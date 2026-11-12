'use strict';

function addReaction(db, messageId, userId, emoji) {
  return db.prepare(`
    INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
    ON CONFLICT(message_id, user_id, emoji) DO NOTHING
  `).run(messageId, userId, emoji);
}

function removeReaction(db, messageId, userId, emoji) {
  return db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .run(messageId, userId, emoji);
}

function listReactions(db, messageId) {
  return db.prepare(`
    SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) AS username
    FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
  `).all(messageId);
}

module.exports = { addReaction, removeReaction, listReactions };
