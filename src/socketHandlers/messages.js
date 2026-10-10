'use strict';

const path = require('path');
const fs   = require('fs');
const bcrypt = require('bcryptjs');
const { utcStamp, isString, isInt, sanitizeText, parseBorderTransform, toReplyContext, stripRoleMentions, releasableUploads } = require('./helpers');
const { getActiveTokenizer, minQueryChars, buildMatchQuery } = require('../searchIndex');
const selfDestruct = require('../selfDestruct');
const { applyTagsToMessage, setMessageTags, normalizeTagName, escapeLike, extractUploadPath, effectiveLimits } = require('../uploadTags');
const { votesFor } = require('../forumVotes');
const forumBlog = require('../forumBlog');

// The length limit is on what people type. An encrypted DM reaches the
// server as ciphertext: AES-GCM output in base64 inside a small JSON wrapper,
// up to about four times the typed length (a character can take three bytes
// as UTF-8 and base64 adds a third). A DM near the limit was refused after
// the message box had already cleared (#5691), so ciphertext gets that room.
function encryptedDmCap(maxChars) {
  return maxChars * 4 + 256;
}
function looksEncrypted(content) {
  if (typeof content !== 'string' || content.charCodeAt(0) !== 123) return false;
  try {
    const o = JSON.parse(content);
    return !!(o && (o.v === 1 || o.v === 2 || (o.v === 3 && Number.isInteger(o.e) && typeof o.sig === 'string')) && typeof o.iv === 'string' && typeof o.ct === 'string');
  } catch { return false; }
}
function isGroupEnvelope(content) {
  return looksEncrypted(content) && JSON.parse(content).v === 3;
}
function contentCap(maxChars, channel, content) {
  return channel && channel.is_dm && looksEncrypted(content) ? encryptedDmCap(maxChars) : maxChars;
}

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel, getChannelRoleChain,
          sendPushNotifications, fireWebhookCallbacks, fireWebhookEvent, processSlashCommand,
          touchVoiceActivity, floodCheck, enforceAutomod, parseFerryTarget, ferryRelay, ferryRelayReply,
          logAudit, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = ctx;
  const { slowModeTracker } = state;
  const { youngAccountWait, refuseYoungAccount } = require('./postingWait')(socket, ctx);

  // Membership alone is not access. A person can hold a membership row for a
  // channel whose required roles they lack (joining with the server code adds
  // every public channel, gate or not), and the gate is what hides it from
  // them. Every handler that reads a channel or posts in it checks both;
  // only get-messages, send-message and the thread handlers used to.
  // @everyone, @here and @Role reach whole groups, so only people allowed
  // mention_everyone may send them; for anyone else a zero-width space after
  // the @ keeps the text and stops the ping. send-message has always done
  // this; threads, polls and scheduled messages skipped it.
  function pingSafe(content, userId, channelId) {
    if (typeof content !== 'string' || !content.includes('@')) return content;
    const u = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if ((u && u.is_admin) || userHasPermission(userId, 'mention_everyone', channelId)) return content;
    const out = content.replace(/(?<![\w@])@(everyone|here)\b/gi, '@\u200B$1');
    return stripRoleMentions(out, db.prepare('SELECT name FROM roles').all().map(r => r.name));
  }

  function hasChannelAccess(channelId) {
    if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id)) return false;
    if (socket.user.isAdmin) return true;
    return ctx.roleGateAllows(socket.user.id, db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channelId));
  }

  const UPLOAD_PATH_RE = /\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
  const UPLOAD_PATH_EXACT_RE = /^\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)$/;

  function isSafeUploadRelPath(relPath) {
    if (typeof relPath !== 'string' || !relPath) return false;
    if (!/^((?!\.\.)(?!\.\/)(?!\/)[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relPath)) return false;
    const parts = relPath.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) return false;
    return true;
  }

  function moveUploadToDeleted(relPath) {
    if (!isSafeUploadRelPath(relPath)) return;
    const src = path.join(UPLOADS_DIR, relPath);
    if (!fs.existsSync(src)) return;
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const dst = path.join(DELETED_ATTACHMENTS_DIR, relPath);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } catch { /* file locked or already moved; it stays where it is and nothing is lost */ }
  }

  // Reply banners must match message rendering: bots live in webhook_* with
  // user_id NULL, so a users-table COALESCE alone becomes "[Deleted User]".
  const REPLY_CONTEXT_SELECT = `
    SELECT m.id, m.content, m.user_id, m.is_webhook, m.webhook_username, m.imported_from, m.persona_username,
           COALESCE(u.display_name, u.username, '[Deleted User]') as username
    FROM messages m LEFT JOIN users u ON m.user_id = u.id`;

  // ── Get message history ─────────────────────────────────
  // ── Forum channels (#144) ──────────────────────────────
  // A forum channel is an ordinary channel whose top-level messages are
  // topics. Replies live in each topic's thread, and the channel lists topics
  // by their latest activity (the topic itself or its newest reply) instead of
  // by when they were posted, so a reply bumps an old topic back to the newest
  // end. Cursors keep the same shape as the chronological queries (a message
  // id) but resolve to that message's activity stamp first, so "older than X"
  // means "less recently active than X".
  const FORUM_ACTIVITY = 'COALESCE((SELECT MAX(t.created_at) FROM messages t WHERE t.thread_id = m.id), m.created_at)';
  // Likes minus dislikes, for the Most liked order (#5742).
  const FORUM_SCORE = '(SELECT COALESCE(SUM(v.value), 0) FROM forum_votes v WHERE v.message_id = m.id)';
  const FORUM_SELECT = `
    SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type, m.title, m.tags, m.closed, m.nsfw,
           COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
           COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile,
           ${FORUM_ACTIVITY} AS activity_at, ${FORUM_SCORE} AS score
    FROM messages m LEFT JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ? AND m.thread_id IS NULL`;
  // Sort key for a forum page: 'active' (default, latest reply bumps the
  // topic), 'created' (date posted) or 'top' (most liked). Tags filter with
  // 'some' (any of the picked tags) or 'all' (every picked tag), read from
  // the JSON array on the topic row.
  function forumKeyExpr(sort) { return sort === 'created' ? 'm.created_at' : sort === 'top' ? FORUM_SCORE : FORUM_ACTIVITY; }
  function forumKeyCol(sort) { return sort === 'created' ? 'created_at' : sort === 'top' ? 'score' : 'activity_at'; }
  function forumTagSql(tags, mode) {
    if (!tags.length) return { sql: '', params: [] };
    const one = "EXISTS (SELECT 1 FROM json_each(COALESCE(m.tags, '[]')) je WHERE je.value = ?)";
    return { sql: ` AND (${tags.map(() => one).join(mode === 'all' ? ' AND ' : ' OR ')})`, params: tags };
  }
  function forumKeyOf(id, sort) {
    const row = db.prepare(`SELECT ${forumKeyExpr(sort)} AS k FROM messages m WHERE m.id = ?`).get(id);
    return row ? row.k : null;
  }
  // Less recently active (or older) than the cursor message, newest first
  // (reversed by the caller, like the chronological "before" query).
  function forumOlder(channelId, cursorId, limit, opts) {
    const at = forumKeyOf(cursorId, opts.sort);
    if (at == null) return [];
    const key = forumKeyCol(opts.sort); const tag = forumTagSql(opts.tags, opts.tagMode);
    return db.prepare(`
      SELECT * FROM (${FORUM_SELECT}${tag.sql})
      WHERE ${key} < ? OR (${key} = ? AND id < ?)
      ORDER BY ${key} DESC, id DESC LIMIT ?
    `).all(channelId, ...tag.params, at, at, cursorId, limit);
  }
  function forumNewer(channelId, cursorId, limit, opts) {
    const at = forumKeyOf(cursorId, opts.sort);
    if (at == null) return [];
    const key = forumKeyCol(opts.sort); const tag = forumTagSql(opts.tags, opts.tagMode);
    return db.prepare(`
      SELECT * FROM (${FORUM_SELECT}${tag.sql})
      WHERE ${key} > ? OR (${key} = ? AND id > ?)
      ORDER BY ${key} ASC, id ASC LIMIT ?
    `).all(channelId, ...tag.params, at, at, cursorId, limit);
  }
  function forumHistory(channelId, { before, after, around, limit, sort = 'active', tags = [], tagMode = 'some' }) {
    const opts = { sort, tags, tagMode };
    if (before) return forumOlder(channelId, before, limit, opts);
    if (after) return forumNewer(channelId, after, limit, opts);
    if (around) {
      const half = Math.floor(limit / 2);
      const target = db.prepare(`SELECT * FROM (${FORUM_SELECT}) WHERE id = ?`).all(channelId, around);
      return [...forumOlder(channelId, around, half, opts).reverse(), ...target, ...forumNewer(channelId, around, half, opts)];
    }
    const key = forumKeyCol(sort); const tag = forumTagSql(tags, tagMode);
    // Pinned topics ride on the first page whatever their last activity, so
    // they are on top from the start rather than only once they happen to
    // load. Later pages may hand one back again; the client skips repeats.
    const pinned = db.prepare(`
      SELECT * FROM (${FORUM_SELECT}${tag.sql})
      WHERE id IN (SELECT message_id FROM pinned_messages WHERE channel_id = ?)
      ORDER BY ${key} DESC, id DESC
    `).all(channelId, ...tag.params, channelId);
    const page = db.prepare(`
      SELECT * FROM (${FORUM_SELECT}${tag.sql})
      ORDER BY ${key} DESC, id DESC LIMIT ?
    `).all(channelId, ...tag.params, limit);
    const seen = new Set(pinned.map(r => r.id));
    return [...pinned, ...page.filter(r => !seen.has(r.id))];
  }
  function parseTags(raw) {
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(t => typeof t === 'string') : []; } catch { return []; }
  }

  socket.on('get-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const before = isInt(data.before) ? data.before : null;
    const after  = isInt(data.after)  ? data.after  : null;
    const around = isInt(data.around) ? data.around : null;
    const limit = isInt(data.limit) && data.limit > 0 && data.limit <= 100 ? data.limit : 80;
    const sort = data.sort === 'created' || data.sort === 'top' ? data.sort : 'active';
    const tags = Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 30)).slice(0, 10) : [];
    const tagMode = data.tagMode === 'all' ? 'all' : 'some';

    const channel = db.prepare('SELECT id, is_forum, role_gate, forum_blog FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return socket.emit('error-msg', 'Not a member of this channel');
    if (!socket.user.isAdmin && !ctx.roleGateAllows(socket.user.id, channel)) return socket.emit('error-msg', 'This channel needs a role you do not hold');

    let messages;
    if (channel.is_forum) {
      messages = forumHistory(channel.id, { before, after, around, limit, sort, tags, tagMode });
    } else if (before) {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id < ? AND m.thread_id IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(channel.id, before, limit);
    } else if (after) {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id > ? AND m.thread_id IS NULL
        ORDER BY m.created_at ASC, m.id ASC LIMIT ?
      `).all(channel.id, after, limit);
    } else if (around) {
      const half = Math.floor(limit / 2);
      const beforeMsgs = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id < ? AND m.thread_id IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(channel.id, around, half);
      const targetMsg = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id = ?
      `).all(channel.id, around);
      const afterMsgs = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id > ? AND m.thread_id IS NULL
        ORDER BY m.created_at ASC, m.id ASC LIMIT ?
      `).all(channel.id, around, half);
      // Combine: beforeMsgs is DESC so reverse it, target, then afterMsgs ASC
      messages = [...beforeMsgs.reverse(), ...targetMsg, ...afterMsgs];
    } else {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.destruct_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain, m.ferry_target, m.type,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.thread_id IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(channel.id, limit);
    }

    // Batch-enrich messages (reply context, reactions, pin status) in 3 queries
    const msgIds = messages.map(m => m.id);
    const replyIds = [...new Set(messages.filter(m => m.reply_to).map(m => m.reply_to))];

    const replyMap = new Map();
    if (replyIds.length > 0) {
      const ph = replyIds.map(() => '?').join(',');
      db.prepare(`${REPLY_CONTEXT_SELECT}
        WHERE m.id IN (${ph}) AND m.channel_id = ?
      `).all(...replyIds, channel.id).forEach(r => replyMap.set(r.id, toReplyContext(r)));
    }

    const reactionMap = new Map();
    const pollVoteMap = new Map();
    const roleMenuMap = new Map();
    const attachmentTagMap = new Map();
    let pinnedSet = null;
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      db.prepare(`
        SELECT r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username
        FROM reactions r JOIN users u ON r.user_id = u.id
        WHERE r.message_id IN (${ph}) ORDER BY r.id
      `).all(...msgIds).forEach(r => {
        if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
        reactionMap.get(r.message_id).push({ emoji: r.emoji, user_id: r.user_id, username: r.username });
      });

      pinnedSet = new Set(
        db.prepare(`SELECT message_id FROM pinned_messages WHERE message_id IN (${ph})`)
          .all(...msgIds).map(r => r.message_id)
      );

      db.prepare(`SELECT message_id, title, data FROM role_menus WHERE message_id IN (${ph})`).all(...msgIds)
        .forEach(r => { const menu = ctx.buildRoleMenu?.(r, socket.user.id); if (menu) roleMenuMap.set(r.message_id, menu); });

      db.prepare(`
        SELECT pv.message_id, pv.option_index, pv.user_id, COALESCE(u.display_name, u.username) as username
        FROM poll_votes pv JOIN users u ON pv.user_id = u.id
        WHERE pv.message_id IN (${ph}) ORDER BY pv.id
      `).all(...msgIds).forEach(v => {
        if (!pollVoteMap.has(v.message_id)) pollVoteMap.set(v.message_id, []);
        pollVoteMap.get(v.message_id).push(v);
      });

      // Attachment tags (#tagging): every tag across a message's attachments,
      // folded into one deduped list per message for the message footer.
      db.prepare(`
        SELECT at.message_id, ut.name
        FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id
        WHERE at.message_id IN (${ph}) ORDER BY ut.name_norm
      `).all(...msgIds).forEach(r => {
        if (!attachmentTagMap.has(r.message_id)) attachmentTagMap.set(r.message_id, []);
        const arr = attachmentTagMap.get(r.message_id);
        if (!arr.includes(r.name)) arr.push(r.name);
      });
    }

    const webhookAvatarMap = new Map();
    const webhookNamesNeedingAvatar = [...new Set(
      messages.filter(m => m.is_webhook && !m.webhook_avatar && m.webhook_username)
        .map(m => m.webhook_username)
    )];
    if (webhookNamesNeedingAvatar.length > 0) {
      const ph = webhookNamesNeedingAvatar.map(() => '?').join(',');
      db.prepare(
        `SELECT name, avatar_url FROM webhooks WHERE channel_id = ? AND name IN (${ph}) AND avatar_url IS NOT NULL`
      ).all(channel.id, ...webhookNamesNeedingAvatar).forEach(w => {
        webhookAvatarMap.set(w.name, w.avatar_url);
      });
    }

    // ── Thread metadata enrichment ─────────────────────────
    const threadMap = new Map();
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      // Get thread counts and last activity for messages that are thread parents
      db.prepare(`
        SELECT thread_id,
               COUNT(*) as reply_count,
               MAX(created_at) as last_reply_at,
               MAX(id) as last_reply_id
        FROM messages WHERE thread_id IN (${ph})
        GROUP BY thread_id
      `).all(...msgIds).forEach(t => {
        threadMap.set(t.thread_id, { count: t.reply_count, lastReplyAt: utcStamp(t.last_reply_at), lastReplyId: t.last_reply_id, participants: [] });
      });
      // Get participants for threads (up to 5 unique usernames)
      if (threadMap.size > 0) {
        const threadIds = [...threadMap.keys()];
        const tph = threadIds.map(() => '?').join(',');
        db.prepare(`
          SELECT tm.thread_id, COALESCE(u.display_name, u.username) as username, u.avatar
          FROM (
            SELECT thread_id, user_id, MAX(created_at) as latest
            FROM messages WHERE thread_id IN (${tph})
            GROUP BY thread_id, user_id
          ) tm JOIN users u ON tm.user_id = u.id
          ORDER BY tm.latest DESC
        `).all(...threadIds).forEach(p => {
          const info = threadMap.get(p.thread_id);
          if (info && info.participants.length < 5) {
            info.participants.push({ username: p.username, avatar: p.avatar });
          }
        });
      }
    }

    // Which reply this account last saw in each topic, for the unread dot on
    // forum cards (#5641).
    const threadReadMap = new Map();
    if (channel.is_forum && msgIds.length > 0) {
      const rph = msgIds.map(() => '?').join(',');
      db.prepare(`SELECT thread_id, last_read_reply_id FROM thread_reads WHERE user_id = ? AND thread_id IN (${rph})`)
        .all(socket.user.id, ...msgIds)
        .forEach(r => threadReadMap.set(r.thread_id, r.last_read_reply_id));
    }
    // Likes and dislikes on forum topics, with this reader's own vote (#5742).
    const topicVotes = channel.is_forum ? votesFor(db, socket.user.id, msgIds) : null;
    // Blog mode: each card counts only the comments, not the author's own
    // follow-ups (#5742).
    const blogComments = channel.is_forum && Number(channel.forum_blog) === 1 ? forumBlog.commentCounts(db, msgIds) : null;

    const enriched = messages.map(m => {
      const obj = { ...m };
      // Border fit travels with the message (like avatar) so it renders even when
      // the author is offline. Parse the stored JSON into the op array the client folds.
      obj.borderTransform = parseBorderTransform(m.border_transform);
      delete obj.border_transform;
      // Animation policy travels with the message too (offline-safe, like the border).
      obj.animateProfile = m.animate_profile || 'trigger';
      delete obj.animate_profile;
      if (obj.created_at && !obj.created_at.endsWith('Z')) obj.created_at = utcStamp(obj.created_at);
      if (obj.edited_at && !obj.edited_at.endsWith('Z')) obj.edited_at = utcStamp(obj.edited_at);
      obj.replyContext = m.reply_to ? (replyMap.get(m.reply_to) || null) : null;
      obj.reactions = reactionMap.get(m.id) || [];
      if (roleMenuMap.has(m.id)) obj.roleMenu = roleMenuMap.get(m.id);
      obj.pinned = pinnedSet ? pinnedSet.has(m.id) : false;
      obj.is_archived = !!m.is_archived;
      obj.thread = threadMap.get(m.id) || null;
      // A forum topic is unread until you open it (your own topics start
      // read), and again whenever a reply lands after the last one you saw.
      if (channel.is_forum && !m.thread_id) {
        const tinfo = obj.thread || { count: 0, lastReplyAt: null, lastReplyId: 0, participants: [] };
        const lastId = tinfo.lastReplyId || 0;
        const seen = threadReadMap.get(m.id);
        tinfo.unread = seen !== undefined ? lastId > seen : (m.user_id !== socket.user.id || lastId > 0);
        if (blogComments) tinfo.comments = blogComments.get(m.id) || 0;
        obj.thread = tinfo;
        obj.votes = topicVotes.get(m.id) || { likes: 0, dislikes: 0, mine: 0 };
        delete obj.score;
      }
      if ('tags' in m) obj.tags = parseTags(m.tags);
      const atags = attachmentTagMap.get(m.id);
      if (atags && atags.length) obj.attachmentTags = atags;
      if ('closed' in m) obj.closed = !!m.closed;
      if ('nsfw' in m) obj.nsfw = !!m.nsfw;
      if (m.poll_data) {
        try {
          obj.poll = JSON.parse(m.poll_data);
          const votes = pollVoteMap.get(m.id) || [];
          obj.poll.votes = {};
          obj.poll.options.forEach((_, i) => { obj.poll.votes[i] = []; });
          votes.forEach(v => {
            if (!obj.poll.votes[v.option_index]) obj.poll.votes[v.option_index] = [];
            obj.poll.votes[v.option_index].push({ user_id: v.user_id, username: v.username });
          });
          obj.poll.totalVotes = votes.length;
        } catch (e) { /* invalid poll_data: send the message without its poll rather than drop it */ }
      }
      if (m.is_webhook) {
        obj.is_webhook = true;
        obj.username = `[BOT] ${m.webhook_username || 'Bot'}`;
        obj.avatar_shape = 'square';
        obj.avatar = m.webhook_avatar || webhookAvatarMap.get(m.webhook_username) || null;
        obj.border = null; obj.borderTransform = null; obj.animateProfile = 'trigger'; // bot identity, not the user's frame
      }
      if (m.imported_from) {
        obj.imported_from = m.imported_from;
        obj.username = m.webhook_username || 'Unknown';
        obj.border = null; obj.borderTransform = null; obj.animateProfile = 'trigger';
      }
      // ── Persona override (#86, #5349) ──
      // Persona display always wins over the real user's avatar/name
      // (it loses to webhook/imported because those represent different
      // message types entirely). The real_username field is preserved so
      // the client can show a "@real_username" hint to mods/owner.
      if (m.persona_id && !m.is_webhook && !m.imported_from) {
        obj.persona_id = m.persona_id;
        obj.persona_username = m.persona_username || null;
        obj.persona_avatar = m.persona_avatar || null;
        obj.real_username = m.real_username;
        obj.username = m.persona_username || m.real_username || obj.username;
        obj.avatar = m.persona_avatar || null;
        obj.avatar_shape = 'circle';
        obj.border = null; obj.borderTransform = null; obj.animateProfile = 'trigger'; // persona identity, not the user's frame
      }
      return obj;
    });

    // Include the user's last-read position so the client can show a
    // "NEW MESSAGES" divider between read and unread messages.
    const readPos = db.prepare(
      'SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?'
    ).get(socket.user.id, channel.id);
    const lastReadMessageId = readPos ? readPos.last_read_message_id : 0;

    socket.emit('message-history', {
      channelCode: code,
      messages: (after || around) ? enriched : enriched.reverse(),
      lastReadMessageId,
      pinnedCount: db.prepare('SELECT COUNT(*) as cnt FROM pinned_messages WHERE channel_id = ?').get(channel.id).cnt,
      ...(around ? { around } : {})
    });
  });

  // ── Search messages (global FTS5 across the user's channels) ─────────────
  // Global by default: scoped to every non-DM channel the user is a member of,
  // re-checked server-side on every query so results can never include content
  // they can't access. in:#channel narrows to one channel; from:/has: filter on
  // top. Paginated 25/page with a total count. DMs are searched client-side
  // (E2E), so they never reach here. (search-overhaul phase 2)
  const SEARCH_PAGE_SIZE = 25;
  socket.on('search-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    let query = typeof data.query === 'string' ? data.query.trim().slice(0, 300) : '';
    if (!query) return;

    // Per-account rate limit on the expensive FTS path. On trip we tell the
    // client to stop its spinner and keep the results it already has; the
    // toast text is rendered client-side for translation. (search-overhaul)
    if (floodCheck('search')) {
      return socket.emit('search-throttled', { token: data.token });
    }

    const tokenizer = getActiveTokenizer();
    const page = (Number.isInteger(data.page) && data.page > 0) ? data.page : 1;
    const sort = ['newest', 'oldest', 'relevant'].includes(data.sort) ? data.sort : 'newest';
    // Opaque token echoed back so the client can drop stale (out-of-order) responses.
    const token = data.token;

    // ── Parse filters out of the query text ──
    const filters = { from: null, in: null, has: null, pinned: null, before: null, after: null, during: null, tag: null };
    query = query.replace(/\bfrom:(\S+)/gi, (_, v) => { filters.from = v; return ''; });
    // tag: supports a quoted value so multi-word tags work (tags allow spaces);
    // the filter picker and clickable message tags append the quoted form.
    query = query.replace(/\btag:"([^"]+)"|\btag:(\S+)/gi, (_, quoted, bare) => { filters.tag = quoted || bare; return ''; });
    // A leading # means "this is a channel code" (unambiguous, what the filter
    // picker appends); without it, in: is treated as a channel name.
    query = query.replace(/\bin:(#?)(\S+)/gi, (_, hash, v) => { filters.in = v; filters.inIsCode = !!hash; return ''; });
    query = query.replace(/\bhas:(\S+)/gi, (_, v) => { filters.has = v.toLowerCase(); return ''; });
    query = query.replace(/\bpinned:(\S+)/gi, (_, v) => { filters.pinned = v.toLowerCase(); return ''; });
    query = query.replace(/\bbefore:(\S+)/gi, (_, v) => { filters.before = v; return ''; });
    query = query.replace(/\bafter:(\S+)/gi, (_, v) => { filters.after = v; return ''; });
    query = query.replace(/\bduring:(\S+)/gi, (_, v) => { filters.during = v; return ''; });
    query = query.trim();

    // Only keep well-formed YYYY-MM-DD dates; drop anything else silently.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    ['before', 'after', 'during'].forEach(k => { if (filters[k] && !DATE_RE.test(filters[k])) filters[k] = null; });

    const empty = { results: [], total: 0, page: 1, query: data.query, filters, token };
    const conditions = [];
    const params = [];

    // ── Free-text MATCH (tokenizer-aware; skipped when there's no text) ──
    let usesFts = false;
    if (query.length > 0) {
      if (query.length < minQueryChars(tokenizer)) return socket.emit('search-results', empty);
      const matchExpr = buildMatchQuery(query, tokenizer);
      if (matchExpr) { conditions.push('messages_fts MATCH ?'); params.push(matchExpr); usesFts = true; }
    }

    // Never dump the whole corpus: require free text or at least one filter.
    const anyFilter = filters.from || filters.has || filters.in || filters.pinned ||
                      filters.before || filters.after || filters.during || filters.tag;
    if (!usesFts && !anyFilter) {
      return socket.emit('search-results', empty);
    }

    // ── Access scope: non-DM channels the user belongs to ──
    if (filters.in) {
      // #code resolves by unique code (unambiguous); a bare name resolves by
      // name, which is not unique so it takes the first match.
      const target = filters.inIsCode
        ? db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(filters.in)
        : db.prepare('SELECT id FROM channels WHERE name = ? COLLATE NOCASE AND is_dm = 0').get(filters.in);
      if (!target) return socket.emit('search-results', empty);
      if (!hasChannelAccess(target.id)) return socket.emit('search-results', empty);
      conditions.push('m.channel_id = ?');
      params.push(target.id);
    } else {
      const reachable = db.prepare(`
        SELECT c.id, c.role_gate FROM channel_members cm
        JOIN channels c ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 0
      `).all(socket.user.id)
        .filter(ch => socket.user.isAdmin || ctx.roleGateAllows(socket.user.id, ch))
        .map(ch => ch.id);
      if (!reachable.length) return socket.emit('search-results', empty);
      conditions.push(`m.channel_id IN (${reachable.map(() => '?').join(',')})`);
      params.push(...reachable);
    }

    // ── from:username filter ──
    if (filters.from) {
      conditions.push('(u.username = ? COLLATE NOCASE OR u.display_name = ? COLLATE NOCASE)');
      params.push(filters.from, filters.from);
    }

    // ── has: filter (URL-pattern LIKE on content) ──
    if (filters.has) {
      switch (filters.has) {
        case 'image':
          conditions.push("(m.content LIKE '%/uploads/%.png%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.jpg%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.jpeg%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.gif%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.webp%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.svg%' ESCAPE '\\')");
          break;
        case 'file':
          conditions.push("m.content LIKE '%/uploads/%' ESCAPE '\\'");
          break;
        case 'link':
          conditions.push("(m.content LIKE '%http://%' ESCAPE '\\' OR m.content LIKE '%https://%' ESCAPE '\\')");
          break;
        case 'video':
          conditions.push("(m.content LIKE '%/uploads/%.mp4%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.webm%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.mov%' ESCAPE '\\' OR m.content LIKE '%youtube.com%' ESCAPE '\\' OR m.content LIKE '%youtu.be%' ESCAPE '\\')");
          break;
        case 'audio':
          conditions.push("(m.content LIKE '%/uploads/%.mp3%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.wav%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.ogg%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.m4a%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.flac%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.aac%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.opus%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.weba%' ESCAPE '\\')");
          break;
      }
    }

    // ── pinned: filter ──
    if (filters.pinned === 'true') {
      conditions.push('m.id IN (SELECT message_id FROM pinned_messages)');
    }

    // ── tag: filter (non-strict, case-folded PREFIX match on an attachment
    // tag) ── The value need not be a confirmed vocabulary tag; a typed prefix
    // like "do" matches "dog", so partial queries still surface results. A
    // message matches if any of its attachment tags starts with the value.
    if (filters.tag) {
      const norm = normalizeTagName(filters.tag);
      if (!norm) return socket.emit('search-results', empty);
      conditions.push("m.id IN (SELECT at.message_id FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id WHERE ut.name_norm LIKE ? ESCAPE '\\')");
      params.push(escapeLike(norm.norm) + '%');
    }

    // ── date filters (created_at). during: is the whole named day. ──
    if (filters.after)  { conditions.push('m.created_at >= ?'); params.push(filters.after); }
    if (filters.before) { conditions.push('m.created_at < ?');  params.push(filters.before); }
    if (filters.during) { conditions.push("m.created_at >= ? AND m.created_at < date(?, '+1 day')"); params.push(filters.during, filters.during); }

    // FTS queries join through messages_fts so bm25() is available for ranking.
    // Channels are joined so each result carries the channel it came from (the
    // results now span channels, and the client jumps into that channel).
    const fromSql = (usesFts
      ? 'messages_fts JOIN messages m ON m.id = messages_fts.rowid LEFT JOIN users u ON m.user_id = u.id'
      : 'messages m LEFT JOIN users u ON m.user_id = u.id')
      + ' LEFT JOIN channels c ON c.id = m.channel_id';
    const orderSql = sort === 'oldest' ? 'm.created_at ASC'
      : (sort === 'relevant' && usesFts) ? 'bm25(messages_fts)'
      : 'm.created_at DESC';
    const whereSql = conditions.join(' AND ');

    let results = [];
    let total = 0;
    try {
      total = db.prepare(`SELECT count(*) AS n FROM ${fromSql} WHERE ${whereSql}`).get(...params).n;
      results = db.prepare(`
        SELECT m.id, m.content, m.created_at,
               COALESCE(u.display_name, u.username, '[Deleted User]') AS username, u.id AS user_id,
               c.name AS channel_name, c.code AS channel_code
        FROM ${fromSql}
        WHERE ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ${SEARCH_PAGE_SIZE} OFFSET ?
      `).all(...params, (page - 1) * SEARCH_PAGE_SIZE);
    } catch (e) {
      console.warn('[search] query failed:', e.message);
      return socket.emit('search-results', empty);
    }

    results.forEach(r => {
      if (r.created_at && !r.created_at.endsWith('Z')) r.created_at = utcStamp(r.created_at);
    });

    // Thread reply counts for this page's results. A result is a thread parent
    // when other messages carry thread_id = its id. One grouped COUNT over the
    // 25 ids (same idiom as the channel loader) drives a display-only badge on
    // the client. (search-overhaul phase 3)
    const resultIds = results.map(r => r.id);
    if (resultIds.length) {
      const ph = resultIds.map(() => '?').join(',');
      const counts = db.prepare(
        `SELECT thread_id, COUNT(*) AS n FROM messages WHERE thread_id IN (${ph}) GROUP BY thread_id`
      ).all(...resultIds);
      const countMap = new Map(counts.map(c => [c.thread_id, c.n]));
      results.forEach(r => { r.thread_count = countMap.get(r.id) || 0; });

      // Attachment tags for this page, so results render the same Tags footer as
      // the channel view (and its chips are clickable). One deduped list per row.
      const tagMap = new Map();
      db.prepare(`
        SELECT at.message_id, ut.name
        FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id
        WHERE at.message_id IN (${ph}) ORDER BY ut.name_norm
      `).all(...resultIds).forEach(row => {
        if (!tagMap.has(row.message_id)) tagMap.set(row.message_id, []);
        const arr = tagMap.get(row.message_id);
        if (!arr.includes(row.name)) arr.push(row.name);
      });
      results.forEach(r => { const tg = tagMap.get(r.id); if (tg && tg.length) r.attachmentTags = tg; });
    }

    socket.emit('search-results', { results, total, page, query: data.query, filters, token });
  });

  // Tell the client the minimum query length for the active tokenizer (trigram
  // needs 3 chars; word tokenizers 2) so the input gate matches the server.
  socket.emit('search-config', { minChars: minQueryChars(), tokenizer: getActiveTokenizer() });

  // ── Channel media gallery (#5350) ───────────────────────
  // Returns categorized media + links from all messages in a channel.
  // Photos / videos / audio / files come from /uploads/ URLs and the
  // [file:name](/uploads/path) markdown wrapper. Links are http(s)://
  // URLs in message bodies that don't point at /uploads/.
  socket.on('get-channel-media', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = hasChannelAccess(channel.id);
    if (!member && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'Not a member of this channel');
    }

    // Pull every message in this channel that mentions /uploads/ or http(s)://
    // Cap at 5000 to avoid pathological loads on giant channels.
    const rows = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.original_name,
             m.persona_id, m.persona_username, m.persona_avatar,
             COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username,
             u.id as user_id
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
        AND m.thread_id IS NULL
        AND (m.content LIKE '%/uploads/%' ESCAPE '\\' OR m.content LIKE '%http://%' ESCAPE '\\' OR m.content LIKE '%https://%' ESCAPE '\\')
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 5000
    `).all(channel.id);

    const photos = [];
    const videos = [];
    const audios = [];
    const files  = [];
    const links  = [];

    const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:$|[?#|])/i;
    const VID_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv)(?:$|[?#|])/i;
    const AUD_EXT = /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)(?:$|[?#|])/i;

    // [file:Original Name](/uploads/...|size) markdown wrapper
    // File attachments use [file:name](url|size) format; capture url + size separately
    const fileLinkRe = /\[file:([^\]]+)\]\((\/uploads\/[^)|\s]+)(?:\|([^)]*))?\)/g;
    // bare /uploads/ URL (image markdown ![alt](/uploads/x) or plain path)
    const uploadRe   = /(?:!\[[^\]]*\]\(([^)\s]+)\)|(\/uploads\/[^\s)]+))/g;
    // http(s):// URLs (anywhere in content)
    const httpRe     = /(https?:\/\/[^\s<>"']+)/gi;

    // Resolve a /uploads/<name> path to a byte size by stat'ing the file on
    // disk. Memoized per request so a popular file isn't stat'd hundreds of
    // times. Returns 0 when the file is missing or path-traversal would
    // escape UPLOADS_DIR.
    const sizeCache = new Map();
    const safeName = /^[\w\-.]+$/;
    const sizeOf = (url) => {
      if (!url || !url.startsWith('/uploads/')) return 0;
      if (sizeCache.has(url)) return sizeCache.get(url);
      const name = url.slice('/uploads/'.length);
      if (!safeName.test(name)) { sizeCache.set(url, 0); return 0; }
      let s = 0;
      try {
        const full = path.join(UPLOADS_DIR, name);
        const st = fs.statSync(full);
        if (st && st.isFile()) s = st.size;
      } catch { /* missing or permission denied: counts as 0 bytes */ }
      sizeCache.set(url, s);
      return s;
    };

    for (const row of rows) {
      const ts = row.created_at && !row.created_at.endsWith('Z') ? utcStamp(row.created_at) : row.created_at;
      const seen = new Set(); // dedupe URLs within a single message
      const baseEntry = (url, name, sizeHint) => {
        let size = 0;
        if (typeof sizeHint === 'number' && sizeHint > 0) size = sizeHint;
        else if (typeof sizeHint === 'string' && /^\d+$/.test(sizeHint)) size = parseInt(sizeHint, 10);
        else size = sizeOf(url);
        return {
          message_id: row.id,
          url,
          name: name || row.original_name || url.split('/').pop(),
          size,
          created_at: ts,
          username: row.username,
          user_id: row.user_id,
        };
      };

      // 1) [file:name](url|size) wrappers
      let m;
      const content = row.content || '';
      while ((m = fileLinkRe.exec(content)) !== null) {
        const name = m[1];
        const url  = m[2];
        const sizeHint = m[3];
        if (seen.has(url)) continue;
        seen.add(url);
        const entry = baseEntry(url, name, sizeHint);
        if      (IMG_EXT.test(url)) photos.push(entry);
        else if (VID_EXT.test(url)) videos.push(entry);
        else if (AUD_EXT.test(url)) audios.push(entry);
        else                        files.push(entry);
      }
      fileLinkRe.lastIndex = 0;

      // 2) bare /uploads/ URLs / image markdown
      while ((m = uploadRe.exec(content)) !== null) {
        const rawUrl = m[1] || m[2];
        if (!rawUrl || !rawUrl.startsWith('/uploads/')) continue;
        // Strip trailing |size suffix that file attachments embed in the URL slot
        const url = rawUrl.replace(/\|[^)]*$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        const entry = baseEntry(url);
        if      (IMG_EXT.test(url)) photos.push(entry);
        else if (VID_EXT.test(url)) videos.push(entry);
        else if (AUD_EXT.test(url)) audios.push(entry);
        else                        files.push(entry);
      }
      uploadRe.lastIndex = 0;

      // 3) http(s):// links — exclude /uploads/ (already counted above as
      //    relative paths) and exclude raw image/video CDN links being
      //    used as inline media (those are covered by link-preview, but
      //    for the gallery we still treat them as 'link' to avoid noise).
      while ((m = httpRe.exec(content)) !== null) {
        const url = m[1].replace(/[)\].,!?]+$/, '');
        if (seen.has(url)) continue;
        // Skip same-origin /uploads (already captured)
        if (/\/uploads\//i.test(url)) continue;
        seen.add(url);
        links.push(baseEntry(url, url));
      }
      httpRe.lastIndex = 0;
    }

    // Attach upload tags to each media entry so the gallery can filter by tag
    // and show chips. Tags key on (message_id, rel_path); links have no backing
    // /uploads/ file so they never carry tags. One batched query for the page.
    const withUrls = [...photos, ...videos, ...audios, ...files];
    const mediaMsgIds = [...new Set(withUrls.map(e => e.message_id))];
    if (mediaMsgIds.length) {
      const ph = mediaMsgIds.map(() => '?').join(',');
      const tagRows = db.prepare(
        `SELECT at.message_id, at.rel_path, ut.name
           FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id
          WHERE at.message_id IN (${ph})
          ORDER BY ut.name_norm`
      ).all(...mediaMsgIds);
      const tagIndex = new Map();
      for (const r of tagRows) {
        const key = `${r.message_id}|${r.rel_path}`;
        if (!tagIndex.has(key)) tagIndex.set(key, []);
        tagIndex.get(key).push(r.name);
      }
      for (const e of withUrls) {
        const tags = tagIndex.get(`${e.message_id}|${e.url}`);
        if (tags && tags.length) e.tags = tags;
      }
    }

    socket.emit('channel-media', {
      channelCode: code,
      photos,
      videos,
      audios,
      files,
      links,
    });
  });

  // ── Channel thread list (#5506) ─────────────────────────
  // Every thread in the channel, newest activity first, so people can find a
  // conversation again without scrolling the channel back to where it started.
  socket.on('get-channel-threads', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = hasChannelAccess(channel.id);
    if (!member && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'Not a member of this channel');
    }

    // A thread is a message that has replies hanging off it, so the join is
    // what defines one: no replies, no thread, nothing to list. Capped like
    // the media gallery so a long-lived channel cannot produce an unbounded
    // payload. Ordered by last reply, because "which thread is alive" is the
    // question people open this to answer.
    const threads = db.prepare(`
      SELECT p.id,
             p.content,
             p.created_at,
             COALESCE(p.persona_username, p.webhook_username, u.display_name, u.username, '[Deleted User]') AS username,
             u.id AS user_id,
             COUNT(t.id) AS reply_count,
             MAX(t.created_at) AS last_reply_at
      FROM messages p
      JOIN messages t ON t.thread_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.channel_id = ? AND p.thread_id IS NULL
      GROUP BY p.id
      ORDER BY last_reply_at DESC, p.id DESC
      LIMIT 500
    `).all(channel.id);

    socket.emit('channel-threads', {
      channelCode: code,
      threads: threads.map(t => ({
        ...t,
        created_at: utcStamp(t.created_at),
        last_reply_at: utcStamp(t.last_reply_at),
      })),
    });
  });

  // ── Shared bulk message delete ──────────────────────────
  // Deletes many messages by id in one transaction using the same
  // permission rules as the single `delete-message` handler, moves their
  // attachments to deleted-attachments/, and broadcasts `message-deleted`
  // for each so other clients update. Shared by the Files & Media gallery
  // (delete-channel-media, #5375) and the multi-select toolbar Delete
  // (delete-messages, #5460) so both stay behaviourally identical.
  const bulkDeleteMessagesByIds = (data, cb) => {
    if (!data || typeof data !== 'object') return cb({ error: 'Bad request' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Bad channel' });

    const ids = Array.isArray(data.messageIds)
      ? Array.from(new Set(data.messageIds.filter(isInt))).slice(0, 500)
      : [];
    if (ids.length === 0) return cb({ error: 'No items selected' });

    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return cb({ error: 'Not a member' });

    const canDeleteAny  = socket.user.isAdmin || userHasPermission(socket.user.id, 'delete_message', channel.id);
    const canDeleteLowr = !canDeleteAny && userHasPermission(socket.user.id, 'delete_lower_messages', channel.id);
    const myLevel = (!canDeleteAny && canDeleteLowr) ? getUserEffectiveLevel(socket.user.id, channel.id) : 0;

    // Allow self-delete fallback only if the policy allows it. Mirrors
    // `delete-message`'s logic for own messages.
    let allowOwnDelete = true;
    if (!socket.user.isAdmin) {
      try {
        // (#5433) Channel-scoped override rows only apply in their channel.
        const chain = getChannelRoleChain(channel.id);
        const ph = chain.map(() => '?').join(',');
        const deny = db.prepare(
          `SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = 'delete_own_messages' AND (channel_id IS NULL OR channel_id IN (${ph})) ORDER BY allowed ASC LIMIT 1`
        ).get(socket.user.id, ...chain);
        if (deny && deny.allowed === 0) allowOwnDelete = false;
      } catch (err) {
        // Could not rule out a deny override, so fail closed.
        allowOwnDelete = false;
        console.error('bulk delete: delete_own_messages check failed:', err.message);
      }
    }

    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, user_id, content FROM messages WHERE channel_id = ? AND id IN (${placeholders})`
    ).all(channel.id, ...ids);

    const deletable = [];
    const skipped = [];
    for (const r of rows) {
      let ok = false;
      if (r.user_id === socket.user.id) {
        ok = allowOwnDelete;
      } else if (canDeleteAny) {
        ok = true;
      } else if (canDeleteLowr) {
        const targetLevel = getUserEffectiveLevel(r.user_id, channel.id);
        ok = myLevel > targetLevel;
      }
      if (ok) deletable.push(r);
      else    skipped.push(r.id);
    }

    if (deletable.length === 0) {
      return cb({ error: 'You don\'t have permission to delete the selected items', deleted: 0, skipped: skipped.length });
    }

    const delPin = db.prepare('DELETE FROM pinned_messages WHERE message_id = ?');
    const delRx  = db.prepare('DELETE FROM reactions WHERE message_id = ?');
    const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    const purge = db.transaction(() => {
      for (const r of deletable) {
        delPin.run(r.id);
        delRx.run(r.id);
        delMsg.run(r.id);
      }
    });
    try { purge(); } catch (err) {
      console.error('Bulk media delete error:', err);
      return cb({ error: 'Failed to delete items', detail: err && err.message });
    }

    // Move attachment files to deleted-attachments/ for each deleted message,
    // but only each author's own attachments (releasableUploads).
    const uploadRe = UPLOAD_PATH_RE;
    for (const r of deletable) {
      const toRelease = [];
      uploadRe.lastIndex = 0;
      let m;
      while ((m = uploadRe.exec(r.content || '')) !== null) toRelease.push(m[1]);
      // For E2E DMs the content is ciphertext; honor client-supplied URLs
      // the same way `delete-message` does. (`data.attachmentsByMessage`
      // is an object map { [messageId]: [url, url, ...] }.)
      if (channel.is_dm && data.attachmentsByMessage && typeof data.attachmentsByMessage === 'object') {
        const urls = data.attachmentsByMessage[r.id];
        if (Array.isArray(urls)) {
          for (const url of urls.slice(0, 50)) {
            if (typeof url !== 'string') continue;
            const match = url.match(UPLOAD_PATH_EXACT_RE);
            if (!match || !isSafeUploadRelPath(match[1])) continue;
            toRelease.push(match[1]);
          }
        }
      }
      for (const rel of releasableUploads(db, toRelease, [r.user_id])) moveUploadToDeleted(rel);
    }

    // Broadcast individual deletes so all clients' message lists, pin lists,
    // and open Files & Media views stay consistent.
    for (const r of deletable) {
      io.to(`channel:${code}`).emit('message-deleted', {
        channelCode: code,
        messageId: r.id
      });
    }

    cb({ success: true, deleted: deletable.length, skipped: skipped.length });
  };

  // ── Delete every message you wrote (#5686) ────────────────
  // For someone leaving a server for good. Off unless an admin turned on
  // "Members can delete all their own messages" under Members; that switch is
  // the permission, so the per-role delete-own-messages rule does not apply.
  // Messages a moderator protected stay, the same as the account deletion's
  // scrub. Deleting a message takes its thread along, as a single delete does.
  socket.on('self-purge-messages', async (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const uid = socket.user.id;
    const allowRow = db.prepare("SELECT value FROM server_settings WHERE key = 'allow_self_purge'").get();
    if (!allowRow || allowRow.value !== 'true') return cb({ error: 'This server does not allow deleting all your messages at once' });
    if (socket.user.isGuest) return cb({ error: 'Guest accounts cannot do this' });

    const password = typeof data.password === 'string' ? data.password : '';
    if (!password) return cb({ error: 'Password is required' });
    const userRow = db.prepare('SELECT password_hash, COALESCE(display_name, username) AS username FROM users WHERE id = ?').get(uid);
    if (!userRow) return cb({ error: 'User not found' });
    try {
      if (!(await bcrypt.compare(password, userRow.password_hash))) return cb({ error: 'Incorrect password' });
    } catch (err) {
      console.error('Self-purge password verification error:', err);
      return cb({ error: 'Password verification failed' });
    }

    if (!state.selfPurgeInFlight) state.selfPurgeInFlight = new Set();
    if (state.selfPurgeInFlight.has(uid)) return cb({ error: 'Already deleting, give it a moment' });
    state.selfPurgeInFlight.add(uid);
    try {
      const rows = db.prepare(`
        SELECT m.id, m.content, c.code, c.is_dm
        FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE m.user_id = ? AND m.is_archived = 0
      `).all(uid);
      const kept = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND is_archived = 1').get(uid).n;
      if (!rows.length) return cb({ success: true, deleted: 0, kept });

      // Reactions, votes, tags and thread replies follow through the foreign
      // keys; pins are cleared by hand, the way the bulk delete does it.
      const delPin = db.prepare('DELETE FROM pinned_messages WHERE message_id = ?');
      const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
      db.transaction(() => {
        for (const r of rows) { delPin.run(r.id); delMsg.run(r.id); }
      })();

      const toRelease = [];
      for (const r of rows) {
        UPLOAD_PATH_RE.lastIndex = 0;
        let m;
        while ((m = UPLOAD_PATH_RE.exec(r.content || '')) !== null) toRelease.push(m[1]);
      }
      for (const rel of releasableUploads(db, toRelease, [uid])) moveUploadToDeleted(rel);

      // One event per channel rather than one per message: a person with
      // years of history would otherwise send thousands of events to every
      // open client. The client drops that author's rows and reloads the
      // channel it has open.
      const codes = new Set(rows.map(r => r.code));
      for (const code of codes) {
        io.to(`channel:${code}`).emit('messages-purged', { channelCode: code, userId: uid });
      }
      logAudit({ actor: socket.user, action: 'self_purge_messages',
        target_type: 'user', target_id: uid, target_name: userRow.username,
        details: { deleted: rows.length, kept, channels: codes.size } });
      console.log(`🗑️  ${userRow.username} (id: ${uid}) deleted all their messages: ${rows.length} removed, ${kept} protected kept`);
      cb({ success: true, deleted: rows.length, kept });
    } catch (err) {
      console.error('Self-purge error:', err);
      cb({ error: 'Failed to delete messages' });
    } finally {
      state.selfPurgeInFlight.delete(uid);
    }
  });

  // ── Bulk delete from media gallery (#5375) ──────────────
  socket.on('delete-channel-media', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    bulkDeleteMessagesByIds(data, cb);
  });

  // ── Bulk delete from the multi-select toolbar (#5460) ────
  // Piggybacks the "Select messages" move selector: a mod picks messages and
  // hits Delete instead of "Move to". Per-message permission is enforced in
  // the shared helper, so a lower mod can only remove what they could already
  // delete one at a time.
  socket.on('delete-messages', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    bulkDeleteMessagesByIds(data, cb);
  });

  // ── Send message ────────────────────────────────────────
  socket.on('send-message', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    let content = typeof data.content === 'string' ? data.content : '';

    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    if (!content || content.trim().length === 0) return;
    const _maxCharsRow = db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get();
    const _maxChars = parseInt(_maxCharsRow?.value) || 2000;
    // Nothing could be this long; the exact check waits for the channel.
    if (content.length > encryptedDmCap(_maxChars)) {
      return socket.emit('error-msg', `Message too long (max ${_maxChars} characters)`);
    }

    touchVoiceActivity(socket.user.id);

    if (floodCheck('message')) {
      return socket.emit('error-msg', 'Slow down, you\'re sending messages too fast');
    }

    const channel = db.prepare('SELECT id, name, slow_mode_interval, text_enabled, voice_enabled, media_enabled, read_only, is_dm, is_group, is_self_dm, is_forum, forum_tags, role_gate FROM channels WHERE code = ?').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found. Try switching channels and back');
    if (channel.is_group && !isGroupEnvelope(content)) return socket.emit('error-msg', 'Group messages must be end-to-end encrypted. Update Haven to send here.');
    if (content.length > contentCap(_maxChars, channel, content)) {
      return socket.emit('error-msg', `Message too long (max ${_maxChars} characters)`);
    }

    // A moderation mute covers the server's channels, not private messages:
    // a muted person can still DM, which is also how they reach a mod about
    // the mute (#5640).
    if (!channel.is_dm) {
      const sendMute = activeMuteNotice(socket.user.id);
      if (sendMute) return socket.emit('error-msg', sendMute);
    }

    // Forum topics carry a title and a pick of the channel's tags. Both are
    // ignored outside forum channels so a stale client cannot tag chat.
    let topicTitle = null;
    let topicTags = null;
    let topicNsfw = 0;
    if (channel.is_forum) {
      if (typeof data.title === 'string' && data.title.trim()) topicTitle = sanitizeText(data.title.trim().replace(/\s+/g, ' ').slice(0, 120)) || null;
      if (topicTitle && enforceAutomod(topicTitle, { surface: channel.is_dm ? 'dm' : 'message', channelId: channel.id })) return;
      // The poster can mark the topic NSFW (#5633).
      if (data.nsfw === true) topicNsfw = 1;
      const allowed = new Set(parseChannelTags(channel.forum_tags).map(t => t.name));
      if (Array.isArray(data.tags)) {
        const picked = [...new Set(data.tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => allowed.has(t)))].slice(0, 5);
        if (picked.length) topicTags = JSON.stringify(picked);
      }
    }

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member) return socket.emit('error-msg', 'Not a member of this channel');
    if (!socket.user.isAdmin && !ctx.roleGateAllows(socket.user.id, channel)) return socket.emit('error-msg', 'This channel needs a role you do not hold');

    // New accounts wait before posting (#5742): messages, forum topics,
    // attachments and DMs alike. A DM with yourself is notes, not a post.
    if (!channel.is_self_dm && refuseYoungAccount(channel.id)) return;

    // ── Auto-mod link policy (v3.42.0) ────────────────────
    // Runs before the message is persisted or broadcast. A blocked message
    // never reaches another client, which is the only way to stop the passive
    // IP leak from inline images and link-preview og:image fetches.
    if (enforceAutomod(content, { surface: channel.is_dm ? 'dm' : 'message', channelId: channel.id, markdown: true })) return;

    if (channel.read_only === 1 && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'read_only_override', channel.id)) {
      return socket.emit('error-msg', 'This channel is read-only');
    }

    // Strip @everyone / @here from senders who lack mention_everyone, so
    // unauthorized users can't trigger an everyone-mention notification.
    // We replace the trigger with a zero-width-joined form so the visible
    // text is preserved but the client-side mention regex no longer matches.
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'mention_everyone', channel.id)) {
      const stripped = content.replace(/(?<![\w@])@(everyone|here)\b/gi, '@\u200B$1');
      if (stripped !== content) content = stripped;
      // @Role pings fan out the same way, so they sit behind the same permission. (#5579)
      const roleNames = db.prepare('SELECT name FROM roles').all().map(r => r.name);
      const roleStripped = stripRoleMentions(content, roleNames);
      if (roleStripped !== content) content = roleStripped;
    }

    if (channel.text_enabled === 0) {
      const isMedia = /^(?:spoiler-img:)?\/uploads\b/i.test(content.trim()) || /^\[file:[^\]]+\]\(/i.test(content.trim());
      if (!isMedia || channel.media_enabled === 0) {
        return socket.emit('error-msg', 'Text messages are disabled in this channel');
      }
    }

    if (channel.media_enabled === 0 && !socket.user.isAdmin) {
      const isMediaContent = /^(?:spoiler-img:)?\/uploads\b/i.test(content.trim()) || /^\[file:[^\]]+\]\(/i.test(content.trim());
      if (isMediaContent) {
        return socket.emit('error-msg', 'Media uploads are disabled in this channel');
      }
    }

    // Bundled media: images/files attached alongside a text message are sent
    // as a separate socket event by the client. They've already consumed one
    // slow-mode slot (via the text message). Skip the check so the media
    // arrives with its parent message instead of being blocked. (#5342)
    // The flag comes from the client, so it only counts for an attachment
    // (optionally after a persona prefix) that follows the sender's own
    // counted message within a minute; set on anything, it skipped slow mode.
    const _trimmed = String(content || '').trim();
    const _mediaOnly = /^(?:::\S+\s+)?(?:spoiler-img:)?\/uploads\/\S+$/i.test(_trimmed) ||
      /^(?:::\S+\s+)?\[file:[^\]]+\]\(\/uploads\//i.test(_trimmed) || (channel.is_dm && data.encrypted === true);
    const _lastCounted = slowModeTracker.get(`slow:${socket.user.id}:${channel.id}`) || 0;
    const _bundledOk = data.bundled === true && _mediaOnly && Date.now() - _lastCounted < 60000;
    if (channel.slow_mode_interval > 0 && !socket.user.isAdmin && getUserEffectiveLevel(socket.user.id, channel.id) < 25 && !_bundledOk) {
      const slowKey = `slow:${socket.user.id}:${channel.id}`;
      const now = Date.now();
      const lastSent = slowModeTracker.get(slowKey) || 0;
      const waitMs = channel.slow_mode_interval * 1000;
      if (now - lastSent < waitMs) {
        const remaining = Math.ceil((waitMs - (now - lastSent)) / 1000);
        return socket.emit('error-msg', `Slow mode: wait ${remaining}s before sending another message`);
      }
      slowModeTracker.set(slowKey, now);
    }

    // ── /break prefix (#5393) ─────────────────────────────
    // User-controlled override: prefixing a message with "/break " (or
    // "/break\n") forces the renderer to start a new visual message group
    // instead of compacting under the previous message. Strip the prefix
    // before any further processing so it never reaches storage or echo.
    let breakChain = 0;
    {
      const breakMatch = content.match(/^\s*\/break(?:\s+|\n)([\s\S]+)$/);
      if (breakMatch) {
        content = breakMatch[1];
        breakChain = 1;
      }
    }

    // Self-destructing messages (src/selfDestruct.js). Channels only: DMs
    // have burn-after-read instead.
    const destructAt = channel.is_dm ? null : selfDestruct.destructAtFromSeconds(data.destructSeconds);
    // Who may send them is a role permission (send_self_destruct).
    if (destructAt && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'send_self_destruct', channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to send self-destructing messages');
    }
    // A message that deletes itself is its sender deleting it, so someone
    // denied delete_own_messages cannot send one. Refused rather than sent
    // as a normal message, which the sender did not ask for; fails closed.
    if (destructAt && !socket.user.isAdmin) {
      try {
        const chain = getChannelRoleChain(channel.id);
        const ph = chain.map(() => '?').join(',');
        const deny = db.prepare(
          `SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = 'delete_own_messages' AND (channel_id IS NULL OR channel_id IN (${ph})) ORDER BY allowed ASC LIMIT 1`
        ).get(socket.user.id, ...chain);
        if (deny && deny.allowed === 0) {
          return socket.emit('error-msg', 'You don\'t have permission to send self-destructing messages');
        }
      } catch (err) {
        console.error('send-message: delete_own_messages check failed:', err.message);
        return socket.emit('error-msg', 'Failed to send message');
      }
    }

    const trimmed = content.trim();
    const isImage = data.isImage === true;
    const isUpload = /^\/uploads\b/i.test(trimmed);
    const isPath = trimmed.startsWith('/') && trimmed.indexOf('/', 1) !== -1;
    const slashMatch = (!isImage && !isUpload && !isPath) ? trimmed.match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/) : null;
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const arg = (slashMatch[2] || '').trim();
      const slashResult = processSlashCommand(cmd, arg, socket.user.displayName, channel.id, code);
      if (slashResult && slashResult.botCommand) {
        // Bot command fired — bot will respond via webhook endpoint
        return;
      }
      if (slashResult) {
        const finalContent = slashResult.content;

        const result = db.prepare(
          'INSERT INTO messages (channel_id, user_id, content, reply_to, break_chain, destruct_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(channel.id, socket.user.id, finalContent, null, breakChain, destructAt);
        if (destructAt) selfDestruct.schedule(destructAt);

        const message = {
          id: result.lastInsertRowid,
          content: finalContent,
          created_at: new Date().toISOString(),
          username: socket.user.displayName,
          user_id: socket.user.id,
          avatar: socket.user.avatar || null,
          avatar_shape: socket.user.avatar_shape || 'circle',
          border: socket.user.border || null,
          borderTransform: socket.user.borderTransform || null,
          animateProfile: socket.user.animate_profile || 'trigger',
          reply_to: null,
          replyContext: null,
          reactions: [],
          edited_at: null,
          thread: null,
          break_chain: breakChain || undefined,
          destruct_at: destructAt || undefined
        };
        if (slashResult.tts) message.tts = true;

        io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
        sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName,
          destructAt ? '🔥 Sent a self-destructing message' : slashResult.content);
        fireWebhookCallbacks(channel.id, code, message);

        try {
          db.prepare(`
            INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
          `).run(socket.user.id, channel.id, result.lastInsertRowid);
        } catch (e) { /* only the sender's own unread marker; it catches up on their next read */ }
        return;
      }
    }

    let replyTo = isInt(data.replyTo) ? data.replyTo : null;
    const safeContent = sanitizeText(content.trim());
    if (!safeContent) return;

    // Validate replyTo belongs to same channel (prevents cross-channel data leaks).
    // A self destructing message takes no replies, so nothing outlives it.
    if (replyTo) {
      const replyMsg = db.prepare('SELECT channel_id, destruct_at FROM messages WHERE id = ?').get(replyTo);
      if (!replyMsg || replyMsg.channel_id !== channel.id || replyMsg.destruct_at) replyTo = null;
    }

    // (#5280) burn-after-read for DMs — capped at 5 minutes; only honored
    // for is_dm channels (the issue scopes burn to direct messages only).
    let burnSeconds = 0;
    if (channel.is_dm) {
      const reqBurn = parseInt(data && data.burnSeconds);
      if (Number.isFinite(reqBurn) && reqBurn >= 1 && reqBurn <= 300) burnSeconds = reqBurn;
    }

    // ── Persona detection (#86, #5349) ────────────────────
    // Pattern: "::PersonaName actual message body"
    // The leading "::" is a deliberate, unambiguous trigger that does not
    // conflict with any markdown syntax. We iterate over the sender's own
    // personas (longest name first to handle prefix ambiguity) and do a
    // case-insensitive prefix match — this correctly handles persona names
    // that contain spaces, which a single regex with [^\s] cannot do.
    let personaId = null;
    let personaUsername = null;
    let personaAvatar = null;
    let finalContent = safeContent;
    if (safeContent.startsWith('::')) {
      const userPersonas = db.prepare(
        'SELECT id, name, avatar FROM user_personas WHERE user_id = ?'
      ).all(socket.user.id);
      // Sort longest name first to prefer the most specific match.
      userPersonas.sort((a, b) => b.name.length - a.name.length);
      const lower = safeContent.toLowerCase();
      for (const persona of userPersonas) {
        // Allow "::Name message" (space separator) or "::Name: message" (colon+space)
        const base = '::' + persona.name.toLowerCase();
        let body = null;
        if (lower.startsWith(base + ' ')) {
          body = safeContent.slice(base.length + 1).trim();
        } else if (lower.startsWith(base + ': ')) {
          body = safeContent.slice(base.length + 2).trim();
        } else if (lower.startsWith(base + ':') && safeContent.length > base.length + 1) {
          body = safeContent.slice(base.length + 1).trim();
        }
        if (body && body.length > 0) {
          personaId = persona.id;
          personaUsername = persona.name;
          personaAvatar = persona.avatar || null;
          finalContent = body;
          break;
        }
      }
    }

    // ── Ferry target (Discord bridge) ─────────────────────
    // Runs after persona detection so the two prefixes compose: "::Alter
    // =>Server#general hi" resolves the persona first and leaves the ferry
    // prefix for this step. The target is stripped from what Haven stores and
    // kept in ferry_target instead, so channel history reads as plain messages
    // with a small destination badge rather than raw routing syntax.
    let ferryTarget = null;
    let ferryLabel = null;
    if (!channel.is_dm) {
      ferryTarget = parseFerryTarget(channel.id, finalContent, data.ferryDiscordUserId);
      if (ferryTarget) {
        finalContent = ferryTarget.body;
        ferryLabel = ferryTarget.dm
          ? 'dm'
          : `${ferryTarget.link.guild_name || 'Discord'}#${ferryTarget.link.discord_channel_name || ''}`;
        // An addressed message with nothing after the target is a typo, not a
        // send. Bail before writing an empty row into channel history.
        if (!finalContent) return socket.emit('error-msg', 'Add a message after the Discord target');
      }
    }

    // Encrypted DM files (#5699): the server cannot read an encrypted message
    // to find the file it points at, so the sender names it. Only files this
    // sender uploaded count, so nobody can get someone else's file removed.
    let e2eFiles = null;
    if (channel.is_dm && data.encrypted === true && Array.isArray(data.files)) {
      const owns = db.prepare('SELECT 1 FROM upload_ownership WHERE rel_path = ? AND user_id = ?');
      e2eFiles = data.files.slice(0, 10)
        .map(f => (typeof f === 'string' ? UPLOAD_PATH_EXACT_RE.exec(f) : null))
        .map(m => (m ? m[1] : null))
        .filter(rel => rel && isSafeUploadRelPath(rel) && owns.get(rel, socket.user.id));
      e2eFiles = e2eFiles.length ? JSON.stringify([...new Set(e2eFiles)]) : null;
    }

    try {
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, reply_to, burn_seconds, persona_id, persona_username, persona_avatar, break_chain, ferry_target, title, tags, nsfw, e2e_files, destruct_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, finalContent, replyTo, burnSeconds, personaId, personaUsername, personaAvatar, breakChain, ferryLabel, topicTitle, topicTags, topicNsfw, e2eFiles, destructAt);
      if (destructAt) selfDestruct.schedule(destructAt);

      // Attachment tags (#tagging): the composer sends `attachmentTags` alongside
      // an upload's URL. Global vocabulary, applied to the file this message
      // carries. Not on E2E DMs (server never sees their plaintext). Minting a
      // new tag needs manage_tags; applying an existing one is open to uploaders.
      // Tagging is non-critical — a failure here never sinks the message.
      let appliedTags = [];
      if (!channel.is_dm && Array.isArray(data.attachmentTags) && data.attachmentTags.length) {
        try {
          const canCreate = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_tags', null);
          const { maxTags, maxLen } = effectiveLimits(db);
          appliedTags = applyTagsToMessage(db, {
            messageId: result.lastInsertRowid,
            content: finalContent,
            tagNames: data.attachmentTags,
            userId: socket.user.id,
            canCreate,
            maxTags,
            maxLen,
          }) || [];
        } catch (e) {
          // Tags are best-effort and never sink the message, but the tags the
          // uploader picked were dropped.
          console.warn('send-message attachment tagging failed:', e.message);
        }
      }

      const message = {
        id: result.lastInsertRowid,
        content: finalContent,
        title: topicTitle || undefined,
        tags: topicTags ? JSON.parse(topicTags) : undefined,
        nsfw: topicNsfw ? true : undefined,
        created_at: new Date().toISOString(),
        username: personaUsername || socket.user.displayName,
        user_id: socket.user.id,
        avatar: personaAvatar || socket.user.avatar || null,
        avatar_shape: personaId ? 'circle' : (socket.user.avatar_shape || 'circle'),
        border: personaId ? null : (socket.user.border || null),
        borderTransform: personaId ? null : (socket.user.borderTransform || null),
        animateProfile: personaId ? 'trigger' : (socket.user.animate_profile || 'trigger'),
        reply_to: replyTo,
        replyContext: null,
        reactions: [],
        edited_at: null,
        thread: null,
        burn_seconds: burnSeconds || undefined,
        destruct_at: destructAt || undefined,
        persona_id: personaId || undefined,
        persona_username: personaUsername || undefined,
        persona_avatar: personaAvatar || undefined,
        real_username: personaId ? socket.user.displayName : undefined,
        break_chain: breakChain || undefined,
        ferry_target: ferryLabel || undefined,
        attachmentTags: appliedTags.length ? appliedTags : undefined,
      };

      if (replyTo) {
        message.replyContext = toReplyContext(db.prepare(`${REPLY_CONTEXT_SELECT}
          WHERE m.id = ? AND m.channel_id = ?
        `).get(replyTo, channel.id));
      }

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
      // Burn messages must not reveal their content in push notifications —
      // the whole point is that the recipient has to actively reveal them.
      // A self-destructing message is kept out of push for the same reason: a
      // notification outlives the message on the phone.
      const pushContent = burnSeconds > 0 ? '🔥 Sent a burn message'
        : destructAt ? '🔥 Sent a self-destructing message' : finalContent;
      const pushDisplayName = personaUsername || socket.user.displayName;
      sendPushNotifications(channel.id, code, channel.name, socket.user.id, pushDisplayName, pushContent);
      fireWebhookCallbacks(channel.id, code, message);

      // Deliberately after the broadcast: the Haven message is already sent and
      // stored, so a slow or broken Discord never holds up the channel. A
      // self-destructing message is not bridged: its Discord copy would stay.
      if (!channel.is_dm && !destructAt) {
        ferryRelay({
          channelId: channel.id,
          user: socket.user,
          body: finalContent,
          target: ferryTarget,
          personaUsername, personaAvatar,
          notify: (msg) => socket.emit('error-msg', msg),
          // Every top-level message in a forum is a topic, and goes to a
          // paired Discord forum as a new post.
          topic: channel.is_forum
            ? { id: result.lastInsertRowid, title: topicTitle, tags: topicTags ? JSON.parse(topicTags) : [], nsfw: !!topicNsfw }
            : null,
        });
      }

      try {
        db.prepare(`
          INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
        `).run(socket.user.id, channel.id, result.lastInsertRowid);
      } catch (e) { /* only the sender's own unread marker; it catches up on their next read */ }
    } catch (err) {
      console.error('send-message error:', err.message);
      socket.emit('error-msg', 'Failed to send message. Please try again');
    }
  });

  // ── Retroactively edit an attachment's tags (#tagging phase 3) ──────────────
  // Replace the full tag set on a message that carries an upload. Editing your
  // own message is always allowed; editing someone else's needs manage_tags.
  // Minting a NEW tag needs manage_tags either way (same rule as the composer).
  // Applying an existing tag to your own message is open. Broadcast so every
  // viewer's Tags footer updates live. Not for DMs (E2E; server has no plaintext).
  socket.on('set-message-tags', (data) => {
    if (!data || typeof data !== 'object' || !isInt(data.messageId)) return;
    if (!Array.isArray(data.tags)) return;
    if (floodCheck('tagEdit')) return socket.emit('error-msg', 'Slow down a moment');

    const msg = db.prepare('SELECT id, channel_id, user_id, content FROM messages WHERE id = ?').get(data.messageId);
    if (!msg) return socket.emit('error-msg', 'Message not found');
    if (!extractUploadPath(msg.content)) return socket.emit('error-msg', 'That message has no attachment to tag');

    const channel = db.prepare('SELECT id, code, is_dm FROM channels WHERE id = ?').get(msg.channel_id);
    if (!channel || channel.is_dm) return;   // DMs are E2E; no server-side tags

    const isAdmin = socket.user.isAdmin;
    const member = hasChannelAccess(channel.id);
    if (!member && !isAdmin) return socket.emit('error-msg', 'Not a member of this channel');

    const isOwn = msg.user_id === socket.user.id;
    const canManage = isAdmin || userHasPermission(socket.user.id, 'manage_tags', channel.id);
    if (!isOwn && !canManage) return socket.emit('error-msg', 'You cannot edit tags on this message');

    try {
      const { maxTags, maxLen } = effectiveLimits(db);
      const applied = setMessageTags(db, {
        messageId: msg.id,
        content: msg.content,
        tagNames: data.tags,
        userId: socket.user.id,
        canCreate: canManage,   // creating a new tag always needs manage_tags
        maxTags,
        maxLen,
      });
      io.to(`channel:${channel.code}`).emit('message-tags-updated', {
        channelCode: channel.code,
        messageId: msg.id,
        tags: applied,
      });
    } catch (e) {
      console.error('set-message-tags error:', e.message);
      socket.emit('error-msg', 'Failed to update tags');
    }
  });

  // ── Bulk tag management from the media gallery (#tagging phase 3b) ───
  // Replace or append tags across many selected attachments in one action.
  // Gated to manage_tags (or admin) — the curation permission — which also
  // lets it mint new tags. Per message: replace clears then relinks (an empty
  // list wipes all tags); append is additive and deduped. Broadcasts
  // message-tags-updated per message so any open footers repaint live, and
  // returns each message's full resulting set so the gallery updates in place.
  socket.on('bulk-tag-messages', (data, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    if (!data || typeof data !== 'object') return ack({ error: 'Bad request' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return ack({ error: 'Bad channel' });
    const mode = data.mode === 'append' ? 'append' : (data.mode === 'replace' ? 'replace' : null);
    if (!mode) return ack({ error: 'Bad mode' });
    if (!Array.isArray(data.tags)) return ack({ error: 'Bad request' });
    const messageIds = Array.isArray(data.messageIds)
      ? Array.from(new Set(data.messageIds.filter(isInt))).slice(0, 500)
      : [];
    if (!messageIds.length) return ack({ error: 'No messages selected' });
    if (floodCheck('tagEdit')) return ack({ error: 'Slow down a moment' });

    // Appending nothing is a deliberate no-op (replacing with nothing clears).
    if (mode === 'append' && data.tags.length === 0) return ack({ ok: true, updated: 0, results: [] });

    const channel = db.prepare('SELECT id, code, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel) return ack({ error: 'Channel not found' });
    if (channel.is_dm) return ack({ error: 'Cannot tag in DMs' });

    const isAdmin = socket.user.isAdmin;
    const member = hasChannelAccess(channel.id);
    if (!member && !isAdmin) return ack({ error: 'Not a member of this channel' });

    const canManage = isAdmin || userHasPermission(socket.user.id, 'manage_tags', channel.id);
    if (!canManage) return ack({ error: 'You need the manage tags permission' });

    const readFull = db.prepare(
      `SELECT ut.name FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id
        WHERE at.message_id = ? ORDER BY ut.name_norm`
    );
    const results = [];
    const { maxTags, maxLen } = effectiveLimits(db);
    try {
      for (const id of messageIds) {
        const msg = db.prepare('SELECT id, content, channel_id FROM messages WHERE id = ?').get(id);
        if (!msg || msg.channel_id !== channel.id) continue;
        if (!extractUploadPath(msg.content)) continue;
        const args = { messageId: msg.id, content: msg.content, tagNames: data.tags, userId: socket.user.id, canCreate: true, maxTags, maxLen };
        if (mode === 'replace') setMessageTags(db, args);
        else applyTagsToMessage(db, args);
        // Read the full current set (append's return is only the new names).
        const full = readFull.all(msg.id).map(r => r.name);
        results.push({ messageId: msg.id, tags: full });
        io.to(`channel:${channel.code}`).emit('message-tags-updated', {
          channelCode: channel.code, messageId: msg.id, tags: full,
        });
      }
    } catch (e) {
      console.error('bulk-tag-messages error:', e.message);
      return ack({ error: 'Failed to update tags' });
    }
    ack({ ok: true, updated: results.length, results });
  });

  // ── Burn-after-read mark + sweep (#5280) ────────────────────
  // The recipient (or sender, but typically recipient) emits `mark-burning`
  // the first time the message is revealed. Server stamps
  // `burning_started_at` once and fans out `message-burning` so every
  // viewer can run a synced countdown. Subsequent emits for the same
  // message are no-ops. The actual delete fires from the periodic sweep
  // below, which also handles the "server restarted mid-timer" case
  // (sweep on next get-messages catches expired burns regardless).
  socket.on('mark-burning', (data) => {
    if (!data || typeof data !== 'object') return;
    const messageId = parseInt(data.messageId);
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!Number.isFinite(messageId) || !code) return;
    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel || !channel.is_dm) return;
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member) return;
    const msg = db.prepare('SELECT id, channel_id, burn_seconds, burning_started_at FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.channel_id !== channel.id) return;
    if (!msg.burn_seconds || msg.burn_seconds <= 0) return;
    if (msg.burning_started_at) return; // already burning — synced countdown is already live
    const startedAt = new Date().toISOString();
    db.prepare('UPDATE messages SET burning_started_at = ? WHERE id = ?').run(startedAt, messageId);
    io.to(`channel:${code}`).emit('message-burning', {
      channelCode: code,
      messageId,
      burnSeconds: msg.burn_seconds,
      burningStartedAt: startedAt
    });
  });

  // Periodic sweep: every 10 seconds, delete any burning message whose
  // timer is up. Emits `message-burned` so clients can replace the row
  // with a "[message burned]" placeholder. Uses datetime() arithmetic
  // so SQLite handles the timezone math.
  if (!global.__havenBurnSweep) {
    global.__havenBurnSweep = setInterval(() => {
      try {
        const expired = db.prepare(`
          SELECT m.id, m.channel_id, c.code AS channel_code
          FROM messages m
          JOIN channels c ON c.id = m.channel_id
          WHERE m.burn_seconds > 0
            AND m.burning_started_at IS NOT NULL
            AND datetime(m.burning_started_at, '+' || m.burn_seconds || ' seconds') <= datetime('now')
        `).all();
        for (const row of expired) {
          db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
          io.to(`channel:${row.channel_code}`).emit('message-burned', {
            channelCode: row.channel_code,
            messageId: row.id
          });
        }
      } catch (err) {
        console.error('[burn-sweep] error:', err.message);
      }
    }, 10000);
  }

  // ── Scheduled messages (#5638) ──────────────────────────
  // Held on the server, so they go out whether or not the sender is online.
  // Not for DMs: those are encrypted in the browser, and a message parked
  // here in plain text would defeat that.
  const SCHEDULE_MAX_DAYS = 30;
  const SCHEDULE_MAX_PENDING = 25;
  function parseSendAt(raw) {
    const ts = Date.parse(typeof raw === 'string' ? raw : '');
    if (!Number.isFinite(ts)) return null;
    if (ts < Date.now() + 15000 || ts > Date.now() + SCHEDULE_MAX_DAYS * 86400000) return null;
    return new Date(ts).toISOString();
  }
  function scheduledList(userId) {
    return db.prepare(`
      SELECT s.id, s.content, s.send_at, c.code AS channelCode, c.name AS channelName
      FROM scheduled_messages s JOIN channels c ON c.id = s.channel_id
      WHERE s.user_id = ? ORDER BY s.send_at ASC
    `).all(userId).map(r => ({ id: r.id, content: r.content, sendAt: r.send_at, channelCode: r.channelCode, channelName: r.channelName }));
  }
  function scheduleMaxChars() {
    return parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get()?.value) || 2000;
  }

  socket.on('schedule-message', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });
    if (!isString(data.content, 1, scheduleMaxChars())) return cb({ error: 'Nothing to send, or the message is too long' });
    const sendAt = parseSendAt(data.sendAt);
    if (!sendAt) return cb({ error: `Pick a time in the future, up to ${SCHEDULE_MAX_DAYS} days away` });
    const channel = db.prepare('SELECT id, is_dm, read_only, text_enabled FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });
    if (channel.is_dm) return cb({ error: 'Scheduled sends are not available in direct messages' });
    if (channel.text_enabled === 0) return cb({ error: 'Text messages are disabled in this channel' });
    if (!hasChannelAccess(channel.id)) return cb({ error: 'Not a member of this channel' });
    if (channel.read_only === 1 && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'read_only_override', channel.id)) return cb({ error: 'This channel is read-only' });
    const mute = activeMuteNotice(socket.user.id);
    if (mute) return cb({ error: mute });
    const wait = youngAccountWait(channel.id);
    if (wait) return cb({ error: wait.message, newAccountWait: wait.minutes });
    const content = sanitizeText(pingSafe(data.content.trim(), socket.user.id, channel.id));
    if (!content) return cb({ error: 'Nothing to send' });
    // The same checks a live send gets, at the moment it is queued.
    if (enforceAutomod(content, { surface: 'message', channelId: channel.id, markdown: true })) return cb({ error: 'That message was blocked' });
    const pending = db.prepare('SELECT COUNT(*) AS c FROM scheduled_messages WHERE user_id = ?').get(socket.user.id).c;
    if (pending >= SCHEDULE_MAX_PENDING) return cb({ error: `You already have ${SCHEDULE_MAX_PENDING} messages waiting to send` });
    try {
      const r = db.prepare('INSERT INTO scheduled_messages (user_id, channel_id, content, send_at) VALUES (?, ?, ?, ?)').run(socket.user.id, channel.id, content, sendAt);
      cb({ success: true, id: r.lastInsertRowid, sendAt, items: scheduledList(socket.user.id) });
    } catch (err) {
      console.error('schedule-message error:', err);
      cb({ error: 'Failed to schedule the message' });
    }
  });

  socket.on('get-scheduled-messages', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : (typeof data === 'function' ? data : () => {});
    try { cb({ items: scheduledList(socket.user.id) }); } catch { cb({ items: [] }); }
  });

  socket.on('update-scheduled-message', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object' || !isInt(data.id)) return cb({ error: 'Invalid request' });
    const row = db.prepare('SELECT id, channel_id FROM scheduled_messages WHERE id = ? AND user_id = ?').get(data.id, socket.user.id);
    if (!row) return cb({ error: 'That scheduled message is gone' });
    if (!isString(data.content, 1, scheduleMaxChars())) return cb({ error: 'Nothing to send, or the message is too long' });
    const sendAt = parseSendAt(data.sendAt);
    if (!sendAt) return cb({ error: `Pick a time in the future, up to ${SCHEDULE_MAX_DAYS} days away` });
    const content = sanitizeText(data.content.trim());
    if (!content) return cb({ error: 'Nothing to send' });
    if (enforceAutomod(content, { surface: 'edit', channelId: row.channel_id, markdown: true })) return cb({ error: 'That message was blocked' });
    db.prepare('UPDATE scheduled_messages SET content = ?, send_at = ? WHERE id = ?').run(content, sendAt, row.id);
    cb({ success: true, items: scheduledList(socket.user.id) });
  });

  socket.on('cancel-scheduled-message', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object' || !isInt(data.id)) return cb({ error: 'Invalid request' });
    db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?').run(data.id, socket.user.id);
    cb({ success: true, items: scheduledList(socket.user.id) });
  });

  // Every 15 seconds, post whatever has come due. Membership is checked
  // again at send time, so leaving a channel drops what was queued for it.
  if (!global.__havenScheduleSweep) {
    global.__havenScheduleSweep = setInterval(() => {
      let due = [];
      try {
        due = db.prepare(`
          SELECT s.id, s.user_id, s.channel_id, s.content, c.code, c.name AS channel_name
          FROM scheduled_messages s JOIN channels c ON c.id = s.channel_id
          WHERE s.send_at <= ? ORDER BY s.send_at ASC LIMIT 20
        `).all(new Date().toISOString());
      } catch (err) { console.error('[schedule-sweep] query error:', err.message); return; }
      for (const row of due) {
        try {
          db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(row.id);
          const author = db.prepare('SELECT id, username, display_name, avatar, avatar_shape, border, border_transform, animate_profile, is_admin FROM users WHERE id = ?').get(row.user_id);
          const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(row.channel_id, row.user_id);
          if (!author || !member) continue;
          // The rules at the moment it goes out, not when it was queued: a
          // ban or a mute since then, a channel gone read-only or text-off,
          // required roles lost, or mention_everyone taken away all count.
          if (db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(author.id)) continue;
          if (activeMuteNotice(author.id)) continue;
          const chNow = db.prepare('SELECT id, read_only, text_enabled, role_gate FROM channels WHERE id = ?').get(row.channel_id);
          if (!chNow || chNow.text_enabled === 0) continue;
          if (!author.is_admin && chNow.read_only === 1 && !userHasPermission(author.id, 'read_only_override', chNow.id)) continue;
          if (!author.is_admin && !ctx.roleGateAllows(author.id, chNow)) continue;
          const sendContent = pingSafe(row.content, author.id, chNow.id);
          const result = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(row.channel_id, row.user_id, sendContent);
          const message = {
            id: result.lastInsertRowid, content: sendContent, created_at: new Date().toISOString(),
            username: author.display_name || author.username, user_id: author.id,
            avatar: author.avatar || null, avatar_shape: author.avatar_shape || 'circle',
            border: author.border || null, borderTransform: parseBorderTransform(author.border_transform),
            animateProfile: author.animate_profile || 'trigger',
            reply_to: null, replyContext: null, reactions: [], edited_at: null, thread: null
          };
          io.to(`channel:${row.code}`).emit('new-message', { channelCode: row.code, message });
          sendPushNotifications(row.channel_id, row.code, row.channel_name, author.id, message.username, sendContent);
          fireWebhookCallbacks(row.channel_id, row.code, message);
          for (const [, s] of io.sockets.sockets) {
            if (s.user && s.user.id === author.id) s.emit('scheduled-message-sent', { id: row.id, channelCode: row.code, channelName: row.channel_name });
          }
        } catch (err) {
          console.error('[schedule-sweep] send error:', err.message);
        }
      }
    }, 15000);
  }

  // ── Typing indicator ────────────────────────────────────
  socket.on('typing', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (data.code !== socket.currentChannel) return;
    socket.to(`channel:${data.code}`).emit('user-typing', {
      channelCode: data.code,
      username: socket.user.displayName
    });
  });

  // ── Ping / latency measurement ──────────────────────────
  socket.on('ping-check', () => {
    socket.emit('pong-check');
  });

  // ── Edit message ────────────────────────────────────────
  function parseChannelTags(raw) {
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(t => t && typeof t.name === 'string') : []; } catch { return []; }
  }

  // Retitle or retag a forum topic. The author, or anyone who may manage
  // messages in the channel, may do it.
  socket.on('set-topic-meta', (data) => {
    if (!data || typeof data !== 'object' || !isInt(data.messageId)) return;
    const msg = db.prepare('SELECT m.id, m.user_id, m.channel_id, m.thread_id, c.code, c.is_forum, c.forum_tags FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?').get(data.messageId);
    if (!msg || !msg.is_forum || msg.thread_id) return socket.emit('error-msg', 'Not a forum topic');
    const mine = msg.user_id === socket.user.id;
    // There is no manage_messages permission, so this used to let nobody but
    // the author and admins in. delete_message is what moderators hold.
    if (!mine && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'delete_message', msg.channel_id)) {
      return socket.emit('error-msg', 'You don\'t have permission to edit this topic');
    }
    if (!socket.user.isAdmin && !hasChannelAccess(msg.channel_id)) return socket.emit('error-msg', 'Not a forum topic');
    // A title is shown like message text, so it gets the same cleaning and
    // the same automod check.
    const title = typeof data.title === 'string' ? sanitizeText(data.title.trim().replace(/\s+/g, ' ').slice(0, 120)) : null;
    if (title && enforceAutomod(title, { surface: 'edit', channelId: msg.channel_id })) return;
    const allowed = new Set(parseChannelTags(msg.forum_tags).map(t => t.name));
    const tags = Array.isArray(data.tags) ? [...new Set(data.tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => allowed.has(t)))].slice(0, 5) : [];
    // Closed is only changed when the editor sent it, so an older client that
    // edits the title leaves it alone (#5624).
    const closed = typeof data.closed === 'boolean' ? (data.closed ? 1 : 0) : null;
    // Same rule for the NSFW flag (#5633).
    const nsfw = typeof data.nsfw === 'boolean' ? (data.nsfw ? 1 : 0) : null;
    try {
      db.prepare('UPDATE messages SET title = ?, tags = ? WHERE id = ?').run(title || null, tags.length ? JSON.stringify(tags) : null, msg.id);
      if (closed !== null) db.prepare('UPDATE messages SET closed = ? WHERE id = ?').run(closed, msg.id);
      if (nsfw !== null) db.prepare('UPDATE messages SET nsfw = ? WHERE id = ?').run(nsfw, msg.id);
      const row = db.prepare('SELECT closed, nsfw FROM messages WHERE id = ?').get(msg.id) || {};
      const closedNow = closed !== null ? closed : (row.closed || 0);
      const nsfwNow = nsfw !== null ? nsfw : (row.nsfw || 0);
      io.to(`channel:${msg.code}`).emit('topic-updated', { channelCode: msg.code, messageId: msg.id, title: title || null, tags, closed: !!closedNow, nsfw: !!nsfwNow });
    } catch (err) {
      console.error('set-topic-meta error:', err);
      socket.emit('error-msg', 'Failed to update the topic');
    }
  });

  // "You are muted for N more minutes", or null when the user has no active
  // mute. Sends, edits and reactions in the server's channels all go through
  // it; DMs are exempt (#5640).
  function activeMuteNotice(userId) {
    const row = db.prepare(
      'SELECT expires_at FROM mutes WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    if (!row) return null;
    const remaining = Math.ceil((new Date(row.expires_at + 'Z') - Date.now()) / 60000);
    return `You are muted for ${remaining} more minute${remaining !== 1 ? 's' : ''}`;
  }

  socket.on('edit-message', (data) => {
    if (!data || typeof data !== 'object') return;
    const _editMaxRow = db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get();
    const _editMax = parseInt(_editMaxRow?.value) || 2000;
    if (!isInt(data.messageId) || !isString(data.content, 1, encryptedDmCap(_editMax))) return;

    // Accept an explicit channelCode from the client (e.g. DM PiP, where
    // socket.currentChannel is a different server channel). Fall back to
    // socket.currentChannel for backwards compatibility.
    const rawCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : null;
    const code = (rawCode && /^[a-f0-9]{8}$/i.test(rawCode)) ? rawCode : socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id, is_dm, is_group FROM channels WHERE code = ?').get(code);
    if (!channel) return;
    if (channel.is_group && !isGroupEnvelope(data.content)) return socket.emit('error-msg', 'Group messages must be end-to-end encrypted. Update Haven to send here.');
    if (data.content.length > contentCap(_editMax, channel, data.content)) {
      return socket.emit('error-msg', `Message too long (max ${_editMax} characters)`);
    }

    const msg = db.prepare(
      'SELECT id, user_id FROM messages WHERE id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!msg) return;

    if (msg.user_id !== socket.user.id) {
      return socket.emit('error-msg', 'You can only edit your own messages');
    }
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'edit_own_messages', channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to edit messages');
    }
    const editMute = channel.is_dm ? null : activeMuteNotice(socket.user.id);
    if (editMute) return socket.emit('error-msg', editMute);

    const newContent = sanitizeText(data.content.trim());
    if (!newContent) return;

    // Edits get the same link policy as sends. Without this the filter is
    // trivially bypassed: post something harmless, then edit the payload in.
    if (enforceAutomod(newContent, { surface: 'edit', channelId: channel.id, markdown: true })) return;

    if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(newContent)) {
      const origMsg = db.prepare('SELECT original_name FROM messages WHERE id = ?').get(data.messageId);
      if (!origMsg || !origMsg.original_name) {
        return socket.emit('error-msg', 'Cannot change a text message into an image');
      }
    }

    try {
      db.prepare(
        'UPDATE messages SET content = ?, edited_at = datetime(\'now\') WHERE id = ?'
      ).run(newContent, data.messageId);
    } catch (err) {
      console.error('Edit message error:', err);
      return socket.emit('error-msg', 'Failed to edit message');
    }

    io.to(`channel:${code}`).emit('message-edited', {
      channelCode: code,
      messageId: data.messageId,
      userId: socket.user.id,
      content: newContent,
      editedAt: new Date().toISOString()
    });
  });

  // ── Delete message ──────────────────────────────────────
  socket.on('delete-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    // Allow the PiP DM overlay (and similar cases where the socket is joined to
    // a different channel) to pass the target channel explicitly so the lookup
    // isn't blocked by socket.currentChannel pointing at a server channel.
    const rawCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : null;
    const code = (rawCode && /^[a-f0-9]{8}$/i.test(rawCode)) ? rawCode : socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel) return;
    // Deleting starts with being there. A DM belongs to its two people, so
    // only they can delete in it, whatever server-wide delete permission
    // someone else holds; anywhere else, a non-admin must be in the channel.
    const _inChannel = !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (channel.is_dm ? !_inChannel : (!_inChannel && !socket.user.isAdmin)) return;

    const msg = db.prepare(
      'SELECT id, user_id, content, destruct_at FROM messages WHERE id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!msg) return;

    if (msg.user_id === socket.user.id) {
      if (!socket.user.isAdmin) {
        try {
          // (#5433) Channel-scoped override rows only apply in their channel.
          const chain = getChannelRoleChain(channel.id);
          const ph = chain.map(() => '?').join(',');
          const deny = db.prepare(
            `SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = 'delete_own_messages' AND (channel_id IS NULL OR channel_id IN (${ph})) ORDER BY allowed ASC LIMIT 1`
          ).get(socket.user.id, ...chain);
          if (deny && deny.allowed === 0) {
            return socket.emit('error-msg', 'You don\'t have permission to delete messages');
          }
        } catch (err) {
          // Could not rule out a deny override, so fail closed.
          console.error('delete-message: delete_own_messages check failed:', err.message);
          return socket.emit('error-msg', 'Failed to delete message');
        }
      }
    } else {
      const canDeleteAny = socket.user.isAdmin || userHasPermission(socket.user.id, 'delete_message', channel.id);
      let canDeleteLower = false;
      if (!canDeleteAny && userHasPermission(socket.user.id, 'delete_lower_messages', channel.id)) {
        const myLevel = getUserEffectiveLevel(socket.user.id, channel.id);
        const targetLevel = getUserEffectiveLevel(msg.user_id, channel.id);
        canDeleteLower = myLevel > targetLevel;
      }
      if (!canDeleteAny && !canDeleteLower) {
        return socket.emit('error-msg', 'You can only delete your own messages');
      }
    }

    try {
      db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(data.messageId);
      db.prepare('DELETE FROM reactions WHERE message_id = ?').run(data.messageId);
      db.prepare('DELETE FROM messages WHERE id = ?').run(data.messageId);
    } catch (err) {
      console.error('Delete message error:', err);
      return socket.emit('error-msg', 'Failed to delete message');
    }
    // Deleted before its timer ran out: the self-destruct timer may have been
    // waiting for this one, so let it move on to the next, or sleep.
    if (msg.destruct_at) selfDestruct.forget(msg.destruct_at);

    const toRelease = [];
    const uploadRe = UPLOAD_PATH_RE;
    uploadRe.lastIndex = 0;
    let m;
    while ((m = uploadRe.exec(msg.content || '')) !== null) toRelease.push(m[1]);

    // For E2E DMs, the message content is encrypted ciphertext, so the
    // upload regex above can't find attachments. The client (which has the
    // decrypted content) passes the URLs in `data.attachments`. (#5299)
    // Either way, only the author's own attachments go (releasableUploads).
    if (channel.is_dm && Array.isArray(data.attachments)) {
      for (const url of data.attachments.slice(0, 50)) {
        if (typeof url !== 'string') continue;
        const match = url.match(UPLOAD_PATH_EXACT_RE);
        if (!match || !isSafeUploadRelPath(match[1])) continue;
        toRelease.push(match[1]);
      }
    }
    for (const rel of releasableUploads(db, toRelease, [msg.user_id])) moveUploadToDeleted(rel);

    io.to(`channel:${code}`).emit('message-deleted', {
      channelCode: code,
      messageId: data.messageId
    });
  });

  // ── Move messages ───────────────────────────────────────
  socket.on('move-messages', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    const messageIds = Array.isArray(data.messageIds) ? data.messageIds.filter(id => isInt(id)) : [];
    if (messageIds.length === 0 || messageIds.length > 200) return cb({ error: 'Select between 1 and 200 messages' });

    const fromCode = typeof data.fromChannel === 'string' ? data.fromChannel.trim() : '';
    const toCode   = typeof data.toChannel   === 'string' ? data.toChannel.trim()   : '';
    if (!fromCode || !toCode || fromCode === toCode) return cb({ error: 'Invalid channels' });
    if (!/^[a-f0-9]{8}$/i.test(fromCode) || !/^[a-f0-9]{8}$/i.test(toCode)) return cb({ error: 'Invalid channel codes' });

    const fromCh = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(fromCode);
    const toCh   = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(toCode);
    if (!fromCh || !toCh) return cb({ error: 'Channel not found' });
    if (fromCh.is_dm || toCh.is_dm) return cb({ error: 'Cannot move messages to or from DMs' });

    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'delete_message', fromCh.id)) {
      return cb({ error: 'You need message management permissions to move messages' });
    }
    // Moving is reading one channel and posting into another, so the mover
    // needs to be able to do both: access to each end, and the right to post
    // at the destination. A Channel Mod of their own channel could otherwise
    // push messages into #announcements or any channel whose code they knew,
    // and a Mod could pull a private channel's messages out into one they read.
    if (!socket.user.isAdmin) {
      if (!hasChannelAccess(fromCh.id) || !hasChannelAccess(toCh.id)) return cb({ error: 'Channel not found' });
      const dest = db.prepare('SELECT read_only, text_enabled FROM channels WHERE id = ?').get(toCh.id);
      if (dest && dest.text_enabled === 0) return cb({ error: 'Text messages are disabled in that channel' });
      if (dest && dest.read_only === 1 && !userHasPermission(socket.user.id, 'read_only_override', toCh.id)) {
        return cb({ error: 'That channel is read-only' });
      }
    }

    const placeholders = messageIds.map(() => '?').join(',');
    const count = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE id IN (${placeholders}) AND channel_id = ?`
    ).get(...messageIds, fromCh.id);
    if (!count || count.cnt !== messageIds.length) return cb({ error: 'Some messages were not found in the source channel' });

    try {
      db.prepare(
        `UPDATE messages SET channel_id = ? WHERE id IN (${placeholders}) AND channel_id = ?`
      ).run(toCh.id, ...messageIds, fromCh.id);

      db.prepare(
        `UPDATE pinned_messages SET channel_id = ? WHERE message_id IN (${placeholders}) AND channel_id = ?`
      ).run(toCh.id, ...messageIds, fromCh.id);
    } catch (err) {
      console.error('Move messages error:', err);
      return cb({ error: 'Failed to move messages' });
    }

    io.to(`channel:${fromCode}`).emit('messages-moved', {
      channelCode: fromCode,
      messageIds,
      toChannel: toCode
    });
    io.to(`channel:${toCode}`).emit('messages-received', {
      channelCode: toCode,
      fromChannel: fromCode,
      messageIds
    });

    cb({ success: true, moved: messageIds.length });
  });

  // ── Pin / Unpin message ─────────────────────────────────
  socket.on('pin-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const pinCode = socket.currentChannel;
    const pinCh = pinCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(pinCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'pin_message', pinCh ? pinCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to pin messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare(
      'SELECT id, destruct_at FROM messages WHERE id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!msg) return socket.emit('error-msg', 'Message not found');

    const existing = db.prepare(
      'SELECT id FROM pinned_messages WHERE message_id = ?'
    ).get(data.messageId);
    if (existing) return socket.emit('error-msg', 'Message is already pinned');

    const pinCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM pinned_messages WHERE channel_id = ?'
    ).get(channel.id);
    if (pinCount.cnt >= 50) {
      return socket.emit('error-msg', 'Channel has reached the 50-pin limit');
    }

    try {
      db.prepare(
        'INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)'
      ).run(data.messageId, channel.id, socket.user.id);
      // Pinning keeps a self-destructing message, as it keeps one from
      // auto-cleanup: the timer is dropped.
      if (msg.destruct_at) {
        db.prepare('UPDATE messages SET destruct_at = NULL WHERE id = ?').run(msg.id);
        selfDestruct.forget(msg.destruct_at);
      }
    } catch (err) {
      console.error('Pin message error:', err);
      return socket.emit('error-msg', 'Failed to pin message');
    }

    io.to(`channel:${code}`).emit('message-pinned', {
      channelCode: code,
      messageId: data.messageId,
      pinnedBy: socket.user.displayName
    });
  });

  socket.on('unpin-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const unpinCode = socket.currentChannel;
    const unpinCh = unpinCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(unpinCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'pin_message', unpinCh ? unpinCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to unpin messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const pin = db.prepare(
      'SELECT id FROM pinned_messages WHERE message_id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!pin) return socket.emit('error-msg', 'Message is not pinned');

    try {
      db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(data.messageId);
    } catch (err) {
      console.error('Unpin message error:', err);
      return socket.emit('error-msg', 'Failed to unpin message');
    }

    io.to(`channel:${code}`).emit('message-unpinned', {
      channelCode: code,
      messageId: data.messageId
    });
  });

  // ── Archive / Unarchive message ─────────────────────────
  socket.on('archive-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const archCode = socket.currentChannel;
    const archCh = archCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(archCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'archive_messages', archCh ? archCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to archive messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare('SELECT id, is_archived, destruct_at FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
    if (!msg) return socket.emit('error-msg', 'Message not found');
    if (msg.is_archived) return socket.emit('error-msg', 'Message is already archived');

    try {
      // A protected message is kept, self-destruct timer included, the
      // same as auto-cleanup and self-purge leave it alone.
      db.prepare('UPDATE messages SET is_archived = 1, destruct_at = NULL WHERE id = ?').run(data.messageId);
      if (msg.destruct_at) selfDestruct.forget(msg.destruct_at);
    } catch (err) {
      console.error('Archive message error:', err);
      return socket.emit('error-msg', 'Failed to archive message');
    }

    io.to(`channel:${code}`).emit('message-archived', {
      channelCode: code,
      messageId: data.messageId,
      archivedBy: socket.user.displayName
    });
  });

  socket.on('unarchive-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const unarchCode = socket.currentChannel;
    const unarchCh = unarchCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(unarchCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'archive_messages', unarchCh ? unarchCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to unarchive messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare('SELECT id, is_archived FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
    if (!msg) return socket.emit('error-msg', 'Message not found');
    if (!msg.is_archived) return socket.emit('error-msg', 'Message is not archived');

    try {
      db.prepare('UPDATE messages SET is_archived = 0 WHERE id = ?').run(data.messageId);
    } catch (err) {
      console.error('Unarchive message error:', err);
      return socket.emit('error-msg', 'Failed to unarchive message');
    }

    io.to(`channel:${code}`).emit('message-unarchived', {
      channelCode: code,
      messageId: data.messageId
    });
  });

  // ── Get pinned messages ─────────────────────────────────
  socket.on('get-pinned-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = hasChannelAccess(channel.id);
    if (!member) return;

    const pins = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar,
             COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id,
             pm.pinned_at, COALESCE(pb.display_name, pb.username, '[Deleted User]') as pinned_by
      FROM pinned_messages pm
      JOIN messages m ON pm.message_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN users pb ON pm.pinned_by = pb.id
      WHERE pm.channel_id = ?
      ORDER BY pm.pinned_at DESC
    `).all(channel.id);

    pins.forEach(p => {
      p.created_at = utcStamp(p.created_at);
      p.edited_at = utcStamp(p.edited_at);
      p.pinned_at = utcStamp(p.pinned_at);
      if (p.is_webhook) {
        p.username = `[BOT] ${p.webhook_username || 'Bot'}`;
      }
    });

    socket.emit('pinned-messages', { channelCode: code, pins });
  });

  // ── Reactions ───────────────────────────────────────────
  socket.on('add-reaction', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 32)) return;
      const reactMute = activeMuteNotice(socket.user.id);
      if (reactMute) return socket.emit('error-msg', reactMute);

      const allowed = /^[\p{Emoji}\p{Emoji_Component}\uFE0F\u200D]+$/u;
      const customEmojiPattern = /^:[a-zA-Z0-9_-]{1,30}:$/;
      if (!allowed.test(data.emoji) && !customEmojiPattern.test(data.emoji)) return;
      if (data.emoji.length > 32) return;

      if (customEmojiPattern.test(data.emoji)) {
        const emojiName = data.emoji.slice(1, -1).toLowerCase();
        const exists = db.prepare('SELECT 1 FROM custom_emojis WHERE name = ?').get(emojiName);
        if (!exists) return;
      }

      // Look up the channel from the message itself, not socket.currentChannel.
      // Reactions can be triggered from the DM PiP while the user's main pane
      // (and therefore socket.currentChannel) is a completely different
      // channel — using socket.currentChannel made the reaction silently
      // fail because the message wouldn't be found in that channel. (#bug-#4)
      const msg = db.prepare(
        'SELECT m.id, c.code, c.id as channel_id, c.is_dm, c.reactions_enabled FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?'
      ).get(data.messageId);
      if (!msg) return;
      const code = msg.code;
      if (!msg.is_dm) {
        const reactMute = activeMuteNotice(socket.user.id);
        if (reactMute) return socket.emit('error-msg', reactMute);
      }

      // Verify membership of the channel the message lives in.
      const member = hasChannelAccess(msg.channel_id);
      if (!member && !socket.user.isAdmin) return;
      if (msg.reactions_enabled === 0) {
        return socket.emit('error-msg', 'Reactions are disabled in this channel');
      }

      db.prepare(
        'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(data.messageId, socket.user.id, data.emoji);
      ctx.applySelfRoleReaction?.(socket, data.messageId, data.emoji, true);

      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
      `).all(data.messageId);

      io.to(`channel:${code}`).emit('reactions-updated', {
        channelCode: code,
        messageId: data.messageId,
        reactions
      });

      // Webhook event: reaction-added (3.13.0)
      try {
        fireWebhookEvent?.(msg.channel_id, code, 'reaction-added', {
          messageId: data.messageId,
          emoji: data.emoji,
          author: { id: socket.user.id, username: socket.user.displayName }
        });
      } catch { /* fireWebhookEvent catches and logs its own errors; this only guards the call */ }
    } catch (err) {
      console.error('add-reaction error:', err.message);
    }
  });

  socket.on('remove-reaction', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 32)) return;

      // Look up the channel from the message (see add-reaction comment).
      const msgRow = db.prepare(
        'SELECT m.id, c.code, c.id as channel_id, c.reactions_enabled FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?'
      ).get(data.messageId);
      if (!msgRow) return;
      const code = msgRow.code;

      const member = hasChannelAccess(msgRow.channel_id);
      if (!member && !socket.user.isAdmin) return;
      if (msgRow.reactions_enabled === 0) {
        return socket.emit('error-msg', 'Reactions are disabled in this channel');
      }

      db.prepare(
        'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
      ).run(data.messageId, socket.user.id, data.emoji);
      ctx.applySelfRoleReaction?.(socket, data.messageId, data.emoji, false);

      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
      `).all(data.messageId);

      io.to(`channel:${code}`).emit('reactions-updated', {
        channelCode: code,
        messageId: data.messageId,
        reactions
      });
    } catch (err) {
      console.error('remove-reaction error:', err.message);
    }
  });

  // ── Polls ───────────────────────────────────────────────
  socket.on('create-poll', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      const question = typeof data.question === 'string' ? data.question.trim() : '';
      if (!question || question.length > 300) return;
      const maxPollOpts = parseInt(db.prepare('SELECT value FROM server_settings WHERE key = ?').get('max_poll_options')?.value) || 10;
      const options = Array.isArray(data.options) ? data.options : [];
      if (options.length < 2 || options.length > maxPollOpts) return;
      const cleanOptions = options.map(o => typeof o === 'string' ? sanitizeText(o.trim()) : '').filter(Boolean);
      if (cleanOptions.length < 2 || cleanOptions.length > maxPollOpts) return;
      if (cleanOptions.some(o => o.length > 100)) return;
      const multiVote = !!data.multiVote;
      const anonymous = !!data.anonymous;
      // One optional picture per option, as an upload path on this server;
      // anything else is dropped rather than rendered (#5648).
      const rawImages = Array.isArray(data.images) ? data.images : [];
      const images = options.map((_, i) => {
        const u = typeof rawImages[i] === 'string' ? rawImages[i].trim() : '';
        return UPLOAD_PATH_EXACT_RE.test(u) ? u : null;
      }).filter((_, i) => options[i] && typeof options[i] === 'string' && options[i].trim());
      const hasImages = images.some(Boolean);
      // A picture poll can be laid out in columns (#5648).
      const columns = hasImages ? Math.min(5, Math.max(0, parseInt(data.columns, 10) || 0)) : 0;

      if (floodCheck('message')) {
        return socket.emit('error-msg', 'Slow down, you\'re sending messages too fast');
      }

      const activeMute = db.prepare(
        'SELECT id, expires_at FROM mutes WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY expires_at DESC LIMIT 1'
      ).get(socket.user.id);
      if (activeMute) {
        const remaining = Math.ceil((new Date(activeMute.expires_at + 'Z') - Date.now()) / 60000);
        return socket.emit('error-msg', `You are muted for ${remaining} more minute${remaining !== 1 ? 's' : ''}`);
      }

      const code = socket.currentChannel;
      if (!code) return;
      const channel = db.prepare('SELECT id, name, text_enabled, read_only, is_dm FROM channels WHERE code = ?').get(code);
      if (!channel) return;
      // A poll's question and answers are stored and sent as plain text, so
      // a DM, which is encrypted end to end, cannot have one.
      if (channel.is_dm) return socket.emit('error-msg', 'Polls are not available in direct messages');
      if (channel.text_enabled === 0) return socket.emit('error-msg', 'Polls are not allowed when text is disabled');
      const member = hasChannelAccess(channel.id);
      if (!member) return socket.emit('error-msg', 'Not a member of this channel');
      if (channel.read_only === 1 && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'read_only_override', channel.id)) {
        return socket.emit('error-msg', 'This channel is read-only');
      }
      if (refuseYoungAccount(channel.id)) return;
      if (enforceAutomod([question, ...cleanOptions].join('\n'), { surface: 'message', channelId: channel.id })) return;
      for (let i = 0; i < cleanOptions.length; i++) cleanOptions[i] = pingSafe(cleanOptions[i], socket.user.id, channel.id);

      const safeQuestion = sanitizeText(pingSafe(question, socket.user.id, channel.id));
      if (!safeQuestion) return;

      const pollData = JSON.stringify({ question: safeQuestion, options: cleanOptions, multiVote, anonymous, ...(hasImages && { images }), ...(columns > 1 && { columns }) });
      const content = `📊 Poll: ${safeQuestion}`;
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, poll_data) VALUES (?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, content, pollData);

      const message = {
        id: result.lastInsertRowid,
        content,
        created_at: new Date().toISOString(),
        username: socket.user.displayName,
        user_id: socket.user.id,
        avatar: socket.user.avatar || null,
        avatar_shape: socket.user.avatar_shape || 'circle',
        border: socket.user.border || null,
        borderTransform: socket.user.borderTransform || null,
        animateProfile: socket.user.animate_profile || 'trigger',
        reply_to: null,
        replyContext: null,
        reactions: [],
        edited_at: null,
        thread: null,
        poll: { question: safeQuestion, options: cleanOptions, multiVote, anonymous, ...(hasImages && { images }), ...(columns > 1 && { columns }), votes: {}, totalVotes: 0 }
      };
      cleanOptions.forEach((_, i) => { message.poll.votes[i] = []; });

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
      sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName, content);
      fireWebhookCallbacks(channel.id, code, message);

      try {
        db.prepare(`
          INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
        `).run(socket.user.id, channel.id, result.lastInsertRowid);
      } catch (e) { /* only the sender's own unread marker; it catches up on their next read */ }
    } catch (err) {
      console.error('create-poll error:', err.message);
      socket.emit('error-msg', 'Failed to create poll');
    }
  });

  socket.on('vote-poll', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId)) return;
      const optionIndex = typeof data.optionIndex === 'number' ? data.optionIndex : -1;
      if (optionIndex < 0 || optionIndex > 9 || !Number.isInteger(optionIndex)) return;

      const code = socket.currentChannel;
      if (!code) return;
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel || !hasChannelAccess(channel.id)) return;

      const msg = db.prepare('SELECT id, poll_data FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msg || !msg.poll_data) return;

      let poll;
      try { poll = JSON.parse(msg.poll_data); } catch (e) { return; }
      if (optionIndex >= poll.options.length) return;

      if (!poll.multiVote) {
        db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(data.messageId, socket.user.id);
      }

      db.prepare(
        'INSERT OR IGNORE INTO poll_votes (message_id, user_id, option_index) VALUES (?, ?, ?)'
      ).run(data.messageId, socket.user.id, optionIndex);

      const votes = db.prepare(`
        SELECT pv.option_index, pv.user_id, COALESCE(u.display_name, u.username) as username
        FROM poll_votes pv JOIN users u ON pv.user_id = u.id
        WHERE pv.message_id = ? ORDER BY pv.id
      `).all(data.messageId);

      const votesByOption = {};
      poll.options.forEach((_, i) => { votesByOption[i] = []; });
      votes.forEach(v => {
        if (!votesByOption[v.option_index]) votesByOption[v.option_index] = [];
        votesByOption[v.option_index].push({ user_id: v.user_id, username: v.username });
      });

      io.to(`channel:${code}`).emit('poll-updated', {
        channelCode: code,
        messageId: data.messageId,
        votes: votesByOption,
        totalVotes: votes.length
      });
    } catch (err) {
      console.error('vote-poll error:', err.message);
    }
  });

  socket.on('unvote-poll', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId)) return;
      const optionIndex = typeof data.optionIndex === 'number' ? data.optionIndex : -1;
      if (optionIndex < 0 || optionIndex > 9 || !Number.isInteger(optionIndex)) return;

      const code = socket.currentChannel;
      if (!code) return;
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel || !hasChannelAccess(channel.id)) return;
      const msg = db.prepare('SELECT id, poll_data FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msg || !msg.poll_data) return;

      db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?')
        .run(data.messageId, socket.user.id, optionIndex);

      let poll;
      try { poll = JSON.parse(msg.poll_data); } catch (e) { return; }

      const votes = db.prepare(`
        SELECT pv.option_index, pv.user_id, COALESCE(u.display_name, u.username) as username
        FROM poll_votes pv JOIN users u ON pv.user_id = u.id
        WHERE pv.message_id = ? ORDER BY pv.id
      `).all(data.messageId);

      const votesByOption = {};
      poll.options.forEach((_, i) => { votesByOption[i] = []; });
      votes.forEach(v => {
        if (!votesByOption[v.option_index]) votesByOption[v.option_index] = [];
        votesByOption[v.option_index].push({ user_id: v.user_id, username: v.username });
      });

      io.to(`channel:${code}`).emit('poll-updated', {
        channelCode: code,
        messageId: data.messageId,
        votes: votesByOption,
        totalVotes: votes.length
      });
    } catch (err) {
      console.error('unvote-poll error:', err.message);
    }
  });

  // ── Read positions ──────────────────────────────────────
  socket.on('mark-read', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    if (!isInt(data.messageId) || data.messageId <= 0) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member) return;

    try {
      db.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
      `).run(socket.user.id, channel.id, data.messageId);
    } catch (err) {
      console.error('Mark read error:', err);
    }
  });

  // Mark entire channel as read (context menu action)
  socket.on('mark-read-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member) return;

    try {
      // Mark up to the latest non-thread message. Thread replies have their
      // own panel and don't participate in channel-level read positions.
      const latest = db.prepare('SELECT MAX(id) AS maxId FROM messages WHERE channel_id = ? AND thread_id IS NULL').get(channel.id);
      if (!latest || !latest.maxId) return;

      db.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
      `).run(socket.user.id, channel.id, latest.maxId);
    } catch (err) {
      console.error('Mark read channel error:', err);
    }
  });

  // Mark everything read (#5683): every channel and DM this account belongs
  // to moves to its latest message, including ones the sidebar is not showing,
  // which is where a badge nobody can reach to clear comes from.
  socket.on('mark-all-read', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    try {
      const rows = db.prepare(`
        SELECT cm.channel_id AS channelId, MAX(m.id) AS latest
        FROM channel_members cm
        JOIN messages m ON m.channel_id = cm.channel_id AND m.thread_id IS NULL
        WHERE cm.user_id = ?
        GROUP BY cm.channel_id
      `).all(socket.user.id);
      const upsert = db.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
      `);
      db.transaction(() => {
        for (const r of rows) if (r.latest) upsert.run(socket.user.id, r.channelId, r.latest);
      })();
      cb({ ok: true, channels: rows.length });
    } catch (err) {
      console.error('Mark all read error:', err);
      cb({ error: 'Could not mark everything read' });
    }
  });

  // Mark every topic in a forum channel read for this account (#5641). Each
  // topic's row moves to its latest reply, or 0 when it has none, so the dot
  // comes back only for replies that land after this.
  socket.on('mark-forum-read', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id, is_forum FROM channels WHERE code = ?').get(code);
    if (!channel || !channel.is_forum) return;

    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return;

    try {
      db.prepare(`
        INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id)
        SELECT ?, m.id, COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = m.id), 0)
        FROM messages m
        WHERE m.channel_id = ? AND m.thread_id IS NULL
        ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = MAX(last_read_reply_id, excluded.last_read_reply_id)
      `).run(socket.user.id, channel.id);
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === socket.user.id) s.emit('forum-read', { channelCode: code });
      }
    } catch (err) {
      console.error('Mark forum read error:', err);
    }
  });

  // A reply that lands while you have the thread open on screen has been
  // seen: record it so a reload, or another device, does not flag it (#5641).
  socket.on('mark-thread-read', (data) => {
    if (!data || typeof data !== 'object' || !isInt(data.parentId)) return;
    const parentRow = db.prepare(
      'SELECT m.id, m.channel_id, c.code as channel_code FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ? AND m.thread_id IS NULL'
    ).get(data.parentId);
    if (!parentRow) return;
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(parentRow.channel_id, socket.user.id);
    if (!member && !socket.user.isAdmin) return;
    try {
      db.prepare(`
        INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id)
        VALUES (?, ?, COALESCE((SELECT MAX(id) FROM messages WHERE thread_id = ?), 0))
        ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = MAX(last_read_reply_id, excluded.last_read_reply_id)
      `).run(socket.user.id, data.parentId, data.parentId);
      for (const [, s] of io.sockets.sockets) {
        if (s !== socket && s.user && s.user.id === socket.user.id) s.emit('thread-read', { channelCode: parentRow.channel_code, parentId: data.parentId });
      }
    } catch (err) {
      console.error('Mark thread read error:', err);
    }
  });

  // ═══════════════════════════════════════════════════════
  // THREADS
  // ═══════════════════════════════════════════════════════

  // ── Get thread messages ─────────────────────────────────
  socket.on('get-thread-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const parentId = isInt(data.parentId) ? data.parentId : null;
    if (!parentId) return;

    // Look up the channel from the parent message rather than relying on
    // socket.currentChannel — the thread panel can persist across channel
    // switches, and a stale currentChannel would silently empty the thread
    // (issue: web users seeing 28 replies but no messages, mobile fine).
    const parentRow = db.prepare(
      'SELECT m.id, m.user_id, m.content, m.created_at, m.channel_id, c.code as channel_code, c.is_dm as is_dm, m.is_webhook, m.webhook_username, m.imported_from,\n              COALESCE(m.webhook_username, u.display_name, u.username, \'[Deleted User]\') as username,\n              COALESCE(m.webhook_avatar, u.avatar) as avatar,\n              COALESCE(u.avatar_shape, \'circle\') as avatar_shape\n       FROM messages m\n       JOIN channels c ON m.channel_id = c.id\n       LEFT JOIN users u ON m.user_id = u.id\n       WHERE m.id = ?'
    ).get(parentId);
    if (!parentRow) return;
    if (parentRow.is_dm) return; // Threads are not available in DMs
    const channel = { id: parentRow.channel_id };
    const parent = parentRow;
    // A relayed or bot author is marked the same way channel history marks
    // it, so a Discord nickname cannot pass for a Haven member's name.
    if (parent.is_webhook && !parent.imported_from) {
      parent.username = `[BOT] ${parent.webhook_username || 'Bot'}`;
      parent.avatar_shape = 'square';
    }

    // Verify the user is a member of the channel (admins exempt).
    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return;
    // A role gate on the channel covers its threads too (#5597).
    if (!socket.user.isAdmin && !ctx.roleGateAllows(socket.user.id, db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channel.id))) return;

    // Opening a thread marks every reply in it seen for this account, and the
    // person's other devices drop the unread dot too (#5641).
    try {
      db.prepare(`
        INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id)
        VALUES (?, ?, COALESCE((SELECT MAX(id) FROM messages WHERE thread_id = ?), 0))
        ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = MAX(last_read_reply_id, excluded.last_read_reply_id)
      `).run(socket.user.id, parentId, parentId);
      for (const [, s] of io.sockets.sockets) {
        if (s !== socket && s.user && s.user.id === socket.user.id) s.emit('thread-read', { channelCode: parentRow.channel_code, parentId });
      }
    } catch (err) {
      console.error('Thread read error:', err);
    }

    const messages = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived,
             COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, COALESCE(m.webhook_avatar, u.avatar) as avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape, u.border, u.border_transform, COALESCE(u.animate_profile, 'trigger') as animate_profile
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.thread_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `).all(parentId);

    // Enrich with reactions and reply context
    const msgIds = messages.map(m => m.id);
    const replyIds = [...new Set(messages.filter(m => m.reply_to).map(m => m.reply_to))];

    const replyMap = new Map();
    if (replyIds.length > 0) {
      const ph = replyIds.map(() => '?').join(',');
      db.prepare(`${REPLY_CONTEXT_SELECT}
        WHERE m.id IN (${ph})
      `).all(...replyIds).forEach(r => replyMap.set(r.id, toReplyContext(r)));
    }

    const reactionMap = new Map();
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      db.prepare(`
        SELECT r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username
        FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id IN (${ph}) ORDER BY r.id
      `).all(...msgIds).forEach(r => {
        if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
        reactionMap.get(r.message_id).push({ emoji: r.emoji, user_id: r.user_id, username: r.username });
      });
    }

    // Attachment tags on the replies' pictures, for their footers and the
    // Edit tags entry on the image menu (#5682).
    const threadTagMap = new Map();
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      db.prepare(`
        SELECT at.message_id, ut.name
        FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id
        WHERE at.message_id IN (${ph}) ORDER BY ut.name_norm
      `).all(...msgIds).forEach(r => {
        if (!threadTagMap.has(r.message_id)) threadTagMap.set(r.message_id, []);
        const arr = threadTagMap.get(r.message_id);
        if (!arr.includes(r.name)) arr.push(r.name);
      });
    }

    // Blog mode (#5742): which replies are the author's additions to the post.
    const blogParts = forumBlog.blogOn(db, channel.id) ? forumBlog.partIdsOf(db, parentId) : null;

    const enriched = messages.map(m => {
      const obj = { ...m };
      const atags = threadTagMap.get(m.id);
      if (atags && atags.length) obj.attachmentTags = atags;
      // Border fit travels with the message (like avatar) so it renders even when
      // the author is offline. Parse the stored JSON into the op array the client folds.
      obj.borderTransform = parseBorderTransform(m.border_transform);
      delete obj.border_transform;
      // Animation policy travels with the message too (offline-safe, like the border).
      obj.animateProfile = m.animate_profile || 'trigger';
      delete obj.animate_profile;
      if (obj.created_at && !obj.created_at.endsWith('Z')) obj.created_at = utcStamp(obj.created_at);
      if (obj.edited_at && !obj.edited_at.endsWith('Z')) obj.edited_at = utcStamp(obj.edited_at);
      obj.replyContext = m.reply_to ? (replyMap.get(m.reply_to) || null) : null;
      obj.reactions = reactionMap.get(m.id) || [];
      // Same marking as channel history: a relayed or bot author gets the
      // [BOT] prefix, so a Discord nickname cannot pass for a Haven member.
      // webhook_username stays the bare name, so the prefix is added once.
      // Imported history keeps its original author's name, as it does there.
      if (m.is_webhook && !m.imported_from) {
        obj.is_webhook = true;
        obj.username = `[BOT] ${m.webhook_username || 'Bot'}`;
        obj.avatar_shape = 'square';
        obj.border = null; obj.borderTransform = null; obj.animateProfile = 'trigger';
      }
      if (blogParts) obj.post_part = blogParts.has(m.id);
      return obj;
    });

    socket.emit('thread-messages', {
      parentId,
      // Blog mode (#5742): the client shows the post_part replies with the
      // post and the rest under Comments.
      blog: !!blogParts,
      parentContent: parent.content,
      parentUserId: parent.user_id || null,
      parentUsername: parent.username || '[Deleted User]',
      parentAvatar: parent.avatar || null,
      parentAvatarShape: parent.avatar_shape || 'circle',
      parentCreatedAt: utcStamp(parent.created_at),
      messages: enriched
    });
  });

  // ── Send message to thread ──────────────────────────────
  socket.on('send-thread-message', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const parentId = isInt(data.parentId) ? data.parentId : null;
    let content = typeof data.content === 'string' ? data.content.trim() : '';
    if (!parentId || !content) return;

    if (floodCheck('message')) return;

    // Resolve channel via the parent message (not socket.currentChannel) so
    // sending from a thread panel still works after the user has navigated
    // away from the parent's channel. (#thread-blank-web)
    const parent = db.prepare(
      'SELECT m.id, m.thread_id, m.channel_id, c.code as code, c.is_dm FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?'
    ).get(parentId);
    if (!parent || parent.thread_id) return; // Can't create sub-threads
    if (parent.is_dm) return socket.emit('error-msg', 'Threads are not available in DMs');
    const code = parent.code;
    const channel = { id: parent.channel_id, is_dm: parent.is_dm };

    // Verify the user is a member of the channel (admins exempt).
    const tMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!tMember && !socket.user.isAdmin) return;
    // A role gate on the channel covers its threads too (#5597).
    if (!socket.user.isAdmin && !ctx.roleGateAllows(socket.user.id, db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channel.id))) return;

    // ── Moderation controls (#5483) ───────────────────────
    // This handler grew up alongside send-message but never picked up the
    // checks that live there, so a thread reply was a way around all of them.
    // @birdcrazy noticed links posting freely in threads; the mute bypass and
    // the missing length cap were sitting in the same gap.
    const tMaxRow = db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get();
    const tMax = parseInt(tMaxRow?.value) || 2000;
    if (content.length > tMax) {
      return socket.emit('error-msg', `Message too long (max ${tMax} characters)`);
    }

    const tMute = db.prepare(
      'SELECT expires_at FROM mutes WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY expires_at DESC LIMIT 1'
    ).get(socket.user.id);
    if (tMute) {
      const remaining = Math.ceil((new Date(tMute.expires_at + 'Z') - Date.now()) / 60000);
      return socket.emit('error-msg', `You are muted for ${remaining} more minute${remaining !== 1 ? 's' : ''}`);
    }

    const tChannelRow = db.prepare('SELECT read_only FROM channels WHERE id = ?').get(channel.id);
    if (tChannelRow && tChannelRow.read_only === 1 && !socket.user.isAdmin &&
        !userHasPermission(socket.user.id, 'read_only_override', channel.id)) {
      return socket.emit('error-msg', 'This channel is read-only');
    }

    if (refuseYoungAccount(channel.id)) return;
    if (enforceAutomod(content, { surface: 'message', channelId: channel.id, markdown: true })) return;

    const safeContent = sanitizeText(pingSafe(content, socket.user.id, channel.id));
    if (!safeContent) return;

    let replyTo = isInt(data.replyTo) ? data.replyTo : null;
    if (replyTo) {
      const replyMsg = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(replyTo);
      if (!replyMsg || replyMsg.thread_id !== parentId) replyTo = null;
    }

    try {
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, thread_id, reply_to) VALUES (?, ?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, safeContent, parentId, replyTo);
      // Your own reply is not news to you (#5641).
      db.prepare(`
        INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id) VALUES (?, ?, ?)
        ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = MAX(last_read_reply_id, excluded.last_read_reply_id)
      `).run(socket.user.id, parentId, result.lastInsertRowid);

      const message = {
        id: result.lastInsertRowid,
        content: safeContent,
        created_at: new Date().toISOString(),
        username: socket.user.displayName,
        user_id: socket.user.id,
        avatar: socket.user.avatar || null,
        avatar_shape: socket.user.avatar_shape || 'circle',
        border: socket.user.border || null,
        borderTransform: socket.user.borderTransform || null,
        animateProfile: socket.user.animate_profile || 'trigger',
        reply_to: replyTo,
        replyContext: null,
        reactions: [],
        edited_at: null,
        thread_id: parentId
      };

      if (replyTo) {
        message.replyContext = toReplyContext(db.prepare(`${REPLY_CONTEXT_SELECT}
          WHERE m.id = ?
        `).get(replyTo));
      }
      // Blog mode (#5742): the server, not the sender, says whether this is
      // part of the post or a comment.
      const blogMode = forumBlog.blogOn(db, channel.id);
      if (blogMode) message.post_part = forumBlog.isPart(db, message.id);

      // Emit to everyone in the channel who has the thread open
      io.to(`channel:${code}`).emit('new-thread-message', {
        channelCode: code,
        parentId,
        message
      });

      // Update thread preview on the parent message for all users
      const threadCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?').get(parentId);
      const lastMsg = db.prepare(`
        SELECT m.id, m.content, m.created_at, COALESCE(u.display_name, u.username) as username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 1
      `).get(parentId);

      // Get up to 5 unique participants
      const participants = db.prepare(`
        SELECT DISTINCT COALESCE(u.display_name, u.username) as username, u.avatar
        FROM messages m JOIN users u ON m.user_id = u.id
        WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 5
      `).all(parentId);

      io.to(`channel:${code}`).emit('thread-updated', {
        channelCode: code,
        parentId,
        thread: {
          count: threadCount.count,
          lastReplyAt: lastMsg ? lastMsg.created_at : null,
          lastReplyId: lastMsg ? lastMsg.id : null,
          // Lets forum cards light up for everyone but the person who replied (#5641).
          senderId: socket.user.id,
          participants: participants.map(p => ({ username: p.username, avatar: p.avatar })),
          ...(blogMode ? forumBlog.threadExtras(db, channel.id, parentId) : {})
        }
      });

      // A reply in a forum topic follows the topic to its Discord post, after
      // the broadcast so Discord never holds up the Haven side.
      ferryRelayReply?.({
        channelId: channel.id,
        parentId,
        user: socket.user,
        body: safeContent,
        notify: (msg) => socket.emit('error-msg', msg),
      });

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      console.error('send-thread-message error:', err.message);
      if (typeof callback === 'function') callback({ error: 'Failed to send thread message' });
    }
  });
};
