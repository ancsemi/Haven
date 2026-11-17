'use strict';

// Removing everything one person wrote in the server's channels: the "Scrub
// messages" of a kick or a ban, and the Scrub button on the banned list.
//
// It used to delete the rows and stop there. Nobody's screen was told, so the
// spam stayed in front of everyone until they reloaded, which looked like the
// scrub had done nothing. Their files stayed in uploads too. Now:
//  - their messages go, in one channel or in every channel of the server.
//    Protected messages stay (src/protectedMessages.js), and so do DMs and
//    group DMs, which belong to the people they talked with
//  - replies under their messages go with them (ON DELETE CASCADE), as in
//    any delete, and every author's own files go to deleted-attachments
//  - each channel gets one messages-purged, which takes that author's rows
//    off every open screen and reloads the channel

const { deletableSql } = require('./protectedMessages');
const { releasableUploads } = require('./socketHandlers/helpers');

const UPLOAD_PATH_RE = /\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;

function uploadsIn(content) {
  const out = [];
  UPLOAD_PATH_RE.lastIndex = 0;
  let m;
  while ((m = UPLOAD_PATH_RE.exec(content || '')) !== null) out.push(m[1]);
  return out;
}

/**
 * Deletes what `userId` wrote in the server's channels, or only in
 * `channelId`. Returns { deleted, channels }.
 */
async function scrubUserMessages({ db, io }, userId, { channelId = null } = {}) {
  const where = `m.user_id = ? AND ${deletableSql('m')} AND c.is_dm = 0${channelId ? ' AND m.channel_id = ?' : ''}`;
  const args = channelId ? [userId, channelId] : [userId];
  const rows = db.prepare(`SELECT m.id, m.content, c.code FROM messages m JOIN channels c ON c.id = m.channel_id WHERE ${where}`).all(...args);
  if (!rows.length) return { deleted: 0, channels: 0 };

  // Other people's replies under these messages go with them; read them first.
  const repliesQ = db.prepare('SELECT user_id, content FROM messages WHERE thread_id = ? AND user_id IS NOT ?');
  const replies = [];
  for (const r of rows) replies.push(...repliesQ.all(r.id, userId));

  const delPin = db.prepare('DELETE FROM pinned_messages WHERE message_id = ?');
  const delRx = db.prepare('DELETE FROM reactions WHERE message_id = ?');
  const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) { delPin.run(r.id); delRx.run(r.id); delMsg.run(r.id); }
  })();

  const storage = require('./storage');
  const own = rows.flatMap(r => uploadsIn(r.content));
  for (const rel of releasableUploads(db, own, [userId])) await storage.softDelete(rel);
  for (const r of replies) {
    if (!Number.isInteger(r.user_id)) continue;
    for (const rel of releasableUploads(db, uploadsIn(r.content), [r.user_id])) await storage.softDelete(rel);
  }

  const codes = new Set(rows.map(r => r.code));
  if (io) for (const code of codes) io.to(`channel:${code}`).emit('messages-purged', { channelCode: code, userId });
  return { deleted: rows.length, channels: codes.size };
}

module.exports = { scrubUserMessages };
