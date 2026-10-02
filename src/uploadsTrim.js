'use strict';

// Auto-Cleanup's uploads limit: when the uploads folder grows past the size
// the admin set, the oldest messages that carry files are removed, oldest
// first, until the files they free bring it back under. Their files go to
// deleted-attachments like any other delete, and leave for good once the
// "Keep deleted files for" window has passed. Archived and pinned messages
// and cleanup-exempt channels are never touched, and neither is anything a
// message doesn't point at (avatars, emoji, stickers, sounds, the icon).

const fs = require('fs');
const path = require('path');

const SKIP_TOP_DIRS = new Set(['deleted-attachments']);
const BATCH = 200;

/** Bytes used under uploads/, not counting deleted-attachments. */
async function uploadsSizeBytes(uploadsDir) {
  let total = 0;
  const walk = async (dir, top) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (top && SKIP_TOP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, false);
      else if (e.isFile()) {
        try { total += (await fs.promises.stat(full)).size; } catch { /* gone meanwhile */ }
      }
    }
  };
  await walk(uploadsDir, true);
  return total;
}

function e2ePaths(value) {
  if (typeof value !== 'string' || !value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter(p => typeof p === 'string') : [];
  } catch { return []; }
}

let running = false;

/**
 * Bring the uploads folder under maxBytes by removing the oldest messages
 * with files. extractPaths(content) returns the upload paths a message body
 * points at; move(relPath) sends one file to deleted-attachments. Encrypted
 * DM files are released by the messages_release_e2e_files trigger when their
 * message goes, so they need no move here.
 * @returns {Promise<{deleted:number, before:number, after:number}>}
 */
async function trimUploadsToLimit({ db, uploadsDir, maxBytes, extractPaths, move, maxMessages = 5000 }) {
  if (running || !(maxBytes > 0)) return { deleted: 0, before: 0, after: 0 };
  running = true;
  try {
    const before = await uploadsSizeBytes(uploadsDir);
    let size = before;
    let deleted = 0;
    if (size <= maxBytes) return { deleted, before, after: size };

    const pick = db.prepare(`
      SELECT id, content, e2e_files, created_at FROM messages
      WHERE (content LIKE '%/uploads/%' OR e2e_files IS NOT NULL)
        AND is_archived = 0
        AND id NOT IN (SELECT message_id FROM pinned_messages)
        AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT ?`);
    const stillUsed = db.prepare("SELECT 1 FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT 1");
    const delReactions = db.prepare('DELETE FROM reactions WHERE message_id = ?');
    const delMessage = db.prepare('DELETE FROM messages WHERE id = ?');

    let cursor = { at: '', id: 0 };
    const counted = new Set();
    while (size > maxBytes && deleted < maxMessages) {
      const rows = pick.all(cursor.at, cursor.at, cursor.id, BATCH);
      if (!rows.length) break;

      const doomed = [];
      const contentFiles = new Set();
      let freed = 0;
      for (const row of rows) {
        cursor = { at: row.created_at, id: row.id };
        const own = [...extractPaths(row.content), ...e2ePaths(row.e2e_files)];
        let rowBytes = 0;
        for (const rel of own) {
          if (counted.has(rel)) continue;
          try {
            const st = await fs.promises.stat(path.join(uploadsDir, rel));
            if (st.isFile()) { rowBytes += st.size; counted.add(rel); }
          } catch { /* not on this server, or already gone */ }
        }
        // A message whose files are already gone frees nothing, so it stays.
        if (rowBytes === 0) continue;
        doomed.push(row.id);
        for (const rel of extractPaths(row.content)) contentFiles.add(rel);
        freed += rowBytes;
        if (size - freed <= maxBytes || deleted + doomed.length >= maxMessages) break;
      }

      if (doomed.length) {
        db.transaction(() => {
          for (const id of doomed) { delReactions.run(id); delMessage.run(id); }
        })();
        deleted += doomed.length;
        // A file can be linked from more than one message; it only moves
        // once nothing left points at it.
        for (const rel of contentFiles) {
          const like = '%/uploads/' + rel.replace(/[\\%_]/g, '\\$&') + '%';
          if (!stillUsed.get(like)) move(rel);
        }
        size -= freed;
      }
    }
    return { deleted, before, after: Math.max(0, size) };
  } finally {
    running = false;
  }
}

module.exports = { uploadsSizeBytes, trimUploadsToLimit };
