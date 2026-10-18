'use strict';

// Badge icon upload (#5632): a small picture for a profile badge, for the
// admin or Manage Badges. The client shrinks it to 64x64 first; this checks
// it again: PNG, GIF, WebP or JPEG only, 256 KB at most, and the first bytes
// have to match the type it claims. Stored in uploads/badges/ under a name
// picked here, which is the only shape a badge accepts as its icon.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const privacyPass = require('../privacyPass');
const storage = require('../storage');
const { imageKey } = require('../badges');

const MAX_BYTES = 256 * 1024;
const EXT = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/jpeg': '.jpg' };

// The type the first bytes of a file say it is, or null.
function sniffImage(hdr) {
  if (hdr.length >= 8 && hdr[0] === 0x89 && hdr.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (hdr.length >= 6 && /^GIF8[79]a$/.test(hdr.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (hdr.length >= 12 && hdr.slice(0, 4).toString('latin1') === 'RIFF' && hdr.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (hdr.length >= 3 && hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF) return 'image/jpeg';
  return null;
}

module.exports = function registerBadgeRoutes(deps) {
  const { app, verifyAdminFromDb, userHasPermission, uploadDir, uploadLimiter, uploadDiskGuard } = deps;
  // Loaded here, not at the top, so the image check below can be tested on its own.
  const { verifyToken } = require('../auth');
  const BADGE_DIR = path.join(uploadDir, 'badges');

  const upload = multer({
    storage: privacyPass.diskStorage({
      destination: BADGE_DIR,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${EXT[file.mimetype]}`),
    }),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 5, fieldSize: 1024 },
    fileFilter: (req, file, cb) => {
      if (EXT[file.mimetype]) cb(null, true);
      else cb(new Error('Only images allowed (png, gif, webp, jpg)'));
    },
  });

  // Any error reading the account or its permissions refuses.
  function mayUpload(user) {
    try {
      return !!(verifyAdminFromDb(user) || userHasPermission(user.id, 'manage_badges'));
    } catch (err) {
      console.warn('[badges] upload permission check failed:', err.message);
      return false;
    }
  }

  function discard(file) {
    fs.unlink(file.path, (err) => {
      if (err && err.code !== 'ENOENT') console.warn('[badges] could not remove a refused upload:', err.code || err.message);
    });
  }

  app.post('/api/upload-badge-icon', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!mayUpload(user)) return res.status(403).json({ error: 'Requires admin or Manage Badges permission' });

    upload.single('icon')(req, res, async (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'Badge icon must be under 256 KB' : err.message;
        return res.status(400).json({ error: message });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      // 256 KB at most, so the whole file is read: the first bytes for the
      // type check, all of it for the key the editor uses to spot a picture
      // another badge already shows.
      let bytes;
      try {
        bytes = fs.readFileSync(req.file.path);
      } catch (readErr) {
        console.warn('[badges] could not read an uploaded icon:', readErr.message);
        discard(req.file);
        return res.status(400).json({ error: 'Failed to validate' });
      }
      if (sniffImage(bytes.subarray(0, 12)) !== req.file.mimetype) {
        discard(req.file);
        return res.status(400).json({ error: 'Invalid image' });
      }
      try { await storage.admitUpload(req.file); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      res.json({ path: `/uploads/badges/${req.file.filename}`, iconKey: imageKey(bytes) });
    });
  });
};

module.exports.sniffImage = sniffImage;
