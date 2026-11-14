'use strict';

const { isUsableEmoji } = require('../builtinEmojis');
const mediaGroup = require('../mediaGroup');
const { looksEncrypted, isGroupEnvelope, sizeCeiling, sizeRefusal, editNeedsOriginalImage } = require('../messageLimits');
const { getActiveMute, muteNotice, updateMessageContent } = require('../db/messagePosting');
const { addReaction, removeReaction, listReactions } = require('../db/messageReactions');
const { messageChannel, messageChannelMember, messageForAction, messageAuthor,
        ownDeleteOverride, deleteMessage, findPin, countPins, insertPin, deletePin, clearDestructAt,
        setProtection, listPins, formatPins } = require('../db/messageManagement');
const protectedMessages = require('../protectedMessages');
const createPermissions = require('./asyncPermissions');
const { editChannelCode, isString, sanitizeText, utcStamp } = require('./helpers');
const { postingSettings, checkText } = require('./postgresPosting');

const unavailable = 'This message feature is not available on this server yet';

async function lockChannel(tx, user, code, messageId, { pinning = false, requireMember = false } = {}) {
  // Reactions identify their channel by message id. An explicit channel also
  // lets a repeat delete confirm a missing message after checking access.
  // Pin writes take the stronger lock before counting, even for different
  // messages in the same channel.
  const channel = await messageChannel(tx, code, { messageId, pinning });
  if (!channel) return;
  if (requireMember || !user.isAdmin || channel.is_dm) {
    const member = await messageChannelMember(tx, channel.id, user.id);
    if (!member) throw new Error('Not a member of this channel');
  }
  const permissions = createPermissions(tx);
  if (!user.isAdmin && !await permissions.roleGateAllows(user.id, channel)) {
    throw new Error('This channel needs a role you do not hold');
  }
  if (channel.is_group || channel.is_forum) throw new Error(unavailable);
  return { channel, permissions };
}

async function lockMessage(tx, channelId, messageId, { historyOnly = true, deleting = false } = {}) {
  // Lock the message after the channel and membership. Deletion also locks
  // out new thread replies while checking whether the message can go.
  const message = await messageForAction(tx, channelId, messageId, { historyOnly, deleting });
  if (message?.role_menu || message?.thread_id) throw new Error(unavailable);
  return message;
}

async function messageAudit(tx, channel, message, action) {
  if (channel.is_dm) return;
  const author = await messageAuthor(tx, message.user_id);
  return { action, targetName: author?.name };
}

async function auditMessage(db, user, channel, messageId, { action, targetName }) {
  try {
    await db.prepare(`
      INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, target_name, details)
      VALUES (?, ?, ?, 'message', ?, ?, ?)
    `).run(user.id, user.displayName || user.username, action, messageId, targetName?.slice(0, 200) || null,
      JSON.stringify({ channel: channel.name }).slice(0, 4000));
  } catch (err) {
    console.warn('[audit] log failed:', err.message);
  }
}

function createPostgresMessageActions(io, db, channelMembers) {
  const pending = new Map();

  async function changeMessage(socket, messageId, code, apply, { pinning = false } = {}) {
    // Keep broadcasts for the same message in write order across sockets.
    // The database locks still protect the writes from other connections.
    const previous = pending.get(messageId) || Promise.resolve();
    const current = previous.catch(() => { /* the earlier request reports its own failure */ }).then(async () => {
      const result = await db.withTransaction(async tx => {
        const target = await lockChannel(tx, socket.user, code, messageId, { pinning });
        if (!target) return;
        const payload = await apply(tx, target);
        if (!payload) return;
        const { channel, permissions } = target;
        const members = payload.senderOnly ? [] : await channelMembers(tx, channel, permissions);
        return { channel, members, payload };
      });
      if (!result) return;
      const { channel, members, payload } = result;
      const { event, audit, senderOnly, ...data } = payload;
      const update = { channelCode: channel.code, messageId, ...data };
      if (senderOnly) return socket.emit(event, update);
      // The audit is best effort, after the write has committed.
      if (audit) await auditMessage(db, socket.user, channel, messageId, audit);
      const allowed = new Set(members.map(member => member.id));
      const room = 'channel:' + channel.code;
      if (allowed.has(socket.user.id) && socket.connected) socket.join(room);
      const receivers = [...(io.sockets.adapter.rooms.get(room) || [])].filter(id =>
        allowed.has(io.sockets.sockets.get(id)?.user?.id));
      if (receivers.length) io.to(receivers).emit(event, update);
      if (!allowed.has(socket.user.id) && socket.user.isAdmin && !channel.is_dm) socket.emit(event, update);
    });
    pending.set(messageId, current);
    try {
      await current;
    } finally {
      if (pending.get(messageId) === current) pending.delete(messageId);
    }
  }

  async function edit(socket, data) {
    if (!Number.isSafeInteger(data?.messageId) || data.messageId <= 0 ||
        !isString(data.content, 1) || !data.content.trim()) return;
    const code = editChannelCode(data.channelCode, socket.currentChannel);
    if (!code) return;
    const user = socket.user;
    return changeMessage(socket, data.messageId, code, async (tx, { channel, permissions }) => {
      const message = await lockMessage(tx, channel.id, data.messageId);
      if (!message) return;
      if (message.user_id !== user.id) throw new Error('You can only edit your own messages');
      if (message.is_archived) throw new Error('This message is protected. Unprotect it first.');
      if (!user.isAdmin && !await permissions.userHasPermission(user.id, 'edit_own_messages', channel.id)) {
        throw new Error("You don't have permission to edit messages");
      }

      const saved = await postingSettings(tx);
      const maxChars = parseInt(saved.max_message_chars, 10) || 2000;
      if (data.content.length > sizeCeiling(maxChars)) {
        throw new Error(`Message too long (max ${maxChars} characters)`);
      }
      const trimmed = data.content.trim();
      const size = sizeRefusal(channel.is_dm ? trimmed : data.content, channel, {
        maxChars, maxAttachments: saved.max_attachments,
      });
      if (size) throw new Error(size);

      let content = trimmed;
      if (channel.is_dm) {
        if (user.isGuest) throw new Error('Guests cannot send direct messages');
        if (!looksEncrypted(content) || isGroupEnvelope(content)) throw new Error('Direct messages must be end-to-end encrypted');
        // The preview has no upload path for encrypted attachments.
        if (message.e2e_files) throw new Error(unavailable);
      } else {
        const mute = muteNotice(await getActiveMute(tx, user.id));
        if (mute) throw new Error(mute);
        content = sanitizeText(content);
        if (!content) return;
        if (editNeedsOriginalImage(content) && !message.original_name) {
          throw new Error('Cannot change a text message into an image');
        }
        // Captions can keep the stored uploads. Adding, swapping or removing
        // files needs the upload and cleanup paths as well.
        const originalFiles = mediaGroup.mediaLines(message.content);
        const editedFiles = mediaGroup.mediaLines(content);
        if (originalFiles.length !== editedFiles.length ||
            originalFiles.some((line, i) => line !== editedFiles[i])) {
          throw new Error(unavailable);
        }
        const level = !user.isAdmin && saved.automod_enabled === 'true'
          ? await permissions.getUserEffectiveLevel(user.id, channel.id)
          : 0;
        await checkText(tx, content, user, saved, { surface: 'edit', effectiveLevel: level, markdown: true });
      }

      const updated = await updateMessageContent(tx, message.id, content);
      return { event: 'message-edited', userId: user.id, content, editedAt: utcStamp(updated.edited_at) };
    });
  }

  async function react(socket, data, added) {
    if (!Number.isSafeInteger(data?.messageId) || data.messageId <= 0 || !isString(data.emoji, 1, 32)) return;
    const userId = socket.user.id;
    return changeMessage(socket, data.messageId, null, async (tx, { channel }) => {
      if (!await lockMessage(tx, channel.id, data.messageId)) return;
      if (channel.reactions_enabled === 0) throw new Error('Reactions are disabled in this channel');
      if (added) {
        const mute = muteNotice(await getActiveMute(tx, userId));
        if (mute) throw new Error(mute);
        if (!await isUsableEmoji(tx, data.emoji)) return;
        await addReaction(tx, data.messageId, userId, data.emoji);
      } else {
        await removeReaction(tx, data.messageId, userId, data.emoji);
      }
      const reactions = await listReactions(tx, data.messageId);
      return { event: 'reactions-updated', reactions };
    });
  }

  async function remove(socket, data) {
    if (!Number.isSafeInteger(data?.messageId) || data.messageId <= 0) return;
    const code = editChannelCode(data.channelCode, socket.currentChannel);
    if (!code) return;
    const user = socket.user;
    return changeMessage(socket, data.messageId, code, async (tx, { channel, permissions }) => {
      const message = await lockMessage(tx, channel.id, data.messageId, { historyOnly: false, deleting: true });
      // A repeat delete still clears the row from the requesting screen.
      if (!message) return { event: 'message-deleted', senderOnly: true };
      const protection = await protectedMessages.protectionFor(tx, message.id);
      if (protection?.kept) {
        throw new Error(protection.is_archived ? protectedMessages.REFUSAL : protectedMessages.THREAD_REFUSAL);
      }
      const own = message.user_id === user.id;
      if (own && !user.isAdmin) {
        // Owners can delete by default. Only an explicit deny in this
        // channel's role chain (or a server-wide deny) takes that away.
        const chain = await permissions.getChannelRoleChain(channel.id);
        const deny = await ownDeleteOverride(tx, user.id, chain);
        if (deny?.allowed === 0) throw new Error("You don't have permission to delete messages");
      } else if (!own) {
        let allowed = !channel.is_dm && (user.isAdmin || await permissions.userHasPermission(user.id, 'delete_message', channel.id));
        if (!allowed && !channel.is_dm && await permissions.userHasPermission(user.id, 'delete_lower_messages', channel.id)) {
          const level = await permissions.getUserEffectiveLevel(user.id, channel.id);
          allowed = level > await permissions.getUserEffectiveLevel(message.user_id, channel.id);
        }
        if (!allowed) throw new Error('You can only delete your own messages');
      }

      // Thread and attachment cleanup are still outside the preview.
      if (message.original_name || message.e2e_files || mediaGroup.hasMedia(message.content) ||
          (channel.is_dm && Array.isArray(data.attachments) && data.attachments.length) ||
          await tx.prepare('SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1').get(message.id)) {
        throw new Error(unavailable);
      }
      // The foreign keys remove reactions and pins in the same transaction.
      await deleteMessage(tx, message.id);
      const audit = own ? null : await messageAudit(tx, channel, message, 'message_delete');
      return { event: 'message-deleted', audit };
    });
  }

  async function pin(socket, data, pinned) {
    const code = socket.currentChannel;
    if (!code || !Number.isSafeInteger(data?.messageId) || data.messageId <= 0) return;
    const user = socket.user;
    return changeMessage(socket, data.messageId, code, async (tx, { channel, permissions }) => {
      if (!user.isAdmin && !await permissions.userHasPermission(user.id, 'pin_message', channel.id)) {
        throw new Error(`You don't have permission to ${pinned ? 'pin' : 'unpin'} messages`);
      }
      const message = await lockMessage(tx, channel.id, data.messageId, { historyOnly: false });
      if (!message) throw new Error(pinned ? 'Message not found' : 'Message is not pinned');
      const existing = await findPin(tx, message.id);
      if (!pinned) {
        if (!existing || existing.channel_id !== channel.id) throw new Error('Message is not pinned');
        await deletePin(tx, message.id);
        return { event: 'message-unpinned', audit: await messageAudit(tx, channel, message, 'message_unpin') };
      }
      if (message.burn_seconds > 0) throw new Error(unavailable);
      if (existing) throw new Error('Message is already pinned');
      if ((await countPins(tx, channel.id)).cnt >= 50) throw new Error('Channel has reached the 50-pin limit');
      await insertPin(tx, message.id, channel.id, user.id);
      // Pinning keeps a self-destructing message, so its timer is dropped.
      if (message.destruct_at) await clearDestructAt(tx, message.id);
      const audit = await messageAudit(tx, channel, message, 'message_pin');
      return { event: 'message-pinned', pinnedBy: user.displayName, audit };
    }, { pinning: true });
  }

  async function protect(socket, data, archived) {
    const code = socket.currentChannel;
    if (!code || !Number.isSafeInteger(data?.messageId) || data.messageId <= 0) return;
    const user = socket.user;
    return changeMessage(socket, data.messageId, code, async (tx, { channel, permissions }) => {
      if (!user.isAdmin && !await permissions.userHasPermission(user.id, 'archive_messages', channel.id)) {
        throw new Error(`You don't have permission to ${archived ? 'archive' : 'unarchive'} messages`);
      }
      const message = await lockMessage(tx, channel.id, data.messageId, { historyOnly: false });
      if (!message) throw new Error('Message not found');
      if (!!message.is_archived === archived) throw new Error(archived ? 'Message is already archived' : 'Message is not archived');
      await setProtection(tx, message.id, archived);
      const audit = await messageAudit(tx, channel, message, archived ? 'message_protect' : 'message_unprotect');
      if (archived) {
        return { event: 'message-archived', archivedBy: user.displayName, audit };
      }
      return { event: 'message-unarchived', audit };
    });
  }

  async function getPins(socket, data) {
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return;
    const pins = await db.withTransaction(async tx => {
      const target = await lockChannel(tx, socket.user, code, null, { requireMember: true });
      if (target) return listPins(tx, target.channel.id, 0);
    });
    if (pins) socket.emit('pinned-messages', { channelCode: code, pins: formatPins(pins) });
  }

  return { edit, react, remove, pin, protect, getPins };
}

module.exports = { createPostgresMessageActions };
