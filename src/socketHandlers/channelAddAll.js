'use strict';

// "Add all members" for a channel that already exists: everyone on the server
// becomes a member, as ticking Add all members does when a channel is made.
//
//   add-all-members { code } -> { success, added } or { error }
//
// "Add members" picks who: the channel's right-click menu lists everyone on
// the server with their roles, and the chosen people join.
//
//   get-channel-add-members { code } -> { channel, users, roles } or { error }
//   add-channel-members { code, userIds } -> { success, added } or { error }
//
// Picking people works on a private channel too, for whoever may invite to
// it one by one (the admin, its creator, or a moderator there), since it is
// the same as inviting each of them.
//
// It takes what the switch at creation takes: the admin, Invite Users or
// Manage Server, and reaching the channel. A private channel stays invite-only
// and a DM is not a channel anyone else belongs in, so both are refused.
// Banned people are left out. The new members get the channel in their list
// straight away, and the member list is drawn again.

const { reachableChannelByCode } = require('./channelAccess');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, broadcastChannelLists, emitOnlineUsers, logAudit } = ctx;

  socket.on('add-all-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const code = data && typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });
    const allowed = socket.user.isAdmin || userHasPermission(socket.user.id, 'invite_users')
      || userHasPermission(socket.user.id, 'manage_server');
    if (!allowed) return cb({ error: 'You don\'t have permission to add members' });
    const channel = socket.user.isAdmin
      ? db.prepare('SELECT * FROM channels WHERE code = ?').get(code)
      : reachableChannelByCode(ctx, socket.user, code);
    if (!channel || channel.is_dm) return cb({ error: 'Channel not found' });
    if (channel.is_private) return cb({ error: 'A private channel stays invite-only' });

    let added = 0;
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      db.transaction(() => {
        for (const u of db.prepare('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM bans)').all()) {
          added += insert.run(channel.id, u.id).changes;
        }
      })();
    } catch (err) {
      console.error('[add-all-members] failed:', err.message);
      return cb({ error: 'Could not add everyone' });
    }

    if (added) {
      broadcastChannelLists();
      emitOnlineUsers(channel.code);
      if (typeof logAudit === 'function') {
        logAudit({ actor: socket.user, action: 'channel_add_all_members', target_type: 'channel',
          target_id: channel.id, target_name: channel.name, details: { added } });
      }
    }
    cb({ success: true, added });
  });

  // The channel, if this person may add people to it, else null.
  function channelToAddTo(code) {
    if (typeof code !== 'string' || !/^[a-f0-9]{8}$/i.test(code)) return null;
    const channel = socket.user.isAdmin
      ? db.prepare('SELECT * FROM channels WHERE code = ?').get(code)
      : reachableChannelByCode(ctx, socket.user, code);
    if (!channel || channel.is_dm) return null;
    if (socket.user.isAdmin) return channel;
    const parent = channel.parent_channel_id
      ? db.prepare('SELECT created_by, is_private, code_visibility FROM channels WHERE id = ?').get(channel.parent_channel_id)
      : null;
    const isPrivate = channel.is_private || channel.code_visibility === 'private'
      || !!(parent && (parent.is_private || parent.code_visibility === 'private'));
    if (isPrivate) {
      const creator = channel.created_by === socket.user.id || !!(parent && parent.created_by === socket.user.id);
      return creator || userHasPermission(socket.user.id, 'kick_user', channel.id) ? channel : null;
    }
    const allowed = userHasPermission(socket.user.id, 'invite_users') || userHasPermission(socket.user.id, 'manage_server');
    return allowed ? channel : null;
  }

  socket.on('get-channel-add-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    let channel;
    try { channel = channelToAddTo(data && data.code); } catch (err) {
      console.warn('[add-members] check failed, denying:', err.message);
      return cb({ error: 'Could not load members' });
    }
    if (!channel) return cb({ error: "You don't have permission to add members here" });
    try {
      const members = new Set(db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id).map(r => r.user_id));
      const roleIds = new Map();
      for (const r of db.prepare('SELECT user_id, role_id FROM user_roles WHERE channel_id IS NULL').all()) {
        if (!roleIds.has(r.user_id)) roleIds.set(r.user_id, []);
        roleIds.get(r.user_id).push(r.role_id);
      }
      const users = db.prepare(`
        SELECT id, username, display_name, is_guest FROM users
        WHERE id NOT IN (SELECT user_id FROM bans) ORDER BY LOWER(COALESCE(display_name, username))
      `).all()
        // A guest only uses the channels the admin opened to guests.
        .filter(u => socket.user.isAdmin || !u.is_guest)
        .map(u => ({ id: u.id, username: u.username, displayName: u.display_name || u.username,
          roles: roleIds.get(u.id) || [], inChannel: members.has(u.id) }));
      const held = new Set([].concat(...roleIds.values()));
      const roles = db.prepare('SELECT id, name, color, level FROM roles ORDER BY level DESC, name').all()
        .filter(r => held.has(r.id)).map(r => ({ id: r.id, name: r.name, color: r.color }));
      cb({ channel: { code: channel.code, name: channel.name }, users, roles });
    } catch (err) {
      console.error('[add-members] load failed:', err.message);
      cb({ error: 'Could not load members' });
    }
  });

  socket.on('add-channel-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const ids = data && Array.isArray(data.userIds) ? data.userIds : null;
    if (!ids || !ids.length || ids.length > 10000 || !ids.every(Number.isInteger)) return cb({ error: 'Invalid request' });
    let channel;
    try { channel = channelToAddTo(data.code); } catch (err) {
      console.warn('[add-members] check failed, denying:', err.message);
      return cb({ error: 'Could not add members' });
    }
    if (!channel) return cb({ error: "You don't have permission to add members here" });

    const addedIds = [];
    try {
      const lookup = db.prepare(`SELECT u.id, u.is_guest, (b.id IS NOT NULL) AS banned
        FROM users u LEFT JOIN bans b ON b.user_id = u.id WHERE u.id = ?`);
      const insert = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      // A top-level channel brings its public sub-channels along, as an invite does.
      const subs = channel.parent_channel_id ? []
        : db.prepare('SELECT id FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(channel.id);
      db.transaction(() => {
        for (const id of new Set(ids)) {
          const u = lookup.get(id);
          if (!u || u.banned || (u.is_guest && !socket.user.isAdmin)) continue;
          if (!insert.run(channel.id, id).changes) continue;
          for (const sub of subs) insert.run(sub.id, id);
          addedIds.push(id);
        }
      })();
    } catch (err) {
      console.error('[add-members] failed:', err.message);
      return cb({ error: 'Could not add members' });
    }

    if (addedIds.length) {
      broadcastChannelLists();
      emitOnlineUsers(channel.code);
      const added = new Set(addedIds);
      for (const [, s] of io.sockets.sockets) {
        if (s.user && added.has(s.user.id)) s.emit('toast', { message: `${socket.user.displayName || socket.user.username} added you to #${channel.name}`, type: 'info' });
      }
      if (typeof logAudit === 'function') {
        logAudit({ actor: socket.user, action: 'channel_add_members', target_type: 'channel',
          target_id: channel.id, target_name: channel.name, details: { added: addedIds.length } });
      }
    }
    cb({ success: true, added: addedIds.length });
  });
};
