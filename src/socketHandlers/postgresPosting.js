'use strict';

const { generateChannelCode } = require('../auth');
const automod = require('../automod');
const mediaGroup = require('../mediaGroup');
const { looksEncrypted, isGroupEnvelope, sizeRefusal } = require('../messageLimits');
const { takeSilent } = require('../silentMessages');
const { parseSlash } = require('../slashParse');
const { sanitizeText, stripRoleMentions, toReplyContext, utcStamp, NEW_DMS_PER_HOUR } = require('./helpers');
const { waitMessage } = require('./postingWait');
const createPermissions = require('./asyncPermissions');
const { REPLY_CONTEXT_SELECT, getActiveMute, muteNotice, insertMessage } = require('../db/messagePosting');
const directMessages = require('../db/directMessages');

const unavailable = 'This message feature is not available on this server yet';

async function postingSettings(db) {
  const rows = await db.prepare(`
    SELECT key, value FROM server_settings
    WHERE key LIKE 'automod_%' OR key IN ('max_message_chars', 'max_attachments')
  `).all();
  return { ...automod.DEFAULTS, ...Object.fromEntries(rows.map(row => [row.key, row.value])) };
}

async function checkText(db, text, user, saved, { surface, effectiveLevel, markdown = false }) {
  if (!text || user.isAdmin || saved.automod_enabled !== 'true') return;
  const domains = await db.prepare('SELECT domain, mode, include_subdomains FROM automod_domains').all();
  const verdict = automod.checkTextWithSettings(text, {
    isAdmin: user.isAdmin, createdAt: user.createdAt, effectiveLevel, surface, markdown,
  }, saved, domains);
  if (!verdict.ok) throw new Error(verdict.message);
}

function refuseYoungAccount(socket, saved, effectiveLevel) {
  const { isAdmin, createdAt } = socket.user;
  const minutes = automod.newAccountWaitMinutes({ isAdmin, createdAt, effectiveLevel }, saved);
  if (minutes <= 0) return false;
  socket.emit('new-account-wait', { minutes, message: waitMessage(minutes) });
  return true;
}

function needsUnmigratedSend(data, content) {
  return data.isImage === true || data.bundled === true || data.highlight === true
    || data.burnSeconds > 0 || data.destructSeconds > 0 || Number.isInteger(data.quoteOf)
    || data.ferryDiscordUserId || data.files?.length || data.mediaTags?.length || data.attachmentTags?.length
    || content.startsWith('::') || /^=>\S/.test(content) || mediaGroup.hasMedia(content);
}

async function reserveDmCode(tx, userId, isSelfDm) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const code = generateChannelCode();
    const reserved = await tx.prepare(`
      SELECT 1 FROM server_settings WHERE key IN ('server_code', 'vanity_code') AND value = ?
      UNION ALL SELECT 1 FROM invite_codes WHERE code = ?
      LIMIT 1
    `).get(code, code);
    if (reserved) continue;
    const inserted = await directMessages.create(tx, code, userId, isSelfDm);
    if (inserted) return { id: inserted.lastInsertRowid, code, name: 'DM' };
  }
  throw new Error('Unable to generate a unique channel code');
}

function dmPayload(channel, target, isSelfDm) {
  return { ...channel, is_dm: 1, is_self_dm: isSelfDm ? 1 : 0, dm_target: target };
}

function createPostgresPosting(io, db, readPositions, channelMembers) {
  const floodTimes = new Map();
  const slowTimes = new Map();

  async function startDm(socket, data) {
    const targetId = data?.targetUserId;
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return;
    const user = socket.user;
    if (user.isGuest) throw new Error('Guests cannot send direct messages');
    const isSelfDm = targetId === user.id;

    const opened = await db.withTransaction(async tx => {
      // Lock the two accounts in id order. Opposite-direction opens share
      // this lock, as do starts by the same user that share the hourly cap.
      await tx.prepare(`
        SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR NO KEY UPDATE
      `).all(user.id, targetId);
      if (!isSelfDm && !await directMessages.target(tx, user.id)) throw new Error('Your account cannot start a conversation');
      const target = await directMessages.target(tx, targetId);
      if (!target) throw new Error('User not found');
      const existing = await directMessages.existing(tx, user.id, targetId);
      if (existing) return { channel: existing, target, created: false };
      if (!isSelfDm && !user.isAdmin) {
        const saved = await postingSettings(tx);
        const age = { createdAt: user.createdAt, isAdmin: false };
        if (automod.newAccountWaitMinutes(age, saved) > 0) {
          const level = await createPermissions(tx).getUserEffectiveLevel(user.id);
          if (refuseYoungAccount(socket, saved, level)) return null;
        }
        const count = await directMessages.recentCount(tx, user.id);
        if (count.n >= NEW_DMS_PER_HOUR) {
          throw new Error('You have started a lot of new conversations in the last hour. Try again later.');
        }
      }
      const channel = await reserveDmCode(tx, user.id, isSelfDm);
      await directMessages.join(tx, channel.id, user.id);
      if (!isSelfDm) await directMessages.join(tx, channel.id, targetId);
      return { channel, target, created: true };
    });
    if (!opened) return;

    const { channel, target, created } = opened;
    const room = 'channel:' + channel.code;
    socket.join(room);
    socket.emit('dm-opened', dmPayload(channel, target, isSelfDm));
    if (created) {
      // Other tabs of either member need the room before the first send.
      for (const peer of io.sockets.sockets.values()) {
        if (peer.user.id === user.id || peer.user.id === targetId) peer.join(room);
        if (!isSelfDm && peer.user.id === targetId) {
          peer.emit('dm-opened', dmPayload(channel, { id: user.id, username: user.displayName }, false));
        }
      }
    }
  }

  async function send(socket, data) {
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code) || typeof data.content !== 'string' || !data.content.trim()) return;
    const user = socket.user;
    if (!user.isAdmin) {
      const now = Date.now();
      const times = (floodTimes.get(user.id) || []).filter(at => now - at < 10000);
      if (times.length >= 10) throw new Error("Slow down, you're sending messages too fast");
      times.push(now);
      floodTimes.set(user.id, times);
    }
    const picked = takeSilent(data.content, data.silent);
    const result = await db.withTransaction(async tx => {
      // Lock both rows through the insert. A removal or a change to the
      // channel's posting options cannot slip between the check and write.
      const channel = await tx.prepare(`
        SELECT c.* FROM channels c
        JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
        WHERE c.code = ? AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = cm.user_id)
        FOR SHARE OF c, cm
      `).get(user.id, code);
      if (!channel) throw new Error('Not a member of this channel');
      if (channel.is_group || channel.is_forum) throw new Error('This channel type is not available on this server yet');

      const saved = await postingSettings(tx);
      let content = picked.content.trim();
      const size = sizeRefusal(picked.content, channel, {
        maxChars: parseInt(saved.max_message_chars, 10) || 2000, maxAttachments: saved.max_attachments,
      });
      if (size) throw new Error(size);

      if (channel.is_dm) {
        if (user.isGuest) throw new Error('Guests cannot send direct messages');
        if (!looksEncrypted(content) || isGroupEnvelope(content)) throw new Error('Direct messages must be end-to-end encrypted');
      } else {
        const mute = muteNotice(await getActiveMute(tx, user.id));
        if (mute) throw new Error(mute);
      }

      const permissions = createPermissions(tx);
      if (!user.isAdmin && !await permissions.roleGateAllows(user.id, channel)) {
        throw new Error('This channel needs a role you do not hold');
      }
      let level = 0;
      if (!user.isAdmin && (saved.automod_enabled === 'true' || channel.slow_mode_interval > 0)) {
        level = await permissions.getUserEffectiveLevel(user.id, channel.id);
      }
      if (!channel.is_self_dm && refuseYoungAccount(socket, saved, level)) return null;
      if (channel.read_only === 1 && !user.isAdmin &&
          !await permissions.userHasPermission(user.id, 'read_only_override', channel.id)) {
        throw new Error('This channel is read-only');
      }
      if (channel.text_enabled === 0) throw new Error('Text messages are disabled in this channel');

      let breakChain = 0;
      if (!channel.is_dm) {
        const split = content.match(/^\/break\s+([\s\S]+)$/);
        if (split) {
          content = split[1];
          breakChain = 1;
        }
        if (parseSlash(content) || needsUnmigratedSend(data, content)) throw new Error(unavailable);
        if (content.includes('@') && !user.isAdmin &&
            !await permissions.userHasPermission(user.id, 'mention_everyone', channel.id)) {
          const roles = await tx.prepare('SELECT name FROM roles').all();
          content = stripRoleMentions(content.replace(/(?<![\w@])@(everyone|here)\b/gi, '@\u200B$1'), roles.map(role => role.name));
        }
        content = sanitizeText(content.trim());
        await checkText(tx, content, user, saved, { surface: 'message', effectiveLevel: level, markdown: true });
      } else if (needsUnmigratedSend(data, content)) {
        throw new Error(unavailable);
      }
      if (!content) return null;

      // Reply data is scoped to the same channel and locked through the write.
      // Ephemeral messages need their own workers before they can be quoted.
      let reply = null;
      if (Number.isSafeInteger(data.replyTo) && data.replyTo > 0) {
        reply = await tx.prepare(`${REPLY_CONTEXT_SELECT}
          WHERE m.id = ? AND m.channel_id = ? AND m.thread_id IS NULL
            AND m.destruct_at IS NULL AND COALESCE(m.burn_seconds, 0) = 0
          FOR SHARE OF m
        `).get(data.replyTo, channel.id);
      }
      if (channel.slow_mode_interval > 0 && !user.isAdmin && level < 25) {
        const key = String(user.id) + ':' + channel.id;
        const now = Date.now();
        const remaining = Math.ceil(((slowTimes.get(key) || 0) + channel.slow_mode_interval * 1000 - now) / 1000);
        if (remaining > 0) throw new Error(`Slow mode: wait ${remaining}s before sending another message`);
        slowTimes.set(key, now);
      }
      const row = await insertMessage(tx, {
        channelId: channel.id, userId: user.id, content, replyTo: reply?.id ?? null,
        silent: picked.silent ? 1 : 0, breakChain,
      });
      const members = await channelMembers(tx, channel, permissions);
      return {
        channelId: channel.id, memberIds: new Set(members.map(member => member.id)),
        message: {
          id: row.lastInsertRowid, content, created_at: utcStamp(row.created_at),
          username: user.displayName, user_id: user.id,
          avatar: user.avatar, avatar_shape: user.avatar_shape, border: user.border,
          borderTransform: user.borderTransform, animateProfile: user.animate_profile,
          reply_to: reply?.id ?? null, replyContext: toReplyContext(reply),
          reactions: [], edited_at: null, thread: null,
          silent: picked.silent || undefined, break_chain: breakChain || undefined,
        },
      };
    });
    if (!result) return;

    // Join the sender and deliver only to sockets that still have access.
    // A Socket.IO subscription alone does not prove database membership.
    const room = 'channel:' + code;
    socket.join(room);
    const receivers = [...(io.sockets.adapter.rooms.get(room) || [])].filter(id =>
      result.memberIds.has(io.sockets.sockets.get(id)?.user?.id));
    if (receivers.length) io.to(receivers).emit('new-message', { channelCode: code, message: result.message });
    await readPositions.advance(user.id, result.channelId, result.message.id)
      .catch(() => { /* only the sender's own unread marker; it catches up on their next read */ });
  }

  return { send, startDm, close: () => { floodTimes.clear(); slowTimes.clear(); } };
}

module.exports = { createPostgresPosting, postingSettings, checkText };
