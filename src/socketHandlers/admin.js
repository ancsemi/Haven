'use strict';

const crypto = require('crypto');
const { utcStamp, isInt, isValidUploadPath, VALID_ROLE_PERMS } = require('./helpers');

module.exports = function register(socket, ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    getUserPermissions, getUserRoles, getUserHighestRole,
    emitOnlineUsers, broadcastChannelLists, generateChannelCode,
    logAudit, fireWebhookEvent, onReferrerPolicyChange, automod, getIdleOnlineUsers,
    getUploadUsage
  } = ctx;
  const { channelUsers } = state;

  // Settings that can also be supplied through the environment (docker
  // env vars, .env). In every one of these the stored setting wins and the
  // environment is only the fallback — but the panel showed no sign of that,
  // so an admin who set SERVER_NAME in their compose file opened Settings,
  // saw an empty box, and had no way to tell whether it had taken effect or
  // what would happen if they typed in it. (#5489)
  const ENV_BACKED_SETTINGS = [
    { key: 'server_name',   env: 'SERVER_NAME' },
    { key: 'stun_urls',     env: 'STUN_URLS' },
    { key: 'turn_url',      env: 'TURN_URL' },
    { key: 'turn_username', env: 'TURN_USERNAME' },
    { key: 'turn_password', env: 'TURN_PASSWORD', secret: true },
    // No field of its own — TURN_SECRET switches env TURN to time-limited
    // HMAC credentials, and is ignored entirely once a TURN server is set
    // here. Reported so that isn't a silent surprise.
    { key: 'turn_secret',   env: 'TURN_SECRET',   secret: true },
    { key: 'giphy_api_key', env: 'GIPHY_API_KEY', secret: true },
    { key: 'tenor_api_key', env: 'TENOR_API_KEY', secret: true }
  ];

  // ── Server settings ─────────────────────────────────────
  socket.on('get-server-settings', () => {
    const rows = db.prepare('SELECT key, value FROM server_settings').all();
    const settings = {};
    const sensitiveKeys = ['giphy_api_key', 'tenor_api_key', 'server_code', 'registration_token', 'turn_password', 'turnstile_secret_key'];
    rows.forEach(r => {
      if (sensitiveKeys.includes(r.key) && !socket.user.isAdmin) return;
      settings[r.key] = r.value;
    });

    // Not a stored setting: the server name actually in effect once
    // SERVER_NAME is taken into account. Without it the sidebar fell back to
    // "HAVEN" on servers whose name only ever came from the environment,
    // even though /api/health has always reported the env name. Kept apart
    // from server_name so the admin panel still shows an empty box for a
    // setting that genuinely has no stored value. (#5489)
    settings.server_name_effective = settings.server_name || (process.env.SERVER_NAME || '').trim() || '';

    // Only the people who can open the admin panel get told what the
    // environment holds, and secrets are reported as present without ever
    // sending the value.
    let envInfo = {};
    if (socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server')) {
      for (const entry of ENV_BACKED_SETTINGS) {
        const raw = (process.env[entry.env] || '').trim();
        if (!raw) continue;
        envInfo[entry.key] = entry.secret
          ? { var: entry.env, secret: true }
          : { var: entry.env, value: raw };
      }
    }

    socket.emit('server-settings', settings, envInfo);
  });

  socket.on('update-server-setting', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) {
      return socket.emit('error-msg', 'Only admins can change server settings');
    }

    const key = typeof data.key === 'string' ? data.key.trim() : '';
    const value = typeof data.value === 'string' ? data.value.trim() : '';

    const allowedKeys = [
      'member_visibility', 'cleanup_enabled', 'cleanup_max_age_days', 'cleanup_max_size_mb',
      'giphy_api_key', 'tenor_api_key', 'server_name', 'server_title', 'server_icon', 'server_banner', 'permission_thresholds',
      'tunnel_enabled', 'tunnel_provider', 'server_code', 'max_upload_mb', 'max_poll_options',
      'max_sound_kb', 'max_emoji_kb', 'max_sticker_kb', 'setup_wizard_complete', 'update_banner_admin_only',
      'default_theme', 'published_themes', 'channel_sort_mode', 'channel_cat_order', 'channel_cat_sort',
      'channel_tag_sorts', 'custom_tos', 'welcome_message', 'vanity_code', 'default_locale',
      'role_icon_sidebar', 'role_icon_chat', 'role_icon_after_name',
      'auto_backup_enabled', 'auto_backup_interval_hours', 'auto_backup_retention', 'auto_backup_sections',
      'session_duration_days', 'max_message_chars',
      'default_join_channels', 'registration_token_enabled', 'invites_bypass_registration_token', // (#5344, #5345), registration_token has its own generate/clear handlers
      'admin_password_reset_enabled', // (#5300) admin password reset feature gate
      'guests_enabled', 'guest_channels', // (#5381) Join-as-Guest toggle + per-channel whitelist (CSV of channel ids)
      'stun_urls', 'turn_url', 'turn_username', 'turn_password', // (#5399) voice connectivity (STUN/TURN)
      'registration_captcha_enabled', 'turnstile_site_key', 'turnstile_secret_key', // opt-in Cloudflare Turnstile on registration
      'registration_rate_limit_enabled', 'registration_rate_limit_per_hour', // opt-in global new-account velocity cap
      'max_invite_uses', // invite uses limiter for non-admin/mannage-server invite-links
      'channel_creator_role', // (#5461) role auto-granted to a non-admin who creates a channel
      // (#12) OIDC / SSO. The client secret is NOT here on purpose — it lives
      // in OIDC_CLIENT_SECRET in the environment, so a database backup never
      // carries an identity-provider credential around with it.
      'oidc_enabled', 'oidc_issuer_url', 'oidc_client_id', 'oidc_scopes',
      'oidc_create_users', 'oidc_button_label',
      'referrer_policy', // Referrer-Policy header, admin-configurable under Settings → Security
      // (v3.42.0) Auto-moderation + voice privacy
      'automod_enabled', 'automod_link_mode', 'automod_link_exempt_level',
      'automod_link_min_account_hours', 'automod_scan_edits', 'automod_scan_profile',
      'automod_scan_dms', 'automod_block_ip_urls', 'automod_block_punycode',
      'automod_block_obfuscated', 'automod_preview_allowlist_only', 'automod_escalation',
      'automod_ban_ip', 'automod_log_channel',
      'voice_force_relay',
      'media_proxy_enabled', // (v3.43.0) server-side fetch + cache for remote images
      'fcm_enabled', // admin gate for Google FCM mobile push; off = FCM sends skipped (web-push unaffected)
      'unicode_emoji_auto_update' // monthly refresh of the built-in emoji set from unicode.org, opt-in
    ];
    if (!allowedKeys.includes(key)) return;

    // ── Auto-mod validation (v3.42.0) ─────────────────────
    const automodBools = [
      'automod_enabled', 'automod_scan_edits', 'automod_scan_profile', 'automod_scan_dms',
      'automod_block_ip_urls', 'automod_block_punycode', 'automod_block_obfuscated',
      'automod_preview_allowlist_only', 'automod_ban_ip'
    ];
    if (automodBools.includes(key) && !['true', 'false'].includes(value)) return;
    if (key === 'media_proxy_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'fcm_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'unicode_emoji_auto_update' && !['true', 'false'].includes(value)) return;
    if (key === 'automod_link_mode' && !['off', 'allowlist', 'blocklist'].includes(value)) return;
    if (key === 'automod_link_exempt_level') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 100) return; }
    if (key === 'automod_link_min_account_hours') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 8760) return; }
    if (key === 'automod_log_channel' && value && !/^[a-f0-9]{8}$/i.test(value)) return;
    if (key === 'automod_escalation') {
      // Thresholds must be coherent or the escalation ladder misbehaves in
      // ways that are very hard to debug from the outside: a ban threshold
      // below the mute threshold would ban before it ever mutes.
      try {
        const c = JSON.parse(value);
        const num = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
        if (!num(c.windowHours, 1, 8760)) return;
        if (!num(c.muteMinutes, 1, 43200)) return;
        for (const k of ['warnAt', 'muteAt', 'banAt']) { if (!num(c[k], 0, 1000)) return; }
        if (c.muteAt && c.warnAt && Number(c.muteAt) < Number(c.warnAt)) return;
        if (c.banAt && c.muteAt && Number(c.banAt) < Number(c.muteAt)) return;
      } catch { return; }
    }

    // Relay-only voice hard-requires TURN. Enabling it without a TURN server
    // configured would leave every client unable to connect at all, so refuse
    // and say why rather than silently breaking voice for the whole server.
    if (key === 'voice_force_relay') {
      if (!['true', 'false'].includes(value)) return;
      if (value === 'true') {
        const turn = db.prepare("SELECT value FROM server_settings WHERE key = 'turn_url'").get();
        const envTurn = (process.env.TURN_URL || '').trim();
        if (!((turn && turn.value && turn.value.trim()) || envTurn)) {
          return socket.emit('error-msg', 'Set a TURN server under Voice & Connectivity first — relay-only voice cannot work without one.');
        }
      }
    }

    // (#5461) '' / 'default' = the highest-level channel-scoped role (the
    // pre-5461 hardcoded behavior); 'none' = don't auto-assign anything;
    // otherwise a numeric id of an existing role.
    if (key === 'channel_creator_role' && value !== '' && value !== 'default' && value !== 'none') {
      const rid = parseInt(value, 10);
      if (isNaN(rid) || !db.prepare('SELECT 1 FROM roles WHERE id = ?').get(rid)) return;
    }

    if (key === 'registration_captcha_enabled' && !['true', 'false'].includes(value)) return;
    if ((key === 'turnstile_site_key' || key === 'turnstile_secret_key') && value.length > 200) return;
    if (key === 'registration_rate_limit_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'registration_rate_limit_per_hour') { const n = parseInt(value); if (isNaN(n) || n < 1 || n > 100000) return; }
    if (key === 'max_invite_uses') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 100000) return; }

    // 'unsafe-url' and 'no-referrer-when-downgrade' are intentionally absent —
    // both leak the full URL cross-origin, and Haven's invite links live in the
    // query string. See the note on VALID_REFERRER_POLICIES in server.js, which
    // this list must match.
    if (key === 'referrer_policy' && !['no-referrer', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(value)) return;
    if (key === 'member_visibility' && !['all', 'online', 'none'].includes(value)) return;
    if (key === 'cleanup_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'cleanup_max_age_days') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 3650) return; }
    if (key === 'cleanup_max_size_mb') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 100000) return; }
    if (key === 'max_upload_mb') { const n = parseInt(value); if (isNaN(n) || n < 1 || n > 102400) return; }
    if (key === 'max_poll_options') { const n = parseInt(value); if (isNaN(n) || n < 2 || n > 25) return; }
    if (key === 'max_message_chars') { const n = parseInt(value); if (isNaN(n) || n < 200 || n > 100000) return; }
    if (key === 'max_sound_kb') { const n = parseInt(value); if (isNaN(n) || n < 256 || n > 10240) return; }
    if (key === 'max_emoji_kb') { const n = parseInt(value); if (isNaN(n) || n < 64 || n > 1024) return; }
    if (key === 'max_sticker_kb') { const n = parseInt(value); if (isNaN(n) || n < 256 || n > 10240) return; }
    if (key === 'session_duration_days') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 365) return; } // 0 = never expire (#5391)
    if (key === 'auto_backup_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'auto_backup_interval_hours') { const n = parseInt(value); if (isNaN(n) || ![6, 12, 24, 168, 720].includes(n)) return; }
    if (key === 'auto_backup_retention') { const n = parseInt(value); if (isNaN(n) || n < 1 || n > 50) return; }
    if (key === 'auto_backup_sections') {
      const valid = new Set(['channels', 'users', 'settings', 'messages', 'dms', 'files']);
      const parts = value.split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.every(p => valid.has(p))) return;
    }
    if (key === 'giphy_api_key') { if (value && (value.length < 10 || value.length > 100)) return; }
    if (key === 'tenor_api_key') { if (value && (value.length < 10 || value.length > 100)) return; }
    if (key === 'server_name') { if (value.length > 32) return; }
    if (key === 'server_title') { if (value.length > 40) return; }
    if (key === 'server_icon') { if (value && !isValidUploadPath(value)) return; }
    if (key === 'tunnel_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'tunnel_provider' && !['localtunnel', 'cloudflared'].includes(value)) return;
    if (key === 'setup_wizard_complete' && !['true', 'false'].includes(value)) return;
    if (key === 'update_banner_admin_only' && !['true', 'false'].includes(value)) return;
    if (key === 'admin_password_reset_enabled' && !['true', 'false'].includes(value)) return;
    // (#12) OIDC. The issuer must be an absolute https URL — anything else is
    // either a typo or an attempt to point discovery somewhere it shouldn't go.
    if (key === 'oidc_enabled' && !['0', '1'].includes(value)) return;
    if (key === 'oidc_create_users' && !['0', '1'].includes(value)) return;
    if (key === 'oidc_issuer_url' && value) {
      try {
        const u = new URL(value);
        const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
        if (u.protocol !== 'https:' && !isLocal) return;
      } catch { return; }
    }
    if (key === 'oidc_client_id' && value.length > 200) return;
    if (key === 'oidc_scopes' && (value.length > 200 || !/^[\w :.\-\/]*$/.test(value))) return;
    if (key === 'oidc_button_label' && value.length > 40) return;
    if (key === 'role_icon_sidebar' && !['true', 'false'].includes(value)) return;
    if (key === 'role_icon_chat' && !['true', 'false'].includes(value)) return;
    if (key === 'role_icon_after_name' && !['true', 'false'].includes(value)) return;
    if (key === 'channel_sort_mode' && !['manual', 'alpha', 'created', 'oldest', 'dynamic'].includes(value)) return;
    if (key === 'channel_cat_sort' && !['az', 'za', 'manual'].includes(value)) return;
    if (key === 'channel_cat_order') {
      try { const arr = JSON.parse(value); if (!Array.isArray(arr)) return; } catch { return; }
    }
    if (key === 'channel_tag_sorts') {
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) return;
        const validModes = ['manual', 'alpha', 'created', 'oldest', 'dynamic'];
        for (const v of Object.values(obj)) { if (!validModes.includes(v)) return; }
      } catch { return; }
    }
    if (key === 'default_theme') {
      // Allow built-in names OR "file:name.theme.css" for published custom themes
      const validBuiltin = ['', 'haven', 'discord', 'matrix', 'fallout', 'ffx', 'ice', 'nord', 'darksouls', 'eldenring', 'bloodborne', 'cyberpunk', 'lotr', 'abyss', 'scripture', 'chapel', 'gospel', 'tron', 'halo', 'dracula', 'win95'];
      if (!validBuiltin.includes(value) && !/^file:[a-zA-Z0-9_\-. ]+\.theme\.css$/.test(value)) return;
    }
    if (key === 'default_locale') {
      const validLocales = ['', 'en', 'fr', 'de', 'es', 'pl', 'ru', 'zh', 'pt'];
      if (!validLocales.includes(value)) return;
    }
    if (key === 'published_themes') {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) return;
        if (!arr.every(f => typeof f === 'string' && /^[a-zA-Z0-9_\-. ]+\.theme\.css$/.test(f))) return;
      } catch { return; }
    }
    if (key === 'custom_tos') { if (value.length > 50000) return; }
    if (key === 'welcome_message') { if (value.length > 500) return; }
    if (key === 'server_code') return; // managed via generate/rotate events
    if (key === 'server_banner') { if (value && !isValidUploadPath(value)) return; }
    if (key === 'vanity_code') {
      if (value && (value.length < 3 || value.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(value))) return;
    }
    if (key === 'registration_token_enabled') {
      if (!['true', 'false'].includes(value)) return;
    }
    if (key === 'invites_bypass_registration_token') {
      if (!['true', 'false'].includes(value)) return;
    }
    if (key === 'guests_enabled') {
      if (!['true', 'false'].includes(value)) return;
    }
    if (key === 'guest_channels') {
      // (#5381) CSV of channel ids guests can see/post in. Empty string =
      // no channels (guests can log in but have nowhere to go). DMs are
      // never auto-joined — checked again at auto-join time.
      if (value !== '') {
        const parts = value.split(',').map(s => s.trim());
        if (!parts.every(p => /^\d+$/.test(p) && parseInt(p) > 0)) return;
        if (parts.length > 500) return;
      }
    }
    if (key === 'stun_urls') {
      // (#5399) Newline- or comma-separated stun:/stuns: URIs. Empty = built-in
      // defaults. Reject anything that isn't a STUN scheme so a typo can't
      // silently kill ICE for everyone.
      if (value !== '') {
        const urls = value.split(/[\n,]/).map(u => u.trim()).filter(Boolean);
        if (urls.length > 20) return;
        if (!urls.every(u => /^stuns?:[^\s]+$/i.test(u) && u.length <= 200)) return;
      }
    }
    if (key === 'turn_url') {
      // Optional. Single turn:/turns: URI. Empty disables admin TURN.
      if (value !== '' && !(/^turns?:[^\s]+$/i.test(value) && value.length <= 200)) return;
    }
    if (key === 'turn_username') { if (value.length > 200) return; }
    if (key === 'turn_password') { if (value.length > 200) return; }
    if (key === 'default_join_channels') {
      // (#5345) JSON array of channel IDs (integers). Empty string = "all public".
      if (value !== '') {
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) return;
          if (!arr.every(n => Number.isInteger(n) && n > 0)) return;
          if (arr.length > 500) return;
        } catch { return; }
      }
    }
    if (key === 'permission_thresholds') {
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const [k, v] of Object.entries(obj)) {
          if (!VALID_ROLE_PERMS.includes(k)) return;
          if (!Number.isInteger(v) || v < 1 || v > 100) return;
        }
      } catch { return; }
    }

    try {
      db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
    } catch (err) {
      console.error('Failed to save server setting:', key, err.message);
      return socket.emit('error-msg', 'Failed to save setting — database write error');
    }

    io.emit('server-setting-changed', { key, value });

    // Clearing the name hands it back to SERVER_NAME, so tell everyone what
    // the name resolves to now rather than leaving the old one on screen
    // until the next reconnect. (#5489)
    if (key === 'server_name') {
      io.emit('server-setting-changed', {
        key: 'server_name_effective',
        value: value || (process.env.SERVER_NAME || '').trim() || ''
      });
    }

    // Automod caches its settings for 15s on the hot path; drop the cache so
    // an admin toggle takes effect on the very next message. (v3.42.0)
    if (key.startsWith('automod_')) {
      try { automod.invalidate(); _broadcastLinkPolicy(); } catch { /* module optional */ }
    }

    // Audit: log the setting change. Skip per-user UI prefs that the
    // organize modal syncs constantly to avoid log spam.
    const _quietKeys = new Set(['channel_cat_order', 'channel_cat_sort', 'channel_tag_sorts', 'channel_sort_mode']);
    if (!_quietKeys.has(key) && typeof logAudit === 'function') {
      const _short = (v) => typeof v === 'string' && v.length > 120 ? v.slice(0, 117) + '...' : v;
      logAudit({
        actor: socket.user, action: 'server_setting_update',
        target_type: 'setting', target_name: key,
        details: { key, value: _short(value) }
      });
    }

    if (key === 'member_visibility') {
      for (const [code] of channelUsers) { emitOnlineUsers(code); }
    }
    if (key === 'referrer_policy') onReferrerPolicyChange(value);

    // Keep the in-memory FCM toggle in sync so the message hot path never reads
    // the database. isFcmEnabled() consults this on the next push. (FCM Privacy)
    if (key === 'fcm_enabled') require('../fcm').setFcmAdminEnabled(value !== 'false');

    // Turning the feature on shouldn't make the admin wait until the next boot —
    // refresh right away. ensureEmojiData is a no-op when the on-disk copy is
    // still current, so this stays at most one request. (env override still wins)
    if (key === 'unicode_emoji_auto_update') {
      const emoji = require('../emoji');
      emoji.ensureEmojiData(emoji.autoUpdateEnabled(value)).catch(() => {});
    }
  });

  // ── Whitelist management ────────────────────────────────
  socket.on('get-whitelist', () => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) return;
    const rows = db.prepare('SELECT id, username, created_at FROM whitelist ORDER BY username').all();
    rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
    socket.emit('whitelist-list', rows);
  });

  socket.on('whitelist-add', (data) => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) return;
    if (!data || typeof data !== 'object') return;
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    if (!username || username.length < 3 || username.length > 20) {
      return socket.emit('error-msg', 'Username must be 3-20 characters');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return socket.emit('error-msg', 'Invalid username format');
    }

    try {
      db.prepare('INSERT OR IGNORE INTO whitelist (username, added_by) VALUES (?, ?)').run(username, socket.user.id);
      socket.emit('error-msg', `Added "${username}" to whitelist`);
      const rows = db.prepare('SELECT id, username, created_at FROM whitelist ORDER BY username').all();
      rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
      socket.emit('whitelist-list', rows);
    } catch {
      socket.emit('error-msg', 'Failed to add to whitelist');
    }
  });

  socket.on('whitelist-remove', (data) => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) return;
    if (!data || typeof data !== 'object') return;
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    if (!username) return;

    db.prepare('DELETE FROM whitelist WHERE username = ?').run(username);
    socket.emit('error-msg', `Removed "${username}" from whitelist`);
    const rows = db.prepare('SELECT id, username, created_at FROM whitelist ORDER BY username').all();
    rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
    socket.emit('whitelist-list', rows);
  });

  socket.on('whitelist-toggle', (data) => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) return;
    if (!data || typeof data !== 'object') return;
    const enabled = data.enabled === true ? 'true' : 'false';
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('whitelist_enabled', ?)").run(enabled);
    socket.emit('error-msg', `Whitelist ${enabled === 'true' ? 'enabled' : 'disabled'}`);
  });

  // ── Server invite code ──────────────────────────────────
  socket.on('generate-server-code', () => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) {
      return socket.emit('error-msg', 'Only admins can manage server codes');
    }
    const code = generateChannelCode();
    db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run('server_code', code);
    io.emit('server-setting-changed', { key: 'server_code', value: code });
    socket.emit('error-msg', `Server invite code generated: ${code}`);
  });

  socket.on('clear-server-code', () => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) {
      return socket.emit('error-msg', 'Only admins can manage server codes');
    }
    db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run('server_code', '');
    io.emit('server-setting-changed', { key: 'server_code', value: '' });
    socket.emit('error-msg', 'Server invite code cleared');
  });

  // ── Managed invite links (multi-code menu) ──────────────
  // (#5470) invite_users lets a trusted member hand out invite links without
  // being handed the whole server with them. What an invite can actually do
  // is already bounded: redeeming one only ever joins public, top-level
  // channels (see _resolveAutoJoinChannels), so a link can't reach a private
  // channel no matter which ids it names. What still needs bounding is other
  // people's links — a member with invite_users has no business revoking the
  // admin's server-wide link — so they only see and edit their own.
  const _canManageInvites = () =>
    socket.user.isAdmin ||
    userHasPermission(socket.user.id, 'manage_server') ||
    userHasPermission(socket.user.id, 'invite_users');

  // True for the people who own the invite system as a whole, rather than
  // just their own links.
  const _canManageAllInvites = () =>
    socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server');

  // The row, but only if this user is allowed to touch it.
  const _ownedInvite = (id) => {
    const row = db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(id);
    if (!row) return null;
    if (_canManageAllInvites()) return row;
    return row.created_by === socket.user.id ? row : null;
  };

  // True if `code` already names a channel, the server code, the legacy vanity
  // code, or another invite link — anything join-channel could ambiguously
  // resolve. Invite codes are checked first at join time, so a collision would
  // silently shadow a real channel; reject up front instead.
  const _inviteCodeTaken = (code, excludeId = null) => {
    if (db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code)) return true;
    const ss = db.prepare("SELECT value FROM server_settings WHERE key IN ('server_code', 'vanity_code')").all();
    if (ss.some(r => r.value && r.value === code)) return true;
    const dup = db.prepare('SELECT id FROM invite_codes WHERE code = ?').get(code);
    return !!(dup && dup.id !== excludeId);
  };

  // Normalise an admin-supplied channel list into a JSON string of positive
  // ints (capped). Returns '' for "all public", or null if the input is invalid.
  const _normaliseInviteChannels = (channels) => {
    if (channels == null) return '';
    if (!Array.isArray(channels)) return null;
    const ids = [...new Set(channels.map(n => parseInt(n)).filter(n => Number.isInteger(n) && n > 0))];
    if (ids.length > 500) return null;
    return ids.length ? JSON.stringify(ids) : '';
  };

  // hours <= 0 / falsy → never expires (null). Stored as a UTC string that
  // sorts identically to SQLite's CURRENT_TIMESTAMP for the expiry comparison.
  const _inviteExpiryStamp = (hours) => {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return null;
    return new Date(Date.now() + h * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  };

  const _emitInviteCodes = (target = socket) => {
    // invite_users on its own sees only the links it made. (#5470)
    const mineOnly = !_canManageAllInvites();
    const rows = db.prepare(`
      SELECT ic.*,
        (SELECT COUNT(*) FROM invite_code_uses u WHERE u.invite_code_id = ic.id) AS use_count,
        (ic.expires_at IS NOT NULL AND ic.expires_at <= CURRENT_TIMESTAMP) AS is_expired
      FROM invite_codes ic
      ${mineOnly ? 'WHERE ic.created_by = ?' : ''}
      ORDER BY ic.created_at DESC
    `).all(...(mineOnly ? [socket.user.id] : []));
    rows.forEach(r => {
      r.created_at = utcStamp(r.created_at);
      if (r.expires_at) r.expires_at = utcStamp(r.expires_at);
      r.enabled = !!r.enabled;
      r.is_expired = !!r.is_expired;
      let ch = [];
      try { const p = JSON.parse(r.channels || '[]'); if (Array.isArray(p)) ch = p; } catch { /* keep [] */ }
      r.channels = ch;
    });
    target.emit('invite-codes-list', rows);
  };

  socket.on('get-invite-codes', () => {
    if (!_canManageInvites()) return;
    _emitInviteCodes();
  });

  socket.on('create-invite-code', (data) => {
    if (!_canManageInvites()) return socket.emit('error-msg', 'You don\'t have permission to manage invite links');
    if (!data || typeof data !== 'object') return;

    // A delegated inviter shouldn't be able to fill the table. Admins and
    // manage_server are uncapped as before. (#5470)
    if (!_canManageAllInvites()) {
      const mine = db.prepare(
        'SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?'
      ).get(socket.user.id).n;
      if (mine >= 25) {
        return socket.emit('error-msg', 'You already have 25 invite links. Delete one before making another.');
      }
    }

    // Enforce the server-configured max uses for delegated inviters.
    // 0 = unlimited. Admins and manage_server are uncapped.
    let maxInvtUsesSetting = parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_invite_uses'").get()?.value, 10);
    if (Number.isNaN(maxInvtUsesSetting)) maxInvtUsesSetting = 1;
    const restrictUses = !socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server') && maxInvtUsesSetting > 0;
    if (restrictUses && (data.maxUses > maxInvtUsesSetting || data.maxUses <= 0)) {
      return socket.emit('error-msg', `Invite links are limited to ${maxInvtUsesSetting} uses.`);
    }

    const label = typeof data.label === 'string' ? data.label.trim().slice(0, 60) : '';
    const channels = _normaliseInviteChannels(data.channels);
    if (channels === null) return socket.emit('error-msg', 'Invalid channel selection');
    const maxUses = Number.isInteger(data.maxUses) && data.maxUses > 0 ? Math.min(data.maxUses, 100000) : 0;
    const expiresAt = _inviteExpiryStamp(data.expiresInHours);

    // Custom slug (optional) or an auto-generated 8-char hex code.
    let code;
    if (typeof data.code === 'string' && data.code.trim()) {
      code = data.code.trim();
      if (!/^[a-zA-Z0-9_-]{3,32}$/.test(code)) {
        return socket.emit('error-msg', 'Custom code must be 3-32 chars (letters, numbers, - and _)');
      }
      if (_inviteCodeTaken(code)) {
        return socket.emit('error-msg', 'That code is already in use — pick another.');
      }
    } else {
      do { code = generateChannelCode(); } while (_inviteCodeTaken(code));
    }

    const info = db.prepare(
      'INSERT INTO invite_codes (code, label, channels, enabled, max_uses, expires_at, created_by) VALUES (?, ?, ?, 1, ?, ?, ?)'
    ).run(code, label, channels, maxUses, expiresAt, socket.user.id);

    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'invite_code_create',
        target_type: 'invite_code', target_name: code,
        details: { label, maxUses, expiresAt, channels: channels || 'all' }
      });
    }
    socket.emit('toast', { message: `Invite link created: ${code}`, type: 'success' });
    _emitInviteCodes();
  });

  socket.on('update-invite-code', (data) => {
    if (!_canManageInvites()) return socket.emit('error-msg', 'You don\'t have permission to manage invite links');
    if (!data || typeof data !== 'object') return;
    const id = parseInt(data.id);
    if (!Number.isInteger(id)) return;
    const row = _ownedInvite(id);
    if (!row) return socket.emit('error-msg', 'Invite link not found');

    // Enforce the server-configured max uses for delegated inviters.
    // 0 = unlimited. Admins and manage_server are uncapped.
    let maxInvtUsesSetting = parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_invite_uses'").get()?.value, 10);
    if (Number.isNaN(maxInvtUsesSetting)) maxInvtUsesSetting = 1;
    const restrictUses = !socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server') && maxInvtUsesSetting > 0;
    if (restrictUses && (data.maxUses > maxInvtUsesSetting || data.maxUses <= 0)) {
      return socket.emit('error-msg', `Invite links are limited to ${maxInvtUsesSetting} uses.`);
    }

    const sets = [];
    const vals = [];
    if (typeof data.label === 'string') { sets.push('label = ?'); vals.push(data.label.trim().slice(0, 60)); }
    if ('channels' in data) {
      const channels = _normaliseInviteChannels(data.channels);
      if (channels === null) return socket.emit('error-msg', 'Invalid channel selection');
      sets.push('channels = ?'); vals.push(channels);
    }
    if ('maxUses' in data) {
      const maxUses = Number.isInteger(data.maxUses) && data.maxUses > 0 ? Math.min(data.maxUses, 100000) : 0;
      sets.push('max_uses = ?'); vals.push(maxUses);
    }
    if ('expiresInHours' in data) {
      sets.push('expires_at = ?'); vals.push(_inviteExpiryStamp(data.expiresInHours));
    }
    if ('enabled' in data) { sets.push('enabled = ?'); vals.push(data.enabled ? 1 : 0); }
    if (sets.length === 0) return;

    vals.push(id);
    db.prepare(`UPDATE invite_codes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'invite_code_update',
        target_type: 'invite_code', target_name: row.code,
        details: { fields: sets.map(s => s.split(' ')[0]) }
      });
    }
    socket.emit('toast', { message: `Invite link updated`, type: 'success' });
    _emitInviteCodes();
  });

  socket.on('delete-invite-code', (data) => {
    if (!_canManageInvites()) return socket.emit('error-msg', 'You don\'t have permission to manage invite links');
    if (!data || typeof data !== 'object') return;
    const id = parseInt(data.id);
    if (!Number.isInteger(id)) return;
    const row = _ownedInvite(id);
    if (!row) return;
    db.prepare('DELETE FROM invite_codes WHERE id = ?').run(id);
    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'invite_code_delete',
        target_type: 'invite_code', target_name: row.code, details: {}
      });
    }
    socket.emit('toast', { message: `Invite link ${row.code} deleted`, type: 'success' });
    _emitInviteCodes();
  });

  // ── Registration token (#5344) ──────────────────────────
  // Independent of the whitelist — admin can use either, both, or
  // neither. The token is a 16-char hex string the admin shares
  // out-of-band; new registrants must enter it on the signup form.
  socket.on('generate-registration-token', () => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) {
      return socket.emit('error-msg', 'Only admins can manage the registration token');
    }
    const token = crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run('registration_token', token);
    io.emit('server-setting-changed', { key: 'registration_token', value: token });
    socket.emit('error-msg', `Registration token generated: ${token}`);
  });

  socket.on('clear-registration-token', () => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) {
      return socket.emit('error-msg', 'Only admins can manage the registration token');
    }
    db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run('registration_token', '');
    io.emit('server-setting-changed', { key: 'registration_token', value: '' });
    socket.emit('error-msg', 'Registration token cleared');
  });

  // ── Run cleanup ─────────────────────────────────────────
  socket.on('run-cleanup-now', () => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_server')) {
      return socket.emit('error-msg', 'Only admins can run cleanup');
    }
    if (typeof global.runAutoCleanup === 'function') {
      global.runAutoCleanup();
      socket.emit('error-msg', 'Cleanup ran — check server console for details');
    } else {
      socket.emit('error-msg', 'Cleanup function not available');
    }
  });

  // ── Webhooks / Bot integrations (consolidated) ──────────
  // Two calling conventions:
  //   Bot-manager modal: uses data.channel_id (integer), data.id for delete/toggle
  //   Per-channel modal: uses data.channelCode (string), data.webhookId for delete/toggle

  socket.on('create-webhook', (data) => {
    if (!data || typeof data !== 'object') return;
    const _canWebhooks = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_webhooks');
    if (!_canWebhooks) return socket.emit('error-msg', 'You don\'t have permission to manage webhooks');

    if (data.channelCode) {
      // Per-channel variant
      const channelCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : '';
      if (!channelCode || !/^[a-f0-9]{8}$/i.test(channelCode)) return;

      const channel = db.prepare('SELECT id, code FROM channels WHERE code = ? AND is_dm = 0').get(channelCode);
      if (!channel) return socket.emit('error-msg', 'Channel not found');

      const name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) : 'Bot';
      if (!name) return socket.emit('error-msg', 'Webhook name is required');

      const token = crypto.randomBytes(32).toString('hex');
      try {
        const result = db.prepare(
          'INSERT INTO webhooks (channel_id, name, token, created_by) VALUES (?, ?, ?, ?)'
        ).run(channel.id, name, token, socket.user.id);

        socket.emit('webhook-created', {
          id: result.lastInsertRowid, channel_id: channel.id,
          channel_code: channel.code, name, token, is_active: 1,
          created_at: new Date().toISOString()
        });
      } catch (err) {
        console.error('Create webhook error:', err);
        socket.emit('error-msg', 'Failed to create webhook');
      }
    } else {
      // Bot-manager variant
      const name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) : '';
      const channelId = parseInt(data.channel_id);
      const avatarUrl = typeof data.avatar_url === 'string' ? data.avatar_url.trim().slice(0, 512) : null;
      if (!name || isNaN(channelId)) return socket.emit('error-msg', 'Name and channel required');

      const channel = db.prepare('SELECT id, name FROM channels WHERE id = ?').get(channelId);
      if (!channel) return socket.emit('error-msg', 'Channel not found');

      const token = crypto.randomBytes(32).toString('hex');
      db.prepare(
        'INSERT INTO webhooks (channel_id, name, token, avatar_url, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(channelId, name, token, avatarUrl, socket.user.id);

      const webhooks = db.prepare(`
        SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
               w.callback_url, w.callback_secret,
               w.subscribed_events, w.last_delivery_status, w.last_delivery_at,
               w.last_delivery_error, w.failure_count, w.can_moderate,
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
      socket.emit('error-msg', `Webhook "${name}" created for #${channel.name}`);
    }
  });

  socket.on('get-webhooks', (data) => {
    const _canWebhooks = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_webhooks');
    if (!_canWebhooks) return;

    if (data && typeof data === 'object' && data.channelCode) {
      // Per-channel variant
      const channelCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : '';
      if (!channelCode || !/^[a-f0-9]{8}$/i.test(channelCode)) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(channelCode);
      if (!channel) return;

      const webhooks = db.prepare(
        'SELECT id, channel_id, name, token, avatar_url, is_active, created_at, callback_url, callback_secret, subscribed_events, last_delivery_status, last_delivery_at, last_delivery_error, failure_count, can_moderate FROM webhooks WHERE channel_id = ? ORDER BY created_at DESC'
      ).all(channel.id);
      socket.emit('webhooks-list', { channelCode, webhooks });
    } else {
      // Bot-manager variant (all webhooks)
      const webhooks = db.prepare(`
        SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
               w.callback_url, w.callback_secret,
               w.subscribed_events, w.last_delivery_status, w.last_delivery_at,
               w.last_delivery_error, w.failure_count, w.can_moderate,
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
    }
  });

  socket.on('delete-webhook', (data) => {
    if (!data || typeof data !== 'object') return;
    const _canWebhooks = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_webhooks');
    if (!_canWebhooks) return socket.emit('error-msg', 'You don\'t have permission to manage webhooks');

    // Per-channel variant uses webhookId, bot-manager uses id
    const webhookId = parseInt(data.webhookId || data.id);
    if (!webhookId || isNaN(webhookId)) return;

    db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId);

    if (data.webhookId) {
      // Per-channel response
      socket.emit('webhook-deleted', { webhookId });
    } else {
      // Bot-manager response — return full list
      const webhooks = db.prepare(`
        SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
               w.callback_url, w.callback_secret,
               w.subscribed_events, w.last_delivery_status, w.last_delivery_at,
               w.last_delivery_error, w.failure_count, w.can_moderate,
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
      socket.emit('error-msg', 'Webhook deleted');
    }
  });

  socket.on('toggle-webhook', (data) => {
    if (!data || typeof data !== 'object') return;
    const _canWebhooks2 = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_webhooks');
    if (!_canWebhooks2) return socket.emit('error-msg', 'You don\'t have permission to manage webhooks');

    const webhookId = parseInt(data.webhookId || data.id);
    if (!webhookId || isNaN(webhookId)) return;

    const wh = db.prepare('SELECT is_active FROM webhooks WHERE id = ?').get(webhookId);
    if (!wh) return socket.emit('error-msg', 'Webhook not found');
    const newState = wh.is_active ? 0 : 1;
    db.prepare('UPDATE webhooks SET is_active = ? WHERE id = ?').run(newState, webhookId);

    if (data.webhookId) {
      // Per-channel response
      socket.emit('webhook-toggled', { webhookId, is_active: newState });
    } else {
      // Bot-manager response — return full list
      const webhooks = db.prepare(`
        SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
               w.callback_url, w.callback_secret,
               w.subscribed_events, w.last_delivery_status, w.last_delivery_at,
               w.last_delivery_error, w.failure_count, w.can_moderate,
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
    }
  });

  socket.on('update-webhook', (data) => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_webhooks')) return socket.emit('error-msg', 'You don\'t have permission to manage webhooks');
    if (!data || typeof data !== 'object') return;
    const webhookId = parseInt(data.id);
    if (isNaN(webhookId)) return;

    const wh = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
    if (!wh) return socket.emit('error-msg', 'Webhook not found');

    if (typeof data.name === 'string' && data.name.trim()) {
      db.prepare('UPDATE webhooks SET name = ? WHERE id = ?').run(data.name.trim().slice(0, 32), webhookId);
    }
    if (data.channel_id !== undefined) {
      const channelId = parseInt(data.channel_id);
      if (!isNaN(channelId)) {
        const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
        if (channel) db.prepare('UPDATE webhooks SET channel_id = ? WHERE id = ?').run(channelId, webhookId);
      }
    }
    if (data.avatar_url !== undefined) {
      const av = typeof data.avatar_url === 'string' ? data.avatar_url.trim().slice(0, 512) : null;
      db.prepare('UPDATE webhooks SET avatar_url = ? WHERE id = ?').run(av || null, webhookId);
    }
    if (data.callback_url !== undefined) {
      let cbUrl = typeof data.callback_url === 'string' ? data.callback_url.trim().slice(0, 1024) : null;
      if (cbUrl && !/^https?:\/\//i.test(cbUrl)) cbUrl = null;
      db.prepare('UPDATE webhooks SET callback_url = ? WHERE id = ?').run(cbUrl || null, webhookId);
    }
    if (data.callback_secret !== undefined) {
      const secret = typeof data.callback_secret === 'string' ? data.callback_secret.trim().slice(0, 256) : null;
      db.prepare('UPDATE webhooks SET callback_secret = ? WHERE id = ?').run(secret || null, webhookId);
    }
    // 3.13.0 — per-event subscriptions. Accepts CSV string or array.
    // Allowed: 'message', 'reaction-added', 'member-joined'. Use '*' for all.
    if (data.subscribed_events !== undefined) {
      const allowed = new Set(['message', 'reaction-added', 'member-joined']);
      let raw = data.subscribed_events;
      if (Array.isArray(raw)) raw = raw.join(',');
      let value = '*';
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed === '*') {
          value = '*';
        } else {
          const parts = trimmed.split(',').map(s => s.trim()).filter(s => allowed.has(s));
          value = parts.length ? parts.join(',') : '*';
        }
      }
      db.prepare('UPDATE webhooks SET subscribed_events = ? WHERE id = ?').run(value, webhookId);
    }
    // 3.18.0 — moderation opt-in. Only admins can grant it (manage_webhooks
    // alone is not enough, since it would let mods escalate their own bots).
    if (data.can_moderate !== undefined) {
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can change a bot\'s moderation permission');
      }
      const flag = data.can_moderate ? 1 : 0;
      db.prepare('UPDATE webhooks SET can_moderate = ? WHERE id = ?').run(flag, webhookId);
    }

    const webhooks = db.prepare(`
      SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
             w.callback_url, w.callback_secret,
             w.subscribed_events, w.last_delivery_status, w.last_delivery_at,
             w.last_delivery_error, w.failure_count, w.can_moderate,
             c.name as channel_name, c.code as channel_code
      FROM webhooks w JOIN channels c ON w.channel_id = c.id
      ORDER BY w.created_at DESC
    `).all();
    socket.emit('webhooks-list', { webhooks });
    socket.emit('bot-updated', 'Bot updated');
  });

  // 3.13.0 — fire a synthetic test event to a webhook's callback URL so
  // admins can verify the bot is reachable from the admin UI.
  socket.on('test-webhook', (data) => {
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_webhooks')) return socket.emit('error-msg', 'You don\'t have permission to manage webhooks');
    if (!data || typeof data !== 'object') return;
    const webhookId = parseInt(data.id || data.webhookId);
    if (isNaN(webhookId)) return;

    const wh = db.prepare(`
      SELECT w.id, w.channel_id, w.callback_url, c.code AS channel_code
      FROM webhooks w JOIN channels c ON w.channel_id = c.id
      WHERE w.id = ? AND w.is_active = 1
    `).get(webhookId);
    if (!wh) return socket.emit('error-msg', 'Webhook not found or inactive');
    if (!wh.callback_url) return socket.emit('error-msg', 'Webhook has no callback URL');

    if (typeof fireWebhookEvent === 'function') {
      fireWebhookEvent(wh.channel_id, wh.channel_code, 'test', {
        triggered_by: { id: socket.user.id, username: socket.user.displayName }
      });
      socket.emit('error-msg', 'Test event dispatched. Check delivery status in a few seconds.');
    } else {
      socket.emit('error-msg', 'Webhook dispatcher unavailable');
    }
  });

  // ── Get all members ─────────────────────────────────────
  socket.on('get-all-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    const isAdmin = socket.user.isAdmin;
    const canMod = isAdmin || userHasPermission(socket.user.id, 'kick_user') || userHasPermission(socket.user.id, 'ban_user');
    const canSeeAll = canMod || userHasPermission(socket.user.id, 'view_all_members');

    let channelOnly = null;
    if (!canSeeAll) {
      const channelCode = data && typeof data.channelCode === 'string' ? data.channelCode : null;
      if (channelCode) {
        const ch = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(channelCode);
        if (ch && userHasPermission(socket.user.id, 'view_channel_members', ch.id)) {
          channelOnly = ch.id;
        }
      }
      if (channelOnly === null) return cb({ error: 'Permission denied' });
    }

    try {
      let users;
      if (channelOnly) {
        users = db.prepare(`
          SELECT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
                 u.is_admin, u.created_at, u.avatar, u.avatar_shape, u.status, u.status_text
          FROM users u
          JOIN channel_members cm ON u.id = cm.user_id
          WHERE cm.channel_id = ?
          ORDER BY u.created_at DESC
        `).all(channelOnly);
      } else {
        users = db.prepare(`
          SELECT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
                 u.is_admin, u.created_at, u.avatar, u.avatar_shape, u.status, u.status_text
          FROM users u
          LEFT JOIN bans b ON u.id = b.user_id
          ORDER BY u.created_at DESC
        `).all();
      }

      const onlineIds = new Set();
      for (const [, s] of io.of('/').sockets) {
        if (s.user) onlineIds.add(s.user.id);
      }

      const roleRows = db.prepare(`
        SELECT ur.user_id, r.id as role_id, r.name, r.level, r.color
        FROM user_roles ur JOIN roles r ON ur.role_id = r.id
        GROUP BY ur.user_id, r.id ORDER BY r.level DESC
      `).all();
      const userRoles = {};
      roleRows.forEach(r => {
        if (!userRoles[r.user_id]) userRoles[r.user_id] = [];
        userRoles[r.user_id].push({ id: r.role_id, name: r.name, level: r.level, color: r.color });
      });

      const bannedRows = db.prepare('SELECT user_id FROM bans').all();
      const bannedIds = new Set(bannedRows.map(r => r.user_id));

      const channelCounts = {};
      // Only count regular (non-DM) channels that still exist. Without the
      // is_dm filter every DM thread would be counted, and stale rows for
      // deleted channels would bloat the count too. (#5273-adjacent)
      const ccRows = db.prepare(`
        SELECT cm.user_id, COUNT(*) as cnt
        FROM channel_members cm
        JOIN channels c ON cm.channel_id = c.id
        WHERE c.is_dm = 0
        GROUP BY cm.user_id
      `).all();
      ccRows.forEach(r => { channelCounts[r.user_id] = r.cnt; });

      let allChannels = [];
      if (canMod) {
        allChannels = db.prepare('SELECT id, name, code, parent_channel_id FROM channels WHERE is_dm = 0 ORDER BY position, name').all()
          .map(c => ({ id: c.id, name: c.name, code: c.code, parentId: c.parent_channel_id }));
      }

      const userChannelMap = {};
      if (canMod) {
        const cmRows = db.prepare(`
          SELECT cm.user_id, cm.channel_id, c.name as channel_name, c.code as channel_code
          FROM channel_members cm JOIN channels c ON cm.channel_id = c.id WHERE c.is_dm = 0
        `).all();
        cmRows.forEach(r => {
          if (!userChannelMap[r.user_id]) userChannelMap[r.user_id] = [];
          userChannelMap[r.user_id].push({ id: r.channel_id, name: r.channel_name, code: r.channel_code });
        });
      }

      // Upload storage per member (#5521). Moderator-only: it is a moderation
      // signal, not something every member needs to see about everyone else.
      // The DM figure is a size, never a hint at what was sent: DM attachments
      // are encrypted client-side and stay unreadable to the server.
      let usage = null;
      if (canMod) {
        try { usage = getUploadUsage(); } catch (err) {
          console.warn('get-all-members: upload usage unavailable:', err.message);
        }
      }
      const storageFor = (userId) => {
        if (!usage) return undefined;
        const entry = usage.byUser.get(userId);
        return {
          total: entry ? entry.total : 0,
          channel: entry ? entry.channel : 0,
          dm: entry ? entry.dm : 0,
          profile: entry ? entry.profile : 0,
          files: entry ? entry.files : 0
        };
      };

      const members = users.map(u => ({
        id: u.id, username: u.username, displayName: u.displayName,
        isAdmin: !!u.is_admin, online: onlineIds.has(u.id),
        banned: bannedIds.has(u.id), roles: userRoles[u.id] || [],
        channels: channelCounts[u.id] || 0,
        channelList: canMod ? (userChannelMap[u.id] || []) : undefined,
        storage: storageFor(u.id),
        avatar: u.avatar || null, avatarShape: u.avatar_shape || 'circle',
        status: u.status || 'online', statusText: u.status_text || '',
        createdAt: u.created_at
      }));

      cb({
        members, total: members.length, channelOnly: !!channelOnly,
        allChannels: canMod ? allChannels : undefined,
        // Files uploaded before this shipped have no owner on record, so they
        // are reported as their own total instead of being blamed on anyone.
        storageSummary: usage ? {
          liveBytes: usage.liveBytes,
          attributedBytes: usage.attributedBytes,
          unattributedBytes: usage.unattributedBytes,
          fileCount: usage.fileCount
        } : undefined,
        callerPerms: {
          isAdmin, canMod,
          canPromote: isAdmin || userHasPermission(socket.user.id, 'promote_user'),
          canKick: isAdmin || userHasPermission(socket.user.id, 'kick_user'),
          canBan: isAdmin || userHasPermission(socket.user.id, 'ban_user'),
          canInvite: isAdmin || userHasPermission(socket.user.id, 'invite_users') || userHasPermission(socket.user.id, 'manage_server'),
        }
      });
    } catch (err) {
      console.error('get-all-members error:', err);
      cb({ error: 'Failed to load members' });
    }
  });

  // ── Audit log: paginated read for admins/mods ───────────
  socket.on('get-audit-log', (opts, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.user) return cb({ error: 'Not authenticated' });
    const isAdmin = socket.user.isAdmin;
    const canView = isAdmin || userHasPermission(socket.user.id, 'view_audit_log');
    if (!canView) return cb({ error: 'Permission denied' });
    try {
      const limit = Math.max(1, Math.min(200, parseInt(opts && opts.limit, 10) || 50));
      const beforeId = parseInt(opts && opts.beforeId, 10) || 0;
      const action = opts && typeof opts.action === 'string' && opts.action ? opts.action : null;
      const actorUsername = opts && typeof opts.actorUsername === 'string' && opts.actorUsername
        ? opts.actorUsername.trim().toLowerCase().slice(0, 40) : null;

      const where = [];
      const params = [];
      if (beforeId > 0) { where.push('id < ?'); params.push(beforeId); }
      if (action) { where.push('action = ?'); params.push(action); }
      if (actorUsername) { where.push('LOWER(actor_username) LIKE ?'); params.push('%' + actorUsername + '%'); }
      const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
      params.push(limit);

      const rows = db.prepare(
        'SELECT id, created_at, actor_id, actor_username, action, target_type, target_id, target_name, details ' +
        'FROM audit_log ' + whereSql + ' ORDER BY id DESC LIMIT ?'
      ).all(...params);
      const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action ASC').all().map(r => r.action);
      cb({ rows, actions, hasMore: rows.length === limit });
    } catch (err) {
      console.error('get-audit-log error:', err);
      cb({ error: 'Failed to load audit log' });
    }
  });

  // ── Admin password reset (#5300) ────────────────────────────
  // Generates a random 16-char temporary password for the target user,
  // hashes + saves it, sets must_change_password=1 so the user is forced
  // through a change-password flow on next login, and returns the
  // plaintext temp password to the admin once (caller is expected to
  // copy it and hand it to the user out of band).
  //
  // Disabled by default. Admin must explicitly opt-in via the
  // `admin_password_reset_enabled` server setting — and that toggle is
  // surfaced in `/api/public-config` so users can see whether the
  // current admin can reset their password (the trust-and-warning side
  // of the feature requested in the issue).
  //
  // E2E impact: bumping `password_version` invalidates all of the
  // user's existing JWTs (matching the existing pwv-rejection logic)
  // and the new password no longer derives the same E2E wrap key, so
  // encrypted DM history that depended on the old key is unrecoverable
  // from the user's side. This matches the existing
  // recovery-codes flow behavior.
  socket.on('admin-reset-user-password', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!socket.user.isAdmin) return cb({ error: 'Admin only' });
    const enabled = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_password_reset_enabled'").get();
    if (!enabled || enabled.value !== 'true') {
      return cb({ error: 'Admin password reset is disabled in server settings' });
    }
    const userId = parseInt(data && data.userId);
    if (!Number.isFinite(userId)) return cb({ error: 'Invalid userId' });
    const target = db.prepare('SELECT id, username, password_version, totp_secret, totp_enabled FROM users WHERE id = ?').get(userId);
    if (!target) return cb({ error: 'User not found' });
    if (target.id === socket.user.id) return cb({ error: 'Use Settings → Account to change your own password' });

    // MFA gate (#5300 hardening): admin reset is a powerful escalation path
    // (admin learns user's new login secret), so we require the target to
    // have TOTP 2FA enabled. This way the temp password alone is not enough
    // to take over the account — the attacker (or rogue admin) would also
    // need the TOTP device. Without this, an admin with reset enabled could
    // silently impersonate any user.
    if (!target.totp_secret || !target.totp_enabled) {
      return cb({ error: 'Target user must enable two-factor authentication before an admin can reset their password (security requirement).', code: 'mfa_required' });
    }

    // 16 hex chars, grouped as XXXX-XXXX-XXXX-XXXX for readability.
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    const tempPw = `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
    let hash;
    try {
      const bcrypt = require('bcryptjs');
      hash = bcrypt.hashSync(tempPw, 10);
    } catch (err) {
      console.error('admin-reset-user-password hash error:', err);
      return cb({ error: 'Server error' });
    }
    const newPwv = (target.password_version || 1) + 1;
    // DM-preservation escape hatch (#5300): write the temp hash to
    // `temp_password_hash` instead of overwriting `password_hash`. Login
    // accepts either hash; logging in with the original password silently
    // clears the temp hash and the must_change_password flag, leaving the
    // E2E wrap key intact. Only the forced change-password flow (which
    // only fires when the user logs in with the temp pw) rotates
    // `password_hash`, at which point DM history becomes unrecoverable.
    db.prepare('UPDATE users SET temp_password_hash = ?, password_version = ?, must_change_password = 1 WHERE id = ?')
      .run(hash, newPwv, target.id);

    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'admin_password_reset',
        target_type: 'user', target_id: target.id, target_name: target.username,
        details: { reason: typeof data?.reason === 'string' ? data.reason.slice(0, 200) : '' }
      });
    }
    cb({ ok: true, username: target.username, tempPassword: tempPw });
  });

  // ══════════════════════════════════════════════════════════
  // Auto-moderation: domain policy + activity feed (v3.42.0)
  // ══════════════════════════════════════════════════════════

  function _canManageAutomod() {
    return socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server');
  }

  // Push the refreshed policy to every connected client. Called whenever the
  // domain lists or the automod settings change, so a client's copy cannot
  // sit stale and quietly allow something the admin has just blocked.
  function _broadcastLinkPolicy() {
    try {
      const s = automod.settings();
      const payload = automod.enabled()
        ? Object.assign(automod.policy(), { enabled: true, scanDms: s.automod_scan_dms === 'true' })
        : { enabled: false, mode: 'off', allow: [], deny: [], scanDms: false };
      io.emit('link-policy', payload);
    } catch { /* non-critical */ }
  }

  function _emitDomains() {
    const rows = db.prepare(`
      SELECT d.domain, d.mode, d.include_subdomains, d.note, d.created_at,
             COALESCE(u.display_name, u.username) AS added_by_name
      FROM automod_domains d LEFT JOIN users u ON d.added_by = u.id
      ORDER BY d.mode ASC, d.domain ASC
    `).all();
    rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
    socket.emit('automod-domain-list', rows);
  }

  // ── Idle-online accounts (v3.46.0) ──────────────────────
  // Surfaces accounts that have sat connected and showing green for hours
  // without posting, joining voice, or changing status. That is the signature
  // of a client parked to log the server rather than a person: a real client
  // trips auto-away. Read-only and non-destructive — it's a light to look at,
  // not an action. Gated to admins and moderators (kick/ban/audit), the same
  // people who can already see the full member list.
  function _canSeeOversight() {
    return socket.user.isAdmin ||
           userHasPermission(socket.user.id, 'view_audit_log') ||
           userHasPermission(socket.user.id, 'ban_user') ||
           userHasPermission(socket.user.id, 'kick_user') ||
           userHasPermission(socket.user.id, 'view_all_members');
  }

  socket.on('get-idle-online', (data) => {
    if (!_canSeeOversight()) return socket.emit('idle-online-list', { thresholdHours: 4, users: [] });
    // Admin-tunable threshold, default 4h, clamped to something sane.
    let hours = 4;
    if (data && Number.isFinite(data.hours)) hours = Math.min(168, Math.max(1, Math.floor(data.hours)));
    let users = [];
    try {
      users = (typeof getIdleOnlineUsers === 'function')
        ? getIdleOnlineUsers(hours * 3600 * 1000)
        : [];
    } catch (err) { console.error('get-idle-online error:', err); }
    socket.emit('idle-online-list', { thresholdHours: hours, users });
  });

  // Media cache size, so an admin can see what proxying costs them on disk
  // before deciding whether to leave it on. (v3.43.0)
  socket.on('get-media-cache-stats', () => {
    if (!_canManageAutomod()) return;
    try {
      const s = require('../mediaProxy').stats();
      socket.emit('media-cache-stats', { items: s.items, bytes: s.bytes });
    } catch { socket.emit('media-cache-stats', { items: 0, bytes: 0 }); }
  });

  socket.on('clear-media-cache', () => {
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can clear the media cache');
    try {
      require('../mediaProxy').clear();
      socket.emit('error-msg', 'Media cache cleared');
      logAudit({ actor: socket.user, action: 'media_cache_clear', target_type: 'server' });
      socket.emit('media-cache-stats', { items: 0, bytes: 0 });
    } catch (err) {
      console.error('clear-media-cache error:', err);
      socket.emit('error-msg', 'Failed to clear the media cache');
    }
  });

  // ── Link policy for clients (#5483, v3.44.0) ────────────
  // End-to-end encrypted DMs reach the server as ciphertext, so the
  // send-message path cannot see their links at all. The recipient's client
  // can, once it decrypts. It needs the policy to make the same judgement the
  // server would, so it gets the same allow/deny lists the server evaluates.
  //
  // Available to every authenticated user, not just admins: this is the input
  // to a protection that runs on their own machine, and the domain lists are
  // not secret. Nothing here reveals anything a member could not learn by
  // posting a link and seeing whether it was blocked.
  socket.on('get-link-policy', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : null;
    let payload;
    try {
      const s = automod.settings();
      payload = automod.enabled()
        ? Object.assign(automod.policy(), { enabled: true, scanDms: s.automod_scan_dms === 'true' })
        : { enabled: false, mode: 'off', allow: [], deny: [], scanDms: false };
    } catch {
      payload = { enabled: false, mode: 'off', allow: [], deny: [], scanDms: false };
    }
    if (cb) cb(payload);
    socket.emit('link-policy', payload);
  });

  socket.on('get-automod-domains', () => {
    if (!_canManageAutomod()) return socket.emit('automod-domain-list', []);
    try { _emitDomains(); } catch { socket.emit('automod-domain-list', []); }
  });

  socket.on('add-automod-domain', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!_canManageAutomod()) return socket.emit('error-msg', 'Only admins can manage the link policy');

    // Accept whatever the admin pastes — a bare domain, a full URL, something
    // with a trailing slash — and reduce it to the same canonical host form
    // the message-path checker produces. Storing "https://YouTube.com/" as a
    // literal string would mean it never matched anything.
    const raw = typeof data.domain === 'string' ? data.domain.trim() : '';
    if (!raw || raw.length > 253) return socket.emit('error-msg', 'Enter a domain');

    let host = '';
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
      host = automod.normalizeHost(u.hostname);
    } catch { return socket.emit('error-msg', 'That does not look like a domain'); }

    if (!host || !host.includes('.') || /\s/.test(host)) {
      return socket.emit('error-msg', 'That does not look like a domain');
    }

    const mode = data.mode === 'deny' ? 'deny' : 'allow';
    const includeSubs = data.includeSubdomains === false ? 0 : 1;
    const note = typeof data.note === 'string' ? data.note.trim().slice(0, 200) : '';

    try {
      db.prepare(
        'INSERT OR REPLACE INTO automod_domains (domain, mode, include_subdomains, note, added_by) VALUES (?, ?, ?, ?, ?)'
      ).run(host, mode, includeSubs, note, socket.user.id);
      automod.invalidate();
      _broadcastLinkPolicy();
      socket.emit('error-msg', `${mode === 'deny' ? 'Blocked' : 'Allowed'} ${host}${includeSubs ? ' and its subdomains' : ''}`);
      logAudit({ actor: socket.user, action: 'automod_domain_add',
        target_type: 'domain', target_name: host, details: { mode, includeSubs, note } });
      _emitDomains();
    } catch (err) {
      console.error('add-automod-domain error:', err);
      socket.emit('error-msg', 'Failed to save that domain');
    }
  });

  socket.on('remove-automod-domain', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!_canManageAutomod()) return socket.emit('error-msg', 'Only admins can manage the link policy');
    const host = automod.normalizeHost(typeof data.domain === 'string' ? data.domain : '');
    if (!host) return;
    try {
      const info = db.prepare('DELETE FROM automod_domains WHERE domain = ?').run(host);
      automod.invalidate();
      _broadcastLinkPolicy();
      if (info.changes > 0) {
        socket.emit('error-msg', `Removed ${host}`);
        logAudit({ actor: socket.user, action: 'automod_domain_remove',
          target_type: 'domain', target_name: host });
      }
      _emitDomains();
    } catch (err) {
      console.error('remove-automod-domain error:', err);
      socket.emit('error-msg', 'Failed to remove that domain');
    }
  });

  // Recent automod activity, newest first. Doubles as the "is my config too
  // strict?" feedback loop: an admin who sees legitimate domains piling up
  // here can allow them straight from the same panel.
  socket.on('get-automod-log', (data) => {
    if (!_canManageAutomod()) return socket.emit('automod-log', { entries: [], hostCounts: [] });
    const limit = (data && Number.isInteger(data.limit) && data.limit > 0 && data.limit <= 500) ? data.limit : 100;
    try {
      const entries = db.prepare(`
        SELECT i.id, i.rule, i.host, i.excerpt, i.created_at, i.user_id,
               COALESCE(u.display_name, u.username, '[deleted user]') AS username,
               c.code AS channel_code, c.name AS channel_name
        FROM automod_infractions i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN channels c ON i.channel_id = c.id
        ORDER BY i.created_at DESC LIMIT ?
      `).all(limit);
      entries.forEach(e => { e.created_at = utcStamp(e.created_at); });

      // Most-blocked hosts in the last week, so a domain that everyone keeps
      // trying to share is easy to spot and allow in one click.
      const hostCounts = db.prepare(`
        SELECT host, COUNT(*) AS hits FROM automod_infractions
        WHERE host IS NOT NULL AND created_at >= datetime('now', '-7 days')
        GROUP BY host ORDER BY hits DESC LIMIT 15
      `).all();

      socket.emit('automod-log', { entries, hostCounts });
    } catch (err) {
      console.error('get-automod-log error:', err);
      socket.emit('automod-log', { entries: [], hostCounts: [] });
    }
  });

  // Clear a user's strike history without unbanning them. Lets an admin undo
  // an escalation caused by an over-tight allowlist rather than waiting for
  // the rolling window to expire.
  socket.on('clear-automod-strikes', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!_canManageAutomod()) return socket.emit('error-msg', 'Only admins can clear strikes');
    if (!isInt(data.userId)) return;
    try {
      const info = db.prepare('DELETE FROM automod_infractions WHERE user_id = ?').run(data.userId);
      socket.emit('error-msg', `Cleared ${info.changes} automod strike${info.changes === 1 ? '' : 's'}`);
      logAudit({ actor: socket.user, action: 'automod_strikes_clear',
        target_type: 'user', target_id: data.userId, details: { cleared: info.changes } });
    } catch (err) {
      console.error('clear-automod-strikes error:', err);
      socket.emit('error-msg', 'Failed to clear strikes');
    }
  });
};
