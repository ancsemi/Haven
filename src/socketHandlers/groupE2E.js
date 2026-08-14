/**
 * Group DM key distribution.
 *
 * The server stores wrapped key blobs and never holds a key that opens any of
 * them. It is not passive, though — it enforces the structure that keeps the
 * scheme honest, because a client cannot check these for itself:
 *
 *   - only a current member may publish an epoch
 *   - an epoch must cover EXACTLY the current membership
 *   - epochs are append-only and strictly sequential
 *   - a member reads only their own wrapped blob
 *
 * Design: docs/group-dm-e2e-plan.md
 */
const { isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db } = ctx;

  const memberIds = (channelId) =>
    db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id').all(channelId).map((r) => r.user_id);

  const isMember = (channelId, userId) =>
    !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);

  const groupChannel = (code) =>
    db.prepare('SELECT id, code, key_epoch FROM channels WHERE code = ? AND is_dm = 1').get(code);

  /* ── Signing identity ───────────────────────────────
     Pinned exactly like the ECDH key: an unpinned signing key would let an
     operator swap in their own and author messages as anyone. */

  socket.on('publish-signing-key', (data) => {
    if (!data || typeof data !== 'object') return;
    const jwk = data.jwk;
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
      return socket.emit('error-msg', 'Invalid signing key format');
    }
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const current = db.prepare('SELECT signing_key FROM users WHERE id = ?').get(socket.user.id);
    if (current && current.signing_key && !data.force) {
      const existing = JSON.parse(current.signing_key);
      if (existing.x !== publicJwk.x || existing.y !== publicJwk.y) {
        console.warn(`[E2E] User ${socket.user.id} tried to overwrite signing key — blocked`);
        return socket.emit('signing-key-conflict', { existing });
      }
    }
    db.prepare('UPDATE users SET signing_key = ? WHERE id = ?').run(JSON.stringify(publicJwk), socket.user.id);
    socket.emit('signing-key-published');
  });

  socket.on('get-signing-key', (data) => {
    const userId = isInt(data && data.userId) ? data.userId : null;
    if (!userId) return;
    const row = db.prepare('SELECT signing_key FROM users WHERE id = ?').get(userId);
    socket.emit('signing-key-result', {
      userId,
      jwk: row && row.signing_key ? JSON.parse(row.signing_key) : null,
    });
  });

  /* ── Group creation ─────────────────────────────── */

  socket.on('start-group-dm', (data) => {
    if (!data || typeof data !== 'object') return;
    if (socket.user.isGuest) return socket.emit('error-msg', 'Guests cannot send direct messages');

    const raw = Array.isArray(data.userIds) ? data.userIds : [];
    const ids = [...new Set(raw.filter(isInt).concat(socket.user.id))];
    if (ids.length < 3) return socket.emit('error-msg', 'A group DM needs at least three people');
    if (ids.length > 50) return socket.emit('error-msg', 'Group DMs are limited to 50 people');

    // Everyone must be real, unbanned, and hold both keys — otherwise they
    // could never read the conversation and would sit there silently broken.
    const placeholders = ids.map(() => '?').join(',');
    const users = db.prepare(`
      SELECT u.id, u.public_key, u.signing_key, u.is_guest,
             COALESCE(u.display_name, u.username) AS username
      FROM users u LEFT JOIN bans b ON u.id = b.user_id
      WHERE u.id IN (${placeholders}) AND b.id IS NULL
    `).all(...ids);
    if (users.length !== ids.length) return socket.emit('error-msg', 'One or more users were not found');
    const unusable = users.filter((u) => u.is_guest || !u.public_key || !u.signing_key);
    if (unusable.length) {
      return socket.emit('error-msg', `Cannot start an encrypted group with ${unusable.map((u) => u.username).join(', ')} — no encryption key published yet`);
    }

    const code = require('crypto').randomBytes(4).toString('hex');
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 50) : 'Group DM';
    const tx = db.transaction(() => {
      const res = db.prepare('INSERT INTO channels (name, code, created_by, is_dm, key_epoch) VALUES (?, ?, ?, 1, 0)')
        .run(name, code, socket.user.id);
      const insert = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      for (const id of ids) insert.run(res.lastInsertRowid, id);
      return res.lastInsertRowid;
    });
    const channelId = tx();

    const payload = {
      id: channelId, code, name, is_dm: 1, is_group: 1,
      members: users.map((u) => ({ id: u.id, username: u.username })),
    };
    for (const [, s] of io.of('/').sockets) {
      if (s.user && ids.includes(s.user.id)) { s.join(`channel:${code}`); s.emit('group-dm-opened', payload); }
    }
  });

  /* ── Epoch publication ──────────────────────────── */

  socket.on('publish-group-epoch', (data) => {
    if (!data || typeof data !== 'object') return;
    const ch = groupChannel(typeof data.code === 'string' ? data.code.trim() : '');
    if (!ch) return socket.emit('error-msg', 'Channel not found');
    if (!isMember(ch.id, socket.user.id)) return socket.emit('error-msg', 'Not a member of this channel');

    const epoch = isInt(data.epoch) ? data.epoch : null;
    const keys = Array.isArray(data.keys) ? data.keys : null;
    if (!epoch || !keys) return socket.emit('error-msg', 'Malformed epoch publication');

    // Strictly sequential. Two members rotating at once means one of them
    // loses here and retries against the newer membership.
    if (epoch !== ch.key_epoch + 1) {
      return socket.emit('group-epoch-conflict', { code: ch.code, currentEpoch: ch.key_epoch });
    }

    // The rule that matters most. Without it a member could publish an epoch
    // that silently omits someone, locking them out of a conversation the UI
    // still shows them in.
    const expected = memberIds(ch.id);
    const got = [...new Set(keys.map((k) => k.recipientId))].sort((a, b) => a - b);
    const same = got.length === expected.length && got.every((v, i) => v === expected[i]);
    if (!same) {
      return socket.emit('error-msg', 'Epoch must contain exactly one key per current member');
    }
    if (keys.some((k) => typeof k.wrappedKey !== 'string' || !k.wrappedKey || k.wrappedKey.length > 4096)) {
      return socket.emit('error-msg', 'Malformed wrapped key');
    }

    try {
      db.transaction(() => {
        const ins = db.prepare(`
          INSERT INTO dm_group_keys (channel_id, epoch, recipient_id, wrapped_key, wrapped_by)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const k of keys) ins.run(ch.id, epoch, k.recipientId, k.wrappedKey, socket.user.id);
        db.prepare('UPDATE channels SET key_epoch = ? WHERE id = ?').run(epoch, ch.id);
      })();
    } catch (e) {
      // UNIQUE violation: someone else published this epoch first.
      return socket.emit('group-epoch-conflict', {
        code: ch.code,
        currentEpoch: db.prepare('SELECT key_epoch FROM channels WHERE id = ?').get(ch.id).key_epoch,
      });
    }

    io.to(`channel:${ch.code}`).emit('group-epoch-published', { code: ch.code, epoch });
  });

  /** A member's own wrapped keys, and only ever their own. */
  socket.on('get-group-keys', (data) => {
    const ch = groupChannel(typeof (data && data.code) === 'string' ? data.code.trim() : '');
    if (!ch) return;
    if (!isMember(ch.id, socket.user.id)) return socket.emit('error-msg', 'Not a member of this channel');
    const sinceEpoch = isInt(data.sinceEpoch) ? data.sinceEpoch : 0;
    const rows = db.prepare(`
      SELECT epoch, wrapped_key AS wrappedKey, wrapped_by AS wrappedBy
      FROM dm_group_keys
      WHERE channel_id = ? AND recipient_id = ? AND epoch > ?
      ORDER BY epoch ASC
    `).all(ch.id, socket.user.id, sinceEpoch);
    socket.emit('group-keys', { code: ch.code, currentEpoch: ch.key_epoch, keys: rows });
  });

  /**
   * Ask the group to re-wrap the current epoch after a key reset. The asker
   * cannot do it themselves — their old blobs are sealed to a key that no
   * longer exists.
   */
  socket.on('request-group-rewrap', (data) => {
    const ch = groupChannel(typeof (data && data.code) === 'string' ? data.code.trim() : '');
    if (!ch) return;
    if (!isMember(ch.id, socket.user.id)) return;
    socket.to(`channel:${ch.code}`).emit('group-rewrap-requested', {
      code: ch.code, userId: socket.user.id, epoch: ch.key_epoch,
    });
  });

  /**
   * Re-wrap one member's copy of an existing epoch. Scoped to a single
   * recipient so it cannot be used to rewrite the whole epoch.
   */
  socket.on('rewrap-group-key', (data) => {
    if (!data || typeof data !== 'object') return;
    const ch = groupChannel(typeof data.code === 'string' ? data.code.trim() : '');
    if (!ch) return;
    if (!isMember(ch.id, socket.user.id)) return socket.emit('error-msg', 'Not a member of this channel');
    const recipientId = isInt(data.recipientId) ? data.recipientId : null;
    const epoch = isInt(data.epoch) ? data.epoch : null;
    if (!recipientId || !epoch || typeof data.wrappedKey !== 'string') return;
    if (!isMember(ch.id, recipientId)) return socket.emit('error-msg', 'Recipient is not a member');

    db.prepare(`
      INSERT INTO dm_group_keys (channel_id, epoch, recipient_id, wrapped_key, wrapped_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, epoch, recipient_id) DO UPDATE SET wrapped_key = excluded.wrapped_key, wrapped_by = excluded.wrapped_by
    `).run(ch.id, epoch, recipientId, data.wrappedKey, socket.user.id);

    for (const [, s] of io.of('/').sockets) {
      if (s.user && s.user.id === recipientId) s.emit('group-key-rewrapped', { code: ch.code, epoch });
    }
  });
};
