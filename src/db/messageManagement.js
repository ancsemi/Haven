'use strict';

const { utcStamp } = require('../socketHandlers/helpers');

function messageChannel(db, code, { messageId = null, pinning = false } = {}) {
  const lock = db.kind === 'postgres' ? (pinning ? 'FOR NO KEY UPDATE OF c' : 'FOR SHARE OF c') : '';
  return db.prepare(`
    SELECT c.id, c.code, c.name, c.is_dm, c.is_group, c.is_forum, c.role_gate, c.reactions_enabled
    FROM channels c
    ${code === null ? 'JOIN messages m ON m.channel_id = c.id WHERE m.id = ?' : 'WHERE c.code = ?'}
    ${lock}
  `).get(code === null ? messageId : code);
}

function messageChannelMember(db, channelId, userId) {
  const lock = db.kind === 'postgres' ? 'FOR SHARE' : '';
  return db.prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? ${lock}`)
    .get(channelId, userId);
}

function messageForAction(db, channelId, messageId, { historyOnly = false, deleting = false } = {}) {
  const lock = db.kind === 'postgres' ? (deleting ? 'FOR UPDATE OF m' : 'FOR NO KEY UPDATE OF m') : '';
  const roleMenu = db.kind === 'postgres'
    ? ', EXISTS (SELECT 1 FROM role_menus rm WHERE rm.message_id = m.id) AS role_menu'
    : '';
  return db.prepare(`
    SELECT m.id, m.user_id, m.content, m.is_archived, m.original_name, m.e2e_files,
           m.thread_id, m.destruct_at, m.burn_seconds ${roleMenu}
    FROM messages m
    WHERE m.id = ? AND m.channel_id = ?
      ${historyOnly ? 'AND m.thread_id IS NULL AND m.destruct_at IS NULL AND COALESCE(m.burn_seconds, 0) = 0' : ''}
    ${lock}
  `).get(messageId, channelId);
}

function messageAuthor(db, userId) {
  return db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(userId);
}

function ownDeleteOverride(db, userId, channelIds) {
  const marks = channelIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = 'delete_own_messages'
      AND (channel_id IS NULL OR channel_id IN (${marks})) ORDER BY allowed ASC LIMIT 1
  `).get(userId, ...channelIds);
}

function deleteMessage(db, messageId) {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
}

function findPin(db, messageId) {
  return db.prepare('SELECT id, channel_id FROM pinned_messages WHERE message_id = ?').get(messageId);
}

function countPins(db, channelId) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM pinned_messages WHERE channel_id = ?').get(channelId);
}

function insertPin(db, messageId, channelId, userId) {
  return db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)')
    .run(messageId, channelId, userId);
}

function deletePin(db, messageId) {
  return db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(messageId);
}

function clearDestructAt(db, messageId) {
  return db.prepare('UPDATE messages SET destruct_at = NULL WHERE id = ?').run(messageId);
}

function setProtection(db, messageId, archived) {
  // Protecting a message also stops its self-destruct and burn-after-read timers.
  const sql = archived
    ? 'UPDATE messages SET is_archived = 1, destruct_at = NULL, burn_seconds = 0, burning_started_at = NULL WHERE id = ?'
    : 'UPDATE messages SET is_archived = 0 WHERE id = ?';
  return db.prepare(sql).run(messageId);
}

function listPins(db, channelId, floor) {
  // Match the message history available in the PostgreSQL preview.
  const visible = db.kind === 'postgres'
    ? 'AND m.channel_id = pm.channel_id AND m.thread_id IS NULL AND m.destruct_at IS NULL AND COALESCE(m.burn_seconds, 0) = 0'
    : '';
  return db.prepare(`
    SELECT m.id, m.content, m.created_at, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar,
           COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id,
           pm.pinned_at, COALESCE(pb.display_name, pb.username, '[Deleted User]') as pinned_by
    FROM pinned_messages pm
    JOIN messages m ON pm.message_id = m.id
    LEFT JOIN users u ON m.user_id = u.id
    LEFT JOIN users pb ON pm.pinned_by = pb.id
    WHERE pm.channel_id = ? AND m.id > ? ${visible}
    ORDER BY pm.pinned_at DESC
  `).all(channelId, floor);
}

function formatPins(pins) {
  for (const pin of pins) {
    pin.created_at = utcStamp(pin.created_at);
    pin.edited_at = utcStamp(pin.edited_at);
    pin.pinned_at = utcStamp(pin.pinned_at);
    if (pin.is_webhook) pin.username = `[BOT] ${pin.webhook_username || 'Bot'}`;
  }
  return pins;
}

module.exports = {
  messageChannel, messageChannelMember, messageForAction, messageAuthor,
  ownDeleteOverride, deleteMessage, findPin, countPins, insertPin, deletePin, clearDestructAt, setProtection, listPins, formatPins,
};
