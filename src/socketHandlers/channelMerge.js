'use strict';

// "Merge into..." on a channel's menu: the admin folds one channel into
// another, for the duplicates a Ferry import leaves next to channels copied
// by hand (the rules are in src/mergeChannels.js).
//
//   merge-channels-preview { fromCode, toCode } -> { counts, repostCount, reposts } or { error }
//   merge-channels { fromCode, toCode, dropReposts } -> { success, moved, duplicates, reposts } or { error }
//
// Only the admin: a merge deletes a channel and changes who can read its
// history, which no channel permission covers. Everyone in the source is sent
// to the merged channel, and everyone in the target reloads it.

const { mergeChannels, preview } = require('../mergeChannels');
const forumUnread = require('../forumUnread');
const { clearChannelRuntimeState } = require('../channelRotation');

const CODE = /^[a-f0-9]{8}$/i;

module.exports = function register(socket, ctx) {
  const { io, db, state, broadcastChannelLists, logAudit, botAudioManager } = ctx;

  function pick(data) {
    const fromCode = data && typeof data.fromCode === 'string' ? data.fromCode.trim() : '';
    const toCode = data && typeof data.toCode === 'string' ? data.toCode.trim() : '';
    if (!CODE.test(fromCode) || !CODE.test(toCode)) return { error: 'Invalid channels' };
    const get = db.prepare('SELECT * FROM channels WHERE code = ?');
    return { from: get.get(fromCode), to: get.get(toCode) };
  }

  socket.on('merge-channels-preview', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only the admin can merge channels' });
    const { from, to, error } = pick(data);
    if (error) return cb({ error });
    try {
      cb(preview(db, from, to));
    } catch (err) {
      console.error('[merge-channels] preview failed:', err);
      cb({ error: 'Could not work out the merge' });
    }
  });

  socket.on('merge-channels', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only the admin can merge channels' });
    const { from, to, error } = pick(data);
    if (error) return cb({ error });

    let result;
    try {
      result = mergeChannels(db, { from, to, dropReposts: data.dropReposts });
    } catch (err) {
      console.error('[merge-channels] failed:', err);
      return cb({ error: 'Failed to merge the channels' });
    }
    if (result.error) return cb({ error: result.error });

    forumUnread.forget(from.id);
    forumUnread.forget(to.id);
    botAudioManager?.stopChannel(from.code, 'channel-deleted');
    broadcastChannelLists();
    io.to(`channel:${from.code}`).to(`voice:${from.code}`).emit('channel-merged', { code: from.code, into: to.code, name: to.name });
    clearChannelRuntimeState(state, from.code);
    io.to(`channel:${to.code}`).emit('messages-received', { channelCode: to.code, fromChannel: from.code, messageIds: [] });

    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'channel_merge',
        target_type: 'channel', target_id: to.id, target_name: to.name,
        details: { fromChannel: from.name, fromCode: from.code, ...result },
      });
    }
    cb({ success: true, ...result });
  });
};
