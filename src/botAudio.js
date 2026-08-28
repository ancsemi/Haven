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
  const isMpegLayer3 = header.length >= 3 &&
    header[0] === 0xff && (header[1] & 0xe0) === 0xe0 &&
    ((header[1] >> 3) & 0x03) !== 0x01 &&
    ((header[1] >> 1) & 0x03) === 0x01 &&
    (header[2] >> 4) !== 0x00 && (header[2] >> 4) !== 0x0f &&
    ((header[2] >> 2) & 0x03) !== 0x03;
  if (isMpegLayer3) {
    return { extension: '.mp3', mime: 'audio/mpeg' };
  }
  return null;
}

async function inspectAudioFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('The uploaded file is empty');
  if (stat.size > MAX_AUDIO_BYTES) throw new Error('Audio must be 10 MB or smaller');

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
    const { parseStream } = await loadMusicMetadata();
    const stream = fs.createReadStream(filePath);
    try {
      // Supplying the already-validated type selects a specific parser and
      // avoids generic container sniffing on attacker-controlled bytes.
      metadata = await parseStream(
        stream,
        { mimeType: format.mime, size: stat.size },
        { duration: true, skipCovers: true }
      );
    } finally {
      stream.destroy();
    }
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

  const container = String(metadata?.format?.container || '');
  const codec = String(metadata?.format?.codec || '');
  const formatMatches =
    (format.extension === '.mp3' && container === 'MPEG' && /Layer 3/i.test(codec)) ||
    (format.extension === '.wav' && container === 'WAVE') ||
    (format.extension === '.ogg' && container === 'Ogg' && codec.length > 0);
  if (!formatMatches) throw new Error('The uploaded file is not valid audio');

  return {
    ...format,
    durationMs: Math.max(1, Math.ceil(durationSeconds * 1000))
  };
}

class BotAudioManager {
  constructor(io, audioDir, options = {}) {
    this.io = io;
    this.audioDir = audioDir;
    this.channels = new Map();
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
    fs.mkdirSync(audioDir, { recursive: true });

    // Queue state is in memory, so files left by an interrupted process can
    // never be resumed safely and must not survive a restart.
    for (const name of fs.readdirSync(audioDir)) {
      try { fs.rmSync(path.join(audioDir, name), { recursive: true, force: true }); } catch {}
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
    const offsetMs = Math.max(0, this.now() - current.startedAt);
    if (offsetMs >= current.durationMs) return null;
    return this._payload(current, offsetMs);
  }

  getPlayable(playbackId, accessToken) {
    if (typeof playbackId !== 'string' || typeof accessToken !== 'string') return null;
    for (const state of this.channels.values()) {
      const current = state.current;
      if (current?.playbackId !== playbackId || current.accessToken !== accessToken) continue;
      if (this.now() >= current.accessExpiresAt) return null;
      return { filePath: current.filePath, mime: current.mime };
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

    return {
      stopped: stoppedCurrent || removed.length > 0,
      removed: removed.length + (stoppedCurrent ? 1 : 0)
    };
  }

  stopWebhook(webhookId) {
    let removed = 0;
    for (const channelCode of Array.from(this.channels.keys())) {
      removed += this.stop(channelCode, webhookId).removed;
    }
    return removed;
  }

  stopChannel(channelCode, reason = 'channel-deleted') {
    const state = this.channels.get(channelCode);
    if (!state) return 0;
    this.channels.delete(channelCode);
    if (state.timer) this.clearTimer(state.timer);
    const entries = [...(state.current ? [state.current] : []), ...state.pending];
    if (state.current) {
      this._emit(channelCode, 'bot-audio-stop', {
        channelCode,
        playbackId: state.current.playbackId,
        reason
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

    if (state.timer) this.clearTimer(state.timer);
    if (state.current) {
      const current = state.current;
      const remainingMs = Math.max(1, current.durationMs - (this.now() - current.startedAt) + 500);
      state.timer = this.setTimer(() => {
        if (state.current?.playbackId === current.playbackId) {
          this._finishCurrent(newCode, state, 'finished', false);
        }
      }, remainingMs);
      state.timer.unref?.();
    }
    return true;
  }

  shutdown() {
    let removed = 0;
    for (const [channelCode, state] of this.channels) {
      if (state.timer) this.clearTimer(state.timer);
      const entries = [...(state.current ? [state.current] : []), ...state.pending];
      removed += entries.length;
      if (state.current) {
        this._emit(channelCode, 'bot-audio-stop', {
          channelCode,
          playbackId: state.current.playbackId,
          reason: 'shutdown'
        });
      }
      for (const entry of entries) {
        try { fs.rmSync(entry.filePath, { force: true }); } catch {}
      }
    }
    this.channels.clear();
    try {
      for (const name of fs.readdirSync(this.audioDir)) {
        fs.rmSync(path.join(this.audioDir, name), { recursive: true, force: true });
      }
    } catch {}
    return removed;
  }

  _startNext(channelCode, state) {
    if (state.current || state.pending.length === 0) {
      this._deleteStateIfEmpty(channelCode, state);
      return;
    }

    const entry = state.pending.shift();
    entry.startedAt = this.now();
    entry.accessExpiresAt = entry.startedAt + entry.durationMs;
    state.current = entry;
    this._emit(channelCode, 'bot-audio-play', this._payload(entry, 0));
    state.timer = this.setTimer(() => {
      if (state.current?.playbackId === entry.playbackId) {
        this._finishCurrent(entry.channelCode, state, 'finished', false);
      }
    }, entry.durationMs + 500);
    state.timer.unref?.();
  }

  _finishCurrent(channelCode, state, reason, notifyClients) {
    const current = state.current;
    if (!current) return;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = null;
    state.current = null;

    if (notifyClients) {
      this._emit(channelCode, 'bot-audio-stop', {
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
      expiresAt: new Date(entry.accessExpiresAt).toISOString(),
      offsetMs
    };
  }

  _emit(channelCode, event, payload) {
    const audience = this.io.to(`voice:${channelCode}`);
    const humans = typeof audience.except === 'function' ? audience.except('bot-sockets') : audience;
    humans.emit(event, payload);
  }

  _deleteStateIfEmpty(channelCode, state) {
    if (!state.current && state.pending.length === 0) this.channels.delete(channelCode);
  }

  _deleteFile(filePath, attempt = 0) {
    fs.promises.unlink(filePath).catch(err => {
      if (err?.code === 'ENOENT' || attempt >= 3) return;
      const timer = this.setTimer(() => this._deleteFile(filePath, attempt + 1), 250 * (attempt + 1));
      timer.unref?.();
    });
  }
}

module.exports = {
  BotAudioManager,
  detectAudioFormat,
  inspectAudioFile,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_QUEUE_ITEMS
};
