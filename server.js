// ── Resolve data directory BEFORE loading .env ────────────
const { DATA_DIR, DB_PATH, ENV_PATH, CERTS_DIR, UPLOADS_DIR } = require('./src/paths');

// ── Node.js version guard ─────────────────────────────────
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18 || nodeMajor >= 24) {
  console.error(`\n  Haven requires Node.js 18-22. You have v${process.versions.node}.`);
  console.error('  better-sqlite3 does not ship prebuilt binaries for Node 24+,');
  console.error('  so npm install will fail without C++ build tools.');
  console.error('  Install Node 22 LTS: https://nodejs.org/\n');
  process.exit(1);
}

// Bootstrap .env into the data directory if it doesn't exist yet
const fs = require('fs');
const path = require('path');
if (!fs.existsSync(ENV_PATH)) {
  const example = path.join(__dirname, '.env.example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, ENV_PATH);
    console.log(`📄 Created .env in ${DATA_DIR} from template`);
  } else {
    // Write a minimal .env so dotenv doesn't fail
    fs.writeFileSync(ENV_PATH, 'JWT_SECRET=change-me-to-something-random-and-long\n');
  }
}

require('dotenv').config({ path: ENV_PATH });
const express = require('express');
const { createServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { Server } = require('socket.io');
const crypto = require('crypto');
const helmet = require('helmet');
const multer = require('multer');

console.log(`📂 Data directory: ${DATA_DIR}`);

// ── Auto-generate JWT secret (MUST happen before loading auth module) ──
if (process.env.JWT_SECRET === 'change-me-to-something-random-and-long' || !process.env.JWT_SECRET) {
  const generated = crypto.randomBytes(48).toString('base64');
  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  envContent = envContent.replace(/JWT_SECRET=.*/, `JWT_SECRET=${generated}`);
  fs.writeFileSync(ENV_PATH, envContent);
  process.env.JWT_SECRET = generated;
  console.log('🔑 Auto-generated strong JWT_SECRET (saved to .env)');
}

// ── Auto-generate VAPID keys for push notifications ──────
const webpush = require('web-push');
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const vapidKeys = webpush.generateVAPIDKeys();
  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  envContent += `\nVAPID_PUBLIC_KEY=${vapidKeys.publicKey}\nVAPID_PRIVATE_KEY=${vapidKeys.privateKey}\n`;
  fs.writeFileSync(ENV_PATH, envContent);
  process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  console.log('🔔 Auto-generated VAPID keys for push notifications (saved to .env)');
}
// Configure web-push with contact email (admin can override via VAPID_EMAIL in .env)
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@haven.local';
webpush.setVapidDetails(vapidEmail, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const { initDatabase } = require('./src/database');
const { router: authRoutes, authLimiter, verifyToken } = require('./src/auth');
const { setupSocketHandlers, sanitizeText } = require('./src/socketHandlers');
const { startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup } = require('./src/tunnel');
const { initFcm } = require('./src/fcm');

const app = express();

// ── Helper: verify admin from DB (don't trust JWT claims alone) ─────
// JWT isAdmin may be stale if admin was demoted since token was issued.
function verifyAdminFromDb(user) {
  if (!user) return false;
  try {
    const { getDb } = require('./src/database');
    const row = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
    return !!(row && row.is_admin);
  } catch { return false; }
}

function userHasPermission(userId, permission) {
  if (!userId) return false;
  try {
    const { getDb } = require('./src/database');
    const isAdmin = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (isAdmin && isAdmin.is_admin) return true;
    const row = getDb().prepare(`
      SELECT 1 FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = ? AND rp.allowed = 1
      LIMIT 1
    `).get(userId, permission);
    return !!row;
  } catch { return false; }
}

// ── Security Headers (helmet) ────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "https://www.youtube.com", "https://w.soundcloud.com", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],  // inline styles + Google Fonts
      imgSrc: ["'self'", "data:", "blob:", "https:"],  // https: for link preview OG images + GIPHY
      connectSrc: ["'self'", "ws:", "wss:", "https:"],  // Socket.IO + cross-origin health checks
      mediaSrc: ["'self'", "blob:", "data:"],  // WebRTC audio + notification sounds
      fontSrc: ["'self'", "https://fonts.gstatic.com"],  // Google Fonts CDN
      workerSrc: ["'self'", "blob:", "https://unpkg.com"],  // service worker + Ruffle WebAssembly workers
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://open.spotify.com", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://w.soundcloud.com"],  // Listen Together embeds + game iframes
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],               // allow mobile app iframe, block third-party clickjacking
    }
  },
  crossOriginEmbedderPolicy: false,  // needed for WebRTC
  crossOriginOpenerPolicy: false,    // needed for WebRTC
  hsts: (process.env.FORCE_HTTP || '').toLowerCase() === 'true' ? false : { maxAge: 31536000, includeSubDomains: false }, // force HTTPS for 1 year (disabled when FORCE_HTTP=true)
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Additional security headers helmet doesn't cover
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Disable Express version disclosure
app.disable('x-powered-by');

// ── Body Parsing with size limits ────────────────────────
app.use(express.json({ limit: '16kb' }));  // no reason for large JSON bodies
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// ── Static files with caching ────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',       // block .env, .git, etc.
  etag: true,             // ETag for conditional requests
  lastModified: true,     // Last-Modified header
  maxAge: 0,              // always revalidate — prevents stale JS/CSS after deploys
}));

// ── Block access to deleted-attachments folder ──────────
// Files moved here are no longer part of any message; they should not be accessible.
app.use('/uploads/deleted-attachments', (req, res) => res.status(404).end());

// ── Serve uploads from external data directory ──────────
app.use('/uploads', express.static(UPLOADS_DIR, {
  dotfiles: 'deny',
  maxAge: '7d',       // 7 days — avatars & images rarely change; filenames include timestamps for uniqueness
  immutable: true,    // tells browser the file at this URL will never change (cache-busting via new filename)
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Force download for non-image files (prevents HTML/SVG execution in browser)
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

// ── Plugin & Theme file serving ─────────────────────────
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const THEMES_DIR  = path.join(__dirname, 'themes');
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
if (!fs.existsSync(THEMES_DIR))  fs.mkdirSync(THEMES_DIR, { recursive: true });

app.use('/plugins', express.static(PLUGINS_DIR, { dotfiles: 'deny', maxAge: 0 }));
app.use('/themes',  express.static(THEMES_DIR,  { dotfiles: 'deny', maxAge: 0 }));

// API: list available plugins (*.plugin.js files)
app.get('/api/plugins', (req, res) => {
  try {
    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.plugin.js'));
    const plugins = files.map(f => {
      // Try to read metadata from the first comment block
      const content = fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8');
      const meta = {};
      const metaMatch = content.match(/\/\*\*[\s\S]*?\*\//);
      if (metaMatch) {
        const block = metaMatch[0];
        const nameM = block.match(/@name\s+(.+)/);
        const descM = block.match(/@description\s+(.+)/);
        const authM = block.match(/@author\s+(.+)/);
        const verM  = block.match(/@version\s+(.+)/);
        if (nameM) meta.name = nameM[1].trim();
        if (descM) meta.description = descM[1].trim();
        if (authM) meta.author = authM[1].trim();
        if (verM)  meta.version = verM[1].trim();
      }
      return { file: f, ...meta };
    });
    res.json(plugins);
  } catch { res.json([]); }
});

// API: list available themes (*.theme.css files)
app.get('/api/themes', (req, res) => {
  try {
    const files = fs.readdirSync(THEMES_DIR).filter(f => f.endsWith('.theme.css'));
    const themes = files.map(f => {
      const content = fs.readFileSync(path.join(THEMES_DIR, f), 'utf8');
      const meta = {};
      const metaMatch = content.match(/\/\*\*[\s\S]*?\*\//);
      if (metaMatch) {
        const block = metaMatch[0];
        const nameM = block.match(/@name\s+(.+)/);
        const descM = block.match(/@description\s+(.+)/);
        const authM = block.match(/@author\s+(.+)/);
        const verM  = block.match(/@version\s+(.+)/);
        if (nameM) meta.name = nameM[1].trim();
        if (descM) meta.description = descM[1].trim();
        if (authM) meta.author = authM[1].trim();
        if (verM)  meta.version = verM[1].trim();
      }
      return { file: f, ...meta };
    });
    res.json(themes);
  } catch { res.json([]); }
});

// ── File uploads (DB-configurable limit, avatar max 5 MB) ──
const uploadDir = UPLOADS_DIR;

const uploadStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

// Image-only upload — multer cap is high; real limit enforced per-request from DB
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed (jpg, png, gif, webp)'));
  }
});

// General file upload — no MIME restrictions; safety enforced via
// Content-Disposition: attachment on non-image downloads (see /uploads handler)
const fileUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // hard cap 2 GB; DB-configurable limit enforced per-request
});

// ── API routes (rate-limited) ────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);

// ── Push notification VAPID public key endpoint ──────────
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Push notification subscription endpoints ─────────────
app.post('/api/push/subscribe', express.json(), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'Invalid subscription object' });

  try {
    const { getDb } = require('./src/database');
    getDb().prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth
    `).run(user.id, endpoint, keys.p256dh, keys.auth);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/push/subscribe', express.json(), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  try {
    const { getDb } = require('./src/database');
    getDb().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(user.id, endpoint);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/unsubscribe]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ICE servers endpoint (STUN + optional TURN) ──────────
app.get('/api/ice-servers', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const turnUrl = process.env.TURN_URL;
  if (turnUrl) {
    const turnSecret = process.env.TURN_SECRET;
    const turnUser = process.env.TURN_USERNAME;
    const turnPass = process.env.TURN_PASSWORD;

    if (turnSecret) {
      // Time-limited TURN credentials (coturn --use-auth-secret / REST API)
      const ttl = 24 * 3600; // 24 hours
      const expiry = Math.floor(Date.now() / 1000) + ttl;
      const username = `${expiry}:${user.username}`;
      const hmac = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      iceServers.push({ urls: turnUrl, username, credential: hmac });
    } else if (turnUser && turnPass) {
      // Static TURN credentials
      iceServers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
    } else {
      // TURN URL with no auth (uncommon but possible)
      iceServers.push({ urls: turnUrl });
    }
  }

  res.json({ iceServers });
});

// ── Avatar upload endpoint (saves to /uploads, updates DB) ──
app.post('/api/upload-avatar', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { getDb } = require('./src/database');
  const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
  if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

  upload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size > 2 * 1024 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Avatar must be under 2 MB' });
    }

    // Validate file magic bytes
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
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Failed to validate file' });
    }

    // Force safe extension
    const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const safeExt = mimeToExt[req.file.mimetype];
    if (!safeExt) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid file type' });
    }
    const currentExt = path.extname(req.file.filename).toLowerCase();
    let finalName = req.file.filename;
    if (currentExt !== safeExt) {
      finalName = req.file.filename.replace(/\.[^.]+$/, '') + safeExt;
      const oldPath = req.file.path;
      const newPath = path.join(uploadDir, finalName);
      fs.renameSync(oldPath, newPath);
    }
    const avatarUrl = `/uploads/${finalName}`;

    // Update the user's avatar in the database
    try {
      const db = getDb();
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, user.id);
      console.log(`[Avatar] ${user.username} uploaded avatar: ${avatarUrl}`);
    } catch (dbErr) {
      console.error('Avatar DB update error:', dbErr);
      return res.status(500).json({ error: 'Failed to save avatar' });
    }

    res.json({ url: avatarUrl });
  });
});

// ── Avatar remove endpoint ──
app.post('/api/remove-avatar', express.json(), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { getDb } = require('./src/database');
    getDb().prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Avatar remove error:', err);
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

app.post('/api/upload-proxy-avatar', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { getDb } = require('./src/database');
  const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
  if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

  upload.single('proxyAvatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const settingRow = getDb().prepare("SELECT value FROM server_settings WHERE key = 'max_proxy_avatar_kb'").get();
    const maxKb = Math.max(32, Math.min(2048, parseInt(settingRow?.value || '256', 10) || 256));
    if (req.file.size > maxKb * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Proxy avatar must be under ${maxKb} KB` });
    }

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
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Failed to validate file' });
    }

    const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const safeExt = mimeToExt[req.file.mimetype];
    if (!safeExt) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const currentExt = path.extname(req.file.filename).toLowerCase();
    let finalName = req.file.filename;
    if (currentExt !== safeExt) {
      finalName = req.file.filename.replace(/\.[^.]+$/, '') + safeExt;
      fs.renameSync(req.file.path, path.join(uploadDir, finalName));
    }

    res.json({ url: `/uploads/${finalName}`, maxKb });
  });
});

// ── Avatar shape endpoint ──
app.post('/api/set-avatar-shape', express.json(), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const validShapes = ['circle', 'rounded', 'squircle', 'hex', 'diamond'];
  const shape = validShapes.includes(req.body.shape) ? req.body.shape : 'circle';
  try {
    const { getDb } = require('./src/database');
    getDb().prepare('UPDATE users SET avatar_shape = ? WHERE id = ?').run(shape, user.id);
    res.json({ shape });
  } catch (err) {
    console.error('Avatar shape error:', err);
    res.status(500).json({ error: 'Failed to save shape' });
  }
});

// ── Webhook/Bot avatar upload endpoint ──
app.post('/api/upload-webhook-avatar', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Only admins can manage webhooks
  const { getDb } = require('./src/database');
  const dbUser = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
  if (!dbUser || !dbUser.is_admin) return res.status(403).json({ error: 'Admin only' });

  upload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Validate file magic bytes
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
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Failed to validate file' });
    }

    const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const safeExt = mimeToExt[req.file.mimetype];
    if (!safeExt) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid file type' });
    }
    const currentExt = path.extname(req.file.filename).toLowerCase();
    let finalName = req.file.filename;
    if (currentExt !== safeExt) {
      finalName = req.file.filename.replace(/\.[^.]+$/, '') + safeExt;
      fs.renameSync(req.file.path, path.join(uploadDir, finalName));
    }
    const avatarUrl = `/uploads/${finalName}`;

    // Update the webhook's avatar in DB
    const webhookId = parseInt(req.body?.webhookId || req.query?.webhookId);
    if (!isNaN(webhookId)) {
      try {
        getDb().prepare('UPDATE webhooks SET avatar_url = ? WHERE id = ?').run(avatarUrl, webhookId);
      } catch (dbErr) {
        console.error('Webhook avatar DB error:', dbErr);
      }
    }
    res.json({ url: avatarUrl });
  });
});

// ── Serve pages ──────────────────────────────────────────

// ── Tunnel API (Admin only) ──────────────────────────────
app.get('/api/tunnel/status', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
  res.json(getTunnelStatus());
});

app.post('/api/tunnel/sync', express.json(), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
  try {
    // Use values from the request body directly (DB may not have saved yet)
    const enabled = req.body.enabled === true;
    const provider = req.body.provider || 'localtunnel';
    if (!enabled) await stopTunnel();
    else await startTunnel(PORT, provider, useSSL);
    res.json(getTunnelStatus());
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Tunnel sync failed' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/games/flappy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'games', 'flappy.html'));
});

// ── Donors / sponsors list (loaded from donors.json) ──
app.get('/api/donors', (req, res) => {
  try {
    const donorsPath = path.join(__dirname, 'donors.json');
    const data = JSON.parse(fs.readFileSync(donorsPath, 'utf-8'));
    res.json(data);
  } catch {
    res.json({ sponsors: [], donors: [] });
  }
});

// ── Health check (CORS allowed for multi-server status pings) ──
app.get('/api/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  let name = process.env.SERVER_NAME || 'Haven';
  let icon = null;
  try {
    const { getDb } = require('./src/database');
    const db = getDb();
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get();
    if (row && row.value) name = row.value;
    const iconRow = db.prepare("SELECT value FROM server_settings WHERE key = 'server_icon'").get();
    if (iconRow && iconRow.value) icon = iconRow.value;
  } catch {}
  res.json({
    status: 'online',
    name,
    icon
    // version intentionally omitted — don't fingerprint the server for attackers
  });
});

// ── Version endpoint (for update checker — authenticated users only) ──
app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version });
});

// ── Public config (unauthenticated — safe, read-only aesthetics) ──
// Returns the admin-configured default theme so the login page can match
// the server's look for first-time visitors who have no localStorage preference.
app.get('/api/public-config', (req, res) => {
  try {
    const { getDb } = require('./src/database');
    const db = getDb();
    const themeRow = db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get();
    const titleRow = db.prepare("SELECT value FROM server_settings WHERE key = 'server_title'").get();
    res.json({
      default_theme: themeRow?.value || '',
      server_title: titleRow?.value || ''
    });
  } catch {
    res.json({ default_theme: '', server_title: '' });
  }
});

// ── Port reachability check (Admin only) ─────────────────
// Uses external services to test if this server is reachable from the internet.
// Returns { reachable: bool, publicIp: string|null, error: string|null }
app.get('/api/port-check', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  const port = process.env.PORT || 3000;
  const https = require('https');
  const http = require('http');

  // Step 1: Get public IP
  let publicIp = null;
  try {
    publicIp = await new Promise((resolve, reject) => {
      const req = https.get('https://api.ipify.org?format=json', { timeout: 5000 }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try { resolve(JSON.parse(data).ip); }
          catch { reject(new Error('Bad response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  } catch {
    return res.json({ reachable: false, publicIp: null, error: 'Could not determine public IP. You may be offline.' });
  }

  // Step 2: Check if port is reachable via external probe
  let reachable = false;
  try {
    reachable = await new Promise((resolve, reject) => {
      const url = `https://portchecker.io/api/v1/query?host=${publicIp}&ports=${port}`;
      const req = https.get(url, { timeout: 10000 }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try {
            const result = JSON.parse(data);
            // portchecker.io returns { host, ports: [{ port, status }] }
            const portResult = result.ports?.find(p => p.port === parseInt(port));
            resolve(portResult?.status === 'open');
          } catch { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } catch {
    // Fallback: try to connect to ourselves from public IP
    try {
      const proto = useSSL ? https : http;
      reachable = await new Promise((resolve) => {
        const req = proto.get(`${useSSL ? 'https' : 'http'}://${publicIp}:${port}/api/health`, {
          timeout: 5000,
          // SECURITY NOTE: rejectUnauthorized:false is intentional here — this
          // connects to OUR OWN public IP to test reachability. Self-signed certs
          // used by Haven would fail standard verification. This never connects
          // to third-party servers.
          rejectUnauthorized: false
        }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            try { resolve(JSON.parse(data).status === 'online'); }
            catch { resolve(false); }
          });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
    } catch { reachable = false; }
  }

  res.json({ reachable, publicIp, error: null });
});

// ── Upload rate limiting ─────────────────────────────────
const uploadLimitStore = new Map();
function uploadLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxUploads = 10;
  if (!uploadLimitStore.has(ip)) uploadLimitStore.set(ip, []);
  const stamps = uploadLimitStore.get(ip).filter(t => now - t < windowMs);
  uploadLimitStore.set(ip, stamps);
  if (stamps.length >= maxUploads) return res.status(429).json({ error: 'Upload rate limit — try again in a minute' });
  stamps.push(now);
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of uploadLimitStore) { const f = t.filter(x => now - x < 60000); if (!f.length) uploadLimitStore.delete(ip); else uploadLimitStore.set(ip, f); } }, 5 * 60 * 1000);

// ── Image upload (authenticated + not banned) ────────────
app.post('/api/upload', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Check if user is banned
  const { getDb } = require('./src/database');
  const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
  if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

  // Enforce upload_files permission (admin always allowed)
  if (!verifyAdminFromDb(user)) {
    const hasPerm = getDb().prepare(`
      SELECT 1 FROM role_permissions rp
      JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = 'upload_files' AND rp.allowed = 1 LIMIT 1
    `).get(user.id);
    if (!hasPerm) return res.status(403).json({ error: 'You don\'t have permission to upload files' });
  }

  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Enforce DB-configurable max upload size (same setting as general file uploads)
    const maxMbRow = getDb().prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get();
    const maxBytes = (parseInt(maxMbRow?.value) || 25) * 1024 * 1024;
    if (req.file.size > maxBytes) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Image too large (max ${maxMbRow?.value || 25} MB)` });
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
      try { fs.unlinkSync(req.file.path); } catch {}
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
      return res.json({ url: `/uploads/${safeName}` });
    }
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

// ── General file upload (authenticated + not banned) ─────
app.post('/api/upload-file', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { getDb } = require('./src/database');
  const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
  if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

  // Enforce upload_files permission (admin always allowed)
  if (!verifyAdminFromDb(user)) {
    const hasPerm = getDb().prepare(`
      SELECT 1 FROM role_permissions rp
      JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = 'upload_files' AND rp.allowed = 1 LIMIT 1
    `).get(user.id);
    if (!hasPerm) return res.status(403).json({ error: 'You don\'t have permission to upload files' });
  }

  fileUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Enforce DB-configurable max upload size
    const maxMbRow = getDb().prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get();
    const maxBytes = (parseInt(maxMbRow?.value) || 25) * 1024 * 1024;
    if (req.file.size > maxBytes) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `File too large (max ${maxMbRow?.value || 25} MB)` });
    }

    const isImage = /^image\//.test(req.file.mimetype);
    // multer passes the raw bytes from the multipart header as a latin1 string;
    // browsers encode filenames as UTF-8 bytes, so re-decode to recover the
    // original text (fixes garbled Chinese/emoji/non-ASCII filenames).
    const originalName = Buffer.from(req.file.originalname || 'file', 'latin1').toString('utf8');
    const fileSize = req.file.size;

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
const ROMS_DIR = path.join(__dirname, 'public', 'games', 'roms');
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
  const { getDb } = require('./src/database');
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

// (duplicate avatar handler removed — handled above at /api/upload-avatar)

// ── Built-in sounds (bundled with Haven, always available) ────
const BUILTIN_SOUNDS = [
  { name: 'AOL - Door Open',       url: '/sounds/aol_door_open.mp3',   builtin: true },
  { name: 'AOL - Door Close',      url: '/sounds/aol_door_close.mp3',  builtin: true },
  { name: "AOL - You've Got Mail", url: '/sounds/aol_got_mail.mp3',    builtin: true },
  { name: 'AOL - Message',         url: '/sounds/aol_message.mp3',     builtin: true },
  { name: 'AOL - Files Done',      url: '/sounds/aol_filesdone.mp3',   builtin: true },
];

// ── Sound upload (admin only, wav/mp3/ogg, configurable max size) ────
function createSoundUpload() {
  const { getDb } = require('./src/database');
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

app.post('/api/upload-sound', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_soundboard')) return res.status(403).json({ error: 'Requires admin or Manage Soundboard permission' });

  createSoundUpload().single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let name = (req.body.name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) name = path.basename(req.file.filename, path.extname(req.file.filename));
    if (name.length > 30) name = name.slice(0, 30);

    const { getDb } = require('./src/database');
    try {
      getDb().prepare(
        'INSERT OR REPLACE INTO custom_sounds (name, filename, uploaded_by) VALUES (?, ?, ?)'
      ).run(name, req.file.filename, user.id);
      res.json({ name, url: `/uploads/${req.file.filename}` });
    } catch { res.status(500).json({ error: 'Failed to save sound' }); }
  });
});

app.get('/api/sounds', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { getDb } = require('./src/database');
  try {
    const custom = getDb().prepare('SELECT name, filename FROM custom_sounds ORDER BY name').all();
    const customList = custom.map(s => ({ name: s.name, url: `/uploads/${s.filename}` }));
    res.json({ sounds: [...BUILTIN_SOUNDS, ...customList] });
  } catch { res.json({ sounds: [...BUILTIN_SOUNDS] }); }
});

app.delete('/api/sounds/:name', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_soundboard')) return res.status(403).json({ error: 'Requires admin or Manage Soundboard permission' });
  if (BUILTIN_SOUNDS.some(s => s.name === req.params.name)) return res.status(403).json({ error: 'Cannot delete built-in sounds' });
  const name = req.params.name;
  const { getDb } = require('./src/database');
  try {
    const row = getDb().prepare('SELECT filename FROM custom_sounds WHERE name = ?').get(name);
    if (row) {
      try { fs.unlinkSync(path.join(uploadDir, row.filename)); } catch {}
      getDb().prepare('DELETE FROM custom_sounds WHERE name = ?').run(name);
    }
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
  let newName = (req.body.newName || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim();
  if (!newName || newName.length > 30) return res.status(400).json({ error: 'Invalid new name' });
  const { getDb } = require('./src/database');
  try {
    const row = getDb().prepare('SELECT id FROM custom_sounds WHERE name = ?').get(oldName);
    if (!row) return res.status(404).json({ error: 'Sound not found' });
    const existing = getDb().prepare('SELECT id FROM custom_sounds WHERE name = ? AND name != ?').get(newName, oldName);
    if (existing) return res.status(409).json({ error: 'Name already taken' });
    getDb().prepare('UPDATE custom_sounds SET name = ? WHERE name = ?').run(newName, oldName);
    res.json({ ok: true, name: newName });
  } catch { res.status(500).json({ error: 'Failed to rename sound' }); }
});

// ── Custom emoji upload (admin only, image, configurable max size) ──
function createEmojiUpload() {
  const { getDb } = require('./src/database');
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

app.post('/api/upload-emoji', uploadLimiter, (req, res) => {
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

    const { getDb } = require('./src/database');
    try {
      getDb().prepare(
        'INSERT OR REPLACE INTO custom_emojis (name, filename, uploaded_by) VALUES (?, ?, ?)'
      ).run(name, req.file.filename, user.id);
      res.json({ name, url: `/uploads/${req.file.filename}` });
    } catch { res.status(500).json({ error: 'Failed to save emoji' }); }
  });
});

// ── Bulk emoji upload (multiple files, auto-named from filenames) ──
app.post('/api/upload-emojis', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Emojis permission' });

  createEmojiUpload().array('emojis', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const { getDb } = require('./src/database');
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
    res.json({ uploaded: results, errors });
  });
});

app.get('/api/emojis', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { getDb } = require('./src/database');
  try {
    const emojis = getDb().prepare('SELECT name, filename FROM custom_emojis ORDER BY name').all();
    res.json({ emojis: emojis.map(e => ({ name: e.name, url: `/uploads/${e.filename}` })) });
  } catch { res.json({ emojis: [] }); }
});

app.delete('/api/emojis/:name', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_emojis')) return res.status(403).json({ error: 'Requires admin or Manage Emojis permission' });
  const name = req.params.name;
  const { getDb } = require('./src/database');
  try {
    const row = getDb().prepare('SELECT filename FROM custom_emojis WHERE name = ?').get(name);
    if (row) {
      try { fs.unlinkSync(path.join(uploadDir, row.filename)); } catch {}
      getDb().prepare('DELETE FROM custom_emojis WHERE name = ?').run(name);
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to delete emoji' }); }
});

// ── GIF search proxy (GIPHY API — keeps key server-side) ──
function getGiphyKey() {
  // Check database first (set via admin panel), fall back to .env
  try {
    const { getDb } = require('./src/database');
    const row = getDb().prepare("SELECT value FROM server_settings WHERE key = 'giphy_api_key'").get();
    if (row && row.value) return row.value;
  } catch { /* DB not ready yet or no key stored */ }
  return process.env.GIPHY_API_KEY || '';
}

// ── Server icon upload (admin only, image only, max 2 MB) ──
app.post('/api/upload-server-icon', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size > 2 * 1024 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Server icon must be under 2 MB' });
    }
    // Validate magic bytes
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
      if (!validMagic) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid image' }); }
    } catch { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Failed to validate' }); }

    const iconUrl = `/uploads/${req.file.filename}`;
    const { getDb } = require('./src/database');
    getDb().prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_icon', ?)").run(iconUrl);
    res.json({ url: iconUrl });
  });
});

// ── GIF endpoint rate limiting (per IP) ──────────────────
const gifLimitStore = new Map();
function gifLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxReqs = 30;
  if (!gifLimitStore.has(ip)) gifLimitStore.set(ip, []);
  const stamps = gifLimitStore.get(ip).filter(t => now - t < windowMs);
  gifLimitStore.set(ip, stamps);
  if (stamps.length >= maxReqs) return res.status(429).json({ error: 'Rate limited — try again shortly' });
  stamps.push(now);
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of gifLimitStore) { const f = t.filter(x => now - x < 60000); if (!f.length) gifLimitStore.delete(ip); else gifLimitStore.set(ip, f); } }, 5 * 60 * 1000);

app.get('/api/gif/search', gifLimiter, (req, res) => {
  // Require authentication
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const key = getGiphyKey();
  if (!key) return res.status(501).json({ error: 'gif_not_configured' });
  const q = (req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=${limit}&rating=r&lang=en`;
  fetch(url).then(r => r.json()).then(data => {
    const results = (data.data || []).map(g => ({
      id: g.id,
      title: g.title || '',
      tiny: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || '',
      full: g.images?.original?.url || '',
    }));
    res.json({ results });
  }).catch(() => res.status(502).json({ error: 'GIPHY API error' }));
});

app.get('/api/gif/trending', gifLimiter, (req, res) => {
  // Require authentication
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const key = getGiphyKey();
  if (!key) return res.status(501).json({ error: 'gif_not_configured' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const url = `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(key)}&limit=${limit}&rating=r`;
  fetch(url).then(r => r.json()).then(data => {
    const results = (data.data || []).map(g => ({
      id: g.id,
      title: g.title || '',
      tiny: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || '',
      full: g.images?.original?.url || '',
    }));
    res.json({ results });
  }).catch(() => res.status(502).json({ error: 'GIPHY API error' }));
});

// ── Link preview (Open Graph metadata) ──────────────────
const linkPreviewCache = new Map(); // url → { data, ts }
const PREVIEW_CACHE_TTL = 30 * 60 * 1000; // 30 min
const PREVIEW_MAX_SIZE = 256 * 1024; // only read first 256 KB of page

// Decode common HTML entities in OG-scraped attribute values.
// Without this, image URLs containing '&amp;' get double-encoded on the client.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
const dns = require('dns');
const { promisify } = require('util');
const dnsResolve = promisify(dns.resolve4);

// Rate limit link preview fetches (per IP, separate from upload limiter)
const previewLimitStore = new Map();
function previewLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReqs = 30; // 30 previews per minute per user
  if (!previewLimitStore.has(ip)) previewLimitStore.set(ip, []);
  const stamps = previewLimitStore.get(ip).filter(t => now - t < windowMs);
  previewLimitStore.set(ip, stamps);
  if (stamps.length >= maxReqs) return res.status(429).json({ error: 'Rate limited — try again shortly' });
  stamps.push(now);
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of previewLimitStore) { const f = t.filter(x => now - x < 60000); if (!f.length) previewLimitStore.delete(ip); else previewLimitStore.set(ip, f); } }, 5 * 60 * 1000);

// Check if an IP is private/internal
function isPrivateIP(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1' || ip === '::' ||
    ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('169.254.') || ip.startsWith('fc00:') || ip.startsWith('fd') ||
    ip.startsWith('fe80:');
}

// Check if a hostname is private/internal (SSRF layer 1)
function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
    host === '::1' || host === '[::1]' ||
    host.startsWith('10.') || host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '169.254.169.254' ||
    host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost');
}

// Validate a URL is safe to fetch (not internal/private) — checks hostname + DNS
async function validateUrlSafe(urlStr) {
  const parsed = new URL(urlStr);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs allowed');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('Private addresses not allowed');
  }
  // SSRF layer 2: DNS resolution check (defeats DNS rebinding)
  try {
    const addresses = await dnsResolve(parsed.hostname);
    if (addresses.some(isPrivateIP)) {
      throw new Error('Private addresses not allowed');
    }
  } catch (err) {
    if (err.message === 'Private addresses not allowed') throw err;
    // DNS resolution failed — could be IPv6-only or non-existent; allow fetch to fail naturally
  }
  return parsed;
}

app.get('/api/link-preview', previewLimiter, async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Validate the initial URL is safe (protocol, hostname, DNS)
  let parsed;
  try {
    parsed = await validateUrlSafe(url);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid URL' });
  }

  // Cache check
  const cached = linkPreviewCache.get(url);
  if (cached && Date.now() - cached.ts < PREVIEW_CACHE_TTL) {
    return res.json(cached.data);
  }

  // Use a real browser UA — many sites (Twitter/X, Instagram, etc.) serve
  // JS-only pages to unknown bots, omitting the OG meta tags we need.
  const PREVIEW_UA = 'Mozilla/5.0 (compatible; HavenBot/2.1; +https://github.com/ancsemi/Haven)';

  try {
    let data = null;

    // ── Site-specific oEmbed handlers ────────────────────
    // Native twitter.com / x.com — their HTML requires JS rendering so the generic
    // scraper gets blank OG tags. The oEmbed API returns structured data directly.
    // NOTE: fxtwitter / vxtwitter / fixupx are proxy sites that deliberately serve
    // their own OG-enriched HTML — they must NOT be routed here; they fall through
    // to the generic OG scraper below which picks up their tags directly.
    const twitterMatch = url.match(/^https?:\/\/(?:(?:www\.|mobile\.)?(?:twitter|x)\.com)\/\w+\/status\/\d+/i);
    if (twitterMatch) {
      try {
        const oembed = await fetch(
          `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`,
          { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA } }
        );
        if (oembed.ok) {
          const oj = await oembed.json();
          // Strip HTML tags from the embedded HTML to extract text
          const text = (oj.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          data = {
            title: oj.author_name ? `${oj.author_name} on ${oj.provider_name || 'X'}` : (oj.provider_name || 'X'),
            description: text.slice(0, 280) || null,
            image: null, // Twitter oEmbed doesn't return images, OG scrape below may add one
            siteName: oj.provider_name || 'X',
            url: oj.url || url
          };
        }
      } catch { /* fall through to generic scrape */ }
    }

    // ── fxtwitter / vxtwitter / fixupx fallback for native Twitter/X links ──
    // If the oEmbed handler above didn't fire (non-matching URL) or failed,
    // and the URL is a native twitter.com/x.com link, try fxtwitter as an
    // OG-enriched proxy. fxtwitter serves bot-friendly HTML with OG tags.
    if (!data && /^https?:\/\/(?:(?:www\.|mobile\.)?(?:twitter|x)\.com)\/\w+\/status\/\d+/i.test(url)) {
      try {
        const fxUrl = url.replace(/^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com/i, 'https://fxtwitter.com');
        const fxResp = await fetch(fxUrl, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'text/html' },
          redirect: 'manual'
        });
        if (fxResp.ok) {
          const fxHtml = (await fxResp.text()).slice(0, PREVIEW_MAX_SIZE);
          const fxMeta = (prop) => {
            const r1 = new RegExp(`<meta[^>]*?(?:property|name)=["']${prop}["'][^>]*?content=["']([^"']+)["']`, 'is');
            const r2 = new RegExp(`<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${prop}["']`, 'is');
            const m = fxHtml.match(r1) || fxHtml.match(r2);
            return m ? decodeHtmlEntities(m[1].trim()) : null;
          };
          const fxTitle = fxMeta('og:title') || fxMeta('twitter:title');
          const fxDesc = fxMeta('og:description') || fxMeta('twitter:description');
          const fxImg = fxMeta('og:image') || fxMeta('twitter:image');
          if (fxTitle || fxDesc) {
            data = {
              title: fxTitle,
              description: fxDesc,
              image: fxImg,
              siteName: fxMeta('og:site_name') || 'X',
              url
            };
          }
        }
      } catch { /* fxtwitter fallback failed — continue to generic scrape */ }
    }

    // ── Reddit — serves no OG tags to unknown bots; use JSON API instead ──
    if (!data && /^https?:\/\/(?:(?:www|old|new)\.)?reddit\.com\/r\/[\w]+\/comments\/[\w]+/i.test(url)) {
      try {
        // Reddit's .json endpoint works with any User-Agent
        const jsonUrl = url.replace(/\/?(?:\?.*)?$/, '/.json');
        const rResp = await fetch(jsonUrl, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': PREVIEW_UA }
        });
        if (rResp.ok) {
          const rJson = await rResp.json();
          const post = rJson?.[0]?.data?.children?.[0]?.data;
          if (post) {
            const redTitle = `${post.subreddit_name_prefixed || 'Reddit'}: ${post.title || ''}`;
            let redImage = null;
            let redImages;

            if (post.is_gallery && post.media_metadata) {
              // Gallery post — collect up to 4 preview images
              const imgs = Object.values(post.media_metadata)
                .filter(m => m.status === 'valid' && m.s?.u)
                .map(m => decodeHtmlEntities(m.s.u))
                .slice(0, 4);
              if (imgs.length >= 2) redImages = imgs;
              redImage = imgs[0] || null;
            } else if (post.preview?.images?.[0]?.source?.url) {
              redImage = decodeHtmlEntities(post.preview.images[0].source.url);
            } else if (post.thumbnail && post.thumbnail !== 'self' && post.thumbnail !== 'default' && post.thumbnail !== 'nsfw' && post.thumbnail !== 'spoiler') {
              redImage = post.thumbnail;
            }

            data = {
              title: redTitle,
              description: post.selftext ? post.selftext.slice(0, 280) : null,
              image: redImage,
              images: redImages,
              siteName: 'Reddit',
              url
            };
          }
        }
      } catch { /* Reddit JSON fallback failed — continue to generic scrape */ }
    }

    // ── Pixiv — blocks bots for HTML but provides an oEmbed API ────────
    if (!data && /^https?:\/\/(?:www\.)?pixiv\.net\/(?:en\/)?artworks\/\d+/i.test(url)) {
      try {
        const poEmbed = await fetch(
          `https://embed.pixiv.net/oembed.php?url=${encodeURIComponent(url)}&format=json`,
          { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA } }
        );
        if (poEmbed.ok) {
          const oj = await poEmbed.json();
          data = {
            title: oj.title || null,
            description: oj.author_name ? `by ${oj.author_name}` : null,
            image: oj.thumbnail_url || null,
            siteName: 'pixiv',
            url
          };
        }
      } catch { /* fall through to generic scrape */ }
    }

    // ── Generic OG scrape (manual redirect following with SSRF checks) ──
    if (!data) {
      let currentUrl = url;
      let resp;
      const MAX_REDIRECTS = 5;
      for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        resp = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': PREVIEW_UA,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          redirect: 'manual'  // handle redirects manually to re-check SSRF
        });
        clearTimeout(timeout);
        // If redirect, validate the new URL before following
        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          const location = resp.headers.get('location');
          if (!location) break;
          // Resolve relative redirects
          const nextUrl = new URL(location, currentUrl).href;
          try {
            await validateUrlSafe(nextUrl);
          } catch {
            // Redirect target is private/internal — abort (SSRF protection)
            return res.json({ title: null, description: null, image: null, siteName: null });
          }
          currentUrl = nextUrl;
          continue;
        }
        break; // not a redirect, use this response
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        linkPreviewCache.set(url, { data: { title: null, description: null, image: null, siteName: null }, ts: Date.now() });
        return res.json({ title: null, description: null, image: null, siteName: null });
      }

      const html = await resp.text();
      const chunk = html.slice(0, PREVIEW_MAX_SIZE);

      // Regex helper — handles attributes spanning multiple lines and both
      // orderings: property before content, and content before property.
      // Decodes HTML entities so image URLs with &amp; etc. work correctly.
      const getMetaContent = (property) => {
        const re1 = new RegExp(`<meta[^>]*?(?:property|name)=["']${property}["'][^>]*?content=["']([^"']+)["']`, 'is');
        const re2 = new RegExp(`<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${property}["']`, 'is');
        const m = chunk.match(re1) || chunk.match(re2);
        return m ? decodeHtmlEntities(m[1].trim()) : null;
      };

      // Returns ALL values for a given OG property (e.g. multiple og:image tags
      // for tweet galleries or reddit image galleries). Deduped, max 4 results.
      // Decodes HTML entities in each value.
      const getAllMetaContent = (property) => {
        const seen = new Set();
        const re1 = new RegExp(`<meta[^>]*?(?:property|name)=["']${property}["'][^>]*?content=["']([^"']+)["']`, 'gi');
        const re2 = new RegExp(`<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${property}["']`, 'gi');
        let m;
        while ((m = re1.exec(chunk)) !== null) seen.add(decodeHtmlEntities(m[1].trim()));
        while ((m = re2.exec(chunk)) !== null) seen.add(decodeHtmlEntities(m[1].trim()));
        return [...seen].slice(0, 4);
      };

      const titleTag = chunk.match(/<title[^>]*>([^<]+)<\/title>/i);

      const ogImages = getAllMetaContent('og:image');
      data = {
        title: getMetaContent('og:title') || getMetaContent('twitter:title') || (titleTag ? titleTag[1].trim() : null),
        description: getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description'),
        image: ogImages[0] || getMetaContent('twitter:image'),
        images: ogImages.length >= 2 ? ogImages : undefined,
        siteName: getMetaContent('og:site_name') || parsed.hostname,
        url: getMetaContent('og:url') || url
      };

      // oEmbed autodiscovery — if OG tags came back empty and the page advertises a
      // JSON oEmbed endpoint, use it. This future-proofs support for any oEmbed-compatible
      // site without needing a dedicated handler.
      if (!data.title && !data.image) {
        const oembedHref =
          chunk.match(/<link[^>]*?type=["']application\/json\+oembed["'][^>]*?href=["']([^"']+)["']/i) ||
          chunk.match(/<link[^>]*?href=["']([^"']+)["'][^>]*?type=["']application\/json\+oembed["']/i);
        if (oembedHref) {
          try {
            const oembedEndpoint = new URL(oembedHref[1], currentUrl).href;
            await validateUrlSafe(oembedEndpoint);
            const oResp = await fetch(oembedEndpoint, {
              signal: AbortSignal.timeout(5000),
              headers: { 'User-Agent': PREVIEW_UA }
            });
            if (oResp.ok) {
              const oj = await oResp.json();
              data.title = data.title || oj.title || null;
              data.image = data.image || oj.thumbnail_url || null;
              if (!data.siteName || data.siteName === parsed.hostname) {
                data.siteName = oj.provider_name || data.siteName;
              }
            }
          } catch { /* autodiscovery failed — keep OG data as-is */ }
        }
      }
    } else {
      // Twitter oEmbed succeeded — try a quick scrape for the image only.
      // First try fxtwitter (bot-friendly proxy), then fall back to the original URL.
      const imageSource = /^https?:\/\/(?:(?:www\.|mobile\.)?(?:twitter|x)\.com)\/\w+\/status\/\d+/i.test(url)
        ? url.replace(/^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com/i, 'https://fxtwitter.com')
        : url;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(imageSource, {
          signal: controller.signal,
          headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'text/html' },
          redirect: 'manual'  // no blind redirect following
        });
        clearTimeout(timeout);
        // Only scrape if we got a direct 200 (no redirect chasing for image-only pass)
        if (resp.status === 200) {
          const html = (await resp.text()).slice(0, PREVIEW_MAX_SIZE);
          const imgMatch = html.match(/<meta[^>]*?(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*?content=["']([^"']+)["']/is)
                        || html.match(/<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:og:image|twitter:image)["']/is);
          if (imgMatch) data.image = decodeHtmlEntities(imgMatch[1].trim());
        }
      } catch { /* image is optional */ }
    }

    linkPreviewCache.set(url, { data, ts: Date.now() });

    // Prune old cache entries if over 500
    if (linkPreviewCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of linkPreviewCache) {
        if (now - v.ts > PREVIEW_CACHE_TTL) linkPreviewCache.delete(k);
      }
    }

    res.json(data);
  } catch {
    res.json({ title: null, description: null, image: null, siteName: null });
  }
});

// ── Games list endpoint — discover available games ──
app.get('/api/games', (req, res) => {
  const gamesDir = path.join(__dirname, 'public', 'games');
  const fs2 = require('fs');
  try {
    const entries = fs2.readdirSync(gamesDir, { withFileTypes: true });
    const games = entries
      .filter(e => e.isFile() && e.name.endsWith('.html'))
      .map(e => e.name.replace('.html', ''));
    res.json({ games });
  } catch {
    res.json({ games: [] });
  }
});

// ── High-scores REST API (mobile-safe fallback for postMessage) ──
app.get('/api/high-scores/:game', (req, res) => {
  const game = req.params.game;
  if (!/^[a-z0-9_-]{1,32}$/.test(game)) return res.status(400).json({ error: 'Invalid game id' });
  const { getDb } = require('./src/database');
  const leaderboard = getDb().prepare(`
    SELECT hs.user_id, COALESCE(u.display_name, u.username) as username, hs.score
    FROM high_scores hs JOIN users u ON hs.user_id = u.id
    WHERE hs.game = ? AND hs.score > 0
    ORDER BY hs.score DESC LIMIT 50
  `).all(game);
  res.json({ game, leaderboard });
});

app.post('/api/high-scores', express.json(), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const game = typeof req.body.game === 'string' ? req.body.game.trim() : '';
  const score = Number(req.body.score);
  if (!game || !/^[a-z0-9_-]{1,32}$/.test(game)) return res.status(400).json({ error: 'Invalid game id' });
  if (!Number.isInteger(score) || score < 0) return res.status(400).json({ error: 'Invalid score' });

  const { getDb } = require('./src/database');
  const db = getDb();
  const current = db.prepare('SELECT score FROM high_scores WHERE user_id = ? AND game = ?').get(user.id, game);
  if (!current || score > current.score) {
    db.prepare(
      "INSERT OR REPLACE INTO high_scores (user_id, game, score, updated_at) VALUES (?, ?, ?, datetime('now'))"
    ).run(user.id, game, score);
  }
  const leaderboard = db.prepare(`
    SELECT hs.user_id, COALESCE(u.display_name, u.username) as username, hs.score
    FROM high_scores hs JOIN users u ON hs.user_id = u.id
    WHERE hs.game = ? AND hs.score > 0
    ORDER BY hs.score DESC LIMIT 50
  `).all(game);
  res.json({ game, leaderboard });
});

// ═══════════════════════════════════════════════════════════
// WEBHOOK / BOT INTEGRATION — incoming message endpoint
// ═══════════════════════════════════════════════════════════
const rateLimit = require('express-rate-limit');
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Rate limit exceeded' } });
app.post('/api/webhooks/:token', webhookLimiter, express.json({ limit: '64kb' }), (req, res) => {
  const { getDb } = require('./src/database');
  const db = getDb();
  const { token } = req.params;

  if (!token || typeof token !== 'string' || token.length !== 64) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const webhook = db.prepare(
    'SELECT w.*, c.code as channel_code, c.name as channel_name FROM webhooks w JOIN channels c ON w.channel_id = c.id WHERE w.token = ? AND w.is_active = 1'
  ).get(token);

  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found or inactive' });
  }

  const content = typeof req.body.content === 'string' ? sanitizeText(req.body.content.trim()) : '';
  if (!content || content.length > 4000) {
    return res.status(400).json({ error: 'Content required (max 4000 chars)' });
  }

  // Optional overrides per-message
  const username = typeof req.body.username === 'string' ? sanitizeText(req.body.username.trim().slice(0, 32)) : webhook.name;
  let avatarUrl = webhook.avatar_url;
  if (typeof req.body.avatar_url === 'string') {
    const trimmed = req.body.avatar_url.trim().slice(0, 512);
    avatarUrl = /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }

  // Insert the message into the DB
  const result = db.prepare(
    'INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar) VALUES (?, ?, ?, 1, ?, ?)'
  ).run(webhook.channel_id, null, content, username, avatarUrl || null);

  const message = {
    id: result.lastInsertRowid,
    content,
    created_at: new Date().toISOString(),
    username: `[BOT] ${username}`,
    user_id: null,
    avatar: avatarUrl || null,
    avatar_shape: 'square',
    reply_to: null,
    replyContext: null,
    reactions: [],
    is_webhook: true,
    webhook_name: username
  };

  // Broadcast to all clients in this channel
  if (io) {
    io.to(`channel:${webhook.channel_code}`).emit('new-message', {
      channelCode: webhook.channel_code,
      message
    });
  }

  res.status(200).json({ success: true, message_id: result.lastInsertRowid });
});

// ═══════════════════════════════════════════════════════════
// DISCORD IMPORT — upload, preview, execute
// ═══════════════════════════════════════════════════════════
const os = require('os');
const { parseDiscordExport } = require('./src/importDiscord');

// Multer instance for import uploads (ZIP/JSON up to 500 MB)
const importUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `haven-import-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.json' || ext === '.zip') cb(null, true);
    else cb(new Error('Only .json and .zip files are accepted'));
  }
});

// ── Step 1: Upload & parse → return preview ──────────────
app.post('/api/import/discord/upload', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  importUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const result = parseDiscordExport(req.file.path);

      // Save parsed data to temp so the execute step can read it
      const importId = crypto.randomBytes(16).toString('hex');
      const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
      fs.writeFileSync(tempPath, JSON.stringify(result));

      // Clean up the uploaded raw file
      try { fs.unlinkSync(req.file.path); } catch {}

      // Return preview (channel list + counts — NOT the full messages)
      res.json({
        importId,
        format: result.format,
        serverName: result.serverName,
        channels: result.channels.map(c => ({
          discordId: c.discordId,
          name: c.name,
          topic: c.topic,
          category: c.category,
          messageCount: c.messageCount
        })),
        totalMessages: result.channels.reduce((sum, c) => sum + c.messageCount, 0)
      });
    } catch (parseErr) {
      try { fs.unlinkSync(req.file.path); } catch {}
      res.status(400).json({ error: parseErr.message });
    }
  });
});

// ── Discord Direct Connect — pull messages straight from Discord's API ──
const DISCORD_API = 'https://discord.com/api/v10';

async function discordApiFetch(endpoint, userToken, retries = 2) {
  const resp = await fetch(`${DISCORD_API}${endpoint}`, {
    headers: { Authorization: userToken }
  });
  if (resp.status === 401) throw new Error('Invalid or expired Discord token');
  if (resp.status === 403) throw new Error('Access denied — check token permissions');
  if (resp.status === 429 && retries > 0) {
    const wait = parseFloat(resp.headers.get('retry-after') || '3');
    await new Promise(r => setTimeout(r, wait * 1000));
    return discordApiFetch(endpoint, userToken, retries - 1);
  }
  if (!resp.ok) throw new Error(`Discord API error ${resp.status}`);
  return resp.json();
}

// Step A: validate token → list servers
app.post('/api/import/discord/connect', express.json(), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  const { discordToken } = req.body;
  if (!discordToken || typeof discordToken !== 'string') {
    return res.status(400).json({ error: 'Discord token required' });
  }

  try {
    const me = await discordApiFetch('/users/@me', discordToken);
    const guilds = await discordApiFetch('/users/@me/guilds?limit=200', discordToken);
    res.json({
      user: { username: me.global_name || me.username },
      guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon }))
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Step B: list text channels, announcement channels, forums, and threads for a guild
app.post('/api/import/discord/guild-channels', express.json(), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  const { discordToken, guildId } = req.body;
  if (!discordToken || !guildId) return res.status(400).json({ error: 'Missing params' });

  try {
    const allChannels = await discordApiFetch(`/guilds/${guildId}/channels`, discordToken);

    // Build category map
    const categories = {};
    allChannels.filter(c => c.type === 4).forEach(c => { categories[c.id] = c.name; });

    // Text (0), Announcement (5), Forum (15), Media (16) — all contain readable content
    const textTypes = new Set([0, 5, 15, 16]);
    const channelsList = allChannels
      .filter(c => textTypes.has(c.type))
      .sort((a, b) => a.position - b.position)
      .map(c => ({
        id: c.id,
        name: c.name,
        topic: c.topic || '',
        category: (c.parent_id && categories[c.parent_id]) || null,
        type: c.type === 5 ? 'announcement' : c.type === 15 ? 'forum' : c.type === 16 ? 'media' : 'text',
        // Forum tags (available on type 15 and 16)
        tags: Array.isArray(c.available_tags) ? c.available_tags.map(t => ({ id: t.id, name: t.name })) : []
      }));

    // Fetch threads (active + archived public)
    const threads = [];

    // Active threads
    try {
      const active = await discordApiFetch(`/guilds/${guildId}/threads/active`, discordToken);
      if (active.threads) threads.push(...active.threads);
    } catch {}

    // Archived threads per text/forum/announcement channel (up to 100 per channel)
    for (const ch of channelsList) {
      try {
        const archived = await discordApiFetch(`/channels/${ch.id}/threads/archived/public?limit=100`, discordToken);
        if (archived.threads) threads.push(...archived.threads);
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }

    // De-duplicate threads and map to entries
    const seen = new Set();
    const threadEntries = [];
    for (const t of threads) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      // Find parent channel
      const parent = channelsList.find(c => c.id === t.parent_id);
      const parentName = parent ? parent.name : null;

      // Resolve applied forum tags
      let tagNames = [];
      if (Array.isArray(t.applied_tags) && parent && parent.tags.length) {
        tagNames = t.applied_tags
          .map(tid => parent.tags.find(tag => tag.id === tid))
          .filter(Boolean)
          .map(tag => tag.name);
      }

      threadEntries.push({
        id: t.id,
        name: t.name,
        topic: '',
        category: (parent && parent.category) || null,
        type: 'thread',
        parentId: t.parent_id,
        parentName,
        tags: tagNames
      });
    }

    res.json({ channels: channelsList, threads: threadEntries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Step C: fetch all messages from selected channels → save temp → return preview
app.post('/api/import/discord/fetch', express.json(), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  const { discordToken, guildName, channels: selected } = req.body;
  if (!discordToken || !Array.isArray(selected) || !selected.length) {
    return res.status(400).json({ error: 'Missing params' });
  }

  try {
    const result = {
      format: 'Discord Direct',
      serverName: guildName || 'Discord Import',
      channels: []
    };

    for (const ch of selected) {
      const messages = [];
      let before = null, batch;

      do {
        let ep = `/channels/${ch.id}/messages?limit=100`;
        if (before) ep += `&before=${before}`;
        batch = await discordApiFetch(ep, discordToken);

        for (const msg of batch) {
          if (msg.type !== 0 && msg.type !== 19) continue; // Default + Reply only
          let content = msg.content || '';
          if (Array.isArray(msg.attachments)) {
            for (const a of msg.attachments) {
              content += `\n📎 ${a.url ? '[' + a.filename + '](' + a.url + ')' : a.filename}`;
            }
          }
          if (Array.isArray(msg.embeds)) {
            for (const e of msg.embeds) {
              if (e.title) content += `\n🔗 **${e.title}**`;
              if (e.description) content += `\n${e.description}`;
              if (e.url && !content.includes(e.url)) content += `\n${e.url}`;
            }
          }
          content = content.trim();
          if (!content) continue;

          messages.push({
            discordId: msg.id,
            author: msg.author?.global_name || msg.author?.username || 'Unknown',
            authorId: msg.author?.id || null,
            authorAvatar: msg.author?.avatar
              ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=64`
              : null,
            isBot: msg.author?.bot || false,
            content,
            timestamp: msg.timestamp,
            isPinned: msg.pinned || false,
            reactions: (msg.reactions || []).map(r => ({
              emoji: r.emoji?.name || '❓',
              count: r.count || 1
            })),
            replyTo: msg.message_reference?.message_id || null
          });
        }

        if (batch.length > 0) before = batch[batch.length - 1].id;
        await new Promise(r => setTimeout(r, 300)); // respect rate limits
      } while (batch.length === 100);

      result.channels.push({
        discordId: ch.id,
        name: ch.name,
        topic: ch.topic || '',
        category: ch.category || null,
        messageCount: messages.length,
        messages
      });
    }

    const importId = crypto.randomBytes(16).toString('hex');
    const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(result));

    res.json({
      importId,
      format: result.format,
      serverName: result.serverName,
      channels: result.channels.map(c => ({
        discordId: c.discordId,
        name: c.name,
        topic: c.topic,
        category: c.category,
        messageCount: c.messageCount
      })),
      totalMessages: result.channels.reduce((sum, c) => sum + c.messageCount, 0)
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Periodic cleanup of orphaned import temp files (1 hour TTL) ──
function cleanupTempImports() {
  try {
    const tmpDir = os.tmpdir();
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const f of fs.readdirSync(tmpDir)) {
      if (!f.startsWith('haven-import-')) continue;
      const fp = path.join(tmpDir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
// Run once at startup to clean up any stale files from previous crashes
cleanupTempImports();
setInterval(cleanupTempImports, 15 * 60 * 1000); // then every 15 min

// ── Step 2: Execute the import ───────────────────────────
app.post('/api/import/discord/execute', express.json({ limit: '1mb' }), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  const { importId, selectedChannels } = req.body;
  if (!importId || !Array.isArray(selectedChannels) || selectedChannels.length === 0) {
    return res.status(400).json({ error: 'Missing importId or selectedChannels' });
  }

  // Validate importId is hex-only (prevent path traversal)
  if (!/^[a-f0-9]{32}$/.test(importId)) {
    return res.status(400).json({ error: 'Invalid import ID' });
  }

  const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
  if (!fs.existsSync(tempPath)) {
    return res.status(404).json({ error: 'Import data expired or not found. Please re-upload.' });
  }

  try {
    const data = JSON.parse(fs.readFileSync(tempPath, 'utf-8'));
    const { getDb } = require('./src/database');
    const db = getDb();
    const { generateChannelCode } = require('./src/auth');

    const stats = { channelsCreated: 0, messagesImported: 0 };

    const txn = db.transaction(() => {
      for (const sel of selectedChannels) {
        // Find channel data by discordId or original name
        const channelData = data.channels.find(c =>
          (sel.discordId && c.discordId === sel.discordId) ||
          c.name === sel.originalName
        );
        if (!channelData || !channelData.messages) continue;

        const channelName = [...(sel.name || channelData.name)].slice(0, 50).join('');
        const code = generateChannelCode();

        // Create the Haven channel
        const chResult = db.prepare(
          'INSERT INTO channels (name, code, created_by, topic) VALUES (?, ?, ?, ?)'
        ).run(channelName, code, user.id, channelData.topic || '');
        const channelId = chResult.lastInsertRowid;

        // Auto-join the importing admin
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, user.id);
        stats.channelsCreated++;

        // Sort messages chronologically
        const sorted = channelData.messages.slice().sort(
          (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );

        // Discord message ID → Haven message ID (for reply threading)
        const idMap = {};

        const insertMsg = db.prepare(`
          INSERT INTO messages (channel_id, user_id, content, created_at, webhook_username, webhook_avatar, is_webhook, imported_from, reply_to)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'discord', ?)
        `);

        for (const msg of sorted) {
          const content = (msg.content || '').trim();
          if (!content) continue;

          // Resolve reply to an already-imported Haven message
          let replyTo = null;
          if (msg.replyTo && idMap[msg.replyTo]) {
            replyTo = idMap[msg.replyTo];
          }

          // Normalize timestamp to SQLite-friendly format
          let ts;
          try {
            ts = new Date(msg.timestamp).toISOString().replace('T', ' ').replace('Z', '');
          } catch {
            ts = msg.timestamp;
          }

          const result = insertMsg.run(
            channelId, user.id, content, ts, msg.author || 'Unknown', msg.authorAvatar || null, replyTo
          );

          if (msg.discordId) {
            idMap[msg.discordId] = result.lastInsertRowid;
          }
          stats.messagesImported++;

          // Pin if flagged
          if (msg.isPinned) {
            try {
              db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)')
                .run(result.lastInsertRowid, channelId, user.id);
            } catch {}
          }

          // Import reactions
          if (Array.isArray(msg.reactions)) {
            for (const r of msg.reactions) {
              if (!r.emoji) continue;
              try {
                db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)')
                  .run(result.lastInsertRowid, user.id, r.emoji);
              } catch {}
            }
          }
        }
      }
    });

    txn();

    // Clean up temp file
    try { fs.unlinkSync(tempPath); } catch {}

    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('Import execute error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── Catch-all: 404 ──────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler (never leak stack traces) ──────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP or HTTPS server
let server;

// Resolve SSL paths: if set in .env resolve relative to DATA_DIR, otherwise auto-detect
let sslCert = process.env.SSL_CERT_PATH;
let sslKey  = process.env.SSL_KEY_PATH;

// If not explicitly configured, check if the startup scripts generated certs
if (!sslCert && !sslKey) {
  const autoCert = path.join(CERTS_DIR, 'cert.pem');
  const autoKey  = path.join(CERTS_DIR, 'key.pem');
  if (fs.existsSync(autoCert) && fs.existsSync(autoKey)) {
    sslCert = autoCert;
    sslKey  = autoKey;
  }
} else {
  // Resolve relative paths against the data directory
  if (sslCert && !path.isAbsolute(sslCert)) sslCert = path.resolve(DATA_DIR, sslCert);
  if (sslKey  && !path.isAbsolute(sslKey))  sslKey  = path.resolve(DATA_DIR, sslKey);
}

const forceHttp = (process.env.FORCE_HTTP || '').toLowerCase() === 'true';
const useSSL = sslCert && sslKey && !forceHttp;

if (forceHttp) {
  console.log('⚡ FORCE_HTTP=true — running plain HTTP (reverse proxy mode)');
}

if (useSSL) {
  try {
    const sslOptions = {
      cert: fs.readFileSync(sslCert),
      key: fs.readFileSync(sslKey)
    };
    server = createHttpsServer(sslOptions, app);
    console.log('🔒 HTTPS enabled');

    // Also start an HTTP server that redirects to HTTPS (hardened)
    const httpRedirect = express();
    httpRedirect.disable('x-powered-by');
    // Rate limit redirect server to prevent abuse
    const redirectHits = new Map();
    httpRedirect.use((req, res, next) => {
      const ip = req.ip || req.socket.remoteAddress;
      const now = Date.now();
      if (!redirectHits.has(ip)) redirectHits.set(ip, []);
      const stamps = redirectHits.get(ip).filter(t => now - t < 60000);
      redirectHits.set(ip, stamps);
      if (stamps.length > 60) return res.status(429).end('Rate limited');
      stamps.push(now);
      next();
    });
    setInterval(() => { const now = Date.now(); for (const [ip, t] of redirectHits) { const f = t.filter(x => now - x < 60000); if (!f.length) redirectHits.delete(ip); else redirectHits.set(ip, f); } }, 5 * 60 * 1000);
    // Only redirect to our own host — prevent open redirect
    const safePort = parseInt(process.env.PORT || 3000);
    httpRedirect.all('*', (req, res) => {
      // Sanitize: only allow path portion, strip host manipulation
      const safePath = (req.url || '/').replace(/[\r\n]/g, '');
      const host = (req.headers.host || `localhost:${safePort}`).replace(/:\d+$/, '') + ':' + safePort;
      res.redirect(301, `https://${host}${safePath}`);
    });
    const HTTP_REDIRECT_PORT = safePort + 1; // 3001
    const httpRedirectServer = createServer(httpRedirect);
    // Timeout to prevent Slowloris on redirect server
    httpRedirectServer.headersTimeout = 5000;
    httpRedirectServer.requestTimeout = 5000;
    httpRedirectServer.listen(HTTP_REDIRECT_PORT, process.env.HOST || '0.0.0.0', () => {
      console.log(`↪️  HTTP redirect running on port ${HTTP_REDIRECT_PORT} → HTTPS`);
    });
  } catch (err) {
    console.error('Failed to load SSL certs, falling back to HTTP:', err.message);
    server = createServer(app);
  }
} else {
  server = createServer(app);
  console.log('⚠️  Running HTTP — voice chat requires HTTPS for remote connections');
}

// Socket.IO — locked down
const io = new Server(server, {
  cors: {
    origin: false,         // same-origin only — no cross-site connections
  },
  maxHttpBufferSize: 64 * 1024,  // 64KB max per message (was 1MB)
  pingTimeout: 30000,
  pingInterval: 25000,
  connectTimeout: 10000,
});

// Initialize
const db = initDatabase();
initFcm(DATA_DIR);
app.set('io', io);   // expose to auth routes (session invalidation on password change)
setupSocketHandlers(io, db);
registerProcessCleanup();

// ── Auto-cleanup interval (runs every 15 minutes) ───────
function runAutoCleanup() {
  try {
    const getSetting = (key) => {
      const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
      return row ? row.value : null;
    };

    const enabled = getSetting('cleanup_enabled');
    if (enabled !== 'true') return;

    const maxAgeDays = parseInt(getSetting('cleanup_max_age_days') || '0');
    const maxSizeMb = parseInt(getSetting('cleanup_max_size_mb') || '0');
    let totalDeleted = 0;

    // 1. Delete messages older than N days (skip archived/protected messages and exempt channels)
    if (maxAgeDays > 0) {
      // Delete reactions for old messages first
      db.prepare(`
        DELETE FROM reactions WHERE message_id IN (
          SELECT id FROM messages WHERE created_at < datetime('now', ?) AND is_archived = 0
          AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)
        )
      `).run(`-${maxAgeDays} days`);
      const result = db.prepare(
        "DELETE FROM messages WHERE created_at < datetime('now', ?) AND is_archived = 0 AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)"
      ).run(`-${maxAgeDays} days`);
      totalDeleted += result.changes;
    }

    // 2. If total DB size exceeds maxSizeMb, trim oldest messages (skip archived)
    if (maxSizeMb > 0) {
      const dbPath = DB_PATH;
      const stats = require('fs').statSync(dbPath);
      const sizeMb = stats.size / (1024 * 1024);
      if (sizeMb > maxSizeMb) {
        // Delete oldest 10% of non-archived messages to bring size down
        const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE is_archived = 0 AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)').get().cnt;
        const deleteCount = Math.max(Math.floor(totalCount * 0.1), 100);
        const oldestIds = db.prepare(
          'SELECT id FROM messages WHERE is_archived = 0 AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1) ORDER BY created_at ASC LIMIT ?'
        ).all(deleteCount).map(r => r.id);
        if (oldestIds.length > 0) {
          // Chunk deletes to avoid creating extremely long SQL statements
          const CHUNK_SIZE = 1000;
          for (let i = 0; i < oldestIds.length; i += CHUNK_SIZE) {
            const chunk = oldestIds.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            db.prepare(`DELETE FROM reactions WHERE message_id IN (${placeholders})`).run(...chunk);
            db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...chunk);
          }
          totalDeleted += oldestIds.length;
        }
      }
    }

    // Also clean up old uploaded files if age cleanup is set
    if (maxAgeDays > 0) {
      const uploadsDir = UPLOADS_DIR;
      if (require('fs').existsSync(uploadsDir)) {
        // Build a set of protected filenames (server icon, avatars, emojis, sounds)
        const protectedFiles = new Set();
        const iconRow = db.prepare("SELECT value FROM server_settings WHERE key = 'server_icon'").get();
        if (iconRow?.value) protectedFiles.add(path.basename(iconRow.value));
        db.prepare("SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar != ''").all()
          .forEach(r => protectedFiles.add(path.basename(r.avatar)));
        try {
          db.prepare("SELECT filename FROM custom_emojis").all()
            .forEach(r => protectedFiles.add(path.basename(r.filename)));
        } catch { /* table may not exist */ }
        try {
          db.prepare("SELECT filename FROM custom_sounds").all()
            .forEach(r => protectedFiles.add(path.basename(r.filename)));
        } catch { /* table may not exist */ }
        // Webhook/bot avatars
        try {
          db.prepare("SELECT avatar_url FROM webhooks WHERE avatar_url IS NOT NULL AND avatar_url != ''").all()
            .forEach(r => protectedFiles.add(path.basename(r.avatar_url)));
        } catch { /* table may not exist */ }
        try {
          db.prepare("SELECT avatar_url FROM proxies WHERE avatar_url IS NOT NULL AND avatar_url != ''").all()
            .forEach(r => protectedFiles.add(path.basename(r.avatar_url)));
        } catch { /* table may not exist */ }

        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        const files = require('fs').readdirSync(uploadsDir);
        let filesDeleted = 0;
        files.forEach(f => {
          if (protectedFiles.has(f)) return; // never delete critical files
          try {
            const fpath = require('path').join(uploadsDir, f);
            const stat = require('fs').statSync(fpath);
            if (stat.mtimeMs < cutoff) {
              require('fs').unlinkSync(fpath);
              filesDeleted++;
            }
          } catch { /* skip */ }
        });
        if (filesDeleted > 0) {
          console.log(`🗑️  Auto-cleanup: removed ${filesDeleted} old uploaded files`);
        }

        // Clean up deleted-attachments folder (files moved here when messages were deleted)
        const deletedDir = path.join(UPLOADS_DIR, 'deleted-attachments');
        if (require('fs').existsSync(deletedDir)) {
          let daDeleted = 0;
          for (const f of require('fs').readdirSync(deletedDir)) {
            try {
              const fp = require('path').join(deletedDir, f);
              if (require('fs').statSync(fp).mtimeMs < cutoff) {
                require('fs').unlinkSync(fp);
                daDeleted++;
              }
            } catch { /* skip */ }
          }
          if (daDeleted > 0) {
            console.log(`🗑️  Auto-cleanup: removed ${daDeleted} files from deleted-attachments`);
          }
        }
      }
    }

    if (totalDeleted > 0) {
      console.log(`🗑️  Auto-cleanup: deleted ${totalDeleted} old messages`);
    }
  } catch (err) {
    console.error('Auto-cleanup error:', err);
  }
}

// Run cleanup every 15 minutes
setInterval(runAutoCleanup, 15 * 60 * 1000);
// Also run once at startup (delayed 30s to let DB settle)
setTimeout(runAutoCleanup, 30000);
// Expose globally so socketHandlers can trigger it
global.runAutoCleanup = runAutoCleanup;

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const protocol = useSSL ? 'https' : 'http';

// ── Global crash prevention ──────────────────────────────
// Prevent the entire server from dying due to an uncaught exception
// in a socket handler or background task.  Log the error so it
// can be debugged, but keep the process alive.
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection (server kept alive):', reason);
});

// ── Memory watchdog ──────────────────────────────────────
// Periodically log memory usage and nudge GC when heap is getting large.
// This helps prevent the Oilpan "large allocation" OOM in Haven Desktop
// where the server runs alongside Electron.
const MEM_WARN_MB = 350;  // warn threshold
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB  = Math.round(mem.heapUsed / 1048576);
  const rssMB   = Math.round(mem.rss / 1048576);
  const extMB   = Math.round((mem.external || 0) / 1048576);

  // Log if above warning threshold
  if (rssMB > MEM_WARN_MB) {
    console.warn(`⚠️  Memory high — RSS: ${rssMB} MB, Heap: ${heapMB} MB, External: ${extMB} MB`);
    // Nudge GC if --expose-gc was passed
    if (global.gc) {
      global.gc();
      console.warn('   GC nudged');
    }
  }
}, 30000);  // every 30 seconds

// ── Anti-Slowloris: server-level timeouts ────────────────
server.headersTimeout = 15000;     // 15s to send all headers
server.requestTimeout = 30000;     // 30s total request time
server.keepAliveTimeout = 65000;   // slightly above typical ALB/LB timeout
server.timeout = 120000;           // 2 min absolute socket timeout

server.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       🏠  HAVEN is running               ║
╠══════════════════════════════════════════╣
║  Name:    ${(process.env.SERVER_NAME || 'Haven').padEnd(29)}║
║  Local:   ${protocol}://localhost:${PORT}             ║
║  Network: ${protocol}://YOUR_IP:${PORT}              ║
║  Admin:   ${(process.env.ADMIN_USERNAME || 'admin').padEnd(29)}║
╚══════════════════════════════════════════╝
  `);
  // Tunnel is now started manually via the admin panel button (no auto-start)
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  io.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
