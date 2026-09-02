'use strict';

function persistChannelCodeRotation(db, channelId, oldCode, newCode) {
  if (oldCode === newCode) throw new Error('New channel code must differ from the current code');
  const rotate = db.transaction(() => {
    const result = db.prepare(`
      UPDATE channels
      SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP
      WHERE id = ? AND code = ?
    `).run(newCode, channelId, oldCode);
    if (result.changes !== 1) throw new Error('Channel code changed before rotation completed');
    db.prepare('UPDATE channels SET afk_sub_code = ? WHERE afk_sub_code = ?').run(newCode, oldCode);
    db.prepare(`
      UPDATE user_channel_prefs
      SET channel_code = ?, updated_at = CURRENT_TIMESTAMP
      WHERE channel_code = ?
    `).run(newCode, oldCode);
    return db.prepare(`
      UPDATE server_settings
      SET value = ?
      WHERE key = 'automod_log_channel' AND value = ?
    `).run(newCode, oldCode).changes > 0;
  });
  return rotate();
}

function channelCodeTaken(db, code) {
  if (db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code)) return true;
  const settings = db.prepare("SELECT value FROM server_settings WHERE key IN ('server_code', 'vanity_code')").all();
  if (settings.some(row => row.value && row.value === code)) return true;
  return !!db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code);
}

function generateUniqueChannelCode(db, generateCode, oldCode, maxAttempts = 64) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateCode();
    if (/^[a-f0-9]{8}$/i.test(candidate) && candidate !== oldCode && !channelCodeTaken(db, candidate)) return candidate;
  }
  throw new Error('Unable to generate a unique channel code');
}

function schedulePendingVoiceLeave({
  pendingVoiceLeave,
  voiceUsers,
  socket,
  userId,
  code,
  oldSocketId,
  handleVoiceLeave,
  delay = 4000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console.log
}) {
  const key = `${userId}:${code}`;
  const existing = pendingVoiceLeave.get(key);
  if (existing) clearTimer(existing.timer);
  const pending = { timer: null, oldSocketId, code };
  pending.timer = setTimer(() => {
    pendingVoiceLeave.delete(`${userId}:${pending.code}`);
    const room = voiceUsers.get(pending.code);
    if (!room) return;
    const entry = room.get(userId);
    if (!entry) return;
    if (entry.socketId !== oldSocketId) {
      log(`[VoiceDiag] grace eviction skipped — ${socket.user.username} rebound to ${entry.socketId}`);
      return;
    }
    log(`[VoiceDiag] grace eviction firing for ${socket.user.username} on ${pending.code} — never reconnected`);
    handleVoiceLeave(socket, pending.code, { softDisconnect: true });
  }, delay);
  pendingVoiceLeave.set(key, pending);
  return pending;
}

function createTempChannelDeleteCallback({ db, io, state, channelId, log = console.log, warn = console.warn }) {
  const { channelUsers, voiceUsers, pendingTempDelete } = state;
  return () => {
    let code = null;
    try {
      const channel = db.prepare('SELECT id, code, is_temp_voice FROM channels WHERE id = ?').get(channelId);
      if (!channel) return false;
      code = channel.code;
      if (!channel.is_temp_voice) {
        pendingTempDelete.delete(code);
        return false;
      }
      const currentRoom = voiceUsers.get(code);
      if (currentRoom?.size > 0) {
        pendingTempDelete.delete(code);
        return false;
      }
      db.transaction(() => {
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(channel.id);
        db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(channel.id);
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channel.id);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channel.id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
      })();
      state.botAudioManager?.stopChannel(code, 'channel-deleted');
      channelUsers.delete(code);
      voiceUsers.delete(code);
      pendingTempDelete.delete(code);
      const audience = typeof io.except === 'function' ? io.except('bot-sockets') : io;
      audience.emit('channel-deleted', { code, reason: 'temp-empty' });
      log(`[Temporary] Temp voice channel "${code}" deleted (everyone left)`);
      return true;
    } catch (err) {
      if (code) pendingTempDelete.delete(code);
      warn(`[Temporary] Failed to delete temp voice channel ${channelId}:`, err.message);
      return false;
    }
  };
}

function migrateMapKey(map, oldCode, newCode) {
  if (oldCode === newCode || !map?.has(oldCode)) return;
  map.set(newCode, map.get(oldCode));
  map.delete(oldCode);
}

function rotateLiveChannelState(io, state, channelId, oldCode, newCode) {
  if (oldCode === newCode) throw new Error('New channel code must differ from the current code');
  const oldRoom = `channel:${oldCode}`;
  const newRoom = `channel:${newCode}`;
  const textSockets = io.sockets.adapter.rooms.get(oldRoom);
  if (textSockets) {
    for (const socketId of [...textSockets]) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.leave(oldRoom);
      socket.join(newRoom);
      if (socket.currentChannel === oldCode) socket.currentChannel = newCode;
    }
  }

  const oldVoiceRoom = `voice:${oldCode}`;
  const newVoiceRoom = `voice:${newCode}`;
  const voiceSockets = io.sockets.adapter.rooms.get(oldVoiceRoom);
  const movedVoiceSocketIds = new Set(voiceSockets || []);
  if (voiceSockets) {
    for (const socketId of [...voiceSockets]) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.leave(oldVoiceRoom);
      socket.join(newVoiceRoom);
    }
  }

  const rotation = { channelId, oldCode, newCode };
  for (const [socketId, socket] of io.sockets.sockets) {
    if (!socket.user?.isBot) continue;
    const currentCodeRotated = socket.user.channelCode === oldCode;
    const assignedChannelRotated = socket.user.channelId === channelId;
    if (currentCodeRotated) socket.user.channelCode = newCode;
    if ((currentCodeRotated || assignedChannelRotated) && !movedVoiceSocketIds.has(socketId)) {
      socket.emit('channel-code-rotated', rotation);
    }
  }

  for (const map of [
    state.channelUsers,
    state.voiceUsers,
    state.activeMusic,
    state.musicQueues,
    state.activeScreenSharers,
    state.activeWebcamUsers
  ]) migrateMapKey(map, oldCode, newCode);

  for (const [key, viewers] of Array.from(state.streamViewers.entries())) {
    if (!key.startsWith(`${oldCode}:`)) continue;
    state.streamViewers.delete(key);
    state.streamViewers.set(`${newCode}:${key.slice(oldCode.length + 1)}`, viewers);
  }

  for (const [key, pending] of Array.from(state.pendingVoiceLeave.entries())) {
    if (!key.endsWith(`:${oldCode}`)) continue;
    const userId = key.slice(0, -(oldCode.length + 1));
    state.pendingVoiceLeave.delete(key);
    pending.code = newCode;
    state.pendingVoiceLeave.set(`${userId}:${newCode}`, pending);
  }

  if (state.pendingTempDelete.has(oldCode)) {
    const timer = state.pendingTempDelete.get(oldCode);
    state.pendingTempDelete.delete(oldCode);
    state.pendingTempDelete.set(newCode, timer);
  }

  state.botAudioManager?.renameChannel(oldCode, newCode);
  io.to(newRoom).to(newVoiceRoom).emit('channel-code-rotated', rotation);
}

module.exports = {
  createTempChannelDeleteCallback,
  generateUniqueChannelCode,
  persistChannelCodeRotation,
  rotateLiveChannelState,
  schedulePendingVoiceLeave
};
