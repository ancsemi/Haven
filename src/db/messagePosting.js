'use strict';

const { utcStamp } = require('../socketHandlers/helpers');

// Reply banners must match message rendering: bots live in webhook_* with
// user_id NULL, so a users-table COALESCE alone becomes "[Deleted User]".
const REPLY_CONTEXT_SELECT = `
  SELECT m.id, m.content, m.user_id, m.is_webhook, m.webhook_username, m.imported_from, m.persona_username,
         COALESCE(u.display_name, u.username, '[Deleted User]') as username
  FROM messages m LEFT JOIN users u ON m.user_id = u.id`;

function getActiveMute(db, userId) {
  const now = db.kind === 'postgres' ? "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')" : "datetime('now')";
  return db.prepare(`SELECT expires_at FROM mutes WHERE user_id = ? AND expires_at > ${now}
    ORDER BY expires_at DESC LIMIT 1`).get(userId);
}

function muteNotice(row) {
  if (!row) return null;
  const remaining = Math.ceil((new Date(utcStamp(row.expires_at)) - Date.now()) / 60000);
  return `You are in a timeout for ${remaining} more minute${remaining !== 1 ? 's' : ''}`;
}

function insertMessage(db, {
  channelId, userId, content, replyTo = null, burnSeconds = 0,
  personaId = null, personaUsername = null, personaAvatar = null, breakChain = 0, ferryLabel = null,
  topicTitle = null, topicTags = null, topicNsfw = 0, e2eFiles = null, destructAt = null, silent = 0,
}) {
  const sql = 'INSERT INTO messages (channel_id, user_id, content, reply_to, burn_seconds, persona_id, persona_username, persona_avatar, break_chain, ferry_target, title, tags, nsfw, e2e_files, destruct_at, silent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const params = [channelId, userId, content, replyTo, burnSeconds, personaId, personaUsername, personaAvatar,
    breakChain, ferryLabel, topicTitle, topicTags, topicNsfw, e2eFiles, destructAt, silent];
  if (db.kind === 'postgres') return db.prepare(sql + ' RETURNING id AS "lastInsertRowid", created_at').get(...params);
  return db.prepare(sql).run(...params);
}

module.exports = { REPLY_CONTEXT_SELECT, getActiveMute, muteNotice, insertMessage };
