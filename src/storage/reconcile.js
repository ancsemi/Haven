'use strict';

// Rebuilds the media_objects index from what storage actually holds. Run
// once when an install first gets the index, and by hand
// (scripts/reconcile-media.js) whenever something wrote to uploads/ behind
// Haven's back. Objects missing from the index are added, index rows whose
// object is gone are dropped, and sizes and states are corrected.

const { DELETED_PREFIX } = require('./paths');

const SKIP_PREFIX = 'bot-audio/';   // temporary, never part of media storage
const toSqlTime = (d) => new Date(d).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

async function reconcile(db, storage) {
  // Haven keeps running while this lists storage, so a row written after the
  // listing began describes a file it may have walked past. Those rows are
  // the newest truth and are left as they are.
  const startedAt = toSqlTime(Date.now());
  // rel → { bytes, state, at } as storage has it. A live object wins over a
  // deleted copy under the same name.
  const found = new Map();
  for await (const obj of storage.list('')) {
    if (obj.rel.startsWith(SKIP_PREFIX)) continue;
    const deleted = obj.rel.startsWith(DELETED_PREFIX);
    const rel = deleted ? obj.rel.slice(DELETED_PREFIX.length) : obj.rel;
    if (!rel) continue;
    if (deleted && found.get(rel)?.state === 'live') continue;
    found.set(rel, { bytes: obj.size, state: deleted ? 'deleted' : 'live', at: obj.lastModified });
  }

  const rows = new Map(db.prepare('SELECT rel_path, bytes, state, created_at, deleted_at FROM media_objects').all().map(r => [r.rel_path, r]));
  const touchedSince = (row) => (row.created_at && row.created_at >= startedAt) || (row.deleted_at && row.deleted_at >= startedAt);
  const insert = db.prepare(`INSERT INTO media_objects (rel_path, bytes, state, created_at, deleted_at)
                             VALUES (?, ?, ?, ?, ?)`);
  const fix = db.prepare(`UPDATE media_objects SET bytes = ?, state = ?,
                            deleted_at = CASE WHEN ? = 'deleted' THEN COALESCE(deleted_at, ?) ELSE NULL END
                          WHERE rel_path = ?`);
  const drop = db.prepare('DELETE FROM media_objects WHERE rel_path = ?');
  const summary = { added: 0, fixed: 0, dropped: 0, objects: found.size };

  db.transaction(() => {
    for (const [rel, obj] of found) {
      const row = rows.get(rel);
      const at = toSqlTime(obj.at);
      if (!row) {
        insert.run(rel, obj.bytes, obj.state, at, obj.state === 'deleted' ? at : null);
        summary.added++;
      } else if (touchedSince(row)) {
        continue;
      } else if (row.bytes !== obj.bytes || row.state !== obj.state) {
        fix.run(obj.bytes, obj.state, obj.state, at, rel);
        summary.fixed++;
      }
    }
    for (const [rel, row] of rows) {
      if (!found.has(rel) && !touchedSince(row)) { drop.run(rel); summary.dropped++; }
    }
  })();
  return summary;
}

module.exports = { reconcile };
