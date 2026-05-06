'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const webpush = require('web-push');

const { verifyToken, generateChannelCode, generateToken } = require('../auth');
const { sendFcm, isFcmEnabled } = require('../fcm');
const { DATA_DIR, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('../paths');
const HAVEN_VERSION = require('../../package.json').version;

const { sanitizeText, utcStamp, isString, isInt, isValidUploadPath, VALID_ROLE_PERMS } = require('./helpers');
const { resolveSpotifyToYouTube, searchYouTube, fetchYouTubePlaylist, extractYouTubeVideoId, resolveMusicMetadata } = require('./musicResolver');
const createPermissions = require('./permissions');

const registerChannels   = require('./channels');
const registerMessages   = require('./messages');
const registerVoice      = require('./voice');
const registerMusic      = require('./music');
const registerUsers      = require('./users');
const registerModeration = require('./moderation');
const registerRoles      = require('./roles');
const registerAdmin      = require('./admin');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

// ══════════════════════════════════════════════════════════════
// setupSocketHandlers — called once from server.js
// ══════════════════════════════════════════════════════════════
function setupSocketHandlers(io, db) {

  // ── Permission helpers (shared across all connections) ───
  const {
    getChannelRoleChain, getUserEffectiveLevel, getPermissionThresholds,
    userHasPermission, getUserPermissions, getUserRoles,
    getUserHighestRole, getUserAllRoles
  } = createPermissions(db);

  // ── Shared state Maps ───────────────────────────────────
  const channelUsers        = new Map(); // code → Map<userId, { id, username, socketId, avatar?, avatar_shape? }>
  const voiceUsers          = new Map(); // code → Map<userId, { id, username, socketId, isMuted, isDeafened }>
  const voiceLastActivity   = new Map(); // userId → timestamp
  const activeMusic         = new Map(); // code → { url, userId, username, playbackState, ... }
  const musicQueues         = new Map(); // code → [{ id, url, title, userId, username, resolvedFrom }]
  const activeScreenSharers = new Map(); // code → Set<userId>
  const activeWebcamUsers   = new Map(); // code → Set<userId>
  const streamViewers       = new Map(); // "code:sharerId" → Set<viewerUserId>
  const slowModeTracker     = new Map(); // "slow:{userId}:{channelId}" → timestamp
  const pendingTempDelete   = new Map(); // code → timeout handle (grace-period before deleting temp-voice channel)

  const state = {
    channelUsers, voiceUsers, voiceLastActivity,
    activeMusic, musicQueues,
    activeScreenSharers, activeWebcamUsers, streamViewers,
    slowModeTracker, pendingTempDelete
  };

  // Transfer-admin mutex (shared across all connections to prevent race conditions)
  const transferAdminRef = { value: false };

  // ── Music state helpers ─────────────────────────────────

  function clampMusicPosition(positionSeconds, durationSeconds = null) {
    const pos = Number(positionSeconds);
    if (!Number.isFinite(pos)) return 0;
    if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      return Math.max(0, Math.min(pos, durationSeconds));
    }
    return Math.max(0, pos);
  }

  function getActiveMusicSyncState(music) {
    if (!music) return null;
    const playback = music.playbackState || {};
    const baseUpdatedAt = Number(playback.updatedAt) || Date.now();
    const durationSeconds = Number.isFinite(playback.durationSeconds) ? playback.durationSeconds : null;
    let positionSeconds = clampMusicPosition(playback.positionSeconds || 0, durationSeconds);
    if (playback.isPlaying) {
      positionSeconds = clampMusicPosition(
        positionSeconds + Math.max(0, Date.now() - baseUpdatedAt) / 1000,
        durationSeconds
      );
    }
    return {
      isPlaying: !!playback.isPlaying,
      positionSeconds, durationSeconds,
      updatedAt: Date.now()
    };
  }

  function updateActiveMusicPlaybackState(code, next = {}) {
    const music = activeMusic.get(code);
    if (!music) return null;
    const current = getActiveMusicSyncState(music) || { isPlaying: false, positionSeconds: 0, durationSeconds: null };
    const durationSeconds = Number.isFinite(next.durationSeconds) ? Math.max(0, Number(next.durationSeconds)) : current.durationSeconds;
    const positionSeconds = Number.isFinite(next.positionSeconds) ? clampMusicPosition(next.positionSeconds, durationSeconds) : current.positionSeconds;
    music.playbackState = {
      isPlaying: typeof next.isPlaying === 'boolean' ? next.isPlaying : current.isPlaying,
      positionSeconds, durationSeconds,
      updatedAt: Date.now()
    };
    return getActiveMusicSyncState(music);
  }

  function trimMusicText(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  function stripYouTubePlaylistParam(url) {
    if (typeof url !== 'string' || !url) return '';
    if (!/(youtube\.com|youtu\.be)/i.test(url)) return url;
    try {
      const parsed = new URL(url);
      parsed.searchParams.delete('list');
      return parsed.toString();
    } catch {
      return url.replace(/([?&])list=[^&]+&?/i, '$1').replace(/[?&]$/g, '');
    }
  }

  function sanitizeQueueEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
      id: trimMusicText(entry.id, 64),
      url: trimMusicText(entry.url, 500),
      title: trimMusicText(entry.title, 200) || 'Untitled track',
      userId: Number(entry.userId) || 0,
      username: trimMusicText(entry.username, 80) || 'Unknown',
      resolvedFrom: trimMusicText(entry.resolvedFrom, 32) || null
    };
  }

  function getMusicQueuePayload(code) {
    const queue = (musicQueues.get(code) || []).map(sanitizeQueueEntry).filter(Boolean);
    return { channelCode: code, queue, upNext: queue[0] || null };
  }

  function broadcastMusicQueue(code) {
    io.to(`voice:${code}`).emit('music-queue-update', getMusicQueuePayload(code));
  }

  function setActiveMusic(code, entry) {
    if (!entry || typeof entry !== 'object') return null;
    const playbackState = entry.playbackState && typeof entry.playbackState === 'object'
      ? {
          isPlaying: !!entry.playbackState.isPlaying,
          positionSeconds: clampMusicPosition(entry.playbackState.positionSeconds || 0, Number(entry.playbackState.durationSeconds) || null),
          durationSeconds: Number.isFinite(entry.playbackState.durationSeconds) ? Math.max(0, Number(entry.playbackState.durationSeconds)) : null,
          updatedAt: Number(entry.playbackState.updatedAt) || Date.now()
        }
      : { isPlaying: true, positionSeconds: 0, durationSeconds: null, updatedAt: Date.now() };
    const music = { ...entry, playbackState };
    activeMusic.set(code, music);
    return music;
  }

  function emitMusicSharedToRoom(code, music) {
    const voiceRoom = voiceUsers.get(code);
    if (!voiceRoom || !music) return;
    for (const [, user] of voiceRoom) {
      io.to(user.socketId).emit('music-shared', {
        userId: music.userId, username: music.username,
        url: music.url, title: music.title, trackId: music.id,
        channelCode: code, resolvedFrom: music.resolvedFrom,
        syncState: getActiveMusicSyncState(music)
      });
    }
  }

  function startQueuedMusic(code, entry) {
    const music = setActiveMusic(code, entry);
    if (!music) return;
    emitMusicSharedToRoom(code, music);
    broadcastMusicQueue(code);
  }

  function popNextQueuedMusic(code) {
    const queue = musicQueues.get(code) || [];
    const next = queue.shift() || null;
    if (queue.length > 0) musicQueues.set(code, queue);
    else musicQueues.delete(code);
    return next;
  }

  function isNaturalMusicFinish(current, reportedPositionSeconds, reportedDurationSeconds) {
    const syncState = getActiveMusicSyncState(current);
    if (!syncState) return false;
    const durationSeconds = Number.isFinite(reportedDurationSeconds) && reportedDurationSeconds > 0
      ? Number(reportedDurationSeconds)
      : (Number.isFinite(syncState.durationSeconds) ? syncState.durationSeconds : null);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
    const positionSeconds = Number.isFinite(reportedPositionSeconds)
      ? clampMusicPosition(reportedPositionSeconds, durationSeconds)
      : clampMusicPosition(syncState.positionSeconds, durationSeconds);
    const remainingSeconds = Math.max(0, durationSeconds - positionSeconds);
    return remainingSeconds <= Math.min(2, durationSeconds * 0.02);
  }

  // ── Voice activity helper ───────────────────────────────
  function touchVoiceActivity(userId) {
    if (voiceLastActivity.has(userId)) {
      voiceLastActivity.set(userId, Date.now());
    }
  }

  // ── getEnrichedChannels ─────────────────────────────────
  function getEnrichedChannels(userId, isAdmin, joinRooms) {
    let channels;
    if (isAdmin) {
      channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only
        FROM channels c WHERE c.is_dm = 0
        UNION
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 1
        ORDER BY is_dm, position, name
      `).all(userId);
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      channels.forEach(ch => { if (!ch.is_dm) insertMember.run(ch.id, userId); });
    } else {
      channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        ORDER BY c.is_dm, c.position, c.name
      `).all(userId);
    }

    if (channels.length > 0) {
      const channelIds = channels.map(c => c.id);
      const placeholders = channelIds.map(() => '?').join(',');

      const readRows = db.prepare(
        `SELECT channel_id, last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id IN (${placeholders})`
      ).all(userId, ...channelIds);
      const readMap = {};
      readRows.forEach(r => { readMap[r.channel_id] = r.last_read_message_id; });

      const latestRows = db.prepare(
        `SELECT channel_id, MAX(id) as latest_id FROM messages WHERE channel_id IN (${placeholders}) AND thread_id IS NULL GROUP BY channel_id`
      ).all(...channelIds);
      const latestMap = {};
      latestRows.forEach(r => { latestMap[r.channel_id] = r.latest_id; });

      channels.forEach(ch => {
        const lastRead = readMap[ch.id] || 0;
        const latestId = latestMap[ch.id] || 0;
        ch.latestMessageId = latestId;
        if (latestId > lastRead) {
          const countRow = db.prepare(
            // Exclude thread replies (thread_id IS NOT NULL): they live in their
            // own thread panel, never appear in the channel scroll, and so can
            // never be marked-read by scrolling — counting them here pins a
            // phantom unread on the channel forever.
            'SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND id > ? AND user_id != ? AND thread_id IS NULL'
          ).get(ch.id, lastRead, userId);
          ch.unreadCount = countRow ? countRow.cnt : 0;
        } else {
          ch.unreadCount = 0;
        }

        if (ch.is_dm) {
          const otherUser = db.prepare(`
            SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u
            JOIN channel_members cm ON u.id = cm.user_id
            WHERE cm.channel_id = ? AND u.id != ?
          `).get(ch.id, userId);
          if (otherUser) {
            ch.dm_target = otherUser;
          } else {
            // Self-DM: only one channel_members row, no "other" user. Use self as the partner.
            const self = db.prepare(
              'SELECT id, COALESCE(display_name, username) as username FROM users WHERE id = ?'
            ).get(userId);
            ch.dm_target = self || null;
            ch.is_self_dm = 1;
          }
        }
      });
    }

    if (joinRooms) {
      channels.forEach(ch => joinRooms(`channel:${ch.code}`));
    }

    channels.forEach(ch => {
      if (isAdmin) {
        ch.display_code = ch.code;
      } else if (ch.code_visibility === 'private' || ch.is_private) {
        const isMod = ch.created_by === userId || userHasPermission(userId, 'kick_user', ch.id);
        ch.display_code = isMod ? ch.code : '••••••••';
      } else {
        ch.display_code = ch.code;
      }
    });

    return channels;
  }

  // ── broadcastChannelLists (debounced, shared timer) ─────
  let _broadcastPending = null;
  function broadcastChannelLists() {
    if (_broadcastPending) return;
    _broadcastPending = setTimeout(() => {
      _broadcastPending = null;
      for (const [, s] of io.sockets.sockets) {
        if (s.user) {
          s.emit('channels-list', getEnrichedChannels(s.user.id, s.user.isAdmin, null));
        }
      }
    }, 150);
  }

  // ── logAudit — record an admin/moderator action ─────────
  // entry: { actor, action, target_type?, target_id?, target_name?, details? }
  // actor can be a user object ({ id, username }) or null for system actions.
  // details is anything JSON-serializable; stored as a JSON string.
  // Failures never throw — auditing must not break the calling action.
  const _auditInsert = db.prepare(
    'INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, target_name, details) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  function logAudit(entry) {
    try {
      if (!entry || typeof entry !== 'object') return;
      const actor = entry.actor || null;
      const actorId = actor && typeof actor.id === 'number' ? actor.id : null;
      const actorUsername = actor ? (actor.displayName || actor.username || null) : null;
      const action = typeof entry.action === 'string' ? entry.action.slice(0, 60) : null;
      if (!action) return;
      const targetType = entry.target_type ? String(entry.target_type).slice(0, 32) : null;
      const targetId = Number.isInteger(entry.target_id) ? entry.target_id : null;
      const targetName = entry.target_name ? String(entry.target_name).slice(0, 200) : null;
      let details = null;
      if (entry.details !== undefined && entry.details !== null) {
        try { details = JSON.stringify(entry.details).slice(0, 4000); } catch { details = null; }
      }
      _auditInsert.run(actorId, actorUsername, action, targetType, targetId, targetName, details);
    } catch (err) {
      console.warn('[audit] log failed:', err.message);
    }
  }

  // ── pruneStaleVoiceUsers ────────────────────────────────
  function pruneStaleVoiceUsers(code) {
    const room = voiceUsers.get(code);
    if (!room) return;
    for (const [userId, entry] of room) {
      const sock = io.sockets.sockets.get(entry.socketId);
      if (!sock || !sock.connected) {
        room.delete(userId);
        console.log(`[Voice] Pruned stale voice entry for user ${userId} (socket ${entry.socketId} gone)`);
      }
    }
    if (room.size === 0) {
      voiceUsers.delete(code);
      activeMusic.delete(code);
      musicQueues.delete(code);
      try {
        const ch = db.prepare('SELECT id, is_temp_voice FROM channels WHERE code = ?').get(code);
        if (ch && ch.is_temp_voice) {
          db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
          db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
          io.emit('channel-deleted', { code, reason: 'temp-empty' });
          channelUsers.delete(code);
          console.log(`[Temporary] Temp voice channel "${code}" deleted (pruned empty)`);
        }
      } catch { /* column may not exist yet */ }
    }
  }

  // ── broadcastVoiceUsers ─────────────────────────────────
  function broadcastVoiceUsers(code) {
    pruneStaleVoiceUsers(code);
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    const channelId = channel ? channel.id : null;
    const room = voiceUsers.get(code);
    const users = room
      ? Array.from(room.values()).map(u => {
          const role = getUserHighestRole(u.id, channelId);
          return { id: u.id, username: u.username, roleColor: role ? role.color : null, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false };
        })
      : [];
    io.to(`voice:${code}`).to(`channel:${code}`).emit('voice-users-update', { channelCode: code, users });
    io.emit('voice-count-update', {
      code, count: users.length,
      users: users.map(u => ({ id: u.id, username: u.username, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false }))
    });
  }

  // ── emitOnlineUsers ─────────────────────────────────────
  function emitOnlineUsers(code) {
    const room = channelUsers.get(code);

    const visibility = db.prepare("SELECT value FROM server_settings WHERE key = 'member_visibility'").get();
    const mode = visibility ? visibility.value : 'online';

    const scores = {};
    try {
      const scoreRows = db.prepare(`
        SELECT hs.user_id, hs.score FROM high_scores hs
        WHERE hs.game = ? AND hs.score > 0
          AND NOT EXISTS (
            SELECT 1 FROM user_preferences up
            WHERE up.user_id = hs.user_id AND up.key = 'hide_score_badge' AND up.value = 'true'
          )
      `).all('flappy');
      scoreRows.forEach(r => { scores[r.user_id] = r.score; });
    } catch { /* table may not exist yet */ }

    const statusMap = {};
    try {
      const statusRows = db.prepare('SELECT id, status, status_text, avatar, avatar_shape FROM users').all();
      statusRows.forEach(r => { statusMap[r.id] = { status: r.status || 'online', statusText: r.status_text || '', avatar: r.avatar || null, avatarShape: r.avatar_shape || 'circle' }; });
    } catch { /* columns may not exist yet */ }

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    const memberIds = new Set();
    if (channel) {
      const rows = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id);
      rows.forEach(r => memberIds.add(r.user_id));
    }

    let users;
    if (mode === 'none') {
      users = [];
    } else if (mode === 'all') {
      const allMembers = db.prepare(`
        SELECT u.id, COALESCE(u.display_name, u.username) as username
        FROM users u
        JOIN channel_members cm ON u.id = cm.user_id
        JOIN channels c ON cm.channel_id = c.id
        LEFT JOIN bans b ON u.id = b.user_id
        WHERE c.code = ? AND b.id IS NULL
        ORDER BY COALESCE(u.display_name, u.username)
      `).all(code);
      const globalOnlineIds = new Set();
      for (const [, s] of io.of('/').sockets) {
        if (s.user) globalOnlineIds.add(s.user.id);
      }
      users = allMembers.map(m => ({
        id: m.id, username: m.username, online: globalOnlineIds.has(m.id),
        highScore: scores[m.id] || 0,
        status: statusMap[m.id]?.status || 'online',
        statusText: statusMap[m.id]?.statusText || '',
        avatar: statusMap[m.id]?.avatar || null,
        avatarShape: statusMap[m.id]?.avatarShape || 'circle',
        role: getUserHighestRole(m.id, channel ? channel.id : null),
        roles: getUserAllRoles(m.id, channel ? channel.id : null)
      }));
    } else {
      const onlineMap = new Map();
      for (const [, s] of io.of('/').sockets) {
        if (s.user && !onlineMap.has(s.user.id) && memberIds.has(s.user.id)) {
          onlineMap.set(s.user.id, {
            id: s.user.id, username: s.user.displayName, online: true,
            highScore: scores[s.user.id] || 0,
            status: statusMap[s.user.id]?.status || 'online',
            statusText: statusMap[s.user.id]?.statusText || '',
            avatar: statusMap[s.user.id]?.avatar || s.user.avatar || null,
            avatarShape: statusMap[s.user.id]?.avatarShape || s.user.avatar_shape || 'circle',
            role: getUserHighestRole(s.user.id, channel ? channel.id : null),
            roles: getUserAllRoles(s.user.id, channel ? channel.id : null)
          });
        }
      }
      users = Array.from(onlineMap.values());
    }

    users.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
    });

    const hasInvisible = users.some(u => u.status === 'invisible');

    if (!hasInvisible) {
      io.to(`channel:${code}`).emit('online-users', { channelCode: code, users, visibilityMode: mode });
    } else {
      for (const [, s] of io.of('/').sockets) {
        if (!s.user || !s.rooms || !s.rooms.has(`channel:${code}`)) continue;
        const viewerId = s.user.id;
        const customUsers = users.map(u => {
          if (u.status === 'invisible' && u.id !== viewerId) {
            if (mode === 'online') return null;
            return { ...u, online: false, status: 'offline' };
          }
          return u;
        }).filter(Boolean);
        customUsers.sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
        });
        s.emit('online-users', { channelCode: code, users: customUsers, visibilityMode: mode });
      }
    }
  }

  // ── broadcastStreamInfo ─────────────────────────────────
  function broadcastStreamInfo(code) {
    const sharers = activeScreenSharers.get(code) || new Set();
    const cams = activeWebcamUsers.get(code) || new Set();
    const streams = [];
    const voiceRoom = voiceUsers.get(code);
    for (const sharerId of sharers) {
      const viewerKey = `${code}:${sharerId}`;
      const viewerSet = streamViewers.get(viewerKey) || new Set();
      const sharerInfo = voiceRoom ? voiceRoom.get(sharerId) : null;
      streams.push({
        userId: sharerId, username: sharerInfo ? sharerInfo.username : 'Unknown',
        type: 'screen', viewers: Array.from(viewerSet)
      });
    }
    for (const camUserId of cams) {
      const camInfo = voiceRoom ? voiceRoom.get(camUserId) : null;
      streams.push({
        userId: camUserId, username: camInfo ? camInfo.username : 'Unknown',
        type: 'webcam', viewers: []
      });
    }
    io.to(`voice:${code}`).to(`channel:${code}`).emit('stream-info', { channelCode: code, streams });
  }

  // ── handleVoiceLeave ────────────────────────────────────
  function handleVoiceLeave(socket, code, { softDisconnect = false } = {}) {
    const voiceRoom = voiceUsers.get(code);
    if (!voiceRoom) return;

    const entry = voiceRoom.get(socket.user.id);
    if (!entry) return;

    // If the stored entry belongs to a different socket (e.g. the user joined
    // from a second client which kicked this one), don't touch the map — just
    // remove this stale socket from the room and return.
    if (entry.socketId !== socket.id) {
      socket.leave(`voice:${code}`);
      return;
    }

    voiceRoom.delete(socket.user.id);
    socket.leave(`voice:${code}`);

    const sharers = activeScreenSharers.get(code);
    if (sharers) { sharers.delete(socket.user.id); if (sharers.size === 0) activeScreenSharers.delete(code); }

    const camUsers = activeWebcamUsers.get(code);
    if (camUsers) { camUsers.delete(socket.user.id); if (camUsers.size === 0) activeWebcamUsers.delete(code); }

    const viewerKey = `${code}:${socket.user.id}`;
    streamViewers.delete(viewerKey);
    for (const [key, viewers] of streamViewers) {
      if (key.startsWith(code + ':')) {
        viewers.delete(socket.user.id);
        if (viewers.size === 0) streamViewers.delete(key);
      }
    }

    for (const [, user] of voiceRoom) {
      io.to(user.socketId).emit('voice-user-left', {
        channelCode: code,
        user: { id: socket.user.id, username: socket.user.displayName }
      });
    }

    broadcastVoiceUsers(code);
    broadcastStreamInfo(code);
    if (voiceRoom.size === 0) {
      activeMusic.delete(code);
      musicQueues.delete(code);

      const doDeleteTempChannel = () => {
        try {
          const ch = db.prepare('SELECT id, is_temp_voice FROM channels WHERE code = ?').get(code);
          if (ch && ch.is_temp_voice) {
            // Double-check the room is still empty — someone may have rejoined
            // during the grace period.
            const currentRoom = voiceUsers.get(code);
            if (currentRoom && currentRoom.size > 0) return;
            db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
            db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
            db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
            db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
            db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
            io.emit('channel-deleted', { code, reason: 'temp-empty' });
            channelUsers.delete(code);
            voiceUsers.delete(code);
            pendingTempDelete.delete(code);
            console.log(`[Temporary] Temp voice channel "${code}" deleted (everyone left)`);
          }
        } catch { /* column may not exist yet */ }
      };

      if (softDisconnect) {
        // Grace period: wait 8 s before deleting the temp channel.
        // This prevents the channel from vanishing when a socket briefly
        // drops and immediately reconnects (e.g. network hiccup, or the
        // Desktop app's memory-based page reload).
        if (pendingTempDelete.has(code)) clearTimeout(pendingTempDelete.get(code));
        const timer = setTimeout(doDeleteTempChannel, 8000);
        pendingTempDelete.set(code, timer);
        console.log(`[Temporary] Temp voice channel "${code}" grace period started (socket disconnect)`);
      } else {
        // Intentional leave — cancel any pending grace-period timer and delete immediately.
        if (pendingTempDelete.has(code)) {
          clearTimeout(pendingTempDelete.get(code));
          pendingTempDelete.delete(code);
        }
        doDeleteTempChannel();
      }
    }

    let stillInVoice = false;
    for (const [, room] of voiceUsers) {
      if (room.has(socket.user.id)) { stillInVoice = true; break; }
    }
    if (!stillInVoice) voiceLastActivity.delete(socket.user.id);
  }

  // ── Push notification helper ────────────────────────────
  function sendPushNotifications(channelId, channelCode, channelName, senderUserId, senderUsername, messageContent) {
    try {
      const activeUserIds = new Set();
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.hasFocus !== false) activeUserIds.add(s.user.id);
      }

      const subs = db.prepare(`
        SELECT ps.endpoint, ps.p256dh, ps.auth, ps.user_id
        FROM push_subscriptions ps
        JOIN channel_members cm ON cm.user_id = ps.user_id
        WHERE cm.channel_id = ? AND ps.user_id != ?
      `).all(channelId, senderUserId);

      // Detect E2E encrypted envelope — don't leak ciphertext in notifications
      let displayContent = messageContent;
      try {
        const parsed = JSON.parse(messageContent);
        if (parsed && parsed.v && parsed.ct) displayContent = 'Sent a message';
      } catch { /* not JSON, use as-is */ }

      const body = displayContent.length > 120 ? displayContent.slice(0, 117) + '...' : displayContent;
      const title = `${senderUsername} in #${channelName}`;
      const payload = JSON.stringify({
        title, body, channelCode,
        tag: `haven-${channelCode}`, url: '/app'
      });

      for (const sub of subs) {
        if (activeUserIds.has(sub.user_id)) continue;
        const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        webpush.sendNotification(pushSub, payload).catch((err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint); } catch { /* non-critical */ }
          }
        });
      }

      if (isFcmEnabled()) {
        const inactiveMembers = db.prepare(`
          SELECT DISTINCT cm.user_id FROM channel_members cm
          WHERE cm.channel_id = ? AND cm.user_id != ?
        `).all(channelId, senderUserId)
          .filter(m => !activeUserIds.has(m.user_id))
          .map(m => m.user_id);

        if (inactiveMembers.length) {
          const placeholders = inactiveMembers.map(() => '?').join(',');
          const fcmRows = db.prepare(`SELECT token FROM fcm_tokens WHERE user_id IN (${placeholders})`).all(...inactiveMembers);
          const tokens = fcmRows.map(r => r.token);

          if (tokens.length) {
            sendFcm(tokens, title, body, { channelCode, tag: `haven-${channelCode}` })
              .then(res => {
                if (res.failedTokens && res.failedTokens.length) {
                  const ph = res.failedTokens.map(() => '?').join(',');
                  try { db.prepare(`DELETE FROM fcm_tokens WHERE token IN (${ph})`).run(...res.failedTokens); } catch {}
                }
              })
              .catch(err => console.error('FCM push error:', err.message));
          }
        }
      }
    } catch (err) {
      console.error('Push notification error:', err.message);
    }
  }

  // ── Webhook callback helper ─────────────────────────────
  // SSRF guard: reject private/internal IPs in callback URLs
  function isSafeCallbackUrl(urlString) {
    try {
      const u = new URL(urlString);
      const h = u.hostname.toLowerCase();
      if (['localhost','127.0.0.1','[::1]','0.0.0.0','::'].includes(h)) return false;
      if (h.startsWith('10.') || h.startsWith('192.168.')) return false;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
      if (h === '169.254.169.254') return false;
      if (h.endsWith('.local') || h.endsWith('.internal')) return false;
      return /^https?:$/i.test(u.protocol);
    } catch { return false; }
  }

  // ── Webhook event delivery (3.13.0 expansion) ───────────
  // Generalized event dispatch — filters by per-webhook subscribed_events,
  // signs with HMAC when callback_secret is set, performs one delayed retry
  // on transient failures, and records last delivery health for the admin UI.
  // `subscribed_events`: '*' means all events; otherwise CSV (e.g. 'message,reaction-added').
  function _webhookSubscribed(bot, eventType) {
    const sub = (bot.subscribed_events || '*').trim();
    if (sub === '*' || sub === '') return true;
    const events = sub.split(',').map(s => s.trim()).filter(Boolean);
    return events.includes(eventType);
  }

  function _recordWebhookDelivery(botId, status, errorMsg) {
    try {
      const isOk = status >= 200 && status < 300;
      db.prepare(
        `UPDATE webhooks
         SET last_delivery_status = ?,
             last_delivery_at = CURRENT_TIMESTAMP,
             last_delivery_error = ?,
             failure_count = CASE WHEN ? THEN 0 ELSE COALESCE(failure_count, 0) + 1 END
         WHERE id = ?`
      ).run(status || 0, isOk ? null : (errorMsg || null), isOk ? 1 : 0, botId);
    } catch { /* best-effort */ }
  }

  // POSTs the event to the bot's callback. Single retry after 5s on 5xx /
  // network error. 4xx responses are NOT retried (treated as bot rejection).
  async function _deliverWebhook(bot, payload, headers, attempt = 0) {
    try {
      const resp = await fetch(bot.callback_url, {
        method: 'POST', headers, body: payload,
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) {
        _recordWebhookDelivery(bot.id, resp.status, null);
        return;
      }
      if (resp.status >= 500 && attempt < 1) {
        setTimeout(() => _deliverWebhook(bot, payload, headers, attempt + 1).catch(() => {}), 5000);
        return;
      }
      _recordWebhookDelivery(bot.id, resp.status, `HTTP ${resp.status}`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (attempt < 1) {
        setTimeout(() => _deliverWebhook(bot, payload, headers, attempt + 1).catch(() => {}), 5000);
        return;
      }
      _recordWebhookDelivery(bot.id, 0, msg.slice(0, 200));
      console.error(`Webhook callback failed for bot ${bot.id} → ${bot.callback_url}: ${msg}`);
    }
  }

  function fireWebhookEvent(channelId, channelCode, eventType, body) {
    try {
      const bots = db.prepare(
        'SELECT id, callback_url, callback_secret, subscribed_events FROM webhooks WHERE channel_id = ? AND is_active = 1 AND callback_url IS NOT NULL'
      ).all(channelId);
      if (!bots.length) return;

      const payload = JSON.stringify({
        event: eventType,
        channelId: channelCode,
        timestamp: new Date().toISOString(),
        ...body
      });

      for (const bot of bots) {
        if (!_webhookSubscribed(bot, eventType)) continue;
        if (!isSafeCallbackUrl(bot.callback_url)) continue;

        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': 'Haven-Webhook/1.1',
          'X-Haven-Event': eventType
        };
        if (bot.callback_secret) {
          headers['X-Haven-Signature'] =
            'sha256=' + crypto.createHmac('sha256', bot.callback_secret).update(payload).digest('hex');
        }

        _deliverWebhook(bot, payload, headers).catch(() => {});
      }
    } catch (err) {
      console.error('Webhook event dispatch error:', err.message);
    }
  }

  function fireWebhookCallbacks(channelId, channelCode, message) {
    if (message && message.is_webhook) return;
    fireWebhookEvent(channelId, channelCode, 'message', {
      message: {
        id: message.id, content: message.content,
        author: { id: message.user_id, username: message.username },
        reply_to: message.reply_to || null,
        is_webhook: !!message.is_webhook,
        timestamp: message.created_at
      }
    });
  }


  // ══════════════════════════════════════════════════════════
  // INTERVALS
  // ══════════════════════════════════════════════════════════

  // Slow mode cleanup (every 5 min)
  setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of slowModeTracker) { if (v < cutoff) slowModeTracker.delete(k); }
  }, 5 * 60 * 1000);

  // AFK voice auto-move (every 30s)
  setInterval(() => {
    try {
      const afkChannels = db.prepare(
        "SELECT code, afk_sub_code, afk_timeout_minutes FROM channels WHERE afk_sub_code IS NOT NULL AND afk_sub_code != '' AND afk_timeout_minutes > 0"
      ).all();
      if (!afkChannels.length) return;

      const afkMap = new Map();
      for (const ch of afkChannels) {
        afkMap.set(ch.code, { afkSubCode: ch.afk_sub_code, timeout: ch.afk_timeout_minutes });
        const subs = db.prepare("SELECT code FROM channels WHERE parent_channel_id = (SELECT id FROM channels WHERE code = ?)").all(ch.code);
        for (const sub of subs) {
          if (sub.code !== ch.afk_sub_code) {
            afkMap.set(sub.code, { afkSubCode: ch.afk_sub_code, timeout: ch.afk_timeout_minutes });
          }
        }
      }

      for (const [code, room] of voiceUsers) {
        const afkConfig = afkMap.get(code);
        if (!afkConfig) continue;
        const cutoff = Date.now() - (afkConfig.timeout * 60 * 1000);
        for (const [userId, user] of room) {
          const lastActive = voiceLastActivity.get(userId);
          if (lastActive && lastActive < cutoff) {
            const userSocket = io.sockets.sockets.get(user.socketId);
            if (!userSocket) continue;
            userSocket.emit('voice-afk-move', { channelCode: afkConfig.afkSubCode });
            handleVoiceLeave(userSocket, code);
            voiceLastActivity.set(userId, Date.now());
          }
        }
      }
    } catch { /* columns may not exist yet */ }
  }, 30 * 1000);

  // Temporary channel cleanup (every 60s)
  setInterval(() => {
    try {
      const expired = db.prepare(
        "SELECT id, code FROM channels WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')"
      ).all();
      for (const ch of expired) {
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
        db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
        io.to(`channel:${ch.code}`).to(`voice:${ch.code}`).emit('channel-deleted', { code: ch.code, reason: 'expired' });
        channelUsers.delete(ch.code);
        voiceUsers.delete(ch.code);
        activeMusic.delete(ch.code);
        musicQueues.delete(ch.code);
        console.log(`[Temporary] Channel "${ch.code}" expired and was deleted`);
      }
    } catch (err) {
      console.error('Temporary channel cleanup error:', err);
    }

    // Safety net: prune empty temp-voice channels that the on-leave path
    // somehow missed (e.g. abrupt disconnects, reconnects re-binding the
    // voice entry to a new socket before the old one disconnected, etc.).
    // Without this, an empty temp channel would linger until the 24-hour
    // expires_at fires.
    try {
      const tempVoice = db.prepare(
        "SELECT id, code FROM channels WHERE is_temp_voice = 1"
      ).all();
      for (const ch of tempVoice) {
        const room = voiceUsers.get(ch.code);
        // Only prune when nobody is in the voice room (or the room is gone).
        if (room && room.size > 0) {
          // Drop stale socket entries first; if all turn out to be dead,
          // pruneStaleVoiceUsers itself deletes the channel. Otherwise skip.
          for (const [userId, entry] of room) {
            const sock = io.sockets.sockets.get(entry.socketId);
            if (!sock || !sock.connected) room.delete(userId);
          }
          if (room.size > 0) continue;
        }
        // Also require the channel to be at least 30s old so we don't race
        // with the creator who hasn't joined voice yet.
        const age = db.prepare(
          "SELECT (julianday('now') - julianday(created_at)) * 86400 AS secs FROM channels WHERE id = ?"
        ).get(ch.id);
        if (age && age.secs != null && age.secs < 30) continue;
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
        db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
        io.emit('channel-deleted', { code: ch.code, reason: 'temp-empty' });
        channelUsers.delete(ch.code);
        voiceUsers.delete(ch.code);
        activeMusic.delete(ch.code);
        musicQueues.delete(ch.code);
        console.log(`[Temporary] Empty temp voice channel "${ch.code}" pruned by safety-net sweep`);
      }
    } catch { /* column may not exist yet */ }
  }, 60 * 1000);

  // Channel code rotation (every 30s)
  setInterval(() => {
    try {
      const dynamicChannels = db.prepare(
        "SELECT * FROM channels WHERE code_mode = 'dynamic' AND code_rotation_type = 'time' AND is_dm = 0"
      ).all();
      const now = Date.now();
      for (const ch of dynamicChannels) {
        const lastRotated = new Date(ch.code_last_rotated + 'Z').getTime();
        const intervalMs = (ch.code_rotation_interval || 60) * 60 * 1000;
        if (now - lastRotated >= intervalMs) {
          const oldCode = ch.code;
          const newCode = generateChannelCode();
          db.prepare('UPDATE channels SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP WHERE id = ?').run(newCode, ch.id);
          const oldRoom = `channel:${oldCode}`;
          const newRoom = `channel:${newCode}`;
          const roomSockets = io.sockets.adapter.rooms.get(oldRoom);
          if (roomSockets) {
            for (const sid of [...roomSockets]) {
              const s = io.sockets.sockets.get(sid);
              if (s) { s.leave(oldRoom); s.join(newRoom); }
            }
          }
          if (channelUsers.has(oldCode)) { channelUsers.set(newCode, channelUsers.get(oldCode)); channelUsers.delete(oldCode); }
          if (voiceUsers.has(oldCode)) { voiceUsers.set(newCode, voiceUsers.get(oldCode)); voiceUsers.delete(oldCode); }
          io.to(newRoom).emit('channel-code-rotated', { channelId: ch.id, oldCode, newCode });
          console.log(`🔄 Auto-rotated code for channel "${ch.name}": ${oldCode} → ${newCode}`);
        }
      }
    } catch (err) {
      console.error('Channel code rotation error:', err);
    }
  }, 30 * 1000);

  // ══════════════════════════════════════════════════════════
  // SOCKET.IO MIDDLEWARE
  // ══════════════════════════════════════════════════════════

  // Connection rate limiting (per IP)
  const connTracker = new Map();
  const MAX_CONN_PER_MIN = 15;

  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const now = Date.now();
    if (!connTracker.has(ip)) {
      connTracker.set(ip, { count: 0, resetTime: now + 60000 });
    }
    const entry = connTracker.get(ip);
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + 60000; }
    entry.count++;
    if (entry.count > MAX_CONN_PER_MIN) {
      return next(new Error('Rate limited — too many connections'));
    }
    next();
  });

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token || typeof token !== 'string') return next(new Error('Authentication required'));

    const user = verifyToken(token);
    if (!user) return next(new Error('Invalid token'));

    const ban = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (ban) return next(new Error('You have been banned from this server'));

    socket.user = user;

    try {
      const uRow = db.prepare('SELECT display_name, is_admin, username, avatar, avatar_shape, password_version FROM users WHERE id = ?').get(user.id);
      if (!uRow || uRow.username !== user.username) {
        return next(new Error('Session expired'));
      }
      const dbPwv = uRow.password_version || 1;
      const tokenPwv = user.pwv || 1;
      if (tokenPwv < dbPwv) {
        return next(new Error('Session expired'));
      }
      socket.user.displayName = uRow.display_name || user.username;
      socket.user.avatar = uRow.avatar || null;
      socket.user.avatar_shape = uRow.avatar_shape || 'circle';

      const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (!anyAdmin && uRow.username.toLowerCase() === ADMIN_USERNAME && !uRow.is_admin) {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
        uRow.is_admin = 1;
      }
      socket.user.isAdmin = !!uRow.is_admin;
    } catch {
      socket.user.displayName = user.displayName || user.username;
    }

    try {
      const statusRow = db.prepare('SELECT status, status_text FROM users WHERE id = ?').get(user.id);
      if (statusRow) {
        const dbStatus = statusRow.status || 'online';
        if (dbStatus === 'away') {
          socket.user.status = 'online';
          socket.user.statusText = statusRow.status_text || '';
          db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', user.id);
        } else {
          socket.user.status = dbStatus;
          socket.user.statusText = statusRow.status_text || '';
        }
      }
    } catch { /* columns may not exist on old db */ }

    try {
      socket.user.roles = getUserRoles(user.id);
      socket.user.effectiveLevel = getUserEffectiveLevel(user.id);
    } catch { socket.user.roles = []; socket.user.effectiveLevel = socket.user.isAdmin ? 100 : 0; }

    next();
  });

  // Clean up connection tracker (every 5 min)
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of connTracker) {
      if (now > entry.resetTime + 120000) connTracker.delete(ip);
    }
  }, 5 * 60 * 1000);

  // ══════════════════════════════════════════════════════════
  // CONNECTION HANDLER
  // ══════════════════════════════════════════════════════════

  io.on('connection', (socket) => {
    if (!socket.user || !socket.user.username) {
      console.warn('⚠️  Connection without valid user — disconnecting');
      socket.disconnect(true);
      return;
    }

    console.log(`✅ ${socket.user.username} connected`);
    socket.currentChannel = null;
    socket.hasFocus = true;
    socket.on('visibility-change', (data) => {
      if (data && typeof data.visible === 'boolean') socket.hasFocus = data.visible;
    });

    // Push authoritative session info
    socket.emit('session-info', {
      id: socket.user.id, username: socket.user.username,
      isAdmin: socket.user.isAdmin,
      displayName: socket.user.displayName,
      avatar: socket.user.avatar || null,
      avatarShape: socket.user.avatar_shape || 'circle',
      version: HAVEN_VERSION,
      roles: socket.user.roles || [],
      effectiveLevel: socket.user.effectiveLevel || 0,
      permissions: getUserPermissions(socket.user.id),
      status: socket.user.status || 'online',
      statusText: socket.user.statusText || ''
    });

    // Send current voice counts for sidebar indicators
    for (const [code, room] of voiceUsers) {
      if (room.size > 0) {
        const users = Array.from(room.values()).map(u => ({
          id: u.id, username: u.username, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false
        }));
        socket.emit('voice-count-update', { code, count: room.size, users });
      }
    }

    // ── Per-socket flood protection ───────────────────────
    const floodBuckets = { message: [], event: [] };
    const FLOOD_LIMITS = {
      message: { max: 10, windowMs: 10000 },
      event:   { max: 60, windowMs: 10000 },
    };

    function floodCheck(bucket) {
      const limit = FLOOD_LIMITS[bucket];
      const now = Date.now();
      const timestamps = floodBuckets[bucket].filter(t => now - t < limit.windowMs);
      floodBuckets[bucket] = timestamps;
      if (timestamps.length >= limit.max) return true;
      timestamps.push(now);
      return false;
    }

    const FLOOD_EXEMPT = new Set([
      'voice-offer', 'voice-answer', 'voice-ice-candidate',
      'screen-share-started', 'screen-share-stopped',
      'voice-speaking', 'webcam-started', 'webcam-stopped',
      'stream-viewer-joined', 'stream-viewer-left',
      'visibility-change'
    ]);

    socket.use((packet, next) => {
      const eventName = packet[0];
      if (FLOOD_EXEMPT.has(eventName)) return next();
      if (floodCheck('event')) {
        socket.emit('error-msg', 'Slow down — too many requests');
        return;
      }
      next();
    });

    // ── Slash command processor (per-socket) ──────────────
    function processSlashCommand(cmd, arg, username, channelId, channelCode) {
      const commands = {
        shrug:     () => ({ content: `${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯` }),
        tableflip: () => ({ content: `${arg ? arg + ' ' : ''}(╯°□°)╯︵ ┻━┻` }),
        unflip:    () => ({ content: `${arg ? arg + ' ' : ''}┬─┬ ノ( ゜-゜ノ)` }),
        lenny:     () => ({ content: `${arg ? arg + ' ' : ''}( ͡° ͜ʖ ͡°)` }),
        disapprove:() => ({ content: `${arg ? arg + ' ' : ''}ಠ_ಠ` }),
        bbs:       () => ({ content: `🕐 ${username} will be back soon` }),
        boobs:     () => ({ content: `( . Y . )` }),
        butt:      () => ({ content: `( . )( . )` }),
        brb:       () => ({ content: `⏳ ${username} will be right back` }),
        afk:       () => ({ content: `💤 ${username} is away from keyboard` }),
        me:        () => arg ? ({ content: `_${username} ${arg}_` }) : null,
        spoiler:   () => arg ? ({ content: `||${arg}||` }) : null,
        tts:       () => {
          if (!arg) return null;
          if (!userHasPermission(socket.user.id, 'use_tts')) return { content: '_You do not have permission to use TTS._' };
          const ttsContent = arg.length > 500 ? arg.slice(0, 500) + '…' : arg;
          return { content: ttsContent, tts: true };
        },
        flip:      () => ({ content: `🪙 ${username} flipped a coin: **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**!` }),
        roll:      () => {
          const m = (arg || '1d6').match(/^(\d{1,2})?d(\d{1,4})$/i);
          if (!m) return { content: `🎲 ${username} rolled: **${Math.floor(Math.random() * 6) + 1}**` };
          const count = Math.min(parseInt(m[1] || '1'), 20);
          const sides = Math.min(parseInt(m[2]), 1000);
          const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
          const total = rolls.reduce((a, b) => a + b, 0);
          return { content: `🎲 ${username} rolled ${count}d${sides}: [${rolls.join(', ')}] = **${total}**` };
        },
        hug:       () => arg ? ({ content: `🤗 ${username} hugs ${arg}` }) : null,
        wave:      () => ({ content: `👋 ${username} waves${arg ? ' ' + arg : ''}` }),
      };
      const handler = commands[cmd];
      if (handler) return handler();

      // Check for bot-registered slash commands
      try {
        const botCmd = db.prepare(`
          SELECT bc.command, bc.description, w.id as webhook_id, w.callback_url, w.callback_secret, w.token, w.name as bot_name
          FROM bot_commands bc
          JOIN webhooks w ON bc.webhook_id = w.id
          WHERE bc.command = ? AND w.is_active = 1 AND w.callback_url IS NOT NULL
        `).get(cmd);
        if (botCmd) {
          if (!isSafeCallbackUrl(botCmd.callback_url)) {
            console.error(`Bot command /${cmd}: callback URL blocked by SSRF guard`);
            return null;
          }
          // Fire command callback to the bot
          const payload = JSON.stringify({
            event: 'slash_command',
            command: cmd,
            args: arg || '',
            channelCode: channelCode || null,
            author: { id: socket.user.id, username: socket.user.displayName }
          });
          const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Haven-Webhook/1.0' };
          if (botCmd.callback_secret) {
            headers['X-Haven-Signature'] = require('crypto').createHmac('sha256', botCmd.callback_secret).update(payload).digest('hex');
          }
          fetch(botCmd.callback_url, {
            method: 'POST', headers, body: payload,
            signal: AbortSignal.timeout(10000)
          }).catch(err => {
            console.error(`Bot command callback failed for /${cmd} → ${botCmd.callback_url}: ${err.message}`);
          });
          return { botCommand: true };
        }
      } catch (err) {
        console.error('Bot command lookup error:', err.message);
      }

      return null;
    }

    // ── Build context for domain modules ──────────────────
    const ctx = {
      io, db, state,
      // Permissions
      getChannelRoleChain, getUserEffectiveLevel, getPermissionThresholds,
      userHasPermission, getUserPermissions, getUserRoles,
      getUserHighestRole, getUserAllRoles,
      // Broadcast helpers
      broadcastChannelLists, broadcastVoiceUsers, emitOnlineUsers,
      getEnrichedChannels, handleVoiceLeave, pruneStaleVoiceUsers,
      broadcastStreamInfo, touchVoiceActivity,
      // Push / webhooks
      sendPushNotifications, fireWebhookCallbacks, fireWebhookEvent,
      // Slash commands
      processSlashCommand,
      // Music helpers
      resolveSpotifyToYouTube, searchYouTube, fetchYouTubePlaylist,
      extractYouTubeVideoId, resolveMusicMetadata,
      getActiveMusicSyncState, updateActiveMusicPlaybackState,
      setActiveMusic, emitMusicSharedToRoom, startQueuedMusic,
      popNextQueuedMusic, isNaturalMusicFinish,
      broadcastMusicQueue, getMusicQueuePayload,
      sanitizeQueueEntry, trimMusicText, stripYouTubePlaylistParam,
      // Auth
      generateChannelCode, generateToken,
      // Flood
      floodCheck,
      // Transfer admin mutex
      transferAdminRef,
      // Audit log
      logAudit,
      // Constants
      HAVEN_VERSION, ADMIN_USERNAME,
      DATA_DIR, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR,
      VALID_ROLE_PERMS
    };

    // ── Register domain modules ───────────────────────────
    registerChannels(socket, ctx);
    registerMessages(socket, ctx);
    registerVoice(socket, ctx);
    registerMusic(socket, ctx);
    registerUsers(socket, ctx);
    registerModeration(socket, ctx);
    registerRoles(socket, ctx);
    registerAdmin(socket, ctx);

    // ── Disconnect handler ────────────────────────────────
    socket.on('disconnect', () => {
      if (!socket.user) return;
      console.log(`❌ ${socket.user.username} disconnected`);

      const affectedChannels = new Set();
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          let otherSocketAlive = false;
          for (const [, s] of io.of('/').sockets) {
            if (s.user && s.user.id === socket.user.id && s.id !== socket.id) {
              users.set(socket.user.id, { ...users.get(socket.user.id), socketId: s.id });
              otherSocketAlive = true;
              break;
            }
          }
          if (!otherSocketAlive) {
            users.delete(socket.user.id);
          }
          affectedChannels.add(code);
        }
      }

      for (const code of affectedChannels) {
        emitOnlineUsers(code);
      }

      for (const [code, room] of voiceUsers) {
        const voiceEntry = room.get(socket.user.id);
        if (voiceEntry && voiceEntry.socketId === socket.id) {
          handleVoiceLeave(socket, code, { softDisconnect: true });
        }
      }
    });
  });
}

module.exports = { setupSocketHandlers, sanitizeText };
