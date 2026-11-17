'use strict';

// Taking someone out of a channel: the membership, their memberships of its
// sub-channels and the roles they held there go, their sockets leave the
// rooms (and the call) and get a fresh channel list, and the people left see
// the member list change. The caller has already checked that the remover
// may do this, and rotates private codes afterwards.
//
//   removeChannelMember(ctx, channel, targetUserId, { quiet })
//
// quiet leaves the member list for the caller to redraw, once, after
// removing several people.

function removeChannelMember(ctx, channel, targetUserId, { quiet = false } = {}) {
  const { io, db, state, getEnrichedChannels, emitOnlineUsers } = ctx;
  const { channelUsers } = state;
  const channelId = channel.id;
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channelId, targetUserId);
  const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ?').all(channelId);
  const delSub = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
  subs.forEach(s => delSub.run(s.id, targetUserId));
  // Roles held in that channel go with the membership; kept, a removed
  // Channel Mod could still act there.
  const delScoped = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND channel_id = ?');
  [channelId, ...subs.map(s => s.id)].forEach(id => delScoped.run(targetUserId, id));
  // Out of the call too, before the code rotates below.
  ctx.liveAccess?.cutOff(targetUserId, [channel.code, ...subs.map(s => s.code)], 'You were removed from this channel');
  const targetSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === targetUserId);
  for (const ts of targetSockets) {
    if (ts.currentChannel === channel.code || subs.some(sub => sub.code === ts.currentChannel)) ts.currentChannel = null;
    ts.leave(`channel:${channel.code}`);
    subs.forEach(sub => ts.leave(`channel:${sub.code}`));
    ts.emit('channels-list', getEnrichedChannels(targetUserId, ts.user.isAdmin, (room) => ts.join(room)));
    ts.emit('toast', { message: `You were removed from #${channel.name}`, type: 'warning' });
  }
  const channelRoom = channelUsers.get(channel.code);
  if (channelRoom) {
    channelRoom.delete(targetUserId);
    if (!quiet) emitOnlineUsers(channel.code);
  }
}

module.exports = { removeChannelMember };
