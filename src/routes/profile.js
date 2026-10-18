// Profile pictures, picture borders and their fit, avatar shape and animation,
// bot (webhook) avatars, and personas.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { verifyToken } = require('../auth');
const storage = require('../storage');
const { sanitizeBorderTransform } = require('../socketHandlers');

module.exports = function registerProfile(deps) {
  const { uploadDiskGuard, app, recordUploadOwnership, releaseOwnUploads, verifyAdminFromDb, userHasPermission, upload, uploadLimiter } = deps;
  // A picture someone replaced or removed goes once nothing else shows it
  // (releaseOwnUploads in server.js).
  const releaseOld = (url, userId, what) => releaseOwnUploads([url], userId)
    .catch(err => console.warn(`[${what}] Could not release the old picture:`, err.message));
  // Profile pictures, borders and persona avatars share one size limit the
  // admin sets (Settings, Uploads & Limits): 1 to 10 MB, 2 MB by default.
  const avatarMaxMb = () => {
    const { getDb } = require('../database');
    const n = parseInt(getDb().prepare("SELECT value FROM server_settings WHERE key = 'max_avatar_mb'").get()?.value, 10);
    return n >= 1 && n <= 10 ? n : 2;
  };
  // ── Avatar upload endpoint (saves to /uploads, updates DB) ──
  app.post('/api/upload-avatar', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { getDb } = require('../database');
    const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

    upload.single('avatar')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const maxMb = avatarMaxMb();
      if (req.file.size > maxMb * 1024 * 1024) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `Avatar must be under ${maxMb} MB` });
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
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
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
        fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), finalName));
      }
      try { await storage.admitUpload(req.file, finalName); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      const avatarUrl = `/uploads/${finalName}`;

      recordUploadOwnership(user.id, finalName, req.file.size, 'profile');

      // Update the user's avatar in the database
      let oldAvatar = null;
      try {
        const db = getDb();
        oldAvatar = db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.id)?.avatar || null;
        db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, user.id);
        console.log(`[Avatar] ${user.username} uploaded avatar: ${avatarUrl}`);
      } catch (dbErr) {
        console.error('Avatar DB update error:', dbErr);
        return res.status(500).json({ error: 'Failed to save avatar' });
      }
      await releaseOld(oldAvatar, user.id, 'Avatar');

      res.json({ url: avatarUrl });
    });
  });

  // ── Avatar remove endpoint ──
  app.post('/api/remove-avatar', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { getDb } = require('../database');
      const old = getDb().prepare('SELECT avatar FROM users WHERE id = ?').get(user.id)?.avatar || null;
      getDb().prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(user.id);
      await releaseOld(old, user.id, 'Avatar');
      res.json({ ok: true });
    } catch (err) {
      console.error('Avatar remove error:', err);
      res.status(500).json({ error: 'Failed to remove avatar' });
    }
  });

  // ── Border upload endpoint (pfp overlay, mirrors avatar upload) ──
  app.post('/api/upload-border', uploadLimiter, uploadDiskGuard, (req, res) => {
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

    upload.single('border')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const maxMb = avatarMaxMb();
      if (req.file.size > maxMb * 1024 * 1024) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `Border must be under ${maxMb} MB` });
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
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
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
        fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), finalName));
      }
      try { await storage.admitUpload(req.file, finalName); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      const borderUrl = `/uploads/${finalName}`;
      recordUploadOwnership(user.id, finalName, req.file.size, 'profile');

      // Update the user's border in the database
      let oldBorder = null;
      try {
        const db = getDb();
        oldBorder = db.prepare('SELECT border FROM users WHERE id = ?').get(user.id)?.border || null;
        // A new image invalidates the old fit; clear it so no stale transform lingers.
        db.prepare('UPDATE users SET border = ?, border_transform = NULL WHERE id = ?').run(borderUrl, user.id);
        console.log(`[Border] ${user.username} uploaded border: ${borderUrl}`);
      } catch (dbErr) {
        console.error('Border DB update error:', dbErr);
        return res.status(500).json({ error: 'Failed to save border' });
      }
      await releaseOld(oldBorder, user.id, 'Border');

      res.json({ url: borderUrl });
    });
  });

  // ── Border remove endpoint ──
  app.post('/api/remove-border', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { getDb } = require('../database');
      const old = getDb().prepare('SELECT border FROM users WHERE id = ?').get(user.id)?.border || null;
      getDb().prepare('UPDATE users SET border = NULL, border_transform = NULL WHERE id = ?').run(user.id);
      await releaseOld(old, user.id, 'Border');
      res.json({ ok: true });
    } catch (err) {
      console.error('Border remove error:', err);
      res.status(500).json({ error: 'Failed to remove border' });
    }
  });

  // ── Border fit (op log) endpoint ──
  // Stores the pfp-overlay transform as sanitized JSON, mirroring set-avatar-shape.
  app.post('/api/set-border-transform', express.json(), (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const clean = sanitizeBorderTransform(req.body.transform);
    const toStore = (clean && clean.length) ? JSON.stringify(clean) : null;
    try {
      const { getDb } = require('../database');
      getDb().prepare('UPDATE users SET border_transform = ? WHERE id = ?').run(toStore, user.id);
      res.json({ transform: toStore ? clean : null });
    } catch (err) {
      console.error('Border transform error:', err);
      res.status(500).json({ error: 'Failed to save border fit' });
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
      const { getDb } = require('../database');
      getDb().prepare('UPDATE users SET avatar_shape = ? WHERE id = ?').run(shape, user.id);
      res.json({ shape });
    } catch (err) {
      console.error('Avatar shape error:', err);
      res.status(500).json({ error: 'Failed to save shape' });
    }
  });

  // ── Animated-profile policy endpoint ──
  // How this user's animated avatar/border play for everyone, mirroring set-avatar-shape.
  app.post('/api/set-animate-profile', express.json(), (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const valid = ['trigger', 'disabled'];
    const mode = valid.includes(req.body.mode) ? req.body.mode : 'trigger';
    try {
      const { getDb } = require('../database');
      getDb().prepare('UPDATE users SET animate_profile = ? WHERE id = ?').run(mode, user.id);
      res.json({ mode });
    } catch (err) {
      console.error('Animate profile error:', err);
      res.status(500).json({ error: 'Failed to save animation policy' });
    }
  });

  // ── Webhook/Bot avatar upload endpoint ──
  app.post('/api/upload-webhook-avatar', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Admins or users with manage_webhooks permission can upload webhook avatars
    const { getDb } = require('../database');
    const dbUser = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
    if (!dbUser || (!dbUser.is_admin && !userHasPermission(user.id, 'manage_webhooks'))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    upload.single('avatar')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
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
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
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
        fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), finalName));
      }
      try { await storage.admitUpload(req.file, finalName); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      const avatarUrl = `/uploads/${finalName}`;

      // Update the webhook's avatar in DB
      const webhookId = parseInt(req.body?.webhookId || req.query?.webhookId);
      if (!isNaN(webhookId)) {
        try {
          // Only a bot of their own, or any bot for the admin, the same rule
          // as editing a bot's other details.
          getDb().prepare('UPDATE webhooks SET avatar_url = ? WHERE id = ? AND (created_by = ? OR ?)')
            .run(avatarUrl, webhookId, user.id, verifyAdminFromDb(user) ? 1 : 0);
        } catch (dbErr) {
          console.error('Webhook avatar DB error:', dbErr);
        }
      }
      res.json({ url: avatarUrl });
    });
  });

  // ── Personas (proxy feature) (#86, #5349) ─────────────────
  // CRUD + avatar upload for per-user personas. Triggered in chat with
  // "PersonaName: message" (handled by send-message socket handler).
  app.get('/api/personas', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { getDb } = require('../database');
      const rows = getDb().prepare(
        'SELECT id, name, avatar, bio, created_at FROM user_personas WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC'
      ).all(user.id);
      res.json({ personas: rows });
    } catch (err) {
      console.error('GET /api/personas error:', err);
      res.status(500).json({ error: 'Failed to load personas' });
    }
  });

  const _validatePersonaName = (raw) => {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length < 1 || trimmed.length > 32) return null;
    // Disallow ":" and control/newline chars (the trigger uses "Name:")
    if (/[\u0000-\u001F:\n\r]/.test(trimmed)) return null;
    return trimmed;
  };

  app.post('/api/personas', express.json(), (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const name = _validatePersonaName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Persona name must be 1-32 chars and may not contain ":" or line breaks' });
    const bio = typeof req.body?.bio === 'string' ? req.body.bio.slice(0, 190) : null;
    const avatar = typeof req.body?.avatar === 'string' && req.body.avatar.startsWith('/uploads/')
      ? req.body.avatar : null;
    try {
      const { getDb } = require('../database');
      const db = getDb();
      // Cap personas per user to keep abuse / accidental spam in check.
      const count = db.prepare('SELECT COUNT(*) as c FROM user_personas WHERE user_id = ?').get(user.id).c;
      if (count >= 25) return res.status(400).json({ error: 'Persona limit reached (25 max)' });
      // Block names that collide with real usernames to prevent impersonation.
      const collision = db.prepare(
        'SELECT id FROM users WHERE username = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE'
      ).get(name, name);
      if (collision) return res.status(400).json({ error: 'That name is already taken by a real user' });
      const result = db.prepare(
        'INSERT INTO user_personas (user_id, name, avatar, bio) VALUES (?, ?, ?, ?)'
      ).run(user.id, name, avatar, bio);
      const row = db.prepare(
        'SELECT id, name, avatar, bio, created_at FROM user_personas WHERE id = ?'
      ).get(result.lastInsertRowid);
      res.json({ persona: row });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(400).json({ error: 'You already have a persona with that name' });
      }
      console.error('POST /api/personas error:', err);
      res.status(500).json({ error: 'Failed to create persona' });
    }
  });

  app.patch('/api/personas/:id', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const { getDb } = require('../database');
      const db = getDb();
      const persona = db.prepare('SELECT id, avatar FROM user_personas WHERE id = ? AND user_id = ?').get(id, user.id);
      if (!persona) return res.status(404).json({ error: 'Persona not found' });

      const updates = [];
      const vals = [];
      if (req.body?.name !== undefined) {
        const name = _validatePersonaName(req.body.name);
        if (!name) return res.status(400).json({ error: 'Persona name must be 1-32 chars and may not contain ":" or line breaks' });
        const collision = db.prepare(
          'SELECT id FROM users WHERE username = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE'
        ).get(name, name);
        if (collision) return res.status(400).json({ error: 'That name is already taken by a real user' });
        updates.push('name = ?'); vals.push(name);
      }
      if (req.body?.avatar !== undefined) {
        const avatar = req.body.avatar === null ? null
          : (typeof req.body.avatar === 'string' && req.body.avatar.startsWith('/uploads/') ? req.body.avatar : null);
        updates.push('avatar = ?'); vals.push(avatar);
      }
      if (req.body?.bio !== undefined) {
        const bio = req.body.bio === null ? null
          : (typeof req.body.bio === 'string' ? req.body.bio.slice(0, 190) : null);
        updates.push('bio = ?'); vals.push(bio);
      }
      if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
      vals.push(id, user.id);
      db.prepare(`UPDATE user_personas SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
      const row = db.prepare(
        'SELECT id, name, avatar, bio, created_at FROM user_personas WHERE id = ?'
      ).get(id);
      if (persona.avatar && persona.avatar !== row.avatar) await releaseOld(persona.avatar, user.id, 'Persona');
      res.json({ persona: row });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(400).json({ error: 'You already have a persona with that name' });
      }
      console.error('PATCH /api/personas/:id error:', err);
      res.status(500).json({ error: 'Failed to update persona' });
    }
  });

  app.delete('/api/personas/:id', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const { getDb } = require('../database');
      const old = getDb().prepare('SELECT avatar FROM user_personas WHERE id = ? AND user_id = ?').get(id, user.id)?.avatar || null;
      getDb().prepare('DELETE FROM user_personas WHERE id = ? AND user_id = ?').run(id, user.id);
      await releaseOld(old, user.id, 'Persona');
      res.json({ ok: true });
    } catch (err) {
      console.error('DELETE /api/personas/:id error:', err);
      res.status(500).json({ error: 'Failed to delete persona' });
    }
  });

  // Persona avatar upload: same validation as user avatar (size limit, magic-byte check)
  app.post('/api/upload-persona-avatar', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { getDb } = require('../database');
    const ban = getDb().prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (ban) return res.status(403).json({ error: 'Banned users cannot upload' });

    upload.single('avatar')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const maxMb = avatarMaxMb();
      if (req.file.size > maxMb * 1024 * 1024) {
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
        return res.status(400).json({ error: `Avatar must be under ${maxMb} MB` });
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
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
        return res.status(400).json({ error: 'Failed to validate file' });
      }
      const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
      const safeExt = mimeToExt[req.file.mimetype];
      if (!safeExt) {
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
        return res.status(400).json({ error: 'Invalid file type' });
      }
      const currentExt = path.extname(req.file.filename).toLowerCase();
      let finalName = req.file.filename;
      if (currentExt !== safeExt) {
        finalName = req.file.filename.replace(/\.[^.]+$/, '') + safeExt;
        fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), finalName));
      }
      try { await storage.admitUpload(req.file, finalName); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      const avatarUrl = `/uploads/${finalName}`;
      recordUploadOwnership(user.id, finalName, req.file.size, 'profile');

      // Optional: if a personaId is supplied, persist immediately (verifying ownership).
      const personaId = parseInt(req.body?.personaId || req.query?.personaId);
      if (Number.isFinite(personaId)) {
        try {
          const persona = getDb().prepare(
            'SELECT id, avatar FROM user_personas WHERE id = ? AND user_id = ?'
          ).get(personaId, user.id);
          if (!persona) {
            await storage.remove(finalName);
            return res.status(403).json({ error: 'Not your persona' });
          }
          getDb().prepare('UPDATE user_personas SET avatar = ? WHERE id = ?').run(avatarUrl, personaId);
          if (persona.avatar && persona.avatar !== avatarUrl) await releaseOld(persona.avatar, user.id, 'Persona');
        } catch (dbErr) {
          console.error('Persona avatar DB error:', dbErr);
          return res.status(500).json({ error: 'Failed to save avatar' });
        }
      }
      res.json({ url: avatarUrl });
    });
  });

};
