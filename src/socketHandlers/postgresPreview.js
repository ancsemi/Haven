'use strict';

// Explicit migration preview: these handlers use PostgreSQL only. The full
// SQLite socket runtime keeps its existing atomic write paths and workers.
const crypto = require('crypto');
const path = require('path');
const { verifyTokenAsync } = require('../auth');
const createPermissions = require('./asyncPermissions');
const createChannelLists = require('./channelList');
const { parseBorderTransform, utcStamp } = require('./helpers');
const { NEVER_SENT_SETTINGS, ADMIN_ONLY_SETTINGS } = require('./settingEffects');
const { compatibleThemeFiles, validatedThemeDefault, themePreferenceAllowed } = require('../themeMetadata');
const { cleanChannelOrder } = require('./users');
const createEncryptionKeyReads = require('../db/encryptionKeys');
const createReadPositions = require('../db/readPositions');
const THEMES_DIR = path.join(__dirname, '..', '..', 'themes');

function setupPostgresPreview(io, db, { isIpBanned = () => false } = {}) {
  const permissions = createPermissions(db);
  const readPositions = createReadPositions(db);
  const lists = createChannelLists({
    db, userHasPermission: permissions.userHasPermission, roleGateAllows: permissions.roleGateAllows,
    getUserEffectiveLevel: permissions.getUserEffectiveLevel,
  });
  const viewers = new Map();
  const floods = new Map();
  const settings = async () => Object.fromEntries((await db.prepare('SELECT key, value FROM server_settings').all()).map(row => [row.key, row.value]));
  io.use(async (socket, next) => {
    try {
      if (isIpBanned(socket.handshake.address)) return next(new Error('Your IP has been banned from this server'));
      const decoded = await verifyTokenAsync(socket.handshake.auth?.token);
      if (!decoded) return next(new Error('Invalid token'));
      const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
      if (!row || row.username !== decoded.username) return next(new Error('Session expired'));
      if (await db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(decoded.id)) return next(new Error('You have been banned from this server'));
      socket.sessionToken = socket.handshake.auth.token;
      socket.user = {
        id: row.id, username: row.username, displayName: row.display_name || row.username,
        isAdmin: !!row.is_admin, isGuest: !!row.is_guest, pwv: row.password_version || 1,
        avatar: row.avatar || null, avatar_shape: row.avatar_shape || 'circle',
        border: row.border || null, borderTransform: parseBorderTransform(row.border_transform),
        animate_profile: row.animate_profile || 'trigger', status: row.status === 'away' ? 'online' : row.status || 'online',
        statusText: row.status_text || '', isSso: !!row.oidc_subject, e2ePassphrase: !!row.e2e_passphrase,
        bio: row.bio || '', birthday: row.birthday || null, birthdaySetAt: row.birthday_set_at || null,
        birthdayHideYear: row.birthday_hide_year !== 0, birthdayHidden: row.birthday_hidden !== 0,
      };
      if (row.status === 'away') await db.prepare("UPDATE users SET status = 'online' WHERE id = ? AND status = 'away'").run(row.id);
      next();
    } catch (err) {
      console.warn('[postgres-preview] socket authentication failed:', err.code || err.message);
      next(new Error('Server error, try again'));
    }
  });

  async function accessible(socket, code) {
    if (typeof code !== 'string' || !/^[a-f0-9]{8}$/i.test(code)) throw new Error('Invalid channel code');
    const ch = await db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!ch) throw new Error('Channel not found');
    const member = await db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ch.id, socket.user.id);
    if (!member && (!socket.user.isAdmin || ch.is_dm)) throw new Error('Not a member of this channel');
    if (!socket.user.isAdmin && !ch.is_dm && !await permissions.roleGateAllows(socket.user.id, ch)) throw new Error('This channel needs a role you do not hold');
    return ch;
  }
  async function emitMembers(code) {
    const live = [...io.sockets.sockets.values()].filter(s => s.user && s.currentChannel === code);
    const unique = new Map(live.map(s => [s.user.id, s.user]));
    const users = [];
    for (const user of unique.values()) users.push({
      id: user.id, username: user.displayName, loginName: user.username, avatar: user.avatar,
      avatar_shape: user.avatar_shape, isAdmin: user.isAdmin, status: user.status, statusText: user.statusText,
      roles: await permissions.getUserRoles(user.id), effectiveLevel: await permissions.getUserEffectiveLevel(user.id),
    });
    io.to('channel:' + code).emit('online-users', { channelCode: code, users });
  }

  io.on('connection', socket => {
    let queue = Promise.resolve();
    const handlers = new Set();
    function on(event, handler) {
      handlers.add(event);
      socket.on(event, (...args) => {
        // Preserve packet order. In particular, mark-read must not overtake
        // the history read that precedes it in the browser's startup burst.
        queue = queue.then(async () => {
          const now = Date.now();
          const history = (floods.get(socket.user.id) || []).filter(at => now - at < 10000);
          if (history.length >= 400) throw new Error('Too many requests');
          history.push(now); floods.set(socket.user.id, history);
          const account = await db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(socket.user.id);
          if (!account || account.username !== socket.user.username || !await verifyTokenAsync(socket.sessionToken) || await db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(socket.user.id)) {
            socket.emit('session-invalidated');
            socket.disconnect(true);
            return;
          }
          socket.user.isAdmin = !!account.is_admin;
          return handler(...args);
        }).catch(err => {
          console.warn('[postgres-preview] ' + event + ' failed:', err.code || err.message);
          socket.emit('error-msg', err.code ? 'Could not complete the request' : err.message);
        });
      });
    }
    socket.onAny((event, ...args) => {
      if (handlers.has(event)) return;
      const callback = args[args.length - 1];
      const error = 'This feature is not available on this server yet';
      if (typeof callback === 'function') callback({ error });
      else socket.emit('error-msg', error);
    });

    on('get-channels', async () => {
      const channels = await lists.getEnrichedChannelsAsync(socket.user.id, socket.user.isAdmin, room => socket.join(room));
      socket.emit('channels-list', channels);
    });
    on('get-server-settings', async () => {
      const saved = await settings();
      const visible = {};
      for (const [key, value] of Object.entries(saved)) {
        if (!NEVER_SENT_SETTINGS.has(key) && (!ADMIN_ONLY_SETTINGS.has(key) || socket.user.isAdmin)) visible[key] = value;
      }
      let published = [];
      try { published = JSON.parse(saved.published_themes || '[]'); } catch { /* no published files */ }
      const files = compatibleThemeFiles(THEMES_DIR, published);
      visible.published_themes = JSON.stringify(files);
      visible.default_theme = validatedThemeDefault(THEMES_DIR, saved.default_theme || '', files);
      visible.server_name_effective = saved.server_name || (process.env.SERVER_NAME || '').trim();
      visible.max_upload_mb_effective = String(await permissions.getUserUploadMb(socket.user.id));
      visible.gif_search_available = 'false'; // external integrations are outside this preview
      socket.emit('server-settings', visible, {});
    });
    on('get-preferences', async () => {
      const rows = await db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?').all(socket.user.id);
      socket.emit('preferences', Object.fromEntries(rows.map(row => [row.key, row.value])));
    });
    on('set-preference', async data => {
      const allowed = ['theme','hide_score_badge','hide_nsfw','effects','share_activity','share_game_activity','share_music_activity',
        'promo_seen_desktop','promo_seen_android','recovery_notice_seen','android_banner_seen','timezone','time_format','channel_order','server_mute','muted_users','media_group_layout'];
      const key = typeof data?.key === 'string' ? data.key.trim() : '';
      const value = typeof data?.value === 'string' ? data.value.trim() : '';
      const max = key === 'effects' ? 400 : key === 'channel_order' ? 20000 : key === 'muted_users' ? 6000 : key === 'theme' ? 200 : 50;
      if (!allowed.includes(key) || !value || value.length > max) return;
      let stored = value;
      if (key === 'channel_order') { stored = cleanChannelOrder(value); if (!stored) return; }
      if (key === 'server_mute' && !['all','mentions'].includes(value)) return;
      if (key === 'media_group_layout' && !['grid','stacked'].includes(value)) return;
      if (key === 'theme' && value.startsWith('file:')) {
        const saved = await settings();
        let published = [];
        try { published = JSON.parse(saved.published_themes || '[]'); } catch { /* no published files */ }
        const current = await db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'theme'").get(socket.user.id);
        const canManage = socket.user.isAdmin || await permissions.userHasPermission(socket.user.id, 'manage_server');
        if (!themePreferenceAllowed(value, { published, current: current?.value || '', defaultTheme: saved.default_theme || '', canManage })) {
          return socket.emit('preference-refused', { key, value });
        }
      }
      if (key === 'muted_users') {
        let ids; try { ids = JSON.parse(value); } catch { return; }
        if (!Array.isArray(ids)) return;
        stored = JSON.stringify([...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== socket.user.id))].slice(0, 500));
      }
      await db.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value').run(socket.user.id, key, stored);
      socket.emit('preference-saved', { key, value: stored });
    });
    on('get-high-scores', async data => {
      const game = typeof data?.game === 'string' ? data.game.trim() : 'flappy';
      const leaderboard = await db.prepare(`SELECT hs.user_id, COALESCE(u.display_name, u.username) AS username, hs.score
        FROM high_scores hs JOIN users u ON hs.user_id = u.id WHERE hs.game = ? AND hs.score > 0
        AND NOT EXISTS (SELECT 1 FROM user_preferences up WHERE up.user_id = u.id AND up.key = 'hide_score_badge' AND up.value = 'true')
        ORDER BY hs.score DESC LIMIT 50`).all(game);
      socket.emit('high-scores', { game, leaderboard });
    });
    on('get-link-policy', async (data, callback) => {
      const saved = await settings();
      const domains = await db.prepare('SELECT domain, mode, include_subdomains FROM automod_domains').all();
      const payload = {
        enabled: saved.automod_enabled === 'true', mode: saved.automod_link_mode || 'allowlist',
        scanDms: saved.automod_scan_dms === 'true',
        allow: domains.filter(r => r.mode === 'allow').map(r => ({ domain: r.domain, includeSubdomains: !!r.include_subdomains })),
        deny: domains.filter(r => r.mode === 'deny').map(r => ({ domain: r.domain, includeSubdomains: !!r.include_subdomains })),
        blockIpUrls: saved.automod_block_ip_urls === 'true', blockPunycode: saved.automod_block_punycode === 'true',
        blockObfuscated: saved.automod_block_obfuscated === 'true',
      };
      if (typeof callback === 'function') callback(payload);
      socket.emit('link-policy', payload);
    });
    on('get-voice-counts', async () => {
      const channels = await db.prepare('SELECT c.id, c.code, c.role_gate FROM channels c JOIN channel_members cm ON cm.channel_id = c.id WHERE cm.user_id = ?').all(socket.user.id);
      for (const ch of channels) if (socket.user.isAdmin || await permissions.roleGateAllows(socket.user.id, ch)) socket.emit('voice-count-update', { code: ch.code, count: 0, users: [] });
    });
    on('enter-channel', async data => {
      const ch = await accessible(socket, data?.code);
      if (ch.is_dm || ch.is_forum) throw new Error('This channel type is not available on this server yet');
      const previous = socket.currentChannel;
      socket.currentChannel = ch.code;
      socket.join('channel:' + ch.code);
      viewers.set(socket.id, ch.code);
      if (previous && previous !== ch.code) await emitMembers(previous);
      await emitMembers(ch.code);
    });
    on('get-channel-members', async data => {
      const ch = await accessible(socket, data?.code);
      const members = await db.prepare(`SELECT u.id, COALESCE(u.display_name, u.username) AS username, u.username AS "loginName",
        CASE WHEN u.birthday_hidden = 0 THEN substr(u.birthday, 6) END AS birthday
        FROM users u JOIN channel_members cm ON cm.user_id = u.id LEFT JOIN bans b ON b.user_id = u.id
        WHERE cm.channel_id = ? AND b.user_id IS NULL ORDER BY COALESCE(u.display_name, u.username)`).all(ch.id);
      socket.emit('channel-members', { channelCode: ch.code, members });
    });
    on('request-voice-users', async data => {
      const ch = await accessible(socket, data?.code);
      socket.emit('voice-users', { channelCode: ch.code, users: [] });
    });
    on('get-messages', async data => {
      const ch = await accessible(socket, data?.code);
      if (ch.is_dm || ch.is_forum) throw new Error('This channel type is not available on this server yet');
      const limit = Number.isInteger(data.limit) && data.limit > 0 && data.limit <= 100 ? data.limit : 80;
      const before = Number.isInteger(data.before) ? data.before : null;
      const after = Number.isInteger(data.after) ? data.after : null;
      const messages = await db.prepare(`SELECT m.*, COALESCE(u.display_name, u.username, '[Deleted User]') AS real_username,
        COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') AS username,
        u.avatar, COALESCE(u.avatar_shape, 'circle') AS avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') AS animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.thread_id IS NULL ${before ? 'AND m.id < ?' : after ? 'AND m.id > ?' : ''}
        ORDER BY m.created_at ${after ? 'ASC' : 'DESC'}, m.id ${after ? 'ASC' : 'DESC'} LIMIT ?`).all(ch.id, ...((before || after) ? [before || after] : []), limit);
      for (const m of messages) {
        m.reactions = await db.prepare(`SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) AS username
          FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.id`).all(m.id);
        m.pinned = !!await db.prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?').get(m.id);
        m.borderTransform = parseBorderTransform(m.border_transform);
        delete m.border_transform;
        m.animateProfile = m.animate_profile || 'trigger';
        delete m.animate_profile;
        for (const key of ['created_at', 'edited_at']) if (m[key] && !m[key].endsWith('Z')) m[key] = m[key].replace(' ', 'T') + 'Z';
      }
      const read = await db.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?').get(socket.user.id, ch.id);
      const pinned = await db.prepare('SELECT COUNT(*) AS n FROM pinned_messages WHERE channel_id = ?').get(ch.id);
      socket.emit('message-history', { channelCode: ch.code, messages: after ? messages : messages.reverse(), lastReadMessageId: read?.last_read_message_id || 0, pinnedCount: pinned.n });
    });
    on('mark-read', async data => {
      const ch = await accessible(socket, data?.code);
      if (!Number.isInteger(data.messageId) || data.messageId <= 0) return;
      if (!await db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL').get(data.messageId, ch.id)) return;
      await readPositions.markRead(socket.user.id, ch.code, data.messageId);
    });
    on('mark-read-channel', async data => {
      const ch = await accessible(socket, data?.code);
      await readPositions.markChannelRead(socket.user.id, ch.code);
    });
    on('mark-all-read', async (data, callback) => {
      try {
        const channels = await readPositions.markAllRead(socket.user.id);
        if (typeof callback === 'function') callback({ ok: true, channels });
      } catch (err) {
        console.error('Mark all read error:', err);
        if (typeof callback === 'function') callback({ error: 'Could not mark everything read' });
      }
    });
    on('mark-forum-read', async data => {
      if (typeof data?.code !== 'string') return;
      const code = data.code.trim();
      if (!/^[a-f0-9]{8}$/i.test(code)) return;
      if (!await readPositions.markForumRead(socket.user.id, code, socket.user.isAdmin)) return;
      for (const s of io.sockets.sockets.values()) {
        if (s.user && s.user.id === socket.user.id) s.emit('forum-read', { channelCode: code });
      }
    });
    on('mark-thread-read', async data => {
      if (!Number.isInteger(data?.parentId)) return;
      const parent = await readPositions.markThreadRead(socket.user.id, data.parentId, socket.user.isAdmin);
      if (!parent) return;
      for (const s of io.sockets.sockets.values()) {
        if (s !== socket && s.user && s.user.id === socket.user.id) s.emit('thread-read', { channelCode: parent.channel_code, parentId: data.parentId });
      }
    });
    on('get-thread-read-state', async (data, callback) => {
      if (typeof callback !== 'function') return;
      const ids = Array.isArray(data?.parentIds) ? [...new Set(data.parentIds.filter(id => Number.isInteger(id) && id > 0))].slice(0, 200) : [];
      const rows = await readPositions.threadState(socket.user.id, ids);
      const reads = {};
      for (const row of rows) if (socket.user.isAdmin || await permissions.roleGateAllows(socket.user.id, { id: row.channel_id, role_gate: row.role_gate })) reads[row.parentId] = row.lastRead;
      callback({ reads });
    });

    registerBootstrapReads(socket, on, db, permissions, accessible);
    registerKeys(socket, on, db, io);
    // Cosmetic presence pings do not write anything until their full feature
    // paths are migrated. They still go through session/rate checks.
    for (const event of ['visibility-change','get-my-badges','get-user-badges','get-game-activity','user-active']) on(event, async () => {});
    socket.on('disconnect', () => {
      const code = viewers.get(socket.id);
      viewers.delete(socket.id);
      if (code) emitMembers(code).catch(err => console.warn('[postgres-preview] presence cleanup failed:', err.code || err.message));
    });

    // Install handlers before sending the initial session. The browser may
    // immediately start key setup and emit its initial batch of reads.
    queue = queue.then(async () => {
      const user = socket.user;
      const roles = await permissions.getUserRoles(user.id);
      const nicknames = await db.prepare('SELECT target_id, nickname FROM user_nicknames WHERE owner_id = ?').all(user.id);
      const row = await db.prepare('SELECT official_mode FROM users WHERE id = ?').get(user.id);
      socket.emit('session-info', {
        ...user, avatarShape: user.avatar_shape, animateProfile: user.animate_profile,
        roles, effectiveLevel: await permissions.getUserEffectiveLevel(user.id),
        permissions: await permissions.getUserPermissions(user.id), globalPermissions: await permissions.getUserGlobalPermissions(user.id),
        nicknames: Object.fromEntries(nicknames.map(r => [r.target_id, r.nickname])),
        version: require('../../package.json').version, officialMode: !!row?.official_mode, features: [],
      });
    }).catch(err => { console.warn('[postgres-preview] session setup failed:', err.code || err.message); socket.disconnect(true); });
  });
  return {
    state: { channelUsers: viewers }, activity: null,
    logAudit: () => {}, broadcastChannelLists: () => {},
    close: () => { viewers.clear(); floods.clear(); },
  };
}

// Reads the browser issues on every connection, including while its admin
// panels are hidden. Keep the same permission and ownership filters as the
// SQLite handlers; writes for those panels are still outside the preview.
function registerBootstrapReads(socket, on, db, permissions, accessible) {
  const canManage = async () => socket.user.isAdmin || await permissions.userHasPermission(socket.user.id, 'manage_server');
  on('ping-check', async () => socket.emit('pong-check'));
  on('get-listening', async () => socket.emit('listening-state', { token: null }));
  on('get-connections', async () => socket.emit('connections', {
    connections: [], available: { steam: false, spotify: false, lastfm: false },
  }));
  on('get-roles', async (data, callback) => {
    const roles = await db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
    const rows = await db.prepare('SELECT * FROM role_permissions').all();
    for (const role of roles) role.permissions = rows.filter(row => row.role_id === role.id).map(row => row.permission);
    if (typeof callback === 'function') callback({ roles });
    else if (typeof data === 'function') data({ roles });
    else socket.emit('roles-list', roles);
  });
  on('get-recovery-notice-state', async () => {
    const codes = await db.prepare('SELECT COUNT(*) AS c FROM account_recovery_codes WHERE user_id = ? AND used = 0').get(socket.user.id);
    const pref = await db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'recovery_notice_seen'").get(socket.user.id);
    socket.emit('recovery-notice-state', { show: !codes.c && pref?.value !== 'true' });
  });
  on('get-pending-warnings', async (_data, callback) => {
    if (typeof callback !== 'function') return;
    const rows = await db.prepare(`SELECT id, reason, created_at FROM mod_cases
      WHERE user_id = ? AND type = 'warn' AND seen_at IS NULL AND revoked_at IS NULL ORDER BY id`).all(socket.user.id);
    callback({ ok: true, warnings: rows.map(row => ({ id: row.id, reason: row.reason, createdAt: row.created_at })) });
  });
  on('get-group-invites', async () => {
    const rows = await db.prepare(`SELECT c.id, c.code, c.name, i.invited_by, COALESCE(u.display_name, u.username) AS inviter
      FROM dm_group_invites i JOIN channels c ON c.id = i.channel_id
      LEFT JOIN users u ON u.id = i.invited_by WHERE i.user_id = ? AND c.is_group = 1`).all(socket.user.id);
    const invites = [];
    for (const row of rows) {
      const members = await db.prepare(`SELECT u.id, COALESCE(u.display_name, u.username) AS username
        FROM users u JOIN channel_members cm ON cm.user_id = u.id WHERE cm.channel_id = ?`).all(row.id);
      const pending = await db.prepare(`SELECT u.id, COALESCE(u.display_name, u.username) AS username
        FROM users u JOIN dm_group_invites i ON i.user_id = u.id WHERE i.channel_id = ?`).all(row.id);
      invites.push({ id: row.id, code: row.code, name: row.name, is_dm: 1, is_group: 1, members, pending, invitedBy: { id: row.invited_by, username: row.inviter } });
    }
    socket.emit('group-dm-invites', { invites });
  });
  on('get-invite-codes', async () => {
    const all = await canManage();
    if (!all && !await permissions.userHasPermission(socket.user.id, 'invite_users')) return;
    const rows = await db.prepare(`SELECT ic.*, ic.spent AS use_count,
      (ic.expires_at IS NOT NULL AND ic.expires_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS is_expired
      FROM invite_codes ic ${all ? '' : 'WHERE ic.created_by = ?'} ORDER BY ic.created_at DESC`).all(...(all ? [] : [socket.user.id]));
    for (const row of rows) {
      row.created_at = utcStamp(row.created_at);
      row.expires_at = utcStamp(row.expires_at);
      row.enabled = !!row.enabled;
      row.is_expired = !!row.is_expired;
      try { const parsed = JSON.parse(row.channels || '[]'); row.channels = Array.isArray(parsed) ? parsed : []; }
      catch { row.channels = []; }
    }
    socket.emit('invite-codes-list', rows);
  });
  on('get-media-cache-stats', async () => {
    if (!await canManage()) return;
    const stats = require('../mediaProxy').stats();
    socket.emit('media-cache-stats', { items: stats.items, bytes: stats.bytes });
  });
  on('get-automod-domains', async () => {
    if (!await canManage()) return socket.emit('automod-domain-list', []);
    const rows = await db.prepare(`SELECT d.domain, d.mode, d.include_subdomains, d.note, d.created_at,
      COALESCE(u.display_name, u.username) AS added_by_name
      FROM automod_domains d LEFT JOIN users u ON d.added_by = u.id ORDER BY d.mode, d.domain`).all();
    rows.forEach(row => { row.created_at = utcStamp(row.created_at); });
    socket.emit('automod-domain-list', rows);
  });
  on('get-automod-log', async data => {
    if (!await canManage()) return socket.emit('automod-log', { entries: [], hostCounts: [] });
    const limit = Number.isInteger(data?.limit) && data.limit > 0 && data.limit <= 500 ? data.limit : 100;
    const rows = await db.prepare(`SELECT i.id, i.rule, i.host, i.excerpt, i.created_at, i.user_id, i.channel_id,
      COALESCE(u.display_name, u.username, '[deleted user]') AS username, c.code AS channel_code, c.name AS channel_name
      FROM automod_infractions i LEFT JOIN users u ON i.user_id = u.id LEFT JOIN channels c ON i.channel_id = c.id
      ORDER BY i.created_at DESC LIMIT ?`).all(limit);
    const entries = [];
    for (const row of rows) {
      if (!socket.user.isAdmin && row.channel_id != null) {
        try { if ((await accessible(socket, row.channel_code)).is_dm) continue; }
        catch { continue; }
      }
      if (!socket.user.isAdmin) row.channel_code = null;
      delete row.channel_id;
      row.created_at = utcStamp(row.created_at);
      entries.push(row);
    }
    const hostCounts = await db.prepare(`SELECT host, COUNT(*) AS hits FROM automod_infractions
      WHERE host IS NOT NULL AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '7 days'
      GROUP BY host ORDER BY hits DESC LIMIT 15`).all();
    socket.emit('automod-log', { entries, hostCounts });
  });
}

function publicKey(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('Invalid public key format');
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
  return publicJwk;
}
function registerKeys(socket, on, db, io) {
  const keyReads = createEncryptionKeyReads(db);
  on('get-encrypted-key', async () => {
    const row = await keyReads.encryptedKey(socket.user.id);
    const hasBackup = !!(row && row.encrypted_private_key && row.e2e_key_salt);
    socket.emit('encrypted-key-result', {
      encryptedKey: row?.encrypted_private_key || null, salt: row?.e2e_key_salt || null,
      hasPublicKey: !!row?.public_key, publicKey: row?.public_key ? JSON.parse(row.public_key) : null,
      signingKey: row?.signing_key ? JSON.parse(row.signing_key) : null, signingBackup: row?.signing_backup || null,
      state: hasBackup ? 'present' : 'empty',
    });
  });
  for (const signing of [false, true]) {
    const column = signing ? 'signing_key' : 'public_key';
    on(signing ? 'publish-signing-key' : 'publish-public-key', async data => {
      const jwk = publicKey(data?.jwk);
      const rid = typeof data.rid === 'string' ? data.rid.slice(0, 64) : undefined;
      const backup = signing && data.backup !== undefined ? data.backup : null;
      if (backup !== null && (typeof backup !== 'string' || !backup || backup.length > 4096)) throw new Error('Invalid signing key backup');
      const result = await db.withTransaction(async tx => {
        const row = await tx.prepare(`SELECT "${column}" FROM users WHERE id = ? FOR UPDATE`).get(socket.user.id);
        if (!row) throw new Error('User not found');
        const existing = row[column] ? JSON.parse(row[column]) : null;
        const changed = existing && (existing.x !== jwk.x || existing.y !== jwk.y);
        if (changed && data.force !== true) return { conflict: existing };
        await tx.prepare(`UPDATE users SET "${column}" = ?${backup ? ', signing_backup = ?' : ''} WHERE id = ?`)
          .run(JSON.stringify(jwk), ...(backup ? [backup] : []), socket.user.id);
        if (signing) await tx.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(socket.user.id, jwk.x + '.' + jwk.y, JSON.stringify(jwk));
        return { changed };
      });
      if (result.conflict) return socket.emit(signing ? 'signing-key-conflict' : 'public-key-conflict', { existing: result.conflict, ...(signing ? { rid } : {}) });
      socket.emit(signing ? 'signing-key-published' : 'public-key-published', ...(signing ? [{ rid }] : []));
      if (result.changed) for (const other of io.sockets.sockets.values()) if (other !== socket && other.user?.id === socket.user.id) other.emit('e2e-key-sync');
    });
  }
  on('store-encrypted-key', async data => {
    if (typeof data?.encryptedKey !== 'string' || typeof data?.salt !== 'string' || data.encryptedKey.length > 4096 || data.salt.length > 128) throw new Error('Invalid encrypted key data');
    const separate = typeof data.separatePassphrase === 'boolean';
    await db.prepare(`UPDATE users SET encrypted_private_key = ?, e2e_key_salt = ?${separate ? ', e2e_passphrase = ?' : ''} WHERE id = ?`)
      .run(data.encryptedKey, data.salt, ...(separate ? [data.separatePassphrase ? 1 : 0] : []), socket.user.id);
    socket.emit('encrypted-key-stored');
  });
  on('store-signing-backup', async data => {
    if (typeof data?.backup !== 'string' || !data.backup || data.backup.length > 4096) throw new Error('Invalid signing key backup');
    await db.prepare('UPDATE users SET signing_backup = ? WHERE id = ?').run(data.backup, socket.user.id);
    socket.emit('signing-backup-stored');
  });
  on('get-public-key', async data => {
    if (!Number.isInteger(data?.userId) || data.userId <= 0) return;
    const row = await keyReads.publicKey(data.userId);
    socket.emit('public-key-result', { userId: data.userId, jwk: row?.public_key ? JSON.parse(row.public_key) : null });
  });
  on('get-signing-key', async data => {
    if (!Number.isInteger(data?.userId) || data.userId <= 0) return;
    const { row, keys } = await keyReads.signingKeys(data.userId);
    socket.emit('signing-key-result', { userId: data.userId, jwk: row?.signing_key ? JSON.parse(row.signing_key) : null, keys: keys.map(r => JSON.parse(r.jwk)) });
  });
}

module.exports = { setupPostgresPreview };
