// Attachments: image and file uploads for messages, and the Flash ROM pack
// used by the built-in games.

const fs = require('fs');
const path = require('path');
const { verifyToken } = require('../auth');
const { GAMES_ROMS_DIR } = require('../paths');
const storage = require('../storage');
const { blockedUploadType } = require('../uploadBlocklist');
const ROOT = path.join(__dirname, '..', '..');

module.exports = function registerUploads(deps) {
  const { uploadDiskGuard, app, recordUploadOwnership, uploadScopeFromRequest, uploadCapMb, verifyAdminFromDb, userHasPermission, upload, fileUpload, uploadLimiter } = deps;
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

    upload.single('image')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
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
      let finalName = req.file.filename;
      if (currentExt !== safeExt) {
        finalName = req.file.filename.replace(/\.[^.]+$/, '') + safeExt;
        fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), finalName));
      }
      try { await storage.admitUpload(req.file, finalName); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      recordUploadOwnership(user.id, finalName, req.file.size, uploadScopeFromRequest(req));
      res.json({ url: `/uploads/${finalName}` });
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

    fileUpload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
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

      // File types the admin refuses, such as exe or bat (#5833)
      const blockedList = getDb().prepare("SELECT value FROM server_settings WHERE key = 'blocked_upload_extensions'").get()?.value;
      const blockedType = blockedUploadType(originalName, blockedList) || blockedUploadType(req.file.filename, blockedList);
      if (blockedType) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `.${blockedType} files can't be uploaded on this server` });
      }

      try { await storage.admitUpload(req.file); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
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

  // ── Held-back upload status ──────────────────────────────
  // An older file the privacy pass could not clean is held back from
  // uploads/, so its message shows a note instead of a broken picture.
  app.get('/api/upload-status', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' });
    const rel = String(req.query.path || '').replace(/^\/?uploads\//, '');
    res.json({ state: require('../privacyPass').heldState(rel) });
  });

  // ── Flash ROM status & download ──────────────────────────
  // New downloads go to the data folder so they survive updates. Games
  // installed before that, in the app's own folder, still count.
  const ROMS_DIR = GAMES_ROMS_DIR;
  const OLD_ROMS_DIR = path.join(ROOT, 'public', 'games', 'roms');
  const romInstalled = (file) => fs.existsSync(path.join(ROMS_DIR, file)) || fs.existsSync(path.join(OLD_ROMS_DIR, file));
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
      installed: romInstalled(rom.file)
    }));
    const allInstalled = status.every(r => r.installed);
    res.json({ allInstalled, roms: status });
  });

  // The download runs in the background and the page asks how it is going.
  // The five files are about 37 MB, and one request held open that long was
  // cut off by reverse proxies in front of the server (Cloudflare gives up
  // after 100 seconds), which only ever said "Download failed".
  const flashInstall = { running: false, results: null };

  // Why a step failed, in words an admin can search for: a failed fetch keeps
  // the useful part (ENOTFOUND, ECONNREFUSED, a certificate error) in its cause.
  const reasonOf = (err) => {
    const code = err && (err.cause?.code || err.code);
    const msg = (err && (err.cause?.message || err.message)) || 'unknown error';
    return code && !msg.includes(code) ? `${msg} (${code})` : msg;
  };

  async function installFlashRoms() {
    try {
      fs.mkdirSync(ROMS_DIR, { recursive: true });
    } catch (err) {
      console.warn(`[flash] cannot create ${ROMS_DIR}: ${reasonOf(err)}`);
      return FLASH_ROM_MANIFEST.map(rom => ({ file: rom.file, status: 'error', error: `cannot create the games folder: ${reasonOf(err)}` }));
    }
    const results = [];
    for (const rom of FLASH_ROM_MANIFEST) {
      const dest = path.join(ROMS_DIR, rom.file);
      if (romInstalled(rom.file)) { results.push({ file: rom.file, status: 'already-installed' }); continue; }
      try {
        const resp = await fetch(rom.url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
        if (!resp.ok) throw new Error(`the download answered HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        // Written under a temporary name first, so a write that fails part
        // way never leaves a broken file that counts as installed.
        const part = dest + '.part';
        fs.writeFileSync(part, buffer);
        fs.renameSync(part, dest);
        results.push({ file: rom.file, status: 'installed' });
      } catch (err) {
        console.warn(`[flash] ${rom.file} failed: ${reasonOf(err)}`);
        results.push({ file: rom.file, status: 'error', error: reasonOf(err) });
      }
    }
    return results;
  }

  // Only admins can download the games or see how the download went.
  function flashAdmin(req, res) {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    const { getDb } = require('../database');
    const adminRow = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
    if (!adminRow || !adminRow.is_admin) { res.status(403).json({ error: 'Only admins can install flash games' }); return false; }
    return true;
  }

  app.post('/api/install-flash-roms', (req, res) => {
    if (!flashAdmin(req, res)) return;
    if (!flashInstall.running) {
      flashInstall.running = true;
      flashInstall.results = null;
      installFlashRoms()
        .then((results) => { flashInstall.results = results; })
        .catch((err) => {
          console.warn(`[flash] install stopped: ${reasonOf(err)}`);
          flashInstall.results = [{ file: '', status: 'error', error: reasonOf(err) }];
        })
        .finally(() => { flashInstall.running = false; });
    }
    res.status(202).json({ running: true });
  });

  app.get('/api/install-flash-roms', (req, res) => {
    if (!flashAdmin(req, res)) return;
    res.json({ running: flashInstall.running, results: flashInstall.results });
  });

};
