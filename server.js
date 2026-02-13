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

const { initDatabase } = require('./src/database');
const { router: authRoutes, authLimiter, verifyToken } = require('./src/auth');
const { setupSocketHandlers } = require('./src/socketHandlers');

const app = express();

// ── Security Headers (helmet) ────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.youtube.com", "https://w.soundcloud.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // inline styles needed for themes
      imgSrc: ["'self'", "data:", "blob:", "https:"],  // https: for link preview OG images + GIPHY
      connectSrc: ["'self'", "ws:", "wss:"],            // Socket.IO (ws for HTTP, wss for HTTPS)
      mediaSrc: ["'self'", "blob:", "data:"],  // WebRTC audio + notification sounds
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["https://open.spotify.com", "https://www.youtube.com", "https://w.soundcloud.com"],  // Listen Together embeds
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],               // prevent clickjacking
    }
  },
  crossOriginEmbedderPolicy: false,  // needed for WebRTC
  crossOriginOpenerPolicy: false,    // needed for WebRTC
  hsts: { maxAge: 31536000, includeSubDomains: false }, // force HTTPS for 1 year
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Additional security headers helmet doesn't cover
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
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
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_FILE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

// ── API routes (rate-limited) ────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);

// ── Serve pages ──────────────────────────────────────────
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
  res.json({
    status: 'online',
    name: process.env.SERVER_NAME || 'Haven'
    // version intentionally omitted — don't fingerprint the server for attackers
  });
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

// ── Avatar upload (authenticated, image only, max 2 MB) ──
app.post('/api/upload-avatar', uploadLimiter, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size > 2 * 1024 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Avatar must be under 2 MB' });
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

    const avatarUrl = `/uploads/${req.file.filename}`;
    const { getDb } = require('./src/database');
    getDb().prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, user.id);
    res.json({ url: avatarUrl });
  });
});

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

    let name = (req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
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

// ── High-scores REST API (mobile-safe fallback for postMessage) ──
app.get('/api/high-scores/:game', (req, res) => {
  const game = req.params.game;
  if (!['flappy'].includes(game)) return res.status(400).json({ error: 'Unknown game' });
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
  if (!game || !['flappy'].includes(game)) return res.status(400).json({ error: 'Unknown game' });
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
      res.redirect(301, `https://localhost:${safePort}${safePath}`);
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
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        const files = require('fs').readdirSync(uploadsDir);
        let filesDeleted = 0;
        files.forEach(f => {
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
});
