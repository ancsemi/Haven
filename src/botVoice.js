'use strict';

function getAccessibleVoiceChannels(db, webhook) {
  if (!webhook) return [];
  const creator = webhook.created_by
    ? db.prepare('SELECT is_admin FROM users WHERE id = ?').get(webhook.created_by)
    : null;

  if (creator?.is_admin) {
    return db.prepare(`
      SELECT id, code, name, voice_enabled, soundboard_enabled, voice_user_limit, voice_bitrate
      FROM channels
      WHERE is_dm = 0
      ORDER BY position ASC, id ASC
    `).all();
  }

  return db.prepare(`
    SELECT DISTINCT c.id, c.code, c.name, c.voice_enabled, c.soundboard_enabled, c.voice_user_limit, c.voice_bitrate
    FROM channels c
    LEFT JOIN channel_members cm
      ON cm.channel_id = c.id AND cm.user_id = ?
    WHERE c.is_dm = 0 AND (c.id = ? OR cm.user_id IS NOT NULL)
    ORDER BY c.position ASC, c.id ASC
  `).all(webhook.created_by || -1, webhook.channel_id);
}

function canAccessVoiceChannel(db, webhook, channelCode) {
  return getAccessibleVoiceChannels(db, webhook).find(channel => channel.code === channelCode) || null;
}

function getBotVoiceAccessFailure(db, webhookId, channelCodes = []) {
  const webhook = db.prepare(`
    SELECT w.id, w.name, w.channel_id, w.created_by, w.can_use_voice,
           c.code AS channel_code
    FROM webhooks w
    JOIN channels c ON c.id = w.channel_id
    WHERE w.id = ? AND w.is_active = 1
  `).get(webhookId);
  if (!webhook) return 'Webhook was deleted or disabled';
  if (!webhook.can_use_voice) return 'Bot voice permission was revoked';
  for (const code of channelCodes) {
    const channel = canAccessVoiceChannel(db, webhook, code);
    if (!channel) return 'Bot no longer has access to this channel';
    if (channel.voice_enabled === 0) return 'Voice was disabled in this channel';
  }
  return null;
}

function registerBotVoiceSocket(socket, ctx) {
  const { io, db, state, broadcastVoiceUsers, handleVoiceLeave } = ctx;
  const { voiceUsers, voiceLastActivity } = state;
  const MAX_SDP_SIZE = 16384;
  const MAX_ICE_SIZE = 2048;
  let eventWindowStartedAt = Date.now();
  let eventCount = 0;

  socket.emit('bot-session', {
    id: socket.user.id,
    webhookId: socket.user.webhookId,
    username: socket.user.displayName,
    channelCode: socket.user.channelCode
  });

  socket.use((packet, next) => {
    const now = Date.now();
    if (now - eventWindowStartedAt >= 10000) {
      eventWindowStartedAt = now;
      eventCount = 0;
    }
    eventCount++;
    if (eventCount > 300) return next(new Error('Bot voice event rate limit exceeded'));
    const webhook = currentWebhook();
    if (!webhook || !webhook.can_use_voice) {
      disconnectRevoked('Bot voice permission was revoked');
      return next(new Error('Bot voice permission is disabled'));
    }
    next();
  });

  function currentWebhook() {
    return db.prepare(`
      SELECT id, name, channel_id, created_by, can_use_voice
      FROM webhooks
      WHERE id = ? AND is_active = 1
    `).get(socket.user.webhookId);
  }

  function disconnectRevoked(reason) {
    for (const [code, room] of Array.from(voiceUsers.entries())) {
      if (room.get(socket.user.id)?.socketId === socket.id) handleVoiceLeave(socket, code);
    }
    socket.emit('voice-kicked', { channelCode: socket.user.channelCode, reason });
    socket.disconnect(true);
  }

  socket.on('voice-join', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const webhook = currentWebhook();
    if (!webhook || !webhook.can_use_voice) return cb({ error: 'Bot voice permission is disabled' });

    const requestedCode = typeof data?.code === 'string' ? data.code.trim() : socket.user.channelCode;
    if (!/^[a-f0-9]{8}$/i.test(requestedCode)) return cb({ error: 'Invalid channel code' });
    const channel = canAccessVoiceChannel(db, webhook, requestedCode);
    if (!channel) return cb({ error: 'Bot cannot access this voice channel' });
    if (channel.voice_enabled === 0) return cb({ error: 'Voice is disabled in this channel' });

    if (!voiceUsers.has(requestedCode)) voiceUsers.set(requestedCode, new Map());
    const room = voiceUsers.get(requestedCode);
    const currentCount = room.size - (room.has(socket.user.id) ? 1 : 0);
    if (channel.voice_user_limit > 0 && currentCount >= channel.voice_user_limit) {
      return cb({ error: `Voice is full (${currentCount}/${channel.voice_user_limit})` });
    }

    for (const [previousCode, previousRoom] of voiceUsers) {
      if (previousRoom.get(socket.user.id)?.socketId === socket.id && previousCode !== requestedCode) {
        handleVoiceLeave(socket, previousCode);
      }
    }

    const existingEntry = room.get(socket.user.id);
    let replacedSocket = null;
    if (existingEntry && existingEntry.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingEntry.socketId);
      if (oldSocket) {
        // Rebind atomically. Removing the only entry first would make a
        // temporary channel look empty and trigger its deletion.
        oldSocket.leave(`voice:${requestedCode}`);
        replacedSocket = oldSocket;
      }
    }

    if (!voiceUsers.has(requestedCode)) voiceUsers.set(requestedCode, new Map());
    const activeRoom = voiceUsers.get(requestedCode);
    const existingUsers = Array.from(activeRoom.values()).filter(user => user.id !== socket.user.id);
    socket.join(`voice:${requestedCode}`);
    socket.user.channelCode = requestedCode;
    activeRoom.set(socket.user.id, {
      id: socket.user.id,
      username: socket.user.displayName,
      socketId: socket.id,
      isMuted: false,
      isDeafened: false,
      isBot: true,
      isListening: true
    });
    voiceLastActivity.set(socket.user.id, Date.now());
    if (replacedSocket) {
      replacedSocket.emit('voice-kicked', { channelCode: requestedCode, reason: 'Bot connected from another process' });
      replacedSocket.disconnect(true);
    }

    socket.emit('voice-existing-users', {
      channelCode: requestedCode,
      users: existingUsers.map(user => ({
        id: user.id,
        username: user.username,
        isBot: !!user.isBot,
        isListening: !!user.isListening
      })),
      voiceBitrate: channel.voice_bitrate || 0
    });

    if (!existingEntry) {
      for (const user of existingUsers) {
        io.to(user.socketId).emit('voice-user-joined', {
          channelCode: requestedCode,
          user: {
            id: socket.user.id,
            username: socket.user.displayName,
            isBot: true,
            isListening: true
          }
        });
      }
    }

    broadcastVoiceUsers(requestedCode);
    cb({ success: true, channelCode: requestedCode, botUserId: socket.user.id });
  });

  function relaySignal(data, field, maxSize, eventName) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.code !== 'string' || !/^[a-f0-9]{8}$/i.test(data.code)) return;
    if (!Number.isInteger(data.targetUserId)) return;
    if (voiceUsers.get(data.code)?.get(socket.user.id)?.socketId !== socket.id) return;
    if (data[field] && (typeof data[field] !== 'object' || JSON.stringify(data[field]).length > maxSize)) return;
    const target = voiceUsers.get(data.code)?.get(data.targetUserId);
    if (!target || target.id === socket.user.id) return;
    io.to(target.socketId).emit(eventName, {
      from: { id: socket.user.id, username: socket.user.displayName, isBot: true },
      [field]: data[field] || null,
      channelCode: data.code
    });
  }

  socket.on('voice-offer', data => relaySignal(data, 'offer', MAX_SDP_SIZE, 'voice-offer'));
  socket.on('voice-answer', data => relaySignal(data, 'answer', MAX_SDP_SIZE, 'voice-answer'));
  socket.on('voice-ice-candidate', data => relaySignal(data, 'candidate', MAX_ICE_SIZE, 'voice-ice-candidate'));

  socket.on('voice-mute-state', data => {
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    const entry = voiceUsers.get(code)?.get(socket.user.id);
    if (!entry || entry.socketId !== socket.id) return;
    entry.isMuted = !!data.muted;
    broadcastVoiceUsers(code);
  });

  socket.on('voice-speaking', data => {
    for (const [code, room] of voiceUsers) {
      if (room.get(socket.user.id)?.socketId !== socket.id) continue;
      if (data?.speaking) voiceLastActivity.set(socket.user.id, Date.now());
      io.to(`voice:${code}`).emit('voice-speaking', {
        userId: socket.user.id,
        speaking: !!data?.speaking
      });
      break;
    }
  });

  socket.on('voice-activity', () => {
    for (const room of voiceUsers.values()) {
      if (room.get(socket.user.id)?.socketId !== socket.id) continue;
      voiceLastActivity.set(socket.user.id, Date.now());
      break;
    }
  });

  socket.on('voice-leave', (data, callback) => {
    const code = typeof data?.code === 'string' ? data.code.trim() : socket.user.channelCode;
    if (/^[a-f0-9]{8}$/i.test(code) && voiceUsers.get(code)?.get(socket.user.id)?.socketId === socket.id) {
      handleVoiceLeave(socket, code);
    }
    if (typeof callback === 'function') callback({ success: true });
  });

  socket.on('disconnect', () => {
    for (const [code, room] of voiceUsers) {
      if (room.get(socket.user.id)?.socketId === socket.id) handleVoiceLeave(socket, code);
    }
  });
}

module.exports = {
  getAccessibleVoiceChannels,
  canAccessVoiceChannel,
  getBotVoiceAccessFailure,
  registerBotVoiceSocket
};
