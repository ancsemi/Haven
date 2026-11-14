'use strict';

const { isString } = require('./helpers');

const validStatuses = ['online', 'away', 'dnd', 'invisible'];

function parseStatus(data) {
  if (!data || typeof data !== 'object') return null;
  const status = validStatuses.includes(data.status) ? data.status : 'online';
  const statusText = isString(data.statusText, 0, 128) ? data.statusText.trim() : '';
  return { status, statusText };
}

function readStatus(db, userId) {
  return db.prepare('SELECT status, status_text FROM users WHERE id = ?').get(userId);
}

function updateStatus(db, userId, { status, statusText }) {
  return db.prepare('UPDATE users SET status = ?, status_text = ? WHERE id = ?').run(status, statusText, userId);
}

function dmChannelCodes(db, userId) {
  return db.prepare(`
    SELECT c.code FROM channels c
    JOIN channel_members cm ON cm.channel_id = c.id
    WHERE c.is_dm = 1 AND cm.user_id = ?
  `).all(userId);
}

module.exports = { parseStatus, readStatus, updateStatus, dmChannelCodes };
