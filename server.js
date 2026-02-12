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
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // inline styles needed for themes
      imgSrc: ["'self'", "data:", "blob:", "https://media.tenor.com", "https:"],  // https: for link preview OG images
      connectSrc: ["'self'", "wss:", "ws:"],    // Socket.IO websockets
      mediaSrc: ["'self'", "blob:"],            // WebRTC audio
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],               // prevent clickjacking
    }
  },
  crossOriginEmbedderPolicy: false,  // needed for WebRTC
  crossOriginOpenerPolicy: false,    // needed for WebRTC
}));

// Disable Express version disclosure
app.disable('x-powered-by');

// ── Body Parsing with size limits ────────────────────────
app.use(express.json({ limit: '16kb' }));  // no reason for large JSON bodies
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// ── Static files with caching ────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',       // block .env, .git, etc.
  maxAge: '1h',           // browser caching
}));

// ── Serve uploads from external data directory ──────────
app.use('/uploads', express.static(UPLOADS_DIR, {
  dotfiles: 'deny',
  maxAge: '1h',
}));

// ── File uploads (images, max 5 MB) ─────────────────────
const uploadDir = UPLOADS_DIR;

const uploadStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed (jpg, png, gif, webp)'));
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
    name: process.env.SERVER_NAME || 'Haven',
    version: require('./package.json').version
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

// ── GIF search proxy (Tenor API — keeps key server-side) ──
function getTenorKey() {
  // Check database first (set via admin panel), fall back to .env
  try {
    const { getDb } = require('./src/database');
    const row = getDb().prepare("SELECT value FROM server_settings WHERE key = 'tenor_api_key'").get();
    if (row && row.value) return row.value;
  } catch { /* DB not ready yet or no key stored */ }
  return process.env.TENOR_API_KEY || '';
}

app.get('/api/gif/search', (req, res) => {
  const key = getTenorKey();
  if (!key) return res.status(501).json({ error: 'gif_not_configured' });
  const q = (req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${key}&client_key=haven&limit=${limit}&media_filter=tinygif,gif`;
  fetch(url).then(r => r.json()).then(data => {
    const results = (data.results || []).map(r => ({
      id: r.id,
      title: r.title || '',
      tiny: r.media_formats?.tinygif?.url || '',
      full: r.media_formats?.gif?.url || '',
    }));
    res.json({ results });
  }).catch(() => res.status(502).json({ error: 'Tenor API error' }));
});

app.get('/api/gif/trending', (req, res) => {
  const key = getTenorKey();
  if (!key) return res.status(501).json({ error: 'gif_not_configured' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const url = `https://tenor.googleapis.com/v2/featured?key=${key}&client_key=haven&limit=${limit}&media_filter=tinygif,gif`;
  fetch(url).then(r => r.json()).then(data => {
    const results = (data.results || []).map(r => ({
      id: r.id,
      title: r.title || '',
      tiny: r.media_formats?.tinygif?.url || '',
      full: r.media_formats?.gif?.url || '',
    }));
    res.json({ results });
  }).catch(() => res.status(502).json({ error: 'Tenor API error' }));
});

// ── Link preview (Open Graph metadata) ──────────────────
const linkPreviewCache = new Map(); // url → { data, ts }
const PREVIEW_CACHE_TTL = 30 * 60 * 1000; // 30 min
const PREVIEW_MAX_SIZE = 256 * 1024; // only read first 256 KB of page

app.get('/api/link-preview', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Only allow http(s) URLs
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs allowed' });
    }
    // Block private/internal IPs (SSRF protection)
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

    // Also start an HTTP server that redirects to HTTPS
    const httpRedirect = express();
    httpRedirect.all('*', (req, res) => {
      res.redirect(`https://${req.hostname}:${process.env.PORT || 3000}${req.url}`);
    });
    const HTTP_REDIRECT_PORT = parseInt(process.env.PORT || 3000) + 1; // 3001
    createServer(httpRedirect).listen(HTTP_REDIRECT_PORT, process.env.HOST || '0.0.0.0', () => {
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
