'use strict';

// Deleted attachments are not deleted straight away. When a message or a whole
// channel goes, the files its messages pointed at are moved into
// uploads/deleted-attachments, where nothing can reach them. This module is the
// other half of that: after a retention window they are removed for good, so
// nothing that was deleted sits on the disk forever. It runs on its own clock,
// whether or not the admin has auto-cleanup switched on.

const fs = require('fs');
const path = require('path');

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
 * Removes every file under `dir` whose modification time is older than
 * `retentionDays`, walking sub-folders too (moved files keep their original
 * folder layout), and prunes any sub-folder that ends up empty. The root is
 * left in place. Returns the number of files removed. Errors on individual
 * entries are skipped so one locked file cannot stop the sweep.
 */
function purgeDeletedAttachments(dir, retentionDays, now = Date.now()) {
  const days = resolveDeletedRetentionDays(retentionDays);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;

  const walk = (folder, isRoot) => {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full, false);
        } else if (entry.isFile()) {
          const st = fs.statSync(full);
          if (st.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            removed++;
          }
        }
      } catch { /* skip this entry */ }
    }
    if (!isRoot) {
      try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* leave it */ }
    }
  };

  if (!dir || !fs.existsSync(dir)) return 0;
  walk(dir, true);
  return removed;
}

module.exports = {
  DEFAULT_DELETED_RETENTION_DAYS,
  MAX_DELETED_RETENTION_DAYS,
  resolveDeletedRetentionDays,
  purgeDeletedAttachments,
};
