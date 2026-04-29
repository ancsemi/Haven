'use strict';

const crypto = require('crypto');
const { utcStamp, isInt, isValidUploadPath, VALID_ROLE_PERMS } = require('./helpers');

module.exports = function register(socket, ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    getUserPermissions, getUserRoles, getUserHighestRole,
    emitOnlineUsers, broadcastChannelLists, generateChannelCode,
    logAudit
  } = ctx;
  const { channelUsers } = state;

  // ── Server settings ─────────────────────────────────────
  socket.on('get-server-settings', () => {
    const rows = db.prepare('SELECT key, value FROM server_settings').all();
    const settings = {};
    const sensitiveKeys = ['giphy_api_key', 'server_code'];
    rows.forEach(r => {
      if (sensitiveKeys.includes(r.key) && !socket.user.isAdmin) return;
      settings[r.key] = r.value;
    });
    socket.emit('server-settings', settings);
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
      'giphy_api_key', 'server_name', 'server_title', 'server_icon', 'server_banner', 'permission_thresholds',
      'tunnel_enabled', 'tunnel_provider', 'server_code', 'max_upload_mb', 'max_poll_options',
      'max_sound_kb', 'max_emoji_kb', 'setup_wizard_complete', 'update_banner_admin_only',
      'default_theme', 'channel_sort_mode', 'channel_cat_order', 'channel_cat_sort',
      'channel_tag_sorts', 'custom_tos', 'welcome_message', 'vanity_code',
      'role_icon_sidebar', 'role_icon_chat', 'role_icon_after_name',
      'auto_backup_enabled', 'auto_backup_interval_hours', 'auto_backup_retention', 'auto_backup_sections',
      'admin_password_reset_enabled'
    ];
    if (!allowedKeys.includes(key)) return;

    if (key === 'member_visibility' && !['all', 'online', 'none'].includes(value)) return;
    if (key === 'cleanup_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'cleanup_max_age_days') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 3650) return; }
    if (key === 'cleanup_max_size_mb') { const n = parseInt(value); if (isNaN(n) || n < 0 || n > 100000) return; }
    if (key === 'max_upload_mb') { const n = parseInt(value); if (isNaN(n) || n < 1 || n > 2048) return; }
    if (key === 'max_poll_options') { const n = parseInt(value); if (isNaN(n) || n < 2 || n > 25) return; }
    if (key === 'max_sound_kb') { const n = parseInt(value); if (isNaN(n) || n < 256 || n > 10240) return; }
    if (key === 'max_emoji_kb') { const n = parseInt(value); if (isNaN(n) || n < 64 || n > 1024) return; }
    if (key === 'auto_backup_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'auto_backup_interval_hours') { const n = parseInt(value); if (isNaN(n) || ![6, 12, 24, 168, 720].includes(n)) return; }
    if (key === 'auto_backup_retention') { const n = parseInt(value); if (isNaN(n) || n < 1 || n > 50) return; }
    if (key === 'auto_backup_sections') {
      const valid = new Set(['channels', 'users', 'settings', 'messages', 'dms', 'files']);
      const parts = value.split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.every(p => valid.has(p))) return;
    }
    if (key === 'giphy_api_key') { if (value && (value.length < 10 || value.length > 100)) return; }
    if (key === 'server_name') { if (value.length > 32) return; }
    if (key === 'server_title') { if (value.length > 40) return; }
    if (key === 'server_icon') { if (value && !isValidUploadPath(value)) return; }
    if (key === 'tunnel_enabled' && !['true', 'false'].includes(value)) return;
    if (key === 'tunnel_provider' && !['localtunnel', 'cloudflared'].includes(value)) return;
    if (key === 'setup_wizard_complete' && !['true', 'false'].includes(value)) return;
    if (key === 'update_banner_admin_only' && !['true', 'false'].includes(value)) return;
    if (key === 'admin_password_reset_enabled' && !['true', 'false'].includes(value)) return;
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
      const validThemes = ['', 'haven', 'discord', 'matrix', 'fallout', 'ffx', 'ice', 'nord', 'darksouls', 'eldenring', 'bloodborne', 'cyberpunk', 'lotr', 'abyss', 'scripture', 'chapel', 'gospel', 'tron', 'halo', 'dracula', 'win95'];
      if (!validThemes.includes(value)) return;
    }
    if (key === 'custom_tos') { if (value.length > 50000) return; }
    if (key === 'welcome_message') { if (value.length > 500) return; }
    if (key === 'server_code') return; // managed via generate/rotate events
    if (key === 'server_banner') { if (value && !isValidUploadPath(value)) return; }
    if (key === 'vanity_code') {
      if (value && (value.length < 3 || value.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(value))) return;
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
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can create webhooks');

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
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
      socket.emit('error-msg', `Webhook "${name}" created for #${channel.name}`);
    }
  });

  socket.on('get-webhooks', (data) => {
    if (!socket.user.isAdmin) return;

    if (data && typeof data === 'object' && data.channelCode) {
      // Per-channel variant
      const channelCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : '';
      if (!channelCode || !/^[a-f0-9]{8}$/i.test(channelCode)) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(channelCode);
      if (!channel) return;

      const webhooks = db.prepare(
        'SELECT id, channel_id, name, token, avatar_url, is_active, created_at, callback_url, callback_secret FROM webhooks WHERE channel_id = ? ORDER BY created_at DESC'
      ).all(channel.id);
      socket.emit('webhooks-list', { channelCode, webhooks });
    } else {
      // Bot-manager variant (all webhooks)
      const webhooks = db.prepare(`
        SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
               w.callback_url, w.callback_secret,
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
    }
  });

  socket.on('delete-webhook', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can manage webhooks');

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
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can manage webhooks');

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
               c.name as channel_name, c.code as channel_code
        FROM webhooks w JOIN channels c ON w.channel_id = c.id
        ORDER BY w.created_at DESC
      `).all();
      socket.emit('webhooks-list', { webhooks });
    }
  });

  socket.on('update-webhook', (data) => {
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can manage webhooks');
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

    const webhooks = db.prepare(`
      SELECT w.id, w.channel_id, w.name, w.token, w.avatar_url, w.is_active, w.created_at,
             w.callback_url, w.callback_secret,
             c.name as channel_name, c.code as channel_code
      FROM webhooks w JOIN channels c ON w.channel_id = c.id
      ORDER BY w.created_at DESC
    `).all();
    socket.emit('webhooks-list', { webhooks });
    socket.emit('bot-updated', 'Bot updated');
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
        WHERE ur.channel_id IS NULL ORDER BY r.level DESC
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

      const members = users.map(u => ({
        id: u.id, username: u.username, displayName: u.displayName,
        isAdmin: !!u.is_admin, online: onlineIds.has(u.id),
        banned: bannedIds.has(u.id), roles: userRoles[u.id] || [],
        channels: channelCounts[u.id] || 0,
        channelList: canMod ? (userChannelMap[u.id] || []) : undefined,
        avatar: u.avatar || null, avatarShape: u.avatar_shape || 'circle',
        status: u.status || 'online', statusText: u.status_text || '',
        createdAt: u.created_at
      }));

      cb({
        members, total: members.length, channelOnly: !!channelOnly,
        allChannels: canMod ? allChannels : undefined,
        callerPerms: {
          isAdmin, canMod,
          canPromote: isAdmin || userHasPermission(socket.user.id, 'promote_user'),
          canKick: isAdmin || userHasPermission(socket.user.id, 'kick_user'),
          canBan: isAdmin || userHasPermission(socket.user.id, 'ban_user'),
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
    const target = db.prepare('SELECT id, username, password_version FROM users WHERE id = ?').get(userId);
    if (!target) return cb({ error: 'User not found' });
    if (target.id === socket.user.id) return cb({ error: 'Use Settings → Account to change your own password' });

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
    db.prepare('UPDATE users SET password_hash = ?, password_version = ?, must_change_password = 1 WHERE id = ?')
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
};
