// Attachments: image and file uploads for messages, and the Flash ROM pack
// used by the built-in games.

const fs = require('fs');
const path = require('path');
const { verifyToken } = require('../auth');
const ROOT = path.join(__dirname, '..', '..');

module.exports = function registerUploads(deps) {
  const { uploadDiskGuard, app, recordUploadOwnership, uploadScopeFromRequest, uploadCapMb, verifyAdminFromDb, userHasPermission, uploadDir, upload, fileUpload, uploadLimiter } = deps;
  // ── Image upload (authenticated + not banned) ────────────
  app.post('/api/upload', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Check if user is banned
    const { getDb } = require('../database');
    const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

    // Enforce upload_files permission (admin always allowed)
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'upload_files')) {
      return res.status(403).json({ error: 'You don\'t have permission to upload files' });
    }

    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      // Enforce the upload cap: the server setting, raised by any role that says so
      const capMb = uploadCapMb(user);
      if (req.file.size > capMb * 1024 * 1024) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `Image too large (max ${capMb} MB)` });
      }

      // Validate file magic bytes (don't trust MIME type alone)
      try {
        const fd = fs.openSync(req.file.path, 'r');
        const hdr = Buffer.alloc(12);
        fs.readSync(fd, hdr, 0, 12, 0);
        fs.closeSync(fd);
        let validMagic = false;
        if (req.file.mimetype === 'image/jpeg') validMagic = hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF;
        else if (req.file.mimetype === 'image/png') validMagic = hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4E && hdr[3] === 0x47;
        else if (req.file.mimetype === 'image/gif') validMagic = hdr.slice(0, 6).toString().startsWith('GIF8');
        else if (req.file.mimetype === 'image/webp') validMagic = hdr.slice(0, 4).toString() === 'RIFF' && hdr.slice(8, 12).toString() === 'WEBP';
        if (!validMagic) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: 'File content does not match image type' });
        }
      } catch {
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
        return res.status(400).json({ error: 'Failed to validate file' });
      }

      // Force safe extension based on validated mimetype (prevent HTML/SVG upload)
      const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
      const safeExt = mimeToExt[req.file.mimetype];
      if (!safeExt) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid file type' });
      }
      // Rename file to use safe extension if it doesn't already match
      const currentExt = path.extname(req.file.filename).toLowerCase();
      if (currentExt !== safeExt) {
        const safeName = req.file.filename.replace(/\.[^.]+$/, '') + safeExt;
        const oldPath = req.file.path;
        const newPath = path.join(uploadDir, safeName);
        fs.renameSync(oldPath, newPath);
        recordUploadOwnership(user.id, safeName, req.file.size, uploadScopeFromRequest(req));
        return res.json({ url: `/uploads/${safeName}` });
      }
      recordUploadOwnership(user.id, req.file.filename, req.file.size, uploadScopeFromRequest(req));
      res.json({ url: `/uploads/${req.file.filename}` });
    });
  });

  // ── General file upload (authenticated + not banned) ─────
  app.post('/api/upload-file', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { getDb } = require('../database');
    const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

    // Enforce upload_files permission (admin always allowed)
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'upload_files')) {
      return res.status(403).json({ error: 'You don\'t have permission to upload files' });
    }

    fileUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      // Enforce the upload cap: the server setting, raised by any role that says so
      const capMb = uploadCapMb(user);
      if (req.file.size > capMb * 1024 * 1024) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `File too large (max ${capMb} MB)` });
      }

      const isImage = /^image\//.test(req.file.mimetype);
      // multer passes the raw bytes from the multipart header as a latin1 string;
      // browsers encode filenames as UTF-8 bytes, so re-decode to recover the
      // original text (fixes garbled Chinese/emoji/non-ASCII filenames).
      const originalName = Buffer.from(req.file.originalname || 'file', 'latin1').toString('utf8');
      const fileSize = req.file.size;

      recordUploadOwnership(user.id, req.file.filename, fileSize, uploadScopeFromRequest(req));

      res.json({
        url: `/uploads/${req.file.filename}`,
        originalName,
        fileSize,
        isImage,
        mimetype: req.file.mimetype
      });
    });
  });

  // ── Flash ROM status & download ──────────────────────────
  const ROMS_DIR = path.join(ROOT, 'public', 'games', 'roms');
  const FLASH_ROM_MANIFEST = [
    { file: 'flight-759879f9.swf',    url: 'https://raw.githubusercontent.com/ancsemi/Haven/ccf21d874c5502eefccc7a46fe525a793e0bc603/public/games/roms/flight-759879f9.swf',    size: 8570000 },
    { file: 'learn-to-fly-3.swf',     url: 'https://raw.githubusercontent.com/ancsemi/Haven/ccf21d874c5502eefccc7a46fe525a793e0bc603/public/games/roms/learn-to-fly-3.swf',     size: 17340000 },
    { file: 'Bubble Tanks 3.swf',     url: 'https://raw.githubusercontent.com/ancsemi/Haven/ccf21d874c5502eefccc7a46fe525a793e0bc603/public/games/roms/Bubble%20Tanks%203.swf',  size: 3870000 },
    { file: 'tanks.swf',              url: 'https://raw.githubusercontent.com/ancsemi/Haven/ccf21d874c5502eefccc7a46fe525a793e0bc603/public/games/roms/tanks.swf',               size: 32000 },
    { file: 'SuperSmash.swf',         url: 'https://raw.githubusercontent.com/ancsemi/Haven/ccf21d874c5502eefccc7a46fe525a793e0bc603/public/games/roms/SuperSmash.swf',          size: 8830000 },
  ];

  app.get('/api/flash-rom-status', (req, res) => {
    const status = FLASH_ROM_MANIFEST.map(rom => ({
      file: rom.file,
      installed: fs.existsSync(path.join(ROMS_DIR, rom.file))
    }));
    const allInstalled = status.every(r => r.installed);
    res.json({ allInstalled, roms: status });
  });

  app.post('/api/install-flash-roms', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Only admins can trigger ROM downloads
    const { getDb } = require('../database');
    const adminRow = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
    if (!adminRow || !adminRow.is_admin) return res.status(403).json({ error: 'Only admins can install flash games' });

    if (!fs.existsSync(ROMS_DIR)) fs.mkdirSync(ROMS_DIR, { recursive: true });

    const results = [];
    for (const rom of FLASH_ROM_MANIFEST) {
      const dest = path.join(ROMS_DIR, rom.file);
      if (fs.existsSync(dest)) { results.push({ file: rom.file, status: 'already-installed' }); continue; }
      try {
        const resp = await fetch(rom.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(dest, buffer);
        results.push({ file: rom.file, status: 'installed' });
      } catch (err) {
        results.push({ file: rom.file, status: 'error', error: err.message });
      }
    }
    res.json({ results });
  });

};
