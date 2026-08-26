'use strict';

const path = require('path');
const fs   = require('fs');
const { utcStamp, isString, isInt, sanitizeText, isValidUploadPath, normalizeDisplayName, sanitizeBorderTransform, parseBorderTransform } = require('./helpers');
const { generateConnectToken } = require('../auth');
const { setEnvValue, clearEnvValue, isWritableKey } = require('../envStore');

module.exports = function register(socket, ctx) {
  const { io, db, state, getChannelRoleChain, userHasPermission, getUserEffectiveLevel,
          emitOnlineUsers, broadcastVoiceUsers, generateToken,
          touchVoiceActivity, enforceAutomod, DATA_DIR, logAudit, getAdminRoleDisplay } = ctx;
  const { channelUsers, voiceUsers } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};

  // ── Rename (display name) ───────────────────────────────
  socket.on('rename-user', (data) => {
    if (!data || typeof data !== 'object') return;
    const checked = normalizeDisplayName(typeof data.username === 'string' ? data.username : '');
    if (checked.error) return socket.emit('error-msg', checked.error);
    const newName = checked.value;

    // (#5482) A moderator-set display name holds. Otherwise the whole
    // Manage Display Names permission is decorative — the moderated user
    // renames themselves straight back and nothing has been moderated.
    // Cleared when a moderator resets them to their username. Admins are
    // never locked, so nobody can end up permanently stuck with a name.
    if (!socket.user.isAdmin) {
      const lock = db.prepare('SELECT display_name_locked FROM users WHERE id = ?').get(socket.user.id);
      if (lock && lock.display_name_locked) {
        return socket.emit('error-msg', 'A moderator set your display name — you cannot change it yourself');
      }
    }

    // The charset still rules out dots, so a display name cannot carry a
    // working URL. Run it through automod anyway so the deny-list can be
    // used to reserve impersonation-prone names (e.g. "Admin", "Moderator"),
    // which is also the only answer to homoglyph lookalikes (#5509).
    if (enforceAutomod(newName, { surface: 'profile' })) return;

    // Reject if another user on this server already uses this display name
    // (case-insensitive). Mentions resolve by login username, but allowing
    // duplicate display names produced confusing sidebars where two people
    // appeared identical.
    try {
      const conflict = db.prepare(`
        SELECT id FROM users
        WHERE id != ?
          AND (LOWER(display_name) = LOWER(?)
               OR (display_name IS NULL AND LOWER(username) = LOWER(?)))
        LIMIT 1
      `).get(socket.user.id, newName, newName);
      if (conflict) {
        return socket.emit('error-msg', 'That display name is already taken on this server');
      }
    } catch (err) {
      console.error('Display name conflict check failed:', err);
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
    if (oldName !== newName) {
      _audit({ actor: socket.user, action: 'user_rename',
        target_type: 'user', target_id: socket.user.id, target_name: newName,
        details: { oldName, newName } });
    }
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

  // Border is a pfp overlay saved like the avatar; broadcast so live views
  // can pick it up without a reconnect.
  socket.on('set-border', (data) => {
    if (!data || typeof data !== 'object') return;
    const url = typeof data.url === 'string' ? data.url.trim() : '';
    if (url && !isValidUploadPath(url)) return;
    socket.user.border = url || null;
    console.log(`[Border] ${socket.user.username} broadcast border: ${url || '(removed)'}`);
    for (const [code, users] of channelUsers) {
      if (users.has(socket.user.id)) {
        users.get(socket.user.id).border = url || null;
        emitOnlineUsers(code);
      }
    }
  });

  // Border fit (op log) broadcast, so live views re-render the overlay without
  // a reconnect. The DB is already written by /api/set-border-transform; this
  // just fans the sanitized value out to open channels.
  socket.on('set-border-transform', (data) => {
    if (!data || typeof data !== 'object') return;
    const transform = sanitizeBorderTransform(data.transform);
    const value = (transform && transform.length) ? transform : null;
    socket.user.borderTransform = value;
    for (const [code, users] of channelUsers) {
      if (users.has(socket.user.id)) {
        users.get(socket.user.id).borderTransform = value;
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

  socket.on('set-animate-profile', (data) => {
    if (!data || typeof data !== 'object') return;
    const valid = ['trigger', 'disabled'];
    const mode = valid.includes(data.mode) ? data.mode : 'trigger';
    try {
      db.prepare('UPDATE users SET animate_profile = ? WHERE id = ?').run(mode, socket.user.id);
      socket.user.animate_profile = mode;
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          users.get(socket.user.id).animate_profile = mode;
          emitOnlineUsers(code);
        }
      }
      socket.emit('animate-profile-updated', { mode });
    } catch (err) {
      console.error('Set animate profile error:', err);
    }
  });

  // ── Status ──────────────────────────────────────────────
  socket.on('set-status', (data) => {
    if (!data || typeof data !== 'object') return;
    const validStatuses = ['online', 'away', 'dnd', 'invisible'];
    const status = validStatuses.includes(data.status) ? data.status : 'online';
    const statusText = isString(data.statusText, 0, 128) ? data.statusText.trim() : '';

    // A status line is displayed next to the name in every member list, so a
    // link parked there is as good as posting it in every channel at once.
    if (statusText && enforceAutomod(statusText, { surface: 'profile' })) return;

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
                u.avatar, u.avatar_shape, u.border, u.border_transform, u.animate_profile, u.status, u.status_text, u.bio, u.created_at
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
        const d = getAdminRoleDisplay();
        if (d.visible) roles.push({ id: -1, name: d.name, level: 100, color: d.color, icon: d.icon });
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
        border: row.border || null,
        borderTransform: parseBorderTransform(row.border_transform),
        animateProfile: row.animate_profile || 'trigger',
        status: row.status || 'online',
        statusText: row.status_text || '',
        bio: row.bio || '',
        roles: roles,
        online: isOnline,
        createdAt: row.created_at,
        // Profile card shows game AND music on separate lines; the sidebar
        // collapses to one. Both read the same privacy-filtered object.
        activity: isOnline && ctx.state?.activity
          ? ctx.state.activity.getPublicActivity(data.userId)
          : null
      });
    } catch (err) {
      console.error('Get user profile error:', err);
    }
  });

  socket.on('set-bio', (data) => {
    if (!data || typeof data.bio !== 'string') return;
    const bio = sanitizeText(data.bio.trim().slice(0, 190));
    if (bio && enforceAutomod(bio, { surface: 'profile' })) return;
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
      // One endpoint is one browser/device, and only one account is signed
      // into it at a time. Because the table is UNIQUE(user_id, endpoint), a
      // previous account's row for this same device would otherwise survive,
      // and fan-out only skips rows whose user_id is the sender, so that stale
      // row pushed the sender their own messages. Claim it for this user.
      db.transaction(() => {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id != ?').run(endpoint, socket.user.id);
        db.prepare(`
          INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
        `).run(socket.user.id, endpoint, keys.p256dh, keys.auth);
      })();
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
      // Same device-ownership rule as push_subscriptions above. An FCM token
      // belongs to one app install, so a token still filed under a previously
      // signed-in account would push that device the current user's own
      // messages. This matters more here than for web push: a web-push
      // endpoint dies on resubscribe and the 410 handler prunes it, but an FCM
      // token stays valid across an account switch, so a stale row never
      // cleans itself up.
      const fcmToken = data.token.trim();
      db.transaction(() => {
        db.prepare('DELETE FROM fcm_tokens WHERE token = ? AND user_id != ?').run(fcmToken, socket.user.id);
        db.prepare(`
          INSERT INTO fcm_tokens (user_id, token)
          VALUES (?, ?)
          ON CONFLICT(user_id, token) DO NOTHING
        `).run(socket.user.id, fcmToken);
      })();
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

    const allowedKeys = [
      'theme', 'hide_score_badge',
      // Rich presence. share_activity is the master switch and defaults to
      // OFF (absent row = not sharing); the two sub-toggles default ON but
      // only matter once the master is enabled.
      'share_activity', 'share_game_activity', 'share_music_activity',
    ];
    if (!allowedKeys.includes(key) || !value || value.length > 50) return;

    db.prepare(
      'INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)'
    ).run(socket.user.id, key, value);

    socket.emit('preference-saved', { key, value });

    // When the score-badge visibility changes, re-broadcast the online-users
    // list for the user's current channel so every connected client immediately
    // sees (or stops seeing) the badge without waiting for the next organic update.
    // Activity toggles need the same treatment: flipping sharing off must take
    // effect for other viewers immediately, not on the next poll tick.
    const ACTIVITY_KEYS = ['share_activity', 'share_game_activity', 'share_music_activity'];
    if ((key === 'hide_score_badge' || ACTIVITY_KEYS.includes(key)) && socket.currentChannel) {
      emitOnlineUsers(socket.currentChannel);
    }
  });

  // ── Rich presence: linked accounts ──────────────────────
  const activity = ctx.state?.activity || null;

  socket.on('get-connections', () => {
    if (!activity) return;
    socket.emit('connections', {
      connections: activity.listConnections(socket.user.id),
      available: {
        steam: activity.isSteamConfigured(),
        spotify: activity.isSpotifyConfigured(),
        lastfm: activity.isLastfmConfigured(),
      },
    });
  });

  /**
   * OAuth/OpenID linking is a top-level browser redirect, so it can't carry the
   * normal Authorization header. The client asks here for a short-lived,
   * single-purpose token and puts it in the URL instead; server.js verifies it
   * and refuses anything that isn't scoped to 'connect'.
   */
  socket.on('get-connect-token', (data) => {
    if (!activity) return;
    const provider = typeof data?.provider === 'string' ? data.provider : '';
    if (!['steam', 'spotify', 'lastfm'].includes(provider)) return;
    if (provider === 'steam' && !activity.isSteamConfigured()) {
      return socket.emit('error-msg', 'Steam integration is not configured on this server');
    }
    if (provider === 'spotify' && !activity.isSpotifyConfigured()) {
      return socket.emit('error-msg', 'Spotify integration is not configured on this server');
    }
    socket.emit('connect-token', { provider, token: generateConnectToken(socket.user.id, provider) });
  });

  /**
   * Admin-only: save integration credentials into .env from Settings, so an
   * admin who has never opened a terminal can turn Steam/Spotify on. Writing
   * also updates process.env, and activity.js reads config per-call, so the
   * pollers pick it up on the next tick without a restart.
   *
   * The keys are secrets: they are never echoed back to any client, and the
   * response is only "is this provider configured now". Validation lives in
   * envStore.setEnvValue, which allow-lists the writable keys — a text field
   * that could write arbitrary .env entries would be a server takeover.
   */
  /**
   * Admin-only: forget an integration's credentials (#5529).
   *
   * The setup form could only ever replace a key, never remove one, because
   * envStore.validate rejects an empty value. That left an admin who had set
   * Steam or Spotify up with no way to turn it back off short of editing .env
   * by hand, which is exactly the audience the setup form exists to spare.
   *
   * Takes a provider's keys together so Spotify's id and secret go at once and
   * it cannot be left half-configured.
   */
  socket.on('clear-integration-key', (data) => {
    if (!activity) return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Admin only');
    if (!data || typeof data !== 'object') return;

    const keys = Array.isArray(data.keys) ? data.keys.filter(k => typeof k === 'string') : [];
    if (!keys.length) return;
    if (!keys.every(isWritableKey)) return socket.emit('error-msg', 'Unknown setting');

    const cleared = [];
    for (const key of keys) {
      const result = clearEnvValue(key);
      if (!result.ok) return socket.emit('error-msg', result.reason || 'Could not remove');
      cleared.push(key);
    }

    _audit({
      actor: socket.user,
      action: 'integration_key_cleared',
      target_type: 'server',
      target_name: cleared.join(', '),
      // Same rule as saving: record which keys changed, never their values.
      details: { keys: cleared },
    });

    socket.emit('toast', { message: `${cleared.join(' and ')} removed`, type: 'success' });
    socket.emit('connections', {
      connections: activity.listConnections(socket.user.id),
      available: {
        steam: activity.isSteamConfigured(),
        spotify: activity.isSpotifyConfigured(),
        lastfm: activity.isLastfmConfigured(),
      },
    });
  });

  socket.on('set-integration-key', (data) => {
    if (!activity) return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Admin only');
    if (!data || typeof data !== 'object') return;

    const key = typeof data.key === 'string' ? data.key.trim() : '';
    const value = typeof data.value === 'string' ? data.value : '';
    if (!isWritableKey(key)) return socket.emit('error-msg', 'Unknown setting');

    const result = setEnvValue(key, value);
    if (!result.ok) return socket.emit('error-msg', result.reason || 'Could not save');

    // Steam's presence poll is driven by a single server-wide key, so refresh
    // it now rather than waiting up to STEAM_POLL_MS for the next tick to pick
    // up the rotated key. Non-fatal: a failure here just means the old cadence.
    if (key === 'STEAM_API_KEY') {
      try { activity.pollSteam().catch(() => {}); } catch { /* ignore */ }
    }

    _audit({
      actor: socket.user,
      action: 'integration_key_set',
      target_type: 'server',
      target_name: key,
      // Deliberately records only which key changed, never the value — the
      // audit log is readable in Settings and is not a place to store secrets.
      details: { key },
    });

    socket.emit('toast', { message: `${key} saved`, type: 'success' });
    socket.emit('connections', {
      connections: activity.listConnections(socket.user.id),
      available: {
        steam: activity.isSteamConfigured(),
        spotify: activity.isSpotifyConfigured(),
        lastfm: activity.isLastfmConfigured(),
      },
    });
  });

  /**
   * Last.fm linking — a username, not an OAuth round-trip.
   *
   * getRecentTracks is a public read, so there is no redirect, no popup, no
   * token to store, and no callback URI to register. The username is verified
   * against the API before saving so a typo fails here rather than silently
   * never reporting anything.
   */
  socket.on('link-lastfm', async (data) => {
    if (!activity) return;
    const username = typeof data?.username === 'string' ? data.username.trim() : '';
    if (!username) return socket.emit('error-msg', 'Enter your Last.fm username');

    const check = await activity.verifyLastfmUser(username);
    if (!check.ok) return socket.emit('error-msg', check.reason || 'Could not verify that username');

    activity.saveConnection(socket.user.id, 'lastfm', {
      externalId: check.name,
      displayName: check.name,
      accessToken: null,   // public API — nothing secret to keep
      refreshToken: null,
      expiresAt: 0,
    });

    // Populate straight away rather than waiting up to 30s for the next tick.
    activity.pollLastfmUser(socket.user.id).catch(() => {});
    if (socket.currentChannel) emitOnlineUsers(socket.currentChannel);
  });

  socket.on('unlink-connection', (data) => {
    if (!activity) return;
    const provider = typeof data?.provider === 'string' ? data.provider : '';
    // lastfm belongs here too — without it a Last.fm account could be linked
    // but never removed.
    if (!['steam', 'spotify', 'lastfm'].includes(provider)) return;
    activity.removeConnection(socket.user.id, provider);
    socket.emit('connections', {
      connections: activity.listConnections(socket.user.id),
      available: {
        steam: activity.isSteamConfigured(),
        spotify: activity.isSpotifyConfigured(),
        lastfm: activity.isLastfmConfigured(),
      },
    });
    socket.emit('toast', { message: `Unlinked ${provider}`, type: 'success' });
    if (socket.currentChannel) emitOnlineUsers(socket.currentChannel);
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
        AND NOT EXISTS (
          SELECT 1 FROM user_preferences up
          WHERE up.user_id = u.id AND up.key = 'hide_score_badge' AND up.value = 'true'
        )
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
        AND NOT EXISTS (
          SELECT 1 FROM user_preferences up
          WHERE up.user_id = u.id AND up.key = 'hide_score_badge' AND up.value = 'true'
        )
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

  // ── Nicknames (#5394) ───────────────────────────────────
  // Nicknames are personal and private — only visible to the user who set them.
  // set-nickname upserts (or deletes when nickname is blank/null).
  // set-nicknames-bulk accepts { nicknames: { [targetId]: nickname|null } } for
  // the one-time migration where the client pushes its localStorage contents.
  socket.on('set-nickname', (data) => {
    if (!data || typeof data !== 'object') return;
    const targetId = parseInt(data.targetId, 10);
    if (!Number.isFinite(targetId) || targetId <= 0) return;
    const nickname = (typeof data.nickname === 'string') ? data.nickname.trim().slice(0, 32) : null;
    try {
      if (nickname) {
        db.prepare(
          'INSERT INTO user_nicknames (owner_id, target_id, nickname) VALUES (?, ?, ?) ON CONFLICT(owner_id, target_id) DO UPDATE SET nickname = excluded.nickname'
        ).run(socket.user.id, targetId, nickname);
      } else {
        db.prepare('DELETE FROM user_nicknames WHERE owner_id = ? AND target_id = ?').run(socket.user.id, targetId);
      }
    } catch (err) {
      console.error('set-nickname error:', err);
    }
  });

  // ── Global display name (Manage Display Names permission) ──
  // Lets a moderator change another member's real display name — the one
  // everyone sees — reusing the same validation and broadcast path as a
  // self-rename. A blank displayName resets the target back to their username.
  socket.on('rename-user-global', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_display_names')) {
      return socket.emit('error-msg', 'You do not have permission to manage display names');
    }
    const targetId = parseInt(data.targetId, 10);
    if (!Number.isFinite(targetId) || targetId <= 0) return;

    const target = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(targetId);
    if (!target) return socket.emit('error-msg', 'User not found');

    // (#5482) Renaming someone is a moderation action, so it respects rank the
    // same way kick, ban and mute do. Without this, anyone holding the
    // permission could rename the server owner.
    if (!socket.user.isAdmin) {
      if (target.is_admin) {
        return socket.emit('error-msg', 'You cannot change an admin\'s display name');
      }
      const myLevel = getUserEffectiveLevel(socket.user.id);
      const targetLevel = getUserEffectiveLevel(targetId);
      if (targetLevel >= myLevel) {
        return socket.emit('error-msg', 'You cannot change the display name of someone at or above your level');
      }
    }

    // Blank still means "reset to the login username", so only a non-empty
    // value goes through validation.
    const submitted = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    let raw = '';
    if (submitted) {
      const checked = normalizeDisplayName(submitted);
      if (checked.error) return socket.emit('error-msg', checked.error);
      raw = checked.value;
    }
    const oldName = target.display_name || target.username;

    let newName, newDisplayCol;
    if (raw) {
      // (#5482) Same automod pass a self-rename gets. The deny-list is what
      // reserves impersonation-prone names like "Admin" / "Moderator", and
      // holding this permission is no reason to be able to hand one out.
      if (enforceAutomod(raw, { surface: 'profile' })) return;
      try {
        const conflict = db.prepare(`
          SELECT id FROM users
          WHERE id != ?
            AND (LOWER(display_name) = LOWER(?)
                 OR (display_name IS NULL AND LOWER(username) = LOWER(?)))
          LIMIT 1
        `).get(targetId, raw, raw);
        if (conflict) {
          return socket.emit('error-msg', 'That display name is already taken on this server');
        }
      } catch (err) {
        console.error('Display name conflict check failed:', err);
      }
      newName = raw;
      newDisplayCol = raw;
    } else {
      // Reset back to the login username
      newName = target.username;
      newDisplayCol = null;
    }

    // (#5482) Lock while a moderator-set name is in force; a reset to the
    // username hands control back. Admins are never locked (see rename-user),
    // so this can't strand anyone.
    const locked = raw ? 1 : 0;

    try {
      db.prepare('UPDATE users SET display_name = ?, display_name_locked = ? WHERE id = ?')
        .run(newDisplayCol, locked, targetId);
    } catch (err) {
      console.error('Global rename error:', err);
      return socket.emit('error-msg', 'Failed to update display name');
    }

    // Refresh presence maps silently — no user-renamed system message, since a
    // moderator changing someone's name shouldn't announce itself in-channel.
    for (const [code, users] of channelUsers) {
      if (users.has(targetId)) {
        users.get(targetId).username = newName;
        emitOnlineUsers(code);
      }
    }
    for (const [code, users] of voiceUsers) {
      if (users.has(targetId)) {
        users.get(targetId).username = newName;
        broadcastVoiceUsers(code);
      }
    }

    // Update the target's own connected sessions (token + UI) as if they renamed
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === targetId) {
        s.user.displayName = newName;
        const newToken = generateToken({ id: s.user.id, username: s.user.username, isAdmin: s.user.isAdmin, displayName: newName });
        s.emit('renamed', {
          token: newToken,
          user: { id: s.user.id, username: s.user.username, isAdmin: s.user.isAdmin, displayName: newName },
          oldName
        });
      }
    }

    // Notify DM partners so their sidebars update
    try {
      const dmPartners = db.prepare(`
        SELECT DISTINCT cm2.user_id FROM channel_members cm1
        JOIN channels c ON c.id = cm1.channel_id AND c.is_dm = 1
        JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.user_id != ?
        WHERE cm1.user_id = ?
      `).all(targetId, targetId);
      for (const partner of dmPartners) {
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === partner.user_id) {
            s.emit('dm-name-updated', { userId: targetId, newName });
          }
        }
      }
    } catch (err) {
      console.error('DM name update broadcast error:', err);
    }

    console.log(`✏️  ${socket.user.username} set display name of ${target.username} to ${newName}`);
    if (oldName !== newName) {
      _audit({ actor: socket.user, action: 'user_rename',
        target_type: 'user', target_id: targetId, target_name: newName,
        details: { oldName, newName } });
    }
  });

  socket.on('set-nicknames-bulk', (data) => {
    if (!data || typeof data !== 'object') return;
    const map = data.nicknames;
    if (!map || typeof map !== 'object') return;
    const entries = Object.entries(map).slice(0, 500); // sanity cap
    const upsert = db.prepare(
      'INSERT INTO user_nicknames (owner_id, target_id, nickname) VALUES (?, ?, ?) ON CONFLICT(owner_id, target_id) DO UPDATE SET nickname = excluded.nickname'
    );
    const txn = db.transaction(() => {
      for (const [rawId, nick] of entries) {
        const targetId = parseInt(rawId, 10);
        if (!Number.isFinite(targetId) || targetId <= 0) continue;
        if (typeof nick !== 'string' || !nick.trim()) continue;
        upsert.run(socket.user.id, targetId, nick.trim().slice(0, 32));
      }
    });
    try { txn(); } catch (err) { console.error('set-nicknames-bulk error:', err); }
  });
};
