'use strict';

// What saving a server setting sets off besides the write itself: the live
// update to clients and the follow-ups some settings need. Made once by
// setupSocketHandlers and shared by the settings screen (admin.js) and
// server template imports, so neither leaves clients with a stale view.

// Secrets are stored next to ordinary settings. The Discord bridge's bot
// token goes to nobody, admins included: its settings screen only ever
// shows a masked hint. The rest go to admins only, here and in every live
// update below, and the audit log records that they changed, not the value.
// import_authors_cleared is a marker the server keeps for itself (src/importAuthors.js).
const NEVER_SENT_SETTINGS = new Set(['ferry_bot_token', 'import_authors_cleared']);
const ADMIN_ONLY_SETTINGS = new Set([
  'giphy_api_key', 'klipy_api_key', 'tenor_api_key', 'server_code', 'registration_token',
  'turn_password', 'turnstile_secret_key',
  // A channel code, and usually a private staff channel's.
  'automod_log_channel',
  // Words blocked from names (src/blockedNames.js): the admin's list only.
  'blocked_name_words',
  // Voice relay setup: only the admin screen needs these.
  'voice_relay_mode', 'voice_relay_port', 'voice_relay_workers', 'voice_relay_address',
]);

function createSettingEffects({ io, automod, channelUsers, emitOnlineUsers, onReferrerPolicyChange, logAudit }) {
  const emitSettingChanged = (key, value) => {
    if (NEVER_SENT_SETTINGS.has(key)) return;
    const target = ADMIN_ONLY_SETTINGS.has(key) ? io.to('admins') : io.except('bot-sockets');
    target.emit('server-setting-changed', { key, value });
  };

  // Push the refreshed policy to every connected client. Called whenever the
  // domain lists or the automod settings change, so a client's copy cannot
  // sit stale and quietly allow something the admin has just blocked.
  function broadcastLinkPolicy() {
    try {
      const s = automod.settings();
      const payload = automod.enabled()
        ? Object.assign(automod.policy(), { enabled: true, scanDms: s.automod_scan_dms === 'true' })
        : { enabled: false, mode: 'off', allow: [], deny: [], scanDms: false };
      io.except('bot-sockets').emit('link-policy', payload);
    } catch (err) {
      // Clients would keep enforcing the old link policy until they reconnect.
      console.error('link policy broadcast failed:', err.message);
    }
  }

  // Follow-ups for settings whose effect reaches past the stored value.
  function afterSettingSaved(key, value) {
    // Clearing the name hands it back to SERVER_NAME, so tell everyone what
    // the name resolves to now rather than leaving the old one on screen
    // until the next reconnect. (#5489)
    if (key === 'server_name') {
      io.except('bot-sockets').emit('server-setting-changed', {
        key: 'server_name_effective',
        value: value || (process.env.SERVER_NAME || '').trim() || ''
      });
    }

    // Automod caches its settings for 15s on the hot path; drop the cache so
    // an admin toggle takes effect on the very next message. (v3.42.0)
    if (key.startsWith('automod_')) {
      automod.invalidate();
      broadcastLinkPolicy();
    }

    if (key === 'member_visibility') {
      for (const [code] of channelUsers) { emitOnlineUsers(code); }
    }
    if (key === 'referrer_policy') onReferrerPolicyChange(value);
  }

  function auditSettingChange(actor, key, value, previous) {
    // Audit: log the setting change. Skip per-user UI prefs that the
    // organize modal syncs constantly to avoid log spam.
    const _quietKeys = new Set(['channel_cat_order', 'channel_cat_sort', 'channel_tag_sorts', 'channel_sort_mode']);
    if (!_quietKeys.has(key) && typeof logAudit === 'function') {
      const _short = (v) => typeof v === 'string' && v.length > 120 ? v.slice(0, 117) + '...' : v;
      const _secret = NEVER_SENT_SETTINGS.has(key) || ADMIN_ONLY_SETTINGS.has(key);
      logAudit({
        actor, action: 'server_setting_update',
        target_type: 'setting', target_name: key,
        details: {
          key,
          from: previous === undefined || _secret ? undefined : _short(previous),
          value: _secret ? (value ? '(hidden)' : '') : _short(value),
        }
      });
    }
  }

  return { emitSettingChanged, broadcastLinkPolicy, afterSettingSaved, auditSettingChange };
}

module.exports = { NEVER_SENT_SETTINGS, ADMIN_ONLY_SETTINGS, createSettingEffects };
