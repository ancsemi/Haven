'use strict';

const crypto = require('crypto');
const { isString, isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission,
          resolveSpotifyToYouTube, searchYouTube, fetchYouTubePlaylist, resolveMusicMetadata,
          getActiveMusicSyncState, updateActiveMusicPlaybackState,
          startQueuedMusic, popNextQueuedMusic, isNaturalMusicFinish,
          broadcastMusicQueue, getMusicQueuePayload, sanitizeQueueEntry,
          trimMusicText, stripYouTubePlaylistParam } = ctx;
  const { voiceUsers, activeMusic, musicQueues } = state;

  // ── Share a track ───────────────────────────────────────
  socket.on('music-share', async (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (!isString(data.url, 1, 500)) return;
    if (!/^https?:\/\//i.test(data.url)) return socket.emit('error-msg', 'Invalid URL');
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    const musicChannel = db.prepare('SELECT music_enabled FROM channels WHERE code = ?').get(data.code);
    if (musicChannel && musicChannel.music_enabled === 0 && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'Music sharing is disabled in this channel');
    }

    let playUrl = stripYouTubePlaylistParam(data.url);
    let resolvedFrom = null;
    let title = trimMusicText(data.title, 200);

    const isSpotify = /open\.spotify\.com\/(track|album|playlist|episode|show)\/[a-zA-Z0-9]+/.test(data.url);
    if (isSpotify) {
      const resolved = await resolveSpotifyToYouTube(data.url);
      if (resolved?.url) {
        playUrl = resolved.url;
        resolvedFrom = 'spotify';
        if (!title) title = trimMusicText(resolved.title, 200);
      } else {
        return socket.emit('error-msg', 'Could not resolve Spotify link to YouTube. Try sharing a YouTube link directly.');
      }
    }

    if (!title) {
      const resolvedMeta = await resolveMusicMetadata(playUrl);
      title = trimMusicText(resolvedMeta.title, 200);
    }

    const entry = sanitizeQueueEntry({
      id: crypto.randomBytes(12).toString('hex'),
      url: playUrl,
      title: title || 'Shared track',
      userId: socket.user.id,
      username: socket.user.displayName,
      resolvedFrom
    });
    if (!entry) return;

    if (!activeMusic.get(data.code)) {
      startQueuedMusic(data.code, entry);
      return;
    }

    const queue = musicQueues.get(data.code) || [];
    queue.push(entry);
    musicQueues.set(data.code, queue);
    broadcastMusicQueue(data.code);
    io.to(`voice:${data.code}`).emit('toast', {
      message: `${entry.username} queued ${entry.title}`,
      type: 'info'
    });
  });

  // ── Share a playlist ────────────────────────────────────
  socket.on('music-share-playlist', async (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (!isString(data.playlistId, 1, 200)) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(data.playlistId)) return socket.emit('error-msg', 'Invalid playlist ID');
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

    const musicChannel = db.prepare('SELECT music_enabled FROM channels WHERE code = ?').get(data.code);
    if (musicChannel && musicChannel.music_enabled === 0 && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'Music sharing is disabled in this channel');
    }

    socket.emit('toast', { message: 'Fetching playlist…', type: 'info' });

    const tracks = await fetchYouTubePlaylist(data.playlistId);
    if (!tracks.length) {
      return socket.emit('error-msg', 'Could not fetch playlist or it is empty');
    }

    let addedCount = 0;
    for (const track of tracks) {
      const url = `https://www.youtube.com/watch?v=${track.videoId}`;
      const entry = sanitizeQueueEntry({
        id: crypto.randomBytes(12).toString('hex'),
        url,
        title: trimMusicText(track.title, 200) || 'Untitled track',
        userId: socket.user.id,
        username: socket.user.displayName,
        resolvedFrom: null
      });
      if (!entry) continue;
      if (!activeMusic.get(data.code) && addedCount === 0) {
        startQueuedMusic(data.code, entry);
      } else {
        const queue = musicQueues.get(data.code) || [];
        queue.push(entry);
        musicQueues.set(data.code, queue);
      }
      addedCount++;
    }

    if (addedCount > 0) {
      broadcastMusicQueue(data.code);
      io.to(`voice:${data.code}`).emit('toast', {
        message: `${socket.user.displayName} added ${addedCount} track${addedCount !== 1 ? 's' : ''} from a playlist`,
        type: 'info'
      });
    } else {
      socket.emit('error-msg', 'No playable tracks found in playlist');
    }
  });

  // ── Stop music ──────────────────────────────────────────
  socket.on('music-stop', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const current = activeMusic.get(data.code);
    if (!current) return;
    if (socket.user.id !== current.userId && !socket.user.isAdmin) {
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
      if (!channel || !userHasPermission(socket.user.id, 'manage_music_queue', channel.id)) {
        return socket.emit('error-msg', 'Only the requestor or a moderator can stop playback');
      }
    }
    activeMusic.delete(data.code);
    musicQueues.delete(data.code);
    for (const [uid, user] of voiceRoom) {
      io.to(user.socketId).emit('music-stopped', {
        userId: socket.user.id,
        username: socket.user.displayName,
        channelCode: data.code
      });
    }
    broadcastMusicQueue(data.code);
  });

  // ── Play / pause / next / prev / shuffle control ────────
  socket.on('music-control', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const action = data.action;
    const allowed = ['play', 'pause', 'next', 'prev', 'shuffle'];
    if (!allowed.includes(action)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const current = activeMusic.get(data.code);
    if (!current) return;
    if (socket.user.id !== current.userId && !socket.user.isAdmin) {
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
      if (!channel || !userHasPermission(socket.user.id, 'manage_music_queue', channel.id)) {
        const label = (action === 'play' || action === 'pause') ? 'pause/resume playback' : 'skip tracks';
        return socket.emit('error-msg', `Only the requestor or a moderator can ${label}`);
      }
    }
    const rawPosition = Number(data.positionSeconds);
    const rawDuration = Number(data.durationSeconds);
    const syncState = updateActiveMusicPlaybackState(data.code, {
      isPlaying: action === 'play' ? true : action === 'pause' ? false : undefined,
      positionSeconds: Number.isFinite(rawPosition) ? rawPosition : undefined,
      durationSeconds: Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : undefined
    });
    for (const [uid, user] of voiceRoom) {
      if (uid === socket.user.id) continue;
      io.to(user.socketId).emit('music-control', {
        action,
        userId: socket.user.id,
        username: socket.user.displayName,
        channelCode: data.code,
        syncState
      });
    }
  });

  // ── Seek ────────────────────────────────────────────────
  socket.on('music-seek', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const current = activeMusic.get(data.code);
    if (!current) return;
    if (socket.user.id !== current.userId && !socket.user.isAdmin) {
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
      if (!channel || !userHasPermission(socket.user.id, 'manage_music_queue', channel.id)) {
        return socket.emit('error-msg', 'Only the requestor or a moderator can seek');
      }
    }
    const rawDuration = Number(data.durationSeconds);
    const durationSeconds = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : undefined;
    let positionSeconds = Number(data.positionSeconds);
    if (!Number.isFinite(positionSeconds)) {
      const positionPct = Number(data.position);
      if (!Number.isFinite(positionPct) || positionPct < 0 || positionPct > 100 || !Number.isFinite(durationSeconds)) return;
      positionSeconds = (durationSeconds * positionPct) / 100;
    }
    const syncState = updateActiveMusicPlaybackState(data.code, {
      positionSeconds,
      durationSeconds
    });
    for (const [uid, user] of voiceRoom) {
      if (uid === socket.user.id) continue;
      io.to(user.socketId).emit('music-seek', {
        position: syncState && Number.isFinite(syncState.durationSeconds) && syncState.durationSeconds > 0
          ? (syncState.positionSeconds / syncState.durationSeconds) * 100
          : undefined,
        positionSeconds: syncState ? syncState.positionSeconds : positionSeconds,
        durationSeconds: syncState ? syncState.durationSeconds : (durationSeconds ?? null),
        userId: socket.user.id,
        username: socket.user.displayName,
        channelCode: data.code,
        syncState
      });
    }
  });

  // ── Track finished ──────────────────────────────────────
  socket.on('music-finished', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const current = activeMusic.get(data.code);
    if (!current) return;
    const trackId = trimMusicText(data.trackId, 64);
    if (!trackId || !current.id || trackId !== current.id) return;
    const isPrivileged = socket.user.id === current.userId || socket.user.isAdmin || (() => {
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
      return !!channel && userHasPermission(socket.user.id, 'manage_music_queue', channel.id);
    })();
    if (data.isSkip) {
      if (!isPrivileged) {
        return socket.emit('error-msg', 'Only the requestor or a moderator can skip tracks');
      }
    } else if (!isPrivileged && !isNaturalMusicFinish(current, Number(data.positionSeconds), Number(data.durationSeconds))) {
      return;
    }
    const next = popNextQueuedMusic(data.code);
    if (next) {
      startQueuedMusic(data.code, next);
      return;
    }
    activeMusic.delete(data.code);
    for (const [, user] of voiceRoom) {
      io.to(user.socketId).emit('music-stopped', {
        userId: current.userId,
        username: current.username,
        channelCode: data.code
      });
    }
    broadcastMusicQueue(data.code);
  });

  // ── Queue management ────────────────────────────────────
  socket.on('music-queue-remove', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8) || !isString(data.entryId, 1, 64)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
    if (!channel) return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_music_queue', channel.id)) {
      return socket.emit('error-msg', 'You do not have permission to manage the music queue');
    }
    const queue = musicQueues.get(data.code) || [];
    const nextQueue = queue.filter(item => item.id !== data.entryId);
    if (nextQueue.length > 0) musicQueues.set(data.code, nextQueue);
    else musicQueues.delete(data.code);
    broadcastMusicQueue(data.code);
  });

  socket.on('music-queue-reorder', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8) || !Array.isArray(data.entryIds)) return;
    if (data.entryIds.length > 200) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
    if (!channel) return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_music_queue', channel.id)) {
      return socket.emit('error-msg', 'You do not have permission to manage the music queue');
    }
    const queue = musicQueues.get(data.code) || [];
    if (queue.length < 2) return;
    const byId = new Map(queue.map(item => [item.id, item]));
    const reordered = [];
    for (const entryId of data.entryIds.map(id => trimMusicText(id, 64))) {
      const item = byId.get(entryId);
      if (item) reordered.push(item);
    }
    if (reordered.length !== queue.length) return;
    musicQueues.set(data.code, reordered);
    broadcastMusicQueue(data.code);
  });

  socket.on('music-queue-shuffle', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    const voiceRoom = voiceUsers.get(data.code);
    if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
    if (!channel) return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_music_queue', channel.id)) {
      return socket.emit('error-msg', 'You do not have permission to manage the music queue');
    }
    const queue = musicQueues.get(data.code) || [];
    if (queue.length < 2) return;
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    musicQueues.set(data.code, queue);
    broadcastMusicQueue(data.code);
  });

  // ── Search ──────────────────────────────────────────────
  socket.on('music-search', async (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.query, 1, 200)) return;
    const offset = isInt(data.offset) && data.offset >= 0 ? data.offset : 0;

    try {
      const results = await searchYouTube(data.query, 5, offset);
      socket.emit('music-search-results', {
        results,
        query: data.query,
        offset
      });
    } catch {
      socket.emit('music-search-results', { results: [], query: data.query, offset });
    }
  });
};
