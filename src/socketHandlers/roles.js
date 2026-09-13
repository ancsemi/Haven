'use strict';

const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { isString, isInt, VALID_ROLE_PERMS } = require('./helpers');
const { seedDefaultRoles } = require('../roleDefaults');

module.exports = function register(socket, ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    getUserPermissions, getUserGlobalPermissions, getUserRoles, getUserHighestRole,
    emitOnlineUsers, broadcastChannelLists, getEnrichedChannels,
    transferAdminRef, HAVEN_VERSION, logAudit, getAdminRoleDisplay
  } = ctx;
  const { channelUsers } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};

  // ── Helper: apply role-linked channel access ────────────
  function applyRoleChannelAccess(roleId, userId, direction) {
    const role = db.prepare('SELECT link_channel_access FROM roles WHERE id = ?').get(roleId);
    if (!role || !role.link_channel_access) return;

    const col = direction === 'grant' ? 'grant_on_promote' : 'revoke_on_demote';
    const channelRows = db.prepare(
      `SELECT channel_id FROM role_channel_access WHERE role_id = ? AND ${col} = 1`
    ).all(roleId);

    if (direction === 'grant') {
      const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      channelRows.forEach(r => ins.run(r.channel_id, userId));
    } else {
      const del = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
      channelRows.forEach(r => del.run(r.channel_id, userId));
    }

    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('channels-list', getEnrichedChannels(userId, s.user.isAdmin, (room) => s.join(room)));
      }
    }
  }

  // Expose on ctx so other modules can use it if needed
  ctx.applyRoleChannelAccess = applyRoleChannelAccess;

  // ── Helper: live-refresh for 'view_all_channels' ────────
  // A role that grants view_all_channels changes what its holder can SEE, so
  // push them a rebuilt channel list (joining the new rooms) the same way
  // applyRoleChannelAccess does, instead of it only appearing on next login.
  function roleGrantsSeeAll(roleId) {
    return !!db.prepare(
      "SELECT 1 FROM role_permissions WHERE role_id = ? AND permission = 'view_all_channels' AND allowed = 1"
    ).get(roleId);
  }
  function pushChannelList(userId) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('channels-list', getEnrichedChannels(userId, s.user.isAdmin, (room) => s.join(room)));
      }
    }
  }

  // ── Helper: undo view_all_channels auto-joins ───────────
  // Granting the permission writes a real membership row for every channel, so
  // losing it has to take those rows back. Without this, demoting a mod leaves
  // them sitting in every private channel on the server, which is the opposite
  // of what demoting someone means. No-ops when they still hold the permission
  // through some other role, and never touches memberships they got another
  // way. (#5512)
  function syncSeeAllMemberships(userId) {
    const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (row && row.is_admin) return;
    if (userHasPermission(userId, 'view_all_channels')) return;

    const losing = db.prepare(`
      SELECT c.code FROM channel_members cm
      JOIN channels c ON c.id = cm.channel_id
      WHERE cm.user_id = ? AND cm.auto_all_channels = 1
    `).all(userId);
    if (!losing.length) return;

    db.prepare('DELETE FROM channel_members WHERE user_id = ? AND auto_all_channels = 1').run(userId);

    // Leaving the rooms matters as much as the rows do: a socket still in
    // channel:<code> keeps receiving live messages from a channel the user can
    // no longer open.
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        losing.forEach(ch => s.leave(`channel:${ch.code}`));
        s.emit('channels-list', getEnrichedChannels(userId, s.user.isAdmin, (room) => s.join(room)));
      }
    }
  }

  // ── Notify helper: push one user's recomputed role state to their sockets ──
  // Recomputes from the DB, so it's correct whether the change was to the
  // user's role ASSIGNMENTS (assign/revoke/promote) or to the PERMISSIONS of a
  // role they already hold (update-role / reset-roles-to-default).
  function pushUserRoleState(userId) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.user.roles = getUserRoles(userId);
        s.user.effectiveLevel = getUserEffectiveLevel(userId);
        s.emit('roles-updated', {
          roles: s.user.roles,
          effectiveLevel: s.user.effectiveLevel,
          permissions: getUserPermissions(userId),
          globalPermissions: getUserGlobalPermissions(userId)
        });
      }
    }
  }

  // Same, plus a member-list refresh everywhere (role badges/ordering change).
  function refreshUserRoles(userId) {
    pushUserRoleState(userId);
    pushUploadCap(userId);
    syncRoleGateRooms(userId);
    for (const [code] of channelUsers) { emitOnlineUsers(code); }
  }

  // The client sizes its upload pre-checks from this; a role change can move it.
  function pushUploadCap(userId) {
    const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    const cap = row && row.is_admin
      ? (parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get()?.value, 10) || 25)
      : ctx.getUserUploadMb(userId);
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) s.emit('server-setting-changed', { key: 'max_upload_mb_effective', value: String(cap) });
    }
  }

  // Role-gated channels: a role change can open or close them for this user.
  // Holding the required roles is membership (#5649), so the rows follow the
  // roles; then leave the rooms they lost and push a fresh list either way.
  function syncRoleGateRooms(userId) {
    const gated = db.prepare('SELECT id, code, role_gate FROM channels WHERE role_gate IS NOT NULL').all();
    if (!gated.length) return;
    const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (row && row.is_admin) return;
    try { ctx.syncRoleGateMemberships({ userId }); } catch (err) { console.error('role gate membership sync failed:', err.message); }
    for (const [, s] of io.sockets.sockets) {
      if (!s.user || s.user.id !== userId) continue;
      gated.forEach(ch => { if (!ctx.roleGateAllows(userId, ch)) s.leave(`channel:${ch.code}`); });
    }
    pushChannelList(userId);
  }

  // ── Self-assign roles (role menus) ──────────────────────
  // A role menu is a message that lists roles with an emoji each. Reacting
  // with the emoji, or clicking the button under the message, gives the
  // reader the role; taking the reaction back, or clicking again, drops it.
  function readRoleMenu(row) {
    try {
      const data = JSON.parse(row.data || '{}');
      const entries = Array.isArray(data.roles) ? data.roles : [];
      if (!entries.length) return [];
      const ph = entries.map(() => '?').join(',');
      const roles = db.prepare(`SELECT id, name, color, icon, level FROM roles WHERE id IN (${ph})`).all(...entries.map(e => e.roleId));
      return entries.map(e => {
        const r = roles.find(x => x.id === e.roleId);
        return r ? { id: r.id, name: r.name, color: r.color, icon: r.icon, emoji: e.emoji } : null;
      }).filter(Boolean);
    } catch { return []; }
  }
  ctx.buildRoleMenu = (row, viewerId) => {
    const roles = readRoleMenu(row);
    if (!roles.length) return null;
    const held = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? AND channel_id IS NULL').all(viewerId).map(r => r.role_id);
    return { title: row.title || '', roles, held: roles.filter(r => held.includes(r.id)).map(r => r.id) };
  };
  function setSelfRole(userId, roleId, held, grantedBy) {
    const has = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').get(userId, roleId);
    if (held && !has) {
      db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)').run(userId, roleId, grantedBy);
      applyRoleChannelAccess(roleId, userId, 'grant');
      if (roleGrantsSeeAll(roleId)) pushChannelList(userId);
    } else if (!held && has) {
      applyRoleChannelAccess(roleId, userId, 'revoke');
      db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
      syncSeeAllMemberships(userId);
    } else return false;
    refreshUserRoles(userId);
    return true;
  }
  function notifySelfRole(target, messageId, roleId, held) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === target) s.emit('self-role-updated', { messageId, roleId, held });
    }
  }
  ctx.applySelfRoleReaction = (sock, messageId, emoji, held) => {
    const row = db.prepare('SELECT * FROM role_menus WHERE message_id = ?').get(messageId);
    if (!row) return;
    const entry = readRoleMenu(row).find(r => r.emoji === emoji);
    if (!entry) return;
    if (setSelfRole(sock.user.id, entry.id, held, row.created_by)) notifySelfRole(sock.user.id, messageId, entry.id, held);
  };

  // The role/emoji pairs of a menu, checked for this user: known roles only,
  // no repeats, and nothing at or above the poster's own level. Shared by
  // posting a menu and editing one (#5644).
  function roleMenuEntries(raw) {
    const emojiOk = /^[\p{Emoji}\p{Emoji_Component}\uFE0F\u200D]{1,8}$/u;
    const wanted = Array.isArray(raw) ? raw.slice(0, 20) : [];
    const myLevel = socket.user.isAdmin ? 100 : getUserEffectiveLevel(socket.user.id);
    const seen = new Set();
    const entries = [];
    for (const e of wanted) {
      const roleId = isInt(e && e.roleId) ? e.roleId : null;
      const emoji = isString(e && e.emoji, 1, 8) && emojiOk.test(e.emoji) ? e.emoji : null;
      if (!roleId || !emoji || seen.has(roleId) || seen.has(emoji)) continue;
      const role = db.prepare('SELECT id, name, level FROM roles WHERE id = ?').get(roleId);
      if (!role) continue;
      if (!socket.user.isAdmin && role.level >= myLevel) return { error: `${role.name} is not below your level (${myLevel})` };
      seen.add(roleId); seen.add(emoji);
      entries.push({ roleId, emoji, name: role.name });
    }
    if (!entries.length) return { error: 'Pick at least one role with an emoji' };
    return { entries };
  }
  function roleMenuContent(title, entries) {
    return [title ? `🎭 ${title}` : '🎭 Pick your roles', ...entries.map(e => `${e.emoji}  ${e.name}`)].join('\n');
  }
  function canManageRoleMenus() {
    return socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_roles') || userHasPermission(socket.user.id, 'promote_user');
  }
  function messageReactions(messageId) {
    return db.prepare(`
      SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
      JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
    `).all(messageId);
  }

  // What a posted menu holds, for the editor to start from (#5644).
  socket.on('get-role-menu', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object' || !isInt(data.messageId)) return cb({ error: 'Invalid request' });
    if (!canManageRoleMenus()) return cb({ error: 'You lack permission to hand out roles' });
    const row = db.prepare(`
      SELECT rm.message_id, rm.title, rm.data, m.content, c.code
      FROM role_menus rm JOIN messages m ON m.id = rm.message_id JOIN channels c ON c.id = rm.channel_id
      WHERE rm.message_id = ?
    `).get(data.messageId);
    if (!row) return cb({ error: 'That role menu is gone' });
    let roles = [];
    try { roles = JSON.parse(row.data || '{}').roles || []; } catch { /* malformed row: start empty */ }
    cb({
      messageId: row.message_id, channelCode: row.code, title: row.title || '', content: row.content || '',
      roles: roles.filter(r => r && isInt(r.roleId)).map(r => ({ roleId: r.roleId, emoji: String(r.emoji || '') }))
    });
  });

  // Change the roles, emojis and text of a menu that is already posted. The
  // message is edited in place, so the buttons and chips people already see
  // update where they are (#5644).
  socket.on('update-role-menu', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object' || !isInt(data.messageId)) return cb({ error: 'Invalid request' });
    if (!canManageRoleMenus()) return cb({ error: 'You lack permission to hand out roles' });
    const row = db.prepare('SELECT rm.*, c.code FROM role_menus rm JOIN channels c ON c.id = rm.channel_id WHERE rm.message_id = ?').get(data.messageId);
    if (!row) return cb({ error: 'That role menu is gone' });
    const parsed = roleMenuEntries(data.roles);
    if (parsed.error) return cb({ error: parsed.error });
    const { sanitizeText } = require('./helpers');
    const maxChars = parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get()?.value, 10) || 2000;
    const custom = isString(data.content, 1, maxChars) ? sanitizeText(data.content.trim()) : '';
    const content = custom || roleMenuContent(row.title, parsed.entries);
    const before = readRoleMenu(row).map(r => r.emoji);
    const after = parsed.entries.map(e => e.emoji);
    try {
      db.transaction(() => {
        db.prepare('UPDATE role_menus SET data = ? WHERE message_id = ?')
          .run(JSON.stringify({ roles: parsed.entries.map(e => ({ roleId: e.roleId, emoji: e.emoji })) }), row.message_id);
        db.prepare("UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?").run(content, row.message_id);
        // A chip for an emoji that left the menu was only ever a role toggle,
        // so it goes; a new emoji gets a seed chip so there is one to click.
        const del = db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ?');
        before.filter(e => !after.includes(e)).forEach(e => del.run(row.message_id, e));
        const seed = db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)');
        parsed.entries.forEach(e => seed.run(row.message_id, socket.user.id, e.emoji));
      })();
    } catch (err) {
      console.error('update-role-menu error:', err);
      return cb({ error: 'Failed to update the role menu' });
    }
    const fresh = db.prepare('SELECT * FROM role_menus WHERE message_id = ?').get(row.message_id);
    io.to(`channel:${row.code}`).emit('message-edited', { channelCode: row.code, messageId: row.message_id, content, editedAt: new Date().toISOString() });
    io.to(`channel:${row.code}`).emit('reactions-updated', { channelCode: row.code, messageId: row.message_id, reactions: messageReactions(row.message_id) });
    for (const [, s] of io.sockets.sockets) {
      if (!s.user || !s.rooms.has(`channel:${row.code}`)) continue;
      s.emit('role-menu-updated', { channelCode: row.code, messageId: row.message_id, roleMenu: ctx.buildRoleMenu(fresh, s.user.id) });
    }
    cb({ success: true });
    _audit({ actor: socket.user, action: 'role_menu_update',
      target_type: 'channel', target_id: row.channel_id, target_name: row.code,
      details: { messageId: row.message_id, roles: parsed.entries.map(e => ({ roleId: e.roleId, emoji: e.emoji })) } });
  });

  socket.on('create-role-menu', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    if (!canManageRoleMenus()) {
      return cb({ error: 'You lack permission to hand out roles' });
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });
    const channel = db.prepare('SELECT id, name, code FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return cb({ error: 'Channel not found' });
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return cb({ error: 'Not a member of this channel' });
    const { sanitizeText } = require('./helpers');
    const title = isString(data.title, 0, 120) ? sanitizeText(data.title.trim()) : '';
    const parsed = roleMenuEntries(data.roles);
    if (parsed.error) return cb({ error: parsed.error });
    const entries = parsed.entries;
    const content = roleMenuContent(title, entries);
    try {
      const result = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(channel.id, socket.user.id, content);
      const messageId = result.lastInsertRowid;
      db.prepare('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)')
        .run(messageId, channel.id, socket.user.id, title, JSON.stringify({ roles: entries.map(e => ({ roleId: e.roleId, emoji: e.emoji })) }));
      // Seed one reaction per emoji so the chips are there to click; the
      // poster's own click does not hand them the role (see applySelfRoleReaction
      // needing a real socket event for that).
      const seed = db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)');
      entries.forEach(e => seed.run(messageId, socket.user.id, e.emoji));
      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
      `).all(messageId);
      const row = db.prepare('SELECT * FROM role_menus WHERE message_id = ?').get(messageId);
      const base = {
        id: messageId, content, created_at: new Date().toISOString(),
        username: socket.user.displayName, user_id: socket.user.id,
        avatar: socket.user.avatar || null, avatar_shape: socket.user.avatar_shape || 'circle',
        border: socket.user.border || null, borderTransform: socket.user.borderTransform || null,
        animateProfile: socket.user.animate_profile || 'trigger',
        reply_to: null, replyContext: null, reactions, edited_at: null, thread: null
      };
      // Every reader gets their own "held" list, so this goes out per socket.
      for (const [, s] of io.sockets.sockets) {
        if (!s.user || !s.rooms.has(`channel:${code}`)) continue;
        s.emit('new-message', { channelCode: code, message: { ...base, roleMenu: ctx.buildRoleMenu(row, s.user.id) } });
      }
      cb({ success: true, messageId });
      _audit({ actor: socket.user, action: 'role_menu_create',
        target_type: 'channel', target_id: channel.id, target_name: channel.name,
        details: { messageId, roles: entries.map(e => ({ roleId: e.roleId, emoji: e.emoji })) } });
    } catch (err) {
      console.error('create-role-menu error:', err);
      cb({ error: 'Failed to post the role menu' });
    }
  });

  socket.on('toggle-self-role', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const messageId = isInt(data.messageId) ? data.messageId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!messageId || !roleId) return cb({ error: 'Invalid request' });
    const row = db.prepare('SELECT * FROM role_menus WHERE message_id = ?').get(messageId);
    if (!row) return cb({ error: 'That role menu is gone' });
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(row.channel_id, socket.user.id);
    if (!member && !socket.user.isAdmin) return cb({ error: 'Not a member of this channel' });
    const entry = readRoleMenu(row).find(r => r.id === roleId);
    if (!entry) return cb({ error: 'That role is not on the menu' });
    const has = !!db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').get(socket.user.id, roleId);
    const held = data.held === undefined ? !has : !!data.held;
    setSelfRole(socket.user.id, roleId, held, row.created_by);
    // Mirror the state onto the reaction chip so both paths agree.
    if (held) db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, socket.user.id, entry.emoji);
    else db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, socket.user.id, entry.emoji);
    const reactions = db.prepare(`
      SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
      JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
    `).all(messageId);
    const ch = db.prepare('SELECT code FROM channels WHERE id = ?').get(row.channel_id);
    if (ch) io.to(`channel:${ch.code}`).emit('reactions-updated', { channelCode: ch.code, messageId, reactions });
    notifySelfRole(socket.user.id, messageId, roleId, held);
    cb({ success: true, held });
  });

  // ── Get roles ───────────────────────────────────────────
  socket.on('get-roles', (data, callback) => {
    const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
    const permissions = db.prepare('SELECT * FROM role_permissions').all();
    const permMap = {};
    permissions.forEach(p => {
      if (!permMap[p.role_id]) permMap[p.role_id] = [];
      permMap[p.role_id].push(p.permission);
    });
    roles.forEach(r => { r.permissions = permMap[r.id] || []; });
    if (typeof callback === 'function') callback({ roles });
    else if (typeof data === 'function') data({ roles });
    else socket.emit('roles-list', roles);
  });

  socket.on('get-user-roles', (data) => {
    if (!data || typeof data !== 'object') return;
    const userId = isInt(data.userId) ? data.userId : null;
    if (!userId) return;
    const roles = getUserRoles(userId);
    const highestRole = getUserHighestRole(userId);
    socket.emit('user-roles', { userId, roles, highestRole });
  });

  // ── Get channel member roles ────────────────────────────
  socket.on('get-channel-member-roles', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can view channel roles' });
    }

    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });

    const channel = db.prepare('SELECT id, name FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });

    const members = db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) as displayName,
             u.username as loginName, u.avatar, u.avatar_shape, u.is_admin
      FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      WHERE cm.channel_id = ?
      ORDER BY COALESCE(u.display_name, u.username)
    `).all(channel.id);

    const memberIds = members.map(m => m.id);
    const userRolesMap = {};
    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',');
      const roleRows = db.prepare(`
        SELECT ur.user_id, r.id as role_id, r.name, r.level, r.color, r.icon, ur.channel_id
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id IN (${placeholders})
          AND (ur.channel_id IS NULL OR ur.channel_id = ?)
        ORDER BY r.level DESC
      `).all(...memberIds, channel.id);
      roleRows.forEach(row => {
        if (!userRolesMap[row.user_id]) userRolesMap[row.user_id] = [];
        userRolesMap[row.user_id].push({
          roleId: row.role_id, name: row.name, level: row.level,
          color: row.color, icon: row.icon, scope: row.channel_id ? 'channel' : 'server'
        });
      });
    }

    const result = members.map(m => ({
      id: m.id, displayName: m.displayName, loginName: m.loginName,
      avatar: m.avatar, avatarShape: m.avatar_shape || 'circle',
      isAdmin: !!m.is_admin, roles: userRolesMap[m.id] || []
    }));

    cb({ channelId: channel.id, channelName: channel.name, members: result });
  });

  // ── Admin role cosmetic display (admin only) ────────────
  // The admin role is synthetic (there is no row for it in `roles`). These
  // handlers persist a purely cosmetic override in server_settings under
  // 'admin_role_display'. Nothing here affects is_admin, level or permissions.
  socket.on('get-admin-role-display', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only the admin can view this' });
    cb({ display: getAdminRoleDisplay() });
  });

  socket.on('update-admin-role-display', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only the admin can edit this' });
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });

    // Validated like create/update-role; invalid fields fall back to the safe
    // default rather than being rejected, since this is cosmetic only.
    const name = isString(data.name, 1, 30) ? data.name.trim() : 'Admin';
    const color = (isString(data.color, 4, 7) && /^#[0-9a-fA-F]{3,6}$/.test(data.color)) ? data.color : '#e74c3c';
    const icon = (isString(data.icon, 1, 512) && /^\/uploads\//i.test(data.icon)) ? data.icon : null;
    const visible = data.visible !== false;

    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('admin_role_display', ?)")
      .run(JSON.stringify({ name, color, icon, visible }));

    // Refresh every live display: member lists re-read getUserHighestRole and
    // clients re-fetch role-driven UI on roles-updated.
    for (const [code] of channelUsers) { emitOnlineUsers(code); }
    io.except('bot-sockets').emit('roles-updated');

    cb({ success: true, display: { name, color, icon, visible } });
    _audit({ actor: socket.user, action: 'admin_role_display_update',
      target_type: 'server', target_id: null, target_name: 'admin_role_display',
      details: { name, color, icon, visible } });
  });

  // ── Create role ─────────────────────────────────────────
  socket.on('create-role', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can create roles' });
    }

    const name = isString(data.name, 1, 30) ? data.name.trim() : '';
    if (!name) return cb({ error: 'Role name required (1-30 chars)' });

    const level = isInt(data.level) && data.level >= 0 && data.level <= 99 ? data.level : 25;
    const scope = data.scope === 'channel' ? 'channel' : 'server';
    const color = isString(data.color, 4, 7) && /^#[0-9a-fA-F]{3,6}$/.test(data.color) ? data.color : null;
    const autoAssign = data.autoAssign ? 1 : 0;
    const icon = isString(data.icon, 1, 512) && /^\/uploads\//i.test(data.icon) ? data.icon : null;
    const maxUploadMb = isInt(data.maxUploadMb) && data.maxUploadMb >= 1 && data.maxUploadMb <= 102400 ? data.maxUploadMb : null;

    // A non-admin cannot create a role at or above their own level (they'd be
    // unable to assign it anyway, and it must not sit at/over their rank).
    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id);
      if (level >= myLevel) {
        return cb({ error: `You can only create roles below your level (${myLevel})` });
      }
    }

    try {
      if (autoAssign) {
        db.prepare('UPDATE roles SET auto_assign = 0').run();
      }
      const result = db.prepare(
        'INSERT INTO roles (name, level, scope, color, auto_assign, icon, max_upload_mb) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(name, level, scope, color, autoAssign, icon, maxUploadMb);

      const perms = level > 0 && Array.isArray(data.permissions) ? data.permissions : [];
      const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];
      const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
      perms.forEach(p => {
        if (!VALID_ROLE_PERMS.includes(p)) return;
        if (!socket.user.isAdmin && (adminOnlyPerms.includes(p) || !userHasPermission(socket.user.id, p))) return;
        insertPerm.run(result.lastInsertRowid, p);
      });

      cb({ success: true, roleId: result.lastInsertRowid });
      _audit({ actor: socket.user, action: 'role_create',
        target_type: 'role', target_id: result.lastInsertRowid, target_name: name,
        details: { level, scope, color, autoAssign: !!autoAssign, permissions: perms } });
    } catch (err) {
      console.error('Create role error:', err);
      cb({ error: 'Failed to create role' });
    }
  });

  // ── Update role ─────────────────────────────────────────
  socket.on('update-role', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can edit roles' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return;

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });

    // Role hierarchy: a non-admin may only edit roles strictly below their own
    // level, and may never raise a role to or above their level. This is the
    // real guard behind the behaviour that used to happen by accident — editing
    // a peer or higher role would nuke its permissions and lock the caller out,
    // while the level change itself still went through. Viewing is unaffected
    // (get-roles has no such gate). Mirrors assign-role / promote-user.
    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id);
      if (role.level >= myLevel) {
        return cb({ error: `You can only edit roles below your level (${myLevel})` });
      }
      if (isInt(data.level) && data.level >= myLevel) {
        return cb({ error: `A role's level must stay below your own (${myLevel})` });
      }
    }
    const newLevel = isInt(data.level) && data.level >= 0 && data.level <= 99 ? data.level : role.level;
    let permissionsChanged = false;

    const updateRoleTx = db.transaction(() => {
      const updates = [];
      const values = [];

      if (isString(data.name, 1, 30)) { updates.push('name = ?'); values.push(data.name.trim()); }
      if (isInt(data.level) && data.level >= 0 && data.level <= 99) { updates.push('level = ?'); values.push(data.level); }
      if (data.color !== undefined) {
        const safeColor = (isString(data.color, 4, 7) && /^#[0-9a-fA-F]{3,6}$/.test(data.color)) ? data.color : null;
        updates.push('color = ?'); values.push(safeColor);
      }
      if (data.icon !== undefined) {
        const safeIcon = (isString(data.icon, 1, 512) && /^\/uploads\//i.test(data.icon)) ? data.icon : null;
        updates.push('icon = ?'); values.push(safeIcon);
      }
      if (data.autoAssign !== undefined) {
        if (data.autoAssign) {
          db.prepare('UPDATE roles SET auto_assign = 0').run();
        }
        updates.push('auto_assign = ?'); values.push(data.autoAssign ? 1 : 0);
      }
      if (data.linkChannelAccess !== undefined) {
        updates.push('link_channel_access = ?'); values.push(data.linkChannelAccess ? 1 : 0);
      }
      if (data.maxUploadMb !== undefined) {
        const cap = isInt(data.maxUploadMb) && data.maxUploadMb >= 1 && data.maxUploadMb <= 102400 ? data.maxUploadMb : null;
        updates.push('max_upload_mb = ?'); values.push(cap);
      }

      if (updates.length > 0) {
        values.push(roleId);
        db.prepare(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      if (newLevel === 0) {   // Remove all permissions if the new level is 0.
        const result = db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
        permissionsChanged = result.changes > 0;
      }
      else if (Array.isArray(data.permissions)) {
        const requested = data.permissions.filter(p => VALID_ROLE_PERMS.includes(p));

        // Resolve the final permission set BEFORE deleting anything. The old
        // code deleted the role's permissions first and then re-checked each
        // requested perm with userHasPermission(caller) — inside the same
        // transaction, so the delete was already visible. When a non-admin
        // edited the very role that granted their own permissions, that source
        // was gone at check time, so every perm they "no longer had" was
        // silently dropped, wiping it for every other member of the role too.
        // We now snapshot the caller's rights up front and preserve any
        // permission they don't personally control (admin-only perms, or perms
        // they lack) exactly as the role already had them — a non-admin can
        // only add or remove perms they actually hold, and never deletes the
        // rest as a side effect.
        const currentPerms = db.prepare(
          'SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1'
        ).all(roleId).map(r => r.permission);
        let finalPerms;
        if (socket.user.isAdmin) {
          finalPerms = requested;
        } else {
          const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];
          const callerPerms = new Set(getUserPermissions(socket.user.id));
          const controllable = (p) => !adminOnlyPerms.includes(p) && (callerPerms.has('*') || callerPerms.has(p));
          const lockedKept = currentPerms.filter(p => !controllable(p));
          const controlledChosen = requested.filter(p => controllable(p));
          finalPerms = [...new Set([...lockedKept, ...controlledChosen])];
        }
        permissionsChanged = currentPerms.length !== finalPerms.length || currentPerms.some(p => !finalPerms.includes(p));

        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
        const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
        finalPerms.forEach(p => insertPerm.run(roleId, p));
      }
    });
    updateRoleTx();

    const freshRoles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
    const perms = db.prepare('SELECT * FROM role_permissions').all();
    const pm = {};
    perms.forEach(p => { if (!pm[p.role_id]) pm[p.role_id] = []; pm[p.role_id].push(p.permission); });
    freshRoles.forEach(r => { r.permissions = pm[r.id] || []; });

    for (const [code] of channelUsers) { emitOnlineUsers(code); }

    // Editing a role's PERMISSIONS changes what every member of that role can
    // do, so each of them needs their own recomputed permission set pushed.
    // The broadcast below carries no payload — it's only a "the server's role
    // list changed" nudge for open Role Management modals — so without this
    // loop a moderator granted e.g. ban_ip kept their stale permission set
    // (and the hidden IP-ban option) until they reconnected.
    const affected = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(roleId);
    for (const row of affected) pushUserRoleState(row.user_id);
    // If the edit granted view_all_channels, every holder's visible channel
    // set just grew — refresh their lists live, like assign-role does.
    if (roleGrantsSeeAll(roleId)) for (const row of affected) pushChannelList(row.user_id);
    else for (const row of affected) syncSeeAllMemberships(row.user_id);

    const nameChanged = data.name !== undefined && isString(data.name, 1, 30) && data.name.trim() !== role.name;
    const levelChanged = data.level !== undefined && newLevel !== role.level;
    const newPermissions = permissionsChanged ? (newLevel === 0 ? [] : data.permissions): undefined;

    socket.broadcast.except('bot-sockets').emit('roles-updated');
    cb({ success: true, roles: freshRoles });
    _audit({ actor: socket.user, action: 'role_update',
      target_type: 'role', target_id: roleId, target_name: role.name,
      details: {
        nameChanged,
        levelChanged,
        permissionsChanged,
        permissions: newPermissions
      } });
  });

  // ── Delete role ─────────────────────────────────────────
  socket.on('delete-role', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can delete roles' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return;

    // Read the holders first: after the delete there is nothing left to ask.
    const heldBy = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(roleId);
    const deletedSeeAll = roleGrantsSeeAll(roleId);
    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM role_channel_access WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
    // A gate that named this role must stop asking for it.
    for (const ch of db.prepare('SELECT id, role_gate FROM channels WHERE role_gate IS NOT NULL').all()) {
      const gate = ctx.parseRoleGate(ch.role_gate);
      if (!gate || !gate.roles.includes(roleId)) continue;
      const rest = gate.roles.filter(r => r !== roleId);
      db.prepare('UPDATE channels SET role_gate = ? WHERE id = ?').run(rest.length ? JSON.stringify({ mode: gate.mode, roles: rest }) : null, ch.id);
    }
    // Gates changed, so who is a member through them may have too (#5649).
    try { ctx.syncRoleGateMemberships(); } catch (err) { console.error('role gate membership sync failed:', err.message); }
    broadcastChannelLists();
    if (deletedSeeAll) for (const r of heldBy) syncSeeAllMemberships(r.user_id);
    for (const [code] of channelUsers) { emitOnlineUsers(code); }
    cb({ success: true });
    _audit({ actor: socket.user, action: 'role_delete',
      target_type: 'role', target_id: roleId, target_name: null,
      details: null });
  });

  function canManagePermPanel(socket) {
    return !!(socket.user && (socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_roles')));
  }

  function serverRolesWithPerms() {
    const roles = db.prepare(`
      SELECT * FROM roles
      WHERE (scope = 'server' OR scope IS NULL) AND level > 0
      ORDER BY level DESC
    `).all();
    const permissions = db.prepare('SELECT * FROM role_permissions').all();
    const permMap = {};
    permissions.forEach(p => {
      if (!permMap[p.role_id]) permMap[p.role_id] = [];
      permMap[p.role_id].push(p.permission);
    });
    roles.forEach(r => { r.permissions = permMap[r.id] || []; });
    return roles;
  }

  function primaryServerRole(userId) {
    return db.prepare(`
      SELECT r.* FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.channel_id IS NULL AND r.scope = 'server' AND r.level > 0
      ORDER BY COALESCE(ur.custom_level, r.level) DESC
      LIMIT 1
    `).get(userId);
  }

  socket.on('get-perm-panel', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!canManagePermPanel(socket)) return cb({ error: 'Only admins can manage permissions' });
    try {
      const roles = serverRolesWithPerms();
      let users = [];
      try {
        const rows = db.prepare(`
          SELECT id, username, COALESCE(display_name, username) as displayName,
                 avatar, avatar_shape, is_admin
          FROM users
          ORDER BY is_admin DESC, displayName COLLATE NOCASE
        `).all();
        const assignments = db.prepare(`
          SELECT ur.user_id, ur.role_id FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
          WHERE ur.channel_id IS NULL AND (r.scope = 'server' OR r.scope IS NULL)
        `).all();
        const byUser = {};
        assignments.forEach(a => {
          if (!byUser[a.user_id]) byUser[a.user_id] = [];
          byUser[a.user_id].push(a.role_id);
        });
        users = rows.map(u => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatar: u.avatar,
          avatarShape: u.avatar_shape || 'circle',
          isAdmin: !!u.is_admin,
          roleIds: byUser[u.id] || [],
          permissions: getUserGlobalPermissions(u.id),
        }));
      } catch (userErr) {
        console.error('get-perm-panel users error:', userErr);
      }
      cb({ roles, users });
    } catch (err) {
      console.error('get-perm-panel error:', err);
      cb({ error: 'Failed to load permissions' });
    }
  });

  socket.on('set-user-server-role', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!canManagePermPanel(socket)) return cb({ error: 'Only admins can manage permissions' });
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Missing user or role' });
    if (userId === socket.user.id) return cb({ error: 'You cannot change your own role here' });
    const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId);
    if (!target) return cb({ error: 'User not found' });
    if (target.is_admin) return cb({ error: 'The host keeps Admin. Transfer admin from Server settings.' });
    const role = db.prepare("SELECT * FROM roles WHERE id = ? AND scope = 'server' AND level > 0").get(roleId);
    if (!role) return cb({ error: 'Role not found' });
    if (!socket.user.isAdmin && role.level >= getUserEffectiveLevel(socket.user.id)) {
      return cb({ error: `You can only assign roles below your level` });
    }
    try {
      db.prepare(`
        DELETE FROM user_role_perms WHERE user_id = ? AND channel_id IS NULL
          AND role_id IN (SELECT id FROM roles WHERE scope = 'server')
      `).run(userId);
      db.prepare(`
        DELETE FROM user_roles WHERE user_id = ? AND channel_id IS NULL
          AND role_id IN (SELECT id FROM roles WHERE scope = 'server')
      `).run(userId);
      db.prepare(
        'INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)'
      ).run(userId, roleId, socket.user.id);
      applyRoleChannelAccess(roleId, userId, 'grant');
      refreshUserRoles(userId);
      io.except('bot-sockets').emit('roles-updated');
      cb({ success: true, permissions: getUserGlobalPermissions(userId), roleIds: [roleId] });
    } catch (err) {
      console.error('set-user-server-role error:', err);
      cb({ error: 'Failed to set role' });
    }
  });

  socket.on('set-user-server-perms', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!canManagePermPanel(socket)) return cb({ error: 'Only admins can manage permissions' });
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const userId = isInt(data.userId) ? data.userId : null;
    if (!userId || !Array.isArray(data.permissions)) return cb({ error: 'Missing user or permissions' });
    if (userId === socket.user.id) return cb({ error: 'You cannot change your own permissions here' });
    const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId);
    if (!target) return cb({ error: 'User not found' });
    if (target.is_admin) return cb({ error: 'The host already has every permission' });

    let role = primaryServerRole(userId);
    if (!role) {
      const auto = db.prepare("SELECT * FROM roles WHERE auto_assign = 1 AND scope = 'server' LIMIT 1").get();
      if (!auto) return cb({ error: 'This user has no role to attach permissions to' });
      db.prepare(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)'
      ).run(userId, auto.id, socket.user.id);
      role = auto;
    }
    if (!socket.user.isAdmin && role.level >= getUserEffectiveLevel(socket.user.id)) {
      return cb({ error: 'You can only edit people below your level' });
    }

    const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];
    const requested = data.permissions.filter(p => {
      if (typeof p !== 'string' || !VALID_ROLE_PERMS.includes(p)) return false;
      if (!socket.user.isAdmin && (adminOnlyPerms.includes(p) || !userHasPermission(socket.user.id, p))) return false;
      return true;
    });
    const rolePerms = db.prepare(
      'SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1'
    ).all(role.id).map(r => r.permission);

    try {
      db.prepare('DELETE FROM user_role_perms WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, role.id);
      const insert = db.prepare(
        'INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed) VALUES (?, ?, NULL, ?, ?)'
      );
      for (const p of requested) {
        if (!rolePerms.includes(p)) insert.run(userId, role.id, p, 1);
      }
      for (const p of rolePerms) {
        if (!requested.includes(p)) insert.run(userId, role.id, p, 0);
      }
      refreshUserRoles(userId);
      cb({ success: true, permissions: getUserGlobalPermissions(userId), roleIds: [role.id] });
    } catch (err) {
      console.error('set-user-server-perms error:', err);
      cb({ error: 'Failed to update permissions' });
    }
  });

  // ── Reset roles to default ─────────────────────────────
  socket.on('reset-roles-to-default', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only admins can reset roles' });

    try {
      db.exec('DELETE FROM user_role_perms');
      db.exec('DELETE FROM user_roles');
      db.exec('DELETE FROM role_permissions');
      db.exec('DELETE FROM role_channel_access');
      db.exec('DELETE FROM roles');

      seedDefaultRoles(db);

      const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1 AND scope = ?').all('server');
      for (const ar of autoRoles) {
        db.prepare(`
          INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by)
          SELECT u.id, ?, NULL, NULL FROM users u
        `).run(ar.id);
      }

      for (const [code] of channelUsers) { emitOnlineUsers(code); }
      // Every role was just torn down and rebuilt, so every connected user's
      // permission set changed. Push each one their own recomputed state —
      // the payload-less broadcast below only nudges open role managers.
      const seen = new Set();
      for (const [, s] of io.sockets.sockets) {
        if (s.user && !s.user.isBot && !seen.has(s.user.id)) { seen.add(s.user.id); pushUserRoleState(s.user.id); }
      }
      io.except('bot-sockets').emit('roles-updated');
      cb({ success: true });
    } catch (err) {
      cb({ error: 'Failed to reset roles: ' + err.message });
    }
  });

  // ── Get role assignment data (three-pane) ───────────────
  socket.on('get-role-assignment-data', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'promote_user') && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'You lack permission to manage roles' });
    }

    try {
      const callerId = socket.user.id;
      const callerIsAdmin = socket.user.isAdmin;
      const callerServerLevel = getUserEffectiveLevel(callerId);

      const callerChannels = db.prepare(`
        SELECT c.id, c.name, c.code, c.parent_channel_id, c.position
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 0
        ORDER BY c.position, c.name
      `).all(callerId);

      if (callerChannels.length === 0) {
        const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
        const permissions = db.prepare('SELECT * FROM role_permissions').all();
        const permMap = {};
        permissions.forEach(p => { if (!permMap[p.role_id]) permMap[p.role_id] = []; permMap[p.role_id].push(p.permission); });
        roles.forEach(r => { r.permissions = permMap[r.id] || []; });
        return cb({ users: [], userChannelMap: {}, channels: [], roles, callerPerms: getUserPermissions(callerId), callerLevel: callerServerLevel, callerIsAdmin });
      }

      const allMembers = db.prepare(`
        SELECT DISTINCT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
               u.avatar, u.avatar_shape, u.is_admin
        FROM users u
        JOIN channel_members cm ON u.id = cm.user_id
        WHERE cm.channel_id IN (${callerChannels.map(() => '?').join(',')})
          AND u.id != ?
        ORDER BY COALESCE(u.display_name, u.username)
      `).all(...callerChannels.map(c => c.id), callerId);

      const users = [];
      const userChannelMap = {};
      for (const m of allMembers) {
        if (m.is_admin) continue;
        const userServerLevel = getUserEffectiveLevel(m.id);
        if (!callerIsAdmin && userServerLevel >= callerServerLevel) continue;

        const uChans = db.prepare(`
          SELECT cm.channel_id FROM channel_members cm
          WHERE cm.user_id = ? AND cm.channel_id IN (${callerChannels.map(() => '?').join(',')})
        `).all(m.id, ...callerChannels.map(c => c.id));

        const sharedChannels = [];
        for (const uc of uChans) {
          const callerChanLevel = getUserEffectiveLevel(callerId, uc.channel_id);
          const userChanLevel = getUserEffectiveLevel(m.id, uc.channel_id);
          if (callerIsAdmin || callerChanLevel > userChanLevel) {
            sharedChannels.push(uc.channel_id);
          }
        }
        if (sharedChannels.length === 0 && !callerIsAdmin) continue;

        const currentRoles = db.prepare(`
          SELECT ur.role_id, ur.channel_id, r.name, r.level, r.color
          FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = ?
          GROUP BY ur.role_id, COALESCE(ur.channel_id, -1)
        `).all(m.id);

        // Compute effective permissions per (role, channel) so the RAC can
        // re-display the user's actual saved customisations on reopen
        // instead of always falling back to the role's defaults.
        let userOverrides = [];
        try {
          userOverrides = db.prepare(
            'SELECT role_id, channel_id, permission, allowed FROM user_role_perms WHERE user_id = ?'
          ).all(m.id);
        } catch { /* table may not exist yet */ }

        for (const cr of currentRoles) {
          const basePerms = db.prepare(
            'SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1'
          ).all(cr.role_id).map(r => r.permission);
          const effective = new Set(basePerms);
          for (const ov of userOverrides) {
            if (ov.role_id !== cr.role_id) continue;
            const ovChan = ov.channel_id == null ? null : ov.channel_id;
            const crChan = cr.channel_id == null ? null : cr.channel_id;
            if (ovChan !== crChan) continue;
            if (ov.allowed === 1) effective.add(ov.permission);
            else if (ov.allowed === 0) effective.delete(ov.permission);
          }
          cr.effectivePerms = [...effective];
        }

        users.push({
          id: m.id, username: m.username, displayName: m.displayName,
          avatar: m.avatar || null, avatarShape: m.avatar_shape || 'circle',
          serverLevel: userServerLevel, currentRoles
        });
        userChannelMap[m.id] = sharedChannels;
      }

      const channelsWithHierarchy = callerChannels.map(c => ({
        id: c.id, name: c.name, code: c.code,
        parentId: c.parent_channel_id, position: c.position
      }));

      const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
      const permissions = db.prepare('SELECT * FROM role_permissions').all();
      const permMap = {};
      permissions.forEach(p => { if (!permMap[p.role_id]) permMap[p.role_id] = []; permMap[p.role_id].push(p.permission); });
      roles.forEach(r => { r.permissions = permMap[r.id] || []; });

      const callerPerms = getUserPermissions(callerId);

      cb({
        users, userChannelMap, channels: channelsWithHierarchy,
        roles, callerPerms, callerLevel: callerServerLevel, callerIsAdmin
      });
    } catch (err) {
      console.error('get-role-assignment-data error:', err);
      cb({ error: 'Failed to load role assignment data' });
    }
  });

  // ── Assign role ─────────────────────────────────────────
  socket.on('assign-role', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'promote_user')) {
      return cb({ error: 'You lack permission to assign roles' });
    }

    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Missing userId or roleId' });

    if (userId === socket.user.id) {
      return cb({ error: 'You cannot modify your own roles' });
    }

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });

    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id);
      if (role.level >= myLevel) {
        return cb({ error: `You can only assign roles below your level (${myLevel})` });
      }
    }

    const channelId = isInt(data.channelId) ? data.channelId : null;

    let assignLevel = role.level;
    if (data.customLevel !== undefined && data.customLevel !== null) {
      const cl = parseInt(data.customLevel);
      if (!isNaN(cl) && cl >= 1 && cl <= 99) {
        if (!socket.user.isAdmin) {
          const myLevel = getUserEffectiveLevel(socket.user.id);
          if (cl >= myLevel) {
            return cb({ error: `Custom level must be below your level (${myLevel})` });
          }
        }
        assignLevel = cl;
      }
    }

    try {
      // The RAC supports multiple roles per scope; only replace the row for
      // *this* (user, role, channel) tuple instead of wiping every role at
      // the scope (which made it impossible to hold more than one role per
      // channel/server-wide and silently revoked sibling roles when the
      // admin saved an edit to one of them).
      if (channelId) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
      } else {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
      }
      db.prepare(
        'INSERT INTO user_roles (user_id, role_id, channel_id, granted_by, custom_level) VALUES (?, ?, ?, ?, ?)'
      ).run(userId, roleId, channelId, socket.user.id, assignLevel !== role.level ? assignLevel : null);

      if (data.customPerms && Array.isArray(data.customPerms)) {
        if (channelId) {
          db.prepare('DELETE FROM user_role_perms WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
        } else {
          db.prepare('DELETE FROM user_role_perms WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
        }
        const rolePerms = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1').all(roleId).map(r => r.permission);
        // Sanitize: drop unknown perms, drop admin-only perms unless caller
        // is admin, and drop any perm the caller doesn't currently hold.
        // This prevents a non-admin promoter from escalating perms via a
        // crafted customPerms payload.
        const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];
        const callerPermsSet = socket.user.isAdmin ? null : new Set(getUserPermissions(socket.user.id));
        const customPerms = data.customPerms.filter(p => {
          if (typeof p !== 'string') return false;
          if (!VALID_ROLE_PERMS.includes(p)) return false;
          if (socket.user.isAdmin) return true;
          if (adminOnlyPerms.includes(p)) return false;
          return callerPermsSet.has('*') || callerPermsSet.has(p);
        });
        // Inherit any previously-held overrides we are not authorised to touch
        // (e.g. an admin-only perm previously granted by an admin) so a
        // non-admin promoter can't strip them.
        if (!socket.user.isAdmin) {
          const existingHeld = rolePerms.filter(p => adminOnlyPerms.includes(p) || !callerPermsSet.has(p));
          for (const p of existingHeld) {
            if (!customPerms.includes(p)) customPerms.push(p);
          }
        }
        const added = customPerms.filter(p => !rolePerms.includes(p));
        const removed = rolePerms.filter(p => !customPerms.includes(p));
        if (added.length > 0 || removed.length > 0) {
          const insertStmt = db.prepare('INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed) VALUES (?, ?, ?, ?, ?)');
          for (const p of added) insertStmt.run(userId, roleId, channelId, p, 1);
          for (const p of removed) insertStmt.run(userId, roleId, channelId, p, 0);
        }
      }

      applyRoleChannelAccess(roleId, userId, 'grant');
      if (roleGrantsSeeAll(roleId)) pushChannelList(userId);
      refreshUserRoles(userId);
      cb({ success: true });
      try {
        const tgt = db.prepare('SELECT COALESCE(display_name, username) AS u FROM users WHERE id = ?').get(userId);
        _audit({ actor: socket.user, action: 'role_assign',
          target_type: 'user', target_id: userId, target_name: tgt ? tgt.u : null,
          details: { roleId, roleName: role.name, channelId, customLevel: assignLevel !== role.level ? assignLevel : null } });
      } catch {}
    } catch (err) {
      console.error('Assign role error:', err);
      cb({ error: 'Failed to assign role' });
    }
  });

  // ── Revoke role ─────────────────────────────────────────
  socket.on('revoke-role', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'promote_user')) {
      return cb({ error: 'You lack permission to revoke roles' });
    }

    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Missing userId or roleId' });

    if (userId === socket.user.id) {
      return cb({ error: 'You cannot modify your own roles' });
    }

    if (!socket.user.isAdmin) {
      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
      if (role) {
        const myLevel = getUserEffectiveLevel(socket.user.id);
        if (role.level >= myLevel) {
          return cb({ error: `You can only revoke roles below your level (${myLevel})` });
        }
      }
    }

    const channelId = isInt(data.channelId) ? data.channelId : null;

    applyRoleChannelAccess(roleId, userId, 'revoke');

    if (channelId) {
      db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
    } else {
      db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
    }

    const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
    cb({ success: true, message: `Revoked role from ${target ? target.username : 'user'}` });

    try {
      const r = db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId);
      _audit({ actor: socket.user, action: 'role_revoke',
        target_type: 'user', target_id: userId, target_name: target ? target.username : null,
        details: { roleId, roleName: r ? r.name : null, channelId } });
    } catch {}

    refreshUserRoles(userId);
    syncSeeAllMemberships(userId);
  });

  // ── Role channel access ─────────────────────────────────
  socket.on('get-role-channel-access', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    // Accept single roleId or multiple roleIds.
    let roleIds;
    if (isInt(data.roleId)) {
      roleIds = [data.roleId];
    } else if (Array.isArray(data.roleIds)) {
      roleIds = [...new Set(data.roleIds.map(id => isInt(id) ? id : null).filter(id => id !== null))];
    } else {
      return cb({ error: 'Invalid role ID' });
    }

    if (!roleIds.length) return cb({ error: 'Invalid role ID' });

    const canManageRoles = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_roles');
    // Non-role-managers may only inspect level-0 groups.
    if (!canManageRoles) {
      const placeholders = roleIds.map(() => '?').join(',');
      const validRoles = db.prepare(`SELECT id FROM roles WHERE id IN (${placeholders}) AND level = 0`).all(...roleIds);

      if (validRoles.length !== roleIds.length) {
        return cb({ error: 'You cannot view this role' });
      }
    }

    const placeholders = roleIds.map(() => '?').join(',');
    let rows = db.prepare(`SELECT role_id, channel_id, grant_on_promote, revoke_on_demote FROM role_channel_access WHERE role_id IN (${placeholders})`).all(...roleIds);
    let channels = db.prepare(`SELECT id, name, parent_channel_id, is_dm, is_private, position FROM channels WHERE is_dm = 0 ORDER BY parent_channel_id IS NOT NULL, position, name`).all();
    // A regular member asking what a group would give them only needs the
    // channels that group grants. The full channel table would hand them the
    // name of every private channel on the server, which the channel list
    // itself deliberately keeps from non-members.
    if (!canManageRoles) {
      rows = rows.filter(r => r.grant_on_promote);
      const granted = new Set(rows.map(r => r.channel_id));
      channels = channels.filter(c => granted.has(c.id));
    }
    cb({ success: true, access: rows, channels });
  });

  socket.on('update-role-channel-access', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can edit role channel access' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return cb({ error: 'Invalid role ID' });
    if (!Array.isArray(data.access)) return cb({ error: 'Invalid access data' });

    try {
      const txn = db.transaction(() => {
        db.prepare('DELETE FROM role_channel_access WHERE role_id = ?').run(roleId);
        const ins = db.prepare('INSERT INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, ?, ?)');
        data.access.forEach(a => {
          const chId = isInt(a.channelId) ? a.channelId : null;
          if (!chId) return;
          const grant = a.grant ? 1 : 0;
          const revoke = a.revoke ? 1 : 0;
          if (grant || revoke) ins.run(roleId, chId, grant, revoke);
        });
        if (data.linkEnabled !== undefined) {
          db.prepare('UPDATE roles SET link_channel_access = ? WHERE id = ?').run(data.linkEnabled ? 1 : 0, roleId);
        }
      });
      txn();
      cb({ success: true });
    } catch (err) {
      console.error('Update role channel access error:', err);
      cb({ error: 'Failed to update channel access' });
    }
  });

  socket.on('reapply-role-access', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can reapply access' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return cb({ error: 'Invalid role ID' });

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });
    if (!role.link_channel_access) return cb({ error: 'Channel access linking is not enabled for this role' });

    const roleUsers = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(roleId);
    const grantChannels = db.prepare('SELECT channel_id FROM role_channel_access WHERE role_id = ? AND grant_on_promote = 1').all(roleId);
    const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');

    const txn = db.transaction(() => {
      roleUsers.forEach(u => {
        grantChannels.forEach(c => ins.run(c.channel_id, u.user_id));
      });
    });
    txn();

    broadcastChannelLists();
    cb({ success: true, affected: roleUsers.length });
  });

  // ── Promote user ────────────────────────────────────────
  socket.on('promote-user', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Invalid parameters' });
    if (userId === socket.user.id) return cb({ error: 'Cannot promote yourself' });

    const myLevel = getUserEffectiveLevel(socket.user.id);
    const hasPromotePerm = socket.user.isAdmin || userHasPermission(socket.user.id, 'promote_user');
    if (!hasPromotePerm) return cb({ error: 'You lack the promote_user permission' });

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });
    if (role.level >= myLevel) {
      return cb({ error: `You can only assign roles below your level (${myLevel})` });
    }

    const channelId = isInt(data.channelId) ? data.channelId : null;
    try {
      if (channelId) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
      } else {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
      }
      db.prepare(
        'INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)'
      ).run(userId, roleId, channelId, socket.user.id);

      refreshUserRoles(userId);
      cb({ success: true });
    } catch (err) {
      console.error('Promote user error:', err);
      cb({ error: 'Failed to promote user' });
    }
  });

  // ── Update own Groups ─────────────────────────────────────
  socket.on('update-groups', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    if (!Array.isArray(data.groupIds)) return cb({ error: 'Invalid group data' });

    const groupIds = [...new Set(data.groupIds.map(id => isInt(id) ? id : null).filter(id => id !== null))];
    try {
      // Only level-0 roles may be self-selected.
      const groups = groupIds.length
        ? db.prepare(`
            SELECT *
            FROM roles
            WHERE id IN (${groupIds.map(() => '?').join(',')})
              AND level = 0
          `).all(...groupIds)
        : [];

      // Reject any IDs that weren't valid level-0 groups.
      if (groups.length !== groupIds.length) return cb({ error: 'Invalid group selection' });

      const currentGroups = db.prepare(`
        SELECT role_id
        FROM user_roles
        WHERE user_id = ?
          AND channel_id IS NULL
          AND role_id IN (
            SELECT id FROM roles WHERE level = 0
          )
      `).all(socket.user.id);

      const currentGroupIds = new Set(currentGroups.map(r => r.role_id));
      const selectedGroupIds = new Set(groupIds);

      const toAdd = groupIds.filter(id => !currentGroupIds.has(id));
      const toRemove = [...currentGroupIds].filter(id => !selectedGroupIds.has(id));

      const txn = db.transaction(() => {
        for (const roleId of toRemove) {
          db.prepare(`
            DELETE FROM user_roles
            WHERE user_id = ?
              AND role_id = ?
              AND channel_id IS NULL
          `).run(socket.user.id, roleId);
        }

        for (const roleId of toAdd) {
          db.prepare(`
            INSERT INTO user_roles
              (user_id, role_id, channel_id, granted_by, custom_level)
            VALUES (?, ?, NULL, ?, NULL)
          `).run(socket.user.id, roleId, socket.user.id);
        }
      });
      txn();

      // Apply linked channel access after the role changes have committed.
      for (const roleId of toRemove) {
        applyRoleChannelAccess(roleId, socket.user.id, 'revoke');
      }
      for (const roleId of toAdd) {
        applyRoleChannelAccess(roleId, socket.user.id, 'grant');
      }
      refreshUserRoles(socket.user.id);

      const updatedGroups = db.prepare(`
        SELECT r.*
        FROM roles r
        JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = ?
          AND ur.channel_id IS NULL
          AND r.level = 0
        ORDER BY r.name COLLATE NOCASE
      `).all(socket.user.id);

      cb({
        success: true,
        groups: updatedGroups
      });
    } catch (err) {
      console.error('Update groups error:', err);
      cb({ error: 'Failed to update groups' });
    }
  });

  // ── Transfer admin ──────────────────────────────────────
  socket.on('transfer-admin', async (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!socket.user.isAdmin) return cb({ error: 'Only admins can transfer admin' });

    if (transferAdminRef.value) return cb({ error: 'A transfer is already in progress' });
    transferAdminRef.value = true;

    try {
      const adminUser = db.prepare(
        'SELECT username, password_hash, oidc_subject, totp_secret, totp_enabled FROM users WHERE id = ?'
      ).get(socket.user.id);
      if (!adminUser) { transferAdminRef.value = false; return cb({ error: 'Admin user not found' }); }

      // An admin who signed in through OIDC has no Haven password, so asking
      // for one did not merely inconvenience them, it closed the door: on a
      // server where everybody arrives through SSO, admin could not be handed
      // to anyone at all. Those accounts confirm with their authenticator code
      // instead. Two-factor has to be switched on for that, and deliberately
      // so, because the whole point of the prompt is a second factor and
      // "you are already signed in" is not one. Anything holding a real bcrypt
      // hash, which is every local account, still takes the password path.
      // (#5539)
      const ssoOnly = !!adminUser.oidc_subject &&
        !(typeof adminUser.password_hash === 'string' && adminUser.password_hash.startsWith('$2'));

      if (ssoOnly) {
        if (!adminUser.totp_secret || !adminUser.totp_enabled) {
          transferAdminRef.value = false;
          return cb({
            error: 'Your account signs in through SSO, so there is no Haven password to confirm with. Turn on two-factor authentication in Settings, then transfer admin.',
            code: 'mfa_required'
          });
        }
        const code = typeof data.totpCode === 'string' ? data.totpCode.replace(/[\s-]/g, '') : '';
        if (!code) { transferAdminRef.value = false; return cb({ error: 'Authenticator code is required for this action' }); }
        let validCode;
        try {
          const totp = new OTPAuth.TOTP({
            issuer: 'Haven',
            label: adminUser.username,
            algorithm: 'SHA1',
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(adminUser.totp_secret)
          });
          validCode = totp.validate({ token: code, window: 1 }) !== null;
        } catch (err) {
          console.error('Transfer admin code verification error:', err);
          transferAdminRef.value = false;
          return cb({ error: 'Code verification failed' });
        }
        if (!validCode) { transferAdminRef.value = false; return cb({ error: 'Incorrect code' }); }
      } else {
        const password = typeof data.password === 'string' ? data.password : '';
        if (!password) { transferAdminRef.value = false; return cb({ error: 'Password is required for this action' }); }
        try {
          const validPw = await bcrypt.compare(password, adminUser.password_hash);
          if (!validPw) { transferAdminRef.value = false; return cb({ error: 'Incorrect password' }); }
        } catch (err) {
          console.error('Password verification error:', err);
          transferAdminRef.value = false;
          return cb({ error: 'Password verification failed' });
        }
      }

      const stillAdmin = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(socket.user.id);
      if (!stillAdmin || !stillAdmin.is_admin) { transferAdminRef.value = false; return cb({ error: 'You are no longer an admin' }); }

      const userId = isInt(data.userId) ? data.userId : null;
      if (!userId) return cb({ error: 'Invalid user' });
      if (userId === socket.user.id) return cb({ error: 'Cannot transfer to yourself' });

      const targetUser = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(userId);
      if (!targetUser) return cb({ error: 'User not found' });
      if (targetUser.is_admin) return cb({ error: 'User is already an admin' });

      try {
        const transferTxn = db.transaction(() => {
          db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
          db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(socket.user.id);

          // Admins are deliberately not allowed to leave channels, so that
          // whoever runs the server can see what happens in all of them. That
          // guarantee quietly broke on transfer: the incoming admin only had
          // whatever channels they had joined as an ordinary member, and there
          // was no way for them to add themselves back to the rest. Join them
          // to every non-DM channel so the new admin starts with the same
          // visibility the old one had. Hiding a channel from your own sidebar
          // is a per-user view setting and stays available.
          db.prepare(`
            INSERT OR IGNORE INTO channel_members (channel_id, user_id)
            SELECT id, ? FROM channels WHERE is_dm = 0
          `).run(userId);

          let formerAdminRole = db.prepare("SELECT id FROM roles WHERE name = 'Former Admin' AND level = 99").get();
          if (!formerAdminRole) {
            const r = db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Former Admin', 99, 'server', '#e74c3c')").run();
            formerAdminRole = { id: r.lastInsertRowid };
            const allPerms = [...VALID_ROLE_PERMS];
            const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
            allPerms.forEach(p => insertPerm.run(formerAdminRole.id, p));
          }
          db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(socket.user.id, formerAdminRole.id);
          db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)').run(
            socket.user.id, formerAdminRole.id, socket.user.id
          );
        });
        transferTxn();

        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === userId) {
            s.user.isAdmin = true;
            s.user.roles = getUserRoles(userId);
            s.user.effectiveLevel = 100;
            s.emit('session-info', {
              id: s.user.id, username: s.user.username, isAdmin: true,
              displayName: s.user.displayName, avatar: s.user.avatar || null,
              avatarShape: s.user.avatar_shape || 'circle',
              version: HAVEN_VERSION, roles: s.user.roles,
              effectiveLevel: 100, permissions: ['*'],
              status: s.user.status || 'online',
              statusText: s.user.statusText || ''
            });
          }
          if (s.user && s.user.id === socket.user.id) {
            s.user.isAdmin = false;
            s.user.roles = getUserRoles(socket.user.id);
            s.user.effectiveLevel = getUserEffectiveLevel(socket.user.id);
            s.emit('session-info', {
              id: s.user.id, username: s.user.username, isAdmin: false,
              displayName: s.user.displayName, avatar: s.user.avatar || null,
              avatarShape: s.user.avatar_shape || 'circle',
              version: HAVEN_VERSION, roles: s.user.roles,
              effectiveLevel: s.user.effectiveLevel,
              permissions: getUserPermissions(socket.user.id),
              globalPermissions: getUserGlobalPermissions(socket.user.id),
              status: s.user.status || 'online',
              statusText: s.user.statusText || ''
            });
          }
        }
        for (const [code] of channelUsers) { emitOnlineUsers(code); }
        cb({ success: true, message: `Admin transferred to ${targetUser.username}` });
      } catch (err) {
        console.error('Transfer admin error:', err);
        cb({ error: 'Failed to transfer admin' });
      }
    } finally {
      transferAdminRef.value = false;
    }
  });
};
