'use strict';

function target(db, userId) {
  return db.prepare(
    'SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE u.id = ? AND b.id IS NULL'
  ).get(userId);
}

function existing(db, userId, targetId) {
  // For self-DM, the channel has only one channel_members row, so both EXISTS
  // clauses below collapse to the same check, which still matches correctly.
  // A group DM that shrank to two (or one) members is still a group, not
  // this pair's 1:1 conversation.
  return db.prepare(`
    SELECT c.id, c.code, c.name FROM channels c
    WHERE c.is_dm = 1 AND COALESCE(c.is_group, 0) = 0
    AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
    AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
    AND (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) = ?
  `).get(userId, targetId, userId === targetId ? 1 : 2);
}

function recentCount(db, userId) {
  const hourAgo = db.kind === 'postgres'
    ? "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour'"
    : "datetime('now', '-1 hour')";
  return db.prepare(`
    SELECT COUNT(*) AS n FROM channels
    WHERE created_by = ? AND is_dm = 1 AND COALESCE(is_group, 0) = 0 AND COALESCE(is_self_dm, 0) = 0
      AND created_at >= ${hourAgo}
  `).get(userId);
}

function create(db, code, userId, isSelfDm) {
  const sql = 'INSERT INTO channels (name, code, created_by, is_dm, is_self_dm) VALUES (?, ?, ?, 1, ?)';
  const params = ['DM', code, userId, isSelfDm ? 1 : 0];
  if (db.kind === 'postgres') {
    return db.prepare(sql + ' ON CONFLICT(code) DO NOTHING RETURNING id AS "lastInsertRowid"').get(...params);
  }
  return db.prepare(sql).run(...params);
}

function join(db, channelId, userId) {
  return db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, userId);
}

module.exports = { target, existing, recentCount, create, join };
