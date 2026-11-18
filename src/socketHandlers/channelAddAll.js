'use strict';

// "Manage members" for a channel that already exists: the channel's
// right-click menu lists everyone on the server with their roles, who is in
// the channel is ticked, and ticking or unticking people adds or removes
// them. Ticking everyone is Add all, unticking everyone is Remove all.
//
//   get-channel-add-members { code } -> { channel, users, roles, canAdd } or { error }
//   update-channel-members { code, add, remove } -> { success, added, removed } or { error }
//   add-channel-members { code, userIds } -> { success, added } or { error }
//   add-all-members { code } -> { success, added } or { error }
//
// Who may add: the admin, Invite Users or Manage Server on a public channel,
// and on a private one whoever may invite to it one by one (its creator or a
// moderator there), since it is the same as inviting each of them. Banned
// people are left out, and guests too unless the admin does it.
//
// Who may remove: whoever may add (what you can add you can take out again),
// and anyone with Kick in the channel. Nobody removes themselves here, and
// only the admin removes an admin or a guest. A private channel's creator may
// remove anyone else; everyone else only people ranked below them.
//
// add-all-members takes what the switch at creation takes and stays out of
// private channels. The people added get the channel in their list straight
// away, the people removed lose it, and the member list is drawn again.

const { reachableChannelByCode } = require('./channelAccess');
const { removeChannelMember } = require('../channelMemberRemoval');

const MAX_IDS = 10000;
const idList = (v) => (Array.isArray(v) && v.length <= MAX_IDS && v.every(Number.isInteger) ? [...new Set(v)] : null);

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, getUserEffectiveLevel, broadcastChannelLists, emitOnlineUsers, logAudit, rotatePrivateCodesAfterRemoval } = ctx;
  const audit = typeof logAudit === 'function' ? logAudit : () => {};

  socket.on('add-all-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const code = data && typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });
    const allowed = socket.user.isAdmin || userHasPermission(socket.user.id, 'invite_users')
      || userHasPermission(socket.user.id, 'manage_server');
    if (!allowed) return cb({ error: "You don't have permission to add members" });
    const channel = socket.user.isAdmin
      ? db.prepare('SELECT * FROM channels WHERE code = ?').get(code)
      : reachableChannelByCode(ctx, socket.user, code);
    if (!channel || channel.is_dm) return cb({ error: 'Channel not found' });
    if (channel.is_private) return cb({ error: 'A private channel stays invite-only' });
    // A hidden-code channel, or a sub-channel under a private or hidden-code
    // one, is private to everyone but the admin, as invite-to-channel has it.
    if (!socket.user.isAdmin) {
      const parent = channel.parent_channel_id
        ? db.prepare('SELECT is_private, code_visibility FROM channels WHERE id = ?').get(channel.parent_channel_id)
        : null;
      if (channel.code_visibility === 'private' || (parent && (parent.is_private || parent.code_visibility === 'private'))) {
        return cb({ error: 'A private channel stays invite-only' });
      }
    }

    let added = 0;
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      db.transaction(() => {
        for (const u of db.prepare('SELECT id, is_guest FROM users WHERE id NOT IN (SELECT user_id FROM bans)').all()) {
          // A guest only uses the channels the admin opened to guests.
          if (u.is_guest && !socket.user.isAdmin) continue;
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
      audit({ actor: socket.user, action: 'channel_add_all_members', target_type: 'channel',
        target_id: channel.id, target_name: channel.name, details: { added } });
    }
    cb({ success: true, added });
  });

  // The channel and what this person may do to its member list, or null when
  // they may do nothing there (or cannot reach it).
  function access(code) {
    if (typeof code !== 'string' || !/^[a-f0-9]{8}$/i.test(code)) return null;
    const channel = socket.user.isAdmin
      ? db.prepare('SELECT * FROM channels WHERE code = ?').get(code)
      : reachableChannelByCode(ctx, socket.user, code);
    if (!channel || channel.is_dm) return null;
    if (socket.user.isAdmin) return { channel, canAdd: true, canRemove: true, creator: true };
    const parent = channel.parent_channel_id
      ? db.prepare('SELECT created_by, is_private, code_visibility FROM channels WHERE id = ?').get(channel.parent_channel_id)
      : null;
    const isPrivate = channel.is_private || channel.code_visibility === 'private'
      || !!(parent && (parent.is_private || parent.code_visibility === 'private'));
    const creator = isPrivate && (channel.created_by === socket.user.id || !!(parent && parent.created_by === socket.user.id));
    const kick = !!userHasPermission(socket.user.id, 'kick_user', channel.id);
    const canAdd = isPrivate
      ? creator || kick
      : !!(userHasPermission(socket.user.id, 'invite_users') || userHasPermission(socket.user.id, 'manage_server'));
    const canRemove = canAdd || kick;
    return canAdd || canRemove ? { channel, canAdd, canRemove, creator } : null;
  }

  // The channel, if this person may add people to it, else null.
  function channelToAddTo(code) {
    const a = access(code);
    return a && a.canAdd ? a.channel : null;
  }

  // Whether this person may take that member out. target: { id, is_admin, is_guest }.
  function removable(a, target, myLevel) {
    if (!a.canRemove || target.id === socket.user.id) return false;
    if (socket.user.isAdmin) return true;
    if (target.is_admin || target.is_guest) return false;
    if (a.creator) return true;
    return getUserEffectiveLevel(target.id, a.channel.id) < myLevel;
  }

  function addMembers(channel, ids) {
    const addedIds = [];
    const lookup = db.prepare(`SELECT u.id, u.is_guest, (b.id IS NOT NULL) AS banned
      FROM users u LEFT JOIN bans b ON b.user_id = u.id WHERE u.id = ?`);
    const insert = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
    // A top-level channel brings its public sub-channels along, as an invite does.
    const subs = channel.parent_channel_id ? []
      : db.prepare('SELECT id FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(channel.id);
    db.transaction(() => {
      for (const id of ids) {
        const u = lookup.get(id);
        if (!u || u.banned || (u.is_guest && !socket.user.isAdmin)) continue;
        if (!insert.run(channel.id, id).changes) continue;
        for (const sub of subs) insert.run(sub.id, id);
        addedIds.push(id);
      }
    })();
    return addedIds;
  }

  function announceAdded(channel, addedIds) {
    const added = new Set(addedIds);
    for (const [, s] of io.sockets.sockets) {
      if (s.user && added.has(s.user.id)) s.emit('toast', { message: `${socket.user.displayName || socket.user.username} added you to #${channel.name}`, type: 'info' });
    }
    audit({ actor: socket.user, action: 'channel_add_members', target_type: 'channel',
      target_id: channel.id, target_name: channel.name, details: { added: addedIds.length } });
  }

  socket.on('get-channel-add-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    let a;
    try { a = access(data && data.code); } catch (err) {
      console.warn('[manage-members] check failed, denying:', err.message);
      return cb({ error: 'Could not load members' });
    }
    if (!a) return cb({ error: "You don't have permission to manage members here" });
    const channel = a.channel;
    try {
      const members = new Set(db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id).map(r => r.user_id));
      // A role hidden on profile cards keeps who holds it hidden here too.
      const shown = db.prepare('SELECT id, name, color, level, COALESCE(show_on_profile, 1) AS shown FROM roles ORDER BY level DESC, name').all()
        .filter(r => socket.user.isAdmin || r.shown !== 0);
      const shownIds = new Set(shown.map(r => r.id));
      const roleIds = new Map();
      for (const r of db.prepare('SELECT user_id, role_id FROM user_roles WHERE channel_id IS NULL').all()) {
        if (!shownIds.has(r.role_id)) continue;
        if (!roleIds.has(r.user_id)) roleIds.set(r.user_id, []);
        roleIds.get(r.user_id).push(r.role_id);
      }
      const myLevel = socket.user.isAdmin ? Infinity : getUserEffectiveLevel(socket.user.id, channel.id);
      const users = db.prepare(`
        SELECT id, username, display_name, is_guest, is_admin FROM users
        WHERE id NOT IN (SELECT user_id FROM bans) ORDER BY LOWER(COALESCE(display_name, username))
      `).all()
        // A guest only uses the channels the admin opened to guests.
        .filter(u => socket.user.isAdmin || !u.is_guest)
        .map(u => {
          const inChannel = members.has(u.id);
          return { id: u.id, username: u.username, displayName: u.display_name || u.username,
            roles: roleIds.get(u.id) || [], inChannel, removable: inChannel && removable(a, u, myLevel) };
        });
      const held = new Set([].concat(...roleIds.values()));
      const roles = shown.filter(r => held.has(r.id)).map(r => ({ id: r.id, name: r.name, color: r.color }));
      cb({ channel: { code: channel.code, name: channel.name }, users, roles, canAdd: a.canAdd });
    } catch (err) {
      console.error('[manage-members] load failed:', err.message);
      cb({ error: 'Could not load members' });
    }
  });

  socket.on('add-channel-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const ids = data ? idList(data.userIds) : null;
    if (!ids || !ids.length) return cb({ error: 'Invalid request' });
    let channel;
    try { channel = channelToAddTo(data.code); } catch (err) {
      console.warn('[add-members] check failed, denying:', err.message);
      return cb({ error: 'Could not add members' });
    }
    if (!channel) return cb({ error: "You don't have permission to add members here" });

    let addedIds;
    try { addedIds = addMembers(channel, ids); } catch (err) {
      console.error('[add-members] failed:', err.message);
      return cb({ error: 'Could not add members' });
    }
    if (addedIds.length) {
      broadcastChannelLists();
      emitOnlineUsers(channel.code);
      announceAdded(channel, addedIds);
    }
    cb({ success: true, added: addedIds.length });
  });

  socket.on('update-channel-members', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const add = data ? idList(data.add || []) : null;
    const remove = data ? idList(data.remove || []) : null;
    if (!add || !remove || (!add.length && !remove.length)) return cb({ error: 'Invalid request' });
    let a;
    try { a = access(data.code); } catch (err) {
      console.warn('[manage-members] check failed, denying:', err.message);
      return cb({ error: 'Could not update members' });
    }
    if (!a || (add.length && !a.canAdd) || (remove.length && !a.canRemove)) {
      return cb({ error: "You don't have permission to manage members here" });
    }
    const channel = a.channel;

    let addedIds = [];
    const removedIds = [];
    try {
      if (add.length) addedIds = addMembers(channel, add);
      if (remove.length) {
        const myLevel = socket.user.isAdmin ? Infinity : getUserEffectiveLevel(socket.user.id, channel.id);
        const member = db.prepare(`SELECT u.id, u.is_admin, u.is_guest FROM users u
          JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = ? WHERE u.id = ?`);
        for (const id of remove) {
          const target = member.get(channel.id, id);
          if (!target || !removable(a, target, myLevel)) continue;
          removeChannelMember(ctx, channel, id, { quiet: true });
          removedIds.push(id);
        }
      }
    } catch (err) {
      console.error('[manage-members] failed:', err.message);
      return cb({ error: 'Could not update members' });
    }

    if (addedIds.length) announceAdded(channel, addedIds);
    if (removedIds.length) {
      if (typeof rotatePrivateCodesAfterRemoval === 'function') rotatePrivateCodesAfterRemoval(channel.id);
      audit({ actor: socket.user, action: 'channel_remove_members', target_type: 'channel',
        target_id: channel.id, target_name: channel.name, details: { removed: removedIds.length } });
    }
    if (addedIds.length || removedIds.length) {
      broadcastChannelLists();
      // The code may have rotated with the removals.
      const now = db.prepare('SELECT code FROM channels WHERE id = ?').get(channel.id);
      emitOnlineUsers(now ? now.code : channel.code);
    }
    cb({ success: true, added: addedIds.length, removed: removedIds.length });
  });
};
