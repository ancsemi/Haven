(async () => {
// ── Resolve data directory BEFORE loading .env ────────────
const { DATA_DIR, DB_PATH, ENV_PATH, CERTS_DIR, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR, GAMES_ROMS_DIR } = require('./src/paths');
const { purgeDeletedAttachments, resolveDeletedRetentionDays } = require('./src/deletedAttachments');
const { trimUploadsToLimit } = require('./src/uploadsTrim');

// ── Node.js version guard ─────────────────────────────────
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 22 || nodeMajor > 26) {
  console.error(`\n  Haven requires Node.js 22-26. You have v${process.versions.node}.`);
  console.error('  If you installed Node.js from nodejs.org, make sure you picked the');
  console.error('  LTS version (v22.x), not an older or unsupported version.');
  console.error('  LTS download: https://nodejs.org/en/download (choose "LTS")\n');
  process.exit(1);
}

// Bootstrap .env into the data directory if it doesn't exist yet
const fs = require('fs');
const path = require('path');

// ── Stale-install guard ───────────────────────────────────
// Updating by unzipping/copying a release over an existing install leaves
// behind files that newer versions deleted. That is normally harmless, until
// the deleted file is a module that was split into a folder of the same name
// (src/socketHandlers.js became src/socketHandlers/ in 2.9.8): require()
// resolves the leftover FILE before the directory, so the server silently
// runs months-old module code no matter how current every other file is, and
// eventually dies somewhere unrelated. A real self-host crashed on boot with
// "Cannot read properties of undefined (reading 'activity')" because a
// pre-2.9.8 socketHandlers.js was still shadowing the folder, after months
// of its socket layer being frozen at the old version while "fully updated".
// Catch the pattern generically and say exactly which file to delete.
{
  const srcDir = path.join(__dirname, 'src');
  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { /* no src folder: the require() calls below fail loudly on their own */ }
  const dirNames = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
  const stale = entries.filter(e =>
    e.isFile() && e.name.endsWith('.js') && dirNames.has(e.name.slice(0, -3)) &&
    fs.existsSync(path.join(srcDir, e.name.slice(0, -3), 'index.js'))
  ).map(e => path.join('src', e.name));
  if (stale.length > 0) {
    console.error('\n❌ Stale file(s) from an older Haven install detected:\n');
    for (const f of stale) console.error(`     ${f}`);
    console.error('\n  Each file above is left over from an old version and hides the');
    console.error('  module folder of the same name, so this server would run with');
    console.error('  outdated code and fail in confusing ways.');
    console.error('  Fix: delete the file(s) listed above (the folders contain the');
    console.error('  current code), or update by replacing the whole Haven folder');
    console.error('  instead of copying new files over an old install. Your data is');
    console.error(`  safe: it lives in ${DATA_DIR}, not in the install folder.\n`);
    process.exit(1);
  }
}
// .env holds JWT_SECRET: readable by other accounts on a shared Linux host,
// it would let them sign admin tokens. No effect on Windows.
function _lockEnvFile() {
  try { fs.chmodSync(ENV_PATH, 0o600); } catch (err) { console.warn('Could not restrict .env permissions:', err.message); }
}
if (!fs.existsSync(ENV_PATH)) {
  const example = path.join(__dirname, '.env.example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, ENV_PATH);
    _lockEnvFile();
    console.log(`📄 Created .env in ${DATA_DIR} from template`);
  } else {
    // Write a minimal .env so dotenv doesn't fail
    fs.writeFileSync(ENV_PATH, 'JWT_SECRET=change-me-to-something-random-and-long\n');
  }
}

require('dotenv').config({ path: ENV_PATH });
require('./src/envHash').warnCutValues(ENV_PATH);

// Also load the project root .env as an override source.
// Docker compose injects it via env_file, but when running directly on the
// host the data-directory .env may be stale (created before PUBLIC_URL was
// added), so the root .env serves as a fallback for env vars the server
// administrator has explicitly set.
//
// This must be done *after* ENV_PATH so the data-dir .env takes precedence
// for server-generated values (JWT_SECRET, VAPID keys).
const rootEnv = path.join(__dirname, '.env');
if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv, override: false });
  require('./src/envHash').warnCutValues(rootEnv);
  console.log('📄 Loaded project root .env as supplementary source');
}

// Send outgoing requests through the host's proxy (https_proxy / http_proxy /
// no_proxy) when one is set. Without one this does nothing.
require('./src/outboundProxy').install();

const express = require('express');
const { createServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { Server } = require('socket.io');
const crypto = require('crypto');
const helmet = require('helmet');
const multer = require('multer');
const { sniffImageType } = require('./src/imageMetadata');
const privacyPass = require('./src/privacyPass');
const diskGuard = require('./src/diskGuard');

// (#5505) Refuse uploads that would eat into the reserved disk headroom, so a
// full volume can never leave admins unable to delete the files that filled it.
const uploadDiskGuard = diskGuard.guardUploads();

console.log(`📂 Data directory: ${DATA_DIR}`);

// ── Auto-generate JWT secret (MUST happen before loading auth module) ──
if (process.env.JWT_SECRET === 'change-me-to-something-random-and-long' || !process.env.JWT_SECRET) {
  const generated = crypto.randomBytes(48).toString('base64');
  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  envContent = envContent.replace(/JWT_SECRET=.*/, `JWT_SECRET=${generated}`);
  fs.writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
  _lockEnvFile();
  process.env.JWT_SECRET = generated;
  console.log('🔑 Auto-generated strong JWT_SECRET (saved to .env)');
}

// ── Auto-generate VAPID keys for push notifications ──────
const webpush = require('web-push');
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const vapidKeys = webpush.generateVAPIDKeys();
  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  envContent += `\nVAPID_PUBLIC_KEY=${vapidKeys.publicKey}\nVAPID_PRIVATE_KEY=${vapidKeys.privateKey}\n`;
  fs.writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
  _lockEnvFile();
  process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  console.log('🔔 Auto-generated VAPID keys for push notifications (saved to .env)');
}
// Configure web-push with contact email (admin can override via VAPID_EMAIL in .env)
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@haven.local';
webpush.setVapidDetails(vapidEmail, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const { initDatabaseAsync } = require('./src/database');
const { router: authRoutes, authLimiter, verifyToken } = require('./src/auth');
const { setupSocketHandlers, sanitizeText, sanitizeSoundName, sanitizeBorderTransform, toReplyContext } = require('./src/socketHandlers');
const { initFerry, stopFerry } = require('./src/ferry');
const { threadExtras: forumBlogThreadExtras } = require('./src/forumBlog');
const { canAccessVoiceChannel, getAccessibleVoiceChannels } = require('./src/botVoice');
const { CREATOR_NOT_BANNED_SQL } = require('./src/botAccess');
const { cleanWebhookName, cleanWebhookAvatarUrl } = require('./src/webhookFields');
const { validHighScore, isKnownGame } = require('./src/highScores');
const protectedMessages = require('./src/protectedMessages');
const {
  BotAudioManager,
  inspectAudioFile,
  MAX_AUDIO_BYTES
} = require('./src/botAudio');
const { startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup } = require('./src/tunnel');
const { startDdns, getDdnsStatus, triggerDdnsNow } = require('./src/ddns');
const { initFcm, setFcmAdminEnabled } = require('./src/fcm');
const threadNotify = require('./src/threadNotify');
const { takeSilent } = require('./src/silentMessages');

const app = express();
const BOT_AUDIO_DIR = path.join(UPLOADS_DIR, 'bot-audio');
fs.mkdirSync(BOT_AUDIO_DIR, { recursive: true });
let botAudioManager = null;
let socketRuntime = null;

// Values set up further down this file (the socket server, the database,
// bot audio) or reassigned while running. Route modules in src/routes read
// them through this object at the moment they use them, so they always
// see the current one.
const late = {
  get io() { return io; },
  get botAudioManager() { return botAudioManager; },
  get socketRuntime() { return socketRuntime; },
};

const UPLOAD_PATH_RE = /\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
const UPLOAD_URL_PATH_RE = /\/uploads\/+([-A-Za-z0-9_.~%/\\]+)/gi;

const storage = require('./src/storage');
const { auditHttp } = require('./src/httpAudit');
const { isSafeUploadRelPath } = storage;

function collectUploadRelPaths(contents) {
  const paths = new Set();
  for (const content of contents) {
    if (typeof content !== 'string' || !content) continue;
    UPLOAD_URL_PATH_RE.lastIndex = 0;
    let match;
    while ((match = UPLOAD_URL_PATH_RE.exec(content)) !== null) {
      let decoded;
      try { decoded = decodeURIComponent(match[1]); } catch { continue; }
      const parts = [];
      let escapesRoot = false;
      const segments = decoded.split(process.platform === 'win32' ? /[\\/]+/ : /\/+/);
      for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
          if (parts.length === 0) { escapesRoot = true; break; }
          parts.pop();
        } else {
          parts.push(segment);
        }
      }
      if (escapesRoot) continue;
      const relPath = parts.join('/');
      if (/^(?:bot-audio|deleted-attachments|stickers)\//i.test(relPath)) continue;
      if (isSafeUploadRelPath(relPath)) paths.add(relPath);
    }
  }
  return paths;
}

// With ownerId, the files are that person's own (a picture they replaced or
// removed), of any scope; without it, only channel uploads can be proven
// orphaned.
async function relocateUnreferencedUploads(db, relPaths, { ownerId = null } = {}) {
  const isLive = db.prepare("SELECT 1 FROM media_objects WHERE rel_path = ? AND state = 'live'");
  const candidates = new Set(Array.from(relPaths).filter(relPath => isLive.get(relPath)));
  if (candidates.size === 0) return;

  // Whose file it is comes first: it is one lookup per file, and most
  // pictures fail it (someone else's upload, an old file with no owner on
  // record). Only what is left is looked for in every message.
  const findOwnership = db.prepare(
    'SELECT user_id, scope, created_at FROM upload_ownership WHERE rel_path = ?'
  );
  const latestDmMessage = db.prepare(`
    SELECT MAX(COALESCE(m.edited_at, m.created_at)) AS referenced_at
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE c.is_dm = 1 AND m.user_id = ?
  `);
  const findProtectedFilenameReference = db.prepare(`
    SELECT 1
    WHERE EXISTS(SELECT 1 FROM custom_sounds WHERE filename = ?)
       OR EXISTS(SELECT 1 FROM custom_emojis WHERE filename = ?)
       OR EXISTS(SELECT 1 FROM stickers WHERE filename = ?)
  `);
  for (const relPath of candidates) {
    const ownership = findOwnership.get(relPath);
    // Legacy/unattributed files and private/profile uploads cannot be proven
    // orphaned, so leave them in place. A channel upload is also retained if
    // its owner later sent an encrypted DM that could contain a reference.
    const keep = !ownership
      || (ownerId !== null ? ownership.user_id !== ownerId : ownership.scope !== 'channel')
      || (() => { const dm = latestDmMessage.get(ownership.user_id)?.referenced_at; return !!dm && dm >= ownership.created_at; })()
      || !!findProtectedFilenameReference.get(relPath, relPath, relPath);
    if (keep) candidates.delete(relPath);
  }
  if (candidates.size === 0) return;

  const survivingMessages = db.prepare(`
    SELECT content, persona_avatar, webhook_avatar
    FROM messages
    WHERE content LIKE '%/uploads/%'
       OR persona_avatar IS NOT NULL
       OR webhook_avatar IS NOT NULL
  `).iterate();
  for (const message of survivingMessages) {
    for (const relPath of collectUploadRelPaths([
      message.content,
      message.persona_avatar,
      message.webhook_avatar
    ])) {
      candidates.delete(relPath);
    }
    if (candidates.size === 0) return;
  }

  const protectedUrlReferences = db.prepare(`
    SELECT avatar AS reference FROM users WHERE avatar LIKE '%/uploads/%'
    UNION ALL SELECT border FROM users WHERE border LIKE '%/uploads/%'
    UNION ALL SELECT avatar FROM user_personas WHERE avatar LIKE '%/uploads/%'
    UNION ALL SELECT avatar_url FROM webhooks WHERE avatar_url LIKE '%/uploads/%'
    UNION ALL SELECT icon FROM roles WHERE icon LIKE '%/uploads/%'
    UNION ALL SELECT value FROM server_settings WHERE value LIKE '%/uploads/%'
  `).iterate();
  for (const row of protectedUrlReferences) {
    for (const relPath of collectUploadRelPaths([row.reference])) candidates.delete(relPath);
    if (candidates.size === 0) return;
  }

  for (const relPath of candidates) await storage.softDelete(relPath);
}

// ── Per-member upload accounting (#5521) ─────────────────
// Admins could see the total size of uploads/ but never who filled it, so one
// person quietly using the server as personal cloud storage was invisible
// unless you went and read the directory yourself. DM attachments made that
// worse: the file bytes are encrypted client-side and the message that links
// them is E2E ciphertext, so nothing the server can read connects a private
// upload to the person who made it. Recording the owner at the moment of
// upload is the only place that link still exists.
function recordUploadOwnership(userId, relPath, bytes, scope = 'channel') {
  if (!Number.isInteger(userId) || !isSafeUploadRelPath(relPath)) return;
  try {
    const { getDb } = require('./src/database');
    getDb().prepare(
      'INSERT OR REPLACE INTO upload_ownership (rel_path, user_id, bytes, scope) VALUES (?, ?, ?, ?)'
    ).run(relPath, userId, Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0,
          ['channel', 'dm', 'profile'].includes(scope) ? scope : 'channel');
  } catch (err) {
    // Accounting is a reporting nicety; never fail a working upload over it.
    console.warn('[uploads] ownership record failed:', err.message);
  }
}

// The uploader's chosen scope only ever narrows what we already know from the
// endpoint, so a client that lies about it can shift its own bytes between the
// public and private columns of its own row. It cannot move them onto someone
// else, and the total (the number that matters here) is unaffected.
function uploadScopeFromRequest(req, fallback = 'channel') {
  const raw = typeof req.body?.scope === 'string' ? req.body.scope.trim().toLowerCase() : '';
  return ['channel', 'dm', 'profile'].includes(raw) ? raw : fallback;
}

// Total the live uploads per owner. Sizes come from the media index that
// src/storage keeps with every move, not from upload_ownership's stored byte
// count, so a deleted, purged, or moved-to-deleted-attachments file drops out
// on its own. Deleted attachments and temporary bot audio are not live member
// storage, and neither is in the index as live.
let _uploadUsageCache = null;
function getUploadUsage() {
  if (_uploadUsageCache && Date.now() - _uploadUsageCache.at < 60_000) return _uploadUsageCache.data;

  const sizes = new Map();   // relPath → bytes
  try {
    const { getDb } = require('./src/database');
    for (const row of getDb().prepare("SELECT rel_path, bytes FROM media_objects WHERE state = 'live'").iterate()) {
      sizes.set(row.rel_path, row.bytes);
    }
  } catch (err) {
    console.warn('[uploads] Could not read the media index for the usage report:', err.message);
  }

  const byUser = new Map();  // userId → { total, channel, dm, profile, files }
  let attributedBytes = 0;
  try {
    const { getDb } = require('./src/database');
    const rows = getDb().prepare('SELECT rel_path, user_id, scope FROM upload_ownership').all();
    for (const row of rows) {
      if (row.user_id === null) continue;
      const bytes = sizes.get(row.rel_path);
      if (bytes === undefined) continue;   // gone from disk, so stop counting it
      let entry = byUser.get(row.user_id);
      if (!entry) { entry = { total: 0, channel: 0, dm: 0, profile: 0, files: 0 }; byUser.set(row.user_id, entry); }
      entry.total += bytes;
      entry[['channel', 'dm', 'profile'].includes(row.scope) ? row.scope : 'channel'] += bytes;
      entry.files++;
      attributedBytes += bytes;
    }
  } catch (err) {
    // Every file then shows as unattributed, so the report is wrong; say why.
    console.warn('[uploads] Could not read upload ownership for the usage report:', err.message);
  }

  let liveBytes = 0;
  for (const bytes of sizes.values()) liveBytes += bytes;

  // Uploads made before this shipped have no owner row, so they land here
  // rather than being silently spread across members who did not make them.
  const data = {
    byUser,
    liveBytes,
    attributedBytes,
    unattributedBytes: Math.max(0, liveBytes - attributedBytes),
    fileCount: sizes.size
  };
  _uploadUsageCache = { at: Date.now(), data };
  return data;
}

// Trust proxy configuration: whose X-Forwarded-For to believe when reading
// the real client IP. src/clientIp.js holds the rule, so HTTP and sockets
// agree.
//
//   (unset)        default: a proxy on this machine only (inside a container,
//                  also the container network's private ranges). Anything
//                  else ignores the header, so nobody can spoof their IP
//                  past the auth rate limiter or an IP ban.
//   TRUST_PROXY=192.168.1.20  a reverse proxy on another LAN machine
//   TRUST_PROXY=1  one hop, wherever it is (Cloudflare's proxy, or any proxy
//                  on another machine)
//   TRUST_PROXY=2  two hops, etc.; TRUST_PROXY=0 trusts nothing
//
// Without a trusted proxy every user behind one shares its IP in the auth
// rate limiter, so innocent users would hit the limit on their first login.
const { trustProxySetting, compileTrust, normalizeIp } = require('./src/clientIp');
app.set('trust proxy', trustProxySetting());

// A proxy Haven does not trust shows up as every visitor having the proxy's
// address. Say so once per address, with the setting that fixes it, rather
// than leave the owner to puzzle over shared rate limits.
{
  const trusted = compileTrust(trustProxySetting());
  const warned = new Set();
  app.use((req, res, next) => {
    if (warned.size < 20 && req.headers['x-forwarded-for']) {
      const peer = normalizeIp(req.socket?.remoteAddress || '');
      if (peer && !warned.has(peer) && !trusted(peer, 0)) {
        warned.add(peer);
        console.warn(`[proxy] ${peer} sent X-Forwarded-For, but Haven does not trust it as a proxy, so everyone coming through it shares that address. If ${peer} is your reverse proxy, set TRUST_PROXY=${peer} in .env and restart.`);
      }
    }
    next();
  });
}

// ── IP ban gate (v3.20.0) ─────────────────────────────────
// Run before anything else (parsers, helmet, static) so banned addresses
// can't consume server resources. Cached for 30s so we aren't hitting SQLite
// on every static asset request from a normal page load. Cache is invalidated
// from the moderation socket handlers whenever the table changes.
// Entries are split into exact addresses (fast Set lookup, the common case)
// and CIDR ranges (linear scan, expected to stay small). Both sides are run
// through normalizeIp so a ban written as "1.2.3.4" also stops the socket
// path, which sees "::ffff:1.2.3.4" on a dual-stack listener. Before v3.42.0
// those two never compared equal and bans silently only half-applied.
const _clientIp = require('./src/clientIp');
let _ipBanCache = { set: new Set(), cidrs: [], expires: 0 };
function _refreshIpBanCache() {
  const current = require('./src/database').getDb();
  if (current?.kind === 'postgres') return current.prepare('SELECT ip FROM ip_bans').all().then(rows => {
    const set = new Set(), cidrs = [];
    for (const row of rows) {
      if (!row.ip) continue;
      if (row.ip.includes('/')) cidrs.push(row.ip);
      else set.add(_clientIp.normalizeIp(row.ip));
    }
    _ipBanCache = { set, cidrs, expires: Date.now() + 30000 };
  }).catch(err => {
    console.warn('[ip-bans] Could not read the ban list, keeping the last one:', err.code || err.message);
    _ipBanCache = { ..._ipBanCache, expires: Date.now() + 5000 };
  });
  try {
    const { getDb } = require('./src/database');
    const rows = getDb().prepare('SELECT ip FROM ip_bans').all();
    const set = new Set(), cidrs = [];
    for (const r of rows) {
      if (!r.ip) continue;
      if (r.ip.includes('/')) cidrs.push(r.ip);
      else set.add(_clientIp.normalizeIp(r.ip));
    }
    _ipBanCache = { set, cidrs, expires: Date.now() + 30000 };
  } catch (err) {
    // Keep the bans already known rather than dropping them all: an empty
    // list here would let every banned address back in until the next read.
    // Try again in a few seconds.
    console.warn('[ip-bans] Could not read the ban list, keeping the last one:', err.message);
    _ipBanCache = { ..._ipBanCache, expires: Date.now() + 5000 };
  }
}
function invalidateIpBanCache() { _ipBanCache.expires = 0; }
function isIpBanned(ip) {
  if (!ip) return false;
  if (Date.now() > _ipBanCache.expires) _refreshIpBanCache();
  const norm = _clientIp.normalizeIp(ip);
  if (!norm) return false;
  // This machine always gets in, so whoever runs the server can lift a ban
  // that went too far, even one placed before ban-ip refused them.
  if (norm === '127.0.0.1' || norm === '::1') return false;
  if (_ipBanCache.set.has(norm)) return true;
  return _ipBanCache.cidrs.some(c => _clientIp.ipMatches(norm, c));
}
app.use((req, res, next) => {
  if (isIpBanned(req.ip)) {
    return res.status(403).type('text/plain').send('Your IP has been banned from this server.');
  }
  next();
});
// Expose the invalidator on the app so socket handlers can poke it.
app.set('invalidateIpBanCache', invalidateIpBanCache);
app.set('isIpBanned', isIpBanned);

// ── Helper: verify admin from DB (don't trust JWT claims alone) ─────
// JWT isAdmin may be stale if admin was demoted since token was issued.
// Upload cap for one user: the server setting, or a higher one from a role
// they hold (roles.max_upload_mb). Admins are checked against the setting.
function uploadCapMb(user) {
  const db = require('./src/database').getDb();
  const base = parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get()?.value, 10) || 25;
  // The admin too: a server owner who lowers the setting for everyone and
  // gives their own role a higher cap was held to the setting.
  try {
    const row = db.prepare(`
      SELECT MAX(r.max_upload_mb) AS cap FROM roles r JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ? AND ur.channel_id IS NULL AND r.max_upload_mb IS NOT NULL
    `).get(user.id);
    return Math.max(base, parseInt(row?.cap, 10) || 0);
  } catch { return base; }
}

function verifyAdminFromDb(user) {
  if (!user) return false;
  try {
    const { getDb } = require('./src/database');
    const row = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
    return !!(row && row.is_admin);
  } catch { return false; }
}

// The permission check the rest of Haven uses (roles, the level thresholds
// and permissions set on one person), made once the database is open.
let _permissions = null;
function permissionsModule() {
  if (!_permissions) _permissions = require('./src/socketHandlers/permissions')(require('./src/database').getDb());
  return _permissions;
}

// For the HTTP routes. It used to look only at roles, so someone given a
// permission through the level thresholds or on their own (which the app shows
// as granted) was refused here, uploads included, and someone denied one on
// their own was still let through by a role.
function userHasPermission(userId, permission) {
  if (!userId) return false;
  try {
    const { getDb } = require('./src/database');
    const db = getDb();
    const isAdmin = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (isAdmin && isAdmin.is_admin) return true;
    // A server-wide setting on the person decides first, allow or deny. The
    // table is created at startup; if this read fails, the outer catch denies
    // rather than skipping a personal deny and letting a role allow it.
    const own = db.prepare(`
      SELECT allowed FROM user_role_perms
      WHERE user_id = ? AND permission = ? AND channel_id IS NULL
      ORDER BY allowed ASC LIMIT 1
    `).get(userId, permission);
    if (own) return own.allowed === 1;
    if (permissionsModule().userHasPermission(userId, permission)) return true;
    // These routes aren't tied to one channel, so a role held in any channel
    // still counts, as it always has here.
    const row = db.prepare(`
      SELECT 1 FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = ? AND rp.allowed = 1
      LIMIT 1
    `).get(userId, permission);
    return !!row;
  } catch { return false; }
}

// ── Referrer-Policy (admin-configurable) ─────────────────
// The Referrer-Policy header is sent on every response by the security-headers
// middleware below. Admins can change it from Settings → Security; the value is
// cached in memory (loaded at boot, refreshed when it changes) so we never read
// the DB per request. Default matches the value helmet used to set.
//
// Two of the eight standard policies are deliberately NOT offered: 'unsafe-url'
// (sends the full URL to every site, always) and 'no-referrer-when-downgrade'
// (sends the full URL to any cross-origin HTTPS site). Haven puts secrets in
// the query string (invite links arrive as ?invite=CODE and deep links as
// ?channel=CODE&message=ID), and they are only scrubbed by replaceState once
// the socket connects. Under either policy, an externally hosted image in the
// channel would carry that invite code to its host in the Referer header on
// first paint. The six kept here all stop at the origin cross-origin, which is
// enough for the case this setting exists for (CDNs like X/Twitter that reject
// a cross-origin referrer on video). Anything not in this list falls back to
// the default below, so a value saved before this list was narrowed degrades
// safely instead of persisting.
// Keep in sync with the validation list in src/socketHandlers/admin.js.
const VALID_REFERRER_POLICIES = ['no-referrer', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'];
// Default is 'same-origin' as of 3.41.0, up from the 'strict-origin-when-cross-origin'
// helmet used to set. Sending the origin cross-origin is enough for X's video CDN to
// return 403, so Twitter/X embeds showed a thumbnail and a dead play button on every
// Haven server out of the box. 'same-origin' sends nothing cross-origin, which fixes
// that and shares strictly less than before. Admins who need the old behaviour (a host
// that uses the referrer for hotlink protection) can pick it in Settings → Security.
const DEFAULT_REFERRER_POLICY = 'same-origin';
let currentReferrerPolicy = DEFAULT_REFERRER_POLICY;

// ── Security Headers (helmet) ────────────────────────────
// ── Do we serve TLS ourselves? ───────────────────────────
// Resolved here because the security headers below depend on the answer. On
// plain HTTP, telling a browser to upgrade every request to HTTPS breaks the
// page rather than protecting it: the CSS and JS are re-requested over https on
// a port with no TLS listener, so a remote visitor gets an unstyled page with
// dead buttons. It looks perfect to whoever is testing on localhost, which
// browsers treat as trustworthy and never upgrade. A Windows install whose SSL
// step was skipped (no OpenSSL on PATH) lands in exactly that state without
// anyone setting FORCE_HTTP.
let sslCert = process.env.SSL_CERT_PATH;
let sslKey  = process.env.SSL_KEY_PATH;

const forceHttp = (process.env.FORCE_HTTP || '').toLowerCase() === 'true';

// If not explicitly configured, use the certs in the data directory, and make
// them ourselves when they are missing. The startup scripts used to need an
// openssl.exe for this, which Windows does not ship (OpenSSH is not OpenSSL),
// so those machines silently fell back to HTTP.
if (!sslCert && !sslKey) {
  const autoCert = path.join(CERTS_DIR, 'cert.pem');
  const autoKey  = path.join(CERTS_DIR, 'key.pem');
  if (!forceHttp && !(fs.existsSync(autoCert) && fs.existsSync(autoKey))) {
    try {
      const made = require('./src/selfsignedCert').ensureCerts(CERTS_DIR);
      console.log(`🔒 Generated a self-signed certificate in ${CERTS_DIR} (${made.names.join(', ')})`);
    } catch (err) {
      console.warn('⚠️  Could not generate a self-signed certificate:', err.message);
    }
  }
  if (fs.existsSync(autoCert) && fs.existsSync(autoKey)) {
    sslCert = autoCert;
    sslKey  = autoKey;
  }
} else {
  // Resolve relative paths against the data directory
  if (sslCert && !path.isAbsolute(sslCert)) sslCert = path.resolve(DATA_DIR, sslCert);
  if (sslKey  && !path.isAbsolute(sslKey))  sslKey  = path.resolve(DATA_DIR, sslKey);
}

const useSSL = !!(sslCert && sslKey) && !forceHttp;
let tlsIssue = null;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:", "https://www.youtube.com", "https://w.soundcloud.com", "https://challenges.cloudflare.com"],  // last host: opt-in Turnstile CAPTCHA on registration
      styleSrc: ["'self'", "'unsafe-inline'"],  // inline styles (fonts are self-hosted, no third-party CDN)
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],  // link preview OG images + GIPHY (http: for local/self-hosted services)
      connectSrc: ["'self'", "ws:", "wss:", "https:"],  // Socket.IO + cross-origin health checks
      mediaSrc: ["'self'", "blob:", "data:", "https:", "http:"],  // WebRTC audio + notification sounds + link preview video embeds
      fontSrc: ["'self'"],  // self-hosted fonts only (see /public/fonts)
      workerSrc: ["'self'", "blob:"],  // service worker + Ruffle WebAssembly workers
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://open.spotify.com", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://w.soundcloud.com", "https://challenges.cloudflare.com"],  // Listen Together embeds + game iframes + Turnstile widget
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],               // allow mobile app iframe, block third-party clickjacking
      ...(useSSL ? {} : { upgradeInsecureRequests: null }), // helmet 8.x auto-appends upgrade-insecure-requests; it breaks every page when Haven is not serving TLS
    }
  },
  crossOriginEmbedderPolicy: false,  // needed for WebRTC
  crossOriginOpenerPolicy: false,    // needed for WebRTC
  hsts: useSSL ? { maxAge: 31536000, includeSubDomains: false } : false, // force HTTPS for 1 year (only sent when we actually serve it)
  referrerPolicy: false, // set dynamically from the admin-configurable cache in the middleware below
}));

// Additional security headers helmet doesn't cover
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', currentReferrerPolicy); // admin-configurable (Settings → Security)
  next();
});

// Disable Express version disclosure
app.disable('x-powered-by');

// ── Body Parsing with size limits ────────────────────────
// Global limit bumped to 128kb so legit large-but-bounded payloads like the
// per-user saved server list (PUT /api/auth/user-servers, ~40kb at 100+
// servers) aren't rejected by the global parser before per-route parsers
// can apply their own limits. Individual routes still set tighter limits
// where appropriate. (#5347 v3.15.7)
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
require('./src/db/postgres/http').installPostgresPreviewHttp(app);

// ── Self-hosted fonts (long-lived cache) ─────────────────
// Fonts never change for a given filename, so let clients cache them for a
// year and skip revalidation. A ?v= bump in style.css busts the cache when a
// file is ever replaced. Mounted before the general /public handler so these
// win over its always-revalidate (maxAge:0) policy.
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts'), {
  dotfiles: 'deny',
  maxAge: '1y',
  immutable: true,
}));

// ── Flash player (Ruffle) ────────────────────────────────
// Served from the npm package pinned in package.json. It used to come from
// unpkg, which meant whatever version was newest that day, fetched from a
// third party by every player, and a CSP that let the games pages run any
// script published to npm. The core scripts and .wasm files carry a content
// hash in their names, so those can be cached for good.
let RUFFLE_DIR = null;
try {
  RUFFLE_DIR = path.dirname(require.resolve('@ruffle-rs/ruffle/package.json'));
} catch {
  console.warn('Flash games are unavailable: the Flash player package is missing. Run npm install in the Haven folder.');
}
if (RUFFLE_DIR) {
  app.use('/games/ruffle', express.static(RUFFLE_DIR, {
    dotfiles: 'deny',
    maxAge: 0,
    setHeaders: (res, file) => {
      if (/(^|\.)[0-9a-f]{20}\.(js|wasm)$/.test(path.basename(file))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}

// Flash games downloaded from Activities, kept in the data folder. Games
// installed before that sat in public/games/roms, which the static files
// below still serve.
app.use('/games/roms', express.static(GAMES_ROMS_DIR, { dotfiles: 'deny', maxAge: 0 }));

// ── Static files with caching ────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',       // block .env, .git, etc.
  etag: true,             // ETag for conditional requests
  lastModified: true,     // Last-Modified header
  maxAge: 0,              // always revalidate (prevents stale JS/CSS after deploys)
}));

// ── Serve uploads from storage ──────────────────────────
// The internal folders are refused first; see src/storage/serve.js.
const { blockInternalUploads, serveUploads } = require('./src/storage/serve');
app.use('/uploads', blockInternalUploads);
app.use('/uploads', serveUploads(storage));

// ── Plugin & Theme file serving ─────────────────────────
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const THEMES_DIR  = path.join(__dirname, 'themes');
const {
  compatibleThemeFiles,
  createThemeFileMiddleware,
  readThemeMetadataSnapshot,
  validatedThemeDefault,
} = require('./src/themeMetadata');
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
if (!fs.existsSync(THEMES_DIR))  fs.mkdirSync(THEMES_DIR, { recursive: true });

// ── Plugin & theme updater ─────────────────────────────
// File checks and replacement live in the helper; HTTP authorization stays
// here alongside the other admin endpoints.
const { createExtensionUpdater } = require('./src/extensionUpdates');
const extensionUpdater = createExtensionUpdater({
  dirs: { plugin: PLUGINS_DIR, theme: THEMES_DIR },
  stateDir: path.join(DATA_DIR, 'extension-updates'),
  havenVersion: require('./package.json').version,
});

app.use('/plugins', express.static(PLUGINS_DIR, { dotfiles: 'deny', maxAge: 0 }));
app.use('/themes', createThemeFileMiddleware(THEMES_DIR));
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
app.get('/api/themes', async (req, res) => {
  try {
    let published = [];
    try {
      const row = await db.async.prepare("SELECT value FROM server_settings WHERE key = 'published_themes'").get();
      if (row) {
        const stored = JSON.parse(row.value);
        if (Array.isArray(stored)) published = stored;
      }
    } catch { /* DB not ready yet or parse error, default to empty */ }
    const themes = readThemeMetadataSnapshot(THEMES_DIR)
      .map(theme => ({ ...theme, published: theme.compatible && published.includes(theme.file) }));
    res.json(themes);
  } catch (err) {
    console.error('Failed to list themes:', err.message);
    res.status(500).json({ error: 'Failed to list themes' });
  }
});

// ── File uploads (DB-configurable limit, avatar max 5 MB) ──
const uploadDir = UPLOADS_DIR;

// Every upload is written into unprocessed/ first and only reaches uploads/
// once its location data is gone (src/privacyPass.js).
const uploadStorage = privacyPass.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

// Uploads stop at the caller's own cap while they stream. The ceiling used to
// be a nominal 100 GB with the real cap checked only once the whole file was
// on disk, so anyone signed in could fill the disk with one request (the
// avatar route needs no permission at all). Each route still checks its own,
// often smaller, limit afterwards. Multer removes a file cut off this way.
function uploadCapMbFor(req) {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  const mb = user ? uploadCapMb(user) : 25;
  return Number.isFinite(mb) && mb > 0 ? mb : 25;
}
// A multer wrapper that cuts the upload off at the caller's cap and, when it
// does, reports it the way the routes do ("File too large (max N MB)").
function cappedUpload(options) {
  return {
    single: (field) => (req, res, next) => {
      const capMb = uploadCapMbFor(req);
      // Text fields are held in memory, and busboy allows any number of them
      // by default; a handful of short ones is all any upload form sends.
      multer({ ...options, limits: { fileSize: capMb * 1024 * 1024 + 1, fields: 20, fieldSize: 16 * 1024 } }).single(field)(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') err.message = `File too large (max ${capMb} MB)`;
        next(err);
      });
    }
  };
}
const imageOnlyFilter = (req, file, cb) => {
  if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only images allowed (jpg, png, gif, webp)'));
};

// Image-only upload
const upload = cappedUpload({ storage: uploadStorage, fileFilter: imageOnlyFilter });

// General file upload: no MIME restrictions; safety enforced via
// Content-Disposition: attachment on non-image downloads (see /uploads handler)
const fileUpload = cappedUpload({ storage: uploadStorage });

const botAudioUpload = multer({
  storage: multer.diskStorage({
    destination: BOT_AUDIO_DIR,
    filename: (req, file, cb) => {
      const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.upload`;
      req.botAudioTempPath = path.join(BOT_AUDIO_DIR, name);
      cb(null, name);
    }
  }),
  limits: {
    fileSize: MAX_AUDIO_BYTES,
    files: 1,
    fields: 1,
    parts: 3,
    fieldSize: 64,
    fieldNestingDepth: 0,
    headerPairs: 20
  }
});

// ── API routes ────────────────────────────────────────────
// authLimiter is applied per-route inside auth.js for credential endpoints
// (login, register, TOTP, password change). Non-credential routes like
// /validate and /user-servers are intentionally left unlimitted here so
// 50+ concurrent users joining a stream event don't trip the limiter. (#5323)
app.use('/api/auth', authRoutes);

// ── Rich presence: account linking (Steam / Spotify) ─────
// Mounted here, ahead of static + SPA handling, so /connect/* is never
// swallowed by a catch-all. The activity engine is built later inside
// setupSocketHandlers, hence the getter (see activityRef below).
const activityRef = { engine: null };
const { createConnectRoutes, baseUrl } = require('./src/connectRoutes');
app.use('/connect', createConnectRoutes(() => activityRef.engine));

// ── Plugin & theme update endpoints (src/routes/extensionUpdates.js) ──
require('./src/routes/extensionUpdates')({ app, verifyToken, verifyAdminFromDb, extensionUpdater, late });

// ── Push notification VAPID public key endpoint ──────────
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Push notification subscription endpoints ─────────────
app.post('/api/push/subscribe', express.json(), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048 ||
      typeof keys?.p256dh !== 'string' || !keys.p256dh || keys.p256dh.length > 512 ||
      typeof keys?.auth !== 'string' || !keys.auth || keys.auth.length > 512)
    return res.status(400).json({ error: 'Invalid subscription object' });
  // Same rule as the socket path: the server posts to this address for every
  // notification, so it must be a public HTTPS push service, never an address
  // on the server's own network, unless HAVEN_ALLOW_PRIVATE_CALLBACKS allows it.
  try {
    if (new URL(endpoint).protocol !== 'https:') throw new Error('not https');
    await require('./src/webhookCallback').resolveCallbackDestination(endpoint,
      { allowPrivateCallbacks: process.env.HAVEN_ALLOW_PRIVATE_CALLBACKS === 'true' });
  } catch (err) {
    console.warn(`Push subscription refused: ${err.message}`);
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  try {
    const { getDb } = require('./src/database');
    const db = getDb();
    // An endpoint identifies one browser/device, and only one account can be
    // signed into it at a time. The table is UNIQUE(user_id, endpoint), so
    // signing in as someone else used to leave the previous account's row
    // behind pointing at the same device. Fan-out only skips subscriptions
    // whose user_id matches the sender, so that stale row kept getting pushed
    // and the sender received their own messages on their own phone. Claim the
    // endpoint for this user.
    db.transaction(() => {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id != ?').run(endpoint, user.id);
      db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth
      `).run(user.id, endpoint, keys.p256dh, keys.auth);
        // Ten devices per person is plenty; the oldest go first. Without a cap
        // one account could register endless endpoints for the push queue.
        db.prepare(`
          DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
            SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10)
        `).run(user.id, user.id);
    })();
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

require('./src/routes/channel-prefs')({ app, verifyToken });

// ── ICE servers endpoint (STUN + optional TURN) ──────────
app.get('/api/ice-servers', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  // TURN credentials relay traffic through the admin's server; a banned
  // account gets none.
  try {
    if (require('./src/database').getDb().prepare('SELECT 1 FROM bans WHERE user_id = ?').get(user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  } catch (err) {
    // Fail closed: without the ban check a banned account would get TURN credentials.
    console.error('[ice-servers] Ban check failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Admin-configured STUN/TURN (#5399) live in server_settings and take
  // precedence over env vars, which in turn override the built-in pool.
  // Admins can now point at their own servers from Settings → Voice &
  // Connectivity without touching env vars or redeploying.
  let dbSettings = {};
  try {
    const { getDb } = require('./src/database');
    const rows = getDb().prepare(
      "SELECT key, value FROM server_settings WHERE key IN ('stun_urls','turn_url','turn_username','turn_password','voice_force_relay','voice_ice_disabled')"
    ).all();
    rows.forEach(r => { dbSettings[r.key] = r.value; });
  } catch (err) {
    // Falls back to env/defaults, which ignores the admin's voice settings.
    console.warn('[ice-servers] Could not read voice settings, using env/defaults:', err.message);
  }

  // An explicit admin disable takes precedence over env and built-in servers.
  // Empty iceServers tells WebRTC to use direct host candidates only.
  if (dbSettings.voice_ice_disabled === 'true') return res.json({ iceServers: [] });

  // STUN precedence: admin setting → STUN_URLS env → built-in defaults.
  // 3.20.2 (#5399): old defaults (stun.stunprotocol.org + stun.nextcloud.com)
  // both went offline simultaneously. Mirrors the voice.js client default
  // pool so any Haven server that hadn't customised STUN would have
  // returned dead endpoints to its clients here too.
  const adminStun = (dbSettings.stun_urls || '').trim();
  const stunUrls = adminStun
    ? adminStun.split(/[\n,]/).map(u => u.trim()).filter(Boolean)
    : process.env.STUN_URLS
      ? process.env.STUN_URLS.split(',').map(u => u.trim()).filter(Boolean)
      : [
          'stun:stun.cloudflare.com:3478',
          'stun:stun.relay.metered.ca:80',
          'stun:global.stun.twilio.com:3478',
        ];
  const iceServers = stunUrls.map(urls => ({ urls }));

  // TURN precedence: admin setting (static creds) → env (supports HMAC secret).
  const adminTurn = (dbSettings.turn_url || '').trim();
  if (adminTurn) {
    const u = (dbSettings.turn_username || '').trim();
    const p = (dbSettings.turn_password || '').trim();
    if (u && p) iceServers.push({ urls: adminTurn, username: u, credential: p });
    else iceServers.push({ urls: adminTurn });
  } else {
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
  }

  // Chrome logs "Using five or more STUN/TURN servers slows down discovery"
  // and genuinely gathers candidates more slowly past that point. A TURN relay
  // on top of the four built-in STUN defaults lands on exactly five, which is
  // what dragged out reconnection after a socket flap in #5444 (peers stuck on
  // ice=checking). Cap the list at four, dropping STUN entries first so the
  // TURN relay (the one that actually traverses strict NAT) always survives.
  const MAX_ICE_SERVERS = 4;
  if (iceServers.length > MAX_ICE_SERVERS) {
    const isTurn = (s) => /turns?:/i.test(String(s.urls));
    const turns = iceServers.filter(isTurn);
    const stuns = iceServers.filter(s => !isTurn(s));
    const keepStun = Math.max(0, MAX_ICE_SERVERS - turns.length);
    const trimmed = [...stuns.slice(0, keepStun), ...turns];
    iceServers.length = 0;
    iceServers.push(...trimmed);
  }

  // ── Relay-only mode (v3.42.0) ───────────────────────────
  // Haven voice is a peer-to-peer WebRTC mesh, so in the default configuration
  // every participant in a call learns every other participant's public IP
  // from the ICE candidate exchange. No click, no prompt, nothing the user
  // can see. Sitting idle in a voice channel is enough to collect addresses
  // from anyone who joins.
  //
  // iceTransportPolicy 'relay' makes the browser discard host and
  // server-reflexive candidates entirely, so peers only ever see the TURN
  // server's address. That costs bandwidth (all media flows through TURN) and
  // hard-requires a working TURN server, which is why the settings handler
  // refuses to turn this on until turn_url is set. Belt-and-braces here too:
  // if TURN somehow vanished since the toggle was flipped, serve normal ICE
  // rather than handing clients a config that cannot connect at all.
  const wantsRelay = dbSettings.voice_force_relay === 'true';
  const hasTurn = iceServers.some(s => /^turns?:/i.test(String(s.urls)));
  if (wantsRelay && hasTurn) {
    return res.json({ iceServers, iceTransportPolicy: 'relay' });
  }
  if (wantsRelay && !hasTurn) {
    console.warn('⚠️  voice_force_relay is on but no TURN server is configured; serving normal ICE so voice keeps working');
  }

  res.json({ iceServers });
});

// ── Profile pictures, borders and personas: src/routes/profile.js ──
// A profile picture someone replaced or removed goes to deleted-attachments,
// if it was their own upload and nothing else still shows it.
const releaseOwnUploads = (urls, ownerId) => relocateUnreferencedUploads(
  require('./src/database').getDb(), collectUploadRelPaths(urls), { ownerId });
require('./src/routes/profile')({ uploadDiskGuard, app, recordUploadOwnership, releaseOwnUploads, verifyAdminFromDb, userHasPermission, upload, uploadLimiter });

// ── Serve pages ──────────────────────────────────────────

// ── Connection address (any signed-in user) ──────────────
// The status bar used to show window.location.origin, which for the person
// running the server is "localhost:3000", useless to share and pointless to
// hide or copy. Resolve the address someone else could actually connect on:
// an active tunnel wins, otherwise the same PUBLIC_URL / X-Forwarded-Host /
// Host resolution the OAuth callbacks already rely on.
//
// Auth-gated on purpose. This is not in /api/public-config because that is
// unauthenticated, and an anonymous caller reaching the box on its LAN
// address should not be handed the server's public hostname.
app.get('/api/connection-address', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = req.postgresUser || (token ? verifyToken(token) : null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const tunnel = getTunnelStatus();
    if (tunnel && tunnel.active && tunnel.url) {
      return res.json({ url: tunnel.url, source: 'tunnel' });
    }
    const resolved = baseUrl(req);
    // Loopback means we could not work out anything shareable. Say so rather
    // than handing back localhost, so the client can hide the widget instead
    // of offering to copy an address that only works on this machine.
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|$)/i.test(resolved);
    res.json({
      url: isLoopback ? null : resolved,
      source: isLoopback ? 'loopback' : (process.env.PUBLIC_URL ? 'public_url' : 'host'),
    });
  } catch {
    res.status(500).json({ error: 'Failed to resolve address' });
  }
});

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
  // Inject current version into cache-busting query strings so client
  // assets are never served stale after an update (especially in Electron).
  const ver = require('./package.json').version;
  let html = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
  html = html.replace(/(\?v=)[^"']*/g, `$1${ver}`);
  res.type('html').send(html);
});

// ── Vanity invite link (/invite/:code) ────────────────
// The answer is the same redirect whether or not the code exists, so this
// page cannot be used to test guesses at short custom invite slugs; the app
// passes ?invite= to join-channel, which checks the code (and its enabled,
// expiry and use-limit rules) for a signed-in member. The limit is per IP,
// generous for people following links and tight for a guessing script.
const inviteLinkLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 30, message: 'Too many invite links, try again in a minute' });
app.get('/invite/:vanityCode', inviteLinkLimiter, (req, res) => {
  const vanityCode = req.params.vanityCode;
  if (!vanityCode || typeof vanityCode !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(vanityCode)) {
    return res.status(400).send('Invalid invite link');
  }
  res.redirect(`/app?invite=${encodeURIComponent(vanityCode)}`);
});

app.get('/games/flappy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'games', 'flappy.html'));
});

// ── Donors / sponsors list (loaded from donors.json) ──
app.get('/api/donors', (req, res) => {
  try {
    const donorsPath = path.join(__dirname, 'donors.json');
    const data = JSON.parse(fs.readFileSync(donorsPath, 'utf-8'));
    // Check for magnitude-sorted order file (gitignored, optional)
    const orderPath = path.join(__dirname, 'donor-order.json');
    if (fs.existsSync(orderPath)) {
      try {
        const ordered = JSON.parse(fs.readFileSync(orderPath, 'utf-8'));
        data.featuredSponsors = ordered.sponsors || [];
        data.featuredDonors = ordered.donors || [];
      } catch { /* optional ordering file; the plain donors list still shows */ }
    }
    res.json(data);
  } catch {
    res.json({ sponsors: [], donors: [] });
  }
});

require('./src/routes/health')({ app });

// ── Version endpoint (for update checker, authenticated users only) ──
app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version });
});

// ── Public config (unauthenticated: safe, read-only aesthetics) ──
// Returns the admin-configured default theme so the login page can match
// the server's look for first-time visitors who have no localStorage preference.
app.get('/api/public-config', async (req, res) => {
  try {
    const { getDb } = require('./src/database');
    const db = getDb().async;
    const themeRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get();
    const publishedThemesRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'published_themes'").get();
    const localeRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'default_locale'").get();
    const titleRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_title'").get();
    const tosRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'custom_tos'").get();
    const nameRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get();
    const iconRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_icon'").get();
    const adminPwResetRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'admin_password_reset_enabled'").get();
    const loginSetting = async (k) => (await db.prepare('SELECT value FROM server_settings WHERE key = ?').get(k))?.value || '';
    const oidcConfig = db.kind === 'postgres' ? { enabled: false } : require('./src/oidc').getOidcConfig();
    let storedPublishedThemes = [];
    try { storedPublishedThemes = JSON.parse(publishedThemesRow?.value || '[]'); } catch { /* malformed setting: treat as no published themes */ }
    const publishedThemes = compatibleThemeFiles(THEMES_DIR, storedPublishedThemes);
    res.json({
      default_theme: validatedThemeDefault(THEMES_DIR, themeRow?.value || '', publishedThemes),
      default_locale: localeRow?.value || '',
      server_title: titleRow?.value || '',
      custom_tos: tosRow?.value || '',
      // Expose name + icon so the login page can brand its tab title and
      // favicon (issue #5284). These are already public via /api/health.
      server_name: nameRow?.value || process.env.SERVER_NAME || '',
      server_icon: iconRow?.value || '',
      // The login page's look (#5819), all of it shown to anyone who visits.
      login_logo: (await loginSetting('login_show_icon')) === 'true' ? (iconRow?.value || '') : '',
      login_background: (await loginSetting('login_show_banner')) === 'true' ? await loginSetting('server_banner') : '',
      login_message: await loginSetting('login_message'),
      login_css: await loginSetting('login_css'),
      // Surface security-relevant settings users may want to know about
      // before signing up (issue #5300). Allowing a user to *see* whether
      // an admin can reset their password is the trust-and-warning half
      // of the feature: admins enable, users get the disclosure.
      admin_password_reset_enabled: adminPwResetRow?.value === 'true',
      // SSO (#12). Reports configured-and-usable, not just the toggle, so the
      // login page never offers a button that can only fail. The issuer and
      // client id stay server-side; the client needs neither.
      oidc_enabled: oidcConfig.enabled,
      oidc_button_label: oidcConfig.enabled ? oidcConfig.buttonLabel : '',
      tls_issue: tlsIssue
    });
  } catch {
    res.json({ default_theme: '', default_locale: '', server_title: '' });
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
  const { agentFor } = require('./src/outboundProxy');

  // Step 1: Get public IP
  let publicIp = null;
  try {
    publicIp = await new Promise((resolve, reject) => {
      const req = https.get('https://api.ipify.org?format=json', { timeout: 5000, agent: agentFor('https://api.ipify.org') }, (resp) => {
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
      const req = https.get(url, { timeout: 10000, agent: agentFor(url) }, (resp) => {
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
          // SECURITY NOTE: rejectUnauthorized:false is intentional here: this
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
  // Server admins are not throttled: posting a batch of pictures for a guide
  // or an example is a normal thing for them to do (#5698). The disk guard
  // and size caps still apply.
  const token = req.headers.authorization?.split(' ')[1];
  const tokenUser = token ? verifyToken(token) : null;
  if (tokenUser && verifyAdminFromDb(tokenUser)) return next();
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxUploads = 10;
  if (!uploadLimitStore.has(ip)) uploadLimitStore.set(ip, []);
  const stamps = uploadLimitStore.get(ip).filter(t => now - t < windowMs);
  uploadLimitStore.set(ip, stamps);
  if (stamps.length >= maxUploads) return res.status(429).json({ error: 'Upload rate limit: try again in a minute' });
  stamps.push(now);
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of uploadLimitStore) { const f = t.filter(x => now - x < 60000); if (!f.length) uploadLimitStore.delete(ip); else uploadLimitStore.set(ip, f); } }, 5 * 60 * 1000);

// ── Image and file uploads, and Flash ROMs: src/routes/uploads.js ──
require('./src/routes/uploads')({ uploadDiskGuard, app, recordUploadOwnership, uploadScopeFromRequest, uploadCapMb, verifyAdminFromDb, userHasPermission, upload, fileUpload, uploadLimiter });

// (duplicate avatar handler removed; handled above at /api/upload-avatar)

// ── Sounds, custom emoji and stickers: src/routes/media-library.js ──
const { BUILTIN_SOUNDS, seedStarterStickers } = require('./src/routes/media-library')({ uploadDiskGuard, app, verifyAdminFromDb, userHasPermission, uploadDir, uploadStorage, uploadLimiter });
// Profile badge icons (#5632): src/routes/badges.js
require('./src/routes/badges')({ app, verifyAdminFromDb, userHasPermission, uploadDir, uploadLimiter, uploadDiskGuard });

// ── GIF search proxy (GIPHY, KLIPY, or a legacy Tenor fallback) ──
// Three providers are supported. preferred_gif_search picks which one to use
// when more than one key is set. If that preference is unset or not a known
// provider, we fall back to whatever is configured, trying GIPHY first, then
// KLIPY, and Tenor last (Tenor is deprecated).
const GIF_FALLBACK_ORDER = ['giphy', 'klipy', 'tenor'];
function getGifProvider() {
  // Check database first (set via admin panel), fall back to .env
  const readSetting = (key) => {
    try {
      const { getDb } = require('./src/database');
      const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
      if (row && row.value) return row.value;
    } catch { /* DB not ready yet or no key stored */ }
    return '';
  };
  const keys = {
    giphy: readSetting('giphy_api_key') || process.env.GIPHY_API_KEY || '',
    klipy: readSetting('klipy_api_key') || process.env.KLIPY_API_KEY || '',
    tenor: readSetting('tenor_api_key') || process.env.TENOR_API_KEY || '',
  };
  const preferred = (readSetting('preferred_gif_search') || process.env.PREFERRED_GIF_SEARCH || '')
    .trim().toLowerCase();
  // Honour the preference only when it names a known provider that actually
  // has a key; otherwise fall through to the configured-order fallback.
  if (GIF_FALLBACK_ORDER.includes(preferred) && keys[preferred]) {
    return { provider: preferred, key: keys[preferred] };
  }
  for (const provider of GIF_FALLBACK_ORDER) {
    if (keys[provider]) return { provider, key: keys[provider] };
  }
  return null;
}

// All providers normalize to the same result shape the client expects:
// { id, title, tiny (grid thumbnail), full (send URL) }.
function fetchGifs(kind, q, limit, cfg) {
  if (cfg.provider === 'klipy') {
    // The app key is a path segment; the small (220px) gif is the grid
    // thumbnail and the hd/md gif is the send URL.
    const path = kind === 'search'
      ? `gifs/search?q=${encodeURIComponent(q)}&`
      : 'gifs/trending?';
    const url = `https://api.klipy.com/api/v1/${encodeURIComponent(cfg.key)}/${path}per_page=${limit}&content_filter=off`;
    return fetch(url).then(r => r.json()).then(data => (data.data?.data || []).map(g => ({
      id: g.id,
      title: g.title || '',
      tiny: g.file?.sm?.gif?.url || g.file?.xs?.gif?.url || '',
      full: g.file?.hd?.gif?.url || g.file?.md?.gif?.url || '',
    })));
  }
  if (cfg.provider === 'tenor') {
    const base = kind === 'search'
      ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&`
      : 'https://tenor.googleapis.com/v2/featured?';
    const url = `${base}key=${encodeURIComponent(cfg.key)}&limit=${limit}&media_filter=tinygif,gif&contentfilter=off`;
    return fetch(url).then(r => r.json()).then(data => (data.results || []).map(g => ({
      id: g.id,
      title: g.content_description || g.title || '',
      tiny: g.media_formats?.tinygif?.url || g.media_formats?.gif?.url || '',
      full: g.media_formats?.gif?.url || '',
    })));
  }
  const base = kind === 'search'
    ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&lang=en&`
    : 'https://api.giphy.com/v1/gifs/trending?';
  const url = `${base}api_key=${encodeURIComponent(cfg.key)}&limit=${limit}&rating=r`;
  return fetch(url).then(r => r.json()).then(data => (data.data || []).map(g => ({
    id: g.id,
    title: g.title || '',
    tiny: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || '',
    full: g.images?.original?.url || '',
  })));
}

// ── Server icon upload (admin only, image only, max 2 MB) ──
app.post('/api/upload-server-icon', uploadLimiter, uploadDiskGuard, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message, code: err.code });
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
    } catch { try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ } return res.status(400).json({ error: 'Failed to validate' }); }

    try { await storage.admitUpload(req.file); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
    const iconUrl = `/uploads/${req.file.filename}`;
    const { getDb } = require('./src/database');
    getDb().prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_icon', ?)").run(iconUrl);
    auditHttp(user, 'server_setting_update', { target_type: 'setting', target_name: 'server_icon', details: { key: 'server_icon', value: iconUrl } });
    res.json({ url: iconUrl });
  });
});

// ── Role icon upload (admin only, image only, max 512 KB) ──
app.post('/api/upload-role-icon', uploadLimiter, uploadDiskGuard, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user) && !userHasPermission(user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Admin or manage_roles permission required' });
  }

  upload.single('icon')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message, code: err.code });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size > 512 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Role icon must be under 512 KB' });
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
      if (!validMagic) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid image' }); }
    } catch { try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ } return res.status(400).json({ error: 'Failed to validate' }); }

    try { await storage.admitUpload(req.file); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
    const iconUrl = `/uploads/${req.file.filename}`;
    res.json({ path: iconUrl });
  });
});

// ── Backup download and restore (admin only): src/routes/backup.js ──
const { buildBackupFile } = require('./src/routes/backup')({ app, verifyAdminFromDb, late });

// ── Server banner upload (admin only, image only, max 4 MB) ──
app.post('/api/upload-server-banner', uploadLimiter, uploadDiskGuard, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message, code: err.code });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size > 4 * 1024 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Server banner must be under 4 MB' });
    }
    try {
      const fd = fs.openSync(req.file.path, 'r');
      const hdr = Buffer.alloc(12);
      fs.readSync(fd, hdr, 0, 12, 0);
      fs.closeSync(fd);
      const isJpeg = hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF;
      const isPng  = hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4E && hdr[3] === 0x47;
      const isGif  = hdr.slice(0, 6).toString().startsWith('GIF8');
      const isWebp = hdr.slice(0, 4).toString() === 'RIFF' && hdr.slice(8, 12).toString() === 'WEBP';
      if (!isJpeg && !isPng && !isGif && !isWebp) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid image: only JPG, PNG, GIF, or WebP' }); }
    } catch { try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ } return res.status(400).json({ error: 'Failed to validate' }); }

    try { await storage.admitUpload(req.file); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
    const bannerUrl = `/uploads/${req.file.filename}`;
    const { getDb } = require('./src/database');
    getDb().prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_banner', ?)").run(bannerUrl);
    auditHttp(user, 'server_setting_update', { target_type: 'setting', target_name: 'server_banner', details: { key: 'server_banner', value: bannerUrl } });
    res.json({ url: bannerUrl });
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
  if (stamps.length >= maxReqs) return res.status(429).json({ error: 'Rate limited, try again shortly' });
  stamps.push(now);
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of gifLimitStore) { const f = t.filter(x => now - x < 60000); if (!f.length) gifLimitStore.delete(ip); else gifLimitStore.set(ip, f); } }, 5 * 60 * 1000);

app.get('/api/gif/search', gifLimiter, (req, res) => {
  // Require authentication
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const cfg = getGifProvider();
  if (!cfg) return res.status(501).json({ error: 'gif_not_configured' });
  const q = (req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  fetchGifs('search', q, limit, cfg)
    .then(results => res.json({ provider: cfg.provider, results }))
    .catch(() => res.status(502).json({ error: 'GIF provider API error' }));
});

app.get('/api/gif/trending', gifLimiter, (req, res) => {
  // Require authentication
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const cfg = getGifProvider();
  if (!cfg) return res.status(501).json({ error: 'gif_not_configured' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  fetchGifs('trending', '', limit, cfg)
    .then(results => res.json({ provider: cfg.provider, results }))
    .catch(() => res.status(502).json({ error: 'GIF provider API error' }));
});

// ── Link previews and the media proxy: src/routes/link-preview.js ──
require('./src/routes/link-preview')({ app });

// ── Release notes for the "What's new" popup: src/routes/changelog.js ──
require('./src/routes/changelog')({ app, verifyToken });

// ── Games list endpoint: discover available games ──
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
  // Answered without a login (the game's fallback cannot send one), so it
  // carries names and scores only, not account ids.
  const leaderboard = getDb().prepare(`
    SELECT COALESCE(u.display_name, u.username) as username, hs.score
    FROM high_scores hs JOIN users u ON hs.user_id = u.id
    WHERE hs.game = ? AND hs.score > 0
      AND NOT EXISTS (
        SELECT 1 FROM user_preferences up
        WHERE up.user_id = u.id AND up.key = 'hide_score_badge' AND up.value = 'true'
      )
    ORDER BY hs.score DESC LIMIT 50
  `).all(game);
  res.json({ game, leaderboard });
});

app.post('/api/high-scores', express.json(), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const game = typeof req.body.game === 'string' ? req.body.game.trim() : '';
  if (!game || !/^[a-z0-9_-]{1,32}$/.test(game) || !isKnownGame(game)) return res.status(400).json({ error: 'Invalid game id' });
  // A JSON number only: no strings, and nothing past the game's ceiling.
  const score = typeof req.body.score === 'number' ? validHighScore(game, req.body.score) : null;
  if (score === null) return res.status(400).json({ error: 'Invalid score' });

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
      AND NOT EXISTS (
        SELECT 1 FROM user_preferences up
        WHERE up.user_id = u.id AND up.key = 'hide_score_badge' AND up.value = 'true'
      )
    ORDER BY hs.score DESC LIMIT 50
  `).all(game);
  res.json({ game, leaderboard });
});

// ═══════════════════════════════════════════════════════════
// WEBHOOK / BOT INTEGRATION: incoming message endpoint
// ═══════════════════════════════════════════════════════════
const rateLimit = require('express-rate-limit');
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Rate limit exceeded' } });
const webhookAudioLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Audio rate limit exceeded' } });
const webhookAudioControlLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Audio control rate limit exceeded' } });
const botAudioPlaybackLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Audio playback rate limit exceeded' } });
// Opening a webhook URL in a browser sends a GET, which used to fall through
// to the generic "Not found" and read as a broken webhook. Say how to use it
// instead. The token is not looked up, so this tells nobody whether it exists.
app.get('/api/webhooks/:token', webhookLimiter, (req, res) => {
  res.set('Allow', 'POST').status(405).json({
    error: 'Webhooks take POST requests, so opening this link in a browser will not work. Send a POST with a JSON body like {"content": "Hello"}. See "Bot & Webhook Developer Guide" in GUIDE.md.'
  });
});

app.post('/api/webhooks/:token', webhookLimiter, express.json({ limit: '64kb' }), (req, res) => {
  const { getDb } = require('./src/database');
  const db = getDb();
  const { token } = req.params;

  if (!token || typeof token !== 'string' || token.length !== 64) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  // Same rule as getWebhookByToken: a banned person's bots stop posting.
  const webhook = db.prepare(
    `SELECT w.*, c.code as channel_code, c.name as channel_name FROM webhooks w JOIN channels c ON w.channel_id = c.id WHERE w.token = ? AND w.is_active = 1 AND c.is_dm = 0 AND ${CREATOR_NOT_BANNED_SQL}`
  ).get(token);

  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found or inactive' });
  }

  // A bot can post silently too: "silent": true, or "@silent" up front.
  const silentPick = takeSilent(typeof req.body.content === 'string' ? req.body.content.trim() : '', req.body.silent);
  const silent = silentPick.silent;
  const content = sanitizeText(silentPick.content.trim());
  if (!content || content.length > 4000) {
    return res.status(400).json({ error: 'Content required (max 4000 chars)' });
  }

  // Optional overrides per-message
  const username = (typeof req.body.username === 'string' && cleanWebhookName(sanitizeText(req.body.username))) || webhook.name;
  // Only this server's uploads or https images (loaded through the media
  // proxy), never a plain http or other scheme URL every reader fetches.
  let avatarUrl = webhook.avatar_url;
  if (typeof req.body.avatar_url === 'string') avatarUrl = cleanWebhookAvatarUrl(req.body.avatar_url);

  // Optional reply_to: bot replying to a message in the same channel (3.13.0)
  let replyTo = null;
  if (req.body.reply_to !== undefined && req.body.reply_to !== null) {
    const rid = parseInt(req.body.reply_to, 10);
    if (Number.isInteger(rid) && rid > 0) {
      const target = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(rid, webhook.channel_id);
      if (target) replyTo = rid;
    }
  }

  // Optional thread_id: post as a reply inside a thread (#5706). The parent
  // has to be a top-level message in this bot's channel, and a reply_to
  // only stands if it points into that same thread.
  let threadId = null;
  if (req.body.thread_id !== undefined && req.body.thread_id !== null) {
    const tid = parseInt(req.body.thread_id, 10);
    const parent = Number.isInteger(tid) && tid > 0
      ? db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL').get(tid, webhook.channel_id)
      : null;
    if (!parent) return res.status(400).json({ error: 'thread_id must be a top-level message in this bot\'s channel' });
    if (req.body.ephemeral === true) return res.status(400).json({ error: 'thread_id cannot be combined with ephemeral' });
    threadId = tid;
    if (replyTo) {
      const r = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(replyTo);
      if (!r || r.thread_id !== threadId) replyTo = null;
    }
  }

  // Optional ephemeral delivery to a single recipient in this channel.
  // Ephemeral webhook messages are not persisted to chat history.
  const ephemeral = req.body.ephemeral === true;
  let recipientId = null;
  if (ephemeral) {
    const parsedRecipientId = parseInt(req.body.recipient_id, 10);
    if (!Number.isInteger(parsedRecipientId) || parsedRecipientId < 1) {
      return res.status(400).json({ error: 'recipient_id is required when ephemeral is true' });
    }
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(webhook.channel_id, parsedRecipientId);
    if (!member) {
      return res.status(400).json({ error: 'recipient_id must be a member of this channel' });
    }
    recipientId = parsedRecipientId;
  }

  // Build replyContext if this is a reply (so the client renders the inline preview)
  let replyContext = null;
  if (replyTo) {
    try {
      const r = db.prepare(`
        SELECT m.id, m.content, m.user_id, m.is_webhook, m.webhook_username, m.imported_from, m.persona_username,
               COALESCE(u.display_name, u.username) AS username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.id = ?
      `).get(replyTo);
      if (r) {
        replyContext = toReplyContext({
          ...r,
          content: (r.content || '').slice(0, 200),
        });
      }
    } catch { /* the inline reply preview is cosmetic; the message still posts without it */ }
  }

  const message = {
    id: null,
    content,
    created_at: new Date().toISOString(),
    username: `[BOT] ${username}`,
    user_id: null,
    avatar: avatarUrl || null,
    avatar_shape: 'square',
    reply_to: replyTo,
    replyContext,
    reactions: [],
    is_webhook: true,
    webhook_name: username,
    ephemeral,
    recipient_id: recipientId,
    thread_id: threadId,
    silent: silent || undefined,
  };

  if (ephemeral) {
    let deliveredSockets = 0;
    if (io) {
      const nsp = io.of('/');
      for (const [, s] of nsp.sockets) {
        if (s.user && s.user.id === recipientId) {
          s.emit('new-message', {
            channelCode: webhook.channel_code,
            message
          });
          deliveredSockets++;
        }
      }
    }
    return res.status(200).json({ success: true, ephemeral: true, recipient_id: recipientId, delivered: deliveredSockets > 0 });
  }

  // Insert non-ephemeral messages into the DB/history.
  const result = db.prepare(
    'INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar, reply_to, thread_id, webhook_id, silent) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)'
  ).run(webhook.channel_id, null, content, username, avatarUrl || null, replyTo, threadId, webhook.id, silent ? 1 : 0);
  message.id = result.lastInsertRowid;

  // Broadcast to all clients in this channel
  if (io && threadId) {
    // A thread reply: the same two events a person's thread reply sends.
    const code = webhook.channel_code;
    io.to(`channel:${code}`).emit('new-thread-message', { channelCode: code, parentId: threadId, message, followerIds: threadNotify.followerIds(db, threadId) });
    const count = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(threadId).count;
    const last = db.prepare('SELECT id, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(threadId);
    const participants = db.prepare(`
      SELECT DISTINCT COALESCE(m.webhook_username, u.display_name, u.username) AS username, COALESCE(m.webhook_avatar, u.avatar) AS avatar
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 5
    `).all(threadId);
    io.to(`channel:${code}`).emit('thread-updated', {
      channelCode: code,
      parentId: threadId,
      thread: {
        count,
        lastReplyAt: last ? last.created_at : null,
        lastReplyId: last ? last.id : null,
        senderId: null,
        participants: participants.map(p => ({ username: p.username, avatar: p.avatar })),
        // A bot's reply is always a comment in a blog-mode forum (#5742).
        ...forumBlogThreadExtras(db, webhook.channel_id, threadId),
      },
    });
  } else if (io) {
    io.to(`channel:${webhook.channel_code}`).emit('new-message', {
      channelCode: webhook.channel_code,
      message
    });
    // Phones, and browsers with push on, are told as for a member's message.
    // Bot posts never pushed, and a browser with push on leaves its pop-ups
    // to the push, so those people heard nothing at all.
    if (socketRuntime?.sendPushNotifications) {
      socketRuntime.sendPushNotifications(webhook.channel_id, webhook.channel_code, webhook.channel_name, 0, username, content,
        { silent, replyToUserId: replyContext?.user_id || undefined });
    }
  }

  res.status(200).json({ success: true, message_id: result.lastInsertRowid, ...(threadId ? { thread_id: threadId } : {}) });
});

// ── Listening presence webhook (any music player) ──
// A reserved path, deliberately kept off the generic /api/webhooks/:token bot
// route (different segment count, so the two never collide). A user generates
// the token from Settings → Activity → Listening; any player's plugin or a
// small script posts presence here (title/artist/album/position/duration +
// optional cover bytes). See docs/listening-api.md for the full contract.
//
// Strict on purpose: this is an unauthenticated-by-header endpoint reachable by
// a user-generated token, and the cover bytes are served back to other users.
const MAX_LISTENING_DURATION = 24 * 60 * 60; // cap seconds so a phony duration can't linger
const listeningLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Rate limit exceeded' } });
// The cover route is viewer-facing (every open profile card fetches it), so it
// gets a looser cap than the single-poster webhook while still bounding abuse.
const listeningCoverLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Rate limit exceeded' } });
const listeningUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024, files: 1, fields: 8, fieldSize: 4096 },
}).single('cover');

app.post('/api/webhooks/listening/:token', listeningLimiter, (req, res) => {
  // Resolve the token before touching the body, so a post to an unknown or
  // malformed token is refused without buffering up to 512KB of upload first.
  const { token } = req.params;
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }
  const row = require('./src/database').getDb()
    .prepare('SELECT user_id FROM listening_tokens WHERE token = ?')
    .get(token);
  if (!row) return res.status(404).json({ error: 'Webhook not found' });

  listeningUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Invalid upload' });

    const engine = activityRef.engine;
    if (!engine) return res.sendStatus(204);

    const b = req.body || {};
    const state = typeof b.state === 'string' ? b.state : '';

    // Stop/expired clears the profile; no track fields needed.
    if (state === 'stopped' || state === 'expired') {
      engine.clearListeningPresence(row.user_id);
      return res.sendStatus(204);
    }

    // Cover is optional, but when present the bytes must be a real image.
    let cover = null, coverType = null;
    if (req.file && req.file.buffer && req.file.buffer.length) {
      coverType = sniffImageType(req.file.buffer);
      if (!coverType) return res.status(400).json({ error: 'Unsupported cover format' });
      cover = req.file.buffer;
    }

    const hasTitle = typeof b.title === 'string' && b.title.trim();
    // An empty body is a reachability ping (or nothing playing); accept it.
    if (!cover && !hasTitle) return res.sendStatus(204);
    if (!hasTitle) return res.status(400).json({ error: 'Title required' });

    // Every track has a duration by definition; reject anything without one and
    // cap it so a track can't schedule a runaway expiry.
    let duration = parseInt(b.duration, 10);
    if (!duration || duration <= 0) return res.status(400).json({ error: 'Duration required' });
    duration = Math.min(duration, MAX_LISTENING_DURATION);

    engine.setListeningPresence(row.user_id, {
      title: b.title,
      artist: typeof b.artist === 'string' ? b.artist : '',
      album: typeof b.album === 'string' ? b.album : '',
      position: parseInt(b.position, 10) || 0,
      duration,
      cover,
      coverType,
      paused: state === 'paused',
      heartbeat: state === 'heartbeat',
      source: typeof b.source === 'string' ? b.source : '',
    });
    return res.sendStatus(204);
  });
});

// Serves a user's current listening cover from memory. The opaque version must
// match, so the URL only works for someone who received the current presence.
app.get('/api/activity/listening-cover/:userId', listeningCoverLimiter, (req, res) => {
  const engine = activityRef.engine;
  const userId = parseInt(req.params.userId, 10);
  const cover = engine && !isNaN(userId) ? engine.getListeningCover(userId) : null;
  if (!cover || req.query.v !== cover.version) return res.sendStatus(404);
  res.setHeader('Content-Type', cover.contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.end(cover.buf);
});

// Voice presence is scoped to the bot's assigned channel, channels its
// creator belongs to, or every non-DM channel when its creator is an admin.
app.get('/api/webhooks/:token/voice/channels', webhookLimiter, (req, res) => {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });
  if (!webhook.can_use_voice) {
    return res.status(403).json({ error: 'This bot does not have voice permission' });
  }

  const { getDb } = require('./src/database');
  const voiceUsers = socketRuntime?.state?.voiceUsers;
  const channels = getAccessibleVoiceChannels(getDb(), webhook)
    .filter(channel => channel.voice_enabled !== 0)
    .map(channel => {
      const room = voiceUsers?.get(channel.code);
      const users = room ? Array.from(room.values()) : [];
      return {
        code: channel.code,
        name: channel.name,
        members: users.filter(user => !user.isBot).length,
        bots: users.filter(user => user.isBot).length
      };
    })
    .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
  res.json({ channels });
});

app.get('/api/bot-audio/:playbackId/:accessToken', botAudioPlaybackLimiter, (req, res) => {
  if (!/^[a-f0-9-]{36}$/i.test(req.params.playbackId) || !/^[a-f0-9]{48}$/i.test(req.params.accessToken)) {
    return res.status(404).end();
  }
  const playable = botAudioManager?.getPlayable(req.params.playbackId, req.params.accessToken);
  if (!playable) return res.status(404).json({ error: 'Audio is unavailable or expired' });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.type(playable.mime);
  return res.sendFile(playable.filePath, err => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).end();
  });
});

app.post(
  '/api/webhooks/:token/audio',
  webhookAudioLimiter,
  requireWebhookVoice,
  uploadDiskGuard,
  (req, res) => {
    let uploadAborted = false;
    const removeUpload = () => {
      const filePath = req.botAudioTempPath;
      if (!filePath) return;
      req.botAudioTempPath = null;
      fs.promises.unlink(filePath).catch(err => {
        if (err?.code !== 'ENOENT') console.error('Failed to clean bot audio upload:', err);
      });
    };
    res.on('close', () => {
      if (!res.writableEnded && req.destroyed) {
        uploadAborted = true;
        removeUpload();
      }
    });

    botAudioUpload.single('audio')(req, res, async uploadError => {
      if (uploadError) {
        removeUpload();
        const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({
          error: tooLarge ? 'Audio must be 10 MB or smaller' : uploadError.message
        });
      }
      if (!req.file) {
        removeUpload();
        return res.status(400).json({ error: 'An audio file is required' });
      }

      req.botAudioTempPath = req.file.path;
      try {
        if (!botAudioManager) throw Object.assign(new Error('Audio service is unavailable'), { status: 503 });
        const requestedCode = typeof req.body?.channel_code === 'string' ? req.body.channel_code.trim() : '';
        if (requestedCode && requestedCode !== req.botVoiceChannelCode) {
          throw Object.assign(new Error('Bot is not connected to the requested voice channel'), { status: 409 });
        }

        const inspected = await inspectAudioFile(req.file.path);

        // Inspection is asynchronous; repeat every authorization and presence
        // check so a revoke, channel move, or voice leave cannot race enqueue.
        const webhook = getWebhookByToken(req.params.token);
        if (!webhook) throw Object.assign(new Error('Invalid bot token'), { status: 401 });
        if (!webhook.can_use_voice) {
          throw Object.assign(new Error('Bot voice permission is required'), { status: 403 });
        }
        const channelCode = resolveCurrentBotVoiceChannel(webhook, req.botVoiceChannelCode);
        if (!channelCode) {
          throw Object.assign(new Error('Bot left or changed voice channels during upload'), { status: 409 });
        }

        const playbackId = crypto.randomUUID();
        const accessToken = crypto.randomBytes(24).toString('hex');
        const finalPath = path.join(BOT_AUDIO_DIR, `${playbackId}${inspected.extension}`);
        await fs.promises.rename(req.file.path, finalPath);
        req.botAudioTempPath = finalPath;

        // Nothing asynchronous may occur between this final check and enqueue.
        // That closes leave/revoke/delete/rotation/abort races during rename.
        if (uploadAborted) throw Object.assign(new Error('Audio upload was aborted'), { status: 400 });
        const finalWebhook = getWebhookByToken(req.params.token);
        if (!finalWebhook) throw Object.assign(new Error('Invalid bot token'), { status: 401 });
        if (!finalWebhook.can_use_voice) {
          throw Object.assign(new Error('Bot voice permission is required'), { status: 403 });
        }
        const finalChannelCode = resolveCurrentBotVoiceChannel(finalWebhook, channelCode);
        if (!finalChannelCode) {
          throw Object.assign(new Error('Bot left or changed voice channels during upload'), { status: 409 });
        }

        const queued = botAudioManager.enqueue({
          playbackId,
          accessToken,
          audioUrl: `/api/bot-audio/${encodeURIComponent(playbackId)}/${accessToken}`,
          webhookId: finalWebhook.id,
          botName: finalWebhook.name,
          channelCode: finalChannelCode,
          filePath: finalPath,
          mime: inspected.mime,
          durationMs: inspected.durationMs
        });
        if (queued.error) throw Object.assign(new Error(queued.error), { status: 409 });

        req.botAudioTempPath = null;
        return res.status(202).json({
          success: true,
          playback_id: playbackId,
          channel_code: finalChannelCode,
          duration_ms: inspected.durationMs,
          position: queued.position,
          queued: queued.queued
        });
      } catch (err) {
        removeUpload();
        return res.status(err.status || 400).json({ error: err.message || 'Audio upload failed' });
      }
    });
  }
);

app.post(
  '/api/webhooks/:token/audio/skip',
  webhookAudioControlLimiter,
  requireWebhookVoice,
  (req, res) => {
    const requestedCode = typeof req.body?.channel_code === 'string' ? req.body.channel_code : '';
    const channelCode = resolveCurrentBotVoiceChannel(req.botWebhook, requestedCode);
    if (!channelCode) return res.status(409).json({ error: 'Bot is not connected to the requested voice channel' });
    const result = botAudioManager?.skip(channelCode, req.botWebhook.id) || { skipped: false };
    return res.json({ success: true, ...result, channel_code: channelCode });
  }
);

app.delete(
  '/api/webhooks/:token/audio/current',
  webhookAudioControlLimiter,
  requireWebhookVoice,
  (req, res) => {
    const requestedCode = typeof req.body?.channel_code === 'string'
      ? req.body.channel_code
      : (typeof req.query.channel_code === 'string' ? req.query.channel_code : '');
    const channelCode = resolveCurrentBotVoiceChannel(req.botWebhook, requestedCode);
    if (!channelCode) return res.status(409).json({ error: 'Bot is not connected to the requested voice channel' });
    const result = botAudioManager?.stop(channelCode, req.botWebhook.id) || { stopped: false, removed: 0 };
    return res.json({ success: true, ...result, channel_code: channelCode });
  }
);

// ── Bot: Delete a message in the webhook's channel ──────
app.delete('/api/webhooks/:token/messages/:messageId', webhookLimiter, async (req, res) => {
  const { getDb } = require('./src/database');
  const db = getDb();
  const { token, messageId } = req.params;

  const webhook = getWebhookByToken(token);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });

  const mid = parseInt(messageId, 10);
  if (!Number.isInteger(mid) || mid < 1) return res.status(400).json({ error: 'Invalid message ID' });

  const msg = db.prepare('SELECT id, content, channel_id, is_webhook, webhook_id FROM messages WHERE id = ? AND channel_id = ?').get(mid, webhook.channel_id);
  if (!msg) return res.status(404).json({ error: 'Message not found in this channel' });
  // A bot deletes its own messages. Anyone else's, people's or another
  // bot's, needs a bot with moderation permission, as the bulk delete below
  // already required.
  if (!webhook.can_moderate && !(msg.is_webhook && msg.webhook_id === webhook.id)) {
    return res.status(403).json({ error: 'This bot can only delete its own messages' });
  }
  // Someone else's message also needs the bot's creator to still hold
  // delete_message here, as for the kick, ban and mute routes.
  const ownMessage = !!msg.is_webhook && msg.webhook_id === webhook.id;
  if (!ownMessage && !botModAuth(webhook, 'delete_message', webhook.channel_id)) {
    return res.status(403).json({ error: BOT_MOD_DENIED });
  }
  const kept = protectedMessages.refusal(db, mid);
  if (kept) return res.status(409).json({ error: kept });

  const replies = db.prepare('SELECT content FROM messages WHERE thread_id = ?').all(mid);
  const botAuthor = ownMessage ? null : db.prepare('SELECT COALESCE(u.display_name, u.username, m.webhook_username) AS name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?').get(mid);
  try {
    db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(mid);
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(mid);
    db.prepare('DELETE FROM messages WHERE id = ?').run(mid);
  } catch (err) {
    console.error('Bot delete message error:', err);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
  if (!ownMessage) {
    const auth = botModAuth(webhook, 'delete_message', webhook.channel_id);
    const chName = db.prepare('SELECT name FROM channels WHERE id = ?').get(webhook.channel_id)?.name || null;
    auditHttp(auth && auth.user, 'message_delete', { target_type: 'message', target_id: mid, target_name: botAuthor ? botAuthor.name : null, details: { channel: chName, via: `bot ${webhook.name}` } });
  }

  // Its files, and its replies' files, go only when nothing else uses them
  // and they were uploaded to a channel. Moving every /uploads/ path the text
  // named let a message that quoted someone's avatar or an emoji take that
  // file away from everyone.
  try {
    await relocateUnreferencedUploads(db, collectUploadRelPaths([msg.content, ...replies.map(r => r.content)]));
  } catch (err) {
    console.error('Bot delete attachment cleanup error:', err);
  }

  // Find channel code for broadcasting
  const channel = db.prepare('SELECT code FROM channels WHERE id = ?').get(webhook.channel_id);
  if (channel && io) {
    io.to(`channel:${channel.code}`).emit('message-deleted', {
      channelCode: channel.code,
      messageId: mid
    });
  }

  res.json({ success: true });
});

// ── Bot: Delete recent messages and their replies ─────────
// Protected messages, and thread heads holding one, are left out.
app.delete('/api/webhooks/:token/messages', webhookLimiter, async (req, res) => {
  const webhook = requireModBot(req, res);
  if (!webhook) return;

  const rawLimit = req.query.limit;
  if (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit)) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
  }

  const { getDb } = require('./src/database');
  const db = getDb();
  const channel = db.prepare('SELECT id, code FROM channels WHERE id = ?').get(webhook.channel_id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  // The creator must still hold delete_message in this channel.
  if (!botModAuth(webhook, 'delete_message', channel.id)) return res.status(403).json({ error: BOT_MOD_DENIED });

  const selectMessages = db.prepare(`
    WITH RECURSIVE
      roots(id) AS (
        SELECT id FROM (
          SELECT id FROM messages
          WHERE channel_id = ? AND thread_id IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        )
      ),
      doomed(id) AS (
        SELECT id FROM roots
        UNION
        SELECT m.id
        FROM messages m
        JOIN doomed d ON m.reply_to = d.id
        UNION
        SELECT m.id
        FROM messages m
        JOIN doomed d ON m.thread_id = d.id
      )
    SELECT m.id, m.channel_id, m.content
    FROM messages m
    JOIN doomed d ON d.id = m.id
    WHERE ${protectedMessages.deletableSql('m')}
    ORDER BY m.id DESC
  `);
  const deletePin = db.prepare('DELETE FROM pinned_messages WHERE message_id = ?');
  const deleteReactions = db.prepare('DELETE FROM reactions WHERE message_id = ?');
  const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ? AND channel_id = ?');
  const purge = db.transaction(() => {
    const messages = selectMessages.all(channel.id, limit);
    if (messages.some(message => message.channel_id !== channel.id)) {
      const error = new Error('Related replies exist in another channel');
      error.statusCode = 409;
      throw error;
    }
    for (const message of messages) {
      deletePin.run(message.id);
      deleteReactions.run(message.id);
    }
    for (const message of messages) deleteMessage.run(message.id, channel.id);
    return messages;
  });

  let deletedMessages;
  try {
    deletedMessages = purge();
  } catch (err) {
    console.error('Bot bulk delete messages error:', err);
    const status = err?.statusCode === 409 ? 409 : 500;
    const error = status === 409 ? err.message : 'Failed to delete messages';
    return res.status(status).json({ error });
  }
  if (deletedMessages.length) {
    const auth = botModAuth(webhook, 'delete_message', channel.id);
    const chName = db.prepare('SELECT name FROM channels WHERE id = ?').get(channel.id)?.name || null;
    auditHttp(auth && auth.user, 'messages_bulk_delete', { target_type: 'channel', target_id: channel.id, target_name: chName, details: { count: deletedMessages.length, via: `bot ${webhook.name}` } });
  }

  try {
    await relocateUnreferencedUploads(
      db,
      collectUploadRelPaths(deletedMessages.map(message => message.content))
    );
  } catch (err) {
    console.error('Bot bulk delete attachment cleanup error:', err);
  }

  if (io) {
    for (const message of deletedMessages) {
      io.to(`channel:${channel.code}`).emit('message-deleted', {
        channelCode: channel.code,
        messageId: message.id
      });
    }
  }

  return res.json({ success: true, deleted: deletedMessages.length });
});

// ── Bot: Play a soundboard sound in the webhook's channel ──
app.post('/api/webhooks/:token/sounds', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });

  const soundName = typeof req.body.sound === 'string' ? req.body.sound.trim() : '';
  if (!soundName) return res.status(400).json({ error: 'sound name required' });

  // Verify the sound exists
  const { getDb } = require('./src/database');
  const builtin = BUILTIN_SOUNDS.find(s => s.name === soundName);
  let soundUrl;
  if (builtin) {
    soundUrl = builtin.url;
  } else {
    const custom = getDb().prepare('SELECT filename FROM custom_sounds WHERE name = ?').get(soundName);
    if (!custom) return res.status(404).json({ error: 'Sound not found' });
    soundUrl = `/uploads/${custom.filename}`;
  }

  // Find the channel code and broadcast the sound event
  const channel = getDb().prepare('SELECT code FROM channels WHERE id = ?').get(webhook.channel_id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  if (io) {
    io.to(`channel:${channel.code}`).emit('play-sound', {
      channelCode: channel.code,
      soundUrl,
      soundName,
      botName: webhook.name
    });
  }

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// MODERATION REST API
// ═══════════════════════════════════════════════════════════
const modLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Rate limit exceeded' } });

// Helper: get authenticated user from Bearer token with admin/mod check
// Moderation over HTTP follows the rules the app follows: the permission
// must be held server-wide (a role held in one channel does not count; the
// helper above counts it), the caller must not be banned, and the target must
// rank below the caller. These routes skipped the rank checks, so a Mod, or
// anyone who had created a channel, could mute or kick an admin.
function getModUser(req, permission) {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return { error: 'Unauthorized', status: 401 };
  const { getDb } = require('./src/database');
  if (getDb().prepare('SELECT 1 FROM bans WHERE user_id = ?').get(user.id)) {
    return { error: 'Insufficient permissions', status: 403 };
  }
  const isAdmin = verifyAdminFromDb(user);
  if (!isAdmin && !(socketRuntime && socketRuntime.userHasPermission(user.id, permission))) {
    return { error: 'Insufficient permissions', status: 403 };
  }
  return { user, isAdmin };
}

function modOutranks(auth, targetId) {
  if (!auth || !auth.user || targetId === auth.user.id) return false;
  const { getDb } = require('./src/database');
  const target = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(targetId);
  if (target && target.is_admin) return false;
  if (auth.isAdmin) return true;
  if (!socketRuntime) return false;
  return socketRuntime.getUserEffectiveLevel(targetId) < socketRuntime.getUserEffectiveLevel(auth.user.id);
}

// Undoing a ban or mute: an admin's stands, as does one placed by someone of
// equal or higher rank.
function modMayUndo(auth, placedBy) {
  if (!auth || !auth.user) return false;
  if (auth.isAdmin || !placedBy || placedBy === auth.user.id) return true;
  const { getDb } = require('./src/database');
  const placer = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(placedBy);
  if (placer && placer.is_admin) return false;
  if (!socketRuntime) return false;
  return socketRuntime.getUserEffectiveLevel(placedBy) < socketRuntime.getUserEffectiveLevel(auth.user.id);
}

// POST /api/moderation/kick
app.post('/api/moderation/kick', modLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const auth = getModUser(req, 'kick_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId, channelCode, reason } = req.body;
  if (!userId || !Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });
  if (!channelCode || typeof channelCode !== 'string') return res.status(400).json({ error: 'channelCode required' });

  const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(channelCode);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const target = db.prepare('SELECT id, COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!modOutranks(auth, userId)) return res.status(403).json({ error: 'You can only kick people ranked below you' });
  httpModAudit(auth, 'user_kick', userId, target.username, { channel: channelCode });

  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channel.id, userId);

  if (io) {
    const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('kicked', { channelCode, reason: safeReason });
        s.leave(`channel:${channelCode}`);
      }
    }
  }
  socketRuntime?.rotatePrivateCodesAfterRemoval?.(channel.id);

  res.json({ success: true, message: `Kicked ${target.username}` });
});

// POST /api/moderation/ban
app.post('/api/moderation/ban', modLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const auth = getModUser(req, 'ban_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId, reason } = req.body;
  if (!userId || !Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });

  const target = db.prepare('SELECT id, COALESCE(display_name, username) as username, is_admin FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.is_admin) return res.status(403).json({ error: 'Cannot ban an admin' });
  if (!modOutranks(auth, userId)) return res.status(403).json({ error: 'You can only ban people ranked below you' });
  // Banning again takes over the ban, and with it who may lift it.
  const priorBan = db.prepare('SELECT banned_by FROM bans WHERE user_id = ?').get(userId);
  if (priorBan && !modMayUndo(auth, priorBan.banned_by)) return res.status(403).json({ error: 'That ban was placed by an admin or by someone of equal or higher rank' });

  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  httpModAudit(auth, 'user_ban', userId, target.username, { reason: safeReason });

  try {
    db.prepare('INSERT OR REPLACE INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)').run(userId, auth.user.id, safeReason);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to ban user' });
  }

  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('banned', { reason: safeReason });
        s.disconnect(true);
      }
    }
  }

  res.json({ success: true, message: `Banned ${target.username}` });
});

// POST /api/moderation/unban
app.post('/api/moderation/unban', modLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const auth = getModUser(req, 'ban_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId } = req.body;
  if (!userId || !Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });
  const existingBan = db.prepare('SELECT banned_by FROM bans WHERE user_id = ?').get(userId);
  if (existingBan && !modMayUndo(auth, existingBan.banned_by)) {
    return res.status(403).json({ error: 'You can\'t undo a ban placed by an admin or by someone of equal or higher rank' });
  }

  db.prepare('DELETE FROM bans WHERE user_id = ?').run(userId);
  const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
  if (existingBan) httpModAudit(auth, 'user_unban', userId, target ? target.username : null, null);
  res.json({ success: true, message: `Unbanned ${target ? target.username : 'user'}` });
});

// POST /api/moderation/mute
app.post('/api/moderation/mute', modLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const auth = getModUser(req, 'mute_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId, duration, reason } = req.body;
  if (!userId || !Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });

  const target = db.prepare('SELECT id, COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!modOutranks(auth, userId)) return res.status(403).json({ error: 'You can only mute people ranked below you' });
  // A new timeout replaces the old one, and with it who may lift it.
  for (const { muted_by: by } of db.prepare("SELECT DISTINCT muted_by FROM mutes WHERE user_id = ? AND expires_at > datetime('now')").all(userId)) {
    if (!modMayUndo(auth, by)) return res.status(403).json({ error: 'That timeout was given by an admin or by someone of equal or higher rank' });
  }
  httpModAudit(auth, 'user_mute', userId, target.username, { duration });

  // Same ceiling as the app: 30 days.
  const durationMs = Number.isInteger(duration) && duration > 0 ? Math.min(duration, 43200) * 60 * 1000 : 10 * 60 * 1000;
  // SQLite's own time format, which every mute check compares against.
  const expiresAt = new Date(Date.now() + durationMs).toISOString().slice(0, 19).replace('T', ' ');
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';

  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO mutes (user_id, muted_by, reason, expires_at) VALUES (?, ?, ?, ?)').run(userId, auth.user.id, safeReason, expiresAt);

  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('muted', { duration: Math.round(durationMs / 60000), reason: safeReason, expiresAt });
      }
    }
  }

  res.json({ success: true, message: `Muted ${target.username} until ${expiresAt}` });
});

// POST /api/moderation/unmute
app.post('/api/moderation/unmute', modLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const auth = getModUser(req, 'mute_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId } = req.body;
  if (!userId || !Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });
  if (!auth.isAdmin && userId === auth.user.id) return res.status(403).json({ error: 'You can\'t unmute yourself' });
  for (const { muted_by: by } of db.prepare("SELECT DISTINCT muted_by FROM mutes WHERE user_id = ? AND expires_at > datetime('now')").all(userId)) {
    if (!modMayUndo(auth, by)) return res.status(403).json({ error: 'You can\'t undo a mute placed by an admin or by someone of equal or higher rank' });
  }

  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
  const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
  httpModAudit(auth, 'user_unmute', userId, target ? target.username : null, null);
  res.json({ success: true, message: `Unmuted ${target ? target.username : 'user'}` });
});

// GET /api/moderation/bans: list all bans
app.get('/api/moderation/bans', modLimiter, (req, res) => {
  const auth = getModUser(req, 'ban_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const bans = getDb().prepare(`
    SELECT b.id, b.user_id, COALESCE(u.display_name, u.username) as username, b.reason, b.created_at
    FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
  `).all();
  res.json({ bans });
});

// GET /api/moderation/mutes: list active mutes
app.get('/api/moderation/mutes', modLimiter, (req, res) => {
  const auth = getModUser(req, 'mute_user');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { getDb } = require('./src/database');
  const mutes = getDb().prepare(`
    SELECT m.id, m.user_id, COALESCE(u.display_name, u.username) as username, m.reason, m.expires_at, m.created_at
    FROM mutes m JOIN users u ON m.user_id = u.id WHERE m.expires_at > datetime('now') ORDER BY m.created_at DESC
  `).all();
  res.json({ mutes });
});
const automod = require('./src/routes/automodRelay')({ app, getModUser, verifyToken, rateLimit });


// ═══════════════════════════════════════════════════════════
// BOT SLASH COMMANDS API
// ═══════════════════════════════════════════════════════════

// Helper: authenticate webhook bot by token
function getWebhookByToken(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const { getDb } = require('./src/database');
  return getDb().prepare(`
    SELECT w.id, w.name, w.channel_id, w.callback_url, w.can_moderate,
           w.can_use_voice, w.created_by, c.code AS channel_code
    FROM webhooks w
    LEFT JOIN channels c ON c.id = w.channel_id
    WHERE w.token = ? AND w.is_active = 1 AND COALESCE(c.is_dm, 0) = 0
      AND ${CREATOR_NOT_BANNED_SQL}
  `).get(token);
}

function getBotCurrentVoiceChannel(webhookId) {
  if (!socketRuntime) return null;
  const botUserId = -Number(webhookId);
  for (const [channelCode, users] of socketRuntime.state.voiceUsers) {
    const presence = users.get(botUserId);
    if (!presence?.isBot || !presence.socketId) continue;
    const socket = io.sockets.sockets.get(presence.socketId);
    if (
      socket?.connected &&
      socket.user?.isBot &&
      Number(socket.user.webhookId) === Number(webhookId)
    ) {
      return channelCode;
    }
  }
  return null;
}

function resolveCurrentBotVoiceChannel(webhook, requestedCode) {
  const currentCode = getBotCurrentVoiceChannel(webhook.id);
  if (!currentCode) return null;
  const expectedCode = typeof requestedCode === 'string' && requestedCode.trim()
    ? requestedCode.trim()
    : currentCode;
  if (expectedCode !== currentCode) return null;
  const channel = canAccessVoiceChannel(db, webhook, currentCode);
  if (!channel || channel.voice_enabled === 0) return null;
  return currentCode;
}

function requireWebhookVoice(req, res, next) {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) return res.status(401).json({ error: 'Invalid bot token' });
  if (!webhook.can_use_voice) return res.status(403).json({ error: 'Bot voice permission is required' });
  const channelCode = resolveCurrentBotVoiceChannel(webhook);
  if (!channelCode) {
    return res.status(409).json({ error: 'Bot must be connected to an accessible voice channel' });
  }
  req.botWebhook = webhook;
  req.botVoiceChannelCode = channelCode;
  return next();
}

// ═══════════════════════════════════════════════════════════
// BOT MODERATION REST API (#5397): webhook-token authenticated.
// Each endpoint requires the bot's `can_moderate` flag to be enabled
// by an admin via the Bot Manager. Mirrors /api/moderation/* but uses
// webhook tokens instead of JWT bearer tokens so bots don't need a
// user login. Audit log records the bot as actor.
// ═══════════════════════════════════════════════════════════
function requireModBot(req, res) {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) { res.status(404).json({ error: 'Webhook not found or inactive' }); return null; }
  if (!webhook.can_moderate) { res.status(403).json({ error: 'This bot does not have moderation permission' }); return null; }
  return webhook;
}
// A moderation bot acts with the rank of the person who made it, so it can
// do no more than they could themselves: nobody at or above them, and no
// undoing an admin's or a higher-ranked moderator's ban or mute. A bot with
// no creator on record acts with no rank at all.
// It also needs the creator to hold, today, the permission the route uses:
// a bot keeps no power its maker has since lost.
const BOT_MOD_DENIED = 'The person who made this bot no longer has this moderation permission';
function botModAuth(webhook, permission, channelId = null) {
  if (!webhook || !webhook.created_by || !permission) return null;
  const { getDb } = require('./src/database');
  const creator = getDb().prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(webhook.created_by);
  if (!creator) return null;
  if (!creator.is_admin && !(socketRuntime && socketRuntime.userHasPermission(creator.id, permission, channelId))) return null;
  return { user: { id: creator.id, username: creator.username, displayName: creator.display_name || creator.username }, isAdmin: !!creator.is_admin, bot: webhook };
}
function httpModAudit(auth, action, targetId, targetName, details) {
  try {
    socketRuntime?.logAudit?.({
      actor: { id: auth.user.id, username: auth.user.username, displayName: auth.user.displayName || auth.user.username },
      action, target_type: 'user', target_id: targetId, target_name: targetName || null,
      details: { ...(details || {}), via: auth.bot ? `bot ${auth.bot.name}` : 'api' },
    });
  } catch (err) { console.warn('[audit] HTTP moderation entry failed:', err.message); }
}

// POST /api/webhooks/:token/moderation/kick
app.post('/api/webhooks/:token/moderation/kick', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = requireModBot(req, res); if (!webhook) return;
  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId, channelCode, reason } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });
  if (!channelCode || typeof channelCode !== 'string') return res.status(400).json({ error: 'channelCode required' });

  // Only from the bot's own channel.
  const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND id = ? AND is_dm = 0').get(channelCode, webhook.channel_id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const target = db.prepare('SELECT id, COALESCE(display_name, username) as username, is_admin FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.is_admin) return res.status(403).json({ error: 'Cannot kick an admin' });
  const botAuth = botModAuth(webhook, 'kick_user', channel.id);
  if (!botAuth) return res.status(403).json({ error: BOT_MOD_DENIED });
  if (!modOutranks(botAuth, userId)) return res.status(403).json({ error: 'This bot can only act on people ranked below the person who made it' });
  httpModAudit(botAuth, 'user_kick', userId, target.username, { channel: channelCode });

  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channel.id, userId);

  if (io) {
    const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('kicked', { channelCode, reason: safeReason });
        s.leave(`channel:${channelCode}`);
      }
    }
  }
  socketRuntime?.rotatePrivateCodesAfterRemoval?.(channel.id);
  res.json({ success: true, message: `Kicked ${target.username}` });
});

// POST /api/webhooks/:token/moderation/ban
app.post('/api/webhooks/:token/moderation/ban', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = requireModBot(req, res); if (!webhook) return;
  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId, reason } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });

  const target = db.prepare('SELECT id, COALESCE(display_name, username) as username, is_admin FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.is_admin) return res.status(403).json({ error: 'Cannot ban an admin' });
  const botAuth = botModAuth(webhook, 'ban_user');
  if (!botAuth) return res.status(403).json({ error: BOT_MOD_DENIED });
  if (!modOutranks(botAuth, userId)) return res.status(403).json({ error: 'This bot can only act on people ranked below the person who made it' });
  const priorBan = db.prepare('SELECT banned_by FROM bans WHERE user_id = ?').get(userId);
  if (priorBan && !modMayUndo(botAuth, priorBan.banned_by)) return res.status(403).json({ error: 'That ban was placed by someone of equal or higher rank' });

  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  httpModAudit(botAuth, 'user_ban', userId, target.username, { reason: safeReason });
  try {
    db.prepare('INSERT OR REPLACE INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)').run(userId, webhook.created_by || null, safeReason);
  } catch {
    return res.status(500).json({ error: 'Failed to ban user' });
  }

  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) { s.emit('banned', { reason: safeReason }); s.disconnect(true); }
    }
  }
  res.json({ success: true, message: `Banned ${target.username}` });
});

// POST /api/webhooks/:token/moderation/unban
app.post('/api/webhooks/:token/moderation/unban', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = requireModBot(req, res); if (!webhook) return;
  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });
  const botAuth = botModAuth(webhook, 'ban_user');
  if (!botAuth) return res.status(403).json({ error: BOT_MOD_DENIED });
  const existingBan = db.prepare('SELECT banned_by FROM bans WHERE user_id = ?').get(userId);
  if (existingBan && !modMayUndo(botAuth, existingBan.banned_by)) {
    return res.status(403).json({ error: 'You can\'t undo a ban placed by an admin or by someone of equal or higher rank' });
  }
  if (existingBan) httpModAudit(botAuth, 'user_unban', userId, null, null);

  db.prepare('DELETE FROM bans WHERE user_id = ?').run(userId);
  const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
  res.json({ success: true, message: `Unbanned ${target ? target.username : 'user'}` });
});

// POST /api/webhooks/:token/moderation/mute, body: { userId, duration (minutes), reason }
app.post('/api/webhooks/:token/moderation/mute', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = requireModBot(req, res); if (!webhook) return;
  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId, duration, reason } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });

  const target = db.prepare('SELECT id, COALESCE(display_name, username) as username, is_admin FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.is_admin) return res.status(403).json({ error: 'Cannot mute an admin' });
  const botAuth = botModAuth(webhook, 'mute_user');
  if (!botAuth) return res.status(403).json({ error: BOT_MOD_DENIED });
  if (!modOutranks(botAuth, userId)) return res.status(403).json({ error: 'This bot can only act on people ranked below the person who made it' });
  for (const { muted_by: by } of db.prepare("SELECT DISTINCT muted_by FROM mutes WHERE user_id = ? AND expires_at > datetime('now')").all(userId)) {
    if (!modMayUndo(botAuth, by)) return res.status(403).json({ error: 'That timeout was given by someone of equal or higher rank' });
  }
  httpModAudit(botAuth, 'user_mute', userId, target.username, { duration });

  // Same ceiling as the app: 30 days.
  const durationMs = Number.isInteger(duration) && duration > 0 ? Math.min(duration, 43200) * 60 * 1000 : 10 * 60 * 1000;
  // SQLite's own time format, which every mute check compares against.
  const expiresAt = new Date(Date.now() + durationMs).toISOString().slice(0, 19).replace('T', ' ');
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';

  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO mutes (user_id, muted_by, reason, expires_at) VALUES (?, ?, ?, ?)').run(userId, webhook.created_by || null, safeReason, expiresAt);

  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) s.emit('muted', { reason: safeReason, expiresAt });
    }
  }
  res.json({ success: true, message: `Muted ${target.username} until ${expiresAt}` });
});

// POST /api/webhooks/:token/moderation/unmute
app.post('/api/webhooks/:token/moderation/unmute', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = requireModBot(req, res); if (!webhook) return;
  const { getDb } = require('./src/database');
  const db = getDb();
  const { userId } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required (integer)' });
  const botAuth = botModAuth(webhook, 'mute_user');
  if (!botAuth) return res.status(403).json({ error: BOT_MOD_DENIED });
  for (const { muted_by: by } of db.prepare("SELECT DISTINCT muted_by FROM mutes WHERE user_id = ? AND expires_at > datetime('now')").all(userId)) {
    if (!modMayUndo(botAuth, by)) return res.status(403).json({ error: 'You can\'t undo a timeout given by an admin or by someone of equal or higher rank' });
  }
  httpModAudit(botAuth, 'user_unmute', userId, null, null);

  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
  const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
  res.json({ success: true, message: `Unmuted ${target ? target.username : 'user'}` });
});

// GET /api/webhooks/:token/commands: list registered commands
app.get('/api/webhooks/:token/commands', webhookLimiter, (req, res) => {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });

  const { getDb } = require('./src/database');
  const rows = getDb().prepare('SELECT id, command, description, subcommands_json FROM bot_commands WHERE webhook_id = ?').all(webhook.id);
  const commands = rows.map(r => {
    let subcommands = [];
    if (r.subcommands_json) {
      try {
        const parsed = JSON.parse(r.subcommands_json);
        if (Array.isArray(parsed)) subcommands = parsed;
      } catch { /* ignore malformed historic values */ }
    }
    return {
      id: r.id,
      command: r.command,
      description: r.description,
      subcommands
    };
  });
  res.json({ commands });
});

// POST /api/webhooks/:token/commands: register a command
app.post('/api/webhooks/:token/commands', webhookLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });
  if (!webhook.callback_url) return res.status(400).json({ error: 'Webhook must have a callback_url to register commands' });

  const { command, description, subcommands } = req.body;
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command required (string)' });

  const cmd = command.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  if (!cmd) return res.status(400).json({ error: 'Invalid command name' });

  // Reject built-in command names
  const builtIn = ['shrug','tableflip','unflip','lenny','disapprove','bbs','boobs','butt','brb','afk','me','spoiler','tts','flip','roll','hug','wave','play','gif','poll'];
  if (builtIn.includes(cmd)) return res.status(409).json({ error: `/${cmd} is a built-in command` });

  const desc = typeof description === 'string' ? description.trim().slice(0, 100) : '';
  let cleanSubs = [];
  if (Array.isArray(subcommands)) {
    if (subcommands.length > 25) {
      return res.status(400).json({ error: 'subcommands can contain at most 25 items' });
    }
    cleanSubs = subcommands
      .map(sc => {
        if (!sc || typeof sc !== 'object') return null;
        const name = String(sc.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
        if (!name) return null;
        const description = typeof sc.description === 'string' ? sc.description.trim().slice(0, 100) : '';
        return { name, description };
      })
      .filter(Boolean);
    const seen = new Set();
    cleanSubs = cleanSubs.filter(sc => {
      if (seen.has(sc.name)) return false;
      seen.add(sc.name);
      return true;
    });
  }
  const subcommandsJson = cleanSubs.length ? JSON.stringify(cleanSubs) : null;

  const { getDb } = require('./src/database');
  try {
    getDb().prepare('INSERT OR REPLACE INTO bot_commands (webhook_id, command, description, subcommands_json) VALUES (?, ?, ?, ?)').run(webhook.id, cmd, desc, subcommandsJson);
    res.json({ success: true, command: cmd, description: desc, subcommands: cleanSubs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register command' });
  }
});

// DELETE /api/webhooks/:token/commands/:command: unregister a command
app.delete('/api/webhooks/:token/commands/:command', webhookLimiter, (req, res) => {
  const webhook = getWebhookByToken(req.params.token);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });

  const cmd = (req.params.command || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cmd) return res.status(400).json({ error: 'Invalid command name' });

  const { getDb } = require('./src/database');
  const result = getDb().prepare('DELETE FROM bot_commands WHERE webhook_id = ? AND command = ?').run(webhook.id, cmd);
  if (result.changes === 0) return res.status(404).json({ error: 'Command not found' });
  res.json({ success: true });
});

// GET /api/bot-commands: list all registered bot commands (for client autocomplete)
// Signed in only, and only bots in channels the caller can see: open to
// anyone, it listed the invite code of every channel with a bot command.
app.get('/api/bot-commands', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { getDb } = require('./src/database');
  const isAdmin = verifyAdminFromDb(user);
  const rows = getDb().prepare(`
    SELECT bc.command, bc.description, bc.subcommands_json, w.name as bot_name, c.code as channel_code, c.id AS channel_id, c.role_gate
    FROM bot_commands bc
    JOIN webhooks w ON bc.webhook_id = w.id
    JOIN channels c ON c.id = w.channel_id
    JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
    WHERE w.is_active = 1 AND ${CREATOR_NOT_BANNED_SQL}
  `).all(user.id).filter(r => isAdmin || !socketRuntime || socketRuntime.roleGateAllows(user.id, { id: r.channel_id, role_gate: r.role_gate }));
  const commands = [];
  for (const row of rows) {
    let subcommands = [];
    if (row.subcommands_json) {
      try {
        const parsed = JSON.parse(row.subcommands_json);
        if (Array.isArray(parsed)) subcommands = parsed;
      } catch { /* ignore malformed historic values */ }
    }
    if (subcommands.length) {
      for (const sc of subcommands) {
        const subName = String(sc?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
        if (!subName) continue;
        commands.push({
          command: `${row.command} ${subName}`,
          description: typeof sc.description === 'string' && sc.description.trim()
            ? sc.description.trim()
            : (row.description || 'Bot command'),
          bot_name: row.bot_name || 'Bot',
          channel_code: row.channel_code || null
        });
      }
      continue;
    }
    commands.push({
      command: row.command,
      description: row.description || '',
      bot_name: row.bot_name || 'Bot',
      channel_code: row.channel_code || null
    });
  }
  res.json({ commands });
});

// ═══════════════════════════════════════════════════════════
// DISCORD IMPORT: upload, preview, execute
// ═══════════════════════════════════════════════════════════
const os = require('os');

// Multer instance for import uploads (ZIP/JSON up to 500 MB)
const importUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `haven-import-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024, fields: 20, fieldSize: 16 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.json' || ext === '.zip') cb(null, true);
    else cb(new Error('Only .json and .zip files are accepted'));
  }
});

// ── Discord import: src/routes/import.js ──
require('./src/routes/import')({ uploadDiskGuard, app, verifyAdminFromDb, uploadLimiter, importUpload });

// ── Server templates: src/routes/serverTemplate.js ──
require('./src/routes/serverTemplate')({ app, verifyAdminFromDb, uploadLimiter, uploadDiskGuard, THEMES_DIR, late });

// Create HTTP or HTTPS server
let server;
// sslCert, sslKey, forceHttp and useSSL are resolved up with the security
// headers, which have to know whether this process serves TLS.

if (forceHttp) {
  console.log('⚡ FORCE_HTTP=true, running plain HTTP (reverse proxy mode)');
}

if (useSSL) {
  try {
    const sslOptions = {
      cert: fs.readFileSync(sslCert),
      key: fs.readFileSync(sslKey)
    };
    server = createHttpsServer(sslOptions, app);
    console.log('🔒 HTTPS enabled');
    try {
      const { inspectCertChain, certAdvice } = require('./src/certCheck');
      const status = inspectCertChain(sslOptions.cert);
      tlsIssue = status.issue;
      const advice = certAdvice(status, sslCert);
      if (advice) console.warn(`⚠️  TLS certificate problem: ${advice}`);
    } catch (err) {
      console.warn('⚠️  Could not check the TLS certificate chain:', err.message);
    }

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
    // Only redirect to our own host (prevent open redirect)
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
    // The redirect listener is a nicety: if its port is taken (or
    // binding it needs elevation), warn and carry on with HTTPS alone
    // rather than letting the bind error become an uncaught exception.
    httpRedirectServer.on('error', (err) => {
      console.warn(`⚠️  HTTP→HTTPS redirect server could not bind port ${HTTP_REDIRECT_PORT} (${(err && err.code) || err}). HTTPS continues on port ${safePort}.`);
    });
    httpRedirectServer.listen(HTTP_REDIRECT_PORT, process.env.HOST || '0.0.0.0', () => {
      console.log(`↪️  HTTP redirect running on port ${HTTP_REDIRECT_PORT} → HTTPS`);
    });
  } catch (err) {
    console.error('Failed to load SSL certs, falling back to HTTP:', err.message);
    if (err.code === 'EACCES') console.error(`   Haven cannot read ${err.path || 'the certificate files'} as this user. Certbot keeps /etc/letsencrypt/live and /etc/letsencrypt/archive readable by root only: copy fullchain.pem and privkey.pem somewhere Haven can read (a certbot deploy hook keeps them fresh), or grant this user read access.`);
    server = createServer(app);
  }
} else {
  server = createServer(app);
  console.log('⚠️  Running HTTP: voice chat requires HTTPS for remote connections');
}

// Socket.IO: locked down
const io = new Server(server, {
  cors: {
    origin: false,         // same-origin only, no cross-site connections
  },
  maxHttpBufferSize: 64 * 1024,  // 64KB max per message (was 1MB)
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 10000,
});

// Initialize
const db = await initDatabaseAsync();
const postgresPreview = db.kind === 'postgres';

// (#5335) Seed starter stickers now that the DB is ready.

// Download / refresh the Unicode emoji list (non-blocking, best-effort).
// Opt-in: off unless the admin enables it or UNICODE_EMOJI_AUTO_UPDATE forces it.
{
  const emoji = require('./src/emoji');
  const row = await db.async.prepare("SELECT value FROM server_settings WHERE key = 'unicode_emoji_auto_update'").get();
  emoji.ensureEmojiData(emoji.autoUpdateEnabled(row?.value));
}

// Load the admin-configured Referrer-Policy into the in-memory cache.
try {
  const rp = (await db.async.prepare("SELECT value FROM server_settings WHERE key = 'referrer_policy'").get())?.value;
  if (rp && VALID_REFERRER_POLICIES.includes(rp)) currentReferrerPolicy = rp;
} catch (err) {
  console.warn(`[security] Could not load the saved Referrer-Policy, using ${DEFAULT_REFERRER_POLICY}:`, err.message);
}

if (postgresPreview) {
  console.log('[db] PostgreSQL browser preview: signup, login and public-room browsing are enabled; unsupported actions and background integrations are disabled.');
  await _refreshIpBanCache();
  app.set('io', io);
  setFcmAdminEnabled(false);
  socketRuntime = require('./src/socketHandlers/postgresPreview').setupPostgresPreview(io, db, { isIpBanned });
} else {
// ── Admin password reset (one-time, from .env) ───────────
// Set ADMIN_RESET_PASSWORD in .env, restart, and it resets the admin's password.
// The variable is removed from .env automatically after use.
if (process.env.ADMIN_RESET_PASSWORD) {
  const bcryptSync = require('bcryptjs');
  const adminName = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const adminUser = db.prepare('SELECT id, username FROM users WHERE LOWER(username) = ?').get(adminName);
  if (adminUser) {
    const newHash = bcryptSync.hashSync(process.env.ADMIN_RESET_PASSWORD, 12);
    const newPwv = (db.prepare('SELECT password_version FROM users WHERE id = ?').get(adminUser.id)?.password_version || 1) + 1;
    db.prepare('UPDATE users SET password_hash = ?, password_version = ?, is_admin = 1 WHERE id = ?').run(newHash, newPwv, adminUser.id);
    db.prepare('DELETE FROM bans WHERE user_id = ?').run(adminUser.id);
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(adminUser.id);
    console.log(`🔑 Admin password reset for "${adminUser.username}" via ADMIN_RESET_PASSWORD`);
    // Remove the variable from .env so it doesn't re-run on next restart
    try {
      let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
      envContent = envContent.replace(/^ADMIN_RESET_PASSWORD=.*$/m, '').replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(ENV_PATH, envContent);
      console.log('   Removed ADMIN_RESET_PASSWORD from .env (one-time use)');
    } catch (err) {
      // Left in place it would reset the admin password again on every restart.
      console.error(`   Could not remove ADMIN_RESET_PASSWORD from ${ENV_PATH}; delete that line by hand:`, err.message);
    }
  } else {
    console.warn(`⚠️  ADMIN_RESET_PASSWORD set but no user "${adminName}" found, skipping`);
  }
  delete process.env.ADMIN_RESET_PASSWORD;
}

// Load the admin FCM toggle (Settings → Security → FCM Privacy) into memory
// before initFcm, so both the startup log line and isFcmEnabled() reflect it
// without a per-message database read. Default on.
try {
  const fe = db.prepare("SELECT value FROM server_settings WHERE key = 'fcm_enabled'").get()?.value;
  setFcmAdminEnabled(fe !== 'false');
} catch (err) {
  // Fail closed: if the admin turned FCM off for privacy, an unreadable
  // setting must not quietly turn it back on.
  setFcmAdminEnabled(false);
  console.error('[fcm] Could not read the FCM Privacy setting, leaving FCM off:', err.message);
}
initFcm(DATA_DIR);
// Clean photos and videos uploaded before the privacy pass existed.
privacyPass.start(db);
// How far a video's cleaning has got, for the uploader's progress bar.
privacyPass.setProgressEmitter((req, percent) => {
  const uploadId = String(req.headers['x-upload-id'] || '').slice(0, 64);
  const user = uploadId && verifyToken(req.headers.authorization?.split(' ')[1] || '');
  if (!user) return;
  for (const [, s] of io.sockets.sockets) if (s.user?.id === user.id) s.emit('upload-processing', { uploadId, percent });
});
app.set('io', io);   // expose to auth routes (session invalidation on password change)
botAudioManager = new BotAudioManager(io, BOT_AUDIO_DIR);
socketRuntime = setupSocketHandlers(io, db, {
  invalidateIpBanCache,
  // Share the cached ban matcher so the socket gate and the HTTP gate agree
  // on both normalization and CIDR handling, and the socket path stops
  // querying SQLite on every single connection. (v3.42.0)
  isIpBanned,
  // Per-member upload totals for the All Members list. Lives here because the
  // uploads directory and the walk that reads it are the HTTP layer's. (#5521)
  getUploadUsage,
  botAudioManager,
  // Keep the Referrer-Policy cache in sync when an admin changes it.
  onReferrerPolicyChange: (v) => { if (VALID_REFERRER_POLICIES.includes(v)) currentReferrerPolicy = v; }
});
activityRef.engine = socketRuntime.activity;
automod.attachSweep(io);
require('./src/httpAudit').setAuditSink(socketRuntime.logAudit);
require('./src/selfDestruct').start({ db, io, UPLOAD_PATH_RE, moveUploadToDeleted: storage.softDelete, removeUpload: storage.remove });

// ── Ferry: Haven <-> Discord bridge ─────────────────────
// Started after the socket layer so an inbound Discord message always has a
// live io to broadcast on. Inserting the message is done here rather than
// inside ferry.js so the bridge reuses the exact same row shape and event
// payload as the existing bot webhook endpoint above, and Discord messages
// render in every client with no client-side changes at all.
initFerry({
  db,
  io,
  sanitizeText,
  // A Discord forum post arrives through here too, with a title and tags, and
  // becomes a forum topic.
  insertHavenMessage: ({ channelId, channelCode, username, avatarUrl, content, title = null, tags = null, discordMessageId = null, replyTo = null }) => {
    // Topic titles get the same clean-up as titles typed in Haven.
    title = typeof title === 'string' && title ? (sanitizeText(title) || null) : null;
    // The Discord id is kept (#5773), so importing the same history later
    // skips what Ferry already brought over instead of adding it twice.
    const discordId = /^\d{5,25}$/.test(String(discordMessageId || '')) ? String(discordMessageId) : null;
    if (discordId) {
      const already = db.prepare('SELECT id FROM messages WHERE channel_id = ? AND discord_message_id = ?').get(channelId, discordId);
      if (already) return already.id;
    }
    try {
      const tagList = Array.isArray(tags) && tags.length ? tags : null;
      // A Discord reply to a message Ferry carried answers that message here
      // too (src/ferryReplies.js), in the same channel only.
      const replyRow = Number.isInteger(replyTo) ? db.prepare(`
        SELECT m.id, m.content, m.user_id, m.is_webhook, m.webhook_username, m.imported_from, m.persona_username,
               COALESCE(u.display_name, u.username, '[Deleted User]') AS username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ? AND m.channel_id = ?
      `).get(replyTo, channelId) : null;
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar, title, tags, discord_message_id, reply_to) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)'
      ).run(channelId, null, content, username, avatarUrl || null, title || null, tagList ? JSON.stringify(tagList) : null, discordId, replyRow ? replyRow.id : null);
      const replyContext = replyRow ? toReplyContext(replyRow) : null;

      io.to(`channel:${channelCode}`).emit('new-message', {
        channelCode,
        message: {
          id: result.lastInsertRowid,
          content,
          title: title || undefined,
          tags: tagList || undefined,
          created_at: new Date().toISOString(),
          username: `[BOT] ${username}`,
          user_id: null,
          avatar: avatarUrl || null,
          avatar_shape: 'square',
          reply_to: replyRow ? replyRow.id : null,
          replyContext,
          reactions: [],
          is_webhook: true,
          webhook_name: username,
          from_discord: true
        }
      });
      // The Haven member it answers is told, on their phone too, the same as
      // for a reply from someone in Haven.
      if (replyRow && replyRow.user_id && socketRuntime?.sendPushNotifications) {
        const ch = db.prepare('SELECT name FROM channels WHERE id = ?').get(channelId);
        socketRuntime.sendPushNotifications(channelId, channelCode, ch ? ch.name : '', 0, username, content,
          { onlyUserIds: [replyRow.user_id], replyToUserId: replyRow.user_id });
      }
      return result.lastInsertRowid;
    } catch (err) {
      console.error('Ferry could not store an inbound Discord message:', err.message);
      return null;
    }
  },

  // Applied when someone edits a Discord message Ferry already relayed. Reuses
  // the same `message-edited` event a Haven edit emits, so every open client
  // updates the message in place instead of showing a stale copy.
  editHavenMessage: ({ havenMessageId, channelCode, content }) => {
    try {
      const info = db.prepare(
        "UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ? AND is_webhook = 1 AND is_archived = 0"
      ).run(content, havenMessageId);
      if (!info.changes) return;

      io.to(`channel:${channelCode}`).emit('message-edited', {
        channelCode,
        messageId: havenMessageId,
        content,
        editedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('Ferry could not apply a Discord edit:', err.message);
    }
  },

  // A message inside a Discord forum post becomes a reply in its Haven topic.
  // Same events a Haven reply sends, so an open thread panel shows it and the
  // topic's reply count and bump follow.
  // The Haven message a Discord thread hangs from (#5773): the copy of the
  // message it was started from, or, for a thread started on its own (or
  // whose first message never came across), a line with its name.
  findOrCreateThreadRoot({ channelId, channelCode, discordThreadId, name, username, avatarUrl }) {
    const found = db.prepare(
      'SELECT id FROM messages WHERE channel_id = ? AND discord_message_id = ? AND thread_id IS NULL'
    ).get(channelId, String(discordThreadId));
    if (found) return found.id;
    return this.insertHavenMessage({
      channelId, channelCode, username, avatarUrl,
      content: `🧵 ${sanitizeText(String(name || '').slice(0, 100)) || 'Thread'}`,
      discordMessageId: discordThreadId,
    });
  },

  insertHavenThreadReply: ({ channelId, channelCode, parentId, username, avatarUrl, content }) => {
    try {
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, thread_id, is_webhook, webhook_username, webhook_avatar) VALUES (?, ?, ?, ?, 1, ?, ?)'
      ).run(channelId, null, content, parentId, username, avatarUrl || null);
      const createdAt = new Date().toISOString();

      io.to(`channel:${channelCode}`).emit('new-thread-message', {
        channelCode,
        parentId,
        message: {
          id: result.lastInsertRowid,
          content,
          created_at: createdAt,
          // Marked like every relayed author in channel history, so a Discord
          // nickname cannot pass for a Haven member's name. The stored and
          // webhook_username copies stay bare, so the prefix is added once.
          username: `[BOT] ${username}`,
          user_id: null,
          avatar: avatarUrl || null,
          avatar_shape: 'square',
          reply_to: null,
          replyContext: null,
          reactions: [],
          edited_at: null,
          is_webhook: 1,
          webhook_username: username,
          webhook_avatar: avatarUrl || null,
          thread_id: parentId,
          from_discord: true
        },
        followerIds: threadNotify.followerIds(db, parentId)
      });

      const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(parentId).n;
      // Participants are Haven accounts only, the same as for a Haven reply,
      // so a relayed Discord author never shows there under any name.
      const participants = db.prepare(`
        SELECT DISTINCT COALESCE(u.display_name, u.username) as username, u.avatar
        FROM messages m JOIN users u ON m.user_id = u.id
        WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 5
      `).all(parentId);
      io.to(`channel:${channelCode}`).emit('thread-updated', {
        channelCode,
        parentId,
        thread: {
          count,
          lastReplyAt: createdAt,
          lastReplyId: result.lastInsertRowid,
          senderId: null,
          participants: participants.map(p => ({ username: p.username, avatar: p.avatar }))
        }
      });
      return result.lastInsertRowid;
    } catch (err) {
      console.error('Ferry could not store a Discord forum reply:', err.message);
      return null;
    }
  },

  // A Discord post was renamed, retagged, locked or unlocked. Reuses the
  // `topic-updated` event a Haven edit of the topic sends. Only the fields
  // given change.
  updateHavenTopic: ({ messageId, channelCode, title, tags, closed }) => {
    try {
      if (typeof title === 'string' && title) {
        const clean = sanitizeText(title);
        if (clean) db.prepare('UPDATE messages SET title = ? WHERE id = ?').run(clean, messageId);
      }
      if (Array.isArray(tags)) db.prepare('UPDATE messages SET tags = ? WHERE id = ?').run(tags.length ? JSON.stringify(tags) : null, messageId);
      if (typeof closed === 'boolean') db.prepare('UPDATE messages SET closed = ? WHERE id = ?').run(closed ? 1 : 0, messageId);
      const row = db.prepare('SELECT title, tags, closed, nsfw FROM messages WHERE id = ?').get(messageId);
      if (!row) return;
      let tagList = [];
      try { tagList = JSON.parse(row.tags || '[]'); } catch { tagList = []; }
      io.to(`channel:${channelCode}`).emit('topic-updated', {
        channelCode, messageId, title: row.title || null, tags: tagList, closed: !!row.closed, nsfw: !!row.nsfw
      });
    } catch (err) {
      console.error('Ferry could not update a forum topic:', err.message);
    }
  }
});

}

registerProcessCleanup();
// Close the Discord socket deliberately on shutdown. Without this a container
// restart leaves Discord holding a session it will keep feeding for a minute.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { stopFerry(); } catch { /* shutting down anyway; Discord drops the session on its own */ } });
}

// ── Auto-cleanup, auto-backup, dynamic DNS and updates: src/routes/maintenance.js ──
if (!postgresPreview) require('./src/routes/maintenance')({ app, UPLOAD_PATH_RE, isSafeUploadRelPath, moveUploadToDeleted: storage.softDelete, verifyAdminFromDb, buildBackupFile, db, late });

// ── Catch-all: 404 ──────────────────────────────────────
// Must be registered AFTER every app.get/post/etc. handler. Express
// matches in registration order, so anything below this never runs.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler (never leak stack traces) ──────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const protocol = useSSL ? 'https' : 'http';

// ── Crash log helper ─────────────────────────────────────
// Write crash events to a file so they survive even when stdout
// is not captured (common on systemd-less Pi setups, screen
// sessions that were closed, etc.).
const CRASH_LOG = path.join(DATA_DIR, 'crash.log');
const MAX_CRASH_LOG_BYTES = (() => {
  const parsed = parseInt(process.env.HAVEN_CRASH_LOG_MAX_MB || '64', 10);
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : 64;
  return mb * 1024 * 1024;
})();

let _inLogCrash = false;
let _consolePipeBroken = false;

function isBrokenPipeError(err) {
  if (!err) return false;
  if (err && err.code === 'EPIPE') return true;
  const msg = String(err.message || err || '');
  return /\bEPIPE\b/i.test(msg) || /broken pipe/i.test(msg);
}

function rotateCrashLogIfNeeded() {
  try {
    const stat = fs.statSync(CRASH_LOG);
    if (stat.size < MAX_CRASH_LOG_BYTES) return;
    const rotated = `${CRASH_LOG}.1`;
    try { fs.unlinkSync(rotated); } catch { /* no older rotated log yet */ }
    try {
      fs.renameSync(CRASH_LOG, rotated);
    } catch {
      fs.truncateSync(CRASH_LOG, 0);
    }
  } catch {
    // File may not exist yet.
  }
}

function logCrash(label, detail) {
  if (isBrokenPipeError(detail)) {
    _consolePipeBroken = true;
    return;
  }
  if (_inLogCrash) return;
  _inLogCrash = true;
  const ts = new Date().toISOString();
  try {
    const mem = process.memoryUsage();
    const line = `[${ts}] ${label}: ${detail instanceof Error ? detail.stack : detail}\n` +
                 `  RSS=${Math.round(mem.rss / 1048576)}MB Heap=${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB\n`;
    if (!_consolePipeBroken) {
      try {
        console.error(`⚠️  ${label}:`, detail);
      } catch (e) {
        if (isBrokenPipeError(e)) _consolePipeBroken = true;
      }
    }
    try {
      rotateCrashLogIfNeeded();
      fs.appendFileSync(CRASH_LOG, line);
    } catch {
      // disk full / read-only
    }
  } finally {
    _inLogCrash = false;
  }
}

// ── Global crash prevention ──────────────────────────────
// Prevent the entire server from dying due to an uncaught exception
// in a socket handler or background task.  Log the error so it
// can be debugged, but keep the process alive.
process.on('uncaughtException', (err) => {
  if (isBrokenPipeError(err)) {
    _consolePipeBroken = true;
    return;
  }
  logCrash('Uncaught exception (server kept alive)', err);
});
process.on('unhandledRejection', (reason) => {
  if (isBrokenPipeError(reason)) {
    _consolePipeBroken = true;
    return;
  }
  logCrash('Unhandled promise rejection (server kept alive)', reason);
});

// ── Process exit logging ─────────────────────────────────
// Catches ALL exits, including native crashes and V8 OOM.
// The 'exit' event fires even for abort() / SIGSEGV on some
// Node versions.  We also log SIGABRT (V8 OOM fires this).
process.on('exit', (code) => {
  if (code !== 0) {
    const ts = new Date().toISOString();
    const line = `[${ts}] Process exited with code ${code}\n`;
    try { rotateCrashLogIfNeeded(); fs.appendFileSync(CRASH_LOG, line); } catch { /* process is exiting; nowhere left to report a log write failure */ }
  }
});

// ── Event loop lag monitor ───────────────────────────────
// Detects when the event loop is blocked (heavy sync SQLite ops
// or native module work).  Logs a warning when lag exceeds 500ms
// so we can correlate with crashes on low-power hardware.
let _lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - _lastTick - 2000; // expected interval is 2s
  if (lag > 500) {
    logCrash('Event loop lag', `${lag}ms (event loop was blocked)`);
  }
  _lastTick = now;
}, 2000).unref();

// ── Memory watchdog ──────────────────────────────────────
// Periodically log memory usage and nudge GC when heap is getting large.
// This helps prevent the Oilpan "large allocation" OOM in Haven Desktop
// where the server runs alongside Electron.
//
// Auto-detects system RAM so Raspberry Pi (1-4 GB) gets a lower
// threshold than a 32 GB desktop.  Fallback: 350 MB.
const MEM_WARN_MB = (() => {
  try {
    const os = require('os');
    const totalMB = Math.round(os.totalmem() / 1048576);
    // Warn at ~40% of total RAM (aggressive for low-RAM devices)
    const threshold = Math.round(totalMB * 0.4);
    // Clamp between 150 MB (Pi Zero) and 500 MB (big box)
    return Math.max(150, Math.min(500, threshold));
  } catch { return 350; }
})();
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB  = Math.round(mem.heapUsed / 1048576);
  const rssMB   = Math.round(mem.rss / 1048576);
  const extMB   = Math.round((mem.external || 0) / 1048576);

  // Log if above warning threshold
  if (rssMB > MEM_WARN_MB) {
    logCrash('Memory high', `RSS: ${rssMB} MB, Heap: ${heapMB} MB, External: ${extMB} MB (threshold: ${MEM_WARN_MB} MB)`);
    // Nudge GC if --expose-gc was passed
    if (global.gc) {
      global.gc();
      console.warn('   GC nudged');
    }
  }
}, 30000);  // every 30 seconds

// ── Anti-Slowloris: server-level timeouts ────────────────
// headersTimeout is the real slowloris defense (slow/incomplete headers). The
// whole-request cap is generous because admin backup restores upload multi-GB
// bodies that take minutes; the restore handler additionally clears its own
// socket inactivity timeout while it stages the upload to disk (#5436).
server.headersTimeout = 15000;     // 15s to send all headers
server.requestTimeout = 3600000;   // 1h max to finish sending a request body (large restore uploads)
server.keepAliveTimeout = 65000;   // slightly above typical ALB/LB timeout
server.timeout = 120000;           // 2 min socket inactivity timeout (resets on I/O)

// ── Fatal listen errors must be loud ─────────────────────
// A failed bind (port already taken, no permission) surfaces as an
// async 'error' event.  Without this handler it falls through to the
// global uncaughtException keep-alive below, which writes it to
// crash.log and keeps a process alive that never got its socket.
// To the user that is a silent crash on launch: no banner, no error,
// no exit, and the stale port-holder makes launch scripts think the
// server came up.  Bind failures are fatal: say why, then exit.
server.on('error', (err) => {
  if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL')) {
    const why = err.code === 'EADDRINUSE'
      ? `port ${PORT} is already in use. Is another Haven instance (or other app) running?`
      : err.code === 'EADDRNOTAVAIL'
        ? `this machine has no network interface with address ${HOST}; check HOST in your .env`
        : process.platform === 'win32'
          ? `Windows refused port ${PORT}. Ports below 1024 need an elevated prompt; otherwise the port is usually inside a reserved range held by Hyper-V/WSL (see: netsh interface ipv4 show excludedportrange protocol=tcp). Pick another PORT in your .env, or free the range with: net stop winnat && net start winnat`
          : `no permission to bind port ${PORT}. Ports below 1024 need root. Keep Haven on a port above 1024 (the default is 3000) and forward 443 to it on your router, or put a reverse proxy such as Caddy or nginx in front`;
    console.error(`\n❌ Haven could not start: ${why}`);
    console.error(err.code === 'EADDRINUSE' ? '   Stop the other process or change PORT in your .env, then start Haven again.' : '   Fix that or change PORT/HOST in your .env, then start Haven again.');
    logCrash('Fatal listen error (exiting)', err);
    process.exit(1);
  }
  logCrash('HTTP server error (server kept alive)', err);
});

function onListening() {
  // Print the machine's LAN address rather than a YOUR_IP placeholder, which
  // more than one self-hoster has read as a broken config. (#5572)
  const lanIps = [];
  try {
    for (const ifaces of Object.values(require('os').networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === 'IPv4' && !i.internal) lanIps.push(i.address);
      }
    }
  } catch { /* leave the placeholder */ }
  const networkLine = `${protocol}://${lanIps[0] || 'YOUR_IP'}:${PORT}`;
  // Every row is 42 columns inside the box, so the right edge lines up.
  const row = (label, value) => `║  ${label.padEnd(9)}${String(value).padEnd(31)}║`;
  console.log(`
╔══════════════════════════════════════════╗
║       🏠  HAVEN is running               ║
╠══════════════════════════════════════════╣
${row('Name:', process.env.SERVER_NAME || 'Haven')}
${row('Local:', `${protocol}://localhost:${PORT}`)}
${row('Network:', networkLine)}
${row('Admin:', process.env.ADMIN_USERNAME || 'admin')}
╚══════════════════════════════════════════╝
  `);
  if (lanIps.length > 1) {
    console.log(`  Also reachable on: ${lanIps.slice(1).map(ip => `${protocol}://${ip}:${PORT}`).join(', ')}`);
  }
  // Tunnel is now started manually via the admin panel button (no auto-start)
  // Dynamic DNS auto-updater (kicks in only if DDNS_PROVIDER is set in .env)
  try { if (!postgresPreview) startDdns(); } catch (err) { console.warn('[ddns] failed to start:', err && err.message); }
}

// Storage has to answer before anything is served. One that cannot be used
// stops the server here instead of leaving it up with no media; the explicit
// exit matters, because the rejection handler above keeps the process alive.
(postgresPreview ? storage.ping() : storage.prepare(db)).then(() => {
  if (!postgresPreview) seedStarterStickers();   // catches and logs its own errors
  server.listen(PORT, HOST, onListening);
  if (!postgresPreview) storage.keepIndexed(db);
}, (err) => {
  console.error(`\n❌ Haven could not start: ${err.message}`);
  logCrash('Storage unavailable (exiting)', err);
  process.exit(1);
});

function gracefulShutdown(signal) {
  const ts = new Date().toISOString();
  const line = `[${ts}] Graceful shutdown: ${signal}\n`;
  try { rotateCrashLogIfNeeded(); fs.appendFileSync(CRASH_LOG, line); } catch { /* crash log is a diagnostic extra; shutdown continues */ }
  console.log(`\n${signal === 'admin' ? 'Shut down from Settings' : `${signal} received`}, shutting down`);
  botAudioManager?.shutdown();
  require('./src/mediaTools').stopExiftool();
  io.close();
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    // Closing the database writes out its journal, so the next start does
    // not have to replay it.
    try { await db.close(); } catch (err) { console.warn('[shutdown] database close failed:', err.message); }
    process.exit(0);
  };
  server.close(finish);
  // A browser holding a keep-alive connection open can keep server.close()
  // waiting; don't let that stall the shutdown.
  setTimeout(finish, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// The same shutdown for the admin's button in Settings (src/routes/maintenance.js).
late.shutdown = (reason) => {
  try { stopFerry(); } catch { /* shutting down anyway; Discord drops the session on its own */ }
  gracefulShutdown(reason);
};

})().catch(err => {
  // The whole reason, for whoever has to fix it: a bare code such as
  // MODULE_NOT_FOUND says nothing. A database address can hold a password.
  console.error('Haven could not start:', String(err.stack || err.message).replace(/\/\/[^@\s/]+@/g, '//***@'));
  process.exit(1);
});
