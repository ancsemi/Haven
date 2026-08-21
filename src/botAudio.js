'use strict';

const fs = require('fs');
const path = require('path');

let musicMetadataPromise;
function loadMusicMetadata() {
  if (!musicMetadataPromise) musicMetadataPromise = import('music-metadata');
  return musicMetadataPromise;
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 5 * 60;
const MAX_AUDIO_QUEUE_ITEMS = 25;

function detectAudioFormat(header) {
  if (!Buffer.isBuffer(header)) return null;
  if (header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') {
    return { extension: '.wav', mime: 'audio/wav' };
  }
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'OggS') {
    return { extension: '.ogg', mime: 'audio/ogg' };
  }
  if (header.length >= 3 && header.toString('ascii', 0, 3) === 'ID3') {
    return { extension: '.mp3', mime: 'audio/mpeg' };
  }
  if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) {
    return { extension: '.mp3', mime: 'audio/mpeg' };
  }
  return null;
}

async function inspectAudioFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  let header;
  try {
    header = Buffer.alloc(12);
    const result = await handle.read(header, 0, header.length, 0);
    header = header.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }

  const format = detectAudioFormat(header);
  if (!format) throw new Error('Only valid MP3, WAV, or OGG audio is allowed');

  let metadata;
  try {
    const { parseFile } = await loadMusicMetadata();
    metadata = await parseFile(filePath, { duration: true, skipCovers: true });
  } catch {
    throw new Error('The uploaded file is not valid audio');
  }

  const durationSeconds = Number(metadata?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Could not determine audio duration');
  }
  if (durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error(`Audio must be ${MAX_AUDIO_DURATION_SECONDS} seconds or shorter`);
  }

  return {
    ...format,
    durationMs: Math.max(1, Math.ceil(durationSeconds * 1000))
  };
}

class BotAudioManager {
  constructor(io, audioDir) {
    this.io = io;
    this.audioDir = audioDir;
    this.channels = new Map();
    fs.mkdirSync(audioDir, { recursive: true });

    // Bot audio is intentionally temporary. Anything left here is from an
    // interrupted server process and is no longer referenced by a live queue.
    for (const name of fs.readdirSync(audioDir)) {
      try {
        const filePath = path.join(audioDir, name);
        if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
      } catch {}
    }
  }

  enqueue(entry) {
    let state = this.channels.get(entry.channelCode);
    if (!state) {
      state = { current: null, pending: [], timer: null };
      this.channels.set(entry.channelCode, state);
    }

    let ownedCount = 0;
    for (const channelState of this.channels.values()) {
      ownedCount += channelState.pending.filter(item => item.webhookId === entry.webhookId).length;
      if (channelState.current?.webhookId === entry.webhookId) ownedCount++;
    }
    if (ownedCount >= MAX_AUDIO_QUEUE_ITEMS) {
      if (!state.current && state.pending.length === 0) this.channels.delete(entry.channelCode);
      return { error: `Audio queue is full (max ${MAX_AUDIO_QUEUE_ITEMS} items per bot)` };
    }

    state.pending.push(entry);
    if (!state.current) this._startNext(entry.channelCode, state);

    const isCurrent = state.current?.playbackId === entry.playbackId;
    const pendingIndex = state.pending.findIndex(item => item.playbackId === entry.playbackId);
    return {
      playbackId: entry.playbackId,
      position: isCurrent ? 0 : pendingIndex + 1,
      queued: !isCurrent
    };
  }

  getCurrent(channelCode) {
    const current = this.channels.get(channelCode)?.current;
    if (!current) return null;
    const offsetMs = Math.max(0, Date.now() - current.startedAt);
    if (offsetMs >= current.durationMs) return null;
    return this._payload(current, offsetMs);
  }

  getPlayable(playbackId, accessToken) {
    if (typeof playbackId !== 'string' || typeof accessToken !== 'string') return null;
    for (const state of this.channels.values()) {
      const current = state.current;
      if (current?.playbackId === playbackId && current.accessToken === accessToken) {
        return { filePath: current.filePath, mime: current.mime };
      }
    }
    return null;
  }

  skip(channelCode, webhookId) {
    const state = this.channels.get(channelCode);
    if (!state) return { skipped: false };

    if (state.current?.webhookId === webhookId) {
      const playbackId = state.current.playbackId;
      this._finishCurrent(channelCode, state, 'skipped', true);
      return { skipped: true, playbackId, current: true };
    }

    const index = state.pending.findIndex(item => item.webhookId === webhookId);
    if (index === -1) return { skipped: false };
    const [entry] = state.pending.splice(index, 1);
    this._deleteFile(entry.filePath);
    this._deleteStateIfEmpty(channelCode, state);
    return { skipped: true, playbackId: entry.playbackId, current: false };
  }

  stop(channelCode, webhookId) {
    const state = this.channels.get(channelCode);
    if (!state) return { stopped: false, removed: 0 };

    const removed = state.pending.filter(item => item.webhookId === webhookId);
    state.pending = state.pending.filter(item => item.webhookId !== webhookId);
    for (const entry of removed) this._deleteFile(entry.filePath);

    let stoppedCurrent = false;
    if (state.current?.webhookId === webhookId) {
      stoppedCurrent = true;
      this._finishCurrent(channelCode, state, 'stopped', true);
    } else {
      this._deleteStateIfEmpty(channelCode, state);
    }

    return { stopped: stoppedCurrent || removed.length > 0, removed: removed.length + (stoppedCurrent ? 1 : 0) };
  }

  stopWebhook(webhookId) {
    let removed = 0;
    for (const channelCode of Array.from(this.channels.keys())) {
      removed += this.stop(channelCode, webhookId).removed;
    }
    return removed;
  }

  stopChannel(channelCode) {
    const state = this.channels.get(channelCode);
    if (!state) return 0;
    this.channels.delete(channelCode);
    if (state.timer) clearTimeout(state.timer);
    const entries = [...(state.current ? [state.current] : []), ...state.pending];
    if (state.current) {
      this.io.to(`voice:${channelCode}`).emit('bot-audio-stop', {
        channelCode,
        playbackId: state.current.playbackId,
        reason: 'channel-deleted'
      });
    }
    for (const entry of entries) this._deleteFile(entry.filePath);
    return entries.length;
  }

  getScopes() {
    const scopes = [];
    for (const [channelCode, state] of this.channels) {
      const webhookIds = new Set();
      if (state.current) webhookIds.add(state.current.webhookId);
      for (const entry of state.pending) webhookIds.add(entry.webhookId);
      for (const webhookId of webhookIds) scopes.push({ webhookId, channelCode });
    }
    return scopes;
  }

  renameChannel(oldCode, newCode) {
    if (oldCode === newCode || !this.channels.has(oldCode) || this.channels.has(newCode)) return false;
    const state = this.channels.get(oldCode);
    this.channels.delete(oldCode);
    this.channels.set(newCode, state);
    if (state.current) state.current.channelCode = newCode;
    for (const entry of state.pending) entry.channelCode = newCode;

    // The current timer closed over the old room name. Re-arm it against the
    // new code without replaying audio that clients are already hearing.
    if (state.timer) clearTimeout(state.timer);
    if (state.current) {
      const current = state.current;
      const remainingMs = Math.max(1, current.durationMs - (Date.now() - current.startedAt) + 500);
      state.timer = setTimeout(() => {
        if (state.current?.playbackId === current.playbackId) {
          this._finishCurrent(newCode, state, 'finished', false);
        }
      }, remainingMs);
      state.timer.unref?.();
    }
    return true;
  }

  _startNext(channelCode, state) {
    if (state.current || state.pending.length === 0) {
      this._deleteStateIfEmpty(channelCode, state);
      return;
    }

    const entry = state.pending.shift();
    entry.startedAt = Date.now();
    state.current = entry;
    this.io.to(`voice:${channelCode}`).emit('bot-audio-play', this._payload(entry, 0));
    state.timer = setTimeout(() => {
      if (state.current?.playbackId === entry.playbackId) {
        this._finishCurrent(channelCode, state, 'finished', false);
      }
    }, entry.durationMs + 500);
    state.timer.unref?.();
  }

  _finishCurrent(channelCode, state, reason, notifyClients) {
    const current = state.current;
    if (!current) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.current = null;

    if (notifyClients) {
      this.io.to(`voice:${channelCode}`).emit('bot-audio-stop', {
        channelCode,
        playbackId: current.playbackId,
        reason
      });
    }

    this._deleteFile(current.filePath);
    this._startNext(channelCode, state);
  }

  _payload(entry, offsetMs) {
    return {
      playbackId: entry.playbackId,
      channelCode: entry.channelCode,
      audioUrl: entry.audioUrl,
      botName: entry.botName,
      durationMs: entry.durationMs,
      startedAt: new Date(entry.startedAt).toISOString(),
      offsetMs
    };
  }

  _deleteStateIfEmpty(channelCode, state) {
    if (!state.current && state.pending.length === 0) this.channels.delete(channelCode);
  }

  _deleteFile(filePath, attempt = 0) {
    fs.promises.unlink(filePath).catch(err => {
      if (err?.code === 'ENOENT' || attempt >= 3) return;
      const timer = setTimeout(() => this._deleteFile(filePath, attempt + 1), 250 * (attempt + 1));
      timer.unref?.();
    });
  }
}

module.exports = {
  BotAudioManager,
  inspectAudioFile,
  detectAudioFormat,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_QUEUE_ITEMS
};
