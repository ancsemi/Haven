'use strict';

const path = require('path');
const fs   = require('fs');
const { utcStamp, isString, isInt, sanitizeText, isValidUploadPath } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, getChannelRoleChain, userHasPermission,
          emitOnlineUsers, broadcastVoiceUsers, generateToken,
          touchVoiceActivity, DATA_DIR } = ctx;
  const { channelUsers, voiceUsers } = state;

  // ── Rename (display name) ───────────────────────────────
  socket.on('rename-user', (data) => {
    if (!data || typeof data !== 'object') return;
    const newName = typeof data.username === 'string' ? data.username.trim().replace(/\s+/g, ' ') : '';

    if (!newName || newName.length < 2 || newName.length > 20) {
      return socket.emit('error-msg', 'Display name must be 2-20 characters');
    }
    if (!/^[a-zA-Z0-9_ ]+$/.test(newName)) {
      return socket.emit('error-msg', 'Letters, numbers, underscores, and spaces only');
    }

    try {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(newName, socket.user.id);
    } catch (err) {
      console.error('Rename error:', err);
      return socket.emit('error-msg', 'Failed to update display name');
    }

    const oldName = socket.user.displayName;
    socket.user.displayName = newName;

    const newToken = generateToken({
      id: socket.user.id,
      username: socket.user.username,
      isAdmin: socket.user.isAdmin,
      displayName: newName
    });

    for (const [code, users] of channelUsers) {
      if (users.has(socket.user.id)) {
        users.get(socket.user.id).username = newName;
        emitOnlineUsers(code);
      }
    }

    for (const [code, users] of voiceUsers) {
      if (users.has(socket.user.id)) {
        users.get(socket.user.id).username = newName;
        broadcastVoiceUsers(code);
      }
    }

    socket.emit('renamed', {
      token: newToken,
      user: { id: socket.user.id, username: socket.user.username, isAdmin: socket.user.isAdmin, displayName: newName },
      oldName
    });

    if (socket.currentChannel) {
      socket.to(`channel:${socket.currentChannel}`).emit('user-renamed', {
        channelCode: socket.currentChannel,
        oldName,
        newName
      });
    }

    // Notify all DM partners so their sidebar updates the display name
    try {
      const dmPartners = db.prepare(`
        SELECT DISTINCT cm2.user_id FROM channel_members cm1
        JOIN channels c ON c.id = cm1.channel_id AND c.is_dm = 1
        JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.user_id != ?
        WHERE cm1.user_id = ?
      `).all(socket.user.id, socket.user.id);

      for (const partner of dmPartners) {
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === partner.user_id) {
            s.emit('dm-name-updated', { userId: socket.user.id, newName });
          }
        }
      }
    } catch (err) {
      console.error('DM name update broadcast error:', err);
    }

    console.log(`✏️  ${oldName} renamed to ${newName}`);
  });

  // ── Avatar ──────────────────────────────────────────────
  socket.on('set-avatar', (data) => {
    if (!data || typeof data !== 'object') return;
    const url = typeof data.url === 'string' ? data.url.trim() : '';
    if (url && !isValidUploadPath(url)) return;
    socket.user.avatar = url || null;
    console.log(`[Avatar] ${socket.user.username} broadcast avatar: ${url || '(removed)'}`);
    for (const [code, users] of channelUsers) {
      if (users.has(socket.user.id)) {
        users.get(socket.user.id).avatar = url || null;
        emitOnlineUsers(code);
      }
    }
  });

  socket.on('set-avatar-shape', (data) => {
    if (!data || typeof data !== 'object') return;
    const validShapes = ['circle', 'rounded', 'squircle', 'hex', 'diamond'];
    const shape = validShapes.includes(data.shape) ? data.shape : 'circle';
    try {
      db.prepare('UPDATE users SET avatar_shape = ? WHERE id = ?').run(shape, socket.user.id);
      socket.user.avatar_shape = shape;
      console.log(`[Avatar] ${socket.user.username} set shape: ${shape}`);
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          users.get(socket.user.id).avatar_shape = shape;
          emitOnlineUsers(code);
        }
      }
      socket.emit('avatar-shape-updated', { shape });
    } catch (err) {
      console.error('Set avatar shape error:', err);
    }
  });

  // ── Status ──────────────────────────────────────────────
  socket.on('set-status', (data) => {
    if (!data || typeof data !== 'object') return;
    const validStatuses = ['online', 'away', 'dnd', 'invisible'];
    const status = validStatuses.includes(data.status) ? data.status : 'online';
    const statusText = isString(data.statusText, 0, 128) ? data.statusText.trim() : '';

    try {
      db.prepare('UPDATE users SET status = ?, status_text = ? WHERE id = ?')
        .run(status, statusText, socket.user.id);
    } catch (err) {
      console.error('Set status error:', err);
      return;
    }

    socket.user.status = status;
    socket.user.statusText = statusText;

    for (const [code, users] of channelUsers) {
      if (users.has(socket.user.id)) {
        users.get(socket.user.id).status = status;
        users.get(socket.user.id).statusText = statusText;
        emitOnlineUsers(code);
      }
    }

    socket.emit('status-updated', { status, statusText });
  });

  // ── Profile ─────────────────────────────────────────────
  socket.on('get-user-profile', (data) => {
    if (!data || typeof data.userId !== 'number') return;
    try {
      const row = db.prepare(
        `SELECT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
                u.avatar, u.avatar_shape, u.status, u.status_text, u.bio, u.created_at
         FROM users u WHERE u.id = ?`
      ).get(data.userId);
      if (!row) return;

      const roles = db.prepare(
        `SELECT DISTINCT r.id, r.name, r.level, r.color
         FROM roles r
         JOIN user_roles ur ON r.id = ur.role_id
         WHERE ur.user_id = ? AND ur.channel_id IS NULL
         GROUP BY r.id
         ORDER BY r.level DESC`
      ).all(data.userId);

      const currentChannelCode = socket.currentChannel;
      if (currentChannelCode) {
        const ch = db.prepare('SELECT id FROM channels WHERE code = ?').get(currentChannelCode);
        if (ch) {
          const chain = getChannelRoleChain(ch.id);
          if (chain.length > 0) {
            const placeholders = chain.map(() => '?').join(',');
            const channelRoles = db.prepare(
              `SELECT DISTINCT r.id, r.name, COALESCE(ur.custom_level, r.level) as level, r.color
               FROM roles r
               JOIN user_roles ur ON r.id = ur.role_id
               WHERE ur.user_id = ? AND ur.channel_id IN (${placeholders})
               GROUP BY r.id
               ORDER BY r.level DESC`
            ).all(data.userId, ...chain);
            const existingIds = new Set(roles.map(r => r.id));
            for (const cr of channelRoles) {
              if (!existingIds.has(cr.id)) {
                roles.push(cr);
                existingIds.add(cr.id);
              }
            }
            roles.sort((a, b) => b.level - a.level);
          }
        }
      }

      const isAdmin = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(data.userId);
      if (isAdmin && isAdmin.is_admin) {
        roles.length = 0;
        roles.push({ id: -1, name: 'Admin', level: 100, color: '#e74c3c' });
      } else if (roles.length > 1) {
        const userRoleIdx = roles.findIndex(r => r.name === 'User' && r.level <= 1);
        if (userRoleIdx !== -1) roles.splice(userRoleIdx, 1);
      }

      let isOnline = false;
      for (const [, s] of io.of('/').sockets) {
        if (s.user && s.user.id === data.userId) { isOnline = true; break; }
      }

      socket.emit('user-profile', {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        avatar: row.avatar || null,
        avatarShape: row.avatar_shape || 'circle',
        status: row.status || 'online',
        statusText: row.status_text || '',
        bio: row.bio || '',
        roles: roles,
        online: isOnline,
        createdAt: row.created_at
      });
    } catch (err) {
      console.error('Get user profile error:', err);
    }
  });

  socket.on('set-bio', (data) => {
    if (!data || typeof data.bio !== 'string') return;
    const bio = sanitizeText(data.bio.trim().slice(0, 190));
    try {
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, socket.user.id);
      socket.emit('bio-updated', { bio });
    } catch (err) {
      console.error('Set bio error:', err);
    }
  });

  // ── Push Notifications ──────────────────────────────────
  socket.on('push-subscribe', (data) => {
    if (!data || typeof data !== 'object') return;
    const { endpoint, keys } = data;
    if (typeof endpoint !== 'string' || !endpoint) return;
    if (!keys || typeof keys !== 'object') return;
    if (typeof keys.p256dh !== 'string' || !keys.p256dh) return;
    if (typeof keys.auth !== 'string' || !keys.auth) return;

    try { const u = new URL(endpoint); if (u.protocol !== 'https:') return; } catch { return; }

    try {
      db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
      `).run(socket.user.id, endpoint, keys.p256dh, keys.auth);
      socket.emit('push-subscribed');
    } catch (err) {
      console.error('Push subscribe error:', err);
    }
  });

  socket.on('push-unsubscribe', (data) => {
    if (!data || typeof data !== 'object') return;
    const endpoint = typeof data.endpoint === 'string' ? data.endpoint : '';
    if (!endpoint) return;

    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .run(socket.user.id, endpoint);
      socket.emit('push-unsubscribed');
    } catch (err) {
      console.error('Push unsubscribe error:', err);
    }
  });

  // ── FCM Tokens ──────────────────────────────────────────
  socket.on('register-fcm-token', (data) => {
    if (!data || typeof data.token !== 'string' || !data.token.trim()) return;
    try {
      db.prepare(`
        INSERT INTO fcm_tokens (user_id, token)
        VALUES (?, ?)
        ON CONFLICT(user_id, token) DO NOTHING
      `).run(socket.user.id, data.token.trim());
    } catch (err) {
      console.error('FCM token register error:', err);
    }
  });

  socket.on('unregister-fcm-token', (data) => {
    if (!data || typeof data.token !== 'string') return;
    try {
      db.prepare('DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?')
        .run(socket.user.id, data.token.trim());
    } catch (err) {
      console.error('FCM token unregister error:', err);
    }
  });

  // ── E2E Public Key Exchange ─────────────────────────────
  socket.on('publish-public-key', (data) => {
    if (!data || typeof data !== 'object') return;
    const jwk = data.jwk;
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
      return socket.emit('error-msg', 'Invalid public key format');
    }
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    try {
      const current = db.prepare('SELECT public_key FROM users WHERE id = ?').get(socket.user.id);
      let keyChanged = false;
      if (current && current.public_key && !data.force) {
        const existing = JSON.parse(current.public_key);
        if (existing.x !== publicJwk.x || existing.y !== publicJwk.y) {
          console.warn(`[E2E] User ${socket.user.id} (${socket.user.username}) tried to overwrite public key — blocked`);
          socket.emit('public-key-conflict', { existing });
          return;
        }
      } else if (current && current.public_key) {
        const existing = JSON.parse(current.public_key);
        keyChanged = existing.x !== publicJwk.x || existing.y !== publicJwk.y;
      }
      db.prepare('UPDATE users SET public_key = ? WHERE id = ?')
        .run(JSON.stringify(publicJwk), socket.user.id);
      socket.emit('public-key-published');

      if (keyChanged) {
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === socket.user.id && s !== socket) {
            s.emit('e2e-key-sync');
          }
        }

        const dmPartners = db.prepare(`
          SELECT DISTINCT cm2.user_id FROM channel_members cm1
          JOIN channels c ON c.id = cm1.channel_id AND c.is_dm = 1
          JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.user_id != ?
          WHERE cm1.user_id = ?
        `).all(socket.user.id, socket.user.id);

        for (const partner of dmPartners) {
          for (const [, s] of io.sockets.sockets) {
            if (s.user && s.user.id === partner.user_id) {
              s.emit('public-key-result', { userId: socket.user.id, jwk: publicJwk });
            }
          }
        }
        console.log(`[E2E] Notified ${dmPartners.length} DM partner(s) + other sessions of key change for user ${socket.user.id}`);
      }
    } catch (err) {
      console.error('Publish public key error:', err);
      socket.emit('error-msg', 'Failed to store public key');
    }
  });

  socket.on('get-public-key', (data) => {
    if (!data || typeof data !== 'object') return;
    const userId = typeof data.userId === 'number' ? data.userId : parseInt(data.userId);
    if (!userId || isNaN(userId)) return;

    const row = db.prepare('SELECT public_key FROM users WHERE id = ?').get(userId);
    const jwk = row && row.public_key ? JSON.parse(row.public_key) : null;
    socket.emit('public-key-result', { userId, jwk });
  });

  // ── E2E Encrypted Private Key Storage ───────────────────
  socket.on('store-encrypted-key', (data) => {
    if (!data || typeof data !== 'object') return;
    const { encryptedKey, salt } = data;
    if (typeof encryptedKey !== 'string' || typeof salt !== 'string') {
      return socket.emit('error-msg', 'Invalid encrypted key data');
    }
    if (encryptedKey.length > 4096 || salt.length > 128) {
      return socket.emit('error-msg', 'Encrypted key data too large');
    }
    try {
      db.prepare('UPDATE users SET encrypted_private_key = ?, e2e_key_salt = ? WHERE id = ?')
        .run(encryptedKey, salt, socket.user.id);
      socket.emit('encrypted-key-stored');
    } catch (err) {
      console.error('Store encrypted key error:', err);
      socket.emit('error-msg', 'Failed to store encrypted key');
    }
  });

  socket.on('get-encrypted-key', () => {
    try {
      const row = db.prepare('SELECT encrypted_private_key, e2e_key_salt, public_key FROM users WHERE id = ?')
        .get(socket.user.id);
      const hasBackup = !!(row && row.encrypted_private_key && row.e2e_key_salt);
      // Forward just the pub-key JWK (x,y) so clients can detect
      // local-vs-server divergence without an extra round-trip. Additive:
      // legacy clients ignore it.
      let publicKey = null;
      if (row && row.public_key) {
        try {
          const parsed = typeof row.public_key === 'string' ? JSON.parse(row.public_key) : row.public_key;
          if (parsed && parsed.x && parsed.y) publicKey = { kty: parsed.kty, crv: parsed.crv, x: parsed.x, y: parsed.y };
        } catch { /* stored pub key not JSON — skip */ }
      }
      socket.emit('encrypted-key-result', {
        encryptedKey: row?.encrypted_private_key || null,
        salt: row?.e2e_key_salt || null,
        hasPublicKey: !!(row && row.public_key),
        publicKey,
        state: hasBackup ? 'present' : 'empty'
      });
    } catch (err) {
      console.error('Get encrypted key error:', err);
      socket.emit('encrypted-key-result', { encryptedKey: null, salt: null, hasPublicKey: false, publicKey: null, state: 'error' });
    }
  });

  // ── Preferences ─────────────────────────────────────────
  socket.on('get-preferences', () => {
    const rows = db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?').all(socket.user.id);
    const prefs = {};
    rows.forEach(r => { prefs[r.key] = r.value; });
    socket.emit('preferences', prefs);
  });

  socket.on('set-preference', (data) => {
    if (!data || typeof data !== 'object') return;
    const key = typeof data.key === 'string' ? data.key.trim() : '';
    const value = typeof data.value === 'string' ? data.value.trim() : '';

    const allowedKeys = ['theme'];
    if (!allowedKeys.includes(key) || !value || value.length > 50) return;

    db.prepare(
      'INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)'
    ).run(socket.user.id, key, value);

    socket.emit('preference-saved', { key, value });
  });

  // ── High Scores ─────────────────────────────────────────
  socket.on('submit-high-score', (data) => {
    if (!data || typeof data !== 'object') return;
    const game = typeof data.game === 'string' ? data.game.trim() : '';
    const score = isInt(data.score) && data.score >= 0 ? data.score : 0;
    if (!game || !/^[a-z0-9_-]{1,32}$/.test(game)) return;

    const current = db.prepare(
      'SELECT score FROM high_scores WHERE user_id = ? AND game = ?'
    ).get(socket.user.id, game);

    if (!current || score > current.score) {
      db.prepare(
        'INSERT OR REPLACE INTO high_scores (user_id, game, score, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
      ).run(socket.user.id, game, score);

      if (socket.currentChannel) {
        io.to(socket.currentChannel).emit('new-high-score', {
          username: socket.user.displayName,
          game,
          score,
          previous: current ? current.score : 0
        });
      }
    }

    const leaderboard = db.prepare(`
      SELECT hs.user_id, COALESCE(u.display_name, u.username) as username, hs.score
      FROM high_scores hs JOIN users u ON hs.user_id = u.id
      WHERE hs.game = ? AND hs.score > 0
      ORDER BY hs.score DESC LIMIT 50
    `).all(game);
    io.emit('high-scores', { game, leaderboard });
  });

  socket.on('get-high-scores', (data) => {
    if (!data || typeof data !== 'object') return;
    const game = typeof data.game === 'string' ? data.game.trim() : 'flappy';
    const leaderboard = db.prepare(`
      SELECT hs.user_id, COALESCE(u.display_name, u.username) as username, hs.score
      FROM high_scores hs JOIN users u ON hs.user_id = u.id
      WHERE hs.game = ? AND hs.score > 0
      ORDER BY hs.score DESC LIMIT 50
    `).all(game);
    socket.emit('high-scores', { game, leaderboard });
  });

  // ── Android Beta Signup ─────────────────────────────────
  socket.on('android-beta-signup', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (!data || !data.email || typeof data.email !== 'string') {
      return callback({ ok: false, error: 'Invalid email.' });
    }
    const email = data.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      return callback({ ok: false, error: 'Invalid email address.' });
    }

    try {
      const filePath = path.join(DATA_DIR, 'beta-signups.json');
      let signups = [];
      try { signups = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* first signup */ }

      if (signups.some(s => s.email === email)) {
        return callback({ ok: true });
      }

      signups.push({
        email,
        username: socket.user.username,
        date: new Date().toISOString()
      });
      fs.writeFileSync(filePath, JSON.stringify(signups, null, 2));
      console.log(`📱 Android beta signup: ${email} (${socket.user.username})`);
      callback({ ok: true });
    } catch (err) {
      console.error('Beta signup error:', err);
      callback({ ok: false, error: 'Server error — try again later.' });
    }
  });
};
