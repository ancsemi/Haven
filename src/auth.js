const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('./database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Check your .env file or let server.js auto-generate it.');
  process.exit(1);
}
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

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

// ── Input Sanitization ──────────────────────────────────
function sanitizeString(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// ── Register ──────────────────────────────────────────────
router.post('/register', async (req, res) => {
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

    // Whitelist check — if enabled, only pre-approved usernames can register
    const wlSetting = db.prepare("SELECT value FROM server_settings WHERE key = 'whitelist_enabled'").get();
    if (wlSetting && wlSetting.value === 'true') {
      const onList = db.prepare('SELECT 1 FROM whitelist WHERE username = ?').get(username);
      if (!onList) {
        return res.status(403).json({ error: 'Registration is restricted. Your username is not on the whitelist.' });
      }
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Registration could not be completed' });
    }

    const hash = await bcrypt.hash(password, 12);
    const isAdmin = username.toLowerCase() === ADMIN_USERNAME ? 1 : 0;

    // Generate a per-account E2E secret for persistent key wrapping
    const e2eSecret = crypto.randomBytes(32).toString('hex');

    const result = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin, e2e_secret) VALUES (?, ?, ?, ?)'
    ).run(username, hash, isAdmin, e2eSecret);

    // Auto-assign default "User" role to new users
    try {
      const defaultRole = db.prepare("SELECT id FROM roles WHERE name = 'User' AND level = 1 AND scope = 'server'").get();
      if (defaultRole) {
        db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)')
          .run(result.lastInsertRowid, defaultRole.id);
      }
    } catch { /* non-critical */ }

    const token = jwt.sign(
      { id: result.lastInsertRowid, username, isAdmin: !!isAdmin, displayName: username },
      JWT_SECRET,
      { expiresIn: '7d' }
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
      user: { id: result.lastInsertRowid, username, isAdmin: !!isAdmin, displayName: username, e2eSecret }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Login ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
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

    // Check if user is banned
    const ban = db.prepare('SELECT reason FROM bans WHERE user_id = ?').get(user.id);
    if (ban) {
      return res.status(403).json({ error: 'You have been banned from this server' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Sync admin status from .env (handles ADMIN_USERNAME changes between restarts)
    const shouldBeAdmin = user.username.toLowerCase() === ADMIN_USERNAME ? 1 : 0;
    if (user.is_admin !== shouldBeAdmin) {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(shouldBeAdmin, user.id);
      user.is_admin = shouldBeAdmin;
    }

    const displayName = user.display_name || user.username;

    // Ensure the user has an E2E secret (generate on first login after migration)
    let e2eSecret = user.e2e_secret;
    if (!e2eSecret) {
      e2eSecret = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE users SET e2e_secret = ? WHERE id = ?').run(e2eSecret, user.id);
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName },
      JWT_SECRET,
      { expiresIn: '7d' }
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
      user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName, e2eSecret }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Change Password ──────────────────────────────────────
router.post('/change-password', async (req, res) => {
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

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

    // Issue a fresh token so the session stays alive
    const freshToken = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName: user.display_name || user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ message: 'Password changed successfully', token: freshToken });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Helpers ───────────────────────────────────────────────
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function generateChannelCode() {
  return crypto.randomBytes(4).toString('hex'); // 8-char hex string
}

module.exports = { router, verifyToken, generateChannelCode, generateToken, authLimiter };
