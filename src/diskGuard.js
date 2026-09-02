// ═══════════════════════════════════════════════════════════
// Haven — Disk headroom guard (#5505)
// Keeps a slice of the data volume free so the database can
// always be written to, including the writes that free space.
// ═══════════════════════════════════════════════════════════
//
// A full disk does not just stop uploads. SQLite needs to write to delete a
// row, so once the volume is full an admin cannot clear the files that filled
// it: deleting the attachment is itself a write, and it fails. The instance
// wedges, and the only way out is to grow the disk from underneath it.
//
// The fix is to never hand out the last of the space in the first place. Any
// upload that would eat into the reserve is refused while there is still room
// to delete things, so the way out stays open.

const fs = require('fs');
const { DATA_DIR } = require('./paths');

// Reserve, in MB. Sized so a busy server still has room for the database, the
// WAL, and a vacuum, without taking a meaningful bite out of a small VPS disk.
const RESERVE_MB = (() => {
  const raw = parseInt(process.env.HAVEN_DISK_RESERVE_MB, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 512;
})();
const RESERVE_BYTES = RESERVE_MB * 1024 * 1024;

// statfs is a syscall, and uploads can arrive in bursts. A few seconds of
// staleness cannot matter here: the reserve is orders of magnitude larger than
// anything that lands inside one window.
const CACHE_MS = 5000;
let _cache = { at: 0, free: null };

/** Free bytes on the data volume, or null if the platform will not say. */
function freeBytes() {
  const now = Date.now();
  if (_cache.free !== null && now - _cache.at < CACHE_MS) return _cache.free;
  let free = null;
  try {
    const stat = fs.statfsSync(DATA_DIR);
    // bavail, not bfree: bfree includes blocks only root may touch.
    free = stat.bavail * stat.bsize;
  } catch (err) {
    // Unsupported filesystem or a permissions quirk. Fail open rather than
    // locking a working server out of uploads over a failed measurement.
    free = null;
  }
  _cache = { at: now, free };
  return free;
}

/**
 * Is there room to accept a write of `incoming` bytes and still leave the
 * reserve intact? Unknown free space counts as yes, so an unsupported
 * platform behaves exactly as it did before this guard existed.
 */
function hasHeadroom(incoming = 0) {
  const free = freeBytes();
  if (free === null) return true;
  return free - incoming >= RESERVE_BYTES;
}

let _warnedAt = 0;
function _warnLow(free) {
  // One line every 5 minutes, not one per rejected upload.
  const now = Date.now();
  if (now - _warnedAt < 5 * 60 * 1000) return;
  _warnedAt = now;
  const mb = (n) => Math.round(n / 1024 / 1024);
  console.warn(`⚠️  Disk headroom low: ${mb(free)} MB free on the data volume, reserve is ${RESERVE_MB} MB. Uploads are being refused so the database can still be written to. Free some space or raise HAVEN_DISK_RESERVE_MB.`);
}

/**
 * Express guard for the upload routes.
 *
 * Runs before multer, because multer streams the body to disk as it arrives:
 * checking afterwards would mean the file is already written and the space
 * this guard exists to protect is already spent.
 *
 * The margin asked for is the largest single upload the server currently
 * allows, so the question is "could the biggest permitted file still fit
 * without eating the reserve", not "is there a byte spare right now".
 */
function _maxUploadBytes() {
  try {
    const { getDb } = require('./database');
    const row = getDb().prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get();
    return (parseInt(row?.value, 10) || 25) * 1024 * 1024;
  } catch {
    return 25 * 1024 * 1024;
  }
}

function guardUploads() {
  return (req, res, next) => {
    if (hasHeadroom(_maxUploadBytes())) return next();
    const free = freeBytes();
    if (free !== null) _warnLow(free);
    return res.status(507).json({
      error: 'The server is low on disk space, so uploads are paused. Ask an admin to free some space.'
    });
  };
}

/**
 * Current headroom state, for surfacing to admins in the app (#5505).
 *
 * The console warning above only helps someone already watching the logs, and
 * the 507 only reaches whoever happens to try an upload. An admin who is not
 * doing either has no way to find out the server is wedging until people start
 * complaining, so the same state is published over the socket as well.
 *
 * `low` uses the same margin as the upload guard, so the banner appears at the
 * moment uploads actually start being refused rather than at some other number.
 */
function diskStatus() {
  const free = freeBytes();
  if (free === null) return { low: false, freeMb: null, reserveMb: RESERVE_MB };
  return {
    low: !hasHeadroom(_maxUploadBytes()),
    freeMb: Math.round(free / 1024 / 1024),
    reserveMb: RESERVE_MB
  };
}

module.exports = { freeBytes, hasHeadroom, guardUploads, diskStatus, RESERVE_BYTES, RESERVE_MB };
