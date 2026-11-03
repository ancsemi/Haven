'use strict';

// "Add all members" for a channel that already exists: everyone on the server
// becomes a member, as ticking Add all members does when a channel is made.
//
//   add-all-members { code } -> { success, added } or { error }
//
// It takes what the switch at creation takes: the admin, Invite Users or
// Manage Server, and reaching the channel. A private channel stays invite-only
// and a DM is not a channel anyone else belongs in, so both are refused.
// Banned people are left out. The new members get the channel in their list
// straight away, and the member list is drawn again.

const { reachableChannelByCode } = require('./channelAccess');

module.exports = function register(socket, ctx) {
  const { db, userHasPermission, broadcastChannelLists, emitOnlineUsers, logAudit } = ctx;

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
};
