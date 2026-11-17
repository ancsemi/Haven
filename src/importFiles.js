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
// Anything that cannot be copied (a link that has already expired, a file
// over the limit, a network error) stays as the link it was.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { UNPROCESSED_DIR } = require('./paths');
const diskGuard = require('./diskGuard');

const DISCORD_FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const ATTACHMENT_LINE = /^📎 \[([^\]\n]*)\]\((https:\/\/[^)\s]+)\)$/u;
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const TIMEOUT_MS = 60000;

function isDiscordFile(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DISCORD_FILE_HOSTS.has(u.hostname) && u.pathname.startsWith('/attachments/');
  } catch {
    return false; // not a link at all, so not one of Discord's
  }
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
async function copyOne(url, name, { capBytes, fetchImpl, admit }) {
  const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  // Stored like any upload (src/storage): on disk, or in the bucket.
  const admitted = await admit(tmp, stored);
  return { stored, size: admitted.size };
}

/**
 * Turns the attachment lines of an imported message into files stored in
 * Haven. `state.stopped` is set once the disk reserve is reached, so the rest
 * of the import stops trying. Never throws: a file that fails stays a link.
 */
async function copyAttachments(content, { capBytes, state = {}, fetchImpl = fetch, admit = null } = {}) {
  if (!content || !content.includes('📎')) return content;
  const admitFile = admit || require('./privacyPass').admitFile;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (state.stopped) break;
    const quoted = lines[i].startsWith('> ');
    const m = ATTACHMENT_LINE.exec(quoted ? lines[i].slice(2) : lines[i]);
    if (!m || !isDiscordFile(m[2])) continue;
    if (!diskGuard.hasHeadroom(0)) { state.stopped = true; break; }
    try {
      const got = await copyOne(m[2], m[1], { capBytes, fetchImpl, admit: admitFile });
      if (!got) { state.skipped = (state.skipped || 0) + 1; continue; }
      const url = `/uploads/${got.stored}`;
      const line = IMAGE_EXTS.has(extOf(got.stored)) ? url : `[file:${safeName(m[1])}](${url}|${sizeLabel(got.size)})`;
      lines[i] = (quoted ? '> ' : '') + line;
      state.copied = (state.copied || 0) + 1;
    } catch (err) {
      state.skipped = (state.skipped || 0) + 1;
      console.warn('[import] Could not copy a Discord attachment, keeping the link:', err.message);
    }
  }
  return lines.join('\n');
}

module.exports = { copyAttachments, isDiscordFile, sizeLabel };
