'use strict';

const { isUsableEmoji } = require('../builtinEmojis');
const mediaGroup = require('../mediaGroup');
const { looksEncrypted, isGroupEnvelope, sizeCeiling, sizeRefusal, editNeedsOriginalImage } = require('../messageLimits');
const { getActiveMute, muteNotice, updateMessageContent } = require('../db/messagePosting');
const { addReaction, removeReaction, listReactions } = require('../db/messageReactions');
const createPermissions = require('./asyncPermissions');
const { editChannelCode, isString, sanitizeText, utcStamp } = require('./helpers');
const { postingSettings, checkText } = require('./postgresPosting');

const unavailable = 'This message feature is not available on this server yet';

async function lockMessage(tx, user, messageId, code) {
  // Reactions identify their channel by message id. Edits also verify the
  // channel from the composer, including when it came from a DM PiP.
  const channel = await tx.prepare(`
    SELECT c.id, c.code, c.is_dm, c.is_group, c.is_forum, c.role_gate, c.reactions_enabled
    FROM channels c JOIN messages m ON m.channel_id = c.id
    WHERE m.id = ? AND (?::text IS NULL OR c.code = ?) FOR SHARE OF c
  `).get(messageId, code, code);
  if (!channel) return;
  if (!user.isAdmin || channel.is_dm) {
    const member = await tx.prepare(`
      SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? FOR SHARE
    `).get(channel.id, user.id);
    if (!member) throw new Error('Not a member of this channel');
  }
  const permissions = createPermissions(tx);
  if (!user.isAdmin && !await permissions.roleGateAllows(user.id, channel)) {
    throw new Error('This channel needs a role you do not hold');
  }
  if (channel.is_group || channel.is_forum) throw new Error(unavailable);

  // Lock the message after the channel and membership. This also serialises
  // reaction snapshots and keeps an edit from racing a protect or move.
  const message = await tx.prepare(`
    SELECT m.id, m.user_id, m.content, m.is_archived, m.original_name, m.e2e_files,
           EXISTS (SELECT 1 FROM role_menus rm WHERE rm.message_id = m.id) AS role_menu
    FROM messages m
    WHERE m.id = ? AND m.channel_id = ? AND m.thread_id IS NULL
      AND m.destruct_at IS NULL AND COALESCE(m.burn_seconds, 0) = 0
    FOR NO KEY UPDATE OF m
  `).get(messageId, channel.id);
  if (!message) return;
  if (message.role_menu) throw new Error(unavailable);
  return { channel, message, permissions };
}

function createPostgresMessageActions(io, db, channelMembers) {
  const pending = new Map();

  async function changeMessage(socket, messageId, code, apply) {
    // Keep broadcasts for the same message in write order across sockets.
    // The database locks still protect the writes from other connections.
    const previous = pending.get(messageId) || Promise.resolve();
    const current = previous.catch(() => { /* the earlier request reports its own failure */ }).then(async () => {
      const result = await db.withTransaction(async tx => {
        const target = await lockMessage(tx, socket.user, messageId, code);
        if (!target) return;
        const payload = await apply(tx, target);
        if (!payload) return;
        const { channel, permissions } = target;
        const members = await channelMembers(tx, channel, permissions);
        return { channel, members, payload };
      });
      if (!result) return;
      const { channel, members, payload } = result;
      const allowed = new Set(members.map(member => member.id));
      const room = 'channel:' + channel.code;
      if (allowed.has(socket.user.id) && socket.connected) socket.join(room);
      const receivers = [...(io.sockets.adapter.rooms.get(room) || [])].filter(id =>
        allowed.has(io.sockets.sockets.get(id)?.user?.id));
      if (receivers.length) {
        const { event, ...data } = payload;
        io.to(receivers).emit(event, { channelCode: channel.code, messageId, ...data });
      }
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
    return changeMessage(socket, data.messageId, code, async (tx, { channel, message, permissions }) => {
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

  return { edit, react };
}

module.exports = { createPostgresMessageActions };
