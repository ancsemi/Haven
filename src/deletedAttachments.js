'use strict';

// Deleted attachments are not deleted straight away. When a message or a whole
// channel goes, the files its messages pointed at are moved into
// uploads/deleted-attachments, where nothing can reach them. This module is the
// other half of that: after a retention window they are removed for good, so
// nothing that was deleted sits on the disk forever. It runs on its own clock,
// whether or not the admin has auto-cleanup switched on.

const DEFAULT_DELETED_RETENTION_DAYS = 7;
const MAX_DELETED_RETENTION_DAYS = 3650;

/**
 * The retention window in days from a raw server_settings value. Anything that
 * is not a whole number of days in range falls back to the default, so a
 * blank, missing or mangled setting never means "keep forever".
 */
function resolveDeletedRetentionDays(raw) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DELETED_RETENTION_DAYS) return DEFAULT_DELETED_RETENTION_DAYS;
  return n;
}

/**
 * Removes for good every deleted attachment that has been waiting longer
 * than `retentionDays`, counted from its deletion, as the media index
 * records it. `storage` is src/storage. Returns the number of files removed.
 * A file that cannot be removed is skipped, so one locked file cannot stop
 * the sweep, and is tried again next run.
 */
async function purgeDeletedAttachments(db, storage, retentionDays, now = Date.now()) {
  const days = resolveDeletedRetentionDays(retentionDays);
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const rows = db.prepare(`SELECT rel_path FROM media_objects
                           WHERE state = 'deleted' AND COALESCE(deleted_at, created_at) < ?`).all(cutoff);
  let removed = 0;
  let failed = 0;
  let firstError = '';
  for (const { rel_path: rel } of rows) {
    try {
      await storage.purge(rel);
      removed++;
    } catch (err) {
      failed++;
      if (!firstError) firstError = err.message;
    }
  }
  if (failed) console.warn(`deleted-attachments purge: ${failed} file(s) could not be removed, will retry next run (${firstError})`);
  return removed;
}

module.exports = {
  DEFAULT_DELETED_RETENTION_DAYS,
  MAX_DELETED_RETENTION_DAYS,
  resolveDeletedRetentionDays,
  purgeDeletedAttachments,
};
