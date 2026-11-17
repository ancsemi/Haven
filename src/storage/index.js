'use strict';

// Where uploads/ lives. Every write, move and delete of a file under
// /uploads/... goes through here, so the driver (local disk or an S3 bucket)
// is chosen in one place and the media_objects index never drifts from it.
//
// All `rel` arguments are the path after "/uploads/", with forward slashes.

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('../paths');
const { LocalStorage } = require('./local');
const { DELETED_PREFIX, isSafeUploadRelPath, isContainedRelPath } = require('./paths');

let driver = null;

// HAVEN_EXTERNAL_STORAGE=true keeps media in an S3-compatible bucket;
// anything else is the local uploads/ folder. Read once.
function fromEnv(env = process.env) {
  if (String(env.HAVEN_EXTERNAL_STORAGE || '').trim().toLowerCase() !== 'true') return new LocalStorage(UPLOADS_DIR);
  const required = ['HAVEN_S3_ENDPOINT', 'HAVEN_S3_BUCKET', 'HAVEN_S3_ACCESS_KEY', 'HAVEN_S3_SECRET_KEY'];
  const missing = required.filter(k => !String(env[k] || '').trim());
  if (missing.length) throw new Error(`HAVEN_EXTERNAL_STORAGE is on but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
  const on = (v, dflt) => (v === undefined || v === '' ? dflt : String(v).trim().toLowerCase() === 'true');
  const { S3Storage } = require('./s3');
  return new S3Storage({
    endpoint: env.HAVEN_S3_ENDPOINT.trim(),
    bucket: env.HAVEN_S3_BUCKET.trim(),
    region: (env.HAVEN_S3_REGION || '').trim() || 'us-east-1',
    accessKeyId: env.HAVEN_S3_ACCESS_KEY.trim(),
    secretAccessKey: env.HAVEN_S3_SECRET_KEY.trim(),
    prefix: (env.HAVEN_S3_PREFIX || '').trim().replace(/^\/+/, ''),
    forcePathStyle: on(env.HAVEN_S3_FORCE_PATH_STYLE, true),
    local: on(env.HAVEN_S3_LOCAL_FALLBACK, false) ? new LocalStorage(UPLOADS_DIR) : null,
  });
}

function getStorage() {
  if (!driver) driver = fromEnv();
  return driver;
}

// For tests: point the module at a driver of their own.
function setStorage(d) { driver = d; }

function indexDb() {
  try {
    return require('../database').getDb();
  } catch {
    return null; // no database yet (scripts, early start): the index is rebuilt by reconcile
  }
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

/**
 * A route's checked upload (req.file from privacyPass.diskStorage) goes into
 * storage as `name`, the route's final name for it in the same staging
 * folder. Returns the rel path. On failure the staged copy is removed and the
 * error thrown, so the route answers 500 and nothing is left behind.
 */
async function admitUpload(file, name = file.filename) {
  const staged = path.join(path.dirname(file.path), name);
  const rel = file.relDir ? `${file.relDir}/${name}` : name;
  try {
    await admit(rel, staged, { contentType: file.mimetype });
  } catch (err) {
    console.error(`[uploads] Could not store ${rel}:`, err.message);
    try { fs.unlinkSync(staged); } catch { /* never written, or already gone */ }
    throw err;
  }
  return rel;
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

/**
 * Before the server takes requests: storage must answer, and an install that
 * predates the media index gets it built from what storage holds. Throws with
 * a message fit for the console when storage cannot be used.
 */
async function prepare(db) {
  const s = getStorage();
  try { await s.ping(); } catch (err) {
    throw new Error(`[storage] Cannot use ${s.describe ? s.describe() : s.root}: ${err.message}`);
  }
  // A restored backup put its files back on disk (src/routes/backup.js); on a
  // bucket they go on to it now. The flag stays until every file made it.
  const restored = db.prepare("SELECT 1 FROM server_settings WHERE key = 'media_restore_pending'").get();
  if (restored) {
    let sent = true;
    if (s.kind === 's3') {
      console.log('[storage] Copying the restored backup\'s files into the bucket…');
      const r = await require('./migrate').pushLocalToBucket(s, { deleteLocal: true, log: (m) => console.log(m) });
      sent = !r.failed;
      console.log(`[storage] Restored files: ${r.sent} copied to the bucket, ${r.files - r.sent} already there${r.failed ? `, ${r.failed} failed and stay on disk; the next start tries again` : ''}`);
    }
    if (sent) db.prepare("DELETE FROM server_settings WHERE key = 'media_restore_pending'").run();
  }
  if (s.kind === 's3') {
    console.log(`[storage] Media is kept in the ${s.describe()}`);
    if (!s.local) {
      let stranded = 0;
      for await (const f of new LocalStorage(UPLOADS_DIR).list('')) if (!f.rel.startsWith('bot-audio/')) stranded++;
      if (stranded) console.warn(`[storage] ${stranded} file(s) in ${UPLOADS_DIR} are not being served; run scripts/migrate-uploads-to-s3.js, or set HAVEN_S3_LOCAL_FALLBACK=true while you do`);
    }
  }
  // A bucket is set up on purpose and its index comes first. On the uploads
  // folder, the server starts at once and keepIndexed builds it afterwards,
  // so a big or slow disk never holds up the start.
  if (s.kind === 's3') await buildIndex(db, s);
}

async function buildIndex(db, s = getStorage()) {
  if (db.prepare("SELECT 1 FROM server_settings WHERE key = 'media_index_built'").get()) return;
  console.log('[storage] Listing existing uploads (one time)…');
  const { reconcile } = require('./reconcile');
  const r = await reconcile(db, s);
  db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('media_index_built', '1')").run();
  console.log(`[storage] Indexed ${r.objects} existing upload(s)`);
}

/**
 * After the server is listening: the one-time index build, then a fresh
 * reconcile once a day on the uploads folder, so a file put there or removed
 * behind Haven's back is counted, trimmed and purged like the rest. A bucket
 * is reconciled by hand (scripts/reconcile-media.js), since listing one costs
 * requests. Never throws.
 */
function keepIndexed(db) {
  const run = async (first) => {
    try {
      if (first) await buildIndex(db);
      else {
        const r = await require('./reconcile').reconcile(db, getStorage());
        if (r.added || r.fixed || r.dropped) console.log(`[storage] Daily check of uploads: ${r.added} added, ${r.fixed} corrected, ${r.dropped} gone`);
      }
    } catch (err) {
      console.warn('[storage] Could not index uploads:', err.message);
    }
  };
  setImmediate(() => run(true));
  if (getStorage().kind === 'local') setInterval(() => run(false), 24 * 60 * 60 * 1000).unref();
}

// The privacy sweep rewrites and holds back files where they lie; these keep
// the index in step with it.
function noteSize(rel, bytes) {
  index(db => db.prepare('UPDATE media_objects SET bytes = ? WHERE rel_path = ?').run(bytes, rel));
}
function noteHeld(rel) {
  index(db => db.prepare('DELETE FROM media_objects WHERE rel_path = ?').run(rel));
}
function noteBack(rel, bytes, state = 'live') {
  index(db => db.prepare(`INSERT INTO media_objects (rel_path, bytes, state, deleted_at)
                          VALUES (?, ?, ?, CASE WHEN ? = 'deleted' THEN CURRENT_TIMESTAMP END)
                          ON CONFLICT(rel_path) DO UPDATE SET bytes = excluded.bytes, state = excluded.state`)
    .run(rel, bytes, state, state));
}

module.exports = {
  getStorage, setStorage, fromEnv, prepare, buildIndex, keepIndexed, admit, admitUpload, softDelete, remove, purge, restore,
  noteSize, noteHeld, noteBack,
  head: (rel) => getStorage().head(rel),
  getStream: (rel, opts) => getStorage().getStream(rel, opts),
  readBuffer: (rel) => getStorage().readBuffer(rel),
  list: (prefix) => getStorage().list(prefix),
  ping: () => getStorage().ping(),
  DELETED_PREFIX, isSafeUploadRelPath, isContainedRelPath,
};
