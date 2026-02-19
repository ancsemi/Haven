// ── Resolve data directory BEFORE loading .env ────────────
const { DATA_DIR, DB_PATH, ENV_PATH, CERTS_DIR, UPLOADS_DIR } = require('./src/paths');

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
const { setupSocketHandlers } = require('./src/socketHandlers');
const { startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup } = require('./src/tunnel');

const app = express();

// ── Security Headers (helmet) ────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", "https://www.youtube.com", "https://w.soundcloud.com", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // inline styles needed for themes
      imgSrc: ["'self'", "data:", "blob:", "https:"],  // https: for link preview OG images + GIPHY
      connectSrc: ["'self'", "ws:", "wss:", "https:"],  // Socket.IO + cross-origin health checks
      mediaSrc: ["'self'", "blob:", "data:"],  // WebRTC audio + notification sounds
      fontSrc: ["'self'"],
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
  hsts: { maxAge: 31536000, includeSubDomains: false }, // force HTTPS for 1 year
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

// ── Serve uploads from external data directory ──────────
app.use('/uploads', express.static(UPLOADS_DIR, {
  dotfiles: 'deny',
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // Force download for non-image files (prevents HTML/SVG execution in browser)
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

// ── File uploads (images max 5 MB, general files max 25 MB) ──
const uploadDir = UPLOADS_DIR;

const uploadStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

// Image-only upload (existing endpoint)
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed (jpg, png, gif, webp)'));
  }
});

// General file upload (expanded MIME whitelist)
const ALLOWED_FILE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown',
  'application/zip', 'application/x-zip-compressed',
  'application/x-7z-compressed', 'application/x-rar-compressed',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/webm',
  'application/json',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const fileUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // hard cap 2 GB; DB-configurable limit enforced per-request
  fileFilter: (req, file, cb) => {
    if (ALLOWED_FILE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

// ── API routes (rate-limited) ────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);

// ── Push notification VAPID public key endpoint ──────────
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
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
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  res.json(getTunnelStatus());
});

app.post('/api/tunnel/sync', express.json(), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });
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
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/games/flappy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'games', 'flappy.html'));
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

// ── Port reachability check (Admin only) ─────────────────
// Uses external services to test if this server is reachable from the internet.
// Returns { reachable: bool, publicIp: string|null, error: string|null }
app.get('/api/port-check', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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

  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

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
    const originalName = req.file.originalname || 'file';
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

// ── Sound upload (admin only, wav/mp3/ogg, max 1 MB) ────
const soundUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^audio\/(mpeg|ogg|wav|webm)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only audio files allowed (mp3, ogg, wav, webm)'));
  }
});

app.post('/api/upload-sound', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });

  soundUpload.single('sound')(req, res, (err) => {
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
    const sounds = getDb().prepare('SELECT name, filename FROM custom_sounds ORDER BY name').all();
    res.json({ sounds: sounds.map(s => ({ name: s.name, url: `/uploads/${s.filename}` })) });
  } catch { res.json({ sounds: [] }); }
});

app.delete('/api/sounds/:name', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });
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

// ── Custom emoji upload (admin only, image, max 256 KB) ──
const emojiUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 256 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|gif|webp|jpeg)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed (png, gif, webp, jpg)'));
  }
});

app.post('/api/upload-emoji', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });

  emojiUpload.single('emoji')(req, res, (err) => {
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
  if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });
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
  if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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

app.get('/api/link-preview', previewLimiter, async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Only allow http(s) URLs
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs allowed' });
    }
    // Block private/internal hostnames (SSRF protection — layer 1: hostname check)
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
        host === '::1' || host === '[::1]' ||
        host.startsWith('10.') || host.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host === '169.254.169.254' ||
        host.endsWith('.local') || host.endsWith('.internal')) {
      return res.status(400).json({ error: 'Private addresses not allowed' });
    }
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  // SSRF protection — layer 2: DNS resolution check (defeats DNS rebinding)
  try {
    const addresses = await dnsResolve(parsed.hostname);
    if (addresses.some(isPrivateIP)) {
      return res.status(400).json({ error: 'Private addresses not allowed' });
    }
  } catch {
    // DNS resolution failed — could be IPv6-only or non-existent; allow fetch to fail naturally
  }

  // Cache check
  const cached = linkPreviewCache.get(url);
  if (cached && Date.now() - cached.ts < PREVIEW_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HavenBot/1.0 (link preview)',
        'Accept': 'text/html'
      },
      redirect: 'follow',
      size: PREVIEW_MAX_SIZE
    });
    clearTimeout(timeout);

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return res.json({ title: null, description: null, image: null, siteName: null });
    }

    const html = await resp.text();
    // Truncate to max size for safety
    const chunk = html.slice(0, PREVIEW_MAX_SIZE);

    const getMetaContent = (property) => {
      const ogRe = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
      const ogRe2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
      const m = chunk.match(ogRe) || chunk.match(ogRe2);
      return m ? m[1].trim() : null;
    };

    const titleTag = chunk.match(/<title[^>]*>([^<]+)<\/title>/i);

    const data = {
      title: getMetaContent('og:title') || getMetaContent('twitter:title') || (titleTag ? titleTag[1].trim() : null),
      description: getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description'),
      image: getMetaContent('og:image') || getMetaContent('twitter:image'),
      siteName: getMetaContent('og:site_name') || new URL(url).hostname,
      url: getMetaContent('og:url') || url
    };

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
app.post('/api/webhooks/:token', express.json({ limit: '64kb' }), (req, res) => {
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

  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > 4000) {
    return res.status(400).json({ error: 'Content required (max 4000 chars)' });
  }

  // Optional overrides per-message
  const username = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 32) : webhook.name;
  const avatarUrl = typeof req.body.avatar_url === 'string' ? req.body.avatar_url.trim().slice(0, 512) : webhook.avatar_url;

  // Insert the message into the DB
  const result = db.prepare(
    'INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username) VALUES (?, ?, ?, 1, ?)'
  ).run(webhook.channel_id, null, content, username);

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
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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
setInterval(() => {
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
}, 15 * 60 * 1000); // check every 15 min

// ── Step 2: Execute the import ───────────────────────────
app.post('/api/import/discord/execute', express.json({ limit: '1mb' }), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin only' });

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

const useSSL = sslCert && sslKey;

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
  pingTimeout: 20000,
  pingInterval: 25000,
  connectTimeout: 10000,
  // Limit simultaneous connections per IP
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});

// Initialize
const db = initDatabase();
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

    // 1. Delete messages older than N days
    if (maxAgeDays > 0) {
      // Delete reactions for old messages first
      db.prepare(`
        DELETE FROM reactions WHERE message_id IN (
          SELECT id FROM messages WHERE created_at < datetime('now', ?)
        )
      `).run(`-${maxAgeDays} days`);
      const result = db.prepare(
        "DELETE FROM messages WHERE created_at < datetime('now', ?)"
      ).run(`-${maxAgeDays} days`);
      totalDeleted += result.changes;
    }

    // 2. If total DB size exceeds maxSizeMb, trim oldest messages
    if (maxSizeMb > 0) {
      const dbPath = DB_PATH;
      const stats = require('fs').statSync(dbPath);
      const sizeMb = stats.size / (1024 * 1024);
      if (sizeMb > maxSizeMb) {
        // Delete oldest 10% of messages to bring size down
        const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM messages').get().cnt;
        const deleteCount = Math.max(Math.floor(totalCount * 0.1), 100);
        const oldestIds = db.prepare(
          'SELECT id FROM messages ORDER BY created_at ASC LIMIT ?'
        ).all(deleteCount).map(r => r.id);
        if (oldestIds.length > 0) {
          const placeholders = oldestIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM reactions WHERE message_id IN (${placeholders})`).run(...oldestIds);
          const result = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...oldestIds);
          totalDeleted += result.changes;
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
          db.prepare("SELECT url FROM custom_emojis").all()
            .forEach(r => protectedFiles.add(path.basename(r.url)));
        } catch { /* table may not exist */ }
        try {
          db.prepare("SELECT url FROM custom_sounds").all()
            .forEach(r => protectedFiles.add(path.basename(r.url)));
        } catch { /* table may not exist */ }
        // Webhook/bot avatars
        try {
          db.prepare("SELECT avatar_url FROM webhooks WHERE avatar_url IS NOT NULL AND avatar_url != ''").all()
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
