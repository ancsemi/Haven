// ── Channel CRUD, sub-channels, settings, reordering, categories, DMs ──
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('../paths');

const UPLOAD_PATH_RE = /\/uploads\/((?!(?:deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
const UPLOAD_PATH_EXACT_RE = /^\/uploads\/((?!(?:deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)$/;

function isSafeUploadRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (!/^((?!\.\.)(?!\.\/)(?!\/)[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relPath)) return false;
  const parts = relPath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  return true;
}

function moveUploadToDeleted(relPath) {
  if (!isSafeUploadRelPath(relPath)) return;
  const src = path.join(UPLOADS_DIR, relPath);
  if (!fs.existsSync(src)) return;
  let stat;
  try {
    stat = fs.statSync(src);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  const dst = path.join(DELETED_ATTACHMENTS_DIR, relPath);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  } catch { /* file locked or already moved */ }
}
const { isString, isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    broadcastChannelLists, getEnrichedChannels, emitOnlineUsers,
    handleVoiceLeave, broadcastVoiceUsers, generateChannelCode,
    applyRoleChannelAccess, logAudit, fireWebhookEvent
  } = ctx;
  const { channelUsers, voiceUsers, activeMusic, musicQueues } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};

  // (#5389) Auto-grant a channel's default_role_id to a user when they join
  // or are added to that channel. No-op if the channel has no default role.
  // Safe to call repeatedly — INSERT OR IGNORE avoids duplicates.
  const _applyChannelDefaultRole = (channelId, userId, grantedBy = null) => {
    try {
      const row = db.prepare('SELECT default_role_id FROM channels WHERE id = ?').get(channelId);
      if (!row || !row.default_role_id) return;
      db.prepare(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)'
      ).run(userId, row.default_role_id, channelId, grantedBy);
      if (typeof applyRoleChannelAccess === 'function') {
        try { applyRoleChannelAccess(row.default_role_id, userId, 'grant'); } catch { /* non-critical */ }
      }
    } catch (e) {
      console.warn('applyChannelDefaultRole failed:', e.message);
    }
  };

  // (#5424) Organizing a parent's sub-channels is sub-channel management, not
  // server administration. A user may do it if they hold manage_sub_channels
  // for that parent (channel-scoped roles cascade onto the parent), or the
  // server-wide create_channel permission. parentId === null means top-level /
  // server structure, which still requires create_channel (or admin).
  const _canManageSubsOf = (parentId) =>
    socket.user.isAdmin ||
    (!!parentId && userHasPermission(socket.user.id, 'manage_sub_channels', parentId)) ||
    userHasPermission(socket.user.id, 'create_channel');

  // ── Get user's channels ─────────────────────────────────
  socket.on('get-channels', () => {
    const channels = getEnrichedChannels(
      socket.user.id,
      socket.user.isAdmin,
      (room) => socket.join(room)
    );
    socket.emit('channels-list', channels);
  });

  // ── Create channel (permission-based) ─────────────────
  socket.on('create-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to create channels');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0) {
      return socket.emit('error-msg', 'Channel name required');
    }
    if (name.length > 50) {
      return socket.emit('error-msg', 'Channel name too long (max 50)');
    }
    if (!/^[\w\s\-!?.,'\p{L}\p{M}\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji}\uFE0F\u200D]+$/u.test(name)) {
      return socket.emit('error-msg', 'Channel name contains invalid characters');
    }

    const code = generateChannelCode();
    const isPrivate = data.isPrivate ? 1 : 0;

    let expiresAt = null;
    if (data.temporary && data.duration) {
      const hours = Math.max(1, Math.min(720, parseInt(data.duration, 10)));
      if (!isNaN(hours)) {
        expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      }
    }

    try {
      const result = db.prepare(
        'INSERT INTO channels (name, code, created_by, is_private, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).run(name.trim(), code, socket.user.id, isPrivate, expiresAt);

      db.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).run(result.lastInsertRowid, socket.user.id);

      // Optional: bulk-add every existing user to the new channel.
      // Lets admins approximate Discord-style "everyone is in every channel"
      // when a server uses the server-wide invite code. (#5271)
      if (data.addAllMembers && !isPrivate) {
        try {
          const allUsers = db.prepare('SELECT id FROM users').all();
          const insertMember = db.prepare(
            'INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)'
          );
          const txn = db.transaction(() => {
            for (const u of allUsers) insertMember.run(result.lastInsertRowid, u.id);
          });
          txn();
        } catch (e) {
          console.warn('addAllMembers failed:', e.message);
        }
      }

      if (!socket.user.isAdmin) {
        const channelModRole = db.prepare(
          "SELECT id FROM roles WHERE scope = 'channel' ORDER BY level DESC LIMIT 1"
        ).get();
        if (channelModRole) {
          db.prepare(
            'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, NULL)'
          ).run(socket.user.id, channelModRole.id, result.lastInsertRowid);
        }
      }

      const channel = {
        id: result.lastInsertRowid,
        name: name.trim(),
        code,
        display_code: code,
        created_by: socket.user.id,
        topic: '',
        is_dm: 0,
        is_private: isPrivate,
        expires_at: expiresAt
      };

      socket.join(`channel:${code}`);
      socket.emit('channel-created', channel);

      _audit({ actor: socket.user, action: 'channel_create',
        target_type: 'channel', target_id: result.lastInsertRowid, target_name: name.trim(),
        details: { code, isPrivate: !!isPrivate, expiresAt } });

      // If we mass-added every user, push the new channel to all currently
      // connected sockets so it appears for them without a refresh. (#5271)
      if (data.addAllMembers && !isPrivate) {
        for (const [, s] of io.sockets.sockets) {
          if (!s.user || s.user.id === socket.user.id) continue;
          s.join(`channel:${code}`);
          s.emit('channel-created', channel);
        }
      }
    } catch (err) {
      console.error('Create channel error:', err);
      socket.emit('error-msg', 'Failed to create channel');
    }
  });

  // ── Create temporary voice channel (#163) ───────────────
  socket.on('create-temp-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_temp_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to create temporary channels');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0) return socket.emit('error-msg', 'Channel name required');
    if (name.length > 50) return socket.emit('error-msg', 'Channel name too long (max 50)');
    if (!/^[\w\s\-!?.,'\p{L}\p{M}\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji}\uFE0F\u200D]+$/u.test(name)) {
      return socket.emit('error-msg', 'Channel name contains invalid characters');
    }

    try {
      const existing = db.prepare(
        "SELECT COUNT(*) as cnt FROM channels WHERE created_by = ? AND expires_at IS NOT NULL"
      ).get(socket.user.id);
      if (existing && existing.cnt >= 3) {
        return socket.emit('error-msg', 'You already have the maximum number of temporary channels (3)');
      }
    } catch { /* ignore */ }

    const code = generateChannelCode();
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();

    try {
      const result = db.prepare(
        'INSERT INTO channels (name, code, created_by, is_private, expires_at, voice_enabled, is_temp_voice) VALUES (?, ?, ?, 0, ?, 1, 1)'
      ).run(name.trim(), code, socket.user.id, expiresAt);

      const channelId = result.lastInsertRowid;
      const allUsers = db.prepare('SELECT id FROM users').all();
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      for (const u of allUsers) insertMember.run(channelId, u.id);

      const channel = {
        id: channelId, name: name.trim(), code, display_code: code,
        created_by: socket.user.id, topic: '', is_dm: 0, is_private: 0,
        expires_at: expiresAt, voice_enabled: 1, is_temp_voice: 1
      };

      for (const [, s] of io.sockets.sockets) {
        if (s.user) s.join(`channel:${code}`);
      }
      io.emit('temp-channel-created', channel);
      socket.emit('temp-channel-join-voice', { code });
    } catch (err) {
      console.error('Create temp channel error:', err);
      socket.emit('error-msg', 'Failed to create temporary channel');
    }
  });

  // ── Join channel by code ────────────────────────────────
  socket.on('join-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    // (#5381) Guests can't widen their own access beyond the admin's
    // guest_channels whitelist by entering an invite code.
    if (socket.user.isGuest) {
      return socket.emit('error-msg', 'Guests cannot join channels by code');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code) return socket.emit('error-msg', 'Invalid channel code');

    // (#5345) Helper: figure out which channels a server-code / vanity-code
    // joiner should be added to. Always EXCLUDES private parents (private
    // channels were never supposed to be unlocked by an invite code).
    // If the admin has set `default_join_channels` to a non-empty JSON
    // array of channel IDs, we restrict the auto-join to that intersection
    // so admins can curate which public channels new arrivals land in.
    // When `explicitChannelIds` is passed (a managed invite link's own channel
    // grant), it overrides the global default_join_channels setting. An empty
    // array means "all public" — same as leaving the global default unset.
    const _resolveAutoJoinChannels = (explicitChannelIds) => {
      const allParents = db.prepare(
        "SELECT id, code, parent_channel_id FROM channels WHERE parent_channel_id IS NULL AND is_dm = 0 AND is_private = 0 AND (code_visibility IS NULL OR code_visibility != 'private')"
      ).all();
      let allowSet = null;
      if (Array.isArray(explicitChannelIds)) {
        if (explicitChannelIds.length > 0) {
          allowSet = new Set(explicitChannelIds.map(n => parseInt(n)).filter(n => Number.isFinite(n)));
        }
        // empty array → allowSet stays null → "all public"
      } else {
        try {
          const djc = db.prepare("SELECT value FROM server_settings WHERE key = 'default_join_channels'").get();
          if (djc && djc.value) {
            const parsed = JSON.parse(djc.value);
            if (Array.isArray(parsed) && parsed.length > 0) {
              allowSet = new Set(parsed.map(n => parseInt(n)).filter(n => Number.isFinite(n)));
            }
          }
        } catch { /* malformed JSON falls through to "all public" */ }
      }
      const parents = allowSet ? allParents.filter(p => allowSet.has(p.id)) : allParents;
      return { parents, allowSet };
    };

    const _doAutoJoin = (explicitChannelIds) => {
      const { parents, allowSet } = _resolveAutoJoinChannels(explicitChannelIds);
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      const joinedChannelIds = [];
      let joinedCount = 0;
      const txn = db.transaction(() => {
        for (const parent of parents) {
          insertMember.run(parent.id, socket.user.id);
          socket.join(`channel:${parent.code}`);
          joinedChannelIds.push(parent.id);
          joinedCount++;
          // Sub-channels: never grant private subs via invite. When a
          // default-channels allowlist is set, only grant subs whose
          // parent is on the list (matches admin intent).
          const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(parent.id);
          for (const sub of subs) {
            insertMember.run(sub.id, socket.user.id);
            socket.join(`channel:${sub.code}`);
            joinedChannelIds.push(sub.id);
            joinedCount++;
          }
        }
      });
      txn();
      // (#5389) Apply each channel's default role after membership is settled.
      for (const chId of joinedChannelIds) _applyChannelDefaultRole(chId, socket.user.id);
      return joinedCount;
    };

    // ── Managed invite link (multi-code menu) ──────────
    // Checked before the legacy vanity/server codes and before the hex-format
    // gate, since a managed code can be a custom slug. Each carries its own
    // channel grant, on/off switch, and optional expiry by time / distinct-user
    // count. A user who already redeemed a code can re-enter it freely (e.g. to
    // refresh) without burning another use against the limit.
    const inviteRow = db.prepare(
      "SELECT *, (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS is_expired FROM invite_codes WHERE code = ?"
    ).get(code);
    if (inviteRow) {
      if (!inviteRow.enabled) {
        return socket.emit('error-msg', 'This invite link has been disabled.');
      }
      if (inviteRow.is_expired) {
        return socket.emit('error-msg', 'This invite link has expired.');
      }
      const alreadyUsed = db.prepare(
        'SELECT 1 FROM invite_code_uses WHERE invite_code_id = ? AND user_id = ?'
      ).get(inviteRow.id, socket.user.id);
      if (!alreadyUsed && inviteRow.max_uses > 0) {
        const used = db.prepare(
          'SELECT COUNT(*) AS n FROM invite_code_uses WHERE invite_code_id = ?'
        ).get(inviteRow.id).n;
        if (used >= inviteRow.max_uses) {
          return socket.emit('error-msg', 'This invite link has reached its use limit.');
        }
      }
      let chList = [];
      try {
        const parsed = JSON.parse(inviteRow.channels || '[]');
        if (Array.isArray(parsed)) chList = parsed;
      } catch { /* malformed → empty array → all public */ }
      const joinedCount = _doAutoJoin(chList);
      db.prepare(
        'INSERT OR IGNORE INTO invite_code_uses (invite_code_id, user_id) VALUES (?, ?)'
      ).run(inviteRow.id, socket.user.id);
      socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
      socket.emit('error-msg', `Invite accepted — joined ${joinedCount} channel${joinedCount !== 1 ? 's' : ''}`);
      return;
    }

    // Check if this is a vanity invite code first
    const vanityRow = db.prepare("SELECT value FROM server_settings WHERE key = 'vanity_code'").get();
    const isVanity = vanityRow && vanityRow.value && vanityRow.value === code;

    // For vanity codes, resolve to the actual server code
    if (isVanity) {
      const joinedCount = _doAutoJoin();
      socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
      socket.emit('error-msg', `Invite accepted — joined ${joinedCount} channel${joinedCount !== 1 ? 's' : ''}`);
      return;
    }

    // Standard 8-char hex code
    if (!/^[a-f0-9]{8}$/i.test(code)) {
      return socket.emit('error-msg', 'Invalid channel code format');
    }

    // ── Check if this is a server-wide invite code ─────
    const serverCodeRow = db.prepare("SELECT value FROM server_settings WHERE key = 'server_code'").get();
    if (serverCodeRow && serverCodeRow.value && serverCodeRow.value === code) {
      const joinedCount = _doAutoJoin();
      socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
      socket.emit('error-msg', `Server code accepted — joined ${joinedCount} channel${joinedCount !== 1 ? 's' : ''}`);
      return;
    }

    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel) {
      return socket.emit('error-msg', 'Invalid channel code — double-check it');
    }

    // (#5348) DMs are private one-to-one channels. Their codes must never be
    // usable by a third party — even a read-only presence leaks metadata
    // (who is talking to whom, timing, frequency). Reject silently with the
    // same generic error so callers can't distinguish "no channel" from "is DM".
    if (channel.is_dm) {
      return socket.emit('error-msg', 'Invalid channel code — double-check it');
    }

    const membership = db.prepare(
      'SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);

    // (#5408) A channel code is not a skeleton key for sub-channels. Access to
    // a sub-channel is inherited by joining its PARENT (which auto-adds the
    // parent's public subs); you never join a sub-channel directly by entering
    // or crafting its code. Without this, a non-member could paste a
    // sub-channel's code (or open a ?channel=<sub> deep link) and the plain
    // join below would hand them membership, unlocking its history and the
    // ability to post. Only gate NEW joins — existing members re-emit
    // join-channel to refresh (e.g. after a message move) and must still pass.
    if (!membership && !socket.user.isAdmin && channel.parent_channel_id) {
      const isPrivateSub = channel.is_private || channel.code_visibility === 'private';
      const parentMember = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(channel.parent_channel_id, socket.user.id);
      // Private subs are never granted by code (they need an explicit add,
      // matching the public-only auto-join rule); public subs require parent
      // membership. Reuse the generic error so the code's existence stays hidden.
      if (isPrivateSub || !parentMember) {
        return socket.emit('error-msg', 'Invalid channel code — double-check it');
      }
    }

    if (!membership) {
      db.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).run(channel.id, socket.user.id);

      try {
        const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1').all();
        const insertAutoRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
        for (const ar of autoRoles) {
          insertAutoRole.run(socket.user.id, ar.id);
          applyRoleChannelAccess(ar.id, socket.user.id, 'grant');
        }
      } catch { /* non-critical */ }

      // (#5389) Per-channel default role auto-grant.
      _applyChannelDefaultRole(channel.id, socket.user.id);
    }

    if (!channel.parent_channel_id) {
      const subs = db.prepare(
        'SELECT id, code FROM channels WHERE parent_channel_id = ? AND is_private = 0'
      ).all(channel.id);
      const insertSub = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      subs.forEach(sub => {
        insertSub.run(sub.id, socket.user.id);
        socket.join(`channel:${sub.code}`);
        _applyChannelDefaultRole(sub.id, socket.user.id);
      });
    }

    if (!membership) {
      if (channel.code_mode === 'dynamic' && channel.code_rotation_type === 'joins') {
        const newCount = (channel.code_rotation_counter || 0) + 1;
        const threshold = channel.code_rotation_interval || 5;
        if (newCount >= threshold) {
          const newCode = generateChannelCode();
          db.prepare(
            'UPDATE channels SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(newCode, channel.id);
          const oldRoom = `channel:${code}`;
          const newRoom = `channel:${newCode}`;
          const roomSockets = io.sockets.adapter.rooms.get(oldRoom);
          if (roomSockets) {
            for (const sid of [...roomSockets]) {
              const s = io.sockets.sockets.get(sid);
              if (s) {
                s.leave(oldRoom);
                s.join(newRoom);
                if (s.currentChannel === code) s.currentChannel = newCode;
              }
            }
          }
          if (channelUsers.has(code)) {
            channelUsers.set(newCode, channelUsers.get(code));
            channelUsers.delete(code);
          }
          io.to(newRoom).emit('channel-code-rotated', { channelId: channel.id, oldCode: code, newCode });
          channel.code = newCode;
        } else {
          db.prepare('UPDATE channels SET code_rotation_counter = ? WHERE id = ?').run(newCount, channel.id);
        }
      }
    }

    const activeCode = channel.code;
    socket.join(`channel:${activeCode}`);

    io.to(`channel:${activeCode}`).emit('user-joined', {
      channelCode: activeCode,
      user: { id: socket.user.id, username: socket.user.displayName }
    });

    // Webhook event: member-joined (3.13.0)
    try {
      fireWebhookEvent?.(channel.id, activeCode, 'member-joined', {
        user: { id: socket.user.id, username: socket.user.displayName }
      });
    } catch { /* best-effort */ }

    const isPrivateCode = channel.code_visibility === 'private' || channel.is_private;
    const joinerCanSeeCode = socket.user.isAdmin
      || channel.created_by === socket.user.id
      || userHasPermission(socket.user.id, 'kick_user', channel.id);
    socket.emit('channel-joined', {
      id: channel.id, name: channel.name, code: activeCode,
      display_code: (isPrivateCode && !joinerCanSeeCode) ? '••••••••' : activeCode,
      created_by: channel.created_by, topic: channel.topic || '', is_dm: channel.is_dm || 0
    });

    socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
  });

  // ── Leave channel ───────────────────────────────────────
  socket.on('leave-channel', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid code' });

    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });
    if (socket.user.isAdmin) return cb({ error: 'Admins cannot leave channels' });
    if (channel.is_dm) return cb({ error: 'Use Delete DM instead' });

    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channel.id, socket.user.id);

    if (!channel.parent_channel_id) {
      const subs = db.prepare('SELECT id FROM channels WHERE parent_channel_id = ?').all(channel.id);
      const delSub = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
      subs.forEach(s => delSub.run(s.id, socket.user.id));
    }

    socket.leave(`channel:${code}`);

    if (socket.currentChannel === code) {
      const prevUsers = channelUsers.get(code);
      if (prevUsers) {
        prevUsers.delete(socket.user.id);
        emitOnlineUsers(code);
      }
      socket.currentChannel = null;
    }

    socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
    cb({ success: true });
  });

  // ── Switch active channel ───────────────────────────────
  socket.on('enter-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const ch = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!ch) return;
    const isMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(ch.id, socket.user.id);
    if (!isMember) {
      if (socket.user.isAdmin && !ch.is_dm) {
        db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch.id, socket.user.id);
      } else {
        return socket.emit('error-msg', 'Not a member of this channel');
      }
    }

    if (socket.currentChannel && socket.currentChannel !== code) {
      const prevUsers = channelUsers.get(socket.currentChannel);
      if (prevUsers) {
        prevUsers.delete(socket.user.id);
        emitOnlineUsers(socket.currentChannel);
      }
    }

    socket.currentChannel = code;
    socket.join(`channel:${code}`);

    if (!channelUsers.has(code)) channelUsers.set(code, new Map());
    channelUsers.get(code).set(socket.user.id, {
      id: socket.user.id,
      username: socket.user.displayName,
      socketId: socket.id,
      status: socket.user.status || 'online',
      statusText: socket.user.statusText || '',
      avatar: socket.user.avatar || null,
      avatar_shape: socket.user.avatar_shape || 'circle'
    });

    emitOnlineUsers(code);
  });

  // ── Delete channel ──────────────────────────────────────
  socket.on('delete-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const delCode = typeof data.code === 'string' ? data.code.trim() : '';
    const delCh = delCode ? db.prepare('SELECT created_by, is_temp_voice FROM channels WHERE code = ?').get(delCode) : null;
    const isOwnTemp = delCh && delCh.is_temp_voice && delCh.created_by === socket.user.id;
    if (!socket.user.isAdmin && !isOwnTemp && !userHasPermission(socket.user.id, 'delete_channel')) {
      return socket.emit('error-msg', 'Only admins can delete channels');
    }

    const code = delCode;
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const deleteAll = db.transaction((chId) => {
      db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(chId);
      db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM channels WHERE id = ?').run(chId);
    });
    deleteAll(channel.id);

    io.to(`channel:${code}`).to(`voice:${code}`).emit('channel-deleted', { code });

    channelUsers.delete(code);
    voiceUsers.delete(code);
    activeMusic.delete(code);
    musicQueues.delete(code);

    _audit({ actor: socket.user, action: 'channel_delete',
      target_type: 'channel', target_id: channel.id, target_name: channel.name,
      details: { code, parent_channel_id: channel.parent_channel_id || null } });
  });

  // ── Rename channel ──────────────────────────────────────
  socket.on('rename-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0 || name.length > 50) {
      return socket.emit('error-msg', 'Channel name must be 1-50 characters');
    }
    if (!/^[\w\s\-!?.,'\p{L}\p{M}\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji}\uFE0F\u200D]+$/u.test(name)) {
      return socket.emit('error-msg', 'Channel name contains invalid characters');
    }

    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');

    const permChannel = channel.parent_channel_id || channel.id;
    const renamePermission = channel.parent_channel_id ? 'rename_sub_channel' : 'rename_channel';
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, renamePermission, permChannel)) {
      return socket.emit('error-msg', 'You don\'t have permission to rename channels');
    }

    try {
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, channel.id);
      broadcastChannelLists();
      io.to(code).emit('channel-renamed', { code, name });
      _audit({ actor: socket.user, action: 'channel_rename',
        target_type: 'channel', target_id: channel.id, target_name: name,
        details: { code, oldName: channel.name, newName: name } });
    } catch (err) {
      console.error('Rename channel error:', err);
      socket.emit('error-msg', 'Failed to rename channel');
    }
  });

  // ── Sub-channels ─────────────────────────────────────────
  socket.on('create-sub-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const parentCode = typeof data.parentCode === 'string' ? data.parentCode.trim() : '';
    if (!parentCode || !/^[a-f0-9]{8}$/i.test(parentCode)) return;

    const parentChannel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(parentCode);
    if (!parentChannel) return socket.emit('error-msg', 'Parent channel not found');

    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_sub_channels', parentChannel.id) && !userHasPermission(socket.user.id, 'create_channel', parentChannel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to create sub-channels');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0 || name.length > 50) {
      return socket.emit('error-msg', 'Sub-channel name must be 1-50 characters');
    }
    if (!/^[\w\s\-!?.,'\p{L}\p{M}\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji}\uFE0F\u200D]+$/u.test(name)) {
      return socket.emit('error-msg', 'Sub-channel name contains invalid characters');
    }

    if (parentChannel.parent_channel_id) {
      return socket.emit('error-msg', 'Cannot create sub-channels inside sub-channels');
    }

    const code = generateChannelCode();
    const isPrivate = data.isPrivate ? 1 : 0;

    let expiresAt = null;
    if (data.temporary && data.duration) {
      const hours = Math.max(1, Math.min(720, parseInt(data.duration, 10)));
      if (!isNaN(hours)) {
        expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      }
    }

    const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id = ?').get(parentChannel.id);
    const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;

    try {
      const result = db.prepare(
        'INSERT INTO channels (name, code, created_by, parent_channel_id, position, is_private, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(name, code, socket.user.id, parentChannel.id, position, isPrivate, expiresAt);

      const parentMembers = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(parentChannel.id);
      const membersToAdd = isPrivate ? [{ user_id: socket.user.id }] : parentMembers;
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      membersToAdd.forEach(m => insertMember.run(result.lastInsertRowid, m.user_id));

      // (#5328) Inherit role-channel-access from the parent channel so that
      // roles configured to grant/revoke access on the parent automatically
      // apply to newly-created sub-channels. Without this, server owners had
      // to re-add every role to every new sub-channel manually. Admins can
      // still customize per-sub-channel access afterwards via the role UI.
      try {
        const parentAccess = db.prepare(
          'SELECT role_id, grant_on_promote, revoke_on_demote FROM role_channel_access WHERE channel_id = ?'
        ).all(parentChannel.id);
        if (parentAccess.length) {
          const insAccess = db.prepare(
            'INSERT OR IGNORE INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, ?, ?)'
          );
          const insMemberRole = db.prepare(
            'INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)'
          );
          parentAccess.forEach(a => {
            insAccess.run(a.role_id, result.lastInsertRowid, a.grant_on_promote, a.revoke_on_demote);
            // Mirror channel membership for current role holders if the role
            // is configured to grant access on promote. Private sub-channels
            // also receive role-based members so the role still works there.
            if (a.grant_on_promote) {
              const holders = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(a.role_id);
              holders.forEach(h => insMemberRole.run(result.lastInsertRowid, h.user_id));
            }
          });
        }
      } catch (rcaErr) {
        console.error('Sub-channel role inheritance error:', rcaErr);
      }

      broadcastChannelLists();
    } catch (err) {
      console.error('Create sub-channel error:', err);
      socket.emit('error-msg', 'Failed to create sub-channel');
    }
  });

  socket.on('delete-sub-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel || !channel.parent_channel_id) {
      return socket.emit('error-msg', 'Sub-channel not found');
    }

    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_sub_channels', channel.parent_channel_id) && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to delete sub-channels');
    }

    try {
      db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(channel.id);
      db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
      broadcastChannelLists();
      socket.emit('error-msg', 'Sub-channel deleted');
    } catch (err) {
      console.error('Delete sub-channel error:', err);
      socket.emit('error-msg', 'Failed to delete sub-channel');
    }
  });

  // ── Channel feature toggles ─────────────────────────────
  socket.on('toggle-channel-permission', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) return socket.emit('error-msg', 'You don\'t have permission to toggle channel permissions');

    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const permission = typeof data.permission === 'string' ? data.permission.trim() : '';
    const validPerms = ['streams', 'music', 'media', 'voice', 'text', 'read_only', 'soundboard'];
    if (!validPerms.includes(permission)) return socket.emit('error-msg', 'Invalid permission');

    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');

    const colMap = { streams: 'streams_enabled', music: 'music_enabled', media: 'media_enabled', voice: 'voice_enabled', text: 'text_enabled', read_only: 'read_only', soundboard: 'soundboard_enabled' };
    const colName = colMap[permission];
    const current = channel[colName];
    const newVal = current ? 0 : 1;

    if ((permission === 'streams' || permission === 'music') && newVal === 1 && channel.voice_enabled === 0) {
      return socket.emit('error-msg', 'Enable voice first — streams and music require voice');
    }

    try {
      db.prepare(`UPDATE channels SET ${colName} = ? WHERE id = ?`).run(newVal, channel.id);
      if (permission === 'voice' && newVal === 0) {
        db.prepare('UPDATE channels SET streams_enabled = 0, music_enabled = 0 WHERE id = ?').run(channel.id);
        const room = voiceUsers.get(code);
        if (room && room.size > 0) {
          for (const entry of Array.from(room.values())) {
            const targetSocket = io.sockets.sockets.get(entry.socketId);
            if (!targetSocket) continue;
            // Force clients out of voice immediately so they don't keep
            // reconnecting to a channel that no longer permits voice.
            targetSocket.emit('voice-channel-gone', { code });
            handleVoiceLeave(targetSocket, code);
          }
          broadcastVoiceUsers(code);
        }
      }

      const labelMap = { streams: 'Screen sharing', music: 'Music sharing', media: 'Media uploads', voice: 'Voice chat', text: 'Text chat', read_only: 'Read-only mode', soundboard: 'Soundboard' };
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('channel-permission-updated', { code, permission, enabled: !!newVal });
      socket.emit('toast', { message: `${labelMap[permission]} ${newVal ? 'enabled' : 'disabled'} for this channel`, type: 'success' });
    } catch (err) {
      console.error('Toggle permission error:', err);
      socket.emit('error-msg', 'Failed to toggle permission');
    }
  });

  socket.on('toggle-cleanup-exempt', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can change cleanup exemptions');
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    const newVal = channel.cleanup_exempt ? 0 : 1;
    try {
      db.prepare('UPDATE channels SET cleanup_exempt = ? WHERE id = ?').run(newVal, channel.id);
      broadcastChannelLists();
      socket.emit('toast', { message: newVal ? '🛡️ Channel exempt from auto-cleanup' : 'Cleanup protection removed', type: 'success' });
    } catch (err) {
      console.error('Toggle cleanup exempt error:', err);
      socket.emit('error-msg', 'Failed to toggle cleanup exemption');
    }
  });

  socket.on('set-slow-mode', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) return socket.emit('error-msg', 'You don\'t have permission to set slow mode');
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const interval = parseInt(data.interval);
    if (isNaN(interval) || interval < 0 || interval > 3600) {
      return socket.emit('error-msg', 'Slow mode interval must be 0-3600 seconds');
    }
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    try {
      db.prepare('UPDATE channels SET slow_mode_interval = ? WHERE id = ?').run(interval, channel.id);
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('slow-mode-updated', { code, interval });
      socket.emit('toast', { message: interval > 0 ? `Slow mode set to ${interval}s` : 'Slow mode disabled', type: 'success' });
    } catch (err) {
      console.error('Set slow mode error:', err);
      socket.emit('error-msg', 'Failed to set slow mode');
    }
  });

  // (#5389) Per-channel default role. Setting it auto-grants the role
  // (channel-scoped) to every existing member and every future joiner.
  // Clearing it (roleId = null/0) leaves existing grants alone — admins can
  // revoke from the Roles UI if they want to strip them.
  socket.on('set-channel-default-role', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return socket.emit('error-msg', 'You don\'t have permission to set a default role');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');

    let roleId = null;
    if (data.roleId !== null && data.roleId !== undefined && data.roleId !== 0 && data.roleId !== '') {
      const parsed = parseInt(data.roleId, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return socket.emit('error-msg', 'Invalid role');
      }
      const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(parsed);
      if (!role) return socket.emit('error-msg', 'Role not found');
      roleId = role.id;
    }

    try {
      db.prepare('UPDATE channels SET default_role_id = ? WHERE id = ?').run(roleId, channel.id);

      if (roleId) {
        // Backfill: grant the new default to every current member of this
        // channel. INSERT OR IGNORE protects against duplicates if any
        // member already holds the role channel-scoped.
        const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id);
        const insertRole = db.prepare(
          'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)'
        );
        const txn = db.transaction(() => {
          for (const m of members) insertRole.run(m.user_id, roleId, channel.id, socket.user.id);
        });
        txn();
        if (typeof applyRoleChannelAccess === 'function') {
          for (const m of members) {
            try { applyRoleChannelAccess(roleId, m.user_id, 'grant'); } catch { /* non-critical */ }
          }
        }
      }

      broadcastChannelLists();
      io.to(`channel:${code}`).emit('channel-default-role-updated', { code, roleId });
      socket.emit('toast', { message: roleId ? 'Default role set' : 'Default role cleared', type: 'success' });
      _audit({ actor: socket.user, action: 'channel_default_role_set',
        target_type: 'channel', target_id: channel.id, details: { code, roleId } });
    } catch (err) {
      console.error('Set default role error:', err);
      socket.emit('error-msg', 'Failed to set default role');
    }
  });

  socket.on('set-sort-alphabetical', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) return socket.emit('error-msg', 'You don\'t have permission to change sort settings');
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    let sortVal = 0;
    if (data.mode === 'alpha' || data.enabled === true) sortVal = 1;
    else if (data.mode === 'created') sortVal = 2;
    else if (data.mode === 'oldest') sortVal = 3;
    else if (data.mode === 'dynamic') sortVal = 4;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    try {
      db.prepare('UPDATE channels SET sort_alphabetical = ? WHERE id = ?').run(sortVal, channel.id);
      broadcastChannelLists();
    } catch (err) {
      console.error('Set sort mode error:', err);
      socket.emit('error-msg', 'Failed to update sort setting');
    }
  });

  socket.on('set-voice-user-limit', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to change the voice user limit');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const limit = typeof data.limit === 'number' ? data.limit : parseInt(data.limit);
    if (isNaN(limit) || limit < 0 || limit > 99) {
      return socket.emit('error-msg', 'Voice user limit must be 0 (unlimited) or 2–99');
    }
    const normalizedLimit = (limit === 1) ? 0 : limit;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    try {
      db.prepare('UPDATE channels SET voice_user_limit = ? WHERE id = ?').run(normalizedLimit, channel.id);
      broadcastChannelLists();
      socket.emit('toast', { message: normalizedLimit >= 2 ? `👥 Voice limit set to ${normalizedLimit}` : '👥 Voice user limit removed', type: 'success' });
    } catch (err) {
      console.error('Set voice user limit error:', err);
      socket.emit('error-msg', 'Failed to set voice user limit');
    }
  });

  socket.on('set-voice-bitrate', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to change voice bitrate');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const bitrate = typeof data.bitrate === 'number' ? data.bitrate : parseInt(data.bitrate);
    const validBitrates = [0, 32, 64, 96, 128, 256, 512];
    if (!validBitrates.includes(bitrate)) {
      return socket.emit('error-msg', 'Invalid bitrate value');
    }
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    try {
      db.prepare('UPDATE channels SET voice_bitrate = ? WHERE id = ?').run(bitrate, channel.id);
      broadcastChannelLists();
      io.to(`voice:${code}`).emit('voice-bitrate-updated', { code, bitrate });
      socket.emit('toast', { message: bitrate > 0 ? `🎙️ Voice bitrate set to ${bitrate} kbps` : '🎙️ Voice bitrate set to auto', type: 'success' });
    } catch (err) {
      console.error('Set voice bitrate error:', err);
      socket.emit('error-msg', 'Failed to set voice bitrate');
    }
  });

  socket.on('set-channel-expiry', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to set self-destruct timers');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    // #5390 — second mode: 'clear' wipes messages periodically instead of
    // deleting the whole channel. Anything other than 'clear' is treated
    // as the legacy 'delete' behaviour so unknown values fail closed
    // toward the original semantics.
    const mode = data.mode === 'clear' ? 'clear' : 'delete';
    let expiresAt = null;
    let intervalHours = null;
    if (data.hours && data.hours > 0) {
      const hours = Math.max(1, Math.min(720, parseInt(data.hours, 10)));
      if (isNaN(hours)) return socket.emit('error-msg', 'Invalid duration');
      expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      intervalHours = hours;
    }
    try {
      db.prepare(
        'UPDATE channels SET expires_at = ?, auto_delete_mode = ?, auto_delete_interval_hours = ? WHERE id = ?'
      ).run(expiresAt, mode, intervalHours, channel.id);
      broadcastChannelLists();
      if (expiresAt) {
        const hours = Math.round((new Date(expiresAt) - Date.now()) / 3600000);
        const verb = mode === 'clear' ? `clear messages every ${hours}h` : `self-destruct in ${hours}h`;
        socket.emit('toast', { message: `⏱️ Channel will ${verb}`, type: 'success' });
      } else {
        socket.emit('toast', { message: '⏱️ Self-destruct timer removed', type: 'success' });
      }
    } catch (err) {
      console.error('Set channel expiry error:', err);
      socket.emit('error-msg', 'Failed to set self-destruct timer');
    }
  });

  socket.on('set-notification-type', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to change channel notification type');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const type = typeof data.type === 'string' ? data.type : '';
    if (!['default', 'announcement'].includes(type)) return socket.emit('error-msg', 'Invalid notification type');
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    try {
      db.prepare('UPDATE channels SET notification_type = ? WHERE id = ?').run(type, channel.id);
      broadcastChannelLists();
      const labels = { default: '🔔 Channel notifications reset to default', announcement: '📢 Channel set to announcement mode' };
      socket.emit('toast', { message: labels[type], type: 'success' });
    } catch (err) {
      console.error('Set notification type error:', err);
      socket.emit('error-msg', 'Failed to set notification type');
    }
  });

  socket.on('set-channel-afk', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to change AFK settings');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const subCode = typeof data.subCode === 'string' ? data.subCode.trim() : '';
    const timeout = parseInt(data.timeout);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 1440) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0 AND parent_channel_id IS NULL').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found or is a sub-channel');
    if (subCode) {
      if (!/^[a-f0-9]{8}$/i.test(subCode)) return;
      const sub = db.prepare('SELECT id FROM channels WHERE code = ? AND parent_channel_id = ?').get(subCode, channel.id);
      if (!sub) return socket.emit('error-msg', 'Sub-channel not found or does not belong to this channel');
    }
    try {
      db.prepare('UPDATE channels SET afk_sub_code = ?, afk_timeout_minutes = ? WHERE id = ?')
        .run(subCode || null, timeout, channel.id);
      broadcastChannelLists();
      if (subCode && timeout > 0) {
        socket.emit('toast', { message: `💤 AFK sub-channel set (${timeout}min timeout)`, type: 'success' });
      } else {
        socket.emit('toast', { message: '💤 AFK sub-channel disabled', type: 'success' });
      }
    } catch (err) {
      console.error('Set channel AFK error:', err);
      socket.emit('error-msg', 'Failed to set AFK settings');
    }
  });

  // ── Channel reordering ──────────────────────────────────
  socket.on('reorder-channels', (data) => {
    if (!data || typeof data !== 'object') return;
    const order = data.order;
    if (!Array.isArray(order) || order.length > 500) return;
    // (#5424) If every channel in this reorder is a sub-channel under one
    // parent, manage_sub_channels on that parent is enough. A top-level (or
    // mixed-parent) reorder still requires create_channel.
    let _reorderParent = null;
    try {
      const codes = order.map(it => (it && typeof it.code === 'string') ? it.code : null).filter(Boolean);
      if (codes.length) {
        const ph = codes.map(() => '?').join(',');
        const rows = db.prepare(`SELECT parent_channel_id FROM channels WHERE code IN (${ph}) AND is_dm = 0`).all(...codes);
        const parents = new Set(rows.map(r => r.parent_channel_id));
        if (parents.size === 1) _reorderParent = [...parents][0];
      }
    } catch { /* fall through to create_channel check */ }
    if (!_canManageSubsOf(_reorderParent)) return socket.emit('error-msg', 'You don\'t have permission to reorder channels');
    try {
      const update = db.prepare('UPDATE channels SET position = ? WHERE code = ?');
      const txn = db.transaction(() => {
        for (const item of order) {
          if (typeof item.code === 'string' && typeof item.position === 'number') {
            update.run(item.position, item.code);
          }
        }
      });
      txn();
      broadcastChannelLists();
    } catch (err) {
      console.error('Reorder channels error:', err);
      socket.emit('error-msg', 'Failed to reorder channels');
    }
  });

  socket.on('move-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const direction = data.direction;
    if (direction !== 'up' && direction !== 'down') return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return;
    if (!_canManageSubsOf(channel.parent_channel_id)) return socket.emit('error-msg', 'You don\'t have permission to reorder channels'); // (#5424)
    try {
      const parentId = channel.parent_channel_id;
      let siblings;
      if (parentId) {
        siblings = db.prepare('SELECT id, code, position FROM channels WHERE parent_channel_id = ? ORDER BY position').all(parentId);
      } else {
        siblings = db.prepare('SELECT id, code, position FROM channels WHERE parent_channel_id IS NULL AND is_dm = 0 ORDER BY position').all();
      }
      const idx = siblings.findIndex(s => s.code === code);
      if (idx < 0) return;
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= siblings.length) return;
      const myPos = siblings[idx].position;
      const theirPos = siblings[swapIdx].position;
      if (myPos === theirPos) {
        const update = db.prepare('UPDATE channels SET position = ? WHERE id = ?');
        siblings.forEach((s, i) => update.run(i, s.id));
        return socket.emit('get-channels');
      }
      db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(theirPos, siblings[idx].id);
      db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(myPos, siblings[swapIdx].id);
      broadcastChannelLists();
    } catch (err) {
      console.error('Move channel error:', err);
      socket.emit('error-msg', 'Failed to move channel');
    }
  });

  // ── Channel reparenting ─────────────────────────────────
  socket.on('reparent-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const newParentCode = data.newParentCode;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    // (#5424) Promoting a sub to top-level, or demoting a top-level channel,
    // changes server structure -> create_channel. Re-nesting an existing
    // sub-channel under a parent is sub-channel management.
    const _promoting = (newParentCode === null || newParentCode === undefined);
    if (_promoting || !channel.parent_channel_id) {
      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) return socket.emit('error-msg', 'You don\'t have permission to move channels');
    }
    try {
      if (newParentCode === null || newParentCode === undefined) {
        if (!channel.parent_channel_id) return socket.emit('error-msg', 'Channel is already top-level');
        const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id IS NULL AND is_dm = 0').get();
        const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;
        db.prepare('UPDATE channels SET parent_channel_id = NULL, position = ?, category = NULL WHERE id = ?').run(position, channel.id);
        broadcastChannelLists();
        socket.emit('error-msg', `"${channel.name}" promoted to top-level channel`);
      } else {
        const parentCode = typeof newParentCode === 'string' ? newParentCode.trim() : '';
        if (!parentCode || !/^[a-f0-9]{8}$/i.test(parentCode)) return;
        const newParent = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(parentCode);
        if (!newParent) return socket.emit('error-msg', 'Target parent not found');
        if (newParent.parent_channel_id) return socket.emit('error-msg', 'Cannot nest channels more than one level deep');
        if (channel.id === newParent.id) return socket.emit('error-msg', 'Cannot move a channel under itself');
        const subCount = db.prepare('SELECT COUNT(*) as cnt FROM channels WHERE parent_channel_id = ?').get(channel.id);
        if (subCount && subCount.cnt > 0) return socket.emit('error-msg', 'Cannot make a channel with sub-channels into a sub-channel. Move or remove its sub-channels first.');
        if (channel.parent_channel_id === newParent.id) return socket.emit('error-msg', 'Channel is already under that parent');
        // (#5424) A sub-channel manager of the destination parent (or the
        // channel's current parent) may re-nest an existing sub-channel.
        if (!_canManageSubsOf(newParent.id) && !_canManageSubsOf(channel.parent_channel_id)) {
          return socket.emit('error-msg', 'You don\'t have permission to move channels');
        }
        const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id = ?').get(newParent.id);
        const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;
        db.prepare('UPDATE channels SET parent_channel_id = ?, position = ?, category = NULL WHERE id = ?').run(newParent.id, position, channel.id);
        broadcastChannelLists();
        socket.emit('error-msg', `"${channel.name}" moved under "${newParent.name}"`);
      }
    } catch (err) {
      console.error('Reparent channel error:', err);
      socket.emit('error-msg', 'Failed to move channel');
    }
  });

  // ── Channel categories ──────────────────────────────────
  socket.on('set-channel-category', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    let category = typeof data.category === 'string' ? data.category.trim() : '';
    if (category.length > 30) category = category.slice(0, 30);
    if (!category) category = null;
    const channel = db.prepare('SELECT id, parent_channel_id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSubsOf(channel.parent_channel_id)) return socket.emit('error-msg', 'You don\'t have permission to set categories'); // (#5424)
    // Case-insensitive dedup: if another channel already uses this tag with
    // different casing, adopt the existing casing so they group together.
    if (category) {
      const existing = db.prepare(
        'SELECT category FROM channels WHERE category IS NOT NULL AND id != ? AND category COLLATE NOCASE = ?'
      ).get(channel.id, category);
      if (existing) category = existing.category;
    }
    try {
      db.prepare('UPDATE channels SET category = ? WHERE id = ?').run(category, channel.id);
      broadcastChannelLists();
      socket.emit('error-msg', category ? `Category set to "${category}"` : 'Category removed');
    } catch (err) {
      console.error('Set category error:', err);
      socket.emit('error-msg', 'Failed to set category');
    }
  });

  // ── Channel topics ──────────────────────────────────────
  socket.on('set-channel-topic', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'set_channel_topic', channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to set channel topics');
    }
    const { sanitizeText } = require('./helpers');
    const topic = isString(data.topic, 0, 256) ? sanitizeText(data.topic.trim()) : '';
    try {
      db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, channel.id);
    } catch (err) {
      console.error('Set topic error:', err);
      return socket.emit('error-msg', 'Failed to update topic');
    }
    io.to(`channel:${code}`).emit('channel-topic-changed', { code, topic });
  });

  // ── Channel code settings ───────────────────────────────
  socket.on('update-channel-code-settings', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to change channel code settings');
    }
    const channelId = typeof data.channelId === 'number' ? data.channelId : null;
    if (!channelId) return;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel || channel.is_dm) return;
    const validVisibility = ['public', 'private'];
    const validMode = ['static', 'dynamic'];
    const validRotationType = ['time', 'joins'];
    const updates = {};
    if (data.code_visibility && validVisibility.includes(data.code_visibility)) updates.code_visibility = data.code_visibility;
    if (data.code_mode && validMode.includes(data.code_mode)) updates.code_mode = data.code_mode;
    if (data.code_rotation_type && validRotationType.includes(data.code_rotation_type)) updates.code_rotation_type = data.code_rotation_type;
    if (data.code_rotation_interval !== undefined) {
      const n = parseInt(data.code_rotation_interval);
      if (!isNaN(n) && n >= 1 && n <= 10000) updates.code_rotation_interval = n;
    }
    if (Object.keys(updates).length === 0) return;
    const setParts = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) { setParts.push(`${key} = ?`); values.push(val); }
    if (updates.code_mode === 'dynamic') {
      setParts.push('code_rotation_counter = 0');
      setParts.push('code_last_rotated = CURRENT_TIMESTAMP');
    }
    values.push(channelId);
    db.prepare(`UPDATE channels SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
    const updated = db.prepare('SELECT id, code_visibility, code_mode, code_rotation_type, code_rotation_interval FROM channels WHERE id = ?').get(channelId);
    io.to(`channel:${channel.code}`).emit('channel-code-settings-updated', { channelId, channelCode: channel.code, settings: updated });
    socket.emit('error-msg', 'Channel code settings updated');
  });

  socket.on('rotate-channel-code', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can rotate channel codes');
    const channelId = typeof data.channelId === 'number' ? data.channelId : null;
    if (!channelId) return;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
    if (!channel) return;
    const oldCode = channel.code;
    const newCode = generateChannelCode();
    db.prepare('UPDATE channels SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP WHERE id = ?').run(newCode, channelId);
    const oldRoom = `channel:${oldCode}`;
    const newRoom = `channel:${newCode}`;
    const roomSockets = io.sockets.adapter.rooms.get(oldRoom);
    if (roomSockets) {
      for (const sid of [...roomSockets]) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.leave(oldRoom);
          s.join(newRoom);
          if (s.currentChannel === oldCode) s.currentChannel = newCode;
        }
      }
    }
    if (channelUsers.has(oldCode)) {
      channelUsers.set(newCode, channelUsers.get(oldCode));
      channelUsers.delete(oldCode);
    }
    if (voiceUsers.has(oldCode)) {
      voiceUsers.set(newCode, voiceUsers.get(oldCode));
      voiceUsers.delete(oldCode);
    }
    io.to(newRoom).emit('channel-code-rotated', { channelId, oldCode, newCode });
  });

  // ── Invite user to channel ──────────────────────────────
  socket.on('invite-to-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const targetUserId = isInt(data.targetUserId) ? data.targetUserId : null;
    const channelId = isInt(data.channelId) ? data.channelId : null;
    if (!targetUserId || !channelId) return socket.emit('error-msg', 'Invalid invite data');
    if (targetUserId === socket.user.id) return;
    const inviterMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id);
    if (!inviterMember && !socket.user.isAdmin) return socket.emit('error-msg', 'You are not a member of that channel');
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    const channelIsPrivate = channel.is_private || channel.code_visibility === 'private';
    if (channelIsPrivate && !socket.user.isAdmin) {
      const isCreator = channel.created_by === socket.user.id;
      const isMod = userHasPermission(socket.user.id, 'kick_user', channelId);
      if (!isCreator && !isMod) return socket.emit('error-msg', 'Only the channel creator or moderators can invite people to private channels');
    }
    const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) return socket.emit('error-msg', 'User not found');
    const alreadyMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, targetUserId);
    if (alreadyMember) return socket.emit('error-msg', `${targetUser.username} is already in #${channel.name}`);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetUserId);
    if (!channel.parent_channel_id) {
      const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(channel.id);
      const insertSub = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      subs.forEach(sub => insertSub.run(sub.id, targetUserId));
    }
    try {
      const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1').all();
      const insertAutoRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
      for (const ar of autoRoles) {
        insertAutoRole.run(targetUserId, ar.id);
        applyRoleChannelAccess(ar.id, targetUserId, 'grant');
      }
    } catch { /* non-critical */ }
    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === targetUserId);
    for (const ts of targetSockets) {
      ts.join(`channel:${channel.code}`);
      if (!channel.parent_channel_id) {
        const subs = db.prepare('SELECT code FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(channel.id);
        subs.forEach(sub => ts.join(`channel:${sub.code}`));
      }
      ts.emit('channels-list', getEnrichedChannels(targetUserId, ts.user.isAdmin, (room) => ts.join(room)));
      ts.emit('toast', { message: `${socket.user.username} invited you to #${channel.name}`, type: 'info' });
    }
    socket.emit('toast', { message: `Invited ${targetUser.username} to #${channel.name}`, type: 'success' });
  });

  // ── Remove from channel ─────────────────────────────────
  socket.on('remove-from-channel', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid data' });
    const targetUserId = isInt(data.userId) ? data.userId : null;
    const channelId = isInt(data.channelId) ? data.channelId : null;
    if (!targetUserId || !channelId) return cb({ error: 'Invalid data' });
    if (targetUserId === socket.user.id) return cb({ error: 'You can\'t remove yourself' });
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'kick_user', channelId)) {
      return cb({ error: 'You don\'t have permission to remove users from channels' });
    }
    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id, channelId);
      const targetLevel = getUserEffectiveLevel(targetUserId, channelId);
      if (targetLevel >= myLevel) return cb({ error: 'You can\'t remove a user with equal or higher rank' });
    }
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
    if (!channel) return cb({ error: 'Channel not found' });
    const targetUser = db.prepare('SELECT id, username, COALESCE(display_name, username) as displayName FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) return cb({ error: 'User not found' });
    const membershipCheck = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, targetUserId);
    if (!membershipCheck) return cb({ error: `${targetUser.username} is not in #${channel.name}` });
    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channelId, targetUserId);
    const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ?').all(channelId);
    const delSub = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
    subs.forEach(s => delSub.run(s.id, targetUserId));
    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === targetUserId);
    for (const ts of targetSockets) {
      ts.leave(`channel:${channel.code}`);
      subs.forEach(sub => ts.leave(`channel:${sub.code}`));
      ts.emit('channels-list', getEnrichedChannels(targetUserId, ts.user.isAdmin, (room) => ts.join(room)));
      ts.emit('toast', { message: `You were removed from #${channel.name}`, type: 'warning' });
    }
    const channelRoom = channelUsers.get(channel.code);
    if (channelRoom) {
      channelRoom.delete(targetUserId);
      emitOnlineUsers(channel.code);
    }
    cb({ success: true });
    socket.emit('error-msg', `Removed ${targetUser.username} from #${channel.name}`);
  });

  // ── Group DM (3+ participants) ──────────────────────────
  socket.on('start-group-dm', (data) => {
    if (!data || typeof data !== 'object') return;
    if (socket.user.isGuest) {
      return socket.emit('error-msg', 'Guests cannot create group conversations');
    }
    let userIds = [];
    if (Array.isArray(data.userIds)) {
      userIds = [...new Set(data.userIds.map(n => isInt(n) ? n : null).filter(Boolean))];
      userIds = userIds.filter(id => id !== socket.user.id);
    }
    if (userIds.length < 2) {
      return socket.emit('error-msg', 'Group DMs require at least 3 participants (you + 2 others)');
    }
    const placeholders = userIds.map(() => '?').join(',');
    const validUsers = db.prepare(
      `SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u
       LEFT JOIN bans b ON u.id = b.user_id
       WHERE u.id IN (${placeholders}) AND b.id IS NULL`
    ).all(...userIds);
    if (validUsers.length !== userIds.length) {
      return socket.emit('error-msg', 'One or more users not found');
    }
    const allMembers = [socket.user, ...validUsers];
    const code = generateChannelCode();
    try {
      const result = db.prepare(
        "INSERT INTO channels (name, code, created_by, is_dm) VALUES ('Group', ?, ?, 1)"
      ).run(code, socket.user.id);
      const channelId = result.lastInsertRowid;
      const insertMember = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      insertMember.run(channelId, socket.user.id);
      for (const uid of userIds) insertMember.run(channelId, uid);
      socket.join(`channel:${code}`);
      // Build dm_members list for the initiator
      const dmMembers = allMembers.map(u => ({ id: u.id, username: u.username }));
      socket.emit('dm-opened', {
        id: channelId, code, name: 'Group', is_dm: 1,
        dm_members: dmMembers, is_group_dm: 1
      });
      // Notify other online participants
      for (const [, s] of io.of('/').sockets) {
        if (s.user && userIds.includes(s.user.id)) {
          s.join(`channel:${code}`);
          const others = allMembers.filter(m => m.id !== s.user.id).map(u => ({ id: u.id, username: u.username }));
          s.emit('dm-opened', {
            id: channelId, code, name: 'Group', is_dm: 1,
            dm_members: others, is_group_dm: 1
          });
        }
      }
    } catch (err) {
      console.error('Start group DM error:', err);
      socket.emit('error-msg', 'Failed to create group conversation');
    }
  });

  // ── Add member to group DM ──────────────────────────────
  socket.on('add-dm-member', (data) => {
    if (!data || typeof data !== 'object') return;
    const channelId = isInt(data.channelId) ? data.channelId : null;
    const targetUserId = isInt(data.targetUserId) ? data.targetUserId : null;
    if (!channelId || !targetUserId) return;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 1').get(channelId);
    if (!channel) return socket.emit('error-msg', 'DM not found');
    const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id);
    if (!isMember && !socket.user.isAdmin) return socket.emit('error-msg', 'You are not a member of this conversation');
    const target = db.prepare(
      'SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE u.id = ? AND b.id IS NULL'
    ).get(targetUserId);
    if (!target) return socket.emit('error-msg', 'User not found');
    const alreadyMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, targetUserId);
    if (alreadyMember) return socket.emit('error-msg', 'User is already in this conversation');
    try {
      db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetUserId);
      const rows = db.prepare(
        "SELECT u.id, COALESCE(u.display_name, u.username) as username FROM channel_members cm JOIN users u ON cm.user_id = u.id WHERE cm.channel_id = ?"
      ).all(channelId);
      const dmMembers = rows.map(r => ({ id: r.id, username: r.username }));
      for (const [, s] of io.of('/').sockets) {
        if (s.user && s.user.id === targetUserId) {
          s.join(`channel:${channel.code}`);
          const others = rows.filter(r => r.id !== targetUserId).map(r => ({ id: r.id, username: r.username }));
          s.emit('dm-opened', {
            id: channelId, code: channel.code, name: channel.name, is_dm: 1,
            dm_members: others, is_group_dm: 1
          });
        } else if (s.user && rows.some(r => r.id === s.user.id) && s.user.id !== targetUserId) {
          s.emit('dm-members-updated', {
            channelId, channelCode: channel.code, dm_members: dmMembers
          });
        }
      }
      socket.emit('error-msg', `Added ${target.username} to the conversation`);
    } catch (err) {
      console.error('Add DM member error:', err);
      socket.emit('error-msg', 'Failed to add member');
    }
  });

  // ── Remove/leave member from group DM ───────────────────
  socket.on('remove-dm-member', (data) => {
    if (!data || typeof data !== 'object') return;
    const channelId = isInt(data.channelId) ? data.channelId : null;
    const targetUserId = isInt(data.targetUserId) ? data.targetUserId : null;
    if (!channelId || !targetUserId) return;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 1').get(channelId);
    if (!channel) return socket.emit('error-msg', 'DM not found');
    const isTargetSelf = targetUserId === socket.user.id;
    const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id);
    if (!isMember && !socket.user.isAdmin) return socket.emit('error-msg', 'Not authorized');
    const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);
    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channelId, targetUserId);
    for (const [, s] of io.of('/').sockets) {
      if (s.user && s.user.id === targetUserId) {
        s.leave(`channel:${channel.code}`);
        s.emit('dm-left', { channelId, channelCode: channel.code });
      }
    }
    // Check remaining members count
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM channel_members WHERE channel_id = ?').get(channelId);
    if (remaining.cnt === 0) {
      // Last member left — delete the DM channel
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
      db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    } else {
      const rows = db.prepare(
        "SELECT u.id, COALESCE(u.display_name, u.username) as username FROM channel_members cm JOIN users u ON cm.user_id = u.id WHERE cm.channel_id = ?"
      ).all(channelId);
      for (const [, s] of io.of('/').sockets) {
        if (s.user && rows.some(r => r.id === s.user.id)) {
          s.emit('dm-members-updated', {
            channelId, channelCode: channel.code,
            dm_members: rows.map(r => ({ id: r.id, username: r.username }))
          });
        }
      }
    }
    if (!isTargetSelf) {
      socket.emit('error-msg', `Removed ${targetUser ? targetUser.username : 'user'} from the conversation`);
    }
  });

  // ── Rename group DM ──────────────────────────────────────
  // Persists the channel name to DB, broadcasts channel lists to all members,
  // and emits channel-renamed to the DM room so the header updates live.
  // This is separate from rename-channel because the existing handler
  // explicitly blocks DMs (SELECT ... WHERE is_dm = 0).
  socket.on('rename-dm', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0 || name.length > 50) {
      return socket.emit('error-msg', 'Group name must be 1-50 characters');
    }
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 1').get(code);
    if (!channel) return socket.emit('error-msg', 'DM not found');
    const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!isMember && !socket.user.isAdmin) return socket.emit('error-msg', 'Not a member');
    try {
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, channel.id);
      // Re-broadcast channel lists so all members see the new name
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('channel-renamed', { code, name });
    } catch (err) {
      console.error('Rename DM error:', err);
      socket.emit('error-msg', 'Failed to rename group');
    }
  });

  // ── Direct Messages ─────────────────────────────────────
  socket.on('start-dm', (data) => {
    if (!data || typeof data !== 'object') return;
    // (#5381) Guests have no E2E key (no password → no PBKDF2-derived
    // wrap key), so DMs would be unencryptable. The DM tab is hidden in
    // the guest UI; this is the server-side enforcement.
    if (socket.user.isGuest) {
      return socket.emit('error-msg', 'Guests cannot send direct messages');
    }
    const targetId = isInt(data.targetUserId) ? data.targetUserId : null;
    if (!targetId) return;
    const isSelfDm = targetId === socket.user.id;
    const target = db.prepare(
      'SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE u.id = ? AND b.id IS NULL'
    ).get(targetId);
    if (!target) return socket.emit('error-msg', 'User not found');
    // For self-DM, the channel has only one channel_members row, so both EXISTS
    // clauses below collapse to the same check — which still matches correctly.
    const existingDm = db.prepare(`
      SELECT c.id, c.code, c.name FROM channels c
      WHERE c.is_dm = 1
      AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
      AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
      ${isSelfDm ? 'AND (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) = 1' : ''}
    `).get(socket.user.id, targetId);
    if (existingDm) {
      socket.emit('dm-opened', {
        id: existingDm.id, code: existingDm.code, name: existingDm.name,
        is_dm: 1, is_self_dm: isSelfDm ? 1 : 0,
        dm_target: { id: target.id, username: target.username }
      });
      return;
    }
    const code = generateChannelCode();
    try {
      const result = db.prepare('INSERT INTO channels (name, code, created_by, is_dm) VALUES (?, ?, ?, 1)').run('DM', code, socket.user.id);
      const channelId = result.lastInsertRowid;
      db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, socket.user.id);
      // Self-DMs only have one member; PRIMARY KEY prevents duplicate insert.
      if (!isSelfDm) {
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetId);
      }
      socket.join(`channel:${code}`);
      socket.emit('dm-opened', { id: channelId, code, name: 'DM', is_dm: 1, is_self_dm: isSelfDm ? 1 : 0, dm_target: { id: target.id, username: target.username } });
      if (!isSelfDm) {
        for (const [, s] of io.of('/').sockets) {
          if (s.user && s.user.id === targetId) {
            s.join(`channel:${code}`);
            s.emit('dm-opened', { id: channelId, code, name: 'DM', is_dm: 1, dm_target: { id: socket.user.id, username: socket.user.displayName } });
          }
        }
      }
    } catch (err) {
      console.error('Start DM error:', err);
      socket.emit('error-msg', 'Failed to create DM');
    }
  });

  socket.on('delete-dm', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 1').get(code);
    if (!channel) return socket.emit('error-msg', 'DM not found');
    const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!isMember && !socket.user.isAdmin) return socket.emit('error-msg', 'Not authorized');

    // Collect attachment filenames before we drop the message rows. We
    // scan plaintext message content server-side, and also accept a
    // `data.attachments` list from the client for E2E-encrypted DM
    // messages whose ciphertext we can't read here. (#5299)
    const filenames = new Set();
    try {
      const msgs = db.prepare('SELECT content FROM messages WHERE channel_id = ?').all(channel.id);
      const uploadRe = UPLOAD_PATH_RE;
      for (const row of msgs) {
        const text = row.content || '';
        uploadRe.lastIndex = 0;
        let m;
        while ((m = uploadRe.exec(text)) !== null) {
          if (isSafeUploadRelPath(m[1])) filenames.add(m[1]);
        }
      }
    } catch { /* ignore scan errors — best-effort cleanup */ }
    if (Array.isArray(data.attachments)) {
      for (const url of data.attachments) {
        if (typeof url !== 'string') continue;
        const match = url.match(UPLOAD_PATH_EXACT_RE);
        if (match && isSafeUploadRelPath(match[1])) filenames.add(match[1]);
      }
    }

    const deleteAll = db.transaction((chId) => {
      db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(chId);
      db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM channels WHERE id = ?').run(chId);
    });
    deleteAll(channel.id);

    for (const name of filenames) moveUploadToDeleted(name);

    io.to(`channel:${code}`).emit('channel-deleted', { code });
  });
};
