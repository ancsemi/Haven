'use strict';

// Receipt writes keep their membership checks in the same SQL statement or
// synchronous SQLite transaction. An await between a check and write would
// let a removal slip between them.
module.exports = function createReadPositions(db) {
  function upsert(driver) {
    const maximum = driver.kind === 'postgres'
      ? 'GREATEST(read_positions.last_read_message_id, excluded.last_read_message_id)'
      : 'MAX(read_positions.last_read_message_id, excluded.last_read_message_id)';
    return `ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = ${maximum}`;
  }
  const latestForUser = `
    SELECT cm.channel_id, MAX(m.id) AS latest
    FROM channel_members cm
    JOIN messages m ON m.channel_id = cm.channel_id AND m.thread_id IS NULL
    WHERE cm.user_id = ?
    GROUP BY cm.channel_id
  `;
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
    async markAllRead(userId) {
      const driver = db.async || db;
      if (driver.kind === 'postgres') {
        // The count and writes share one snapshot, including a channel whose
        // latest id is zero (counted, but left alone by the original handler).
        const row = await driver.prepare(`
          WITH latest AS (${latestForUser}), written AS (
            INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
            SELECT ?, channel_id, latest FROM latest WHERE latest != 0 ORDER BY channel_id
            ${upsert(driver)}
            RETURNING channel_id
          )
          SELECT COUNT(*) AS channels FROM latest
        `).get(userId, userId);
        return row.channels;
      }
      // Keep SQLite's entire read/write loop synchronous. Awaiting inside a
      // native transaction would let legacy handlers use its open connection.
      return db.transaction(() => {
        const rows = db.prepare(latestForUser).all(userId);
        const write = db.prepare(`
          INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
          VALUES (?, ?, ?)
          ${upsert(driver)}
        `);
        for (const row of rows) if (row.latest) write.run(userId, row.channel_id, row.latest);
        return rows.length;
      })();
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
    async markForumRead(userId, code, isAdmin) {
      const driver = db.async || db;
      const maximum = driver.kind === 'postgres'
        ? 'GREATEST(thread_reads.last_read_reply_id, excluded.last_read_reply_id)'
        : 'MAX(thread_reads.last_read_reply_id, excluded.last_read_reply_id)';
      // Eligibility is part of the write, so a delayed request cannot use
      // membership that was removed while its query was waiting.
      const result = await driver.prepare(`
        INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id)
        SELECT ?, m.id, COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = m.id), 0)
        FROM channels c JOIN messages m ON m.channel_id = c.id AND m.thread_id IS NULL
        WHERE c.code = ? AND c.is_forum != 0
          AND (? = 1 OR EXISTS (
            SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
          ))
        ORDER BY m.id
        ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = ${maximum}
      `).run(userId, code, isAdmin ? 1 : 0, userId);
      if (result.changes) return true;
      // An authorized empty forum still sends forum-read, as before. This
      // fallback only decides whether to emit; it never authorizes a write.
      const channel = await driver.prepare(`
        SELECT c.id FROM channels c WHERE c.code = ? AND c.is_forum != 0
          AND (? = 1 OR EXISTS (
            SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
          ))
      `).get(code, isAdmin ? 1 : 0, userId);
      return !!channel;
    },
    async markThreadRead(userId, parentId, isAdmin) {
      const driver = db.async || db;
      const maximum = driver.kind === 'postgres'
        ? 'GREATEST(thread_reads.last_read_reply_id, excluded.last_read_reply_id)'
        : 'MAX(thread_reads.last_read_reply_id, excluded.last_read_reply_id)';
      return driver.prepare(`
        INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id)
        SELECT ?, m.id, COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = m.id), 0)
        FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE m.id = ? AND m.thread_id IS NULL
          AND (? = 1 OR EXISTS (
            SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
          ))
        ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = ${maximum}
        RETURNING (
          SELECT c.code FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?
        ) AS channel_code
      `).get(userId, parentId, isAdmin ? 1 : 0, userId, parentId);
    },
    async threadState(userId, ids) {
      const driver = db.async || db;
      if (!ids.length) return [];
      const ph = ids.map(() => '?').join(',');
      return driver.prepare(`
        SELECT m.id AS "parentId", COALESCE(tr.last_read_reply_id, 0) AS "lastRead",
               m.channel_id, c.role_gate
        FROM messages m
        JOIN channels c ON c.id = m.channel_id
        JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
        LEFT JOIN thread_reads tr ON tr.thread_id = m.id AND tr.user_id = ?
        WHERE m.id IN (${ph}) AND m.thread_id IS NULL
      `).all(userId, userId, ...ids);
    },
  };
};
