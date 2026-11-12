'use strict';

// A forum's unread dot in the sidebar. Replies to topics never count as new
// messages in the channel (they live in the topic's own thread), so a forum
// needs its own count: the topics this person has not caught up on, leaving
// out the topics they muted.
//
// "Not caught up" is the same rule the topic cards use (messages.js): a topic
// never opened is unread unless it is your own with no replies yet, and an
// opened one is unread when a reply landed after the last one you saw.

const CAP = 100;

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_topic_mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, topic_id)
    );
  `);
}

function count(db, userId, channelId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM messages m
      LEFT JOIN thread_reads tr ON tr.thread_id = m.id AND tr.user_id = @u
      WHERE m.channel_id = @c AND m.thread_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM forum_topic_mutes f WHERE f.user_id = @u AND f.topic_id = m.id)
        AND (CASE WHEN tr.thread_id IS NULL
               THEN (COALESCE(m.user_id, 0) != @u OR EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.id))
               ELSE COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = m.id), 0) > tr.last_read_reply_id
             END)
      LIMIT ${CAP}
    )
  `).get({ u: userId, c: channelId });
  return row ? row.n : 0;
}

// The count walks every topic in the forum, and it runs for every forum in
// every channel list sent out. Most of the time nothing it depends on has
// changed since the last count, so each person's result is kept against a
// signature of the forum (its messages) and of what they have read and muted;
// a new reply, a read or a mute changes the signature and the next ask
// counts again.
const cache = new Map();
const CACHE_MAX = 20000;

function signature(db, userId, channelId) {
  const msgs = db.prepare('SELECT COALESCE(MAX(id), 0) AS m, COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId);
  const reads = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(last_read_reply_id), 0) AS s FROM thread_reads WHERE user_id = ?').get(userId);
  const mutes = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(topic_id), 0) AS s, COALESCE(SUM(topic_id * topic_id), 0) AS q FROM forum_topic_mutes WHERE user_id = ?').get(userId);
  return `${msgs.m}:${msgs.n}:${reads.n}:${reads.s}:${mutes.n}:${mutes.s}:${mutes.q}`;
}

function countCached(db, userId, channelId) {
  const key = `${userId}:${channelId}`;
  const sig = signature(db, userId, channelId);
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.n;
  const n = count(db, userId, channelId);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { sig, n });
  return n;
}

// Topics folded into another topic's thread (moveToThread.js) leave the
// forum without changing its messages, so the signature above cannot see it:
// every count kept for that forum is dropped.
function forget(channelId) {
  const suffix = `:${channelId}`;
  for (const key of cache.keys()) if (key.endsWith(suffix)) cache.delete(key);
}

function mutedIn(db, userId, topicIds) {
  if (!topicIds || !topicIds.length) return new Set();
  const ph = topicIds.map(() => '?').join(',');
  return new Set(db.prepare(`SELECT topic_id FROM forum_topic_mutes WHERE user_id = ? AND topic_id IN (${ph})`)
    .all(userId, ...topicIds).map(r => r.topic_id));
}

function setMute(db, userId, topicId, muted) {
  if (muted) db.prepare('INSERT OR IGNORE INTO forum_topic_mutes (user_id, topic_id) VALUES (?, ?)').run(userId, topicId);
  else db.prepare('DELETE FROM forum_topic_mutes WHERE user_id = ? AND topic_id = ?').run(userId, topicId);
}

async function countAsync(db, userId, channelId) {
  // SQLite retains its existing signature cache and synchronous reads.
  if (db.async.kind === 'sqlite') return countCached(db, userId, channelId);
  const row = await db.async.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM messages m
      LEFT JOIN thread_reads tr ON tr.thread_id = m.id AND tr.user_id = ?
      WHERE m.channel_id = ? AND m.thread_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM forum_topic_mutes f WHERE f.user_id = ? AND f.topic_id = m.id)
        AND (CASE WHEN tr.thread_id IS NULL
               THEN (COALESCE(m.user_id, 0) != ? OR EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.id))
               ELSE COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = m.id), 0) > tr.last_read_reply_id
             END)
      LIMIT ${CAP}
    ) AS unread_topics
  `).get(userId, channelId, userId, userId);
  return row ? row.n : 0;
}

module.exports = { ensureTable, count, countAsync, countCached, forget, mutedIn, setMute };
