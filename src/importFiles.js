'use strict';

// Copying a Discord import's pictures and files into Haven (#5811).
//
// An imported attachment used to stay a link to Discord's copy. Discord signs
// those links and they stop working after about a day, so every imported
// picture turned into a dead link. While an import is written, each
// attachment line ("📎 [name](link)") is downloaded and stored like any
// upload, and the line becomes the picture itself, or a file with its player
// or download button.
//
// What is held to:
//  - only Discord's own file servers are fetched. Uploaded export files
//    (DiscordChatExporter) carry whatever links they were given, and the
//    server must not be made to fetch anything else, least of all addresses
//    on its own network
//  - the server's upload size limit, per file
//  - the disk reserve (src/diskGuard.js): once taking a file would cut into
//    it, the rest stay links, and the import still finishes
//  - the privacy pass: a file is cleaned before it is reachable, the same as
//    an upload (privacyPass.admitFile)
//  - the file types the admin refuses (src/uploadBlocklist.js), checked on
//    the name before anything is fetched
//  - a file named as a picture has to be one: its first bytes are checked the
//    way an uploaded picture's are
// Anything that cannot be copied (a link that has already expired, a file
// over the limit, a network error) stays as the link it was.
//
// The live Discord bridge (src/ferry.js) uses the same copy for the files in
// messages as they arrive: storeDiscordFiles.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { UNPROCESSED_DIR } = require('./paths');
const diskGuard = require('./diskGuard');
const { blockedUploadType } = require('./uploadBlocklist');

const DISCORD_FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const ATTACHMENT_LINE = /^📎 \[([^\]\n]*)\]\((https:\/\/[^)\s]+)\)$/u;
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const TIMEOUT_MS = 60000;

// Whether a stored file named as a picture starts the way that kind of
// picture does, the check an uploaded picture gets (src/routes/uploads.js).
function looksLikeImage(file, ext) {
  let hdr;
  const fd = fs.openSync(file, 'r');
  try {
    hdr = Buffer.alloc(12);
    fs.readSync(fd, hdr, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (ext === 'jpg' || ext === 'jpeg') return hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF;
  if (ext === 'png') return hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4E && hdr[3] === 0x47;
  if (ext === 'gif') return hdr.subarray(0, 4).toString('latin1') === 'GIF8';
  if (ext === 'webp') return hdr.subarray(0, 4).toString('latin1') === 'RIFF' && hdr.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

function isDiscordFile(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DISCORD_FILE_HOSTS.has(u.hostname) && u.pathname.startsWith('/attachments/');
  } catch {
    return false; // not a link at all, so not one of Discord's
  }
}

// A link without its signature, which Discord changes whenever it refreshes one.
function fileKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url);
  }
}

function nameOfUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'file';
  } catch {
    return 'file';
  }
}

// The Discord file links standing alone on a line of a relayed message, also
// inside a quoted (forwarded) one.
function fileUrlsIn(text) {
  return String(text || '').split('\n').map(l => (l.startsWith('> ') ? l.slice(2) : l).trim()).filter(isDiscordFile);
}

// The same size label the app writes for an upload ("1.2 MB").
function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// A name that cannot break the [file:name](...) line it goes into.
function safeName(name) {
  return String(name || 'file').replace(/[[\]()|\r\n]/g, '_').slice(0, 200) || 'file';
}

// Downloads one file into uploads/, cleaned. Returns its stored name and
// size, or null when it stays a link.
async function copyOne(url, name, { capBytes, fetchImpl, admit, blocked = '', timeoutMs = TIMEOUT_MS }) {
  if (blockedUploadType(name, blocked)) return null;
  const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) return null;
  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared > capBytes || !diskGuard.hasHeadroom(declared)) {
    await res.body.cancel?.();
    return null;
  }
  const ext = extOf(name);
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext ? '.' + ext : ''}`;
  fs.mkdirSync(UNPROCESSED_DIR, { recursive: true });
  const tmp = path.join(UNPROCESSED_DIR, `import-${stored}`);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > capBytes) return cb(new Error('over the upload limit'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.message === 'over the upload limit') return null;
    throw err;
  }
  if (IMAGE_EXTS.has(ext) && !looksLikeImage(tmp, ext)) {
    fs.rmSync(tmp, { force: true });
    return null;
  }
  // Stored like any upload (src/storage): on disk, or in the bucket.
  const admitted = await admit(tmp, stored);
  return { stored, size: admitted.size };
}

// Copies one Discord file into Haven. Returns the line that shows it in a
// message (the picture's path, or a file line), or null when it stays a link.
async function storeFile(url, name, { capBytes, fetchImpl, admit, state, blocked, timeoutMs, onStored }) {
  if (!diskGuard.hasHeadroom(0)) { state.stopped = true; return null; }
  try {
    const got = await copyOne(url, name, { capBytes, fetchImpl, admit, blocked, timeoutMs });
    if (!got) { state.skipped = (state.skipped || 0) + 1; return null; }
    state.copied = (state.copied || 0) + 1;
    if (onStored) onStored(got.stored, got.size);
    return IMAGE_EXTS.has(extOf(got.stored)) ? `/uploads/${got.stored}` : `[file:${safeName(name)}](/uploads/${got.stored}|${sizeLabel(got.size)})`;
  } catch (err) {
    state.skipped = (state.skipped || 0) + 1;
    console.warn('[import] Could not copy a Discord attachment, keeping the link:', err.message);
    return null;
  }
}

/**
 * Turns the attachment lines of an imported message into files stored in
 * Haven. `state.stopped` is set once the disk reserve is reached, so the rest
 * of the import stops trying. Never throws: a file that fails stays a link.
 */
async function copyAttachments(content, { capBytes, state = {}, fetchImpl = fetch, admit = null, blocked = '' } = {}) {
  if (!content || !content.includes('📎')) return content;
  const admitFile = admit || require('./privacyPass').admitFile;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (state.stopped) break;
    const quoted = lines[i].startsWith('> ');
    const m = ATTACHMENT_LINE.exec(quoted ? lines[i].slice(2) : lines[i]);
    if (!m || !isDiscordFile(m[2])) continue;
    const line = await storeFile(m[2], m[1], { capBytes, fetchImpl, admit: admitFile, state, blocked });
    if (line) lines[i] = (quoted ? '> ' : '') + line;
  }
  return lines.join('\n');
}

/**
 * Copies the Discord files at `urls` into Haven and returns `known`, a map
 * from each link (without its signature) to the line that shows the copy. A
 * link already in `known` is not fetched again, and one that cannot be copied
 * is left out, so it stays a link. At most `maxFiles` are copied for one
 * message. `onStored(storedName, bytes)` is told about each new copy. Never
 * throws.
 */
async function storeDiscordFiles(urls, { capBytes, state = {}, fetchImpl = fetch, admit = null, known = new Map(), blocked = '', timeoutMs, maxFiles = 10, onStored = null } = {}) {
  const admitFile = admit || require('./privacyPass').admitFile;
  let tried = 0;
  for (const url of urls) {
    if (state.stopped || tried >= maxFiles) break;
    const key = fileKey(url);
    if (!isDiscordFile(url) || known.has(key)) continue;
    tried++;
    const line = await storeFile(url, nameOfUrl(url), { capBytes, fetchImpl, admit: admitFile, state, blocked, timeoutMs, onStored });
    if (line) known.set(key, line);
  }
  return known;
}

module.exports = { copyAttachments, storeDiscordFiles, fileUrlsIn, fileKey, isDiscordFile, sizeLabel };
