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
  const { io, db, generateUniqueSharedCode } = ctx;

  const memberIds = (channelId) =>
    db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id').all(channelId).map((r) => r.user_id);

  const isMember = (channelId, userId) =>
    !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);

  const groupChannel = (code) =>
    db.prepare('SELECT id, code, key_epoch FROM channels WHERE code = ? AND is_dm = 1').get(code);

  const pendingInvitees = (channelId) =>
    db.prepare('SELECT user_id FROM dm_group_invites WHERE channel_id = ? ORDER BY user_id').all(channelId).map((r) => r.user_id);

  const rosterIds = (channelId) =>
    [...new Set([...memberIds(channelId), ...pendingInvitees(channelId)])].sort((a, b) => a - b);

  const sameIds = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  const findExistingGroup = (want) => {
    const target = [...want].sort((a, b) => a - b);
    const candidates = db.prepare(`
      SELECT c.id, c.code, c.name FROM channels c
      WHERE c.is_dm = 1
        AND (
          (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) >= 3
          OR EXISTS (SELECT 1 FROM dm_group_invites WHERE channel_id = c.id)
        )
    `).all();
    return candidates.find((c) => sameIds(rosterIds(c.id), target)) || null;
  };

  const userSummaries = (ids) => {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) AS username
      FROM users u WHERE u.id IN (${ph})
    `).all(...ids);
  };

  const groupPayload = (ch) => {
    const members = memberIds(ch.id);
    const pending = pendingInvitees(ch.id);
    return {
      id: ch.id, code: ch.code, name: ch.name, is_dm: 1, is_group: 1,
      members: userSummaries(members).map((u) => ({ id: u.id, username: u.username })),
      pending: userSummaries(pending).map((u) => ({ id: u.id, username: u.username })),
    };
  };

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

    const existing = findExistingGroup(ids);
    if (existing) {
      const payload = groupPayload(existing);
      if (isMember(existing.id, socket.user.id)) {
        socket.join(`channel:${existing.code}`);
        socket.emit('group-dm-opened', payload);
      } else {
        socket.emit('group-dm-invite', payload);
      }
      return;
    }

    const invitees = ids.filter((id) => id !== socket.user.id);
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 50) : 'Group DM';
    let channelId;
    let code;
    try {
      const tx = db.transaction(() => {
        code = generateUniqueSharedCode ? generateUniqueSharedCode() : require('crypto').randomBytes(4).toString('hex');
        const res = db.prepare('INSERT INTO channels (name, code, created_by, is_dm, key_epoch) VALUES (?, ?, ?, 1, 0)')
          .run(name, code, socket.user.id);
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(res.lastInsertRowid, socket.user.id);
        const insInvite = db.prepare('INSERT INTO dm_group_invites (channel_id, user_id, invited_by) VALUES (?, ?, ?)');
        for (const id of invitees) insInvite.run(res.lastInsertRowid, id, socket.user.id);
        return res.lastInsertRowid;
      });
      channelId = tx();
    } catch (err) {
      console.error('Start group DM error:', err);
      return socket.emit('error-msg', 'Failed to create group DM');
    }

    const payload = groupPayload({ id: channelId, code, name });
    socket.join(`channel:${code}`);
    socket.emit('group-dm-opened', payload);
    // Named people are invited, not joined. They opt in via accept-group-dm.
    for (const [, s] of io.of('/').sockets) {
      if (s.user && invitees.includes(s.user.id)) {
        s.emit('group-dm-invite', {
          ...payload,
          invitedBy: { id: socket.user.id, username: socket.user.displayName || socket.user.username },
        });
      }
    }
  });

  socket.on('accept-group-dm', (data) => {
    const ch = groupChannel(typeof (data && data.code) === 'string' ? data.code.trim() : '');
    if (!ch) return socket.emit('error-msg', 'Group not found');
    const invite = db.prepare('SELECT invited_by FROM dm_group_invites WHERE channel_id = ? AND user_id = ?')
      .get(ch.id, socket.user.id);
    if (!invite) return socket.emit('error-msg', 'No outstanding invite for this group');
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM dm_group_invites WHERE channel_id = ? AND user_id = ?').run(ch.id, socket.user.id);
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch.id, socket.user.id);
      })();
    } catch (err) {
      console.error('Accept group DM error:', err);
      return socket.emit('error-msg', 'Failed to join group DM');
    }
    const named = db.prepare('SELECT name FROM channels WHERE id = ?').get(ch.id);
    socket.join(`channel:${ch.code}`);
    const payload = groupPayload({ id: ch.id, code: ch.code, name: named && named.name });
    socket.emit('group-dm-opened', payload);
    io.to(`channel:${ch.code}`).emit('group-dm-member-joined', {
      code: ch.code,
      user: { id: socket.user.id, username: socket.user.displayName || socket.user.username },
      members: payload.members,
    });
  });

  socket.on('decline-group-dm', (data) => {
    const ch = groupChannel(typeof (data && data.code) === 'string' ? data.code.trim() : '');
    if (!ch) return;
    db.prepare('DELETE FROM dm_group_invites WHERE channel_id = ? AND user_id = ?').run(ch.id, socket.user.id);
    socket.emit('group-dm-declined', { code: ch.code });
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
    db.prepare(`
      INSERT INTO dm_group_rewrap_requests (channel_id, epoch, requester_id)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id, epoch, requester_id) DO NOTHING
    `).run(ch.id, ch.key_epoch, socket.user.id);
    socket.to(`channel:${ch.code}`).emit('group-rewrap-requested', {
      code: ch.code, userId: socket.user.id, epoch: ch.key_epoch,
    });
  });

  /**
   * Re-wrap one member's copy of an existing epoch. Only after that member
   * asked, and only if the wrapper attests the same public key the server
   * already pinned — otherwise a helper could seal the epoch to a key the
   * recipient never published.
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
    if (typeof data.wrappedKey !== 'string' || !data.wrappedKey || data.wrappedKey.length > 4096) {
      return socket.emit('error-msg', 'Malformed wrapped key');
    }

    const asked = db.prepare(
      'SELECT 1 FROM dm_group_rewrap_requests WHERE channel_id = ? AND epoch = ? AND requester_id = ?'
    ).get(ch.id, epoch, recipientId);
    if (!asked) return socket.emit('error-msg', 'No outstanding rewrap request from that member');

    const pinned = db.prepare('SELECT public_key FROM users WHERE id = ?').get(recipientId);
    const claimed = typeof data.recipientPublicKey === 'string' ? data.recipientPublicKey : '';
    if (!pinned || !pinned.public_key || pinned.public_key !== claimed) {
      let existing = null;
      try { existing = pinned && pinned.public_key ? JSON.parse(pinned.public_key) : null; } catch {}
      return socket.emit('public-key-conflict', { existing });
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO dm_group_keys (channel_id, epoch, recipient_id, wrapped_key, wrapped_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, epoch, recipient_id) DO UPDATE SET wrapped_key = excluded.wrapped_key, wrapped_by = excluded.wrapped_by
      `).run(ch.id, epoch, recipientId, data.wrappedKey, socket.user.id);
      db.prepare('DELETE FROM dm_group_rewrap_requests WHERE channel_id = ? AND epoch = ? AND requester_id = ?')
        .run(ch.id, epoch, recipientId);
    })();

    for (const [, s] of io.of('/').sockets) {
      if (s.user && s.user.id === recipientId) s.emit('group-key-rewrapped', { code: ch.code, epoch });
    }
  });
};
