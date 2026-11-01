'use strict';

// Each receipt checks membership and writes in the same SQL statement. An
// await between a separate check and write would let a removal slip between
// them. SQLite executes the statement before the returned promise yields.
module.exports = function createReadPositions(db) {
  function upsert(driver) {
    const maximum = driver.kind === 'postgres'
      ? 'GREATEST(read_positions.last_read_message_id, excluded.last_read_message_id)'
      : 'MAX(read_positions.last_read_message_id, excluded.last_read_message_id)';
    return `ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = ${maximum}`;
  }
  return {
    // Used after a send has already passed its checks and stored the message.
    async advance(userId, channelId, messageId) {
      const driver = db.async || db;
      return driver.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ${upsert(driver)}
      `).run(userId, channelId, messageId);
    },
    async markRead(userId, code, messageId) {
      const driver = db.async || db;
      return driver.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        SELECT cm.user_id, c.id, ?
        FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
        WHERE c.code = ? AND cm.user_id = ?
        ${upsert(driver)}
      `).run(messageId, code, userId);
    },
    async markChannelRead(userId, code) {
      const driver = db.async || db;
      // Thread replies have their own read positions. As before, an empty
      // channel (or a latest id of zero) leaves the marker alone. The scalar
      // subquery keeps the indexed latest-message lookup instead of grouping
      // every message in the channel.
      return driver.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        SELECT cm.user_id, c.id, m.id
        FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
        JOIN messages m ON m.id = (
          SELECT MAX(latest.id) FROM messages latest
          WHERE latest.channel_id = c.id AND latest.thread_id IS NULL
        )
        WHERE c.code = ? AND cm.user_id = ? AND m.id != 0
        ${upsert(driver)}
      `).run(code, userId);
    },
  };
};
