'use strict';

// Copies what is in uploads/ on this machine into the bucket: every file the
// bucket does not have, or has at another size. Used by
// scripts/migrate-uploads-to-s3.js, and at boot after a backup was restored
// onto a server that keeps its media in a bucket (the restore puts the files
// back on disk; this sends them on). Safe to run again: what is already there
// is left alone.

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, STAGING_DIR } = require('../paths');
const { LocalStorage } = require('./local');

async function pushLocalToBucket(bucket, { deleteLocal = false, log = () => {} } = {}) {
  const local = new LocalStorage(UPLOADS_DIR);
  const s = { files: 0, bytes: 0, sent: 0, sentBytes: 0, failed: 0, removed: 0 };
  const done = [];
  for await (const f of local.list('')) {
    if (f.rel.startsWith('bot-audio/')) continue;
    s.files++;
    s.bytes += f.size;
    try {
      const there = await bucket.headObject(f.rel);
      if (!there || there.size !== f.size) {
        // put() moves the file it is given, and the original stays until the
        // whole run has gone well, so it goes up from a copy.
        const copy = path.join(STAGING_DIR, `migrate-${process.pid}-${s.files}${path.extname(f.rel)}`);
        fs.copyFileSync(path.join(UPLOADS_DIR, f.rel), copy);
        try { await bucket.put(f.rel, copy); } finally { try { fs.unlinkSync(copy); } catch { /* moved by put */ } }
        s.sent++;
        s.sentBytes += f.size;
      }
      done.push(f.rel);
    } catch (err) {
      s.failed++;
      log(`[storage] Could not copy ${f.rel} to the bucket: ${err.message}`);
    }
    if (s.files % 500 === 0) log(`[storage] ${s.files} file(s) checked, ${s.sent} copied…`);
  }
  if (deleteLocal && !s.failed) {
    for (const rel of done) {
      try { await local.remove(rel); s.removed++; } catch (err) { log(`[storage] Could not remove ${rel} from disk: ${err.message}`); }
    }
  }
  return s;
}

module.exports = { pushLocalToBucket };
