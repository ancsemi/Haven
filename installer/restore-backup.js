// Restores a Haven backup into a data folder before Haven starts, for the
// installers' "Restore from a backup" option (#5713). Needs npm install first.
//
//   node installer/restore-backup.js <backup.zip> <data folder>
//
// Prints one JSON object per line: { progress: 0-100 } while it works, then
// { ok: true, serverName, adminUsername } or { ok: false, error }.
// Data already in the folder is kept beside the restored copy as
// haven.db.pre-restore and uploads.pre-restore, the same as a restore from
// Settings, so nothing is lost if the wrong backup was picked.
const fs = require('fs');
const path = require('path');
const { extractFullBackup } = require('../src/backupExtract');

const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// A running Haven holds haven.db open, and Windows will not move an open file.
function explainMoveError(err) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
    return 'Haven seems to be running and is using its data folder. Close Haven, then try again.';
  }
  return err.message;
}

function removeIfThere(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

async function restore(zipPath, dataDir) {
  if (!zipPath || !dataDir) throw new Error('Usage: node installer/restore-backup.js <backup.zip> <data folder>');
  if (!fs.existsSync(zipPath)) throw new Error('The backup file was not found: ' + zipPath);
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'haven.db');
  const uploadsDir = path.join(dataDir, 'uploads');
  const stagedDb = dbPath + '.restore';
  const stagedUploads = uploadsDir + '.restore';

  // Unpack beside the live data first. A bad or partial backup fails here,
  // before anything that is already in the folder is touched.
  try {
    await extractFullBackup(zipPath, stagedDb, stagedUploads, (p) => {
      if (p.bytesTotal > 0) say({ progress: Math.floor((p.bytesDone / p.bytesTotal) * 100) });
    });
  } catch (err) {
    removeIfThere(stagedDb);
    removeIfThere(stagedUploads);
    throw err;
  }

  // Keep whatever was there before. SQLite looks for a database's journal at
  // "<file>-wal", so the journal moves with it under the matching name.
  const moved = [];
  const moveAside = (from, to) => {
    if (!fs.existsSync(from)) return;
    removeIfThere(to);
    fs.renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    moveAside(dbPath, dbPath + '.pre-restore');
    moveAside(dbPath + '-wal', dbPath + '.pre-restore-wal');
    moveAside(dbPath + '-shm', dbPath + '.pre-restore-shm');
    if (fs.existsSync(stagedUploads)) moveAside(uploadsDir, uploadsDir + '.pre-restore');
    fs.renameSync(stagedDb, dbPath);
    if (fs.existsSync(stagedUploads)) fs.renameSync(stagedUploads, uploadsDir);
  } catch (err) {
    // Put back what was moved so the folder is as it was before.
    for (const [from, to] of moved.reverse()) {
      try { if (!fs.existsSync(from)) fs.renameSync(to, from); }
      catch (err2) { console.error('[Restore] Could not move ' + to + ' back to ' + from + ':', err2.message); }
    }
    removeIfThere(stagedDb);
    removeIfThere(stagedUploads);
    throw new Error(explainMoveError(err));
  }

  // The server's name and its first admin, for the installer's last page and
  // its .env. Older backups bring a database the next start migrates; these
  // two have been in every version, but a missing one only costs the message.
  let serverName = null;
  let adminUsername = null;
  try {
    const Database = require('better-sqlite3');
    // Not read-only: a database copied out in WAL mode cannot be opened
    // read-only until something has created its shared-memory file.
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      serverName = db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get()?.value || null;
      adminUsername = db.prepare('SELECT username FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get()?.username || null;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[Restore] Restored, but could not read the server name or admin from it:', err.message);
  }
  return { serverName, adminUsername };
}

restore(process.argv[2], process.argv[3]).then(
  (result) => { say({ ok: true, ...result }); },
  (err) => { say({ ok: false, error: err.message }); process.exitCode = 1; }
);
