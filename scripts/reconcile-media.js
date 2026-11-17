#!/usr/bin/env node
'use strict';

// Brings the media index (media_objects) back in line with what storage
// holds, after anything wrote to uploads/ or the bucket outside Haven.
//
//   node scripts/reconcile-media.js [--data <dir>]
//
// --data is Haven's data folder (the one holding haven.db); it defaults to
// HAVEN_DATA_DIR, then the usual location. Safe to run while Haven is up.

const i = process.argv.indexOf('--data');
if (i !== -1) {
  if (!process.argv[i + 1]) { console.error('--data needs a folder'); process.exit(1); }
  process.env.HAVEN_DATA_DIR = process.argv[i + 1];
}

// The server's own settings (HAVEN_S3_* and the rest), as server.js reads them.
require('dotenv').config({ path: require('../src/paths').ENV_PATH });
const { initDatabase } = require('../src/database');
const storage = require('../src/storage');
const { reconcile } = require('../src/storage/reconcile');

(async () => {
  const db = initDatabase();
  try {
    const s = await reconcile(db, storage.getStorage());
    console.log(`Media index: ${s.objects} file(s) in storage; ${s.added} added, ${s.fixed} corrected, ${s.dropped} dropped.`);
  } finally {
    db.close();
  }
})().catch((err) => {
  console.error('Reconcile failed:', err.message);
  process.exit(1);
});
