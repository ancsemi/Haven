'use strict';

const bcrypt = require('bcryptjs');
const { utcStamp, isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel,
          emitOnlineUsers, broadcastVoiceUsers, getEnrichedChannels, logAudit } = ctx;
  const { channelUsers, voiceUsers } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};

  // Helper: run an UPDATE only if the target table exists (avoids crash on
  // tables that haven't been created yet, e.g. uploads, channel_emojis).
  const _tableExists = {};
  function updateIfTableExists(table, sql, ...params) {
    if (_tableExists[table] === undefined) {
      _tableExists[table] = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }
    if (_tableExists[table]) db.prepare(sql).run(...params);
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
      details: { reason, scrubMessages: !!data.scrubMessages, purgeMessages: !!data.purgeMessages } });
  });

  // ── Unban user ──────────────────────────────────────────
  socket.on('unban-user', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) {
      return socket.emit('error-msg', 'Only admins can unban users');
    }
    if (!isInt(data.userId)) return;

    db.prepare('DELETE FROM bans WHERE user_id = ?').run(data.userId);
    const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
    socket.emit('error-msg', `Unbanned ${targetUser ? targetUser.username : 'user'}`);
    _audit({ actor: socket.user, action: 'user_unban',
      target_type: 'user', target_id: data.userId,
      target_name: targetUser ? targetUser.username : null });

    const bans = db.prepare(`
      SELECT b.id, b.user_id, b.reason, b.created_at, COALESCE(u.display_name, u.username) as username
      FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
    `).all();
    bans.forEach(b => { b.created_at = utcStamp(b.created_at); });
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
      db.prepare('DELETE FROM reactions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM mutes WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM bans WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM read_positions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(uid);
      db.prepare('UPDATE pinned_messages SET pinned_by = ? WHERE pinned_by = ?').run(socket.user.id, uid);
      db.prepare('DELETE FROM high_scores WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM eula_acceptances WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(uid);
      db.prepare('UPDATE channels SET created_by = NULL WHERE created_by = ?').run(uid);
      updateIfTableExists('uploads', 'UPDATE uploads SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
      updateIfTableExists('channel_emojis', 'UPDATE channel_emojis SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
      db.prepare('UPDATE bans SET banned_by = ? WHERE banned_by = ?').run(socket.user.id, uid);
      db.prepare('UPDATE mutes SET muted_by = ? WHERE muted_by = ?').run(socket.user.id, uid);
      db.prepare('UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?').run(uid);
      updateIfTableExists('webhook_configs', 'UPDATE webhook_configs SET created_by = NULL WHERE created_by = ?', uid);
      db.prepare('UPDATE whitelist SET added_by = NULL WHERE added_by = ?').run(uid);
      db.prepare('UPDATE deleted_users SET deleted_by = NULL WHERE deleted_by = ?').run(uid);
      if (data.scrubMessages) {
        db.prepare('DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)').run(uid);
        db.prepare('DELETE FROM messages WHERE user_id = ? AND is_archived = 0').run(uid);
        db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);
      } else {
        db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      db.prepare('INSERT INTO deleted_users (username, display_name, reason, deleted_by) VALUES (?, ?, ?, ?)').run(
        targetUser.username, targetUser.display_name, reason, socket.user.id
      );
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

    const purge = db.transaction(() => {
      db.prepare('DELETE FROM reactions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM mutes WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM bans WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM read_positions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM high_scores WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM eula_acceptances WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(uid);
      db.prepare('UPDATE channels SET created_by = NULL WHERE created_by = ?').run(uid);
      updateIfTableExists('uploads', 'UPDATE uploads SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
      updateIfTableExists('channel_emojis', 'UPDATE channel_emojis SET uploaded_by = NULL WHERE uploaded_by = ?', uid);
      db.prepare('UPDATE bans SET banned_by = NULL WHERE banned_by = ?').run(uid);
      db.prepare('UPDATE mutes SET muted_by = NULL WHERE muted_by = ?').run(uid);
      db.prepare('UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?').run(uid);
      updateIfTableExists('webhook_configs', 'UPDATE webhook_configs SET created_by = NULL WHERE created_by = ?', uid);
      db.prepare('UPDATE whitelist SET added_by = NULL WHERE added_by = ?').run(uid);
      db.prepare('UPDATE deleted_users SET deleted_by = NULL WHERE deleted_by = ?').run(uid);
      db.prepare('UPDATE pinned_messages SET pinned_by = NULL WHERE pinned_by = ?').run(uid);

      if (scrubMessages) {
        db.prepare('DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE user_id = ? AND is_archived = 0)').run(uid);
        db.prepare('DELETE FROM messages WHERE user_id = ? AND is_archived = 0').run(uid);
        db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);

        const dmChannels = db.prepare(`
          SELECT c.id, c.code FROM channels c
          JOIN channel_members cm ON c.id = cm.channel_id
          WHERE c.is_dm = 1 AND cm.user_id = ?
        `).all(uid);
        for (const dm of dmChannels) {
          const remaining = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?').get(dm.id);
          if (remaining.cnt === 0) {
            db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(dm.id);
            db.prepare('DELETE FROM read_positions WHERE channel_id = ?').run(dm.id);
            db.prepare('DELETE FROM channels WHERE id = ?').run(dm.id);
          }
        }
      } else {
        db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);
      }

      db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    });

    try {
      purge();
    } catch (err) {
      console.error('Self-delete error:', err);
      return cb({ error: 'Failed to delete account' });
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
    // LEFT JOIN so bans referencing a since-deleted user still appear
    const bans = db.prepare(`
      SELECT b.id, b.user_id, b.reason, b.created_at,
             COALESCE(u.display_name, u.username, '[deleted user]') as username
      FROM bans b LEFT JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
    `).all();
    bans.forEach(b => { b.created_at = utcStamp(b.created_at); });
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
};
