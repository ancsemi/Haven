// Sounds, custom emoji and stickers: uploads and deletes (for admins and
// members with the matching permission) and the lists every client loads.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { DATA_DIR } = require('../paths');
const { verifyToken } = require('../auth');
const { sanitizeSoundName } = require('../socketHandlers');
const ROOT = path.join(__dirname, '..', '..');

module.exports = function registerMediaLibrary(deps) {
  const { uploadDiskGuard, app, verifyAdminFromDb, userHasPermission, uploadDir, uploadStorage, uploadLimiter } = deps;
  // ── Built-in sounds (bundled with Haven, always available) ────
  const BUILTIN_SOUNDS = [
    { name: 'AOL - Door Open',       url: '/sounds/aol_door_open.mp3',   builtin: true },
    { name: 'AOL - Door Close',      url: '/sounds/aol_door_close.mp3',  builtin: true },
    { name: "AOL - You've Got Mail", url: '/sounds/aol_got_mail.mp3',    builtin: true },
    { name: 'AOL - Message',         url: '/sounds/aol_message.mp3',     builtin: true },
    { name: 'AOL - Files Done',      url: '/sounds/aol_filesdone.mp3',   builtin: true },
  ];

  // (#5426) Custom sounds, emojis and stickers are uploaded/deleted over HTTP,
  // so other connected clients never heard about the change and only saw it
  // after a full app restart. Broadcast a lightweight signal so every client
  // re-fetches the relevant library live. `io` is created later in server.js, so
  // resolve it at request time via app.set('io', io).
  function broadcastLibraryUpdate(req, kind) {
    try { req.app.get('io')?.emit('library-updated', { kind }); } catch { /* live refresh hint only; clients still see the change on next load */ }
  }

  // ── Sound upload (admin only, wav/mp3/ogg, configurable max size) ────
  function createSoundUpload() {
    const { getDb } = require('../database');
    const maxKb = parseInt(getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get('max_sound_kb')?.value) || 1024;
    return multer({
      storage: uploadStorage,
      limits: { fileSize: maxKb * 1024 },
      fileFilter: (req, file, cb) => {
        if (/^audio\/(mpeg|ogg|wav|webm)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only audio files allowed (mp3, ogg, wav, webm)'));
      }
    });
  }

  app.post('/api/upload-sound', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_soundboard')) return res.status(403).json({ error: 'Requires admin or Manage Soundboard permission' });

    createSoundUpload().single('sound')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      let name = sanitizeSoundName(req.body.name || '');
      if (!name) name = path.basename(req.file.filename, path.extname(req.file.filename));

      const { getDb } = require('../database');
      try {
        getDb().prepare(
          'INSERT OR REPLACE INTO custom_sounds (name, filename, uploaded_by) VALUES (?, ?, ?)'
        ).run(name, req.file.filename, user.id);
        broadcastLibraryUpdate(req, 'sounds');
        res.json({ name, url: `/uploads/${req.file.filename}` });
      } catch { res.status(500).json({ error: 'Failed to save sound' }); }
    });
  });

  app.get('/api/sounds', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { getDb } = require('../database');
    try {
      const disabledRows = getDb().prepare('SELECT name FROM disabled_builtin_sounds').all();
      const disabledSet = new Set(disabledRows.map(r => r.name));
      const enabledBuiltins = BUILTIN_SOUNDS.filter(s => !disabledSet.has(s.name));
      const custom = getDb().prepare('SELECT name, filename FROM custom_sounds ORDER BY name').all();
      const customList = custom.map(s => ({ name: s.name, url: `/uploads/${s.filename}` }));
      res.json({ sounds: [...enabledBuiltins, ...customList] });
    } catch { res.json({ sounds: [...BUILTIN_SOUNDS] }); }
  });

  app.delete('/api/sounds/:name', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_soundboard')) return res.status(403).json({ error: 'Requires admin or Manage Soundboard permission' });
    const name = req.params.name;
    const { getDb } = require('../database');
    try {
      // Built-in sounds are disabled by adding them to a blocklist (they can't be physically deleted)
      if (BUILTIN_SOUNDS.some(s => s.name === name)) {
        getDb().prepare('INSERT OR IGNORE INTO disabled_builtin_sounds (name) VALUES (?)').run(name);
        broadcastLibraryUpdate(req, 'sounds');
        return res.json({ ok: true });
      }
      const row = getDb().prepare('SELECT filename FROM custom_sounds WHERE name = ?').get(name);
      if (row) {
        try { fs.unlinkSync(path.join(uploadDir, row.filename)); } catch (err) {
          if (err.code !== 'ENOENT') console.warn(`[sounds] Could not delete file for sound "${name}":`, err.message);
        }
        getDb().prepare('DELETE FROM custom_sounds WHERE name = ?').run(name);
      }
      broadcastLibraryUpdate(req, 'sounds');
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Failed to delete sound' }); }
  });

  app.patch('/api/sounds/:name', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_soundboard')) return res.status(403).json({ error: 'Requires admin or Manage Soundboard permission' });
    const oldName = req.params.name;
    if (BUILTIN_SOUNDS.some(s => s.name === oldName)) return res.status(403).json({ error: 'Cannot rename built-in sounds' });
    const newName = sanitizeSoundName(req.body.newName || '');
    if (!newName) return res.status(400).json({ error: 'Invalid new name' });
    const { getDb } = require('../database');
    try {
      const row = getDb().prepare('SELECT id FROM custom_sounds WHERE name = ?').get(oldName);
      if (!row) return res.status(404).json({ error: 'Sound not found' });
      const existing = getDb().prepare('SELECT id FROM custom_sounds WHERE name = ? AND name != ?').get(newName, oldName);
      if (existing) return res.status(409).json({ error: 'Name already taken' });
      getDb().prepare('UPDATE custom_sounds SET name = ? WHERE name = ?').run(newName, oldName);
      broadcastLibraryUpdate(req, 'sounds');
      res.json({ ok: true, name: newName });
    } catch { res.status(500).json({ error: 'Failed to rename sound' }); }
  });

  // -- User sound preferences ---------------------------------------------------
  app.get('/api/user-sound-prefs', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { getDb } = require('../database');
    try {
      const rows = getDb().prepare('SELECT sound_name, hidden, custom_order FROM sound_preferences WHERE user_id = ?').all(user.id);
      const prefs = {};
      rows.forEach(r => { prefs[r.sound_name] = { hidden: !!r.hidden, customOrder: r.custom_order }; });
      res.json({ prefs });
    } catch { res.json({ prefs: {} }); }
  });

  app.post('/api/user-sound-prefs', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { prefs } = req.body || {};
    if (!prefs || typeof prefs !== 'object') return res.status(400).json({ error: 'Invalid prefs' });
    const { getDb } = require('../database');
    try {
      const db = getDb();
      const upsert = db.prepare('INSERT INTO sound_preferences (user_id, sound_name, hidden, custom_order) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, sound_name) DO UPDATE SET hidden = excluded.hidden, custom_order = excluded.custom_order');
      const runMany = db.transaction(() => { Object.entries(prefs).forEach(([name, pref]) => { upsert.run(user.id, name, pref.hidden ? 1 : 0, pref.customOrder ?? null); }); });
      runMany();
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Failed to save prefs' }); }
  });

  // ── Custom emoji upload (admin only, image, configurable max size) ──
  function createEmojiUpload() {
    const { getDb } = require('../database');
    const maxKb = parseInt(getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get('max_emoji_kb')?.value) || 256;
    return multer({
      storage: uploadStorage,
      limits: { fileSize: maxKb * 1024 },
      fileFilter: (req, file, cb) => {
        if (/^image\/(png|gif|webp|jpeg)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only images allowed (png, gif, webp, jpg)'));
      }
    });
  }

  app.post('/api/upload-emoji', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Emojis permission' });

    createEmojiUpload().single('emoji')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      let name = (req.body.name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      if (!name) name = path.basename(req.file.filename, path.extname(req.file.filename));
      if (name.length > 30) name = name.slice(0, 30);

      const { getDb } = require('../database');
      try {
        getDb().prepare(
          'INSERT OR REPLACE INTO custom_emojis (name, filename, uploaded_by) VALUES (?, ?, ?)'
        ).run(name, req.file.filename, user.id);
        broadcastLibraryUpdate(req, 'emojis');
        res.json({ name, url: `/uploads/${req.file.filename}` });
      } catch { res.status(500).json({ error: 'Failed to save emoji' }); }
    });
  });

  // ── Bulk emoji upload (multiple files, auto-named from filenames) ──
  app.post('/api/upload-emojis', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Emojis permission' });

    createEmojiUpload().array('emojis', 50)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

      const { getDb } = require('../database');
      const db = getDb();
      const results = [];
      const errors = [];
      const insert = db.prepare('INSERT OR REPLACE INTO custom_emojis (name, filename, uploaded_by) VALUES (?, ?, ?)');

      for (const file of req.files) {
        let name = path.basename(file.originalname, path.extname(file.originalname))
          .replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
        if (!name) name = path.basename(file.filename, path.extname(file.filename));
        if (name.length > 30) name = name.slice(0, 30);
        try {
          insert.run(name, file.filename, user.id);
          results.push({ name, url: `/uploads/${file.filename}` });
        } catch (e) {
          errors.push({ name, error: e.message });
        }
      }
      if (results.length) broadcastLibraryUpdate(req, 'emojis');
      res.json({ uploaded: results, errors });
    });
  });

  app.get('/api/emojis', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { getDb } = require('../database');
    try {
      const emojis = getDb().prepare('SELECT name, filename FROM custom_emojis ORDER BY name').all();
      res.json({ emojis: emojis.map(e => ({ name: e.name, url: `/uploads/${e.filename}` })) });
    } catch { res.json({ emojis: [] }); }
  });

  // Full Unicode emoji list (built from emoji-test.txt), rendered client-side
  // with the OS font. Falls back to the client's built-in list when unavailable.
  app.get('/api/standard-emojis', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' });
    res.json(require('../emoji').getEmojiData() || { categories: {}, names: {}, modifierBase: [] });
  });

  // ── Discord emote cache ─────────────────────────────────
  // A Discord custom emote travels as <:name:id> (or <a:name:id> when animated),
  // whether Ferry relayed it or a Haven member typed it so it shows on the
  // Discord side. Clients render that token as an inline image and load it from
  // here rather than from cdn.discordapp.com, so a third-party host never sees
  // who is scrolling through a bridged channel: the server fetches each emote
  // once and keeps it on disk. Only a server with the bridge switched on fetches
  // anything; everywhere else the client gets a 404 and shows the :name: text.
  const DISCORD_EMOTE_DIR = path.join(DATA_DIR, 'cache', 'discord-emotes');
  const DISCORD_EMOTE_MAX_BYTES = 512 * 1024;
  const DISCORD_EMOTE_MAX_FILES = 5000;
  const discordEmoteMisses = new Map();    // file -> when Discord last said it does not exist
  const discordEmoteInflight = new Map();  // file -> download in progress, so a burst of renders is one fetch
  const discordEmoteLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 300, message: { error: 'Rate limit exceeded' } });

  app.get('/api/ferry/emote/:file', discordEmoteLimiter, async (req, res) => {
    const m = /^(\d{15,25})\.(png|gif)$/.exec(String(req.params.file || ''));
    if (!m) return res.status(400).end();
    const file = m[0];
    const full = path.join(DISCORD_EMOTE_DIR, file);
    // An emote id never changes what it points at, so a copy is good forever.
    const sendOpts = { maxAge: 365 * 24 * 60 * 60 * 1000, immutable: true };
    if (fs.existsSync(full)) return res.sendFile(full, sendOpts);

    let ferryOn = false;
    try { ferryOn = !!require('../ferry').getFerryState().enabled; } catch { /* bridge not loaded */ }
    if (!ferryOn) return res.status(404).end();
    const missedAt = discordEmoteMisses.get(file);
    if (missedAt && Date.now() - missedAt < 6 * 60 * 60 * 1000) return res.status(404).end();

    let job = discordEmoteInflight.get(file);
    if (!job) {
      job = (async () => {
        fs.mkdirSync(DISCORD_EMOTE_DIR, { recursive: true });
        if (fs.readdirSync(DISCORD_EMOTE_DIR).length >= DISCORD_EMOTE_MAX_FILES) return false;
        const r = await fetch(`https://cdn.discordapp.com/emojis/${file}?size=64`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok || !/^image\//i.test(r.headers.get('content-type') || '')) return false;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > DISCORD_EMOTE_MAX_BYTES) return false;
        const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, full);
        return true;
      })().catch(() => false).finally(() => discordEmoteInflight.delete(file));
      discordEmoteInflight.set(file, job);
    }
    if (await job) return res.sendFile(full, sendOpts);
    discordEmoteMisses.set(file, Date.now());
    res.status(404).end();
  });

  app.delete('/api/emojis/:name', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Emojis permission' });
    const name = req.params.name;
    const { getDb } = require('../database');
    try {
      const row = getDb().prepare('SELECT filename FROM custom_emojis WHERE name = ?').get(name);
      if (row) {
        try { fs.unlinkSync(path.join(uploadDir, row.filename)); } catch (err) {
          if (err.code !== 'ENOENT') console.warn(`[emojis] Could not delete file for emoji "${name}":`, err.message);
        }
        getDb().prepare('DELETE FROM custom_emojis WHERE name = ?').run(name);
      }
      broadcastLibraryUpdate(req, 'emojis');
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Failed to delete emoji' }); }
  });

  // ── Stickers (admin/manage_stickers-only upload, anyone can list/send) ──
  // (#5335) `manage_stickers` is the canonical permission. We still accept
  // `manage_emojis` as a fallback so anyone who already had emoji-management
  // access keeps sticker access without an explicit re-grant.
  // Stored under uploads/stickers/<file> so message rendering can detect
  // them by URL prefix and render at sticker dimensions.
  const STICKERS_DIR = path.join(uploadDir, 'stickers');
  try { fs.mkdirSync(STICKERS_DIR, { recursive: true }); } catch (err) {
    console.error('[stickers] Could not create the stickers folder; sticker uploads will fail:', err.message);
  }

  // (#5335) Seed a small starter pack on first run so the picker isn't empty
  // out of the box. Files in public/starter-stickers/ are copied into
  // uploads/stickers/ and registered in the `stickers` table under the
  // "Starter" pack — but only if there are zero stickers in the DB. Once
  // any sticker exists we leave things alone so admin uploads or deletions
  // aren't trampled on next restart.
  function seedStarterStickers() {
    try {
      const { getDb } = require('../database');
      const db = getDb();
      const existing = db.prepare('SELECT COUNT(*) as c FROM stickers').get();
      if (existing && existing.c > 0) return;
      const seedDir = path.join(ROOT, 'public', 'starter-stickers');
      if (!fs.existsSync(seedDir)) return;
      const files = fs.readdirSync(seedDir).filter(f => /\.(svg|png|gif|webp|jpg|jpeg)$/i.test(f));
      const insert = db.prepare(
        'INSERT OR IGNORE INTO stickers (name, pack_name, filename, uploaded_by) VALUES (?, ?, ?, NULL)'
      );
      let seeded = 0;
      for (const file of files) {
        try {
          const ext = path.extname(file).toLowerCase();
          const baseName = path.basename(file, ext).toLowerCase().replace(/[^a-z0-9_-]/g, '');
          if (!baseName) continue;
          const destName = `starter-${baseName}${ext}`;
          const destPath = path.join(STICKERS_DIR, destName);
          if (!fs.existsSync(destPath)) fs.copyFileSync(path.join(seedDir, file), destPath);
          insert.run(baseName, 'Starter', destName);
          seeded++;
        } catch (err) {
          console.warn(`[stickers] Could not seed starter sticker ${file}:`, err.message);
        }
      }
      if (seeded > 0) console.log(`[stickers] Seeded ${seeded} starter sticker(s) into the "Starter" pack.`);
    } catch (err) {
      // Non-fatal — the server runs fine without the starter pack.
      console.warn('[stickers] Could not seed starter pack:', err?.message || err);
    }
  }
  const stickerStorage = multer.diskStorage({
    destination: STICKERS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  });
  function createStickerUpload() {
    const { getDb } = require('../database');
    // Stickers are larger than emojis by design — separate setting, default 1 MB.
    const maxKb = parseInt(getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get('max_sticker_kb')?.value) || 1024;
    return multer({
      storage: stickerStorage,
      limits: { fileSize: maxKb * 1024 },
      fileFilter: (req, file, cb) => {
        if (/^image\/(png|gif|webp|jpeg)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only images allowed (png, gif, webp, jpg)'));
      }
    });
  }

  app.post('/api/upload-sticker', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_stickers') && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Stickers permission' });

    createStickerUpload().single('sticker')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      let name = (req.body.name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      if (!name) name = path.basename(req.file.filename, path.extname(req.file.filename));
      if (name.length > 40) name = name.slice(0, 40);

      let pack = (req.body.pack_name || '').trim().slice(0, 40);
      if (!pack) pack = 'General';

      const { getDb } = require('../database');
      try {
        getDb().prepare(
          'INSERT OR REPLACE INTO stickers (name, pack_name, filename, uploaded_by) VALUES (?, ?, ?, ?)'
        ).run(name, pack, req.file.filename, user.id);
        broadcastLibraryUpdate(req, 'stickers');
        res.json({ name, pack_name: pack, url: `/uploads/stickers/${req.file.filename}` });
      } catch { res.status(500).json({ error: 'Failed to save sticker' }); }
    });
  });

  app.post('/api/upload-stickers', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_stickers') && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Stickers permission' });

    createStickerUpload().array('stickers', 50)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

      let pack = (req.body.pack_name || '').trim().slice(0, 40);
      if (!pack) pack = 'General';

      const { getDb } = require('../database');
      const db = getDb();
      const results = [];
      const errors = [];
      const insert = db.prepare('INSERT OR REPLACE INTO stickers (name, pack_name, filename, uploaded_by) VALUES (?, ?, ?, ?)');

      for (const file of req.files) {
        let name = path.basename(file.originalname, path.extname(file.originalname))
          .replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
        if (!name) name = path.basename(file.filename, path.extname(file.filename));
        if (name.length > 40) name = name.slice(0, 40);
        try {
          insert.run(name, pack, file.filename, user.id);
          results.push({ name, pack_name: pack, url: `/uploads/stickers/${file.filename}` });
        } catch (e) {
          errors.push({ name, error: e.message });
        }
      }

      if (results.length) broadcastLibraryUpdate(req, 'stickers');
      res.json({ uploaded: results, errors });
    });
  });

  app.get('/api/stickers', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { getDb } = require('../database');
    try {
      const rows = getDb().prepare('SELECT id, name, pack_name, filename FROM stickers ORDER BY pack_name COLLATE NOCASE, name COLLATE NOCASE').all();
      res.json({ stickers: rows.map(r => ({ id: r.id, name: r.name, pack_name: r.pack_name, url: `/uploads/stickers/${r.filename}` })) });
    } catch { res.json({ stickers: [] }); }
  });

  app.delete('/api/stickers/:name', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_stickers') && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Stickers permission' });
    const name = req.params.name;
    const { getDb } = require('../database');
    try {
      const row = getDb().prepare('SELECT filename FROM stickers WHERE name = ?').get(name);
      if (row) {
        try { fs.unlinkSync(path.join(STICKERS_DIR, row.filename)); } catch (err) {
          if (err.code !== 'ENOENT') console.warn(`[stickers] Could not delete file for sticker "${name}":`, err.message);
        }
        getDb().prepare('DELETE FROM stickers WHERE name = ?').run(name);
      }
      broadcastLibraryUpdate(req, 'stickers');
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Failed to delete sticker' }); }
  });

  return { BUILTIN_SOUNDS, seedStarterStickers };
};
