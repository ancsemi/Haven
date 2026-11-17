'use strict';

// "Move here as thread": selected messages go into the thread under another
// message, in the same channel or another. The rules live in
// src/moveToThread.js.
//
//   move-messages-to-thread { code, rootId, messageIds }
//     code is the channel the selection is in; the base names its own.
//     -> { success, moved, brought, toChannel } or { error }
//
// The same permission as Move to..., in both channels: the admin, or Delete
// Messages there, and the mover has to reach both (membership and the role
// gate). Into another channel, its text switch and read-only mode apply as
// they do for a plain move. Then:
//   messages-moved     to the source: the selected messages leave the feed
//                      (the event Move to... sends, so older clients drop
//                      them too)
//   messages-threaded  to both: which thread they went to, so an open thread
//                      panel or a forum reloads
//   thread-updated     to the base's channel: its reply chip and count
// No new-thread-message goes out: these are old messages that were already
// on screen, so nobody gets a sound or an "N new" marker for them.
//
// The way back out (src/moveOutOfThread.js):
//   move-messages-out-of-thread { parentId, messageIds }
//     -> { success, moved, toChannel } or { error }
// The same permission as going in, in the thread's channel, so whoever can
// put messages in a thread can take them out again. Then, to the channel:
//   messages-unthreaded  the replies leave an open thread panel and the
//                        channel feed reloads to show them in time order
//   thread-updated       its reply chip and count (not in a forum, which
//                        reloads instead, so no topic is bumped or lit up)

const { utcStamp } = require('./helpers');
const { reachableChannel, reachableChannelByCode } = require('./channelAccess');
const { moveIntoThread } = require('../moveToThread');
const { moveOutOfThread } = require('../moveOutOfThread');
const forumUnread = require('../forumUnread');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, logAudit } = ctx;

  // A failed check refuses.
  function canMove(channelId) {
    if (socket.user.isAdmin) return true;
    try {
      return !!userHasPermission(socket.user.id, 'delete_message', channelId);
    } catch (err) {
      console.warn('[move-thread] permission check failed, refusing:', err.message);
      return false;
    }
  }

  // The base's thread chip, in the shape send-thread-message sends.
  function threadSummary(rootId) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(rootId).n;
    const last = db.prepare('SELECT id, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(rootId);
    const participants = db.prepare(`
      SELECT DISTINCT COALESCE(u.display_name, u.username) AS username, u.avatar, COALESCE(u.avatar_shape, 'circle') AS avatar_shape
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 5
    `).all(rootId);
    return {
      count,
      lastReplyAt: last ? utcStamp(last.created_at) : null,
      lastReplyId: last ? last.id : null,
      participants: participants.map(p => ({ username: p.username, avatar: p.avatar, avatarShape: p.avatar_shape })),
    };
  }

  socket.on('move-messages-to-thread', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const rootId = data.rootId;
    if (!Number.isInteger(rootId) || rootId <= 0) return cb({ error: 'Invalid message' });

    // Where the selection is, and where the base is.
    const from = reachableChannelByCode(ctx, socket.user, typeof data.code === 'string' ? data.code.trim() : '');
    if (!from) return cb({ error: 'Channel not found' });
    const base = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(rootId);
    const to = base ? reachableChannel(ctx, socket.user, base.channel_id) : null;
    if (!to) return cb({ error: 'That message no longer exists' });
    if (from.is_dm || to.is_dm) return cb({ error: 'Cannot move messages to or from DMs' });
    if (!canMove(from.id) || !canMove(to.id)) {
      return cb({ error: 'You need message management permissions to move messages' });
    }
    // Into another channel it is posting there, as Move to... checks.
    if (from.id !== to.id && !socket.user.isAdmin) {
      if (to.text_enabled === 0) return cb({ error: 'Text messages are disabled in that channel' });
      if (to.read_only === 1 && !userHasPermission(socket.user.id, 'read_only_override', to.id)) {
        return cb({ error: 'That channel is read-only' });
      }
    }

    let result;
    try {
      result = moveIntoThread(db, { from, to, rootId, messageIds: data.messageIds });
    } catch (err) {
      console.error('Move to thread error:', err);
      return cb({ error: 'Failed to move messages' });
    }
    if (result.error) return cb({ error: result.error });
    forumUnread.forget(from.id);
    forumUnread.forget(to.id);

    const tell = (code, event, payload) => io.to(`channel:${code}`).emit(event, payload);
    tell(from.code, 'messages-moved', { channelCode: from.code, messageIds: result.selected, toChannel: to.code, toThread: rootId });
    const threaded = {
      channelCode: to.code,
      fromChannel: from.code,
      parentId: rootId,
      messageIds: result.moved,
      absorbedRoots: result.absorbedRoots,
    };
    tell(to.code, 'messages-threaded', threaded);
    // Viewers of the source with a moved thread open, or a forum showing.
    if (from.id !== to.id) tell(from.code, 'messages-threaded', threaded);
    tell(to.code, 'thread-updated', { channelCode: to.code, parentId: rootId, thread: threadSummary(rootId) });

    const brought = result.moved.length - result.selected.length;
    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'messages_move_to_thread',
        target_type: 'channel', target_id: to.id, target_name: to.name,
        details: { thread: rootId, fromChannel: from.name, messages: result.selected.length, broughtReplies: brought, messageIds: result.selected },
      });
    }
    cb({ success: true, moved: result.selected.length, brought, toChannel: to.code });
  });

  socket.on('move-messages-out-of-thread', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const rootId = data.parentId;
    if (!Number.isInteger(rootId) || rootId <= 0) return cb({ error: 'Invalid message' });

    const root = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(rootId);
    const channel = root ? reachableChannel(ctx, socket.user, root.channel_id) : null;
    if (!channel) return cb({ error: 'That thread no longer exists' });
    if (channel.is_dm) return cb({ error: 'Cannot move messages to or from DMs' });
    if (!canMove(channel.id)) return cb({ error: 'You need message management permissions to move messages' });

    let result;
    try {
      result = moveOutOfThread(db, { channel, rootId, messageIds: data.messageIds });
    } catch (err) {
      console.error('Move out of thread error:', err);
      return cb({ error: 'Failed to move messages' });
    }
    if (result.error) return cb({ error: result.error });
    forumUnread.forget(channel.id);

    const room = io.to(`channel:${channel.code}`);
    room.emit('messages-unthreaded', { channelCode: channel.code, parentId: rootId, messageIds: result.moved });
    if (!channel.is_forum) {
      room.emit('thread-updated', { channelCode: channel.code, parentId: rootId, thread: threadSummary(rootId) });
    }

    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'messages_move_out_of_thread',
        target_type: 'channel', target_id: channel.id, target_name: channel.name,
        details: { thread: rootId, messages: result.moved.length, messageIds: result.moved },
      });
    }
    cb({ success: true, moved: result.moved.length, toChannel: channel.code });
  });
};
