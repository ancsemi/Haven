/**
 * Group DM key distribution.
 *
 * The server stores wrapped key blobs and never holds a key that opens any of
 * them. It is not passive, though: it enforces the structure that keeps the
 * scheme honest, because a client cannot check these for itself:
 *
 *   - only a current member may publish an epoch
 *   - an epoch must cover EXACTLY the current membership
 *   - epochs are append-only and strictly sequential
 *   - a member reads only their own wrapped blob
 */
const { isInt, NEW_DMS_PER_HOUR } = require('./helpers');

const { clearChannelRuntimeState } = require('../channelRotation');
const { CONVERSATION_REFUSAL } = require('../protectedMessages');
module.exports = function register(socket, ctx) {
  ctx.leaveGroupDm = async (code, userId, attachments) => { const ch = groupOf(code); if (ch && isMember(ch.id, userId)) { await leaveGroup(ch, userId, attachments); return true; } return false; };
  const { io, db, generateUniqueSharedCode } = ctx;
  const { refuseYoungAccount } = require('./postingWait')(socket, ctx);

  // Group invites a member may send per hour, by call. A group invite lands
  // in other people's lists the same as a new DM, so it gets the DM cap.
  // Kept in memory: an invite row is gone once it is answered.
  if (!ctx.state.groupInviteLog) ctx.state.groupInviteLog = new Map();
  const inviteLog = ctx.state.groupInviteLog;
  function overInviteCap() {
    if (socket.user.isAdmin) return false;
    const now = Date.now();
    const recent = (inviteLog.get(socket.user.id) || []).filter(t => now - t < 3600000);
    if (recent.length >= NEW_DMS_PER_HOUR) { inviteLog.set(socket.user.id, recent); return true; }
    recent.push(now);
    inviteLog.set(socket.user.id, recent);
    return false;
  }
  // New groups this member started in the last hour, against the same cap.
  // Any error refuses.
  function overGroupCap() {
    if (socket.user.isAdmin) return false;
    try {
      const n = db.prepare(`
        SELECT COUNT(*) AS n FROM channels
        WHERE created_by = ? AND is_dm = 1 AND COALESCE(is_group, 0) = 1
          AND created_at >= datetime('now', '-1 hour')
      `).get(socket.user.id).n;
      return n >= NEW_DMS_PER_HOUR;
    } catch (err) {
      console.warn('[groups] could not count new groups, refusing:', err.message);
      return true;
    }
  }

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

  // A line in the group's history saying who was invited, joined, left or
  // was removed. It holds ids and names only, never sentences: each member's
  // app writes the line itself (app-groups.js _groupNoticeText), so these
  // plain rows cannot be used to put words in a member's mouth.
  const nameOf = (id) => {
    const u = db.prepare('SELECT COALESCE(display_name, username) AS username FROM users WHERE id = ?').get(id);
    return u ? u.username : '';
  };
  const postNotice = (ch, actorId, event, userIds = []) => {
    const content = JSON.stringify({
      event,
      by: { id: actorId, name: nameOf(actorId) },
      users: userIds.map((id) => ({ id, name: nameOf(id) })),
    });
    try {
      const info = db.prepare("INSERT INTO messages (channel_id, user_id, content, type) VALUES (?, ?, ?, 'notice')").run(ch.id, actorId, content);
      io.to(`channel:${ch.code}`).emit('group-notice', {
        channelCode: ch.code,
        message: { id: Number(info.lastInsertRowid), user_id: actorId, content, type: 'notice', created_at: new Date().toISOString() },
      });
    } catch (err) {
      console.warn('[groups] could not record a membership notice:', err.message);
    }
  };

  const findExistingGroup = (want, requesterId) => {
    const target = [...want].sort((a, b) => a - b);
    // Only groups the requester is in or invited to: the roster asked for
    // always includes them, and scanning every group on the server made each
    // call cost more as groups piled up.
    const candidates = db.prepare(`
      SELECT c.id, c.code, c.name FROM channels c
      WHERE c.is_dm = 1
        AND (
          EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
          OR EXISTS (SELECT 1 FROM dm_group_invites WHERE channel_id = c.id AND user_id = ?)
        )
        AND (
          (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) >= 3
          OR EXISTS (SELECT 1 FROM dm_group_invites WHERE channel_id = c.id)
        )
      LIMIT 500
    `).all(requesterId, requesterId);
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
    // Echoed back so a client can tell its own reply from another request's.
    const rid = typeof data.rid === 'string' ? data.rid.slice(0, 64) : undefined;
    // The private key's backup travels with the public key and is stored in
    // the same write, so the two can never disagree.
    const backup = data.backup === undefined ? null : data.backup;
    if (backup !== null && (typeof backup !== 'string' || !backup || backup.length > 4096)) {
      return socket.emit('error-msg', 'Invalid signing key backup');
    }
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const current = db.prepare('SELECT signing_key FROM users WHERE id = ?').get(socket.user.id);
    if (current && current.signing_key && !data.force) {
      const existing = JSON.parse(current.signing_key);
      if (existing.x !== publicJwk.x || existing.y !== publicJwk.y) {
        console.warn(`[E2E] User ${socket.user.id} tried to overwrite signing key, blocked`);
        return socket.emit('signing-key-conflict', { existing, rid });
      }
    }
    const stored = JSON.stringify(publicJwk);
    db.transaction(() => {
      if (backup) {
        db.prepare('UPDATE users SET signing_key = ?, signing_backup = ? WHERE id = ?').run(stored, backup, socket.user.id);
      } else {
        db.prepare('UPDATE users SET signing_key = ? WHERE id = ?').run(stored, socket.user.id);
      }
      // Append-only: a replaced key stays on record for the messages it signed.
      db.prepare('INSERT OR IGNORE INTO user_signing_keys (user_id, fp, jwk) VALUES (?, ?, ?)')
        .run(socket.user.id, `${publicJwk.x}.${publicJwk.y}`, stored);
    })();
    socket.emit('signing-key-published', { rid });
  });

  /**
   * A user's current signing key, plus every key they have published before
   * (newest first), so history signed before a key reset still verifies.
   */
  socket.on('get-signing-key', (data) => {
    const userId = isInt(data && data.userId) ? data.userId : null;
    if (!userId) return;
    const row = db.prepare('SELECT signing_key FROM users WHERE id = ?').get(userId);
    const keys = db.prepare('SELECT jwk FROM user_signing_keys WHERE user_id = ? ORDER BY rowid DESC LIMIT 50').all(userId)
      .map((r) => JSON.parse(r.jwk));
    socket.emit('signing-key-result', {
      userId,
      jwk: row && row.signing_key ? JSON.parse(row.signing_key) : null,
      keys,
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

    // Everyone must be real, unbanned, and hold both keys; otherwise they
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
      return socket.emit('error-msg', `Cannot start an encrypted group with ${unusable.map((u) => u.username).join(', ')}: no encryption key published yet`);
    }

    const existing = findExistingGroup(ids, socket.user.id);
    if (existing) {
      const payload = { ...groupPayload(existing), existing: true };
      if (isMember(existing.id, socket.user.id)) {
        socket.join(`channel:${existing.code}`);
        socket.emit('group-dm-opened', payload);
      } else {
        socket.emit('group-dm-invite', payload);
      }
      return;
    }

    // A new group reaches its invitees like a new DM does, so the same wait
    // for new accounts and the same hourly cap apply.
    if (refuseYoungAccount(null)) return;
    if (overGroupCap()) return socket.emit('error-msg', 'You have started a lot of new conversations in the last hour. Try again later.');

    const invitees = ids.filter((id) => id !== socket.user.id);
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 50) : 'Group DM';
    let channelId;
    let code;
    try {
      const tx = db.transaction(() => {
        code = generateUniqueSharedCode ? generateUniqueSharedCode() : require('crypto').randomBytes(4).toString('hex');
        const res = db.prepare('INSERT INTO channels (name, code, created_by, is_dm, is_group, key_epoch) VALUES (?, ?, ?, 1, 1, 0)')
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
    postNotice({ id: channelId, code }, socket.user.id, 'invited', invitees);
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
    postNotice(ch, socket.user.id, 'joined');
  });

  socket.on('decline-group-dm', (data) => {
    const ch = groupChannel(typeof (data && data.code) === 'string' ? data.code.trim() : '');
    if (!ch) return;
    db.prepare('DELETE FROM dm_group_invites WHERE channel_id = ? AND user_id = ?').run(ch.id, socket.user.id);
    socket.emit('group-dm-declined', { code: ch.code });
  });

  const groupOf = (code) => {
    const ch = typeof code === 'string' ? groupChannel(code.trim()) : null;
    if (!ch) return null;
    const row = db.prepare('SELECT is_group, name FROM channels WHERE id = ?').get(ch.id);
    return row && row.is_group ? { ...ch, name: row.name } : null;
  };
  const socketsOf = (ids) => [...io.of('/').sockets.values()].filter((s) => s.user && ids.includes(s.user.id));
  socket.on('get-group-invites', () => {
    const rows = db.prepare(`SELECT c.id, c.code, c.name, i.invited_by, COALESCE(u.display_name, u.username) AS inviter FROM dm_group_invites i JOIN channels c ON c.id = i.channel_id LEFT JOIN users u ON u.id = i.invited_by WHERE i.user_id = ? AND c.is_group = 1`).all(socket.user.id);
    socket.emit('group-dm-invites', { invites: rows.map((r) => ({ ...groupPayload(r), invitedBy: { id: r.invited_by, username: r.inviter } })) });
  });
  socket.on('get-group-roster', (data) => {
    const ch = groupOf(data && data.code);
    if (!ch || !isMember(ch.id, socket.user.id)) return;
    const keysOf = (ids) => {
      if (!ids.length) return [];
      const ph = ids.map(() => '?').join(',');
      return db.prepare(`SELECT id, COALESCE(display_name, username) AS username, public_key, signing_key FROM users WHERE id IN (${ph})`).all(...ids)
        .map((u) => ({ id: u.id, username: u.username, publicKey: u.public_key ? JSON.parse(u.public_key) : null, signingKey: u.signing_key ? JSON.parse(u.signing_key) : null }));
    };
    socket.emit('group-roster', { code: ch.code, id: ch.id, name: ch.name, epoch: ch.key_epoch, members: keysOf(memberIds(ch.id)), pending: keysOf(pendingInvitees(ch.id)) });
  });
  socket.on('invite-group-dm', (data) => {
    const ch = groupOf(data && data.code);
    if (!ch || !isMember(ch.id, socket.user.id)) return socket.emit('error-msg', 'Group not found');
    const current = rosterIds(ch.id);
    const ids = [...new Set((Array.isArray(data.userIds) ? data.userIds : []).filter(isInt))].filter((id) => !current.includes(id));
    if (!ids.length) return;
    if (current.length + ids.length > 50) return socket.emit('error-msg', 'Group DMs are limited to 50 people');
    if (refuseYoungAccount(null)) return;
    if (overInviteCap()) return socket.emit('error-msg', 'You have sent a lot of group invites in the last hour. Try again later.');
    const ph = ids.map(() => '?').join(',');
    const users = db.prepare(`SELECT u.id, u.public_key, u.signing_key, u.is_guest, COALESCE(u.display_name, u.username) AS username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE u.id IN (${ph}) AND b.id IS NULL`).all(...ids);
    if (users.length !== ids.length) return socket.emit('error-msg', 'One or more users were not found');
    const unusable = users.filter((u) => u.is_guest || !u.public_key || !u.signing_key);
    if (unusable.length) return socket.emit('error-msg', `Cannot add ${unusable.map((u) => u.username).join(', ')} to an encrypted group: no encryption key published yet`);
    const ins = db.prepare('INSERT OR IGNORE INTO dm_group_invites (channel_id, user_id, invited_by) VALUES (?, ?, ?)');
    db.transaction(() => { for (const id of ids) ins.run(ch.id, id, socket.user.id); })();
    const payload = groupPayload(ch);
    for (const s of socketsOf(ids)) s.emit('group-dm-invite', { ...payload, invitedBy: { id: socket.user.id, username: socket.user.displayName || socket.user.username } });
    io.to(`channel:${ch.code}`).emit('group-dm-updated', payload);
    postNotice(ch, socket.user.id, 'invited', ids);
  });
  async function leaveGroup(ch, userId, attachments, removedBy = null) {
    db.transaction(() => {
      db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(ch.id, userId);
      db.prepare('DELETE FROM dm_group_invites WHERE channel_id = ? AND user_id = ?').run(ch.id, userId);
      db.prepare('DELETE FROM dm_group_rewrap_requests WHERE channel_id = ? AND requester_id = ?').run(ch.id, userId);
    })();
    // Out of the group's call too: leaving the group is leaving its call.
    ctx.liveAccess?.dropFromVoice(userId, [ch.code], 'You are no longer in this group');
    for (const s of socketsOf([userId])) { s.leave(`channel:${ch.code}`); s.emit('channel-deleted', { code: ch.code }); s.emit('group-dm-left', { code: ch.code }); }
    const left = memberIds(ch.id);
    if (!left.length) {
      // Only the last member's own uploads are released. Earlier members'
      // files may still be linked from encrypted messages elsewhere, which the
      // server cannot read to check. A group holding protected messages is
      // kept; the auto-cleanup sweep clears the rest of it.
      if (await ctx.purgeDmChannel(ch, attachments, [userId])) clearChannelRuntimeState(ctx.state, ch.code);
      else console.log(`[protected] Kept group DM "${ch.code}" after its last member left: it holds protected messages`);
    } else {
      const user = db.prepare('SELECT COALESCE(display_name, username) AS username FROM users WHERE id = ?').get(userId);
      io.to(`channel:${ch.code}`).emit('group-dm-member-left', { code: ch.code, user: { id: userId, username: user && user.username }, members: groupPayload(ch).members });
      if (removedBy) postNotice(ch, removedBy, 'removed', [userId]);
      else postNotice(ch, userId, 'left');
    }
    if (ctx.broadcastChannelLists) ctx.broadcastChannelLists();
  }
  socket.on('leave-group-dm', async (data) => {
    const ch = groupOf(data && data.code);
    if (!ch || !isMember(ch.id, socket.user.id)) return;
    await leaveGroup(ch, socket.user.id, data.attachments);
  });
  // The person who started the group can remove people from it (#5740). It
  // works like a moderator's kick: the removed person loses the group on
  // every device at once and the rest replace the key they hold. The creator
  // leaves with Leave group, not this.
  socket.on('remove-group-member', async (data) => {
    if (!data || typeof data !== 'object') return;
    const ch = groupOf(data.code);
    if (!ch || !isMember(ch.id, socket.user.id)) return socket.emit('error-msg', 'Group not found');
    const targetId = isInt(data.userId) ? data.userId : null;
    if (!targetId) return;
    const row = db.prepare('SELECT created_by FROM channels WHERE id = ?').get(ch.id);
    if (!row || !isInt(row.created_by) || row.created_by !== socket.user.id) {
      return socket.emit('error-msg', 'Only the person who started this group can remove people from it');
    }
    if (targetId === socket.user.id) return socket.emit('error-msg', 'Use Leave group to leave it yourself');
    if (!isMember(ch.id, targetId)) return socket.emit('error-msg', 'That person is not in this group');
    const target = db.prepare('SELECT COALESCE(display_name, username) AS username FROM users WHERE id = ?').get(targetId);
    // Told first, while their app still knows the group's name.
    for (const s of socketsOf([targetId])) s.emit('kicked', { channelCode: ch.code, group: true, reason: '' });
    await leaveGroup(ch, targetId, [], socket.user.id);
    socket.emit('group-dm-member-removed', { code: ch.code, user: { id: targetId, username: target && target.username } });
  });
  // The server admin can delete a group for everyone in it, the way a 1:1 DM
  // can be deleted for both people (#5740). Moderators and the group's
  // creator cannot: a moderator kicks, the creator removes people and then
  // deletes the group as its last member. Checked against the database too,
  // so an admin demoted since this connection opened is refused.
  const isServerAdmin = () => {
    if (!socket.user || !socket.user.isAdmin) return false;
    const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(socket.user.id);
    return !!(row && row.is_admin);
  };
  async function deleteGroupForEveryone(code, attachments) {
    const ch = groupOf(code);
    if (!ch) return void socket.emit('error-msg', 'Group not found');
    if (!isServerAdmin()) return void socket.emit('error-msg', 'Only the server admin can delete a group for everyone');
    const told = [...new Set([...memberIds(ch.id), ...pendingInvitees(ch.id), socket.user.id])];
    // Every member's own uploads go with it. Encrypted files the members sent
    // are also released by the messages they were attached to (#5699); the
    // list from the admin's app covers files from before that.
    if (!(await ctx.purgeDmChannel(ch, Array.isArray(attachments) ? attachments : []))) {
      return void socket.emit('error-msg', CONVERSATION_REFUSAL);
    }
    clearChannelRuntimeState(ctx.state, ch.code);
    // group-dm-deleted goes first, while their app still knows the group's
    // name; channel-deleted then removes it, the pop-out DM window included.
    for (const s of socketsOf(told)) {
      s.emit('group-dm-deleted', { code: ch.code });
      s.leave(`channel:${ch.code}`);
      s.emit('channel-deleted', { code: ch.code });
    }
    io.to(`voice:${ch.code}`).emit('channel-deleted', { code: ch.code });
    if (typeof ctx.logAudit === 'function') {
      ctx.logAudit({ actor: socket.user, action: 'channel_delete', target_type: 'channel', target_id: ch.id,
        target_name: ch.name, details: { group: true, code: ch.code } });
    }
    if (ctx.broadcastChannelLists) ctx.broadcastChannelLists();
  }
  ctx.deleteGroupDmForEveryone = deleteGroupForEveryone;
  socket.on('delete-group-dm-for-everyone', async (data) => {
    if (!data || typeof data !== 'object') return;
    await deleteGroupForEveryone(data.code, data.attachments);
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

    // The publisher's signed statement: this key, for this group and epoch,
    // for exactly these members and keys. Members check it before using the
    // key; the server only keeps it and makes sure it names the same people.
    const jwkOk = (j) => j && typeof j.x === 'string' && typeof j.y === 'string' && j.x.length <= 100 && j.y.length <= 100;
    const roster = Array.isArray(data.roster) ? data.roster : null;
    if (typeof data.sig !== 'string' || !data.sig || data.sig.length > 512 || !roster
      || roster.some((m) => !m || !isInt(m.id) || !jwkOk(m.ecdhJwk) || !jwkOk(m.signJwk))
      || !sameIds([...new Set(roster.map((m) => m.id))].sort((a, b) => a - b), expected) || roster.length !== expected.length) {
      return socket.emit('error-msg', 'Epoch must be signed for exactly the current members');
    }
    const pick = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
    const storedRoster = JSON.stringify(roster.map((m) => ({ id: m.id, ecdhJwk: pick(m.ecdhJwk), signJwk: pick(m.signJwk) })));

    try {
      db.transaction(() => {
        const ins = db.prepare(`
          INSERT INTO dm_group_keys (channel_id, epoch, recipient_id, wrapped_key, wrapped_by)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const k of keys) ins.run(ch.id, epoch, k.recipientId, k.wrappedKey, socket.user.id);
        db.prepare('INSERT INTO dm_group_epochs (channel_id, epoch, published_by, sig, roster) VALUES (?, ?, ?, ?, ?)')
          .run(ch.id, epoch, socket.user.id, data.sig, storedRoster);
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
      SELECT k.epoch, k.wrapped_key AS wrappedKey, k.wrapped_by AS wrappedBy,
             e.published_by AS publishedBy, e.sig, e.roster
      FROM dm_group_keys k
      LEFT JOIN dm_group_epochs e ON e.channel_id = k.channel_id AND e.epoch = k.epoch
      WHERE k.channel_id = ? AND k.recipient_id = ? AND k.epoch > ?
      ORDER BY k.epoch ASC
    `).all(ch.id, socket.user.id, sinceEpoch).map((r) => ({ ...r, roster: r.roster ? JSON.parse(r.roster) : null }));
    const covered = db.prepare('SELECT recipient_id FROM dm_group_keys WHERE channel_id = ? AND epoch = ? ORDER BY recipient_id').all(ch.id, ch.key_epoch).map((r) => r.recipient_id);
    // An epoch from before signed statements existed is replaced too, since
    // members no longer accept an unsigned key.
    const signed = !!db.prepare('SELECT 1 FROM dm_group_epochs WHERE channel_id = ? AND epoch = ?').get(ch.id, ch.key_epoch);
    const needsRotation = ch.key_epoch === 0 || !signed || !sameIds(covered, memberIds(ch.id));
    socket.emit('group-keys', { code: ch.code, currentEpoch: ch.key_epoch, keys: rows, needsRotation });
  });

  /**
   * Ask the group to re-wrap the current epoch after a key reset. The asker
   * cannot do it themselves: their old blobs are sealed to a key that no
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
   * already pinned; otherwise a helper could seal the epoch to a key the
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
      try { existing = pinned && pinned.public_key ? JSON.parse(pinned.public_key) : null; } catch { /* stored key not JSON: report the conflict with no key attached */ }
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
    // The rest stop waiting to answer the same request.
    socket.to(`channel:${ch.code}`).emit('group-rewrap-fulfilled', { code: ch.code, userId: recipientId, epoch });
  });
};
