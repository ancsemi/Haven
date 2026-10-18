'use strict';

// Where uploads/ lives. Every write, move and delete of a file under
// /uploads/... goes through here, so the driver (local disk or an S3 bucket)
// is chosen in one place and the media_objects index never drifts from it.
//
// All `rel` arguments are the path after "/uploads/", with forward slashes.

const { UPLOADS_DIR } = require('../paths');
const { LocalStorage } = require('./local');
const { DELETED_PREFIX, isSafeUploadRelPath, isContainedRelPath } = require('./paths');

let driver = null;

function getStorage() {
  if (!driver) driver = new LocalStorage(UPLOADS_DIR);
  return driver;
}

// For tests: point the module at a driver of their own.
function setStorage(d) { driver = d; }

function indexDb() {
  try { return require('../database').getDb(); } catch { return null; }
}

function index(fn) {
  const db = indexDb();
  if (!db) return;
  try { fn(db); } catch (err) {
    // The index is rebuilt by reconcile; a failed write here must not fail the
    // move it describes.
    console.warn('[storage] media index write failed:', err.message);
  }
}

/** A cleaned local file becomes `rel` in storage. Throws when it cannot. */
async function admit(rel, localPath, { contentType } = {}) {
  if (!isContainedRelPath(rel)) throw new Error(`unsafe upload path: ${rel}`);
  const { size } = await getStorage().put(rel, localPath, { contentType });
  index(db => db.prepare(`INSERT INTO media_objects (rel_path, bytes, content_type, state)
                          VALUES (?, ?, ?, 'live')
                          ON CONFLICT(rel_path) DO UPDATE SET bytes = excluded.bytes,
                            content_type = excluded.content_type, state = 'live',
                            created_at = CURRENT_TIMESTAMP, deleted_at = NULL`)
    .run(rel, size, contentType || null));
  return { size };
}

/** Moves `rel` into deleted-attachments/, where it waits out the retention window. Never throws. */
async function softDelete(rel) {
  if (!isContainedRelPath(rel) || rel.startsWith(DELETED_PREFIX)) return false;
  try {
    const moved = await getStorage().softDelete(rel);
    if (moved) index(db => db.prepare("UPDATE media_objects SET state = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE rel_path = ?").run(rel));
    return moved;
  } catch (err) {
    // Anything here leaves the file live after its message was deleted, so say so.
    console.warn(`[uploads] Could not move ${rel} to deleted-attachments:`, err.message);
    return false;
  }
}

/** Gone for good, never held for recovery. Never throws. */
async function remove(rel) {
  if (!isContainedRelPath(rel)) return;
  try {
    await getStorage().remove(rel);
    index(db => db.prepare("DELETE FROM media_objects WHERE rel_path = ? AND state = 'live'").run(rel));
  } catch (err) {
    console.warn(`[uploads] Could not remove ${rel}:`, err.message);
  }
}

/** Removes the deleted-attachments/ copy of `rel` for good. Throws, so a purge can count failures. */
async function purge(rel) {
  await getStorage().remove(DELETED_PREFIX + rel);
  index(db => db.prepare("DELETE FROM media_objects WHERE rel_path = ? AND state = 'deleted'").run(rel));
}

/** Brings `rel` back from deleted-attachments/. */
async function restore(rel) {
  if (!isContainedRelPath(rel)) return false;
  const back = await getStorage().restore(rel);
  if (back) index(db => db.prepare("UPDATE media_objects SET state = 'live', deleted_at = NULL WHERE rel_path = ?").run(rel));
  return back;
}

module.exports = {
  getStorage, setStorage, admit, softDelete, remove, purge, restore,
  head: (rel) => getStorage().head(rel),
  getStream: (rel, opts) => getStorage().getStream(rel, opts),
  readBuffer: (rel) => getStorage().readBuffer(rel),
  list: (prefix) => getStorage().list(prefix),
  ping: () => getStorage().ping(),
  DELETED_PREFIX, isSafeUploadRelPath, isContainedRelPath,
};
