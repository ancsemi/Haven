'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const webpush = require('web-push');

const { verifyToken, generateChannelCode, generateToken } = require('../auth');
const { sendFcm, isFcmEnabled } = require('../fcm');
const { DATA_DIR, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('../paths');
const HAVEN_VERSION = require('../../package.json').version;

const { sanitizeText, utcStamp, isString, isInt, isValidUploadPath, sanitizeBorderTransform, parseBorderTransform, VALID_ROLE_PERMS, filterIdleOnline } = require('./helpers');
const { socketClientIp } = require('../clientIp');
const automod = require('../automod');
const { resolveSpotifyToYouTube, searchYouTube, fetchYouTubePlaylist, extractYouTubeVideoId, resolveMusicMetadata } = require('./musicResolver');
const createPermissions = require('./permissions');
const { diskStatus } = require('../diskGuard');
const {
  UnsafeCallbackError,
  postWebhookCallback,
  validateCallbackUrl
} = require('../webhookCallback');
const {
  generateUniqueChannelCode,
  persistChannelCodeRotation,
  rotateLiveChannelState
} = require('../channelRotation');

const { createActivity } = require('../activity');

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
function setupSocketHandlers(io, db, opts = {}) {
  const invalidateIpBanCache = (typeof opts.invalidateIpBanCache === 'function') ? opts.invalidateIpBanCache : () => {};
  const onReferrerPolicyChange = (typeof opts.onReferrerPolicyChange === 'function') ? opts.onReferrerPolicyChange : () => {};
  // Per-member upload totals, computed by the HTTP layer that owns the
  // uploads directory. Returns empty usage when the host did not supply it.
  const getUploadUsage = (typeof opts.getUploadUsage === 'function')
    ? opts.getUploadUsage
    : () => ({ byUser: new Map(), liveBytes: 0, attributedBytes: 0, unattributedBytes: 0, fileCount: 0 });

  // ── Client IP + ban matching (v3.42.0) ───────────────────
  // Both delegate to the same helpers the HTTP layer uses so the two gates
  // can never disagree about who a client is or whether they are banned.
  // server.js passes its cached matcher in; the fallback keeps this module
  // usable standalone (tests, older callers) at the cost of a query per check.
  const clientIp = (socket) => socketClientIp(socket);
  const isIpBanned = (typeof opts.isIpBanned === 'function')
    ? opts.isIpBanned
    : (ip) => {
        try {
          const { normalizeIp, ipMatches } = require('../clientIp');
          const norm = normalizeIp(ip);
          if (!norm) return false;
          return db.prepare('SELECT ip FROM ip_bans').all()
            .some(r => r.ip && (r.ip.includes('/') ? ipMatches(norm, r.ip) : normalizeIp(r.ip) === norm));
        } catch { return false; }
      };

  // ── Permission helpers (shared across all connections) ───
  const {
    getChannelRoleChain, getUserEffectiveLevel, getPermissionThresholds,
    userHasPermission, getUserPermissions, getUserGlobalPermissions, getUserRoles, getUserHighestRole, getUserAllRoles, getAdminRoleDisplay
  } = createPermissions(db);

  // ── Shared state Maps ───────────────────────────────────
  const channelUsers        = new Map(); // code → Map<userId, { id, username, socketId, avatar?, avatar_shape? }>
  const voiceUsers          = new Map(); // code → Map<userId, { id, username, socketId, isMuted, isDeafened }>
  const voiceLastActivity   = new Map(); // userId → timestamp
  const activeMusic         = new Map(); // code → { url, userId, username, playbackState, ... }
  const musicQueues         = new Map(); // code → [{ id, url, title, userId, username, resolvedFrom }]
  const activeScreenSharers = new Map(); // code → Set<userId>
  const activeWebcamUsers   = new Map(); // code → Set<userId>
  const userFloodBuckets    = new Map(); // `${userId}:${bucket}` → number[] (send timestamps)
  // Presence timing for the "idle but online" flag. onlineSince is set when a
  // user goes from having zero live sockets to one; lastActiveAt advances only
  // on deliberate human actions (posting, joining voice, changing status).
  // Cleared when the user's last socket disconnects. Lets a mod spot an
  // account that has sat connected and green for hours doing nothing, which is
  // the signature of a logging bot rather than a person (a real client trips
  // auto-away). userId → { onlineSince, lastActiveAt }
  const presenceTimers      = new Map();

  // Advance a user's activity clock. Called for the deliberate actions that
  // mark a real, engaged human — not passive traffic like typing or
  // visibility pings, and not the client's automatic away transition (that
  // one is exactly what we're using to tell people from bots).
  function touchPresenceActivity(userId) {
    const t = presenceTimers.get(userId);
    if (t) t.lastActiveAt = Date.now();
  }

  // The oversight query behind the flag. Returns accounts that are online,
  // showing as 'online' (green — an auto-away client is excluded), and have
  // had no deliberate activity for at least thresholdMs.
  function getIdleOnlineUsers(thresholdMs) {
    // Build one entry per online user from the presence clock plus their live
    // status, then let the pure helper make the decision (unit-tested).
    const entries = [];
    for (const [userId, t] of presenceTimers) {
      let status = null, username = null, isAdmin = false, createdAt = null;
      for (const [, s] of io.of('/').sockets) {
        if (s.user && s.user.id === userId) {
          status = s.user.status || 'online';
          username = s.user.displayName || s.user.username;
          isAdmin = !!s.user.isAdmin;
          createdAt = s.user.createdAt || null;
          break;
        }
      }
      entries.push({ id: userId, username, isAdmin, createdAt,
        onlineSince: t.onlineSince, lastActiveAt: t.lastActiveAt, status });
    }
    return filterIdleOnline(entries, thresholdMs, Date.now());
  }
  const streamViewers       = new Map(); // "code:sharerId" → Set<viewerUserId>
  const slowModeTracker     = new Map(); // "slow:{userId}:{channelId}" → timestamp
  const pendingTempDelete   = new Map(); // code → timeout handle (grace-period before deleting temp-voice channel)
  const pendingVoiceLeave   = new Map(); // `${userId}:${code}` → { timer, oldSocketId, code } (grace-period before evicting a transiently-disconnected voice user)

  const state = {
    channelUsers, voiceUsers, voiceLastActivity,
    activeMusic, musicQueues,
    activeScreenSharers, activeWebcamUsers, streamViewers,
    slowModeTracker, pendingTempDelete, pendingVoiceLeave
  };

  // ── Rich presence ───────────────────────────────────────
  // Owns the in-memory "what is this user doing" map and the Steam/Spotify
  // pollers. Only polls for users who are connected right now, which is why
  // it needs a live view of the socket set rather than a DB query.
  const activity = createActivity({
    db,
    getOnlineUserIds: () => {
      const ids = new Set();
      for (const [, s] of io.of('/').sockets) if (s.user) ids.add(s.user.id);
      return Array.from(ids);
    },
    // A user's activity changed → re-broadcast presence for whatever channel
    // they're in, so watchers see it without waiting for an organic update.
    onChange: (userId) => {
      try {
        for (const [, s] of io.of('/').sockets) {
          if (s.user && s.user.id === userId && s.currentChannel) {
            emitOnlineUsers(s.currentChannel);
            break;
          }
        }
      } catch { /* presence is best-effort */ }
    },
    // Linked accounts changed. Push to EVERY socket this user has open, not
    // just the one that started the flow — the OAuth callback frequently
    // completes somewhere else entirely (Steam's QR sign-in hands off to
    // whatever browser is default), so the app that's actually open has no
    // other way to learn the link succeeded.
    onConnectionsChanged: (userId) => {
      try {
        const payload = {
          connections: activity.listConnections(userId),
          available: {
            steam: activity.isSteamConfigured(),
            spotify: activity.isSpotifyConfigured(),
            // Omitting a provider here reads client-side as "not configured",
            // so this list must stay in step with the ones in users.js. Missing
            // lastfm made a successful link immediately revert the row to
            // "Set up" — the success toast and the regression arrived in the
            // same push.
            lastfm: activity.isLastfmConfigured(),
          },
        };
        for (const [, s] of io.of('/').sockets) {
          if (s.user && s.user.id === userId) s.emit('connections', payload);
        }
      } catch { /* best-effort */ }
    },
  });
  activity.start();
  state.activity = activity;

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
    syncMusicActivity(code);
    return music;
  }

  /**
   * Push Haven's own player into rich presence for everyone currently in the
   * voice room — not just whoever queued the track, since they're all actually
   * listening to it. Called whenever the track changes or the room membership
   * changes; the activity engine ignores no-op updates, so calling it often is
   * cheap and calling it too rarely is what causes stale "listening to" lines.
   */
  function syncMusicActivity(code) {
    if (!state.activity) return;
    const room = voiceUsers.get(code);
    const listeners = room ? Array.from(room.keys()) : [];
    const music = activeMusic.get(code);

    if (!music || music.playbackState?.isPlaying === false) {
      state.activity.clearHavenMusic(listeners);
      return;
    }
    let channelName = code;
    try {
      const ch = db.prepare('SELECT name FROM channels WHERE code = ?').get(code);
      if (ch?.name) channelName = ch.name;
    } catch { /* fall back to the code */ }

    state.activity.setHavenMusic(listeners, { title: music.title, channelName });
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
  function getEnrichedChannels(userId, isAdmin, joinRooms, knownCodes = []) {
    // Holders of 'view_all_channels' (e.g. a server-wide Mod role) get the
    // same visibility treatment as the admin: every non-DM channel, with
    // membership filled in on the fly — so channels created after the role
    // was granted show up for them automatically instead of someone having
    // to add every mod to every new channel by hand.
    const seesAll = isAdmin || userHasPermission(userId, 'view_all_channels');
    // Only auto-joins owed to the permission are marked. An admin's are not:
    // admin is not a role that gets revoked in the same casual way, and their
    // memberships should survive a permission cleanup. (#5512)
    const autoJoin = seesAll && !isAdmin ? 1 : 0;
    let channels;
    if (seesAll) {
      channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome
        FROM channels c WHERE c.is_dm = 0
        UNION
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 1
        ORDER BY is_dm, position, name
      `).all(userId);
      // OR IGNORE, so a membership the user already had by other means keeps
      // its existing flag and survives a later cleanup.
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, auto_all_channels) VALUES (?, ?, ?)');
      channels.forEach(ch => { if (!ch.is_dm) insertMember.run(ch.id, userId, autoJoin); });
    } else {
      channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        ORDER BY c.is_dm, c.position, c.name
      `).all(userId);

      // Self-heal legacy accounts that somehow ended up with zero memberships.
      // This restores visibility without requiring the user to manually join by code.
      if (channels.length === 0) {
        const userRow = db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId);
        if (!userRow || !userRow.is_guest) {
          let targetRows = [];
          try {
            const djc = db.prepare("SELECT value FROM server_settings WHERE key = 'default_join_channels'").get();
            const parsed = djc && djc.value ? JSON.parse(djc.value) : [];
            const ids = Array.isArray(parsed)
              ? parsed.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0)
              : [];

            if (ids.length > 0) {
              const ph = ids.map(() => '?').join(',');
              targetRows = db.prepare(
                `SELECT id FROM channels WHERE is_dm = 0 AND is_private = 0 AND id IN (${ph})`
              ).all(...ids);
            }
          } catch {
            targetRows = [];
          }

          if (targetRows.length === 0) {
            targetRows = db.prepare(
              'SELECT id FROM channels WHERE is_dm = 0 AND is_private = 0 ORDER BY position, name'
            ).all();
          }

          if (targetRows.length > 0) {
            const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
            for (const row of targetRows) insertMember.run(row.id, userId);
            channels = db.prepare(`
              SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
                     c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
                     c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
                     c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
                     c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
                     c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome
              FROM channels c
              JOIN channel_members cm ON c.id = cm.channel_id
              WHERE cm.user_id = ?
              ORDER BY c.is_dm, c.position, c.name
            `).all(userId);
          }
        }
      }
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

      const requestedAliases = [...new Set(knownCodes)]
        .filter(code => typeof code === 'string' && /^[a-f0-9]{8}$/i.test(code))
        .slice(0, 2000);
      let historyRows = [];
      if (requestedAliases.length > 0) {
        const authorizedIds = new Set(channelIds);
        for (let offset = 0; offset < requestedAliases.length; offset += 400) {
          const batch = requestedAliases.slice(offset, offset + 400);
          const aliasPlaceholders = batch.map(() => '?').join(',');
          const rows = db.prepare(
            `SELECT channel_id, old_code FROM channel_code_history WHERE old_code IN (${aliasPlaceholders}) ORDER BY rotated_at`
          ).all(...batch);
          historyRows.push(...rows.filter(row => authorizedIds.has(row.channel_id)));
        }
      }
      const codeHistory = {};
      for (const row of historyRows) {
        if (!codeHistory[row.channel_id]) codeHistory[row.channel_id] = [];
        codeHistory[row.channel_id].push(row.old_code);
      }

      channels.forEach(ch => {
        ch.previous_codes = codeHistory[ch.id] || [];
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

        // Whether this viewer may post in a read-only channel, answered per
        // channel. The client only ever had a flat permission list that merges
        // server-wide grants with every channel-scoped one, so holding
        // read_only_override in a single channel made the composer appear in
        // every read-only channel. The send was still refused server-side, so
        // the box looked usable and silently was not. (#5468)
        if (ch.read_only === 1 && !ch.is_dm) {
          ch.canOverrideReadOnly = isAdmin || userHasPermission(userId, 'read_only_override', ch.id);
        }

        // Whether this viewer may invite someone into this private channel.
        // Mirrors the rule the invite-to-channel handler already enforces:
        // admin, the channel's creator, or a moderator within that channel.
        // The menu only ever offered private channels to admins, so creators
        // and channel moderators held the right with no way to use it. This
        // does not widen the rule, it just lets the UI match it. (#5466)
        if (!ch.is_dm && (ch.is_private || ch.code_visibility === 'private')) {
          ch.canInvitePrivate = isAdmin
            || ch.created_by === userId
            || userHasPermission(userId, 'kick_user', ch.id);
        }

        // Same per-channel answer for the two channel-management surfaces the
        // flat permission list gets wrong. Holding manage_channel_settings in
        // one channel put "Channel Functions" in every channel's menu, and
        // holding manage_sub_channels in one channel offered "Create
        // Sub-channel" everywhere. Both were refused server-side, so the
        // controls were there but dead. (#5467)
        if (!ch.is_dm) {
          ch.canManageSettings = isAdmin || userHasPermission(userId, 'manage_channel_settings', ch.id);
          ch.canManageSubs = isAdmin || userHasPermission(userId, 'manage_sub_channels', ch.id);
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
      // DM channels route by code internally but the code is a pure implementation
      // detail. Never expose it as a copyable value — strip all code-related fields
      // so no client surface can accidentally reveal or share it.
      if (ch.is_dm) {
        ch.display_code = null;
        delete ch.code_visibility;
        delete ch.code_mode;
        delete ch.code_rotation_type;
        delete ch.code_rotation_interval;
        return;
      }
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

  // ── Channel member list (@mention autocomplete source) ──
  // A ban leaves channel_members alone on purpose, so an unban puts the person
  // back in exactly the channels they were in. That meant banned accounts kept
  // appearing in @mention autocomplete, so filter them here (the one place
  // this list is built) rather than in each caller.
  function getMentionableChannelMembers(channelId) {
    return db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) as username, u.username as loginName FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      LEFT JOIN bans b ON b.user_id = u.id
      WHERE cm.channel_id = ? AND b.user_id IS NULL
      ORDER BY COALESCE(u.display_name, u.username)
    `).all(channelId);
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
  // Returns an array of removed { id, username } so callers can decide
  // whether to broadcast a fresh roster. We do NOT broadcast from inside
  // prune to avoid recursion with broadcastVoiceUsers.
  function pruneStaleVoiceUsers(code) {
    const room = voiceUsers.get(code);
    if (!room) return [];
    const removed = [];
    for (const [userId, entry] of room) {
      // Don't prune a user who is inside their post-disconnect grace window
      // (#5444). Their old socket is gone, but a reconnect + voice-rejoin is
      // expected within a few seconds and will rebind the entry. Pruning here
      // races that rebind: it fires a spurious voice-user-left (leave sound),
      // the rejoin then fires a join sound, and the user briefly vanishes from
      // the roster — exactly the "kicked from voice on a brief blip / double
      // join-leave notifications" report. The 4s grace timer (see the
      // disconnect handler) already evicts them if they never actually return.
      if (pendingVoiceLeave.has(`${userId}:${code}`)) continue;
      const sock = io.sockets.sockets.get(entry.socketId);
      if (!sock || !sock.connected) {
        room.delete(userId);
        removed.push({ id: userId, username: entry.username });
        console.log(`[Voice] Pruned stale voice entry for user ${userId} (socket ${entry.socketId} gone)`);
      }
    }
    if (room.size === 0) {
      voiceUsers.delete(code);
      activeMusic.delete(code);
      syncMusicActivity(code);
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
    // Tell any remaining peers (and watchers of the text channel) that the
    // pruned users are gone so they tear down dead RTCPeerConnections and
    // clear stale sidebar entries. This is the safety net for ghost users
    // that the disconnect/leave handlers somehow missed (rejoin races,
    // owner-mismatch, dropped events, etc.). See #5347.
    for (const u of removed) {
      io.to(`voice:${code}`).to(`channel:${code}`).emit('voice-user-left', {
        channelCode: code,
        user: { id: u.id, username: u.username }
      });
    }
    return removed;
  }

  // ── broadcastVoiceUsers ─────────────────────────────────
  function broadcastVoiceUsers(code) {
    pruneStaleVoiceUsers(code);
    // Room membership just changed, so who is "listening to" the active track
    // changed with it — someone who joined mid-song should pick it up.
    syncMusicActivity(code);
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    const channelId = channel ? channel.id : null;
    const room = voiceUsers.get(code);
    const users = room
      ? Array.from(room.values()).map(u => {
          const role = getUserHighestRole(u.id, channelId);
          const roles = getUserAllRoles(u.id, channelId);
          return {
            id: u.id, username: u.username,
            roleColor: role ? role.color : null,
            roleName: role ? role.name : null,
            roles,
            isMuted: u.isMuted || false, isDeafened: u.isDeafened || false
          };
        })
      : [];
    io.to(`voice:${code}`).to(`channel:${code}`).emit('voice-users-update', { channelCode: code, users });
    io.emit('voice-count-update', {
      code, count: users.length,
      users: users.map(u => ({ id: u.id, username: u.username, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false }))
    });
  }

  // A user agent is long, spoofable and full of history nobody wants to read.
  // All this needs to do is let you recognise your own devices well enough to
  // notice one you do not recognise, so it reduces to browser plus platform.
  function _describeUserAgent(ua) {
    if (!ua || typeof ua !== 'string') return 'Unknown device';
    const browser =
      /Edg\//.test(ua)                        ? 'Edge'
      : /OPR\/|Opera/.test(ua)            ? 'Opera'
      : /Firefox\//.test(ua)                  ? 'Firefox'
      : /Chrome\//.test(ua)                   ? 'Chrome'
      : /Safari\//.test(ua)                   ? 'Safari'
      : /Haven|Electron/i.test(ua)              ? 'Haven Desktop'
      : 'Browser';
    const platform =
      /Android/.test(ua)                    ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)  ? 'iOS'
      : /Windows/.test(ua)                  ? 'Windows'
      : /Mac OS X|Macintosh/.test(ua)   ? 'macOS'
      : /Linux/.test(ua)                    ? 'Linux'
      : '';
    return platform ? `${browser} on ${platform}` : browser;
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
      const statusRows = db.prepare('SELECT id, status, status_text, avatar, avatar_shape, border, border_transform, animate_profile, is_guest FROM users').all();
      statusRows.forEach(r => { statusMap[r.id] = { status: r.status || 'online', statusText: r.status_text || '', avatar: r.avatar || null, avatarShape: r.avatar_shape || 'circle', border: r.border || null, borderTransform: parseBorderTransform(r.border_transform), animateProfile: r.animate_profile || 'trigger', isGuest: !!r.is_guest }; });
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
        border: statusMap[m.id]?.border || null,
        borderTransform: statusMap[m.id]?.borderTransform || null,
        animateProfile: statusMap[m.id]?.animateProfile || 'trigger',
        isGuest: statusMap[m.id]?.isGuest || false,
        role: getUserHighestRole(m.id, channel ? channel.id : null),
        // null unless the user opted in; getPublicActivity applies their
        // privacy prefs, so nothing filtered here can leak downstream.
        activity: globalOnlineIds.has(m.id) ? activity.getPublicActivity(m.id) : null
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
            border: statusMap[s.user.id]?.border || s.user.border || null,
            borderTransform: statusMap[s.user.id]?.borderTransform || s.user.borderTransform || null,
            animateProfile: statusMap[s.user.id]?.animateProfile || s.user.animate_profile || 'trigger',
            isGuest: statusMap[s.user.id]?.isGuest || !!s.user.isGuest,
            role: getUserHighestRole(s.user.id, channel ? channel.id : null),
            activity: activity.getPublicActivity(s.user.id)
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

    // Leaving voice ends any Haven-sourced "listening to" for this user.
    // syncMusicActivity only touches people still in the room, so the leaver
    // has to be cleared explicitly or their activity would freeze on the last
    // track they heard.
    if (state.activity) state.activity.clearHavenMusic([socket.user.id]);

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
      syncMusicActivity(code);
      musicQueues.delete(code);

      let tempChannel = null;
      try {
        tempChannel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_temp_voice = 1').get(code);
      } catch { /* column may not exist yet */ }
      if (tempChannel) {
        const doDeleteTempChannel = () => {
          try {
            const ch = db.prepare('SELECT id, code, is_temp_voice FROM channels WHERE id = ?').get(tempChannel.id);
            if (ch && ch.is_temp_voice) {
              const deleteCode = ch.code;
              // Double-check the room is still empty — someone may have rejoined
              // during the grace period.
              const currentRoom = voiceUsers.get(deleteCode);
              if (currentRoom && currentRoom.size > 0) return;
              db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
              db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
              db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
              db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
              db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
              io.emit('channel-deleted', { code: deleteCode, reason: 'temp-empty' });
              channelUsers.delete(deleteCode);
              voiceUsers.delete(deleteCode);
              pendingTempDelete.delete(deleteCode);
              console.log(`[Temporary] Temp voice channel "${deleteCode}" deleted (everyone left)`);
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

      // 3.20.2 (#5399 follow-up): pull the per-user mute set for this
      // channel up front so we can skip both web-push AND FCM for anyone
      // who's muted it. Was previously localStorage-only, which the mobile
      // app had no visibility into — so muted users still got pushed.
      let mutedUserIds = new Set();
      try {
        const mutedRows = db.prepare(
          'SELECT user_id FROM user_channel_prefs WHERE channel_code = ? AND muted = 1'
        ).all(channelCode);
        mutedUserIds = new Set(mutedRows.map(r => r.user_id));
      } catch { /* table may not exist on a brand-new fresh schema race; skip */ }

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
        if (mutedUserIds.has(sub.user_id)) continue;
        const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        webpush.sendNotification(pushSub, payload).catch((err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint); } catch { /* non-critical */ }
          }
        });
      }

      // isFcmEnabled() also reflects the admin's FCM Privacy toggle, kept in
      // memory and synced on change, so no per-message DB read. Web-push above
      // is unaffected either way.
      if (isFcmEnabled()) {
        const inactiveMembers = db.prepare(`
          SELECT DISTINCT cm.user_id FROM channel_members cm
          WHERE cm.channel_id = ? AND cm.user_id != ?
        `).all(channelId, senderUserId)
          .filter(m => !activeUserIds.has(m.user_id))
          .filter(m => !mutedUserIds.has(m.user_id))
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
  // SSRF guard: reject private/internal IPs in callback URLs.
  //
  // Self-hosters whose bot runs on the same LAN or in a sibling Docker
  // container have a legitimate reason to point a callback at a private
  // address (#5518), so HAVEN_ALLOW_PRIVATE_CALLBACKS=true lifts the private
  // range checks. It is an env var rather than an admin toggle on purpose:
  // setting a callback URL only needs the manage_webhooks permission, so a
  // toggle in the UI could be flipped by the very account the guard exists to
  // contain. Changing an env var needs access to the host itself.
  const ALLOW_PRIVATE_CALLBACKS = process.env.HAVEN_ALLOW_PRIVATE_CALLBACKS === 'true';
  if (ALLOW_PRIVATE_CALLBACKS) {
    console.warn('⚠️  HAVEN_ALLOW_PRIVATE_CALLBACKS=true: bot callback URLs may point at private or local addresses.');
  }

  function isSafeCallbackUrl(urlString) {
    return validateCallbackUrl(urlString, ALLOW_PRIVATE_CALLBACKS);
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
      const resp = await postWebhookCallback(bot.callback_url, payload, headers, {
        allowPrivateCallbacks: ALLOW_PRIVATE_CALLBACKS,
        timeoutMs: 10000
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
      if (err instanceof UnsafeCallbackError || err?.code === 'ERR_UNSAFE_CALLBACK_URL') {
        _recordWebhookDelivery(bot.id, 0, msg.slice(0, 200));
        console.warn(`Webhook callback blocked for bot ${bot.id}: ${msg}`);
        return;
      }
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
        "SELECT id, code, auto_delete_mode, auto_delete_interval_hours FROM channels WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')"
      ).all();
      for (const ch of expired) {
        if (ch.auto_delete_mode === 'clear') {
          // #5390 — clear-messages mode: wipe message-related rows but keep
          // the channel, its members, permissions, roles, and integrations
          // intact. Then rearm the timer using the original interval so the
          // sweep repeats (e.g. daily flood-channel reset) until an admin
          // disables it. If for some reason the interval wasn't stored,
          // fall back to disabling the timer to avoid getting stuck firing
          // a zero-second loop.
          db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
          db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
          const interval = ch.auto_delete_interval_hours;
          if (interval && interval > 0) {
            const nextExpiry = new Date(Date.now() + interval * 3600000).toISOString();
            db.prepare('UPDATE channels SET expires_at = ? WHERE id = ?').run(nextExpiry, ch.id);
          } else {
            db.prepare('UPDATE channels SET expires_at = NULL WHERE id = ?').run(ch.id);
          }
          io.to(`channel:${ch.code}`).emit('channel-messages-cleared', { code: ch.code, reason: 'auto-clear' });
          // Refresh channel lists so the new expires_at propagates to clients.
          try { broadcastChannelLists(); } catch {}
          console.log(`[Temporary] Channel "${ch.code}" messages cleared (auto-clear mode)`);
        } else {
          db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(ch.id);
          db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
          db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
          io.to(`channel:${ch.code}`).to(`voice:${ch.code}`).emit('channel-deleted', { code: ch.code, reason: 'expired' });
          channelUsers.delete(ch.code);
          voiceUsers.delete(ch.code);
          activeMusic.delete(ch.code);
      syncMusicActivity(ch.code);
          musicQueues.delete(ch.code);
          console.log(`[Temporary] Channel "${ch.code}" expired and was deleted`);
        }
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
      syncMusicActivity(ch.code);
        musicQueues.delete(ch.code);
        console.log(`[Temporary] Empty temp voice channel "${ch.code}" pruned by safety-net sweep`);
      }
    } catch { /* column may not exist yet */ }
  }, 60 * 1000);

  function rotateChannelCode(channelId, oldCode) {
    const newCode = generateUniqueSharedCode(oldCode);
    persistChannelCodeRotation(db, channelId, oldCode, newCode);
    rotateLiveChannelState(io, state, channelId, oldCode, newCode);
    return newCode;
  }

  function generateUniqueSharedCode(excludeCode = null) {
    return generateUniqueChannelCode(db, generateChannelCode, excludeCode);
  }

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
          const newCode = rotateChannelCode(ch.id, oldCode);
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
    // Real client IP, not the proxy's. socket.handshake.address is the raw TCP
    // peer and ignores `trust proxy`, so behind nginx/Cloudflare every user
    // shared one bucket here and this limiter effectively did nothing. (v3.42.0)
    const ip = clientIp(socket);
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

  // IP ban gate — block banned addresses before token verification so they
  // never see the auth handshake response. Mirrors the HTTP middleware in
  // server.js. (v3.20.0)
  io.use((socket, next) => {
    try {
      const ip = clientIp(socket);
      // Delegates to the same cache + matcher the HTTP gate uses, so the two
      // can no longer disagree. The old code compared the raw handshake
      // address against the stored string: a ban on "1.2.3.4" never matched
      // the "::ffff:1.2.3.4" a dual-stack listener reports, so HTTP was
      // blocked while the socket connected anyway. CIDR entries also work
      // now, which matters for IPv6 where one subscriber holds a whole /64.
      if (ip && isIpBanned(ip)) {
        return next(new Error('Your IP has been banned from this server'));
      }
    } catch { /* table may not exist on very old DBs — fail open */ }
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
      // created_at feeds the automod new-account link gate (v3.42.0).
      const uRow = db.prepare('SELECT display_name, is_admin, username, avatar, avatar_shape, border, border_transform, animate_profile, password_version, is_guest, created_at, oidc_subject FROM users WHERE id = ?').get(user.id);
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
      socket.user.border = uRow.border || null;
      socket.user.borderTransform = parseBorderTransform(uRow.border_transform);
      socket.user.animate_profile = uRow.animate_profile || 'trigger';
      socket.user.isGuest = !!uRow.is_guest;
      socket.user.createdAt = uRow.created_at || null;
      // (#12) The client needs this to ask for the right secret: an SSO
      // account unlocks E2E with its encryption passphrase, not a password.
      socket.user.isSso = !!uRow.oidc_subject;

      const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (!anyAdmin && uRow.username.toLowerCase() === ADMIN_USERNAME && !uRow.is_admin) {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
        uRow.is_admin = 1;
      }
      socket.user.isAdmin = !!uRow.is_admin;
    } catch {
      socket.user.displayName = user.displayName || user.username;
      socket.user.isGuest = !!user.isGuest;
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

    // Record IP for future "ban IP" lookups. Kept to the 5 most-recent
    // distinct IPs per user — older entries are pruned to bound storage.
    try {
      // Normalised, proxy-aware address. Storing the raw handshake address
      // here was actively dangerous: behind a reverse proxy it recorded the
      // proxy's IP for every account, so a moderator ticking "also ban IP"
      // would have banned the proxy and locked every user out. (v3.42.0)
      const ip = clientIp(socket);
      if (ip) {
        db.prepare(`INSERT INTO user_ips (user_id, ip, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = CURRENT_TIMESTAMP`)
          .run(user.id, ip);
        // Prune to last 5 IPs for this user
        db.prepare(`DELETE FROM user_ips WHERE user_id = ? AND ip NOT IN (
                      SELECT ip FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT 5
                    )`).run(user.id, user.id);
      }
    } catch { /* table may not exist on very old DBs */ }

    next();
  });

  // Clean up connection tracker (every 5 min)
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of connTracker) {
      if (now > entry.resetTime + 120000) connTracker.delete(ip);
    }
    // Flood buckets outlive their sockets now that they are keyed by user, so
    // drop any whose newest timestamp has aged out of the widest window.
    for (const [key, stamps] of userFloodBuckets) {
      if (!stamps.length || now - stamps[stamps.length - 1] > 120000) userFloodBuckets.delete(key);
    }
  }, 5 * 60 * 1000);

  // (#5505) Watch the disk headroom and tell admins when it changes. Only the
  // transitions are broadcast, so a server sitting healthy sends nothing and a
  // server sitting full does not repeat itself every minute. statfs is cached
  // inside the guard, so this costs a syscall a minute at worst.
  let _diskWasLow = false;
  setInterval(() => {
    try {
      const status = diskStatus();
      if (status.low === _diskWasLow) return;
      _diskWasLow = status.low;
      io.to('admins').emit('disk-status', status);
    } catch { /* never let a health check take the server down */ }
  }, 60 * 1000);

  // ══════════════════════════════════════════════════════════
  // CONNECTION HANDLER
  // ══════════════════════════════════════════════════════════

  io.on('connection', (socket) => {
    if (!socket.user || !socket.user.username) {
      console.warn('⚠️  Connection without valid user — disconnecting');
      socket.disconnect(true);
      return;
    }

    // Stamped here rather than read from the token: the token's iat is when
    // you signed in, which can be weeks before this tab opened.
    if (socket.handshake) socket.handshake.issued = Date.now();
    console.log(`✅ ${socket.user.username} connected`);
    socket.currentChannel = null;
    socket.hasFocus = true;

    // (#5518 sibling) Your own open connections, for the session list in
    // Settings. Haven issues stateless tokens and keeps no session table, so
    // this is exactly what it says: sockets attached right now. A token with no
    // tab open does not appear here, which is why the list is paired with a
    // revoke that invalidates every token rather than individual rows.
    socket.on('get-sessions', () => {
      const mine = [];
      for (const [, s2] of io.of('/').sockets) {
        if (!s2.user || s2.user.id !== socket.user.id) continue;
        const ua = (s2.handshake?.headers?.['user-agent']) || '';
        mine.push({
          id: s2.id,
          current: s2.id === socket.id,
          device: _describeUserAgent(ua),
          ip: socketClientIp(s2),
          since: s2.handshake?.issued || null
        });
      }
      // Current session first, then oldest to newest so a new arrival appears
      // at the bottom where it is easy to spot.
      mine.sort((a, b) => (b.current - a.current) || ((a.since || 0) - (b.since || 0)));
      socket.emit('sessions-list', { sessions: mine });
    });

    // (#5505) Admins get their own room so server-health warnings can reach
    // them without walking every socket. An admin joining mid-problem is told
    // straight away rather than waiting for the next poll.
    if (socket.user.isAdmin) {
      socket.join('admins');
      const status = diskStatus();
      if (status.low) socket.emit('disk-status', status);
    }

    // Start the presence clock the moment a user goes from offline to online.
    // A second tab/device keeps the original onlineSince so "continuously
    // online" means what it says. (idle-online flag)
    if (!presenceTimers.has(socket.user.id)) {
      const now = Date.now();
      presenceTimers.set(socket.user.id, { onlineSince: now, lastActiveAt: now });
    }
    socket.on('visibility-change', (data) => {
      if (data && typeof data.visible === 'boolean') socket.hasFocus = data.visible;
    });

    // Push authoritative session info
    // (#5394) Include server-stored nicknames so they sync across devices.
    let nicknames = {};
    try {
      const rows = db.prepare('SELECT target_id, nickname FROM user_nicknames WHERE owner_id = ?').all(socket.user.id);
      for (const r of rows) nicknames[r.target_id] = r.nickname;
    } catch { /* non-critical — table may not exist yet on old installs before migration runs */ }

    socket.emit('session-info', {
      id: socket.user.id, username: socket.user.username,
      isAdmin: socket.user.isAdmin,
      isSso: !!socket.user.isSso,
      displayName: socket.user.displayName,
      avatar: socket.user.avatar || null,
      avatarShape: socket.user.avatar_shape || 'circle',
      border: socket.user.border || null,
      borderTransform: socket.user.borderTransform || null,
      animateProfile: socket.user.animate_profile || 'trigger',
      version: HAVEN_VERSION,
      roles: socket.user.roles || [],
      effectiveLevel: socket.user.effectiveLevel || 0,
      permissions: getUserPermissions(socket.user.id),
      globalPermissions: getUserGlobalPermissions(socket.user.id),
      status: socket.user.status || 'online',
      statusText: socket.user.statusText || '',
      nicknames
    });

    // Send current voice counts for sidebar indicators.
    // Prune stale entries first so the new client doesn't seed its sidebar
    // with ghost users left behind by abrupt disconnects (#5347 follow-up).
    // pruneStaleVoiceUsers itself broadcasts voice-user-left for ghosts it
    // removes, which is enough — we don't also call broadcastVoiceUsers
    // here because that races the upcoming voice-rejoin broadcast and can
    // re-seed every other client's sidebar with this socket's pre-rejoin
    // view of the room. (#5347 v3.15.4.)
    for (const code of Array.from(voiceUsers.keys())) {
      pruneStaleVoiceUsers(code);
      const room = voiceUsers.get(code);
      if (room && room.size > 0) {
        const users = Array.from(room.values()).map(u => ({
          id: u.id, username: u.username, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false
        }));
        socket.emit('voice-count-update', { code, count: room.size, users });
      } else {
        socket.emit('voice-count-update', { code, count: 0, users: [] });
      }
    }

    // ── Per-user flood protection ─────────────────────────
    // These buckets used to live per-socket, which meant the limit scaled with
    // however many connections you opened: two tabs bought twice the send
    // rate, and reconnecting reset the window outright. Keying on user id
    // instead makes the cap mean what it says. (v3.42.0)
    const FLOOD_LIMITS = {
      message: { max: 10, windowMs: 10000 },
      event:   { max: 60, windowMs: 10000 },
    };

    function floodCheck(bucket) {
      const limit = FLOOD_LIMITS[bucket];
      const key = `${socket.user.id}:${bucket}`;
      const now = Date.now();
      const timestamps = (userFloodBuckets.get(key) || []).filter(t => now - t < limit.windowMs);
      if (timestamps.length >= limit.max) {
        userFloodBuckets.set(key, timestamps);
        return true;
      }
      timestamps.push(now);
      userFloodBuckets.set(key, timestamps);
      return false;
    }

    const FLOOD_EXEMPT = new Set([
      'voice-offer', 'voice-answer', 'voice-ice-candidate',
      'screen-share-started', 'screen-share-stopped',
      'request-screen-renegotiate',
      'voice-speaking', 'webcam-started', 'webcam-stopped',
      'stream-viewer-joined', 'stream-viewer-left',
      'visibility-change'
    ]);

    // Events that mark a real, engaged human for the idle-online flag. Kept
    // deliberately narrow: passive traffic (typing, visibility, presence
    // pings) and the client's automatic away transition are NOT here, because
    // an account staying green with none of THESE happening is exactly what
    // we're trying to surface.
    const PRESENCE_ACTIVE_EVENTS = new Set([
      'send-message', 'send-thread-message', 'edit-message',
      'add-reaction', 'remove-reaction',
      'voice-join', 'voice-rejoin', 'set-status',
      'start-dm', 'create-channel'
    ]);

    socket.use((packet, next) => {
      const eventName = packet[0];
      if (PRESENCE_ACTIVE_EVENTS.has(eventName)) touchPresenceActivity(socket.user.id);
      if (FLOOD_EXEMPT.has(eventName)) return next();
      if (floodCheck('event')) {
        socket.emit('error-msg', 'Slow down — too many requests');
        return;
      }
      next();
    });

    // ── Auto-moderation enforcement (v3.42.0) ─────────────
    //
    // Single choke point for every surface that accepts user text. Returns
    // true when the caller must abort (the content was rejected), false when
    // it is clear to proceed.
    //
    // Blocking happens at send time rather than post-and-delete. That is the
    // whole point: Haven inline-renders image URLs and unfurls og:image
    // straight from the third-party host, so a message that reaches other
    // clients for even a moment has already leaked their IP addresses to
    // whoever posted it. There is no safe window in which to clean up.
    function enforceAutomod(text, opts = {}) {
      let verdict;
      try {
        verdict = automod.checkText(text, {
          userId: socket.user.id,
          isAdmin: socket.user.isAdmin,
          effectiveLevel: getUserEffectiveLevel(socket.user.id, opts.channelId || null),
          createdAt: opts.createdAt || socket.user.createdAt,
          surface: opts.surface || 'message'
        });
      } catch (err) {
        // Never let an automod fault take chat down with it.
        console.error('automod check failed:', err);
        return false;
      }
      if (!verdict || verdict.ok) return false;

      socket.emit('error-msg', verdict.message);

      let outcome = { count: 1, action: 'none' };
      try {
        outcome = automod.recordInfraction(socket.user.id, verdict, opts.channelId || null);
      } catch (err) { console.error('automod infraction record failed:', err); }

      logAudit({
        actor: socket.user, action: 'automod_block',
        target_type: 'user', target_id: socket.user.id, target_name: socket.user.displayName,
        details: { rule: verdict.rule, host: verdict.host || null, surface: opts.surface || 'message',
                   channelId: opts.channelId || null, strikes: outcome.count, escalated: outcome.action }
      });

      applyAutomodEscalation(outcome, verdict);
      mirrorAutomodToLogChannel(verdict, outcome);
      return true;
    }

    // mutes.muted_by and bans.banned_by are both NOT NULL REFERENCES users(id),
    // so an automated action still needs a real account to attribute to.
    // Rather than rebuild two moderation tables to allow NULL, attribute to
    // the longest-standing admin; the "Auto-mod:" reason prefix is what
    // actually tells a reader it was not a human decision.
    function _automodActorId() {
      try {
        const row = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get();
        return row ? row.id : null;
      } catch { return null; }
    }

    // Carry out warn / mute / ban once the strike count crosses a threshold.
    // Kept here rather than in automod.js because it needs the socket layer:
    // live disconnects, presence broadcasts and the ban tables.
    function applyAutomodEscalation(outcome, verdict) {
      if (!outcome || outcome.action === 'none' || outcome.action === 'warn') return;

      // Never let automod act on staff. A misconfigured allowlist should not
      // be able to mute the person who has to fix it.
      if (socket.user.isAdmin) return;

      const reason = `Auto-mod: ${verdict.rule}${verdict.host ? ` (${verdict.host})` : ''}`.slice(0, 200);
      const actorId = _automodActorId();
      // No admin account to attribute to (shouldn't happen on a real server).
      // Blocking already worked; skip escalation rather than self-attributing
      // the punishment to the person being punished.
      if (!actorId) {
        console.warn('automod: no admin account to attribute escalation to, skipping');
        return;
      }

      if (outcome.action === 'mute') {
        try {
          db.prepare(
            "INSERT INTO mutes (user_id, muted_by, reason, expires_at) VALUES (?, ?, ?, datetime('now', ?))"
          ).run(socket.user.id, actorId, reason, `+${outcome.muteMinutes} minutes`);
          socket.emit('muted', { duration: outcome.muteMinutes, reason });
          logAudit({ actor: socket.user, action: 'automod_mute', target_type: 'user',
            target_id: socket.user.id, target_name: socket.user.displayName,
            details: { minutes: outcome.muteMinutes, strikes: outcome.count } });
        } catch (err) { console.error('automod mute failed:', err); }
        return;
      }

      if (outcome.action === 'ban') {
        try {
          db.prepare('INSERT OR REPLACE INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)')
            .run(socket.user.id, actorId, reason);

          if (automod.settings().automod_ban_ip === 'true') {
            const { normalizeIp } = require('../clientIp');
            const ips = db.prepare('SELECT ip FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT 3').all(socket.user.id);
            const stmt = db.prepare('INSERT OR REPLACE INTO ip_bans (ip, banned_by, reason) VALUES (?, ?, ?)');
            let banned = 0;
            for (const r of ips) {
              const norm = normalizeIp(r.ip);
              if (!norm) continue;
              stmt.run(norm, actorId, reason);
              banned++;
            }
            if (banned) invalidateIpBanCache();
          }

          for (const [, s] of io.sockets.sockets) {
            if (s.user && s.user.id === socket.user.id) { s.emit('banned', { reason }); s.disconnect(true); }
          }
          for (const [code] of channelUsers) emitOnlineUsers(code);

          logAudit({ actor: socket.user, action: 'automod_ban', target_type: 'user',
            target_id: socket.user.id, target_name: socket.user.displayName,
            details: { strikes: outcome.count, windowHours: outcome.windowHours } });
          console.log(`🛡️  Auto-mod banned "${socket.user.username}" after ${outcome.count} strikes`);
        } catch (err) { console.error('automod ban failed:', err); }
      }
    }

    // Optional mirror into a moderator channel so staff see automod activity
    // without having to open the admin panel.
    function mirrorAutomodToLogChannel(verdict, outcome) {
      const code = (automod.settings().automod_log_channel || '').trim();
      if (!code) return;
      try {
        const ch = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
        if (!ch) return;
        const summary = `🛡️ Blocked ${verdict.rule} from **${socket.user.displayName}**` +
          (verdict.host ? ` — \`${verdict.host}\`` : '') +
          ` (strike ${outcome.count}${outcome.action !== 'none' && outcome.action !== 'warn' ? `, ${outcome.action}` : ''})`;
        const result = db.prepare(
          'INSERT INTO messages (channel_id, user_id, content) VALUES (?, NULL, ?)'
        ).run(ch.id, summary);
        io.to(`channel:${code}`).emit('new-message', {
          channelCode: code,
          message: {
            id: result.lastInsertRowid, content: summary, created_at: new Date().toISOString(),
            username: 'Auto-Mod', user_id: 0, reply_to: null, replyContext: null,
            reactions: [], edited_at: null, system: true
          }
        });
      } catch (err) { console.error('automod log mirror failed:', err); }
    }

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
      // IMPORTANT: scope by channel_id so the bot in the channel where the
      // command was issued handles it. Without this filter, /ping registered
      // on multiple bots in different channels would route to whichever row
      // SQLite returned first (effectively the most-recently-saved bot's
      // callback URL), making per-bot callback URLs behave server-wide. (#5398)
      try {
        const botCmd = db.prepare(`
          SELECT bc.command, bc.description, w.id as webhook_id, w.callback_url, w.callback_secret, w.token, w.name as bot_name
          FROM bot_commands bc
          JOIN webhooks w ON bc.webhook_id = w.id
          WHERE bc.command = ? AND w.channel_id = ? AND w.is_active = 1 AND w.callback_url IS NOT NULL
        `).get(cmd, channelId);
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
          postWebhookCallback(botCmd.callback_url, payload, headers, {
            allowPrivateCallbacks: ALLOW_PRIVATE_CALLBACKS,
            timeoutMs: 10000
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
      userHasPermission, getUserPermissions, getUserGlobalPermissions, getUserRoles, getUserHighestRole, getUserAllRoles, getAdminRoleDisplay,
      // Broadcast helpers
      broadcastChannelLists, broadcastVoiceUsers, emitOnlineUsers,
      getEnrichedChannels, handleVoiceLeave, pruneStaleVoiceUsers,
      broadcastStreamInfo, touchVoiceActivity, rotateChannelCode,
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
      generateChannelCode, generateUniqueSharedCode, generateToken,
      // Flood
      floodCheck,
      // Transfer admin mutex
      transferAdminRef,
      // Audit log
      logAudit,
      // Auto-moderation (v3.42.0)
      automod,
      enforceAutomod,
      // Idle-online oversight (flag accounts sitting connected + green + silent)
      getIdleOnlineUsers,
      onReferrerPolicyChange,
      // Per-member upload storage totals (#5521)
      getUploadUsage,
      // Ban-filtered channel roster used by @mention autocomplete
      getMentionableChannelMembers,
      // IP-ban cache invalidator (server.js HTTP-side cache)
      invalidateIpBanCache,
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
    // Socket.IO hands us why the socket went away, and throwing that away made
    // reconnect loops impossible to diagnose from a server log: every drop
    // looked identical. The reason separates the causes that need completely
    // different fixes -- "ping timeout" means the client stopped answering
    // heartbeats (a backgrounded tab whose timers the browser throttled),
    // "transport close" means something in between cut the connection (a proxy
    // or tunnel idle timeout), and "client namespace disconnect" means the
    // client asked to leave. (#5463)
    socket.on('disconnect', (reason, description) => {
      if (!socket.user) return;
      const detail = description && description.message ? ` (${description.message})` : '';
      console.log(`❌ ${socket.user.username} disconnected [${reason || 'unknown'}]${detail}`);

      // Drop the presence clock once this user's last socket is gone, so a
      // genuine reconnect later starts a fresh "online since". Deferred a beat
      // so socket.io's rapid reconnect blips don't reset it constantly.
      {
        const uid = socket.user.id;
        setTimeout(() => {
          for (const [, s] of io.of('/').sockets) {
            if (s.user && s.user.id === uid) return; // still online elsewhere
          }
          presenceTimers.delete(uid);
        }, 5000);
      }

      // (#5381) Guest cleanup — if this was the last live socket for an
      // ephemeral guest account, delete the users row so the username is
      // freed for the next person. Cascade FKs purge their (mostly empty)
      // chat history. We schedule this slightly after the disconnect so
      // socket.io reconnect blips don't churn the row.
      if (socket.user.isGuest) {
        const guestId = socket.user.id;
        const guestName = socket.user.username;
        setTimeout(() => {
          let stillOnline = false;
          for (const [, s] of io.of('/').sockets) {
            if (s.user && s.user.id === guestId) { stillOnline = true; break; }
          }
          if (stillOnline) return;
          try {
            db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').run(guestId);
            console.log(`👤 guest ${guestName} (id=${guestId}) cleaned up — username freed`);
          } catch (err) {
            console.warn(`[guest-cleanup] failed for ${guestName}:`, err.message);
          }
        }, 5000);
      }

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

      for (const code of Array.from(voiceUsers.keys())) {
        const room = voiceUsers.get(code);
        if (!room) continue;
        const voiceEntry = room.get(socket.user.id);
        if (voiceEntry && voiceEntry.socketId === socket.id) {
          // GRACE PERIOD: socket.io aggressively reconnects within a few
          // hundred ms on transient network blips (Electron renderer
          // suspends, mobile screen sleep, NAT rebind, etc.). Eagerly
          // removing the user here causes the recurring "I vanished from
          // my own voice panel even though I can still talk" bug — the
          // peers' RTCPeerConnections survive (so audio works) but every
          // client wipes the user from their roster and the user is
          // missing until they manually leave and rejoin.
          //
          // Instead, schedule eviction in 4 s. If voice-rejoin or
          // voice-join arrives from the user before the timer fires, we
          // cancel the eviction and just rebind the socketId on the
          // existing entry — peers never see voice-user-left, and the
          // panels never blank.
          const key = `${socket.user.id}:${code}`;
          const existingPending = pendingVoiceLeave.get(key);
          if (existingPending) clearTimeout(existingPending.timer);
          const oldSocketId = socket.id;
          const pending = { timer: null, oldSocketId, code };
          console.log(`[VoiceDiag] disconnect for ${socket.user.username} (id=${socket.user.id}) on ${code} — scheduling 4s grace eviction (oldSocket=${oldSocketId})`);
          pending.timer = setTimeout(() => {
            pendingVoiceLeave.delete(`${socket.user.id}:${pending.code}`);
            const stillRoom = voiceUsers.get(pending.code);
            if (!stillRoom) return;
            const entry = stillRoom.get(socket.user.id);
            if (!entry) return;
            // If the entry's socketId has changed, the user reconnected
            // and rebound — leave them alone.
            if (entry.socketId !== oldSocketId) {
              console.log(`[VoiceDiag] grace eviction skipped — ${socket.user.username} rebound to ${entry.socketId}`);
              return;
            }
            console.log(`[VoiceDiag] grace eviction firing for ${socket.user.username} on ${pending.code} — never reconnected`);
            handleVoiceLeave(socket, pending.code, { softDisconnect: true });
          }, 4000);
          pendingVoiceLeave.set(key, pending);
        } else {
          // Owner-mismatch or no entry: still run a prune pass for this room
          // so any other ghost entries (e.g. from a peer whose disconnect
          // was missed) get cleaned up while we're already iterating.
          // pruneStaleVoiceUsers itself broadcasts voice-user-left for the
          // pruned ids and may delete the code key when the room empties.
          const removed = pruneStaleVoiceUsers(code);
          if (removed.length && voiceUsers.has(code)) broadcastVoiceUsers(code);
        }
      }
    });
  });

  // Handed back so server.js can mount the account-linking HTTP routes against
  // the same engine instance the socket layer is using.
  return { activity };
}

module.exports = { setupSocketHandlers, sanitizeText, sanitizeBorderTransform };
