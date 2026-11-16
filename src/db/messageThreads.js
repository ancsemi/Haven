'use strict';

const { parseBorderTransform, toReplyContext, utcStamp } = require('../socketHandlers/helpers');
const { REPLY_CONTEXT_SELECT } = require('./messagePosting');

function threadHistoryVisible(alias) {
  return `${alias}.destruct_at IS NULL AND COALESCE(${alias}.burn_seconds, 0) = 0`;
}

function threadParent(db, parentId, { channelId, sending = false } = {}) {
  const scope = channelId === undefined ? '' : `AND m.channel_id = ? AND m.thread_id IS NULL AND ${threadHistoryVisible('m')}`;
  const lock = db.kind === 'postgres' ? (sending ? 'FOR NO KEY UPDATE OF m' : 'FOR SHARE OF m') : '';
  return db.prepare(`
    SELECT m.id, m.user_id, m.content, m.created_at, m.channel_id, m.thread_id, m.closed,
           c.is_forum, c.code AS channel_code, c.is_dm, m.is_webhook, m.webhook_username, m.imported_from,
           COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') AS username,
           COALESCE(m.webhook_avatar, u.avatar) AS avatar, COALESCE(u.avatar_shape, 'circle') AS avatar_shape
    FROM messages m JOIN channels c ON m.channel_id = c.id LEFT JOIN users u ON m.user_id = u.id
    WHERE m.id = ? ${scope}
    ${lock}
  `).get(parentId, ...(channelId === undefined ? [] : [channelId]));
}

function threadMessages(db, parentId, channelId) {
  const scope = channelId === undefined ? '' : `AND m.channel_id = ? AND ${threadHistoryVisible('m')}`;
  return db.prepare(`
    SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username,
           m.webhook_avatar, m.imported_from, m.is_archived, m.silent, m.nsfw,
           COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') AS username,
           u.id AS user_id, COALESCE(m.webhook_avatar, u.avatar) AS avatar,
           COALESCE(u.avatar_shape, 'circle') AS avatar_shape, u.border, u.border_transform,
           COALESCE(u.animate_profile, 'trigger') AS animate_profile
    FROM messages m LEFT JOIN users u ON m.user_id = u.id
    WHERE m.thread_id = ? ${scope}
    ORDER BY m.created_at ASC, m.id ASC
  `).all(parentId, ...(channelId === undefined ? [] : [channelId]));
}

function threadReplyContexts(db, ids, parentId, channelId) {
  if (!ids.length) return [];
  if (db.kind === 'postgres') {
    return db.prepare(`${REPLY_CONTEXT_SELECT}
      WHERE m.id = ANY(?::bigint[]) AND m.channel_id = ? AND (m.thread_id = ? OR m.id = ?)
        AND ${threadHistoryVisible('m')}
    `).all(ids, channelId, parentId, parentId);
  }
  const marks = ids.map(() => '?').join(',');
  return db.prepare(`${REPLY_CONTEXT_SELECT} WHERE m.id IN (${marks})`).all(...ids);
}

function threadReplyTarget(tx, replyTo, parentId, channelId) {
  return tx.prepare(`${REPLY_CONTEXT_SELECT}
    WHERE m.id = ? AND m.thread_id = ? AND m.channel_id = ? AND ${threadHistoryVisible('m')}
    FOR SHARE OF m
  `).get(replyTo, parentId, channelId);
}

function insertThreadReply(db, { channelId, userId, content, parentId, replyTo, silent, blogComment = 0 }) {
  const sql = 'INSERT INTO messages (channel_id, user_id, content, thread_id, reply_to, silent, blog_comment) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const params = [channelId, userId, content, parentId, replyTo, silent, blogComment];
  if (db.kind === 'postgres') return db.prepare(sql + ' RETURNING id AS "lastInsertRowid", created_at').get(...params);
  return db.prepare(sql).run(...params);
}

function threadSummaries(db, parentIds, channelId) {
  if (!parentIds.length) return new Map();
  const marks = parentIds.map(() => '?').join(',');
  const scope = channelId === undefined ? '' : `AND m.channel_id = ? AND ${threadHistoryVisible('m')}`;
  const counts = db.prepare(`
    SELECT thread_id, COUNT(*) AS reply_count, MAX(created_at) AS last_reply_at, MAX(id) AS last_reply_id
    FROM messages m WHERE thread_id IN (${marks}) ${scope}
    GROUP BY thread_id
  `).all(...parentIds, ...(channelId === undefined ? [] : [channelId]));
  function withCounts(rows) {
    const threads = new Map(rows.map(row => [row.thread_id, {
      count: row.reply_count, lastReplyAt: utcStamp(row.last_reply_at), lastReplyId: row.last_reply_id, participants: [],
    }]));
    if (!threads.size) return threads;
    const ids = [...threads.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const participants = db.prepare(`
      SELECT tm.thread_id, COALESCE(u.display_name, u.username) AS username, u.avatar,
             COALESCE(u.avatar_shape, 'circle') AS avatar_shape
      FROM (
        SELECT thread_id, user_id, MAX(created_at) AS latest, MAX(id) AS latest_id
        FROM messages m WHERE thread_id IN (${placeholders}) ${scope}
        GROUP BY thread_id, user_id
      ) tm JOIN users u ON tm.user_id = u.id
      ORDER BY tm.latest DESC ${db.kind === 'postgres' ? ', tm.latest_id DESC' : ''}
    `).all(...ids, ...(channelId === undefined ? [] : [channelId]));
    function addParticipants(people) {
      for (const person of people) {
        const info = threads.get(person.thread_id);
        if (info && info.participants.length < 5) {
          info.participants.push({ username: person.username, avatar: person.avatar, avatarShape: person.avatar_shape });
        }
      }
      return threads;
    }
    return db.kind === 'postgres' ? participants.then(addParticipants) : addParticipants(participants);
  }
  return db.kind === 'postgres' ? counts.then(withCounts) : withCounts(counts);
}

function channelThreads(db, channelId) {
  const visible = db.kind === 'postgres'
    ? `AND t.channel_id = p.channel_id AND ${threadHistoryVisible('p')} AND ${threadHistoryVisible('t')}`
    : '';
  // A thread is a message with replies. Cap the list and order by activity.
  return db.prepare(`
    SELECT p.id, p.content, p.created_at,
           COALESCE(p.persona_username, p.webhook_username, u.display_name, u.username, '[Deleted User]') AS username,
           u.id AS user_id, COUNT(t.id) AS reply_count, MAX(t.created_at) AS last_reply_at
    FROM messages p JOIN messages t ON t.thread_id = p.id LEFT JOIN users u ON p.user_id = u.id
    WHERE p.channel_id = ? AND p.thread_id IS NULL ${visible}
    GROUP BY p.id${db.kind === 'postgres' ? ', u.id' : ''}
    ORDER BY last_reply_at DESC, p.id DESC
    LIMIT 500
  `).all(channelId);
}

function formatChannelThreads(threads, newCounts) {
  return threads.map(thread => ({
    ...thread,
    ...(newCounts.has(thread.id) ? { new_count: newCounts.get(thread.id) } : {}),
    created_at: utcStamp(thread.created_at),
    last_reply_at: utcStamp(thread.last_reply_at),
  }));
}

function formatThreadParent(parent) {
  // A relayed or bot author is marked the same way channel history marks
  // it, so a Discord nickname cannot pass for a Haven member's name.
  const bot = parent.is_webhook && !parent.imported_from;
  return {
    parentContent: parent.content,
    parentUserId: parent.user_id || null,
    parentUsername: bot ? `[BOT] ${parent.webhook_username || 'Bot'}` : parent.username || '[Deleted User]',
    parentAvatar: parent.avatar || null,
    parentAvatarShape: bot ? 'square' : parent.avatar_shape || 'circle',
    parentCreatedAt: utcStamp(parent.created_at),
  };
}

function formatThreadMessage(message, reply, reactions) {
  const row = { ...message };
  if (row.silent) row.silent = true; else delete row.silent;
  if (row.nsfw) row.nsfw = true; else delete row.nsfw;
  // Border fit and animation policy travel with the message, even offline.
  row.borderTransform = parseBorderTransform(row.border_transform);
  delete row.border_transform;
  row.animateProfile = row.animate_profile || 'trigger';
  delete row.animate_profile;
  row.created_at = utcStamp(row.created_at);
  row.edited_at = utcStamp(row.edited_at);
  row.replyContext = toReplyContext(reply);
  row.reactions = reactions || [];
  // webhook_username stays bare so the prefix is added once. Imported
  // history keeps its original author's name, as in channel history.
  if (row.is_webhook && !row.imported_from) {
    row.is_webhook = true;
    row.username = `[BOT] ${row.webhook_username || 'Bot'}`;
    row.avatar_shape = 'square';
    row.border = null; row.borderTransform = null; row.animateProfile = 'trigger';
  }
  return row;
}

module.exports = {
  threadHistoryVisible, threadParent, threadMessages, threadReplyContexts, threadReplyTarget, insertThreadReply,
  threadSummaries, channelThreads, formatChannelThreads, formatThreadParent, formatThreadMessage,
};
