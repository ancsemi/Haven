'use strict';

// Who hears a thread reply, and how many replies in a thread are new to you.
//
// A reply in a busy channel used to reach everyone in it with nothing to say
// where it went. A thread now belongs to the people taking part in it: the
// one who wrote the message it hangs from and everyone who has replied. Their
// ids travel with each reply (followerIds) so a client knows whether to make
// a sound without asking. Muting a forum topic takes you off its list.
//
// "New" goes by the read position kept per thread (thread_reads, #5641):
// every reply after the last one you saw that someone else wrote. It is
// counted only for threads you follow, the ones you started, opened or
// replied in; a thread you never looked at has no position to count from.

const { threadHistoryVisible } = require('./db/messageThreads');

function followerIds(db, parentId, channelId) {
  const scope = channelId === undefined ? '' : `AND m.channel_id = ? AND ${threadHistoryVisible('m')}`;
  const rows = db.prepare(`
    WITH people AS (
      SELECT user_id FROM messages m WHERE id = ? AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM messages m WHERE thread_id = ? AND user_id IS NOT NULL ${scope}
    )
    SELECT user_id FROM people
    WHERE NOT EXISTS (
      SELECT 1 FROM forum_topic_mutes f WHERE f.topic_id = ? AND f.user_id = people.user_id
    )
    ORDER BY user_id
  `).all(parentId, parentId, ...(channelId === undefined ? [] : [channelId]), parentId);
  const ids = people => people.map(row => row.user_id);
  return db.kind === 'postgres' ? rows.then(ids) : ids(rows);
}

// For each of the given threads you follow, how many replies you have not
// seen; threads you do not follow are left out, so the client keeps its own
// count for those. `threads` is [{ id, userId }] with userId the author of
// the message the thread hangs from.
function newCounts(db, userId, threads, channelId) {
  const out = new Map();
  if (!userId || !Array.isArray(threads) || threads.length === 0) return out;
  const ids = threads.map(t => t.id);
  const ph = ids.map(() => '?').join(',');
  const scope = channelId === undefined ? '' : `AND m.channel_id = ? AND ${threadHistoryVisible('m')}`;
  const counts = db.prepare(`
    SELECT p.id, tr.thread_id AS seen, COUNT(m.id) AS n
    FROM messages p
    LEFT JOIN thread_reads tr ON tr.thread_id = p.id AND tr.user_id = ?
    LEFT JOIN messages m ON m.thread_id = p.id
        AND (m.user_id IS NULL OR m.user_id != ?)
        AND m.id > COALESCE(tr.last_read_reply_id, 0) ${scope}
    WHERE p.id IN (${ph})
    GROUP BY p.id, tr.thread_id
  `).all(userId, userId, ...(channelId === undefined ? [] : [channelId]), ...ids);
  function withCounts(rows) {
    for (const thread of threads) if (thread.userId === userId) out.set(thread.id, 0);
    for (const row of rows) if (row.seen != null || out.has(row.id)) out.set(row.id, row.n);
    return out;
  }
  return db.kind === 'postgres' ? counts.then(withCounts) : withCounts(counts);
}

// The first reply under a message starts its thread, and that reaches the
// message's author like a reply to them (bell, sound, push). Returns their id,
// or null when this is not the first reply, they wrote it themselves, or they
// muted the topic. Call it after the reply is stored.
function startedFor(db, parentId, replierId, followers) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(parentId).n;
  if (n !== 1) return null;
  const parent = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(parentId);
  return firstReplyRecipient(n, parent?.user_id, replierId, followers);
}

function firstReplyRecipient(count, parentAuthor, replierId, followers) {
  if (count !== 1 || parentAuthor == null || parentAuthor === replierId) return null;
  return followers.includes(parentAuthor) ? parentAuthor : null;
}

module.exports = { followerIds, newCounts, startedFor, firstReplyRecipient };
