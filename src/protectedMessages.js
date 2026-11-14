'use strict';

// Protected messages (messages.is_archived = 1, "Protect" in the message
// menu) are kept for history and evidence. No delete removes one: not its
// author, a moderator, a bot or the admin, and no bulk or automatic cleanup.
// Unprotecting it (unarchive-message) is the one way back.
//
// A thread reply goes with the message it hangs from (thread_id is ON DELETE
// CASCADE), so a thread head that holds a protected reply is kept as well.
// Its other replies can still go.
//
// installGuard adds a trigger that refuses to delete a protected row, so a
// path that misses these checks (a channel or account cascade included)
// fails instead of losing the message.

const REFUSAL = 'This message is protected. Unprotect it first.';
const THREAD_REFUSAL = 'This thread holds a protected reply. Unprotect it first.';
const CHANNEL_REFUSAL = 'This channel holds protected messages. Unprotect them first, or ask the admin.';
const CONVERSATION_REFUSAL = 'This conversation holds protected messages. Unprotect them first, or ask the admin.';

/** Why message `id` cannot be deleted, or null when it can. A failed check
 *  refuses. */
function refusal(db, id) {
  try {
    const row = protectionFor(db, id);
    if (!row || !row.kept) return null;
    return row.is_archived ? REFUSAL : THREAD_REFUSAL;
  } catch (err) {
    console.warn('[protected] message check failed, keeping it:', err.message);
    return REFUSAL;
  }
}

function protectionFor(db, id) {
  return db.prepare(`SELECT m.is_archived, ${keptSql('m')} AS kept FROM messages m WHERE m.id = ?`).get(id);
}

/** SQL that is true for a message row (table alias `alias`) that must stay. */
function keptSql(alias = 'm') {
  return `(${alias}.is_archived = 1 OR EXISTS (SELECT 1 FROM messages pkr WHERE pkr.thread_id = ${alias}.id AND pkr.is_archived = 1))`;
}

/** SQL that is true for a message row that may be deleted. */
function deletableSql(alias = 'm') {
  return `NOT ${keptSql(alias)}`;
}

/** How many messages in these channels must stay: protected ones, and
 *  thread heads whose protected reply sits elsewhere. A failed check counts
 *  as one, so the caller keeps the channel. */
function protectedCount(db, channelIds) {
  const ids = (channelIds || []).filter(Number.isInteger);
  if (!ids.length) return 0;
  try {
    const ph = ids.map(() => '?').join(',');
    return db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.channel_id IN (${ph}) AND ${keptSql('m')}`).get(...ids).n;
  } catch (err) {
    console.warn('[protected] channel check failed, keeping it:', err.message);
    return 1;
  }
}

/** Delete a channel's messages except the ones that must stay, with their
 *  reactions and pins. Returns how many went. Runs inside the caller's
 *  transaction when there is one. */
function clearUnprotected(db, channelId) {
  const doomed = `SELECT m.id FROM messages m WHERE m.channel_id = ? AND ${deletableSql('m')}`;
  db.prepare(`DELETE FROM reactions WHERE message_id IN (${doomed})`).run(channelId);
  db.prepare(`DELETE FROM pinned_messages WHERE message_id IN (${doomed})`).run(channelId);
  return db.prepare(`DELETE FROM messages WHERE id IN (${doomed})`).run(channelId).changes;
}

/** An automatic delete found protected messages in this channel: clear the
 *  rest, keep the channel and turn its timer off, so it is not tried again.
 *  Returns how many messages went. */
function keepChannel(db, channel, why) {
  const removed = db.transaction(() => {
    const n = clearUnprotected(db, channel.id);
    db.prepare('UPDATE channels SET expires_at = NULL, is_temp_voice = 0 WHERE id = ?').run(channel.id);
    return n;
  })();
  console.log(`[protected] Kept channel "${channel.code}" (${why}): it holds protected messages. Cleared ${removed} other message(s) and turned its timer off.`);
  return removed;
}

function installGuard(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_keep_protected
    BEFORE DELETE ON messages
    WHEN OLD.is_archived = 1
    BEGIN
      SELECT RAISE(ABORT, 'protected message');
    END;
  `);
}

module.exports = {
  REFUSAL, THREAD_REFUSAL, CHANNEL_REFUSAL, CONVERSATION_REFUSAL,
  keptSql, deletableSql, protectionFor, refusal, protectedCount, clearUnprotected, keepChannel, installGuard,
};
