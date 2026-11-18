'use strict';

function savePreference(db, userId, key, value) {
  const sql = db.kind === 'postgres'
    ? 'INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'
    : 'INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)';
  return db.prepare(sql).run(userId, key, value);
}

function deletePreference(db, userId, key) {
  return db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').run(userId, key);
}

function nicknameUpsert(db) {
  return db.prepare(
    'INSERT INTO user_nicknames (owner_id, target_id, nickname) VALUES (?, ?, ?) ON CONFLICT(owner_id, target_id) DO UPDATE SET nickname = excluded.nickname'
  );
}

function deleteNickname(db, ownerId, targetId) {
  return db.prepare('DELETE FROM user_nicknames WHERE owner_id = ? AND target_id = ?').run(ownerId, targetId);
}

function nicknameEntries(map) {
  const entries = [];
  for (const [rawId, nick] of Object.entries(map).slice(0, 500)) {
    const targetId = parseInt(rawId, 10);
    if (!Number.isFinite(targetId) || targetId <= 0 || typeof nick !== 'string' || !nick.trim()) continue;
    entries.push([targetId, nick.trim().slice(0, 32)]);
  }
  return entries;
}

// Serialize PostgreSQL writes that replace or merge an account's lists.
function lockUserPreferences(db, userId) {
  return db.prepare('SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE').get(userId);
}

module.exports = { savePreference, deletePreference, nicknameUpsert, deleteNickname, nicknameEntries, lockUserPreferences };
