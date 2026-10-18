'use strict';

// The one place a file under uploads/ is moved aside or removed. The socket
// handlers used to carry their own copies of these, which skipped the time
// stamp below, so a deleted old attachment was purged at the next sweep
// instead of after the retention window.

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('./paths');

function isSafeUploadRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (!/^((?!\.\.)(?!\.\/)(?!\/)[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relPath)) return false;
  const parts = relPath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  return true;
}

function moveUploadToDeleted(relPath) {
  if (!isSafeUploadRelPath(relPath)) return;
  const src = path.join(UPLOADS_DIR, relPath);
  if (!fs.existsSync(src)) return;
  let stat;
  try {
    stat = fs.statSync(src);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  const dst = path.join(DELETED_ATTACHMENTS_DIR, relPath);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    // A rename keeps the upload's own timestamp. The retention window counts
    // from the deletion, so stamp the file now.
    try { const now = new Date(); fs.utimesSync(dst, now, now); } catch { /* purge falls back to the upload time */ }
  } catch (err) {
    // Already moved by another path is fine; anything else leaves the file
    // live in uploads/ after its message was deleted, so say so.
    if (err.code !== 'ENOENT') console.warn(`[uploads] Could not move ${relPath} to deleted-attachments:`, err.message);
  }
}

// For files an admin chose not to keep: gone for good, never held for recovery.
function removeUpload(relPath) {
  if (!isSafeUploadRelPath(relPath)) return;
  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, relPath));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[uploads] Could not remove ${relPath}:`, err.message);
  }
}

module.exports = { isSafeUploadRelPath, moveUploadToDeleted, removeUpload };
