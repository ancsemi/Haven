'use strict';

function persistChannelCodeRotation(db, channelId, oldCode, newCode) {
  const rotate = db.transaction(() => {
    db.prepare(`
      UPDATE channels
      SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP
      WHERE id = ? AND code = ?
    `).run(newCode, channelId, oldCode);
    db.prepare('UPDATE channels SET afk_sub_code = ? WHERE afk_sub_code = ?').run(newCode, oldCode);
    db.prepare('UPDATE user_channel_prefs SET channel_code = ? WHERE channel_code = ?').run(newCode, oldCode);
  });
  rotate();
}

function rotateLiveChannelState(io, state, botAudioManager, channelId, oldCode, newCode) {
  const {
    channelUsers, voiceUsers, activeMusic, musicQueues,
    activeScreenSharers, activeWebcamUsers, streamViewers, pendingVoiceLeave, pendingTempDelete
  } = state;
  const oldRoom = `channel:${oldCode}`;
  const newRoom = `channel:${newCode}`;
  const textSockets = io.sockets.adapter.rooms.get(oldRoom);
  if (textSockets) {
    for (const sid of [...textSockets]) {
      const connectedSocket = io.sockets.sockets.get(sid);
      if (!connectedSocket) continue;
      connectedSocket.leave(oldRoom);
      connectedSocket.join(newRoom);
      if (connectedSocket.currentChannel === oldCode) connectedSocket.currentChannel = newCode;
    }
  }
  if (channelUsers.has(oldCode)) {
    channelUsers.set(newCode, channelUsers.get(oldCode));
    channelUsers.delete(oldCode);
  }

  const oldVoiceRoom = `voice:${oldCode}`;
  const newVoiceRoom = `voice:${newCode}`;
  const voiceSockets = io.sockets.adapter.rooms.get(oldVoiceRoom);
  if (voiceSockets) {
    for (const sid of [...voiceSockets]) {
      const connectedSocket = io.sockets.sockets.get(sid);
      if (!connectedSocket) continue;
      connectedSocket.leave(oldVoiceRoom);
      connectedSocket.join(newVoiceRoom);
      if (connectedSocket.user?.isBot && connectedSocket.user.channelCode === oldCode) {
        connectedSocket.user.channelCode = newCode;
      }
    }
  }

  const roomRecipients = new Set([...(textSockets || []), ...(voiceSockets || [])]);
  for (const [sid, connectedSocket] of io.sockets.sockets) {
    if (!connectedSocket.user?.isBot || connectedSocket.user.channelId !== channelId) continue;
    if (connectedSocket.user.channelCode === oldCode) connectedSocket.user.channelCode = newCode;
    if (!roomRecipients.has(sid)) {
      connectedSocket.emit('channel-code-rotated', { channelId, oldCode, newCode });
    }
  }

  const migrateMap = map => {
    if (!map.has(oldCode)) return;
    map.set(newCode, map.get(oldCode));
    map.delete(oldCode);
  };
  migrateMap(voiceUsers);
  migrateMap(activeMusic);
  migrateMap(musicQueues);
  migrateMap(activeScreenSharers);
  migrateMap(activeWebcamUsers);

  for (const [key, viewers] of Array.from(streamViewers.entries())) {
    if (!key.startsWith(`${oldCode}:`)) continue;
    streamViewers.delete(key);
    streamViewers.set(`${newCode}:${key.slice(oldCode.length + 1)}`, viewers);
  }
  for (const [key, pending] of Array.from(pendingVoiceLeave.entries())) {
    if (!key.endsWith(`:${oldCode}`)) continue;
    const userId = key.slice(0, -(oldCode.length + 1));
    pendingVoiceLeave.delete(key);
    pending.code = newCode;
    pendingVoiceLeave.set(`${userId}:${newCode}`, pending);
  }
  if (pendingTempDelete.has(oldCode)) {
    const pending = pendingTempDelete.get(oldCode);
    pendingTempDelete.delete(oldCode);
    pending.code = newCode;
    pendingTempDelete.set(newCode, pending);
  }

  botAudioManager?.renameChannel(oldCode, newCode);
  io.to(newRoom).to(newVoiceRoom).emit('channel-code-rotated', { channelId, oldCode, newCode });
}

module.exports = { persistChannelCodeRotation, rotateLiveChannelState };
