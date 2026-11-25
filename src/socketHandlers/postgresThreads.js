'use strict';

const createPermissions = require('./asyncPermissions');
const { messageChannel, messageChannelMember } = require('../db/messageManagement');
const { reactionsForMessages, reactionsByMessage } = require('../db/messageReactions');
const {
  threadParent, threadMessages, threadReplyContexts, threadReplyTarget, insertThreadReply,
  threadSummaries, channelThreads, formatChannelThreads, formatThreadParent, formatThreadMessage,
} = require('../db/messageThreads');
const { advanceThreadRead } = require('../db/readPositions');
const threadNotify = require('../threadNotify');
const { takeSilent } = require('../silentMessages');
const { sizeRefusal } = require('../messageLimits');
const { toReplyContext, utcStamp } = require('./helpers');
const { postingSettings } = require('./postgresPosting');

function checkThreadChannel(channel) {
  if (channel.is_dm) throw new Error('Threads are not available in DMs');
  if (channel.is_forum || channel.is_group) throw new Error('This channel type is not available on this server yet');
}

async function checkAccess(tx, user, channel, permissions) {
  if (user.isAdmin) return;
  if (!await messageChannelMember(tx, channel.id, user.id)) throw new Error('Not a member of this channel');
  if (!await permissions.roleGateAllows(user.id, channel)) throw new Error('This channel needs a role you do not hold');
}

function emitThreadRead(io, socket, channelCode, parentId) {
  for (const other of io.sockets.sockets.values()) {
    if (other !== socket && other.user?.id === socket.user.id) other.emit('thread-read', { channelCode, parentId });
  }
}

async function historyThreads(db, channel, userId, messages) {
  if (channel.is_dm || !messages.length) return new Map();
  const threads = await threadSummaries(db, messages.map(message => message.id), channel.id);
  const roots = messages.filter(message => threads.has(message.id)).map(message => ({ id: message.id, userId: message.user_id }));
  const unread = await threadNotify.newCounts(db, userId, roots, channel.id);
  for (const [id, count] of unread) threads.get(id).newCount = count;
  return threads;
}

function createPostgresThreads(io, db, posting, channelMembers) {
  // Keep PostgreSQL's history and live events for a thread in order even
  // after the transaction ends. The parent row lock protects database writers
  // on other connections.
  const pending = new Map();
  async function inThreadOrder(parentId, run) {
    const previous = pending.get(parentId) || Promise.resolve();
    const current = previous.catch(() => { /* the previous caller handles its error */ }).then(run);
    pending.set(parentId, current);
    try {
      return await current;
    } finally {
      if (pending.get(parentId) === current) pending.delete(parentId);
    }
  }

  async function list(socket, data) {
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) throw new Error('Invalid channel code');
    const payload = await db.withTransaction(async tx => {
      const channel = await messageChannel(tx, code);
      if (!channel) throw new Error('Channel not found');
      checkThreadChannel(channel);
      await checkAccess(tx, socket.user, channel, createPermissions(tx));
      const rows = await channelThreads(tx, channel.id);
      const unread = await threadNotify.newCounts(tx, socket.user.id, rows.map(row => ({ id: row.id, userId: row.user_id })), channel.id);
      return { channelCode: channel.code, threads: formatChannelThreads(rows, unread) };
    });
    socket.emit('channel-threads', payload);
  }

  async function load(socket, data) {
    const parentId = data?.parentId;
    if (!Number.isSafeInteger(parentId) || parentId <= 0) return;
    return inThreadOrder(parentId, () => loadThread(socket, parentId));
  }

  async function loadThread(socket, parentId) {
    const payload = await db.withTransaction(async tx => {
      // Find the room from the parent, since the thread panel can outlive a
      // channel switch. Lock the room and membership before the message.
      const channel = await messageChannel(tx, null, { messageId: parentId });
      if (!channel) return;
      checkThreadChannel(channel);
      await checkAccess(tx, socket.user, channel, createPermissions(tx));
      const parent = await threadParent(tx, parentId, { channelId: channel.id });
      if (!parent) return;

      const messages = await threadMessages(tx, parentId, channel.id);
      const replyIds = [...new Set(messages.map(message => message.reply_to).filter(Boolean))];
      const contexts = await threadReplyContexts(tx, replyIds, parentId, channel.id);
      const replies = new Map(contexts.map(row => [row.id, row]));
      const reactions = reactionsByMessage(await reactionsForMessages(tx, messages.map(message => message.id)));
      // Mark only the replies actually returned, leaving later arrivals unread.
      const seen = messages.reduce((latest, message) => Math.max(latest, message.id), 0);
      await advanceThreadRead(tx, socket.user.id, parentId, seen);
      return {
        parentId, channelCode: channel.code, blog: false, blogPicsOnly: false, closed: false,
        ...formatThreadParent(parent),
        messages: messages.map(message => formatThreadMessage(message, replies.get(message.reply_to), reactions.get(message.id))),
      };
    });
    if (!payload) return;
    socket.join('channel:' + payload.channelCode);
    emitThreadRead(io, socket, payload.channelCode, parentId);
    socket.emit('thread-messages', payload);
  }

  async function send(socket, data, callback) {
    const parentId = data?.parentId;
    const text = typeof data?.content === 'string' ? data.content.trim() : '';
    const acknowledge = typeof callback === 'function' ? callback : () => {};
    if (!Number.isSafeInteger(parentId) || parentId <= 0 || !text) return acknowledge({ error: 'Could not send thread reply' });
    return inThreadOrder(parentId, () => sendReply(socket, parentId, text, data, acknowledge));
  }

  async function sendReply(socket, parentId, text, data, acknowledge) {
    const user = socket.user;
    try {
      posting.checkFlood(user);
      const picked = takeSilent(text, data.silent);
      const result = await posting.withPostingTransaction(user, async tx => {
        const channel = await messageChannel(tx, null, { messageId: parentId });
        if (!channel) return;
        checkThreadChannel(channel);
        const permissions = createPermissions(tx);
        if (!user.isAdmin && !await messageChannelMember(tx, channel.id, user.id)) {
          throw new Error('Not a member of this channel');
        }
        // Keep reply insertion, the sender's read position and the first
        // reply decision in one transaction. Concurrent writers to this
        // thread take the same parent lock before any of them can insert.
        const parent = await threadParent(tx, parentId, { channelId: channel.id, sending: true });
        if (!parent) return;
        const saved = await postingSettings(tx);
        const why = sizeRefusal(picked.content, channel, {
          maxChars: parseInt(saved.max_message_chars, 10) || 2000, maxAttachments: saved.max_attachments,
        });
        if (why) throw new Error(why);
        const level = await posting.checkChannelPosting(tx, socket, channel, permissions, saved);
        if (level === null) return;
        const content = await posting.cleanRoomText(tx, data, picked.content, user, channel, permissions, saved, level, { thread: true });
        if (!content) return;

        // Outside a blog, replying to the parent itself is a plain thread
        // reply. Keep banners only for another reply in the same thread.
        let reply;
        if (Number.isSafeInteger(data.replyTo) && data.replyTo > 0 && data.replyTo !== parentId) {
          reply = await threadReplyTarget(tx, data.replyTo, parentId, channel.id);
        }
        const slowKey = posting.checkSlowMode(user, channel, level);
        const replyTo = reply?.id ?? null;
        const row = await insertThreadReply(tx, {
          channelId: channel.id, userId: user.id, parentId, content, replyTo, silent: picked.silent ? 1 : 0,
        });
        await advanceThreadRead(tx, user.id, parentId, row.lastInsertRowid);
        const summaries = await threadSummaries(tx, [parentId], channel.id);
        const thread = summaries.get(parentId);
        const members = await channelMembers(tx, channel, permissions);
        const memberIds = new Set(members.map(member => member.id));
        const followers = (await threadNotify.followerIds(tx, parentId, channel.id)).filter(id => memberIds.has(id));
        const startedFor = threadNotify.firstReplyRecipient(thread.count, parent.user_id, user.id, followers);
        return {
          slowKey, channelCode: channel.code, memberIds, followers, startedFor, thread,
          message: {
            id: row.lastInsertRowid, content, created_at: utcStamp(row.created_at),
            username: user.displayName, user_id: user.id, avatar: user.avatar,
            avatar_shape: user.avatar_shape || 'circle', border: user.border,
            borderTransform: user.borderTransform, animateProfile: user.animate_profile || 'trigger',
            reply_to: replyTo, replyContext: toReplyContext(reply), reactions: [], edited_at: null,
            thread_id: parentId, silent: picked.silent || undefined,
          },
        };
      });
      if (!result) return acknowledge({ error: 'Could not send thread reply' });

      const { channelCode, memberIds, message, thread, followers, startedFor } = result;
      const room = 'channel:' + channelCode;
      if (memberIds.has(user.id) && socket.connected) socket.join(room);
      const receivers = [...(io.sockets.adapter.rooms.get(room) || [])].filter(id =>
        memberIds.has(io.sockets.sockets.get(id)?.user?.id));
      // An admin can reply in a room they are visiting without membership.
      if (user.isAdmin && !memberIds.has(user.id)) receivers.push(socket.id);
      if (receivers.length) {
        const audience = io.to(receivers);
        audience.emit('new-thread-message', {
          channelCode, parentId, message, followerIds: followers, ...(startedFor ? { threadStartedFor: startedFor } : {}),
        });
        audience.emit('thread-updated', { channelCode, parentId, thread: { ...thread, senderId: user.id } });
      }
      acknowledge({ success: true });
    } catch (err) {
      if (err.code) console.warn('[postgres-preview] send-thread-message failed:', err.code);
      const error = err.code ? 'Failed to send thread message' : err.message;
      socket.emit('error-msg', error);
      acknowledge({ error });
    }
  }

  return { list, load, send };
}

module.exports = { createPostgresThreads, emitThreadRead, historyThreads };
