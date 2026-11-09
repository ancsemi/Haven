'use strict';

const path = require('path');
const fs   = require('fs');
const { utcStamp, isString, sanitizeText, isValidUploadPath, normalizeDisplayName, sanitizeBorderTransform, parseBorderTransform } = require('./helpers');
const { generateConnectToken } = require('../auth');
const { setEnvValue, clearEnvValue, isWritableKey } = require('../envStore');
const { saveFcmToken } = require('../fcm');
const { validHighScore, isKnownGame } = require('../highScores');
const { badgesForProfile } = require('../badges');
const { themePreferenceAllowed } = require('../themeMetadata');
const { MEDIA_GROUP_LAYOUTS } = require('../mediaGroup');
const { cleanEmojiFavorites } = require('../builtinEmojis');
const { nameRefusal } = require('../blockedNames');
const createEncryptionKeyReads = require('../db/encryptionKeys');

const PUSH_SCOPES = ['all', 'mentions'];

// A personal sidebar order (#5779): category keys and, per category, channel
// codes. Only that shape is kept, within limits, so the value cannot carry
// anything else.
function cleanChannelOrder(raw) {
  let o;
  try { o = JSON.parse(raw); } catch { return null; } // not JSON: refused
  if (!o || typeof o !== 'object') return null;
  const key = (k) => typeof k === 'string' && k.length <= 60 ? k : null;
  const cats = Array.isArray(o.cats) ? o.cats.map(key).filter(Boolean).slice(0, 200) : [];
  const ch = {};
  if (o.ch && typeof o.ch === 'object') {
    for (const [k, list] of Object.entries(o.ch).slice(0, 200)) {
      if (!key(k) || !Array.isArray(list)) continue;
      ch[k] = list.filter(c => typeof c === 'string' && /^[a-f0-9]{8}$/i.test(c)).slice(0, 500);
    }
  }
  const out = JSON.stringify({ cats, ch });
  return out.length <= 20000 ? out : null;
}

// A real calendar date from 1900 up to today as YYYY-MM-DD, else null. A day
// of slack lets someone whose local date is ahead of UTC pick their today.
function cleanBirthday(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > Date.now() + 86400000) return null;
  return value;
}

module.exports = function register(socket, ctx) {
  const { io, db, state, getChannelRoleChain, userHasPermission, getUserEffectiveLevel,
          emitOnlineUsers, emitDmPresence, broadcastVoiceUsers, generateToken,
          touchVoiceActivity, enforceAutomod, DATA_DIR, logAudit } = ctx;
  const { channelUsers, voiceUsers } = state;
  const keyReads = createEncryptionKeyReads(db);
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};

  // ── Rename (display name) ───────────────────────────────
  socket.on('rename-user', (data) => {
    if (!data || typeof data !== 'object') return;
    const checked = normalizeDisplayName(typeof data.username === 'string' ? data.username : '');
    if (checked.error) return socket.emit('error-msg', checked.error);
    const newName = checked.value;
    // Saving the profile for a bio or avatar change sends the name along
    // unchanged, which announced "fenix is now known as fenix" to the
    // channel every time. Nothing changed, so nothing to do.
    if (newName === socket.user.displayName) return;

    // (#5482) A moderator-set display name holds. Otherwise the whole
    // Manage Display Names permission is decorative: the moderated user
    // renames themselves straight back and nothing has been moderated.
    // Cleared when a moderator resets them to their username. Admins are
    // never locked, so nobody can end up permanently stuck with a name.
    if (!socket.user.isAdmin) {
      const lock = db.prepare('SELECT display_name_locked FROM users WHERE id = ?').get(socket.user.id);
      if (lock && lock.display_name_locked) {
        return socket.emit('error-msg', 'A moderator set your display name, so you cannot change it yourself');
      }
    }

    // The charset still rules out dots, so a display name cannot carry a
    // working URL. Run it through automod anyway so the deny-list can be
    // used to reserve impersonation-prone names (e.g. "Admin", "Moderator"),
    // which is also the only answer to homoglyph lookalikes (#5509).
    if (enforceAutomod(newName, { surface: 'profile' })) return;

    // Words the admin blocked from names. The admin is not held to it.
    if (!socket.user.isAdmin) {
      const blocked = nameRefusal(db, newName);
      if (blocked) return socket.emit('error-msg', blocked);
    }

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
    // DM partners see the new status too, with the DM not on screen (#5574).
    if (emitDmPresence) emitDmPresence(socket.user.id);

    socket.emit('status-updated', { status, statusText });
  });

  // ── Profile ─────────────────────────────────────────────
  socket.on('get-user-profile', (data) => {
    if (!data || typeof data.userId !== 'number') return;
    try {
      const row = db.prepare(
        `SELECT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
                u.avatar, u.avatar_shape, u.border, u.border_transform, u.animate_profile, u.status, u.status_text, u.bio, u.created_at,
                CASE WHEN u.birthday_hidden <> 0 OR u.birthday_hidden IS NULL THEN NULL
                     WHEN u.birthday_hide_year = 0 THEN u.birthday ELSE substr(u.birthday, 6) END as birthday
         FROM users u WHERE u.id = ?`
      ).get(data.userId);
      if (!row) return;

      const roles = db.prepare(
        `SELECT DISTINCT r.id, r.name, r.level, r.color, r.color2, r.color_shimmer, COALESCE(r.show_on_profile, 1) AS show_on_profile
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
              `SELECT DISTINCT r.id, r.name, COALESCE(ur.custom_level, r.level) as level, r.color, r.color2, r.color_shimmer, COALESCE(r.show_on_profile, 1) AS show_on_profile
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

      if (roles.length > 1) {
        const userRoleIdx = roles.findIndex(r => r.name === 'User' && r.level <= 1);
        if (userRoleIdx !== -1) roles.splice(userRoleIdx, 1);
      }
      // A role switched off for profile cards (#5822) is left off for
      // everyone but the people who manage roles, who see it marked.
      const seesHidden = socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_roles');
      for (let i = roles.length - 1; i >= 0; i--) {
        const shown = roles[i].show_on_profile !== 0;
        delete roles[i].show_on_profile;
        if (shown) continue;
        if (seesHidden) roles[i].hiddenOnProfile = true;
        else roles.splice(i, 1);
      }

      let isOnline = false;
      for (const [, s] of io.of('/').sockets) {
        if (s.user && s.user.id === data.userId) { isOnline = true; break; }
      }
      // Invisible means offline to everyone else, here as in the member
      // list: reporting online next to status 'invisible' gave it away.
      const hidden = row.status === 'invisible' && data.userId !== socket.user.id;
      if (hidden) isOnline = false;

      // Badges (#5632) are worked out here, when a card opens, and nowhere
      // else, so member lists never pay for them. A card without its badges
      // still beats no card.
      let badges = [];
      try {
        badges = badgesForProfile(db, row.id, socket.user.id);
      } catch (err) {
        console.warn('[badges] profile badges failed:', err.message);
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
        status: hidden ? 'offline' : (row.status || 'online'),
        statusText: row.status_text || '',
        bio: row.bio || '',
        // MM-DD, or YYYY-MM-DD when the owner turned off Hide birth year;
        // null while they hide their birthday.
        birthday: row.birthday || null,
        roles: roles,
        badges,
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
      socket.user.bio = bio;
      socket.emit('bio-updated', { bio });
    } catch (err) {
      console.error('Set bio error:', err);
    }
  });

  // A birthday is set once and can never be changed. Hiding it keeps the date
  // and only takes it off the profile and member lists; Hide birth year
  // changes whenever. `hidden` is optional: clients from before it existed
  // send birthday null to hide, and a first date shows.
  socket.on('set-birthday', (data) => {
    if (!data || typeof data !== 'object') return;
    let birthday = null;
    if (data.birthday != null) {
      birthday = cleanBirthday(data.birthday);
      if (!birthday) return socket.emit('error-msg', 'Invalid birthday');
    }
    let listsChanged = false;
    try {
      const row = db.prepare('SELECT birthday, birthday_set_at, birthday_hide_year, birthday_hidden FROM users WHERE id = ?').get(socket.user.id);
      if (!row) return;
      if (row.birthday && birthday && birthday !== row.birthday) {
        return socket.emit('error-msg', 'Your birthday can only be set once.');
      }
      const firstSet = !row.birthday && !!birthday;
      const date = row.birthday || birthday;
      const setAt = firstSet ? new Date().toISOString() : row.birthday_set_at;
      // A missing or NULL flag counts as hidden, so privacy fails closed.
      const wasHidden = row.birthday_hidden !== 0;
      const hidden = typeof data.hidden === 'boolean' ? data.hidden
        : data.birthday === null ? true
        : firstSet ? false
        : wasHidden;
      const hideYear = typeof data.hideYear === 'boolean' ? data.hideYear : row.birthday_hide_year !== 0;
      // Member lists only carry MM-DD, so Hide birth year alone leaves them be.
      listsChanged = date !== row.birthday || hidden !== wasHidden;
      if (!listsChanged && hideYear === (row.birthday_hide_year !== 0)) return;
      db.prepare('UPDATE users SET birthday = ?, birthday_set_at = ?, birthday_hide_year = ?, birthday_hidden = ? WHERE id = ?')
        .run(date, setAt, hideYear ? 1 : 0, hidden ? 1 : 0, socket.user.id);
      socket.user.birthday = date;
      socket.user.birthdaySetAt = setAt;
      socket.user.birthdayHideYear = hideYear;
      socket.user.birthdayHidden = hidden;
      socket.emit('birthday-updated', { birthday: date, birthdaySetAt: setAt, birthdayHideYear: hideYear, birthdayHidden: hidden });
    } catch (err) {
      console.error('Set birthday error:', err);
      return;
    }
    if (!listsChanged) return;
    // Member lists carry the birthday, so a 🎉 shows (or goes) right away.
    for (const [code, users] of channelUsers) {
      if (users.has(socket.user.id)) emitOnlineUsers(code);
    }
    if (emitDmPresence) emitDmPresence(socket.user.id);
  });

  // ── Push Notifications ──────────────────────────────────
  socket.on('push-subscribe', async (data) => {
    if (!data || typeof data !== 'object') return;
    const { endpoint, keys } = data;
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048) return;
    if (!keys || typeof keys !== 'object') return;
    if (typeof keys.p256dh !== 'string' || !keys.p256dh || keys.p256dh.length > 512) return;
    if (typeof keys.auth !== 'string' || !keys.auth || keys.auth.length > 512) return;

    try { const u = new URL(endpoint); if (u.protocol !== 'https:') return; } catch { return; }
    // The server posts to this address for every notification, so it has to
    // be a public push service: a client-chosen endpoint on the server's own
    // network was a way to make it send requests there. A self-hosted ntfy
    // next to Haven is the exception HAVEN_ALLOW_PRIVATE_CALLBACKS opts into.
    try {
      await require('../webhookCallback').resolveCallbackDestination(endpoint,
        { allowPrivateCallbacks: process.env.HAVEN_ALLOW_PRIVATE_CALLBACKS === 'true' });
    } catch (err) {
      // The client is never told, so say why here or the device just stops
      // getting notifications with no trace anywhere.
      console.warn(`Push subscription refused for ${new URL(endpoint).host}: ${err.message}`);
      return;
    }

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
        if (PUSH_SCOPES.includes(data.scope)) {
          db.prepare('UPDATE push_subscriptions SET scope = ? WHERE user_id = ? AND endpoint = ?')
            .run(data.scope, socket.user.id, endpoint);
        }
        // Ten devices per person is plenty; the oldest go first. Without a cap
        // one account could register endless endpoints for the push queue.
        db.prepare(`
          DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
            SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10)
        `).run(socket.user.id, socket.user.id);
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
      // saveFcmToken claims the token for this account and applies the
      // length and per-account caps.
      saveFcmToken(db, socket.user.id, data.token.trim(), data.scope);
    } catch (err) {
      console.error('FCM token register error:', err);
    }
  });

  // Which messages this device is pushed: 'all', or 'mentions' while its
  // Notifications switch (Settings > Sounds) is off, so push follows the same
  // choice as the device's sounds and pop-ups. Only the caller's own rows.
  socket.on('set-push-scope', (data) => {
    if (!data || typeof data !== 'object' || !PUSH_SCOPES.includes(data.scope)) return;
    try {
      if (typeof data.endpoint === 'string' && data.endpoint) {
        db.prepare('UPDATE push_subscriptions SET scope = ? WHERE user_id = ? AND endpoint = ?')
          .run(data.scope, socket.user.id, data.endpoint);
      }
      if (typeof data.token === 'string' && data.token.trim()) {
        db.prepare('UPDATE fcm_tokens SET scope = ? WHERE user_id = ? AND token = ?')
          .run(data.scope, socket.user.id, data.token.trim());
      }
    } catch (err) {
      console.error('Push scope update error:', err);
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
          console.warn(`[E2E] User ${socket.user.id} (${socket.user.username}) tried to overwrite public key, blocked`);
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

  socket.on('get-public-key', async (data) => {
    if (!data || typeof data !== 'object') return;
    const userId = typeof data.userId === 'number' ? data.userId : parseInt(data.userId);
    if (!userId || isNaN(userId)) return;

    try {
      const row = await keyReads.publicKey(userId);
      const jwk = row && row.public_key ? JSON.parse(row.public_key) : null;
      socket.emit('public-key-result', { userId, jwk });
    } catch (err) {
      console.error('Get public key error:', err);
      socket.emit('error-msg', 'Failed to get public key');
    }
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
      // separatePassphrase says what this backup is locked with, when the
      // client is switching between its login password and a passphrase of
      // its own; the two are saved together so they never disagree.
      if (typeof data.separatePassphrase === 'boolean') {
        db.prepare('UPDATE users SET encrypted_private_key = ?, e2e_key_salt = ?, e2e_passphrase = ? WHERE id = ?')
          .run(encryptedKey, salt, data.separatePassphrase ? 1 : 0, socket.user.id);
        socket.user.e2ePassphrase = data.separatePassphrase;
      } else {
        db.prepare('UPDATE users SET encrypted_private_key = ?, e2e_key_salt = ? WHERE id = ?')
          .run(encryptedKey, salt, socket.user.id);
      }
      socket.emit('encrypted-key-stored');
    } catch (err) {
      console.error('Store encrypted key error:', err);
      socket.emit('error-msg', 'Failed to store encrypted key');
    }
  });

  socket.on('store-signing-backup', (data) => {
    const backup = typeof data?.backup === 'string' ? data.backup : '';
    if (!backup || backup.length > 4096) return socket.emit('error-msg', 'Invalid signing key backup');
    db.prepare('UPDATE users SET signing_backup = ? WHERE id = ?').run(backup, socket.user.id);
    socket.emit('signing-backup-stored');
  });
  socket.on('get-encrypted-key', async () => {
    try {
      const row = await keyReads.encryptedKey(socket.user.id);
      const hasBackup = !!(row && row.encrypted_private_key && row.e2e_key_salt);
      // Forward just the pub-key JWK (x,y) so clients can detect
      // local-vs-server divergence without an extra round-trip. Additive:
      // legacy clients ignore it.
      let publicKey = null;
      if (row && row.public_key) {
        try {
          const parsed = typeof row.public_key === 'string' ? JSON.parse(row.public_key) : row.public_key;
          if (parsed && parsed.x && parsed.y) publicKey = { kty: parsed.kty, crv: parsed.crv, x: parsed.x, y: parsed.y };
        } catch { /* stored pub key not JSON: send none, the client copes with that */ }
      }
      socket.emit('encrypted-key-result', {
        encryptedKey: row?.encrypted_private_key || null,
        salt: row?.e2e_key_salt || null,
        hasPublicKey: !!(row && row.public_key),
        publicKey,
        signingKey: row && row.signing_key ? JSON.parse(row.signing_key) : null,
        signingBackup: row?.signing_backup || null,
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

  // Whether this account may save a theme file as its theme. Every failure
  // counts against it: no permission, nothing published.
  const themeFileAllowed = (value) => {
    let canManage = false;
    try {
      canManage = !!(socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server'));
    } catch (err) {
      console.warn('[preferences] permission check failed:', err.message);
    }
    const setting = (name) => db.prepare('SELECT value FROM server_settings WHERE key = ?').get(name)?.value || '';
    let published = [];
    try {
      published = JSON.parse(setting('published_themes') || '[]');
    } catch {
      // A malformed list publishes nothing; the picker reads it the same way.
    }
    const current = db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'theme'")
      .get(socket.user.id)?.value || '';
    return themePreferenceAllowed(value, { published, current, defaultTheme: setting('default_theme'), canManage });
  };

  socket.on('set-preference', (data) => {
    if (!data || typeof data !== 'object') return;
    const key = typeof data.key === 'string' ? data.key.trim() : '';
    const value = typeof data.value === 'string' ? data.value.trim() : '';

    const allowedKeys = [
      'theme', 'hide_score_badge', 'hide_nsfw',
      // Visual effects picker (theme.js). Same reason as theme: a desktop app
      // that lands on a different storage origin (http vs https autodetect)
      // loses localStorage, and only server-side preferences come back.
      'effects',
      // Rich presence. share_activity is the master switch and defaults to
      // OFF (absent row = not sharing); the two sub-toggles default ON but
      // only matter once the master is enabled.
      'share_activity', 'share_game_activity', 'share_music_activity',
      // "Don't show again" for the desktop / mobile promo modals and the
      // recovery-codes notice. Persisted per-account (not localStorage) so
      // hardened browsers that wipe local storage every session still honour a
      // prior dismissal instead of re-showing the modal on every login.
      'promo_seen_desktop', 'promo_seen_android', 'recovery_notice_seen',
      // The top-bar Android banner, closed once (#5594).
      'android_banner_seen',
      // Persisted localization. timezone is an IANA zone id (e.g.
      // "America/New_York") so DST is resolved per-instant by Intl, never a
      // frozen offset. time_format is '12' or '24'.
      'timezone', 'time_format',
      // Your own sidebar order (#5779, app-channel-personal-order.js).
      'channel_order',
      // Muting, for yourself (app-server-mute.js): this server ('all' or
      // 'mentions') and members muted for you (a JSON list of user ids).
      'server_mute', 'muted_users',
      // How pictures sent together show for you (#5799): 'grid' or
      // 'stacked'. No row follows the server's media_group_layout.
      'media_group_layout',
      'emoji_favorites',
    ];
    // 'effects' is a JSON array of effect ids, longer than the other values.
    // A theme is saved as file:<file name>, and a community theme's file name
    // can run long; at 50 it was dropped without a word and lost on reload.
    const maxLen = key === 'effects' ? 400 : key === 'channel_order' ? 20000 : key === 'muted_users' ? 6000 : key === 'emoji_favorites' ? 1700 : key === 'theme' ? 200 : 50;
    if (!allowedKeys.includes(key) || !value || value.length > maxLen) return;
    let stored = value;
    if (key === 'channel_order') {
      stored = cleanChannelOrder(value);
      if (!stored) return;
    }
    if (key === 'emoji_favorites') {
      stored = cleanEmojiFavorites(value);
      if (!stored) return;
    }
    if (key === 'server_mute' && value !== 'all' && value !== 'mentions') return;
    if (key === 'media_group_layout' && !MEDIA_GROUP_LAYOUTS.includes(value)) return;
    // Members pick from Haven's own themes and the published theme files. A
    // refusal is quiet: the picker only offers allowed themes, so this is a
    // stale list or a crafted request, and the client falls back on its own.
    if (key === 'theme' && value.startsWith('file:') && !themeFileAllowed(value)) {
      socket.emit('preference-refused', { key, value });
      return;
    }
    if (key === 'muted_users') {
      let ids;
      try { ids = JSON.parse(value); } catch { return; } // not JSON: refused
      if (!Array.isArray(ids)) return;
      stored = JSON.stringify([...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== socket.user.id))].slice(0, 500));
    }

    db.prepare(
      'INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)'
    ).run(socket.user.id, key, stored);

    socket.emit('preference-saved', { key, value: stored });

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

  // Clear a preference back to unset. Only the localization keys are erasable
  // (the Erase button in the timezone modal), which returns the account to the
  // browser-default behaviour. set-preference never writes empty values, so a
  // dedicated delete is the way to remove a row.
  socket.on('delete-preference', (data) => {
    if (!data || typeof data !== 'object') return;
    const key = typeof data.key === 'string' ? data.key.trim() : '';
    const deletableKeys = ['timezone', 'time_format', 'channel_order', 'server_mute', 'muted_users', 'media_group_layout'];
    if (!deletableKeys.includes(key)) return;
    db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').run(socket.user.id, key);
    socket.emit('preference-deleted', { key });
  });

  // ── Recovery-codes notice gating ────────────────────────
  // The client asks whether to surface the one-time "generate recovery codes"
  // notice; the decision is made entirely server-side. Skip it when the account
  // already has at least one usable recovery code (nothing to nudge), or when
  // the user ticked "never show again" (persisted in user_preferences, exactly
  // like the promo-modal dismissals).
  socket.on('get-recovery-notice-state', () => {
    try {
      const codes = db.prepare(
        'SELECT COUNT(*) AS c FROM account_recovery_codes WHERE user_id = ? AND used = 0'
      ).get(socket.user.id);
      const pref = db.prepare(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = 'recovery_notice_seen'"
      ).get(socket.user.id);
      const hasCodes = (codes?.c || 0) > 0;
      const dismissed = pref?.value === 'true';
      socket.emit('recovery-notice-state', { show: !hasCodes && !dismissed });
    } catch (err) {
      console.error('recovery-notice-state error:', err);
      // Fail closed: never nag if we couldn't determine the state.
      socket.emit('recovery-notice-state', { show: false });
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
   * envStore.setEnvValue, which allow-lists the writable keys; a text field
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
      try { activity.pollSteam().catch((err) => console.warn('[Haven activity] Steam poll failed:', err.message)); } catch { /* the regular poll picks up the new key anyway */ }
    }

    _audit({
      actor: socket.user,
      action: 'integration_key_set',
      target_type: 'server',
      target_name: key,
      // Deliberately records only which key changed, never the value. The
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
   * Last.fm linking: a username, not an OAuth round-trip.
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
      accessToken: null,   // public API, nothing secret to keep
      refreshToken: null,
      expiresAt: 0,
    });

    // Populate straight away rather than waiting up to 30s for the next tick.
    activity.pollLastfmUser(socket.user.id).catch((err) => console.warn('[Haven activity] Last.fm poll failed:', err.message));
    if (socket.currentChannel) emitOnlineUsers(socket.currentChannel);
  });

  socket.on('unlink-connection', (data) => {
    if (!activity) return;
    const provider = typeof data?.provider === 'string' ? data.provider : '';
    // lastfm belongs here too; without it a Last.fm account could be linked
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

  // ── Listening presence webhook (any music player) ──
  // A per-user webhook token a player's plugin or script posts presence to.
  // Enabling generates and stores a token; disabling removes it. Only the token
  // travels to the client; it builds the full URL from its own origin, so the
  // server never needs to know its public address.
  socket.on('get-listening', () => {
    if (!activity) return;
    socket.emit('listening-state', { token: activity.getListeningToken(socket.user.id) });
  });

  socket.on('set-listening', (data) => {
    if (!activity) return;
    let token = null;
    if (data && data.enabled) {
      token = activity.enableListening(socket.user.id);
    } else {
      activity.disableListening(socket.user.id);
    }
    socket.emit('listening-state', { token });
  });

  // ── High Scores ─────────────────────────────────────────
  socket.on('submit-high-score', (data) => {
    if (!data || typeof data !== 'object') return;
    const game = typeof data.game === 'string' ? data.game.trim() : '';
    if (!game || !/^[a-z0-9_-]{1,32}$/.test(game)) return;
    if (!isKnownGame(game)) return;
    // Same rule as POST /api/high-scores: a safe integer under the game's ceiling.
    const score = validHighScore(game, data.score);
    if (score === null) return;

    const current = db.prepare(
      'SELECT score FROM high_scores WHERE user_id = ? AND game = ?'
    ).get(socket.user.id, game);

    const improved = !current || score > current.score;
    if (improved) {
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
    // Everyone hears about a new best; an unchanged board goes only to the
    // sender, so repeating a score is not a broadcast to the whole server.
    (improved ? io.except('bot-sockets') : socket).emit('high-scores', { game, leaderboard });
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
      try { signups = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (err) {
        // No file yet means this is the first signup. Anything else (an
        // unreadable or corrupt file) must not be treated as empty, or the
        // write below would wipe every earlier signup.
        if (err.code !== 'ENOENT') throw err;
      }

      if (signups.some(s => s.email === email)) {
        return callback({ ok: true });
      }
      // One entry per account, and a ceiling on the file: it is read and
      // rewritten whole on each signup.
      if (signups.some(s => s.username === socket.user.username)) {
        return callback({ ok: false, error: 'You are already signed up.' });
      }
      if (signups.length >= 5000) {
        return callback({ ok: false, error: 'The beta list is full.' });
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
      callback({ ok: false, error: 'Server error. Try again later.' });
    }
  });

  // ── Nicknames (#5394) ───────────────────────────────────
  // Nicknames are personal and private: only visible to the user who set them.
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
  // Lets a moderator change another member's real display name (the one
  // everyone sees), reusing the same validation and broadcast path as a
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
      if (!socket.user.isAdmin) {
        const blocked = nameRefusal(db, raw);
        if (blocked) return socket.emit('error-msg', blocked);
      }
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

    // Refresh presence maps silently: no user-renamed system message, since a
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

module.exports.cleanChannelOrder = cleanChannelOrder;
