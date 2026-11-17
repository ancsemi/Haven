'use strict';

// The privacy pass: location data comes out of every photo and video before
// anyone else can see it.
//
// Phones write GPS coordinates into photos and videos, and until this pass
// every upload kept them, so anyone who could see a picture could find where
// it was taken. This cannot be switched off.
//
// exiftool and ffmpeg are optional. Without them, JPEG, PNG and WebP photos
// are cleaned by Haven's own code (src/imageMetadata.js) and other files go
// through as before, so a server works the same with or without them.
//
// Why exiftool and ffmpeg rather than our own code: both are tried and true,
// kept up to date as cameras and phones change their formats, and thorough,
// which is the whole job here. exiftool knows where every camera hides GPS
// (EXIF, XMP, IPTC, maker notes, Apple and Android video tags, the timed
// location tracks dashcams and action cameras record) and can read and write
// all of it. ffmpeg rewrites a video keeping only its picture and sound.
//
// How a file is handled:
//   1. exiftool reads it. Its real type comes from its contents, not its name;
//      anything that is not a photo or video is left alone.
//   2. Already clean (no location, no XMP, no IPTC) means nothing is rewritten.
//   3. Photos: exiftool removes the GPS tags, every location tag, all XMP and
//      all IPTC, without re-encoding, so pixels and rotation are untouched. If
//      something survives, a second try keeps only rotation and the colour
//      profile. Videos: ffmpeg copies only the video and audio streams into a
//      new file with no metadata, without re-encoding.
//   4. exiftool reads the result again, embedded tracks included. Anything
//      left means the file is refused, not let through.
//
// New uploads land in data/unprocessed/, which is not served, and only move
// into uploads/ once clean, so a dirty file is never reachable even for a
// moment. Files are rewritten to a temporary name and swapped in with a
// rename, so a crash leaves either the old file or the clean one, never both.
//
// Files uploaded before this pass existed are cleaned once by a sweep when the
// server starts (see start). What it cannot reach: copies people already
// downloaded, copies Ferry already sent to Discord, the server's backups, and
// encrypted DM attachments, which reach the server already encrypted.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const tools = require('./mediaTools');
const { UPLOADS_DIR, UNPROCESSED_DIR, STAGING_DIR } = require('./paths');
const { stripImageMetadata } = require('./imageMetadata');
const { DELETED_PREFIX } = require('./storage/paths');

// The media index key for a file under uploads/, or null for bot audio,
// which is not indexed.
function indexed(rel) {
  if (rel.startsWith('bot-audio/')) return null;
  return rel.startsWith(DELETED_PREFIX)
    ? { rel: rel.slice(DELETED_PREFIX.length), state: 'deleted' }
    : { rel, state: 'live' };
}

const HELD_DIR = path.join(UNPROCESSED_DIR, 'held');
const FAILED_JSON = path.join(HELD_DIR, 'failed.json');
const TMP_MARK = '.privacy-tmp';
const MAX_RETRIES = 3;

const MESSAGES = {
  PRIVACY_GPS_REMAINS: 'Your file contains GPS data that Haven failed to remove. Please try again or remove the GPS data manually',
  PRIVACY_FAILED: "Haven couldn't process this file. Please try again or upload a different file.",
};

class PrivacyError extends Error {
  constructor(code, detail) {
    super(MESSAGES[code]);
    this.code = code;
    this.detail = detail || '';
  }
}

// ── Reading a file ───────────────────────────────────────

// Tag names that can hold a place. SubjectLocation (where in the frame the
// camera focused) does not start with either, so it is not caught by mistake.
const LOCATION_TAG = /^(gps|location)|iso6709/i;

function kindOfMime(mime) {
  if (/^image\/svg/i.test(mime)) return null;
  if (/^image\//i.test(mime)) return 'photo';
  if (/^video\//i.test(mime)) return 'video';
  return null;
}

/**
 * What exiftool sees in a file: its type, and the tags that would make it
 * dirty. `embedded` also reads timed metadata tracks inside videos, which is
 * where dashcams and action cameras keep their location.
 */
async function inspect(file, { embedded = false, signal } = {}) {
  const args = ['-j', '-G1', '-a', '-n', '-api', 'LargeFileSupport=1',
    ...(embedded ? ['-ee3'] : []),
    '-FileType', '-FileTypeExtension', '-MIMEType', '-Duration',
    '-*gps*', '-location*', '-*iso6709*', '-xmp:all', '-iptc:all', file];
  // A long video scan runs on its own copy so photos are not stuck behind it.
  const { stdout, stderr } = embedded
    ? await tools.run('exiftool', args, { signal, timeoutMs: 10 * 60 * 1000 })
    : await tools.exiftool(args);
  let row;
  try { row = JSON.parse(stdout)[0] || {}; } catch {
    throw new PrivacyError('PRIVACY_FAILED', `exiftool could not read the file: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  const get = (name) => { for (const k of Object.keys(row)) if (k.endsWith(':' + name)) return row[k]; return undefined; };
  const dirt = [];
  for (const key of Object.keys(row)) {
    const [group, tag = ''] = key.split(':');
    if (/^(File|System|ExifTool|Composite)$/.test(group) && !LOCATION_TAG.test(tag)) continue;
    if (LOCATION_TAG.test(tag) || /^XMP/i.test(group) || /^IPTC/i.test(group)) dirt.push(key);
  }
  return {
    mime: String(get('MIMEType') || ''),
    ext: String(get('FileTypeExtension') || '').toLowerCase(),
    duration: Number(get('Duration')) || 0,
    error: get('Error') ? String(get('Error')) : '',
    dirt,
  };
}

// Extensions that already name the same type as the one detected, so a
// correct-but-different spelling is not "corrected".
const EXT_ALIASES = {
  jpg: ['jpeg', 'jpe', 'jfif'], tif: ['tiff'], heic: ['heif', 'hif'], heif: ['heic', 'hif'],
  mov: ['qt'], mp4: ['m4v', 'm4a'], m4v: ['mp4'], webm: ['weba'], mpg: ['mpeg'], m2ts: ['mts', 'ts'], mkv: ['mk3d'],
};
function correctExt(currentExt, detectedExt) {
  const cur = String(currentExt || '').replace(/^\./, '').toLowerCase();
  if (!detectedExt || cur === detectedExt || (EXT_ALIASES[detectedExt] || []).includes(cur)) return null;
  return detectedExt;
}

// ── Cleaning a file ──────────────────────────────────────

function moveFile(src, dst) {
  try { fs.renameSync(src, dst); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

function keepTimes(file, stat) {
  // Retention and cleanup count from a file's own date, so a rewrite must not
  // make an old file look new.
  try { fs.utimesSync(file, stat.atime, stat.mtime); } catch { /* the file keeps today's date */ }
}

async function cleanPhoto(file) {
  await tools.exiftool(['-overwrite_original', '-P', '-m',
    '-gps:all=', '-*gps*=', '-location*=', '-xmp:all=', '-iptc:all=', file]);
  let after = await inspect(file);
  if (!after.dirt.length) return;
  // Something hid where the targeted delete did not reach (a maker note, say).
  // Keep only what changes how the photo looks.
  await tools.exiftool(['-overwrite_original', '-P', '-m',
    '-all=', '-tagsfromfile', '@', '-Orientation', '-ICC_Profile', file]);
  after = await inspect(file);
  if (after.dirt.length) throw new PrivacyError('PRIVACY_GPS_REMAINS', `still present: ${after.dirt.slice(0, 5).join(', ')}`);
}

const OUTPUT_EXT_OK = /^(mp4|m4v|mov|3gp|3g2|mkv|webm|avi|flv|wmv|asf|mpg|mpeg|ts|m2ts|mts|ogv)$/;

async function cleanVideo(file, info, { signal, onProgress } = {}) {
  let ext = path.extname(file).slice(1).toLowerCase();
  if (!OUTPUT_EXT_OK.test(ext)) ext = info.ext;          // ffmpeg picks its output format from the name
  if (!OUTPUT_EXT_OK.test(ext)) throw new PrivacyError('PRIVACY_FAILED', `no way to rewrite a .${ext} video`);
  const tmp = `${file}${TMP_MARK}.${ext}`;
  const durationUs = info.duration * 1e6;
  let buf = '';
  const r = await tools.run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', file, '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
    '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-progress', 'pipe:1', '-nostats', tmp], {
    signal,
    onStdout: (d) => {
      if (!onProgress || !durationUs) return;
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Math.min(99, Math.floor(Number(m[1]) / durationUs * 100)));
      }
    },
  });
  try {
    if (r.aborted) throw Object.assign(new Error('cancelled'), { code: 'PRIVACY_CANCELLED' });
    if (r.code !== 0) throw new PrivacyError('PRIVACY_FAILED', `ffmpeg: ${r.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    const after = await inspect(tmp, { embedded: true, signal });
    if (after.dirt.length) throw new PrivacyError('PRIVACY_GPS_REMAINS', `still present: ${after.dirt.slice(0, 5).join(', ')}`);
    moveFile(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* moved into place, or never written */ }
  }
}

/**
 * Make one file clean, in place. Resolves { kind, ext, mime } where `ext` is
 * the file's real extension when its name says something else, or throws a
 * PrivacyError. Files that are not photos or videos resolve { kind: null }.
 */
// The built-in cleaner reads the whole file, so it only takes photos.
const BUILTIN_MAX_BYTES = 64 * 1024 * 1024;
function looksLikeStrippable(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    const n = fs.readSync(fd, b, 0, 12, 0);
    if (n < 12) return false;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return true;
    return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
  } catch (err) {
    console.warn('[privacy] Could not read the start of a file:', err.message);
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function cleanFile(file, { signal, onProgress } = {}) {
  if (!tools.toolsReady()) {
    // Haven's own cleaner: JPEG, PNG and WebP photos; anything else is left
    // as it is. The file keeps its date, as it does below.
    const stat = fs.statSync(file);
    if (stat.size <= BUILTIN_MAX_BYTES && looksLikeStrippable(file) && stripImageMetadata(file)) keepTimes(file, stat);
    return { kind: null, ext: null };
  }
  const first = await inspect(file);
  const kind = kindOfMime(first.mime);
  if (!kind) return { kind: null, ext: null };
  const ext = correctExt(path.extname(file), first.ext);
  const mime = first.mime;
  const stat = fs.statSync(file);

  const info = kind === 'video' ? await inspect(file, { embedded: true, signal }) : first;
  if (info.error && !info.mime) throw new PrivacyError('PRIVACY_FAILED', info.error);
  if (!info.dirt.length) return { kind, ext, mime };

  if (kind === 'photo') await cleanPhoto(file);
  else await cleanVideo(file, { ...info, ext: first.ext }, { signal, onProgress });
  keepTimes(file, stat);
  return { kind, ext, mime };
}

// ── New uploads ──────────────────────────────────────────

let activeUploads = 0;
const videoSlots = { free: 2, waiters: [] };
async function withVideoSlot(fn) {
  if (videoSlots.free > 0) videoSlots.free--;
  else await new Promise(res => videoSlots.waiters.push(res));
  try { return await fn(); } finally {
    const next = videoSlots.waiters.shift();
    if (next) next(); else videoSlots.free++;
  }
}

let progressEmitter = null;
/** fn(req, percent) is told how far a video's cleaning has got. */
function setProgressEmitter(fn) { progressEmitter = fn; }

function latin1(s) { return Buffer.from(s, 'utf8').toString('latin1'); }
function utf8(s) { return Buffer.from(s, 'latin1').toString('utf8'); }

/**
 * A drop-in for multer.diskStorage({ destination, filename }) with a string
 * destination under uploads/. The upload is written into unprocessed/,
 * cleaned there, and then waits in unprocessed/staging/ (req.file.path) until
 * its route admits it to storage under req.file.relDir (src/storage). A photo
 * or video whose name lies about its type gets its real extension, on disk
 * and in the name shown in chat.
 */
function diskStorage({ destination, filename }) {
  const relDir = path.relative(UPLOADS_DIR, destination).split(path.sep).join('/');
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) throw new Error(`upload destination is not under uploads/: ${destination}`);
  const stageDir = path.join(STAGING_DIR, relDir);
  const inner = multer.diskStorage({ destination: UNPROCESSED_DIR, filename });
  return {
    _handleFile(req, file, cb) {
      inner._handleFile(req, file, async (err, info) => {
        if (err) return cb(err);
        if (file.stream.truncated) return cb(null, info);  // over the size cap: multer refuses and removes it
        activeUploads++;
        const ctrl = new AbortController();
        const onClose = () => ctrl.abort();
        req.socket?.once('close', onClose);
        try {
          const run = (opts) => cleanFile(info.path, opts);
          const result = await (await isVideoUpload(info.path)
            ? withVideoSlot(() => run({ signal: ctrl.signal, onProgress: (pct) => progressEmitter?.(req, pct) }))
            : run({ signal: ctrl.signal }));
          let name = info.filename;
          const out = {};
          if (result.ext) {
            if (result.mime) out.mimetype = result.mime === 'image/apng' ? 'image/png' : result.mime;
            name = name.replace(/\.[^./]*$/, '') + '.' + result.ext;
            const shown = utf8(file.originalname || 'file');
            out.originalname = latin1(shown.replace(/(\.[^./]*)?$/, '.' + result.ext));
          }
          fs.mkdirSync(stageDir, { recursive: true });
          const dest = path.join(stageDir, name);
          moveFile(info.path, dest);
          // Cleaning changes the size; quotas and the size shown use this one.
          cb(null, { ...info, ...out, destination: stageDir, filename: name, path: dest, relDir, size: fs.statSync(dest).size });
        } catch (e) {
          try { fs.unlinkSync(info.path); } catch { /* already gone */ }
          if (e instanceof PrivacyError) console.error(`[privacy] Upload refused (${e.code}): ${e.detail || e.message}`);
          else if (e.code !== 'PRIVACY_CANCELLED') console.error('[privacy] Upload refused:', e.message);
          cb(e instanceof PrivacyError ? e : new PrivacyError('PRIVACY_FAILED', e.message));
        } finally {
          req.socket?.off('close', onClose);
          activeUploads--;
        }
      });
    },
    _removeFile(req, file, cb) {
      fs.unlink(file.path, (err) => cb(err && err.code !== 'ENOENT' ? err : null));
    },
  };
}

async function isVideoUpload(file) {
  if (!tools.toolsReady()) return false;
  try { return kindOfMime((await inspect(file)).mime) === 'video'; } catch { return false; }
}

/**
 * Clean a file Haven fetched itself (e.g. a sign-in provider's avatar) before
 * it goes into storage as `rel`. `tmp` must be in UNPROCESSED_DIR. Throws a
 * PrivacyError, after removing `tmp`, when it cannot be made clean.
 */
async function admitFile(tmp, rel) {
  activeUploads++;
  try {
    await cleanFile(tmp);
    return await require('./storage').admit(rel, tmp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  } finally { activeUploads--; }
}

// ── The sweep ────────────────────────────────────────────
// Every photo and video already in uploads/ (deleted-attachments included,
// since those can be restored) is cleaned once, where it is. Old files keep
// being served while it runs; new uploads are cleaned as they arrive and the
// sweep waits whenever one is in progress. A file that cannot be cleaned is
// moved to unprocessed/held/, out of reach, and retried after the sweep, up
// to three more times; then it is listed in unprocessed/held/failed.json.

let db = null;
let sweepRunning = false;
let toolRecheck = null;

// Files in a bucket are a sweep of their own: moving to one starts it again.
const onBucket = () => require('./storage').getStorage().kind === 's3';
const stateKey = () => (onBucket() ? 'privacy_sweep_s3' : 'privacy_sweep');
function getState() {
  try { return JSON.parse(db.prepare('SELECT value FROM server_settings WHERE key = ?').get(stateKey())?.value || '{}'); } catch { return {}; }
}
function setState(state) {
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(stateKey(), JSON.stringify(state));
}

function listFiles(root, rel = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// Left behind by a crash mid-rewrite: a half-written clean copy, or an
// upload that never finished arriving.
function removeLeftovers() {
  for (const rel of listFiles(UPLOADS_DIR)) {
    if (rel.includes(TMP_MARK) || rel.endsWith('_exiftool_tmp') || rel.endsWith('.strip')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, rel)); } catch { /* gone already */ }
    }
  }
  for (const e of fs.readdirSync(UNPROCESSED_DIR, { withFileTypes: true })) {
    if (e.isFile()) {
      try { fs.unlinkSync(path.join(UNPROCESSED_DIR, e.name)); } catch { /* gone already */ }
    }
  }
  // An upload its route never admitted, from a request a restart cut short.
  for (const rel of listFiles(STAGING_DIR)) {
    try { fs.unlinkSync(path.join(STAGING_DIR, rel)); } catch { /* gone already */ }
  }
  for (const rel of listFiles(HELD_DIR)) {
    if (rel.includes(TMP_MARK) || rel.endsWith('_exiftool_tmp')) {
      try { fs.unlinkSync(path.join(HELD_DIR, rel)); } catch { /* gone already */ }
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForUploads() { while (activeUploads > 0) await sleep(500); }

function reasonOf(e) { return e instanceof PrivacyError ? `${e.code}: ${e.detail || e.message}` : (e.message || String(e)); }

// `src` is the file on disk: in uploads/, or the cleaned copy of a bucket
// object, which then leaves the bucket.
async function hold(rel, error, src = path.join(UPLOADS_DIR, rel)) {
  const dst = path.join(HELD_DIR, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  moveFile(src, dst);
  if (onBucket()) await require('./storage').getStorage().remove(rel);
  const key = indexed(rel);
  if (key) require('./storage').noteHeld(key.rel);
  db.prepare(`INSERT OR REPLACE INTO privacy_held (rel_path, attempts, last_error, failed, updated_at)
              VALUES (?, 1, ?, 0, CURRENT_TIMESTAMP)`).run(rel, error);
}

function messagesUsing(rel) {
  try {
    return db.prepare(`SELECT m.id AS messageId, c.code AS channel FROM messages m
                       JOIN channels c ON c.id = m.channel_id
                       WHERE m.content LIKE ? ESCAPE '\\' LIMIT 5`)
      .all(`%/uploads/${rel.replace(/[\\%_]/g, '\\$&')}%`);
  } catch { return []; }
}

function writeFailedJson() {
  const rows = db.prepare('SELECT rel_path, attempts, last_error, updated_at FROM privacy_held WHERE failed = 1 ORDER BY rel_path').all();
  const list = rows.map(r => ({
    file: r.rel_path,
    error: r.last_error,
    attempts: r.attempts,
    failedAt: r.updated_at,
    messages: messagesUsing(r.rel_path),
  }));
  try { fs.writeFileSync(FAILED_JSON, JSON.stringify(list, null, 2) + '\n'); } catch (err) {
    console.error('[privacy] Could not write unprocessed/held/failed.json:', err.message);
  }
}

async function sweepUploads() {
  const full = tools.toolsReady();
  let state = getState();
  // A sweep without the tools only reached JPEG, PNG and WebP; once they are
  // installed, everything is gone through again.
  if ((state.done || state.cursor) && !!state.full !== full && full) state = {};
  if (state.done) return;
  if (onBucket()) return sweepBucket(state, full);
  const files = listFiles(UPLOADS_DIR).filter(r => !r.includes(TMP_MARK)).sort();
  const todo = state.cursor ? files.filter(r => r > state.cursor) : files;
  if (todo.length) console.log(`[privacy] Removing location data from existing uploads (${todo.length} files to check)…`);
  let held = 0, lastSave = Date.now();
  for (const rel of todo) {
    await waitForUploads();
    await new Promise(r => setImmediate(r));
    const abs = path.join(UPLOADS_DIR, rel);
    try {
      await cleanFile(abs);
      const key = indexed(rel);
      if (key) require('./storage').noteSize(key.rel, fs.statSync(abs).size);
    } catch (e) {
      if (e.code === 'ENOENT') continue;                  // deleted while we were busy
      if (e.code !== 'PRIVACY_GPS_REMAINS') {
        console.warn(`[privacy] Could not check ${rel}, left as it is: ${reasonOf(e)}`);
        continue;
      }
      console.error(`[privacy] Could not clean ${rel}, holding it back: ${reasonOf(e)}`);
      try { await hold(rel, reasonOf(e)); held++; } catch (err) {
        console.error(`[privacy] Could not move ${rel} to unprocessed/held:`, err.message);
      }
    }
    if (Date.now() - lastSave > 5000) { setState({ cursor: rel, full }); lastSave = Date.now(); }
  }
  setState({ done: true, full });
  if (todo.length) console.log(`[privacy] Existing uploads checked${held ? `; ${held} could not be cleaned and are held in unprocessed/held` : ''}.`);
}

// The bucket's own sweep. There is no folder to walk, so it goes by the media
// index, and each photo or video is cleaned in unprocessed/ and written back
// only when cleaning changed it.
// It picks files by extension, so a photo stored under some other name is
// missed here (the disk sweep reads every file). New uploads are cleaned by
// content either way; this only covers files already in the bucket.
const SWEEP_EXT = /\.(jpe?g|jfif|png|webp|gif|heic|heif|hif|avif|tiff?|bmp|dng|mp4|m4v|mov|qt|3gp|3g2|mkv|webm|avi|mpe?g|ts|m2ts|mts|ogv|wmv|flv|asf)$/i;
async function sweepBucket(state, full) {
  const driver = require('./storage').getStorage();
  const keys = db.prepare('SELECT rel_path, state FROM media_objects').all()
    .map(r => (r.state === 'deleted' ? DELETED_PREFIX + r.rel_path : r.rel_path))
    .filter(k => SWEEP_EXT.test(k)).sort();
  const todo = state.cursor ? keys.filter(k => k > state.cursor) : keys;
  if (todo.length) console.log(`[privacy] Removing location data from existing uploads in the bucket (${todo.length} files to check)…`);
  let held = 0, lastSave = Date.now();
  for (const rel of todo) {
    await waitForUploads();
    await new Promise(r => setImmediate(r));
    const tmp = path.join(UNPROCESSED_DIR, `sweep${TMP_MARK}-${process.pid}-${Date.now()}${path.extname(rel)}`);
    try {
      const before = await driver.readBuffer(rel);
      if (!before) continue;                              // deleted while we were busy
      fs.writeFileSync(tmp, before);
      await cleanFile(tmp);
      if (!before.equals(fs.readFileSync(tmp))) {
        const size = fs.statSync(tmp).size;
        await driver.put(rel, tmp);
        const key = indexed(rel);
        if (key) require('./storage').noteSize(key.rel, size);
      }
    } catch (e) {
      if (e.code !== 'PRIVACY_GPS_REMAINS') {
        console.warn(`[privacy] Could not check ${rel}, left as it is: ${reasonOf(e)}`);
      } else {
        console.error(`[privacy] Could not clean ${rel}, holding it back: ${reasonOf(e)}`);
        try { await hold(rel, reasonOf(e), tmp); held++; } catch (err) {
          console.error(`[privacy] Could not move ${rel} to unprocessed/held:`, err.message);
        }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* written back, held, or never written */ }
    }
    if (Date.now() - lastSave > 5000) { setState({ cursor: rel, full }); lastSave = Date.now(); }
  }
  setState({ done: true, full });
  if (todo.length) console.log(`[privacy] Existing uploads in the bucket checked${held ? `; ${held} could not be cleaned and are held in unprocessed/held` : ''}.`);
}

async function retryHeld() {
  for (;;) {
    const rows = db.prepare('SELECT rel_path, attempts FROM privacy_held WHERE failed = 0 ORDER BY rel_path').all();
    if (!rows.length) return;
    for (const row of rows) {
      await waitForUploads();
      await new Promise(r => setImmediate(r));
      const abs = path.join(HELD_DIR, row.rel_path);
      if (!fs.existsSync(abs)) { db.prepare('DELETE FROM privacy_held WHERE rel_path = ?').run(row.rel_path); continue; }
      try {
        await cleanFile(abs);
        const size = fs.statSync(abs).size;
        if (onBucket()) {
          await require('./storage').getStorage().put(row.rel_path, abs);
        } else {
          const back = path.join(UPLOADS_DIR, row.rel_path);
          fs.mkdirSync(path.dirname(back), { recursive: true });
          moveFile(abs, back);
        }
        const key = indexed(row.rel_path);
        if (key) require('./storage').noteBack(key.rel, size, key.state);
        db.prepare('DELETE FROM privacy_held WHERE rel_path = ?').run(row.rel_path);
        console.log(`[privacy] ${row.rel_path} cleaned on retry and put back.`);
      } catch (e) {
        const attempts = row.attempts + 1;
        const failed = attempts > MAX_RETRIES ? 1 : 0;
        db.prepare('UPDATE privacy_held SET attempts = ?, last_error = ?, failed = ?, updated_at = CURRENT_TIMESTAMP WHERE rel_path = ?')
          .run(attempts, reasonOf(e), failed, row.rel_path);
        console.error(`[privacy] Retry ${attempts - 1} of ${MAX_RETRIES} failed for ${row.rel_path}: ${reasonOf(e)}`);
        if (failed) writeFailedJson();
      }
    }
  }
}

async function runSweep() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await sweepUploads();
    await retryHeld();
  } catch (err) {
    console.error('[privacy] Sweep stopped:', err.message);
  } finally { sweepRunning = false; }
}

function reportMissing() {
  console.log(`ℹ️  [privacy] ${tools.missingTools().join(' and ')} not found, so location data is removed from JPEG, PNG and WebP photos only. ` +
    'Install exiftool and ffmpeg (or point HAVEN_EXIFTOOL_PATH / HAVEN_FFMPEG_PATH at them) to clean videos and other photo formats too.');
}

/**
 * Find the tools, clean up after any crash, and start the sweep. When the
 * tools turn up later, the sweep runs again with them, without a restart.
 */
function start(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS privacy_held (
    rel_path TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    failed INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  fs.mkdirSync(HELD_DIR, { recursive: true });
  try { removeLeftovers(); } catch (err) { console.warn('[privacy] Could not clear leftovers:', err.message); }
  const ready = () => {
    const v = tools.toolInfo();
    console.log(`🔒 Privacy pass ready (exiftool ${v.exiftool}, ffmpeg ${v.ffmpeg})`);
    runSweep();
  };
  if (tools.locateTools()) return ready();
  reportMissing();
  runSweep();
  watchForTools();
}

function watchForTools() {
  // Installing the tools should not need a restart.
  toolRecheck = setInterval(() => {
    if (!tools.locateTools()) return;
    clearInterval(toolRecheck); toolRecheck = null;
    console.log('🔒 Privacy pass tools found; videos and every photo format are cleaned from now on.');
    runSweep();
  }, 5 * 60 * 1000);
  toolRecheck.unref?.();
}

/** 'processing' while a held file still has retries left, 'failed' after. */
function heldState(rel) {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT failed FROM privacy_held WHERE rel_path = ?').get(rel);
    return row ? (row.failed ? 'failed' : 'processing') : null;
  } catch { return null; }
}

module.exports = {
  start, diskStorage, admitFile, cleanFile, inspect, correctExt, heldState,
  setProgressEmitter, PrivacyError, toolsReady: tools.toolsReady,
};
