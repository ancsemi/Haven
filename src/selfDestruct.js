'use strict';

// Self-destructing messages. A message sent with a timer carries destruct_at;
// once that passes, the message goes, and its files go the way a deleted
// message's do: only the sender's own, only when nothing else still uses
// them (a link in another message does not count), and into
// deleted-attachments for the usual retention window, so a moderator can
// still recover something abusive posted on a short timer.
// An admin can turn that off (keep_self_destructed_attachments), and then the
// files are removed for good instead.
//
// One timer waits for the soonest deadline. When it fires it deletes what is
// due and waits for the next one, or sleeps when none is left. A new message
// with a sooner deadline wakes it (schedule), and deleting the message it is
// waiting for moves it on (forget). It runs once at startup, so anything that
// came due while the server was down goes first.

const { releasableUploads } = require('./socketHandlers/helpers');

const MAX_DESTRUCT_SECONDS = 24 * 60 * 60;
// When a due message could not be deleted, try again after this instead of
// firing again at once in a loop.
const RETRY_MS = 30 * 1000;

let run = null;       // set by start()
let timer = null;
let armedFor = null;  // ms of the deadline the timer is waiting for, null while asleep

/** destruct_at for a requested timer, or null when there is none or it is out of range. */
function destructAtFromSeconds(raw) {
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs < 1 || secs > MAX_DESTRUCT_SECONDS) return null;
  return new Date(Date.now() + Math.round(secs) * 1000).toISOString();
}

function arm(at) {
  clearTimeout(timer);
  timer = null;
  armedFor = Number.isFinite(at) ? at : null;
  if (armedFor !== null) timer = setTimeout(run, Math.max(0, armedFor - Date.now()));
}

/** A self-destructing message was sent: wake up if it is due sooner. */
function schedule(destructAt) {
  const at = Date.parse(destructAt);
  if (run && Number.isFinite(at) && (armedFor === null || at < armedFor)) arm(at);
}

/** A self-destructing message was deleted early. Only the one the timer is
 *  waiting for matters; then it waits for the next, or sleeps. */
function forget(destructAt) {
  if (run && armedFor !== null && Date.parse(destructAt) === armedFor) run();
}

function start({ db, io, UPLOAD_PATH_RE, moveUploadToDeleted, removeUpload }) {
  const due = db.prepare(`
    SELECT m.id, m.user_id, m.content, c.code
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.destruct_at IS NOT NULL AND m.destruct_at <= ?
    ORDER BY m.destruct_at ASC LIMIT 200
  `);
  const next = db.prepare('SELECT MIN(destruct_at) AS at FROM messages WHERE destruct_at IS NOT NULL');
  const keepSetting = db.prepare("SELECT value FROM server_settings WHERE key = 'keep_self_destructed_attachments'");
  const removeOne = db.transaction((id) => {
    db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  });

  const sweep = () => {
    let rows;
    try { rows = due.all(new Date().toISOString()); } catch (err) {
      console.error('[self-destruct] query error:', err.message);
      return 0;
    }
    // Only an explicit off removes for good; an unreadable setting keeps.
    let dispose = moveUploadToDeleted;
    try {
      if (keepSetting.get()?.value === 'false') dispose = removeUpload;
    } catch (err) {
      console.error('[self-destruct] setting read error:', err.message);
    }
    let removed = 0;
    for (const row of rows) {
      try {
        removeOne(row.id);
        UPLOAD_PATH_RE.lastIndex = 0;
        const paths = [];
        let m;
        while ((m = UPLOAD_PATH_RE.exec(row.content || '')) !== null) paths.push(m[1]);
        // Someone else's file named in the message is never touched, and a
        // file a profile still uses stays. A link in another message does
        // not keep it, or pasting the link would beat the timer.
        for (const rel of releasableUploads(db, paths, [row.user_id], { ignoreMessages: true })) dispose(rel);
        io.to(`channel:${row.code}`).emit('message-deleted', { channelCode: row.code, messageId: row.id });
        removed++;
      } catch (err) {
        console.error('[self-destruct] delete error:', err.message);
      }
    }
    return removed;
  };

  // Wait for the soonest deadline left. One already past means more than a
  // batch was due (go again now) or a row would not delete (back off).
  const rearm = (removed) => {
    let at = null;
    let failed = false;
    try { at = Date.parse(next.get()?.at || ''); } catch (err) {
      // A busy database must not put the timer to sleep with messages
      // still waiting; look again shortly.
      console.error('[self-destruct] query error:', err.message);
      failed = true;
    }
    if (failed || (at <= Date.now() && !removed)) at = Date.now() + RETRY_MS;
    arm(at);
  };

  run = () => rearm(sweep());
  run();
}

/** Stop the timer (tests, shutdown). */
function stop() {
  arm(null);
  run = null;
}

module.exports = { MAX_DESTRUCT_SECONDS, destructAtFromSeconds, start, schedule, forget, stop };
