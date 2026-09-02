'use strict';

const BOT_SOCKET_ROOM = 'bot-sockets';

function getAccessibleVoiceChannels(db, webhook) {
  if (!webhook) return [];
  const creator = webhook.created_by
    ? db.prepare('SELECT is_admin FROM users WHERE id = ?').get(webhook.created_by)
    : null;

  if (creator?.is_admin) {
    return db.prepare(`
      SELECT id, code, name, voice_enabled, voice_user_limit, voice_bitrate
      FROM channels
      WHERE is_dm = 0
      ORDER BY position ASC, id ASC
    `).all();
  }

  return db.prepare(`
    SELECT DISTINCT c.id, c.code, c.name, c.voice_enabled, c.voice_user_limit, c.voice_bitrate
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

function getBotVoiceWebhookByToken(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return null;
  return db.prepare(`
    SELECT w.id, w.name, w.token, w.channel_id, w.created_by, w.can_use_voice,
           c.code AS channel_code
    FROM webhooks w
    JOIN channels c ON c.id = w.channel_id
    WHERE w.token = ? AND w.is_active = 1
  `).get(token) || null;
}

function getActiveBotVoiceWebhook(db, webhookId) {
  return db.prepare(`
    SELECT w.id, w.name, w.token, w.channel_id, w.created_by, w.can_use_voice,
           c.code AS channel_code
    FROM webhooks w
    JOIN channels c ON c.id = w.channel_id
    WHERE w.id = ? AND w.is_active = 1
  `).get(webhookId) || null;
}

function getBotVoiceAccessFailure(db, webhookId, channelCodes = [], expectedToken = null) {
  const webhook = getActiveBotVoiceWebhook(db, webhookId);
  if (!webhook) return 'Webhook was deleted or disabled';
  if (expectedToken && webhook.token !== expectedToken) return 'Bot token was rotated';
  if (!webhook.can_use_voice) return 'Bot voice permission was revoked';
  for (const code of channelCodes) {
    const channel = canAccessVoiceChannel(db, webhook, code);
    if (!channel) return 'Bot no longer has access to this channel';
    if (channel.voice_enabled === 0) return 'Voice was disabled in this channel';
  }
  return null;
}

function getSocketVoiceChannelCodes(socket) {
  const codes = new Set();
  for (const room of socket.rooms || []) {
    if (typeof room === 'string' && room.startsWith('voice:')) codes.add(room.slice(6));
  }
  return codes;
}

function disconnectBotVoiceSocket(socket, ctx, reason) {
  const { state, handleVoiceLeave } = ctx;
  for (const [code, room] of Array.from(state.voiceUsers.entries())) {
    if (room.get(socket.user.id)?.socketId === socket.id) handleVoiceLeave(socket, code);
  }
  socket.emit('voice-kicked', { channelCode: socket.user.channelCode, reason });
  socket.disconnect(true);
}

function disconnectDuplicateBotSockets(socket, ctx) {
  let disconnected = 0;
  for (const [, existing] of Array.from(ctx.io.sockets.sockets.entries())) {
    if (existing.id === socket.id || !existing.user?.isBot) continue;
    if (existing.user.webhookId !== socket.user.webhookId) continue;
    disconnectBotVoiceSocket(existing, ctx, 'Bot connected from another process');
    disconnected++;
  }
  return disconnected;
}

function isolateBotVoiceSocket(socket) {
  socket.join(BOT_SOCKET_ROOM);
  const join = socket.join.bind(socket);
  socket.join = rooms => {
    const requested = Array.isArray(rooms) ? rooms : [rooms];
    const allowed = requested.filter(room => typeof room === 'string' && room.startsWith('voice:'));
    if (!allowed.length) return Promise.resolve();
    return join(Array.isArray(rooms) ? allowed : allowed[0]);
  };
}

function reconcileBotVoiceAccess(io, db, state, revokeBotVoiceAccess) {
  const invalid = new Map();
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.user?.isBot) continue;
    const reason = getBotVoiceAccessFailure(
      db,
      socket.user.webhookId,
      getSocketVoiceChannelCodes(socket),
      socket.user.botToken
    );
    if (reason) invalid.set(socket.user.webhookId, reason);
  }
  for (const [webhookId, reason] of invalid) revokeBotVoiceAccess(webhookId, reason);
  return invalid.size;
}

function registerBotVoiceSocket(socket, ctx) {
  const { io, db, state, broadcastVoiceUsers, handleVoiceLeave, revokeBotVoiceAccess } = ctx;
  const { voiceUsers, voiceLastActivity } = state;
  const MAX_SDP_SIZE = 16384;
  const MAX_ICE_SIZE = 2048;
  let eventWindowStartedAt = Date.now();
  let eventCount = 0;
  let disconnecting = false;

  socket.emit('bot-session', {
    id: socket.user.id,
    webhookId: socket.user.webhookId,
    username: socket.user.displayName,
    channelCode: socket.user.channelCode
  });

  function disconnectRevoked(reason) {
    if (disconnecting) return;
    disconnecting = true;
    if (typeof revokeBotVoiceAccess === 'function') {
      revokeBotVoiceAccess(socket.user.webhookId, reason);
    } else {
      disconnectBotVoiceSocket(socket, { state, handleVoiceLeave }, reason);
    }
  }

  socket.use((packet, next) => {
    const now = Date.now();
    if (now - eventWindowStartedAt >= 10000) {
      eventWindowStartedAt = now;
      eventCount = 0;
    }
    eventCount++;
    if (eventCount > 300) return next(new Error('Bot voice event rate limit exceeded'));

    const reason = getBotVoiceAccessFailure(
      db,
      socket.user.webhookId,
      getSocketVoiceChannelCodes(socket),
      socket.user.botToken
    );
    if (reason) {
      next(new Error(reason));
      disconnectRevoked(reason);
      return;
    }
    next();
  });

  socket.on('voice-join', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const sessionFailure = getBotVoiceAccessFailure(
      db,
      socket.user.webhookId,
      [],
      socket.user.botToken
    );
    if (sessionFailure) {
      cb({ error: sessionFailure });
      disconnectRevoked(sessionFailure);
      return;
    }

    const webhook = getActiveBotVoiceWebhook(db, socket.user.webhookId);
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
      replacedSocket.emit('voice-kicked', {
        channelCode: requestedCode,
        reason: 'Bot connected from another process'
      });
      replacedSocket.disconnect(true);
    }

    socket.emit('voice-existing-users', {
      channelCode: requestedCode,
      users: existingUsers.map(user => ({
        id: user.id,
        username: user.username,
        isMuted: !!user.isMuted,
        isDeafened: !!user.isDeafened,
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

  function relaySignal(data, field, maxSize, eventName, allowNull = false) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.code !== 'string' || !/^[a-f0-9]{8}$/i.test(data.code)) return;
    if (!Number.isInteger(data.targetUserId)) return;
    if (voiceUsers.get(data.code)?.get(socket.user.id)?.socketId !== socket.id) return;
    const signal = data[field];
    if (!allowNull && (!signal || typeof signal !== 'object')) return;
    if (signal && (typeof signal !== 'object' || JSON.stringify(signal).length > maxSize)) return;
    const target = voiceUsers.get(data.code)?.get(data.targetUserId);
    if (!target || target.id === socket.user.id) return;
    io.to(target.socketId).emit(eventName, {
      from: { id: socket.user.id, username: socket.user.displayName, isBot: true },
      [field]: signal || null,
      channelCode: data.code
    });
  }

  socket.on('voice-offer', data => relaySignal(data, 'offer', MAX_SDP_SIZE, 'voice-offer'));
  socket.on('voice-answer', data => relaySignal(data, 'answer', MAX_SDP_SIZE, 'voice-answer'));
  socket.on('voice-ice-candidate', data => relaySignal(data, 'candidate', MAX_ICE_SIZE, 'voice-ice-candidate', true));

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
  BOT_SOCKET_ROOM,
  canAccessVoiceChannel,
  disconnectBotVoiceSocket,
  disconnectDuplicateBotSockets,
  getAccessibleVoiceChannels,
  getBotVoiceAccessFailure,
  getBotVoiceWebhookByToken,
  isolateBotVoiceSocket,
  reconcileBotVoiceAccess,
  registerBotVoiceSocket
};
