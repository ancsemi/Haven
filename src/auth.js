const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('./database');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Check your .env file or let server.js auto-generate it.');
  process.exit(1);
}
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

// ── TOTP helpers ─────────────────────────────────────────
// Short-lived tokens for the TOTP verification step (not full session tokens)
function generateTotpChallengeToken(userId) {
  return jwt.sign({ id: userId, purpose: 'totp_challenge' }, JWT_SECRET, { expiresIn: '5m' });
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

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Registration could not be completed' });
    }

    const hash = await bcrypt.hash(password, 12);
    const isAdmin = username.toLowerCase() === ADMIN_USERNAME ? 1 : 0;

    const result = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)'
    ).run(username, hash, isAdmin);

    // Auto-assign roles flagged as auto_assign to new users
    try {
      const autoRoles = db.prepare("SELECT id FROM roles WHERE auto_assign = 1 AND scope = 'server'").all();
      const insertRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
      for (const role of autoRoles) {
        insertRole.run(result.lastInsertRowid, role.id);
        // Grant linked channel access for this role (fixes #79)
        try {
          const r = db.prepare('SELECT link_channel_access FROM roles WHERE id = ?').get(role.id);
          if (r && r.link_channel_access) {
            const grantChannels = db.prepare(
              'SELECT channel_id FROM role_channel_access WHERE role_id = ? AND grant_on_promote = 1'
            ).all(role.id);
            const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
            for (const ch of grantChannels) ins.run(ch.channel_id, result.lastInsertRowid);
          }
        } catch { /* non-critical */ }
      }
    } catch { /* non-critical */ }

    const token = jwt.sign(
      { id: result.lastInsertRowid, username, isAdmin: !!isAdmin, displayName: username, pwv: 1 },
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
      user: { id: result.lastInsertRowid, username, isAdmin: !!isAdmin, displayName: username }
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
      const challengeToken = generateTotpChallengeToken(user.id);
      return res.json({ requiresTOTP: true, challengeToken });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName, pwv: user.password_version || 1 },
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
      user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Validate (second step of login) ─────────────────
router.post('/totp/validate', async (req, res) => {
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

    const displayName = user.display_name || user.username;
    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName, pwv: user.password_version || 1 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName }
    });
  } catch (err) {
    console.error('TOTP validate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── TOTP Setup (generate secret + QR) ────────────────────
router.post('/totp/setup', async (req, res) => {
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
router.post('/totp/verify-setup', async (req, res) => {
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
      { expiresIn: '7d' }
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
router.post('/totp/disable', async (req, res) => {
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
    const newPwv = (user.password_version || 1) + 1;
    db.prepare('UPDATE users SET password_hash = ?, password_version = ? WHERE id = ?').run(hash, newPwv, user.id);

    // Issue a fresh token so the session stays alive
    const freshToken = jwt.sign(
      { id: user.id, username: user.username, isAdmin: !!user.is_admin, displayName: user.display_name || user.username, pwv: newPwv },
      JWT_SECRET,
      { expiresIn: '7d' }
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
router.post('/verify-password', async (req, res) => {
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
      { expiresIn: '7d' }
    );

    console.log(`🔑 Admin recovery used for "${user.username}" from ${req.ip || 'unknown'}`);
    res.json({ token, user: { id: user.id, username: user.username, isAdmin: true, displayName } });
  } catch (err) {
    console.error('Admin recovery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
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

router.put('/user-servers', async (req, res) => {
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

module.exports = { router, verifyToken, generateChannelCode, generateToken, authLimiter };
