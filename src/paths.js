/**
 * Haven — Centralised data-directory resolution
 *
 * All user data (database, .env, certs, uploads) lives OUTSIDE the
 * application folder so the code directory can never accidentally
 * leak personal data — even if someone copies the whole folder,
 * force-adds files, or pushes to a public repo.
 *
 * Locations:
 *   Windows : %APPDATA%\Haven\          (e.g. C:\Users\you\AppData\Roaming\Haven)
 *   Linux   : ~/.haven/
 *   macOS   : ~/.haven/
 *
 * Override : set HAVEN_DATA_DIR env var to any absolute path.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

function getDataDir() {
  // Allow explicit override via environment variable
  if (process.env.HAVEN_DATA_DIR) {
    const custom = path.resolve(process.env.HAVEN_DATA_DIR);
    fs.mkdirSync(custom, { recursive: true });
    return custom;
  }

  let base;
  if (process.platform === 'win32') {
    // %APPDATA% → C:\Users\<user>\AppData\Roaming
    base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Haven');
  } else {
    // Linux / macOS → ~/.haven
    base = path.join(os.homedir(), '.haven');
  }

  fs.mkdirSync(base, { recursive: true });
  return base;
}

// Pre-computed paths for convenience
const DATA_DIR     = getDataDir();
const DB_PATH      = path.join(DATA_DIR, 'haven.db');
const ENV_PATH     = path.join(DATA_DIR, '.env');
const CERTS_DIR    = path.join(DATA_DIR, 'certs');
const UPLOADS_DIR  = path.join(DATA_DIR, 'uploads');

const DELETED_ATTACHMENTS_DIR = path.join(UPLOADS_DIR, 'deleted-attachments');

// Ensure sub-directories exist
fs.mkdirSync(CERTS_DIR,                { recursive: true });
fs.mkdirSync(UPLOADS_DIR,             { recursive: true });
fs.mkdirSync(DELETED_ATTACHMENTS_DIR, { recursive: true });

// ── One-time migration: move data from old project-dir locations ─────
const PROJECT_ROOT = path.join(__dirname, '..');

function migrateFile(oldRel, newAbs) {
  const oldAbs = path.join(PROJECT_ROOT, oldRel);
  if (fs.existsSync(oldAbs) && !fs.existsSync(newAbs)) {
    try {
      fs.copyFileSync(oldAbs, newAbs);
      fs.unlinkSync(oldAbs);
      console.log(`📦 Migrated ${oldRel} → ${newAbs}`);
    } catch (err) {
      // Left behind, the server would start on an empty file in the new location.
      console.warn(`⚠️  Could not migrate ${oldRel} to ${newAbs}:`, err.message);
    }
  }
}

function migrateDir(oldRel, newDir) {
  const oldAbs = path.join(PROJECT_ROOT, oldRel);
  if (fs.existsSync(oldAbs)) {
    try {
      const entries = fs.readdirSync(oldAbs);
      for (const entry of entries) {
        if (entry === '.gitkeep') continue;
        const src = path.join(oldAbs, entry);
        const dst = path.join(newDir, entry);
        if (!fs.existsSync(dst) && fs.statSync(src).isFile()) {
          fs.copyFileSync(src, dst);
          fs.unlinkSync(src);
          console.log(`📦 Migrated ${oldRel}/${entry} → ${dst}`);
        }
      }
    } catch (err) {
      console.warn(`⚠️  Could not migrate ${oldRel} to ${newDir}:`, err.message);
    }
  }
}

migrateFile('haven.db',       DB_PATH);
migrateFile('haven.db-shm',   DB_PATH + '-shm');
migrateFile('haven.db-wal',   DB_PATH + '-wal');
migrateFile('.env',           ENV_PATH);
migrateDir('certs',           CERTS_DIR);
migrateDir('public/uploads',  UPLOADS_DIR);

module.exports = { getDataDir, DATA_DIR, DB_PATH, ENV_PATH, CERTS_DIR, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR };
