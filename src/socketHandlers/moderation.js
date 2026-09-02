'use strict';

const bcrypt = require('bcryptjs');
const { utcStamp, isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel,
          emitOnlineUsers, broadcastVoiceUsers, getEnrichedChannels, logAudit,
          invalidateIpBanCache, getMentionableChannelMembers } = ctx;
  const { channelUsers, voiceUsers } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};
  const _invalidateIpCache = (typeof invalidateIpBanCache === 'function') ? invalidateIpBanCache : () => {};

  // Helper: run an UPDATE only if the target table exists (avoids crash on
  // tables that haven't been created yet, e.g. uploads, channel_emojis).
  const _tableExists = {};
  function updateIfTableExists(table, sql, ...params) {
    if (_tableExists[table] === undefined) {
      _tableExists[table] = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }
    if (_tableExists[table]) db.prepare(sql).run(...params);
  }

  // ── Full account-purge cascade ──────────────────────────
  // Deletes a user and cleans up / reassigns all of their rows. Caller MUST
  // wrap this in a db.transaction. Shared by the single delete-user handler
  // and the bulk-remove-users cleanup tool so both stay in lockstep.
  // `targetUser` needs { username, display_name }.
  function purgeUserCascade(uid, targetUser, actorId, scrubMessages, reason) {
    db.prepare('DELETE FROM reactions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM bans WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM read_positions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(uid);
    db.prepare('UPDATE pinned_messages SET pinned_by = ? WHERE pinned_by = ?').run(actorId, uid);
    db.prepare('DELETE FROM high_scores WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM eula_acceptances WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(uid);
    updateIfTableExists('user_connections', 'DELETE FROM user_connections WHERE user_id = ?', uid);
    try { ctx.state?.activity?.clearUser(uid); } catch { /* presence is best-effort */ }
    db.prepare('UPDATE channels SET created_by = NULL WHERE created_by = ?').run(uid);
    updateIfTableExists('uploads', 'UPDATE uploads SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
    updateIfTableExists('channel_emojis', 'UPDATE channel_emojis SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
    db.prepare('UPDATE bans SET banned_by = ? WHERE banned_by = ?').run(actorId, uid);
    db.prepare('UPDATE mutes SET muted_by = ? WHERE muted_by = ?').run(actorId, uid);
    db.prepare('UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?').run(uid);
    updateIfTableExists('webhook_configs', 'UPDATE webhook_configs SET created_by = NULL WHERE created_by = ?', uid);
    db.prepare('UPDATE whitelist SET added_by = NULL WHERE added_by = ?').run(uid);
    db.prepare('UPDATE deleted_users SET deleted_by = NULL WHERE deleted_by = ?').run(uid);
    if (scrubMessages) {
      db.prepare('DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)').run(uid);
      db.prepare('DELETE FROM messages WHERE user_id = ? AND is_archived = 0').run(uid);
      db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);
    } else {
      db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    db.prepare('INSERT INTO deleted_users (username, display_name, reason, deleted_by) VALUES (?, ?, ?, ?)').run(
      targetUser.username, targetUser.display_name, reason || '', actorId
    );
  }

  // ── Kick user ───────────────────────────────────────────
  socket.on('kick-user', (data) => {
    if (!data || typeof data !== 'object') return;
    const kickCode = socket.currentChannel;
    const kickCh = kickCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(kickCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'kick_user', kickCh ? kickCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to kick users');
    }
    if (!isInt(data.userId)) return;
    if (data.userId === socket.user.id) {
      return socket.emit('error-msg', 'You can\'t kick yourself');
    }

    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id, kickCh ? kickCh.id : null);
      const targetLevel = getUserEffectiveLevel(data.userId, kickCh ? kickCh.id : null);
      if (targetLevel >= myLevel) {
        return socket.emit('error-msg', 'You can\'t kick a user with equal or higher rank');
      }
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channelRoom = channelUsers.get(code);
    const targetInfo = channelRoom ? channelRoom.get(data.userId) : null;
    if (!targetInfo) {
      return socket.emit('error-msg', 'User is not currently online in this channel (use ban instead)');
    }

    if (kickCh) {
      db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(kickCh.id, data.userId);
      const subs = db.prepare('SELECT id FROM channels WHERE parent_channel_id = ?').all(kickCh.id);
      const delSub = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
      subs.forEach(s => delSub.run(s.id, data.userId));
    }

    io.to(targetInfo.socketId).emit('kicked', {
      channelCode: code,
      reason: typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : ''
    });

    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === data.userId);
    for (const ts of targetSockets) {
      ts.leave(`channel:${code}`);
      if (kickCh) {
        const subs = db.prepare('SELECT code FROM channels WHERE parent_channel_id = ?').all(kickCh.id);
        subs.forEach(sub => ts.leave(`channel:${sub.code}`));
      }
      ts.emit('channels-list', getEnrichedChannels(data.userId, false, (room) => ts.join(room)));
    }

    channelRoom.delete(data.userId);

    const online = Array.from(channelRoom.values()).map(u => ({
      id: u.id, username: u.username
    }));
    io.to(`channel:${code}`).emit('online-users', {
      channelCode: code,
      users: online
    });

    io.to(`channel:${code}`).emit('new-message', {
      channelCode: code,
      message: {
        id: 0, content: `${targetInfo.username} was kicked`, created_at: new Date().toISOString(),
        username: 'System', user_id: 0, reply_to: null, replyContext: null, reactions: [], edited_at: null, system: true
      }
    });

    if (data.scrubMessages) {
      const scrubScope = (socket.user.isAdmin && data.scrubScope === 'server') ? 'server' : 'channel';
      if (scrubScope === 'channel' && kickCh) {
        db.prepare('DELETE FROM reactions WHERE user_id = ? AND message_id IN (SELECT id FROM messages WHERE channel_id = ? AND is_archived = 0)').run(data.userId, kickCh.id);
        db.prepare('DELETE FROM messages WHERE user_id = ? AND channel_id = ? AND is_archived = 0').run(data.userId, kickCh.id);
      } else if (scrubScope === 'server') {
        db.prepare('DELETE FROM reactions WHERE user_id = ? AND message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)').run(data.userId, data.userId);
        db.prepare('DELETE FROM messages WHERE user_id = ? AND is_archived = 0').run(data.userId);
      }
    }

    socket.emit('error-msg', `Kicked ${targetInfo.username}`);
    _audit({ actor: socket.user, action: 'user_kick',
      target_type: 'user', target_id: data.userId, target_name: targetInfo.username,
      details: { channelCode: code, reason: data.reason || null,
        scrubMessages: !!data.scrubMessages, scrubScope: data.scrubScope || null } });
  });

  // ── Ban user ────────────────────────────────────────────
  socket.on('ban-user', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'ban_user')) {
      return socket.emit('error-msg', 'You don\'t have permission to ban users');
    }
    if (!isInt(data.userId)) return;
    if (data.userId === socket.user.id) {
      return socket.emit('error-msg', 'You can\'t ban yourself');
    }

    const targetRow = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(data.userId);
    if (targetRow && targetRow.is_admin && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'You cannot ban an admin');
    }

    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id);
      const targetLevel = getUserEffectiveLevel(data.userId);
      if (targetLevel >= myLevel) {
        return socket.emit('error-msg', 'You can\'t ban a user with equal or higher rank');
      }
    }

    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';

    const targetUser = db.prepare('SELECT id, COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
    if (!targetUser) return socket.emit('error-msg', 'User not found');

    try {
      db.prepare(
        'INSERT OR REPLACE INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)'
      ).run(data.userId, socket.user.id, reason);
    } catch (err) {
      console.error('Ban error:', err);
      return socket.emit('error-msg', 'Failed to ban user');
    }

    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === data.userId) {
        s.emit('banned', { reason });
        s.disconnect(true);
      }
    }

    for (const [code] of channelUsers) {
      emitOnlineUsers(code);
    }

    // Clients cache the member list per channel and only refetch on a channel
    // switch, so without this push the banned name stayed in @mention
    // autocomplete for everyone already sitting in the channel. The list is
    // identical for every viewer, so one query per channel covers the room.
    try {
      const affected = db.prepare(`
        SELECT c.id, c.code FROM channel_members cm
        JOIN channels c ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 0
      `).all(data.userId);
      for (const ch of affected) {
        io.to(`channel:${ch.code}`).emit('channel-members', {
          channelCode: ch.code,
          members: getMentionableChannelMembers(ch.id)
        });
      }
    } catch (err) {
      console.warn('[ban] member list refresh failed:', err.message);
    }

    if (data.scrubMessages) {
      db.prepare('DELETE FROM reactions WHERE user_id = ? AND message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)').run(data.userId, data.userId);
      db.prepare('DELETE FROM messages WHERE user_id = ? AND is_archived = 0').run(data.userId);
    } else if (data.purgeMessages) {
      // Replace the user's messages with a placeholder rather than deleting
      // them. Useful when admins want a visible "this user was banned"
      // marker in conversation history. Default placeholder is intentionally
      // simple; admins can override with a custom message per ban.
      let placeholder = (typeof data.purgeMessage === 'string') ? data.purgeMessage.trim().slice(0, 200) : '';
      if (!placeholder) placeholder = 'User banned.';
      // Affected channels (so we can broadcast updates only where needed)
      const affectedChannels = db.prepare(
        `SELECT DISTINCT c.code FROM messages m
         JOIN channels c ON c.id = m.channel_id
         WHERE m.user_id = ? AND m.is_archived = 0`
      ).all(data.userId).map(r => r.code);
      // Drop reactions tied to the purged messages (they no longer make sense
      // with the placeholder body).
      db.prepare(
        'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)'
      ).run(data.userId);
      // Replace content + clear file metadata so attachments aren't shown.
      // edited_at gets set so the "edited" tag conveys the change.
      db.prepare(
        `UPDATE messages
         SET content = ?, original_name = NULL, edited_at = datetime('now')
         WHERE user_id = ? AND is_archived = 0`
      ).run(placeholder, data.userId);
      for (const ccode of affectedChannels) {
        io.to(`channel:${ccode}`).emit('user-messages-purged', {
          channelCode: ccode,
          userId: data.userId,
          placeholder
        });
      }
    }

    socket.emit('error-msg', `Banned ${targetUser.username}`);
    _audit({ actor: socket.user, action: 'user_ban',
      target_type: 'user', target_id: data.userId, target_name: targetUser.username,
      details: { reason, scrubMessages: !!data.scrubMessages, purgeMessages: !!data.purgeMessages, banIp: !!data.banIp } });

    // Optional: also ban the user's recently-observed IP addresses. Requires
    // the separate `ban_ip` permission (so a moderator can ban accounts but
    // not addresses unless explicitly granted). Admins always have it.
    if (data.banIp) {
      const canBanIp = socket.user.isAdmin || userHasPermission(socket.user.id, 'ban_ip');
      if (!canBanIp) {
        socket.emit('error-msg', 'IP ban skipped — you don\'t have ban_ip permission');
      } else {
        try {
          const ipRows = db.prepare('SELECT ip FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT 5').all(data.userId);
          const ipReason = reason ? `[Linked to ${targetUser.username}] ${reason}` : `Linked to ${targetUser.username}`;
          const stmt = db.prepare('INSERT OR REPLACE INTO ip_bans (ip, banned_by, reason) VALUES (?, ?, ?)');
          // Normalise on the way out: rows written before v3.42.0 may still
          // hold "::ffff:1.2.3.4", which would be stored as a ban the HTTP
          // gate never matched.
          const { normalizeIp } = require('../clientIp');
          let count = 0;
          const seenIps = new Set();
          for (const r of ipRows) {
            const norm = normalizeIp(r.ip);
            if (!norm || seenIps.has(norm)) continue;
            seenIps.add(norm);
            stmt.run(norm, socket.user.id, ipReason.slice(0, 200));
            count++;
          }
          if (count > 0) {
            _invalidateIpCache();
            socket.emit('error-msg', `Also banned ${count} IP${count === 1 ? '' : 's'} linked to ${targetUser.username}`);
            _audit({ actor: socket.user, action: 'ip_ban_bulk',
              target_type: 'user', target_id: data.userId, target_name: targetUser.username,
              details: { count, reason: ipReason } });
          } else {
            socket.emit('error-msg', `No recorded IPs to ban for ${targetUser.username}`);
          }
        } catch (err) {
          console.error('Bulk IP ban error:', err);
          socket.emit('error-msg', 'Failed to ban linked IPs');
        }
      }
    }
  });

  // ── Unban user ──────────────────────────────────────────
  socket.on('unban-user', (data) => {
    if (!data || typeof data !== 'object') return;
    // This was admin-only while ban-user, get-bans and dismiss-ban-appeal all
    // accepted ban_user, so a moderator could ban someone, watch them sit in
    // the list, reject their appeal, and then be refused the one action that
    // undoes their own mistake. IP bans have always shared a single permission
    // for both directions (_canBanIp); user bans now work the same way.
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'ban_user')) {
      return socket.emit('error-msg', 'You don\'t have permission to unban users');
    }
    if (!isInt(data.userId)) return;

    // Mirror the rank guard on ban-user. A moderator can lift a ban they
    // placed themselves, or one placed by someone below them, but not an
    // admin's ban or a peer's. Without this, widening the permission would
    // hand every moderator a quiet way to reverse an admin's decision.
    if (!socket.user.isAdmin) {
      const existing = db.prepare('SELECT banned_by FROM bans WHERE user_id = ?').get(data.userId);
      if (existing && existing.banned_by !== socket.user.id) {
        const banner = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(existing.banned_by);
        if (banner && banner.is_admin) {
          return socket.emit('error-msg', 'You can\'t undo a ban placed by an admin');
        }
        if (getUserEffectiveLevel(existing.banned_by) >= getUserEffectiveLevel(socket.user.id)) {
          return socket.emit('error-msg', 'You can\'t undo a ban placed by someone of equal or higher rank');
        }
      }
    }

    db.prepare('DELETE FROM bans WHERE user_id = ?').run(data.userId);
    // Any appeal is resolved once the ban is lifted (#5457).
    db.prepare('DELETE FROM ban_appeals WHERE user_id = ?').run(data.userId);
    const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
    socket.emit('error-msg', `Unbanned ${targetUser ? targetUser.username : 'user'}`);
    _audit({ actor: socket.user, action: 'user_unban',
      target_type: 'user', target_id: data.userId,
      target_name: targetUser ? targetUser.username : null });

    const bans = db.prepare(`
      SELECT b.id, b.user_id, b.reason, b.created_at,
             COALESCE(u.display_name, u.username) as username,
             ba.appeal as appeal, ba.created_at as appeal_at
      FROM bans b
      JOIN users u ON b.user_id = u.id
      LEFT JOIN ban_appeals ba ON ba.user_id = b.user_id
      ORDER BY b.created_at DESC
    `).all();
    bans.forEach(b => {
      b.created_at = utcStamp(b.created_at);
      if (b.appeal_at) b.appeal_at = utcStamp(b.appeal_at);
    });
    socket.emit('ban-list', bans);
  });

  // ── Dismiss a ban appeal without unbanning (#5457) ──────────
  // Lets an admin clear an appeal they've reviewed and rejected, so the
  // Banned Users list stops flagging it, while the ban itself stays.
  socket.on('dismiss-ban-appeal', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'ban_user')) {
      return socket.emit('error-msg', 'You don\'t have permission to review appeals');
    }
    if (!isInt(data.userId)) return;
    db.prepare('DELETE FROM ban_appeals WHERE user_id = ?').run(data.userId);
    _audit({ actor: socket.user, action: 'ban_appeal_dismiss',
      target_type: 'user', target_id: data.userId });

    const bans = db.prepare(`
      SELECT b.id, b.user_id, b.reason, b.created_at,
             COALESCE(u.display_name, u.username, '[deleted user]') as username,
             ba.appeal as appeal, ba.created_at as appeal_at
      FROM bans b
      LEFT JOIN users u ON b.user_id = u.id
      LEFT JOIN ban_appeals ba ON ba.user_id = b.user_id
      ORDER BY b.created_at DESC
    `).all();
    bans.forEach(b => {
      b.created_at = utcStamp(b.created_at);
      if (b.appeal_at) b.appeal_at = utcStamp(b.appeal_at);
    });
    socket.emit('ban-list', bans);
  });

  // ── Delete user (admin purge) ───────────────────────────
  socket.on('delete-user', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) {
      return socket.emit('error-msg', 'Only admins can delete users');
    }
    if (!isInt(data.userId)) return;
    if (data.userId === socket.user.id) {
      return socket.emit('error-msg', 'You can\'t delete yourself');
    }

    const targetUser = db.prepare('SELECT id, username, display_name, COALESCE(display_name, username) as displayName FROM users WHERE id = ?').get(data.userId);
    if (!targetUser) return socket.emit('error-msg', 'User not found');

    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : '';

    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === data.userId) {
        s.emit('banned', { reason: 'Your account has been deleted by an admin.' });
        s.disconnect(true);
      }
    }

    for (const [code, users] of channelUsers) {
      if (users.has(data.userId)) {
        users.delete(data.userId);
        emitOnlineUsers(code);
      }
    }
    for (const [code, users] of voiceUsers) {
      if (users.has(data.userId)) {
        users.delete(data.userId);
        broadcastVoiceUsers(code);
      }
    }

    const purge = db.transaction((uid) => {
      purgeUserCascade(uid, targetUser, socket.user.id, data.scrubMessages, reason);
    });

    try {
      purge(data.userId);
    } catch (err) {
      console.error('Delete user error:', err);
      return socket.emit('error-msg', 'Failed to delete user');
    }

    socket.emit('error-msg', `Deleted user "${targetUser.displayName}" — username is now available`);

    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.isAdmin) {
        s.emit('user-deleted', { userId: data.userId, username: targetUser.displayName });
      }
    }

    const bans = db.prepare(`
      SELECT b.id, b.user_id, b.reason, b.created_at, COALESCE(u.display_name, u.username) as username
      FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
    `).all();
    bans.forEach(b => { b.created_at = utcStamp(b.created_at); });
    socket.emit('ban-list', bans);

    console.log(`🗑️  Admin deleted user "${targetUser.displayName}" (id: ${data.userId})`);
  });

  // ── Bulk remove users (bot-wave cleanup) ────────────────
  // Admin-only, two-phase. A PREVIEW (no userIds) filters accounts by join
  // recency / zero activity / New flag and returns the candidate list with
  // per-account message counts, so the admin can uncheck any real users the
  // filter caught. A COMMIT (userIds present) bans + deletes exactly the
  // accounts the admin kept checked. Both phases ALWAYS exclude admins, the
  // acting admin, and anyone holding an assigned role; preview requires at
  // least one filter so it can never sweep the whole table.
  socket.on('bulk-remove-users', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only admins can bulk-remove users' });
    if (!data || typeof data !== 'object') return cb({ error: 'Bad request' });

    // ── COMMIT: an explicit, admin-vetted list of user IDs ──
    if (Array.isArray(data.userIds)) {
      const requested = [...new Set(data.userIds.filter(x => Number.isInteger(x)))].slice(0, 10000);
      if (requested.length === 0) return cb({ ok: true, removed: 0, total: 0 });
      const reason = (typeof data.reason === 'string' && data.reason.trim()) ? data.reason.trim().slice(0, 200) : 'Bulk cleanup';

      // Re-apply the hard exclusions server-side — never trust the client to
      // have kept staff or the acting admin out of the list. "Staff" means a
      // deliberately-granted (non-auto-assign) role; the default role every
      // account gets on registration is auto_assign and must NOT protect a bot.
      const ph = requested.map(() => '?').join(',');
      let targets;
      try {
        targets = db.prepare(
          `SELECT u.id, u.username, u.display_name FROM users u
           WHERE u.id IN (${ph}) AND u.is_admin = 0 AND u.id != ?
             AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                             WHERE ur.user_id = u.id AND r.auto_assign = 0)`
        ).all(...requested, socket.user.id);
      } catch (err) {
        console.error('bulk-remove-users select error:', err);
        return cb({ error: 'Failed to look up selected accounts' });
      }
      if (targets.length === 0) return cb({ ok: true, removed: 0, total: requested.length });
      const ids = targets.map(t => t.id);

      // Optional IP ban (off by default): a botnet spreads across many
      // addresses and some may be shared (CGNAT), so this needs ban_ip.
      let ipBanned = 0;
      if (data.banIp && (socket.user.isAdmin || userHasPermission(socket.user.id, 'ban_ip'))) {
        try {
          const ipStmt = db.prepare('INSERT OR REPLACE INTO ip_bans (ip, banned_by, reason) VALUES (?, ?, ?)');
          const { normalizeIp } = require('../clientIp');
          const banIps = db.transaction((idList) => {
            const seen = new Set();
            for (const uid of idList) {
              for (const r of db.prepare('SELECT ip FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT 3').all(uid)) {
                const norm = normalizeIp(r.ip);
                if (!norm || seen.has(norm)) continue;
                seen.add(norm);
                ipStmt.run(norm, socket.user.id, `[Bulk cleanup] ${reason}`.slice(0, 200));
                ipBanned++;
              }
            }
          });
          banIps(ids);
          if (ipBanned > 0) _invalidateIpCache();
        } catch (err) { console.error('bulk-remove-users IP ban error:', err); }
      }

      // Kick live sockets and drop them from in-memory presence/voice maps.
      const idSet = new Set(ids);
      for (const [, s] of io.sockets.sockets) {
        if (s.user && idSet.has(s.user.id)) { s.emit('banned', { reason: 'Your account was removed by an admin.' }); s.disconnect(true); }
      }
      for (const [code, users] of channelUsers) {
        let changed = false;
        for (const uid of ids) if (users.delete(uid)) changed = true;
        if (changed) emitOnlineUsers(code);
      }
      for (const [code, users] of voiceUsers) {
        let changed = false;
        for (const uid of ids) if (users.delete(uid)) changed = true;
        if (changed) broadcastVoiceUsers(code);
      }

      let removed = 0;
      try {
        const purgeAll = db.transaction((list) => {
          for (const t of list) { purgeUserCascade(t.id, { username: t.username, display_name: t.display_name }, socket.user.id, !!data.scrubMessages, reason); removed++; }
        });
        purgeAll(targets);
      } catch (err) {
        console.error('bulk-remove-users purge error:', err);
        return cb({ error: `Failed partway — removed ${removed} of ${targets.length}` });
      }

      _audit({ actor: socket.user, action: 'user_bulk_remove', target_type: 'user', target_id: null, target_name: null,
        details: { removed, requested: requested.length, ipBanned, scrubMessages: !!data.scrubMessages, reason } });
      for (const [, s] of io.sockets.sockets) { if (s.user && s.user.isAdmin) s.emit('users-bulk-removed', { removed, ids }); }
      console.log(`🧹 Admin ${socket.user.username} bulk-removed ${removed} user(s)${ipBanned ? ` and ${ipBanned} IP(s)` : ''}`);
      return cb({ ok: true, removed, total: requested.length, ipBanned });
    }

    // ── PREVIEW: filter → candidate list for the checkbox review ──
    const f = (data.filter && typeof data.filter === 'object') ? data.filter : {};
    const joinedWithinHours = Number.isFinite(f.joinedWithinHours) && f.joinedWithinHours > 0
      ? Math.min(Math.floor(f.joinedWithinHours), 24 * 3650) : null;
    const zeroMessages = f.zeroMessages === true;
    const newOnly = f.newOnly === true;   // 'New' badge == joined within 7 days
    if (!joinedWithinHours && !zeroMessages && !newOnly) {
      return cb({ error: 'Pick at least one filter — refusing to select every account.' });
    }

    // Hard exclusions keep staff safe no matter what filters are set. A
    // deliberately-granted (non-auto-assign) role marks staff; the default role
    // every account receives on registration is auto_assign and must not shield
    // a bot from cleanup.
    const where = [
      'u.is_admin = 0',
      'u.id != @actorId',
      'NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.auto_assign = 0)'
    ];
    const params = { actorId: socket.user.id };
    if (joinedWithinHours) { where.push("u.created_at >= datetime('now', @joinWindow)"); params.joinWindow = `-${joinedWithinHours} hours`; }
    if (newOnly)           where.push("u.created_at >= datetime('now', '-7 days')");
    if (zeroMessages)      where.push('NOT EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)');
    const whereSql = where.join(' AND ');

    const PREVIEW_CAP = 2000;
    let rows, total;
    try {
      total = db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE ${whereSql}`).get(params).c;
      rows = db.prepare(
        `SELECT u.id, u.username, u.display_name, u.created_at,
                (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS msg_count
         FROM users u WHERE ${whereSql} ORDER BY u.created_at DESC LIMIT ${PREVIEW_CAP}`
      ).all(params);
    } catch (err) {
      console.error('bulk-remove-users preview error:', err);
      return cb({ error: 'Failed to compute matches' });
    }
    return cb({
      ok: true, total, capped: total > PREVIEW_CAP,
      users: rows.map(r => ({ id: r.id, username: r.display_name || r.username, createdAt: r.created_at, msgCount: r.msg_count }))
    });
  });

  // ── Self-delete account ─────────────────────────────────
  socket.on('self-delete-account', async (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    const uid = socket.user.id;

    if (socket.user.isAdmin) {
      return cb({ error: 'Admins must transfer admin to another user before deleting their account' });
    }

    const password = typeof data.password === 'string' ? data.password : '';
    if (!password) return cb({ error: 'Password is required' });

    const userRow = db.prepare('SELECT password_hash, COALESCE(display_name, username) as username FROM users WHERE id = ?').get(uid);
    if (!userRow) return cb({ error: 'User not found' });

    let validPw;
    try {
      validPw = await bcrypt.compare(password, userRow.password_hash);
      if (!validPw) return cb({ error: 'Incorrect password' });
    } catch (err) {
      console.error('Self-delete password verification error:', err);
      return cb({ error: 'Password verification failed' });
    }

    const scrubMessages = !!data.scrubMessages;

    for (const [code, users] of channelUsers) {
      if (users.has(uid)) {
        users.delete(uid);
        emitOnlineUsers(code);
      }
    }
    for (const [code, users] of voiceUsers) {
      if (users.has(uid)) {
        users.delete(uid);
        broadcastVoiceUsers(code);
      }
    }

    // Helper: run a DELETE/UPDATE only when the target table exists.
    // Self-hosted instances upgraded from older versions may be missing
    // newer tables (push_subscriptions, fcm_tokens, eula_acceptances,
    // user_preferences, high_scores, deleted_users, whitelist, etc.).
    // Without guards, a missing table aborts the whole transaction and
    // the user sees "Failed to delete account" with no clue why (#5376).
    const _runIfTable = (table, sql, ...params) => {
      updateIfTableExists(table, sql, ...params);
    };

    const purge = db.transaction(() => {
      _runIfTable('reactions', 'DELETE FROM reactions WHERE user_id = ?', uid);
      _runIfTable('mutes', 'DELETE FROM mutes WHERE user_id = ?', uid);
      _runIfTable('bans', 'DELETE FROM bans WHERE user_id = ?', uid);
      _runIfTable('user_roles', 'DELETE FROM user_roles WHERE user_id = ?', uid);
      _runIfTable('read_positions', 'DELETE FROM read_positions WHERE user_id = ?', uid);
      _runIfTable('high_scores', 'DELETE FROM high_scores WHERE user_id = ?', uid);
      _runIfTable('eula_acceptances', 'DELETE FROM eula_acceptances WHERE user_id = ?', uid);
      _runIfTable('user_preferences', 'DELETE FROM user_preferences WHERE user_id = ?', uid);
      // Linked Steam/Spotify accounts carry encrypted OAuth tokens. The FK
      // cascade would take these anyway, but a deleted account's credentials
      // are exactly the thing worth removing explicitly rather than trusting
      // a pragma that a future migration could turn off.
      _runIfTable('user_connections', 'DELETE FROM user_connections WHERE user_id = ?', uid);
      _runIfTable('push_subscriptions', 'DELETE FROM push_subscriptions WHERE user_id = ?', uid);
      _runIfTable('fcm_tokens', 'DELETE FROM fcm_tokens WHERE user_id = ?', uid);
      _runIfTable('channels', 'UPDATE channels SET created_by = NULL WHERE created_by = ?', uid);
      _runIfTable('uploads', 'UPDATE uploads SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
      _runIfTable('channel_emojis', 'UPDATE channel_emojis SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
      _runIfTable('bans', 'UPDATE bans SET banned_by = NULL WHERE banned_by = ?', uid);
      _runIfTable('mutes', 'UPDATE mutes SET muted_by = NULL WHERE muted_by = ?', uid);
      _runIfTable('user_roles', 'UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?', uid);
      _runIfTable('webhook_configs', 'UPDATE webhook_configs SET created_by = NULL WHERE created_by = ?', uid);
      _runIfTable('whitelist', 'UPDATE whitelist SET added_by = NULL WHERE added_by = ?', uid);
      _runIfTable('deleted_users', 'UPDATE deleted_users SET deleted_by = NULL WHERE deleted_by = ?', uid);
      _runIfTable('pinned_messages', 'UPDATE pinned_messages SET pinned_by = NULL WHERE pinned_by = ?', uid);

      if (scrubMessages) {
        _runIfTable('pinned_messages', 'DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)', uid);
        _runIfTable('messages', 'DELETE FROM messages WHERE user_id = ? AND is_archived = 0', uid);
        _runIfTable('messages', 'UPDATE messages SET user_id = NULL WHERE user_id = ?', uid);

        const dmChannels = db.prepare(`
          SELECT c.id, c.code FROM channels c
          JOIN channel_members cm ON c.id = cm.channel_id
          WHERE c.is_dm = 1 AND cm.user_id = ?
        `).all(uid);
        for (const dm of dmChannels) {
          const remaining = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?').get(dm.id);
          if (remaining.cnt === 0) {
            db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(dm.id);
            _runIfTable('read_positions', 'DELETE FROM read_positions WHERE channel_id = ?', dm.id);
            db.prepare('DELETE FROM channels WHERE id = ?').run(dm.id);
          }
        }
      } else {
        _runIfTable('messages', 'UPDATE messages SET user_id = NULL WHERE user_id = ?', uid);
      }

      db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    });

    try {
      purge();
    } catch (err) {
      console.error('Self-delete error:', err);
      // Surface the real SQL error to the client so users (and we) can
      // actually diagnose schema/FK issues instead of seeing the generic
      // "Failed to delete account" message (#5376).
      const detail = err && err.message ? String(err.message).slice(0, 240) : 'Unknown error';
      return cb({ error: `Failed to delete account: ${detail}` });
    }

    console.log(`🗑️  User self-deleted: "${userRow.username}" (id: ${uid}, scrub: ${scrubMessages})`);
    cb({ success: true });
    socket.disconnect(true);
  });

  // ── Mute / unmute ───────────────────────────────────────
  socket.on('mute-user', (data) => {
    if (!data || typeof data !== 'object') return;
    const muteCode = socket.currentChannel;
    const muteCh = muteCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(muteCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'mute_user', muteCh ? muteCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to mute users');
    }
    if (!isInt(data.userId)) return;
    if (data.userId === socket.user.id) {
      return socket.emit('error-msg', 'You can\'t mute yourself');
    }

    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id, muteCh ? muteCh.id : null);
      const targetLevel = getUserEffectiveLevel(data.userId, muteCh ? muteCh.id : null);
      if (targetLevel >= myLevel) {
        return socket.emit('error-msg', 'You can\'t mute a user with equal or higher rank');
      }
    }

    const durationMinutes = isInt(data.duration) && data.duration > 0 && data.duration <= 43200
      ? data.duration : 10;
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';

    const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
    if (!targetUser) return socket.emit('error-msg', 'User not found');

    try {
      db.prepare(
        'INSERT INTO mutes (user_id, muted_by, reason, expires_at) VALUES (?, ?, ?, datetime(\'now\', ?))'
      ).run(data.userId, socket.user.id, reason, `+${durationMinutes} minutes`);
    } catch (err) {
      console.error('Mute error:', err);
      return socket.emit('error-msg', 'Failed to mute user');
    }

    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === data.userId) {
        s.emit('muted', { duration: durationMinutes, reason });
      }
    }

    socket.emit('error-msg', `Muted ${targetUser.username} for ${durationMinutes} min`);
    _audit({ actor: socket.user, action: 'user_mute',
      target_type: 'user', target_id: data.userId, target_name: targetUser.username,
      details: { durationMinutes, reason, channelCode: muteCode || null } });
  });

  socket.on('unmute-user', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) {
      return socket.emit('error-msg', 'Only admins can unmute users');
    }
    if (!isInt(data.userId)) return;

    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(data.userId);
    const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
    socket.emit('error-msg', `Unmuted ${targetUser ? targetUser.username : 'user'}`);
    _audit({ actor: socket.user, action: 'user_unmute',
      target_type: 'user', target_id: data.userId,
      target_name: targetUser ? targetUser.username : null });
  });

  // ── Ban / deleted-user lists ────────────────────────────
  socket.on('get-bans', () => {
    // Anyone with ban permission can view the ban list (mirrors ban-user perm check)
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'ban_user')) {
      return socket.emit('ban-list', []);
    }
    // LEFT JOIN so bans referencing a since-deleted user still appear, plus
    // any pending appeal text for this ban (#5457).
    const bans = db.prepare(`
      SELECT b.id, b.user_id, b.reason, b.created_at,
             COALESCE(u.display_name, u.username, '[deleted user]') as username,
             ba.appeal as appeal, ba.created_at as appeal_at
      FROM bans b
      LEFT JOIN users u ON b.user_id = u.id
      LEFT JOIN ban_appeals ba ON ba.user_id = b.user_id
      ORDER BY b.created_at DESC
    `).all();
    bans.forEach(b => {
      b.created_at = utcStamp(b.created_at);
      if (b.appeal_at) b.appeal_at = utcStamp(b.appeal_at);
    });
    socket.emit('ban-list', bans);
  });

  socket.on('get-deleted-users', () => {
    if (!socket.user.isAdmin) return;
    const rows = db.prepare(`
      SELECT d.id, d.username, d.display_name, d.reason, d.deleted_at,
             COALESCE(u.display_name, u.username) as deleted_by_name
      FROM deleted_users d
      LEFT JOIN users u ON d.deleted_by = u.id
      ORDER BY d.deleted_at DESC
    `).all();
    rows.forEach(r => { r.deleted_at = utcStamp(r.deleted_at); });
    socket.emit('deleted-users-list', rows);
  });

  // ── IP bans (v3.20.0) ───────────────────────────────────
  // Gated on the separate `ban_ip` permission (admins always have it).
  function _canBanIp() {
    return socket.user.isAdmin || userHasPermission(socket.user.id, 'ban_ip');
  }

  // Validation and canonicalisation now live in src/clientIp.js so that the
  // ban gates, the user_ips recorder and this handler all agree on what an
  // address is. v3.42.0 also accepts CIDR ranges: a single IPv6 subscriber is
  // routinely handed an entire /64, so banning one address of theirs used to
  // accomplish nothing at all.
  const { normalizeIp, isValidIpOrCidr } = require('../clientIp');

  // Preserve the prefix on CIDR input; normalise the address half only.
  function _canonicalBanEntry(s) {
    const raw = String(s || '').trim();
    const slash = raw.indexOf('/');
    if (slash === -1) return normalizeIp(raw);
    return normalizeIp(raw.slice(0, slash)) + '/' + parseInt(raw.slice(slash + 1), 10);
  }

  socket.on('ban-ip', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!_canBanIp()) return socket.emit('error-msg', 'You don\'t have permission to ban IPs');
    const input = (data.ip || '').trim();
    if (!isValidIpOrCidr(input)) return socket.emit('error-msg', 'Invalid IP address or CIDR range');
    const ip = _canonicalBanEntry(input);
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';
    try {
      db.prepare('INSERT OR REPLACE INTO ip_bans (ip, banned_by, reason) VALUES (?, ?, ?)').run(ip, socket.user.id, reason);
      _invalidateIpCache();
      // Disconnect any live sockets coming from that address. Compared through
      // ipMatches so a /64 ban actually sweeps everyone inside it, and so a
      // ban on "1.2.3.4" still matches the "::ffff:1.2.3.4" a dual-stack
      // listener reports. The old identity check on handshake.address missed
      // both cases, leaving banned clients connected until they reloaded.
      const { ipMatches, socketClientIp } = require('../clientIp');
      for (const [, s] of io.sockets.sockets) {
        try {
          if (ipMatches(socketClientIp(s), ip)) { s.emit('banned', { reason }); s.disconnect(true); }
        } catch {}
      }
      socket.emit('error-msg', `Banned IP ${ip}`);
      _audit({ actor: socket.user, action: 'ip_ban',
        target_type: 'ip', target_id: null, target_name: ip,
        details: { reason } });
    } catch (err) {
      console.error('IP ban error:', err);
      socket.emit('error-msg', 'Failed to ban IP');
    }
  });

  socket.on('unban-ip', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!_canBanIp()) return socket.emit('error-msg', 'You don\'t have permission to unban IPs');
    const raw = (data.ip || '').trim();
    if (!raw) return;
    // Try the canonical form first, then the literal string, so entries stored
    // by older versions (pre-normalisation) can still be lifted from the UI.
    const ip = _canonicalBanEntry(raw);
    try {
      let info = db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
      if (info.changes === 0 && raw !== ip) info = db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(raw);
      _invalidateIpCache();
      if (info.changes > 0) {
        socket.emit('error-msg', `Unbanned IP ${ip}`);
        _audit({ actor: socket.user, action: 'ip_unban',
          target_type: 'ip', target_id: null, target_name: ip });
      }
      // Re-emit refreshed list
      const rows = db.prepare('SELECT b.ip, b.reason, b.created_at, COALESCE(u.display_name, u.username) as banned_by_name FROM ip_bans b LEFT JOIN users u ON b.banned_by = u.id ORDER BY b.created_at DESC').all();
      rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
      socket.emit('ip-ban-list', rows);
    } catch (err) {
      console.error('IP unban error:', err);
      socket.emit('error-msg', 'Failed to unban IP');
    }
  });

  socket.on('get-ip-bans', () => {
    if (!_canBanIp()) return socket.emit('ip-ban-list', []);
    const rows = db.prepare(`
      SELECT b.ip, b.reason, b.created_at,
             COALESCE(u.display_name, u.username) as banned_by_name
      FROM ip_bans b LEFT JOIN users u ON b.banned_by = u.id
      ORDER BY b.created_at DESC
    `).all();
    rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
    socket.emit('ip-ban-list', rows);
  });
};
