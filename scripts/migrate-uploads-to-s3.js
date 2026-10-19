#!/usr/bin/env node
'use strict';

// Moves a server's existing uploads from its uploads folder into the bucket
// set by HAVEN_EXTERNAL_STORAGE and the HAVEN_S3_* settings.
//
//   node scripts/migrate-uploads-to-s3.js [--data <dir>] [--delete-local]
//
// Safe to run while Haven is up with HAVEN_S3_LOCAL_FALLBACK=true, and safe
// to run again: a file the bucket already has at the same size is skipped.
// The local copies stay unless --delete-local is given, and even then only
// when every file made it and the bucket's count and size match the folder's.
// Bot audio (uploads/bot-audio) stays on disk; it is never in the bucket.

const args = process.argv.slice(2);
const i = args.indexOf('--data');
if (i !== -1) {
  if (!args[i + 1]) { console.error('--data needs a folder'); process.exit(1); }
  process.env.HAVEN_DATA_DIR = args[i + 1];
}
const deleteLocal = args.includes('--delete-local');
// The server's own settings (HAVEN_S3_* and the rest), as server.js reads them.
require('dotenv').config({ path: require('../src/paths').ENV_PATH });

const { initDatabase } = require('../src/database');
const storage = require('../src/storage');
const { reconcile } = require('../src/storage/reconcile');
const { pushLocalToBucket } = require('../src/storage/migrate');

(async () => {
  const bucket = storage.getStorage();
  if (bucket.kind !== 's3') throw new Error('Set HAVEN_EXTERNAL_STORAGE=true and the HAVEN_S3_* settings first.');
  await bucket.ping();
  console.log(`Copying uploads into the ${bucket.describe()}…`);

  const copied = await pushLocalToBucket(bucket, { log: (m) => console.log(m) });
  console.log(`${copied.files} file(s), ${(copied.bytes / 1048576).toFixed(1)} MB on disk; ${copied.sent} copied, ${copied.files - copied.sent - copied.failed} already in the bucket, ${copied.failed} failed.`);

  const db = initDatabase();
  try {
    const r = await reconcile(db, bucket);
    console.log(`Media index: ${r.added} added, ${r.fixed} corrected, ${r.dropped} dropped.`);
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('media_index_built', '1')").run();
  } finally {
    db.close();
  }

  // The bucket has to hold at least what the folder does before anything on
  // disk goes.
  let inBucket = 0, bucketBytes = 0;
  for await (const o of bucket.list('')) { inBucket++; bucketBytes += o.size; }
  const verified = !copied.failed && inBucket >= copied.files && bucketBytes >= copied.bytes;
  console.log(`Check: the bucket holds ${inBucket} file(s), ${(bucketBytes / 1048576).toFixed(1)} MB${verified ? ', everything from the folder is there' : ''}.`);
  if (!verified) {
    console.error('Not everything made it into the bucket. Nothing on disk was removed; run this again.');
    process.exitCode = 1;
    return;
  }
  if (deleteLocal) {
    const again = await pushLocalToBucket(bucket, { deleteLocal: true, log: (m) => console.log(m) });
    console.log(`Removed ${again.removed} file(s) from the uploads folder.`);
  } else {
    console.log('The files are still on disk too. Once Haven serves them from the bucket, run again with --delete-local to free the space.');
  }
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
});
