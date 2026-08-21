const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('./database');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const https = require('https');
const http = require('http');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Check your .env file or let server.js auto-generate it.');
  process.exit(1);
}
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

// Admin-configurable session duration (days). Bounded 0–365 to match the
// validator in src/socketHandlers/admin.js (#5294, expanded for #5391).
// A value of 0 means "never expire" — the JWT is signed without an `exp`
// claim and lives until the user logs out or their password_version bumps.
// Returns either a string like '7d' OR null (no expiry).
// For new installs the seeded default is 0 (Never); existing installs that
// were seeded with '7' keep their previous behavior until the admin changes it.
function _sessionExpiresIn() {
  try {
    const row = getDb().prepare("SELECT value FROM server_settings WHERE key = 'session_duration_days'").get();
    const n = parseInt(row && row.value);
    if (n === 0) return null;
    if (Number.isFinite(n) && n >= 1 && n <= 365) return `${n}d`;
  } catch {}
  return null;
}

// Build the options object for jwt.sign() respecting the never-expire setting.
// jsonwebtoken throws on { expiresIn: null }, so we must omit the field entirely.
function _sessionSignOptions() {
  const exp = _sessionExpiresIn();
  return exp ? { expiresIn: exp } : {};
}

// ── TOTP helpers ─────────────────────────────────────────
// Short-lived tokens for the TOTP verification step (not full session tokens).
// `mustChangePassword` and `cancelTempReset` carry across the challenge so the
// /totp/validate handler knows whether to flag the issued session for the
// forced change-password screen (#5300) and whether to clear an outstanding
// admin reset because the user successfully proved the original password.
function generateTotpChallengeToken(userId, extras = {}) {
  return jwt.sign(
    { id: userId, purpose: 'totp_challenge',
      mustChangePassword: !!extras.mustChangePassword,
      cancelTempReset: !!extras.cancelTempReset },
    JWT_SECRET, { expiresIn: '5m' }
  );
}

function verifyTotpChallengeToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'totp_challenge') return null;
    return decoded;
  } catch { return null; }
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 8-char alphanumeric codes, grouped as XXXX-XXXX for readability
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4));
  }
  return codes;
}

// ── Rate Limiting (in-memory, no extra deps) ────────────
const rateLimitStore = new Map();

function authLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 20;           // 20 auth requests per 15 min per IP

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }

  const timestamps = rateLimitStore.get(ip).filter(t => now - t < windowMs);
  rateLimitStore.set(ip, timestamps);

  if (timestamps.length >= maxAttempts) {
    return res.status(429).json({
      error: 'Too many attempts. Try again in a few minutes.'
    });
  }

  timestamps.push(now);
  next();
}

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  for (const [ip, timestamps] of rateLimitStore) {
    const fresh = timestamps.filter(t => now - t < windowMs);
    if (fresh.length === 0) rateLimitStore.delete(ip);
    else rateLimitStore.set(ip, fresh);
  }
}, 30 * 60 * 1000);

// ── Global registration velocity limiter (opt-in) ───────
// Caps how many new accounts can be created server-wide per rolling hour, to
// blunt a bot wave even when it is spread across many IPs (the per-IP limiter
// above can't). In-memory, so it resets on restart — same as the others here.
const _regTimestamps = [];
function _regCountLastHour() {
  const cutoff = Date.now() - 3600 * 1000;
  while (_regTimestamps.length && _regTimestamps[0] < cutoff) _regTimestamps.shift();
  return _regTimestamps.length;
}

// ── Input Sanitization ──────────────────────────────────
function sanitizeString(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// ── Cloudflare Turnstile verification (opt-in CAPTCHA) ───
// Verifies a registration challenge token server-side against Cloudflare so a
// forged or missing token can't pass. Returns true only on a confirmed pass;
// any error (network, timeout, bad response) returns false = challenge failed.
async function verifyTurnstile(secret, token, remoteIp) {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.append('remoteip', remoteIp);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!(data && data.success === true);
  } catch {
    return false;
  }
}

// ── SSO Avatar Download ─────────────────────────────────
// Downloads a profile picture from a remote Haven server and saves it locally.
// Returns the local /uploads/ path, or throws on failure.
function downloadSSOAvatar(url) {
  return new Promise((resolve, reject) => {
    // Validate URL
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error('Invalid protocol'));
    }

    const fetcher = parsed.protocol === 'https:' ? https : http;
    const request = fetcher.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const validTypes = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
      const ext = validTypes[contentType.split(';')[0].trim()];
      if (!ext) {
        res.resume();
        return reject(new Error('Not a supported image type'));
      }

      // Limit to 2 MB
      let size = 0;
      const maxSize = 2 * 1024 * 1024;
      const chunks = [];

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxSize) {
          res.destroy();
          return reject(new Error('Image too large'));
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);

          // Validate magic bytes
          let validMagic = false;
          if (ext === '.jpg') validMagic = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
          else if (ext === '.png') validMagic = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
          else if (ext === '.gif') validMagic = buffer.slice(0, 6).toString().startsWith('GIF8');
          else if (ext === '.webp') validMagic = buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
          if (!validMagic) return reject(new Error('File content does not match image type'));

          const filename = Date.now() + crypto.randomBytes(8).toString('hex') + ext;
          const { UPLOADS_DIR } = require('./paths');
          const path = require('path');
          const fs = require('fs');
          const filePath = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(filePath, buffer);
          resolve(`/uploads/${filename}`);
        } catch (err) {
          reject(err);
        }
      });

      res.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

// ── Register ──────────────────────────────────────────────

// (#5344) Public endpoint that tells the registration page which
// gates the admin has enabled. Only booleans are exposed — the
// actual token value never leaves the server here.
router.get('/registration-info', (req, res) => {
  try {
    const db = getDb();
    const tokenEnabledRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_token_enabled'").get();
    const inviteBypassTokenRow = db.prepare("SELECT value FROM server_settings WHERE key = 'invites_bypass_registration_token'").get();
    const tokenRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_token'").get();
    const requiresToken = !!(tokenEnabledRow && tokenEnabledRow.value === 'true' && tokenRow && tokenRow.value);
    const invitesBypassToken = !!(inviteBypassTokenRow && inviteBypassTokenRow.value === 'true');
    // Opt-in Turnstile CAPTCHA. Only the public site key is exposed (safe by
    // design); the secret key never leaves the server. Gated on a site key
    // being present so the page never tries to render a keyless widget.
    const capEnabledRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_captcha_enabled'").get();
    const siteKeyRow = db.prepare("SELECT value FROM server_settings WHERE key = 'turnstile_site_key'").get();
    const turnstileSiteKey = (siteKeyRow && typeof siteKeyRow.value === 'string') ? siteKeyRow.value.trim() : '';
    const captchaEnabled = !!(capEnabledRow && capEnabledRow.value === 'true' && turnstileSiteKey);
    res.json({ requiresToken, invitesBypassToken, captchaEnabled, turnstileSiteKey: captchaEnabled ? turnstileSiteKey : '' });
  } catch (err) {
    res.json({ requiresToken: false, captchaEnabled: false, turnstileSiteKey: '' });
  }
});

// (#5381) Public endpoint that tells the login page whether the admin
// has enabled the Join-as-Guest button.
router.get('/guest-info', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'guests_enabled'").get();
    res.json({ guestsEnabled: !!(row && row.value === 'true') });
  } catch {
    res.json({ guestsEnabled: false });
  }
});

// (#5381) Guest login — ephemeral, no password, no E2E key. Creates
// a real users row with is_guest=1 so the existing socket auth, member
// list, role lookup, etc. all just work; the row is deleted when the
// guest's last socket disconnects (see socketHandlers/index.js).
//
// Username collision rules:
//   - reserved if a non-guest user already owns it → reject
//   - reserved if a guest user owns it (live or not) → reject (we can't
//     tell from this layer whether the existing guest row has a live
//     socket; the disconnect handler is responsible for freeing the row)
router.post('/guest-login', authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const enabledRow = db.prepare("SELECT value FROM server_settings WHERE key = 'guests_enabled'").get();
    if (!enabledRow || enabledRow.value !== 'true') {
      return res.status(403).json({ error: 'Guest access is disabled on this server' });
    }

    const username = sanitizeString(req.body.username, 20);
    const eulaVersion = typeof req.body.eulaVersion === 'string' ? req.body.eulaVersion.trim() : '';
    const ageVerified = req.body.ageVerified === true;
    if (!username) return res.status(400).json({ error: 'Username required' });
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
    }
    if (username.toLowerCase() === ADMIN_USERNAME) {
      return res.status(400).json({ error: 'That username is reserved' });
    }
    if (!eulaVersion) {
      return res.status(400).json({ error: 'You must accept the Terms of Service & Release of Liability Agreement' });
    }
    if (!ageVerified) {
      return res.status(400).json({ error: 'You must confirm that you are 18 years of age or older' });
    }

    // Ban check by name (so a banned member can't slip back in as a guest).
    const bannedRow = db.prepare(
      'SELECT b.id FROM bans b JOIN users u ON b.user_id = u.id WHERE LOWER(u.username) = LOWER(?)'
    ).get(username);
    if (bannedRow) {
      return res.status(403).json({ error: 'That username is banned from this server' });
    }

    const existing = db.prepare('SELECT id, is_guest FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (existing) {
      if (!existing.is_guest) {
        return res.status(409).json({ error: 'That username is taken by a registered member' });
      }
      return res.status(409).json({ error: 'That username is currently in use — try another' });
    }

    // Random unusable hash — the row needs a password_hash but guests
    // never reach the /login endpoint, so nothing should ever match.
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 4);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin, is_guest) VALUES (?, ?, 0, 1)'
    ).run(username, hash);
    const userId = result.lastInsertRowid;

    // Auto-join exactly the admin-whitelisted guest channels. (#5401)
    // The admin picks each channel individually in the guest-channels picker —
    // top-level rooms, sub-channels, and voice rooms alike — so we join only
    // the listed ids and never cascade implicitly. This lets guests reach
    // nested and voice channels (previously skipped) while keeping the admin in
    // full control of what's exposed. DM channels are never joined.
    try {
      const chRow = db.prepare("SELECT value FROM server_settings WHERE key = 'guest_channels'").get();
      const csv = (chRow && typeof chRow.value === 'string') ? chRow.value.trim() : '';
      if (csv) {
        const seedIds = csv.split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n) && n > 0);
        const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
        for (const cid of new Set(seedIds)) {
          const ch = db.prepare('SELECT id, is_dm FROM channels WHERE id = ?').get(cid);
          if (ch && !ch.is_dm) insertMember.run(cid, userId);
        }
      }
    } catch (err) {
      console.warn('[guest-login] channel auto-join failed:', err.message);
    }

    if (eulaVersion) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO eula_acceptances (user_id, version, ip_address, age_verified) VALUES (?, ?, ?, ?)'
        ).run(userId, eulaVersion, req.ip || req.socket.remoteAddress || '', ageVerified ? 1 : 0);
      } catch { /* non-critical */ }
    }

    const token = jwt.sign(
      { id: userId, username, isAdmin: false, isGuest: true, displayName: username, pwv: 1 },
      JWT_SECRET,
      { expiresIn: '12h' } // guests get a short session by design
    );

    res.json({
      token,
      user: { id: userId, username, isAdmin: false, isGuest: true, displayName: username }
    });
  } catch (err) {
    console.error('Guest login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Everything a brand-new account needs beyond its row in `users`: the roles an
 * admin flagged auto_assign (without them a new member can be left unable to
 * see any channel), plus the persistent welcome message.
 *
 * Shared by local registration and OIDC first-login (#12) so a federated user
 * lands in exactly the same state as someone who signed up with a password.
 * Every step is best-effort — none of it is worth failing a signup over.
 */
function provisionNewUser(db, userId, username, io) {
  // Auto-assign roles flagged as auto_assign to new users
  try {
    const autoRoles = db.prepare("SELECT id FROM roles WHERE auto_assign = 1 AND scope = 'server'").all();
    const insertRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
    for (const role of autoRoles) {
      insertRole.run(userId, role.id);
      // Grant linked channel access for this role (fixes #79)
      try {
        const r = db.prepare('SELECT link_channel_access FROM roles WHERE id = ?').get(role.id);
        if (r && r.link_channel_access) {
          const grantChannels = db.prepare(
            'SELECT channel_id FROM role_channel_access WHERE role_id = ? AND grant_on_promote = 1'
          ).all(role.id);
          const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
          for (const ch of grantChannels) ins.run(ch.channel_id, userId);
        }
      } catch { /* non-critical */ }
    }
  } catch { /* non-critical */ }

  // ── Persistent welcome message ─────────────────────────
  // Post a saved welcome message to every channel flagged show_welcome, so a
  // new member gets a permanent, consistent welcome that stays in history for
  // everyone (replacing the old live-only flash that vanished on reload and
  // only showed to whoever happened to be watching that channel). Gated on
  // the admin welcome_message template — an empty template turns it off.
  try {
    const wmRow = db.prepare("SELECT value FROM server_settings WHERE key = 'welcome_message'").get();
    const template = wmRow && typeof wmRow.value === 'string' ? wmRow.value.trim() : '';
    if (template) {
      const welcomeText = template.replace(/\{user\}/gi, username).slice(0, 500);
      const welcomeChannels = db.prepare(
        'SELECT id, code FROM channels WHERE is_dm = 0 AND show_welcome = 1'
      ).all();
      if (welcomeChannels.length) {
        const insertWelcome = db.prepare(
          "INSERT INTO messages (channel_id, user_id, content, type) VALUES (?, ?, ?, 'welcome')"
        );
        for (const ch of welcomeChannels) {
          const info = insertWelcome.run(ch.id, userId, welcomeText);
          if (io) {
            io.to(`channel:${ch.code}`).emit('welcome-message', {
              channelCode: ch.code,
              message: {
                id: info.lastInsertRowid,
                user_id: userId,
                content: welcomeText,
                type: 'welcome',
                created_at: new Date().toISOString()
              }
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[welcome] Failed to post welcome message:', err.message);
  }
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 20);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const eulaVersion = typeof req.body.eulaVersion === 'string' ? req.body.eulaVersion.trim() : '';
    const ageVerified = req.body.ageVerified === true;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!eulaVersion) {
      return res.status(400).json({ error: 'You must accept the Terms of Service & Release of Liability Agreement' });
    }
    if (!ageVerified) {
      return res.status(400).json({ error: 'You must confirm that you are 18 years of age or older' });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
    }

    const db = getDb();

    // (#5344) Registration token check — admin-controlled gate that can
    // sit alongside (or instead of) the whitelist. When enabled, a valid
    // registration token is required unless a valid invite link is being
    // used and invite links are configured to bypass the token requirement
    let inviteRow
    const tokenEnabledRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_token_enabled'").get();
    if (tokenEnabledRow && tokenEnabledRow.value === 'true') {
      // if invite code is used, and admin allows invites to override registration code requirement, validate invite code and use it in place of the registration code
      const inviteOverridesTokenRow = db.prepare("SELECT value FROM server_settings WHERE key = 'invites_bypass_registration_token'").get();
      const inviteCode = typeof req.body.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
      if (inviteOverridesTokenRow && inviteOverridesTokenRow.value === 'true' && inviteCode) {
        inviteRow = db.prepare(
          "SELECT *, (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS is_expired FROM invite_codes WHERE code = ?"
        ).get(inviteCode);

        if (!inviteRow) {
          return res.status(403).json({error: 'Invalid invite link.'});
        }
        if (!inviteRow.enabled) {
          return res.status(403).json({error: 'This invite link has been disabled.'});
        }
        if (inviteRow.is_expired) {
          return res.status(403).json({error: 'This invite link has expired.'});
        }
        if (inviteRow.max_uses > 0) {
          const used = db.prepare(
            'SELECT COUNT(*) AS n FROM invite_code_uses WHERE invite_code_id = ?'
          ).get(inviteRow.id).n;

          if (used >= inviteRow.max_uses) {
            return res.status(403).json({error: 'This invite link has reached its use limit.'});
          }
        }
      } else {
        // check registration token
        const tokenRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_token'").get();
        const expected = tokenRow && typeof tokenRow.value === 'string' ? tokenRow.value.trim() : '';
        const supplied = typeof req.body.registrationToken === 'string' ? req.body.registrationToken.trim() : '';
        if (!expected) {
          return res.status(403).json({ error: 'Registration is restricted. Ask the server admin for an invite.' });
        }
        if (supplied !== expected) {
          return res.status(403).json({ error: 'Invalid or missing registration token.' });
        }
      }
    }

    // Whitelist check — if enabled, only pre-approved usernames can register
    const wlSetting = db.prepare("SELECT value FROM server_settings WHERE key = 'whitelist_enabled'").get();
    if (wlSetting && wlSetting.value === 'true') {
      const onList = db.prepare('SELECT 1 FROM whitelist WHERE username = ?').get(username);
      if (!onList) {
        return res.status(403).json({ error: 'Registration is restricted. Your username is not on the whitelist.' });
      }
    }

    // Cloudflare Turnstile CAPTCHA (opt-in). When enabled with a secret key,
    // the registrant must pass the challenge, verified server-side so a forged
    // or absent token can't slip through. A blank secret disables enforcement
    // (misconfiguration), rather than locking everyone out.
    const capEnabledRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_captcha_enabled'").get();
    if (capEnabledRow && capEnabledRow.value === 'true') {
      const secretRow = db.prepare("SELECT value FROM server_settings WHERE key = 'turnstile_secret_key'").get();
      const secret = secretRow && typeof secretRow.value === 'string' ? secretRow.value.trim() : '';
      if (secret) {
        const capToken = typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '';
        if (!capToken) return res.status(400).json({ error: 'Please complete the CAPTCHA.' });
        const passed = await verifyTurnstile(secret, capToken, req.ip);
        if (!passed) return res.status(403).json({ error: 'CAPTCHA verification failed. Please try again.' });
      }
    }

    // Global registration rate limit (opt-in). Caps new accounts per rolling
    // hour server-wide to blunt a bot wave spread across many IPs.
    const rlEnabledRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_rate_limit_enabled'").get();
    if (rlEnabledRow && rlEnabledRow.value === 'true') {
      const rlRow = db.prepare("SELECT value FROM server_settings WHERE key = 'registration_rate_limit_per_hour'").get();
      const limit = Math.max(1, parseInt(rlRow && rlRow.value, 10) || 20);
      if (_regCountLastHour() >= limit) {
        return res.status(429).json({ error: 'This server is temporarily limiting new sign-ups. Please try again later.' });
      }
    }

    // Make Sure username doesn't already exist.
    // Provide a vague error response that promts the user to change the username, -
    // but is vague enough to not reveal existing usernames to a probing attacker or bot.
    // check this after authenticating the capacha and invite to reduce probing risk.
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Registration could not be completed: invalid username' });
    }

    const hash = await bcrypt.hash(password, 12);
    const isAdmin = username.toLowerCase() === ADMIN_USERNAME ? 1 : 0;

    // SSO profile picture: download from home server if provided
    const ssoProfilePicture = typeof req.body.ssoProfilePicture === 'string' ? req.body.ssoProfilePicture.trim().slice(0, 500) : null;
    let avatarPath = null;
    if (ssoProfilePicture) {
      try {
        avatarPath = await downloadSSOAvatar(ssoProfilePicture);
      } catch (err) {
        console.warn('[SSO] Avatar download failed:', err.message);
        // Non-fatal — proceed without avatar
      }
    }

    const result = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin, avatar) VALUES (?, ?, ?, ?)'
    ).run(username, hash, isAdmin, avatarPath);
    _regTimestamps.push(Date.now()); // feed the opt-in global registration rate limit

    // Consume the invite if it was used for registration.
    if (inviteRow) {
      db.prepare(
        'INSERT INTO invite_code_uses (invite_code_id, user_id) VALUES (?, ?)'
      ).run(inviteRow.id, result.lastInsertRowid);
    }

    provisionNewUser(db, result.lastInsertRowid, username, req.app.get('io'));

    const token = jwt.sign(
      { id: result.lastInsertRowid, username, isAdmin: !!isAdmin, displayName: username, pwv: 1 },
      JWT_SECRET,
      _sessionSignOptions()
    );

    // Record EULA acceptance
    if (eulaVersion) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO eula_acceptances (user_id, version, ip_address, age_verified) VALUES (?, ?, ?, ?)'
        ).run(result.lastInsertRowid, eulaVersion, req.ip || req.socket.remoteAddress || '', ageVerified ? 1 : 0);
      } catch { /* non-critical */ }
    }

    res.json({
      token,
      user: { id: result.lastInsertRowid, username, isAdmin: !!isAdmin, displayName: username }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Login ─────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 20);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const eulaVersion = typeof req.body.eulaVersion === 'string' ? req.body.eulaVersion.trim() : '';
    const ageVerified = req.body.ageVerified === true;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!eulaVersion) {
      return res.status(400).json({ error: 'You must accept the Terms of Service & Release of Liability Agreement' });
    }
    if (!ageVerified) {
      return res.status(400).json({ error: 'You must confirm that you are 18 years of age or older' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // (#12) A federated account has no password_hash at all. Say so rather
    // than failing as "invalid credentials" — otherwise someone who signed up
    // through SSO just sees their password rejected forever, with no hint that
    // they are meant to use the SSO button.
    if (user.oidc_subject && !hasLocalPassword(user)) {
      return res.status(401).json({ error: 'This account signs in through SSO. Use the SSO button on the login page.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    // (#5300 DM-preservation) If the original password didn't match, fall
    // back to the temp hash set by an admin reset. Tracking which one matched
    // controls two downstream behaviors:
    //   - mustChangePassword (client routes to forced change-password screen)
    //   - cancelTempReset (server clears temp_password_hash + flag on success,
    //     silently cancelling the reset and preserving the user's E2E wrap
    //     key since their original password is still intact)
    let usedTemp = false;
    const okWithOriginal = valid;
    if (!valid && user.temp_password_hash) {
      try {
        usedTemp = await bcrypt.compare(password, user.temp_password_hash);
      } catch { usedTemp = false; }
    }
    if (!okWithOriginal && !usedTemp) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // ── Ban check (deferred until AFTER credentials verify) ──────
    // Kept below the password check on purpose (#5457): the ban reason is
    // only revealed to whoever actually owns the account, never on a bare
    // username guess. The client shows the reason and an appeal box; the
    // /ban-appeal endpoint re-verifies these same credentials before storing.
    const ban = db.prepare('SELECT reason FROM bans WHERE user_id = ?').get(user.id);
    if (ban) {
      return res.status(403).json({
        error: 'You have been banned from this server',
        banned: true,
        reason: (typeof ban.reason === 'string' && ban.reason.trim()) ? ban.reason.trim() : '',
        canAppeal: true
      });
    }

    // Bootstrap admin from ADMIN_USERNAME env only when NO admin exists
    // (first run or recovery). Prevents overriding explicit admin transfers.
    const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (!anyAdmin && user.username.toLowerCase() === ADMIN_USERNAME && !user.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
      user.is_admin = 1;
    }

    const displayName = user.display_name || user.username;

    // ── TOTP check: if enabled, require a second step ──
    if (user.totp_enabled) {
      // Defer temp-reset state mutations until after TOTP success so an
      // attacker holding only the original password can't clear a pending
      // admin reset without also presenting the second factor.
      const challengeToken = generateTotpChallengeToken(user.id, {
        mustChangePassword: usedTemp,
        cancelTempReset: okWithOriginal && !!user.temp_password_hash
      });
      return res.json({ requiresTOTP: true, challengeToken });
    }

    // No TOTP gate — apply the temp-reset state mutation now.
    if (okWithOriginal && user.temp_password_hash) {
      db.prepare('UPDATE users SET temp_password_hash = NULL, must_change_password = 0 WHERE id = ?').run(user.id);
      user.must_change_password = 0;
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName, pwv: user.password_version || 1 },
      JWT_SECRET,
      _sessionSignOptions()
    );

    // Record EULA acceptance
    if (eulaVersion) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO eula_acceptances (user_id, version, ip_address, age_verified) VALUES (?, ?, ?, ?)'
        ).run(user.id, eulaVersion, req.ip || req.socket.remoteAddress || '', ageVerified ? 1 : 0);
      } catch { /* non-critical */ }
    }

    res.json({
      token,
      user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName },
      // (#5300) Set when an admin reset this user's password to a temp
      // placeholder AND the user just logged in with that temp pw. Client
      // must funnel the user through a mandatory change-password screen
      // before doing anything else. False when the user logged in with
      // their original password (which silently cancels the reset).
      mustChangePassword: usedTemp
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Ban appeal submission (#5457) ───────────────────────────
// A banned user proves ownership of the account (same credential check as
// login) and submits one appeal, which admins see next to the ban in the
// Banned Users list. Returns the same generic 'Invalid credentials' as login
// for a bad username/password so it can't be used to probe which accounts
// exist or are banned. Rate-limited via authLimiter; one active appeal per
// user (re-submitting overwrites the previous text).
router.post('/ban-appeal', authLimiter, async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 20);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const appeal = typeof req.body.appeal === 'string' ? req.body.appeal.trim() : '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (appeal.length < 1 || appeal.length > 2000) {
      return res.status(400).json({ error: 'Appeal must be between 1 and 2000 characters' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    let ok = false;
    try { ok = await bcrypt.compare(password, user.password_hash); } catch { ok = false; }
    if (!ok && user.temp_password_hash) {
      try { ok = await bcrypt.compare(password, user.temp_password_hash); } catch { ok = false; }
    }
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const ban = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (!ban) return res.status(400).json({ error: 'This account is not banned' });

    // One active appeal per user — resubmitting replaces the previous text.
    db.prepare(
      'INSERT INTO ban_appeals (user_id, appeal) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET appeal = excluded.appeal, created_at = CURRENT_TIMESTAMP'
    ).run(user.id, appeal);

    // Best-effort real-time nudge to any online admin (they check the Banned
    // Users list to review). Non-fatal if io isn't reachable.
    try {
      const io = req.app.get('io');
      if (io) {
        const displayName = user.display_name || user.username;
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.isAdmin) {
            s.emit('ban-appeal-received', { userId: user.id, username: displayName });
          }
        }
      }
    } catch { /* non-critical */ }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ban appeal error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Forced change-password endpoint (#5300) ─────────────────
// Used after an admin password reset. Requires a valid session token,
// validates the new password's length, updates the row, clears the
// must_change_password flag, and returns a fresh JWT so the client
// doesn't have to re-login.
router.post('/change-password-required', authLimiter, async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = jwt.verify(auth.slice(7), JWT_SECRET); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    // (#5300 DM-preservation) Optional escape hatch from the forced
    // change-password screen: if the user remembers their original password
    // and submits it here, we cancel the admin reset without changing the
    // password at all. password_hash is left intact, so the user's E2E
    // wrap key (PBKDF2-derived from the password) keeps working and DM
    // history is preserved. The newPassword field is ignored in this path.
    const oldPassword = typeof req.body.oldPassword === 'string' ? req.body.oldPassword : '';
    const db = getDb();
    const user = db.prepare('SELECT id, username, is_admin, display_name, password_version, password_hash FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    let preserved = false;
    if (oldPassword) {
      let matchesOriginal = false;
      try { matchesOriginal = await bcrypt.compare(oldPassword, user.password_hash); } catch { /* fall through */ }
      if (matchesOriginal) {
        preserved = true;
      } else {
        return res.status(401).json({ error: 'Old password did not match', code: 'old_password_invalid' });
      }
    }

    if (!preserved && (newPassword.length < 8 || newPassword.length > 128)) {
      return res.status(400).json({ error: 'Password must be 8 to 128 characters' });
    }

    const newPwv = (user.password_version || 1) + 1;
    if (preserved) {
      db.prepare('UPDATE users SET temp_password_hash = NULL, password_version = ?, must_change_password = 0 WHERE id = ?')
        .run(newPwv, user.id);
    } else {
      const hash = await bcrypt.hash(newPassword, 10);
      db.prepare('UPDATE users SET password_hash = ?, temp_password_hash = NULL, password_version = ?, must_change_password = 0 WHERE id = ?')
        .run(hash, newPwv, user.id);
    }
    const displayName = user.display_name || user.username;
    const freshToken = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName, pwv: newPwv },
      JWT_SECRET,
      _sessionSignOptions()
    );
    res.json({ token: freshToken, user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName }, preserved });
  } catch (err) {
    console.error('change-password-required error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Validate token (lightweight, for SSO consent page) ───
router.get('/validate', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });

  const db = getDb();
  const user = db.prepare('SELECT username, display_name, avatar FROM users WHERE id = ?').get(decoded.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    username: user.username,
    displayName: user.display_name || user.username,
    avatar: user.avatar || null
  });
});

// ── TOTP Validate (second step of login) ─────────────────
router.post('/totp/validate', authLimiter, async (req, res) => {
  try {
    const challengeToken = typeof req.body.challengeToken === 'string' ? req.body.challengeToken : '';
    const code = typeof req.body.code === 'string' ? req.body.code.replace(/\s/g, '') : '';

    if (!challengeToken || !code) {
      return res.status(400).json({ error: 'Challenge token and code required' });
    }

    const challenge = verifyTotpChallengeToken(challengeToken);
    if (!challenge) {
      return res.status(401).json({ error: 'Invalid or expired challenge. Please log in again.' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(challenge.id);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Try TOTP code first
    const totp = new OTPAuth.TOTP({
      issuer: 'Haven',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(user.totp_secret)
    });

    const delta = totp.validate({ token: code, window: 1 });
    let valid = delta !== null;

    // If not a valid TOTP code, check backup codes
    if (!valid) {
      const normalizedCode = code.toUpperCase().replace(/-/g, '');
      const backupCodes = db.prepare(
        'SELECT id, code_hash FROM totp_backup_codes WHERE user_id = ? AND used = 0'
      ).all(user.id);

      for (const bc of backupCodes) {
        // Compare hashed backup code
        const codeToCheck = normalizedCode.slice(0, 4) + '-' + normalizedCode.slice(4);
        if (crypto.timingSafeEqual(
          Buffer.from(bc.code_hash, 'hex'),
          Buffer.from(crypto.createHash('sha256').update(codeToCheck).digest('hex'), 'hex')
        )) {
          // Mark backup code as used
          db.prepare('UPDATE totp_backup_codes SET used = 1 WHERE id = ?').run(bc.id);
          valid = true;
          break;
        }
      }
    }

    if (!valid) {
      return res.status(401).json({ error: 'Invalid code' });
    }

    // (#5300) Apply any deferred temp-reset state mutations now that TOTP
    // succeeded. If the user logged in with their original password,
    // silently clear the admin reset (DM history preserved). If they used
    // the temp password, the must_change_password flag stays set so the
    // client routes them to the forced change-password screen.
    if (challenge.cancelTempReset) {
      db.prepare('UPDATE users SET temp_password_hash = NULL, must_change_password = 0 WHERE id = ?').run(user.id);
    }

    const displayName = user.display_name || user.username;
    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName, pwv: user.password_version || 1 },
      JWT_SECRET,
      _sessionSignOptions()
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName },
      mustChangePassword: !!challenge.mustChangePassword
    });
  } catch (err) {
    console.error('TOTP validate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Setup (generate secret + QR) ────────────────────
router.post('/totp/setup', authLimiter, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.totp_enabled) {
      return res.status(400).json({ error: '2FA is already enabled' });
    }

    // Generate a new TOTP secret
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Haven',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret
    });

    // Store secret (not yet enabled — user must verify first)
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, user.id);

    const otpauthUri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 256, margin: 2 });

    res.json({
      base32Secret: secret.base32,
      otpauthUri,
      qrDataUrl
    });
  } catch (err) {
    console.error('TOTP setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Verify Setup (confirm code → enable) ────────────
router.post('/totp/verify-setup', authLimiter, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const code = typeof req.body.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
    if (!code) return res.status(400).json({ error: 'Verification code required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.totp_enabled) {
      return res.status(400).json({ error: '2FA is already enabled' });
    }
    if (!user.totp_secret) {
      return res.status(400).json({ error: 'No 2FA setup in progress. Start setup first.' });
    }

    const totp = new OTPAuth.TOTP({
      issuer: 'Haven',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(user.totp_secret)
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: 'Invalid code. Make sure your authenticator app is synced and try again.' });
    }

    // Enable TOTP and bump password_version to invalidate all existing sessions
    const newPwv = (user.password_version || 1) + 1;
    db.prepare('UPDATE users SET totp_enabled = 1, password_version = ? WHERE id = ?').run(newPwv, user.id);

    // Generate backup codes
    const backupCodes = generateBackupCodes(8);
    const insertCode = db.prepare('INSERT INTO totp_backup_codes (user_id, code_hash) VALUES (?, ?)');
    // Clear any old backup codes
    db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);
    for (const c of backupCodes) {
      const hash = crypto.createHash('sha256').update(c).digest('hex');
      insertCode.run(user.id, hash);
    }

    // Issue a fresh token for the current session (carries new pwv so it stays valid)
    const freshToken = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName: user.display_name || user.username, pwv: newPwv },
      JWT_SECRET,
      _sessionSignOptions()
    );

    // Send the response first so the client can store the fresh token
    res.json({ success: true, backupCodes, token: freshToken });

    // After a short delay, disconnect all other sockets for this user (force-logout other devices)
    const io = req.app.get('io');
    if (io) {
      setTimeout(() => {
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === user.id) {
            s.emit('force-logout', { reason: 'totp_enabled' });
            s.disconnect(true);
          }
        }
      }, 500);
    }
  } catch (err) {
    console.error('TOTP verify-setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Disable ─────────────────────────────────────────
router.post('/totp/disable', authLimiter, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) return res.status(400).json({ error: 'Password required to disable 2FA' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);

    res.json({ success: true });
  } catch (err) {
    console.error('TOTP disable error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Status ──────────────────────────────────────────
router.get('/totp/status', (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const db = getDb();
    const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const remaining = db.prepare(
      'SELECT COUNT(*) as count FROM totp_backup_codes WHERE user_id = ? AND used = 0'
    ).get(decoded.id);

    res.json({ enabled: !!user.totp_enabled, backupCodesRemaining: remaining?.count || 0 });
  } catch (err) {
    console.error('TOTP status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Regenerate Backup Codes ─────────────────────────
router.post('/totp/regenerate-backup', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) return res.status(400).json({ error: 'Password required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const backupCodes = generateBackupCodes(8);
    db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);
    const insertCode = db.prepare('INSERT INTO totp_backup_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of backupCodes) {
      const hash = crypto.createHash('sha256').update(c).digest('hex');
      insertCode.run(user.id, hash);
    }

    res.json({ success: true, backupCodes });
  } catch (err) {
    console.error('TOTP regenerate-backup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Change Password ──────────────────────────────────────
router.post('/change-password', authLimiter, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8-128 characters' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // (#12) There is no Haven password on a federated account to change. The
    // compare below would just fail as "incorrect", which reads like a bug.
    if (user.oidc_subject && !hasLocalPassword(user)) {
      return res.status(400).json({ error: 'This account signs in through SSO, so it has no Haven password. Change it with your identity provider instead.' });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    const newPwv = (user.password_version || 1) + 1;
    db.prepare('UPDATE users SET password_hash = ?, password_version = ? WHERE id = ?').run(hash, newPwv, user.id);

    // Issue a fresh token so the session stays alive
    const freshToken = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName: user.display_name || user.username, pwv: newPwv },
      JWT_SECRET,
      _sessionSignOptions()
    );

    // Send the response FIRST so the client can store the fresh token
    // before we disconnect sockets (prevents redirect loop)
    res.json({ message: 'Password changed successfully', token: freshToken });

    // Disconnect all existing sockets for this user (forces re-login on other sessions)
    const io = req.app.get('io');
    if (io) {
      // Small delay to let the HTTP response reach the client first
      setTimeout(() => {
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === user.id) {
            s.emit('force-logout', { reason: 'password_changed' });
            s.disconnect(true);
          }
        }
      }, 500);
    }
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Helpers ───────────────────────────────────────────────

// ── Verify Password (lightweight, for E2E password prompt) ──
router.post('/verify-password', authLimiter, async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 20);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ valid: false, error: 'Username and password required' });
    }
    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ valid: false, error: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ valid: false, error: 'Invalid credentials' });
    }
    res.json({ valid: true });
  } catch (err) {
    console.error('Verify password error:', err);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── Account Recovery Codes ─────────────────────────────
// Users generate these in advance. Each is a one-time token that can reset
// their password (and clear their E2E keys) without admin involvement.

router.get('/recovery-codes/status', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    const db = getDb();
    const count = db.prepare(
      'SELECT COUNT(*) as count FROM account_recovery_codes WHERE user_id = ? AND used = 0'
    ).get(decoded.id);
    res.json({ count: count?.count || 0 });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/recovery-codes/generate', authLimiter, async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) return res.status(400).json({ error: 'Password required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Generate 8 new codes, replacing any existing unused ones
    const codes = generateBackupCodes(8);
    db.prepare('DELETE FROM account_recovery_codes WHERE user_id = ?').run(user.id);
    const insertCode = db.prepare('INSERT INTO account_recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) {
      const hash = await bcrypt.hash(c, 10);
      insertCode.run(user.id, hash);
    }

    console.log(`🔑 Recovery codes generated for "${user.username}" from ${req.ip || 'unknown'}`);
    res.json({ codes });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/recover-account', authLimiter, async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 20);
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

    if (!username || !code || !newPassword) {
      return res.status(400).json({ error: 'Username, recovery code, and new password required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or recovery code' });

    // Find a matching unused code
    const storedCodes = db.prepare(
      'SELECT id, code_hash FROM account_recovery_codes WHERE user_id = ? AND used = 0'
    ).all(user.id);

    let matchedId = null;
    for (const sc of storedCodes) {
      if (await bcrypt.compare(code, sc.code_hash)) {
        matchedId = sc.id;
        break;
      }
    }
    if (!matchedId) return res.status(401).json({ error: 'Invalid username or recovery code' });

    // Mark code used
    db.prepare('UPDATE account_recovery_codes SET used = 1 WHERE id = ?').run(matchedId);

    // Reset password, bump version, clear E2E keys, clear TOTP
    const newHash = await bcrypt.hash(newPassword, 12);
    const newVersion = (user.password_version || 1) + 1;
    db.prepare(`
      UPDATE users SET
        password_hash = ?,
        password_version = ?,
        totp_secret = NULL,
        totp_enabled = 0,
        public_key = NULL,
        encrypted_private_key = NULL,
        e2e_key_salt = NULL,
        e2e_secret = NULL
      WHERE id = ?
    `).run(newHash, newVersion, user.id);
    db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM account_recovery_codes WHERE user_id = ?').run(user.id);

    console.log(`🔑 Account recovery used for "${user.username}" from ${req.ip || 'unknown'} — E2E keys cleared`);
    res.json({ success: true });
  } catch (err) {
    console.error('Account recovery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin Recovery ──────────────────────────────────────
// Allows the server owner to reclaim admin access using their .env credentials.
// This is a last-resort mechanism if the admin gets banned, demoted, or locked out.
// Requires ADMIN_USERNAME and the admin account's password (verified against DB hash).
router.post('/admin-recover', authLimiter, async (req, res) => {
  try {
    const username = sanitizeString(req.body.username, 20);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Only the ADMIN_USERNAME from .env can use this endpoint
    if (username.toLowerCase() !== ADMIN_USERNAME) {
      return res.status(403).json({ error: 'This endpoint is only available for the server admin account' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Restore admin status
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);

    // Remove any active ban on the admin
    db.prepare('DELETE FROM bans WHERE user_id = ?').run(user.id);

    // Remove any active mute on the admin
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(user.id);

    const displayName = user.display_name || user.username;
    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: true, displayName, pwv: user.password_version || 1 },
      JWT_SECRET,
      _sessionSignOptions()
    );

    console.log(`🔑 Admin recovery used for "${user.username}" from ${req.ip || 'unknown'}`);
    res.json({ token, user: { id: user.id, username: user.username, isAdmin: true, displayName } });
  } catch (err) {
    console.error('Admin recovery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, _sessionSignOptions());
}

/**
 * Short-lived token for the account-linking redirects (Steam OpenID, Spotify
 * OAuth). These travel in a URL, which means they can land in browser history,
 * proxy logs, and Referer headers — so they expire in five minutes and carry a
 * 'connect' scope that the session middleware will not accept. Never issue a
 * full session token for a redirect flow.
 */
function generateConnectToken(userId, provider) {
  return jwt.sign({ id: userId, scope: 'connect', provider }, JWT_SECRET, { expiresIn: '5m' });
}

function generateChannelCode() {
  return crypto.randomBytes(4).toString('hex'); // 8-char hex string
}

// ── Encrypted Server List (cross-device sync) ───────────
// Client encrypts/decrypts the server list with the user's password-derived key.
// Server stores only the opaque blob — no visibility into URLs or network graph.

router.get('/user-servers', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = getDb();
    const row = db.prepare('SELECT encrypted_servers FROM users WHERE id = ?').get(decoded.id);
    res.json({ blob: row?.encrypted_servers || null });
  } catch (err) {
    console.error('Get user-servers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/user-servers', express.json({ limit: '96kb' }), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  const blob = typeof req.body.blob === 'string' ? req.body.blob : null;
  if (blob && blob.length > 65536) {
    return res.status(400).json({ error: 'Server list too large' });
  }

  try {
    const db = getDb();
    db.prepare('UPDATE users SET encrypted_servers = ? WHERE id = ?').run(blob, decoded.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Put user-servers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SSO (Sign in with existing Haven server) ───────────
// Allows other Haven servers to pre-fill registration with this user's profile.
// Flow: foreign server opens /SSO?authCode=X → user confirms → foreign server
// calls /SSO/authenticate?authCode=X to retrieve public profile data.

const pendingSSO = new Map();

// Rate limiter for SSO authenticate endpoint (prevents auth code brute-force)
const ssoRateLimitStore = new Map();
function ssoAuthLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxAttempts = 5;

  if (!ssoRateLimitStore.has(ip)) ssoRateLimitStore.set(ip, []);
  const timestamps = ssoRateLimitStore.get(ip).filter(t => now - t < windowMs);
  ssoRateLimitStore.set(ip, timestamps);

  if (timestamps.length >= maxAttempts) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }
  timestamps.push(now);
  next();
}

// Clean up SSO rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ssoRateLimitStore) {
    const fresh = timestamps.filter(t => now - t < 60000);
    if (fresh.length === 0) ssoRateLimitStore.delete(ip);
    else ssoRateLimitStore.set(ip, fresh);
  }
}, 5 * 60 * 1000);

// GET /api/auth/SSO?authCode=X — Consent/authorize page
// The user must be logged in (valid JWT in localStorage). The page is client-rendered
// and reads the token from localStorage to make the approve call.
router.get('/SSO', (req, res) => {
  const authCode = typeof req.query.authCode === 'string' ? req.query.authCode.trim() : '';
  const origin = typeof req.query.origin === 'string' ? req.query.origin.trim().slice(0, 200) : '';
  if (!authCode || authCode.length < 32 || authCode.length > 128) {
    return res.status(400).send('Invalid or missing auth code.');
  }

  const safeAuthCode = authCode.replace(/[^a-fA-F0-9]/g, '');
  const safeOrigin = origin.replace(/[<>"'&]/g, '');

  // Serve a self-contained consent page that reads JWT from localStorage
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Haven SSO</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d0d1a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a2e; border: 1px solid #333; border-radius: 12px; padding: 32px; max-width: 400px; width: 90%; text-align: center; }
    .card h2 { margin-bottom: 8px; font-size: 20px; }
    .card p { color: #aaa; font-size: 14px; margin-bottom: 20px; }
    .origin { color: #6b4fdb; font-weight: 600; word-break: break-all; }
    .info { background: #12122a; border: 1px solid #2a2a4a; border-radius: 8px; padding: 12px; margin-bottom: 20px; text-align: left; font-size: 13px; }
    .info-row { display: flex; justify-content: space-between; padding: 4px 0; }
    .info-label { color: #888; }
    .info-value { color: #e0e0e0; font-weight: 500; }
    .btn { display: inline-block; padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin: 4px; transition: opacity 0.2s; }
    .btn-primary { background: #6b4fdb; color: #fff; }
    .btn-primary:hover { opacity: 0.9; }
    .btn-cancel { background: transparent; color: #888; border: 1px solid #444; }
    .btn-cancel:hover { color: #fff; border-color: #666; }
    .success { display: none; color: #4ade80; font-size: 15px; margin-top: 12px; }
    .not-logged-in { color: #ef4444; }
    .loading { color: #888; }
    .debug { margin-top: 10px; font-size: 12px; color: #8f95b2; word-break: break-word; }
    .debug.error { color: #ef4444; }
    .debug.ok { color: #4ade80; }
  </style>
</head>
<body>
  <div class="card">
    <h2>⬡ Haven SSO</h2>
    <div id="loading" class="loading"><p>Checking login status...</p></div>
    <div id="sso-debug" class="debug">Starting SSO checks...</div>
    <div id="not-logged-in" style="display:none">
      <p class="not-logged-in">You are not logged in to this server.</p>
      <p style="font-size:13px;color:#888;margin-top:8px">Log in first, then try again.</p>
      <button class="btn btn-primary" onclick="window.location.href='/'">Go to Login</button>
    </div>
    <div id="consent" style="display:none">
      <p>Another Haven server wants to use your identity to pre-fill registration.</p>
      ${safeOrigin ? `<p>Requesting server: <span class="origin">${safeOrigin}</span></p>` : ''}
      <div class="info">
        <div class="info-row"><span class="info-label">Username</span><span class="info-value" id="sso-username">—</span></div>
        <div class="info-row"><span class="info-label">Profile picture</span><span class="info-value" id="sso-avatar">—</span></div>
      </div>
      <p style="font-size:12px;color:#666">Your password is <strong>never</strong> shared. Only your username and profile picture.</p>
      <div id="buttons">
        <button class="btn btn-primary" id="approve-btn">Approve</button>
        <button class="btn btn-cancel" onclick="window.close()">Cancel</button>
      </div>
      <p class="success" id="success-msg">✓ Approved! You can close this tab.</p>
    </div>
  </div>
  <script>
    const authCode = '${safeAuthCode}';
    const origin = '${safeOrigin}';
    let approvedProfile = null;

    (async function() {
      const loadingEl = document.getElementById('loading');
      const debugEl = document.getElementById('sso-debug');

      function setDebug(msg, tone = '') {
        if (!debugEl) return;
        debugEl.textContent = msg;
        debugEl.className = 'debug' + (tone ? (' ' + tone) : '');
      }

      function showNotLoggedIn(reason = 'No active login was found on this server.') {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('not-logged-in').style.display = 'block';
        setDebug(reason, 'error');
      }

      function showConsentReady() {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('consent').style.display = 'block';
        setDebug('Login verified. You can approve this SSO request.', 'ok');
      }

      // Safety watchdog: if anything stalls, stop showing an indefinite spinner.
      const bootTimeout = setTimeout(() => {
        if (loadingEl && loadingEl.style.display !== 'none') {
          // If we have a cached user profile, use that instead of failing — server
          // may simply be slow/unreachable for the validate endpoint, but the
          // profile we'll share is already cached locally.
          try {
            const cachedRaw = localStorage.getItem('haven_user');
            const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
            if (cached && cached.username) {
              approvedProfile = {
                username: cached.username,
                displayName: cached.displayName || cached.username,
                profilePicture: cached.avatar || null
              };
              document.getElementById('sso-username').textContent = approvedProfile.displayName || approvedProfile.username;
              document.getElementById('sso-avatar').textContent = cached.avatar ? 'Will be shared' : 'None set';
              showConsentReady();
              setDebug('Using cached profile (validate endpoint did not respond in time).', 'ok');
              return;
            }
          } catch {}
          showNotLoggedIn('SSO check timed out. Try refreshing this page or logging in again.');
        }
      }, 5000);

      let token;
      try {
        setDebug('Reading local login token...');
        token = localStorage.getItem('haven_token');
      } catch {
        // localStorage blocked (third-party cookies, popup restrictions, etc.)
        showNotLoggedIn('Browser storage is blocked in this tab, so Haven cannot read your login token.');
        clearTimeout(bootTimeout);
        return;
      }

      if (!token) {
        showNotLoggedIn('No Haven login token found in this browser profile.');
        clearTimeout(bootTimeout);
        return;
      }

      // Verify token is still valid by calling the server
      try {
        setDebug('Validating token with this server...');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const verifyRes = await fetch('/api/auth/validate', {
          headers: { 'Authorization': 'Bearer ' + token },
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (!verifyRes.ok) {
          showNotLoggedIn('Token validation failed (' + verifyRes.status + '). Please log in again.');
          clearTimeout(bootTimeout);
          return;
        }
        const userData = await verifyRes.json();
        approvedProfile = {
          username: userData.username || '—',
          displayName: userData.displayName || userData.username || '—',
          profilePicture: userData.avatar || null
        };

        document.getElementById('sso-username').textContent = approvedProfile.displayName || approvedProfile.username;
        document.getElementById('sso-avatar').textContent = userData.avatar ? 'Will be shared' : 'None set';
        showConsentReady();
        clearTimeout(bootTimeout);
      } catch {
        // Fall back to localStorage user data if validate endpoint unavailable
        try {
          setDebug('Validate endpoint unavailable. Falling back to local profile data...');
          const userStr = localStorage.getItem('haven_user');
          const user = userStr ? JSON.parse(userStr) : null;
          if (!user) {
            showNotLoggedIn('Could not validate token and no cached local user profile was found.');
            clearTimeout(bootTimeout);
            return;
          }

          approvedProfile = {
            username: user.username || '—',
            displayName: user.displayName || user.username || '—',
            profilePicture: user.avatar || null
          };

          document.getElementById('sso-username').textContent = approvedProfile.displayName || approvedProfile.username;
          document.getElementById('sso-avatar').textContent = user.avatar ? 'Will be shared' : 'None set';
          showConsentReady();
          clearTimeout(bootTimeout);
        } catch {
          showNotLoggedIn('Failed to read cached local profile for SSO consent.');
          clearTimeout(bootTimeout);
          return;
        }
      }

      document.getElementById('approve-btn').addEventListener('click', async () => {
        const btn = document.getElementById('approve-btn');
        btn.disabled = true;
        btn.textContent = 'Approving...';
        try {
          const res = await fetch('/api/auth/SSO/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ authCode, origin })
          });
          if (res.ok) {
            setDebug('Approval stored on home server. Returning profile to requesting server...', 'ok');
            if (origin && window.opener && approvedProfile) {
              try {
                window.opener.postMessage({
                  type: 'haven-sso-approved',
                  authCode,
                  profile: approvedProfile,
                  serverOrigin: window.location.origin
                }, origin);
              } catch {}
            }
            document.getElementById('buttons').style.display = 'none';
            document.getElementById('success-msg').style.display = 'block';
          } else {
            const data = await res.json().catch(() => ({}));
            setDebug(data.error || 'Approval failed on home server.', 'error');
            alert(data.error || 'Failed to approve');
            btn.disabled = false;
            btn.textContent = 'Approve';
          }
        } catch {
          setDebug('Connection error while approving SSO request.', 'error');
          alert('Connection error');
          btn.disabled = false;
          btn.textContent = 'Approve';
        }
      });
    })();
  </script>
</body>
</html>`);
});

// POST /api/auth/SSO/approve — User clicks Approve on consent page
router.post('/SSO/approve', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  const authCode = typeof req.body.authCode === 'string' ? req.body.authCode.trim() : '';
  const origin = typeof req.body.origin === 'string' ? req.body.origin.trim().slice(0, 200) : '';
  if (!authCode || authCode.length < 32) {
    return res.status(400).json({ error: 'Invalid auth code' });
  }

  // Prevent duplicate approvals
  if (pendingSSO.has(authCode)) {
    return res.status(400).json({ error: 'Auth code already used' });
  }

  pendingSSO.set(authCode, { userId: decoded.id, origin, approvedAt: Date.now() });

  // Auto-expire after 60 seconds
  setTimeout(() => pendingSSO.delete(authCode), 60000);

  res.json({ ok: true });
});

// GET /api/auth/SSO/authenticate?authCode=X — Foreign server calls this to retrieve user info
// This is called by the CLIENT on the foreign server, not server-to-server.
router.get('/SSO/authenticate', ssoAuthLimiter, (req, res) => {
  const requestOrigin = req.headers.origin;
  if (requestOrigin) {
    res.set('Access-Control-Allow-Origin', requestOrigin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'false');
  }

  const authCode = typeof req.query.authCode === 'string' ? req.query.authCode.trim() : '';
  if (!authCode) return res.status(400).json({ error: 'Missing auth code' });

  const pending = pendingSSO.get(authCode);
  if (!pending) return res.status(404).json({ error: 'Invalid or expired auth code' });

  // One-time use: delete immediately
  pendingSSO.delete(authCode);

  // If this auth code was issued for a specific origin, mirror it for strictness.
  if (pending.origin) res.set('Access-Control-Allow-Origin', pending.origin);

  const db = getDb();
  const user = db.prepare('SELECT username, avatar, display_name FROM users WHERE id = ?').get(pending.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Build the avatar URL — if it's a relative path, make it absolute
  let avatarUrl = user.avatar || null;
  if (avatarUrl && avatarUrl.startsWith('/')) {
    // The client will need to construct the full URL using the home server address
    // We return it as-is (relative) and the client prepends the server URL
  }

  res.json({
    username: user.username,
    displayName: user.display_name || user.username,
    profilePicture: avatarUrl
  });
});

// CORS preflight for SSO/authenticate (cross-origin requests from foreign Haven clients)
router.options('/SSO/authenticate', (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  res.sendStatus(204);
});

/* ═══════════════════════════════════════════════════════════
   OIDC / SSO  (issue #12)

   Phase 1: sign in through an external provider, creating a Haven account on
   first login. Linking an SSO identity to an existing local account and
   RP-initiated logout are deliberately not here yet.

   The E2E half of this lives entirely in the browser. Haven wraps your private
   key with a key derived from what you type at login, and an SSO user never
   types a password here — so on first login the client asks for a separate
   encryption passphrase and derives from that instead. The server's only part
   is telling the client whether a wrapped key already exists (`e2eReady`); it
   never sees the passphrase, and there is nothing to store for it.
   ═══════════════════════════════════════════════════════════ */

const oidc = require('./oidc');
const { baseUrl } = require('./connectRoutes');

function _oidcRedirectUri(req) {
  return `${baseUrl(req)}/api/auth/oidc/callback`;
}

/**
 * `users.password_hash` is NOT NULL, and rebuilding that table on every
 * existing install just to relax it is not worth the risk. Federated accounts
 * store this sentinel instead. It can never authenticate anyone: bcrypt.compare
 * returns false for any string that is not a real hash (verified), and
 * hasLocalPassword() below rejects it before a comparison is even attempted.
 */
const OIDC_NO_PASSWORD = '!oidc-no-local-password';

/** True only for a real bcrypt hash — every one starts with $2a/$2b/$2y. */
function hasLocalPassword(user) {
  return typeof user.password_hash === 'string' && user.password_hash.startsWith('$2');
}

/** Turn provider claims into a username that satisfies Haven's own rules. */
function _usernameFromClaims(db, claims) {
  const candidates = [
    claims.preferred_username,
    typeof claims.email === 'string' ? claims.email.split('@')[0] : '',
    claims.name,
  ];
  let base = '';
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const cleaned = c.trim().replace(/[^a-zA-Z0-9_]/g, '');
    if (cleaned.length >= 3) { base = cleaned.slice(0, 20); break; }
  }
  // Nothing usable in the claims — fall back to the subject, which always exists.
  if (!base) base = `sso_${String(claims.sub).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
  if (base.length < 3) base = `${base}_sso`;

  const taken = (name) => !!db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(name);
  if (!taken(base)) return base;
  // A directory username can collide with a local account. Suffix rather than
  // adopt the existing account — taking it over would be exactly the account
  // takeover that linking has to ask about explicitly.
  for (let i = 2; i < 1000; i++) {
    const suffix = String(i);
    const candidate = base.slice(0, 20 - suffix.length) + suffix;
    if (!taken(candidate)) return candidate;
  }
  return `sso_${crypto.randomBytes(6).toString('hex')}`;
}

/** Bounce back to the login page with a short reason code. */
function _oidcFail(res, code, err) {
  if (err) console.warn(`[OIDC] ${code}:`, err.message || err);
  res.redirect(`/?oidc_error=${encodeURIComponent(code)}`);
}

// Begin a login. Nothing is trusted from the query string here; the redirect
// URI is derived from the server's own configuration.
router.get('/oidc/start', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) return _oidcFail(res, 'disabled');
  try {
    const { url, state, nonce, verifier } = await oidc.buildAuthorizationUrl(_oidcRedirectUri(req));
    oidc.saveTransaction(state, { nonce, verifier });
    res.redirect(url);
  } catch (err) {
    _oidcFail(res, 'provider_unreachable', err);
  }
});

router.get('/oidc/callback', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) return _oidcFail(res, 'disabled');

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';

  // The provider reports its own refusals here (access_denied when the user
  // cancels at the consent screen, and so on).
  if (typeof req.query.error === 'string' && req.query.error) {
    return _oidcFail(res, req.query.error === 'access_denied' ? 'cancelled' : 'provider_error',
      new Error(String(req.query.error_description || req.query.error)));
  }
  if (!state || !code) return _oidcFail(res, 'bad_callback');

  // Single-use: a replayed callback finds nothing here.
  const tx = oidc.takeTransaction(state);
  if (!tx) return _oidcFail(res, 'expired');

  try {
    const tokens = await oidc.exchangeCode(code, tx.verifier, _oidcRedirectUri(req));
    const claims = await oidc.verifyIdToken(tokens.id_token, tx.nonce);

    const db = getDb();
    const cfg = oidc.getOidcConfig();
    const subject = String(claims.sub);

    let user = db.prepare('SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ?')
      .get(cfg.issuerKey, subject);

    if (!user) {
      if (!cfg.createUsers) return _oidcFail(res, 'no_account');
      const username = _usernameFromClaims(db, claims);
      // Never inherit admin from a directory. ADMIN_USERNAME grants admin on
      // local signup, and honouring that here would let anyone who can pick
      // their own username at the IdP walk in as the server admin.
      const result = db.prepare(
        'INSERT INTO users (username, password_hash, is_admin, oidc_issuer, oidc_subject) VALUES (?, ?, 0, ?, ?)'
      ).run(username, OIDC_NO_PASSWORD, cfg.issuerKey, subject);
      provisionNewUser(db, result.lastInsertRowid, username, req.app.get('io'));
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      console.log(`🔐 OIDC: created account "${username}" for ${cfg.issuerKey} subject ${subject.slice(0, 8)}…`);
    }

    const banned = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (banned) return _oidcFail(res, 'banned');

    // Keep the display name in step with the directory, but never clobber a
    // name the user set inside Haven.
    if (!user.display_name && typeof claims.name === 'string' && claims.name.trim()) {
      try {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?')
          .run(sanitizeString(claims.name, 32), user.id);
      } catch { /* non-critical */ }
    }

    const displayName = user.display_name || user.username;
    const token = generateToken({
      id: user.id, username: user.username, isAdmin: !!user.is_admin,
      displayName, pwv: user.password_version || 1,
    });

    // `e2eReady` decides which passphrase prompt the client shows: a wrapped
    // key already on the server means "enter your passphrase to unlock this
    // device", none means "set one".
    const e2eReady = !!(user.encrypted_private_key && user.e2e_key_salt);
    const handoff = JSON.stringify({
      token,
      user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName },
      e2eReady,
    });

    // Hand the session to the login page through the document body, not the
    // URL. A token in a query string survives in browser history, proxy logs,
    // and Referer headers (same reasoning as generateConnectToken above).
    res.set('Cache-Control', 'no-store');
    // Locked down to exactly what this page uses: one inline script, one
    // inline style, and a data: favicon so the browser does not go asking for
    // one and get refused by default-src.
    res.set('Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:");
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Signing in…</title>
<link rel="icon" href="data:,">
<style>body{background:#0d0d1a}</style></head>
<body>
<script>
  try {
    sessionStorage.setItem('haven_oidc_handoff', ${JSON.stringify(handoff)});
  } catch (e) {}
  location.replace('/?oidc=1');
</script>
</body></html>`);
  } catch (err) {
    _oidcFail(res, 'exchange_failed', err);
  }
});

module.exports = { router, verifyToken, generateChannelCode, generateToken, generateConnectToken, authLimiter };
