'use strict';

const { isString, isInt } = require('./helpers');

// Keep enough room below socket.io's 64 KiB frame limit for event metadata.
// Gathered native screen SDP can exceed the old 16 KiB voice limit.
const MAX_SDP_SIZE = 49152;
const MAX_ICE_SIZE = 2048;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NEGOTIATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_OFFERS_PER_TARGET_WINDOW = 8;
const OFFER_WINDOW_MS = 10000;
const NATIVE_SCREEN_SIGNAL_EVENTS = new Set([
  'native-screen-offer',
  'native-screen-answer',
  'native-screen-ice-candidate',
]);

function clearNativeScreenOfferWindows(offerWindows, code, userId) {
  const id = String(userId);
  for (const key of offerWindows?.keys() || []) {
    const [sharerId, viewerId, channelCode] = key.split(':');
    if (channelCode === code && (sharerId === id || viewerId === id)) {
      offerWindows.delete(key);
    }
  }
}

function nativeScreenSignalFloodScope(eventName, payload, context) {
  if (!payload || typeof payload !== 'object') return 'invalid';
  const { socket, voiceUsers, activeScreenSessions } = context;
  const code = payload.code;
  const targetUserId = payload.targetUserId;
  const sessionId = payload.sessionId;
  if (typeof eventName !== 'string' || typeof code !== 'string' ||
      !/^[a-f0-9]{8}$/i.test(code) || !Number.isInteger(targetUserId) ||
      typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return 'invalid';
  }
  const room = voiceUsers.get(code);
  const sender = room?.get(socket.user.id);
  const target = room?.get(targetUserId);
  if (!sender || sender.socketId !== socket.id || !target || target.id === socket.user.id) {
    return 'invalid';
  }
  const sessions = activeScreenSessions.get(code);
  const senderSession = sessions?.get(socket.user.id);
  const targetSession = sessions?.get(targetUserId);
  const matches = session => session?.transport === 'native' && session.sessionId === sessionId;
  if (!matches(senderSession) && !matches(targetSession)) return 'invalid';
  return `${eventName}:${targetUserId}:${sessionId}`;
}

function registerNativeScreenSignaling(socket, ctx) {
  const { io, voiceUsers, activeScreenSharers, activeScreenSessions } = ctx;
  const offerWindows = ctx.nativeScreenOfferWindows || new Map();

  function allowOffer(code, targetUserId) {
    const now = Date.now();
    const key = `${socket.user.id}:${targetUserId}:${code}`;
    const recent = (offerWindows.get(key) || [])
      .filter(timestamp => now - timestamp < OFFER_WINDOW_MS);
    if (recent.length >= MAX_OFFERS_PER_TARGET_WINDOW) {
      offerWindows.set(key, recent);
      return false;
    }
    recent.push(now);
    offerWindows.set(key, recent);
    return true;
  }

  function relay(eventName, field, maxSize, relation, allowNull = false) {
    socket.on(eventName, data => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId)) return;
      if (typeof data.sessionId !== 'string' || !SESSION_ID_PATTERN.test(data.sessionId)) return;
      if (typeof data.negotiationId !== 'string' || !NEGOTIATION_ID_PATTERN.test(data.negotiationId)) return;

      const room = voiceUsers.get(data.code);
      const sender = room?.get(socket.user.id);
      const target = room?.get(data.targetUserId);
      if (!sender || sender.socketId !== socket.id || !target || target.id === socket.user.id) return;
      if (sender.isBot || target.isBot || sender.nativeScreenVersion !== 2 || target.nativeScreenVersion !== 2) return;

      const sharers = activeScreenSharers.get(data.code);
      const senderIsSharer = sharers?.has(socket.user.id) === true;
      const targetIsSharer = sharers?.has(data.targetUserId) === true;
      if (relation === 'sender' && !senderIsSharer) return;
      if (relation === 'target' && !targetIsSharer) return;
      if (relation === 'either' && !senderIsSharer && !targetIsSharer) return;

      const sessions = activeScreenSessions.get(data.code);
      const matchesSession = userId => {
        const session = sessions?.get(userId);
        return session?.transport === 'native' && session.sessionId === data.sessionId;
      };
      if (relation === 'sender' && !matchesSession(socket.user.id)) return;
      if (relation === 'target' && !matchesSession(data.targetUserId)) return;
      if (relation === 'either' &&
          !matchesSession(socket.user.id) && !matchesSession(data.targetUserId)) return;
      if (eventName === 'native-screen-offer' && !allowOffer(data.code, data.targetUserId)) return;

      const signal = data[field];
      if (!allowNull && (!signal || typeof signal !== 'object')) return;
      if (signal) {
        if (typeof signal !== 'object') return;
        let encoded;
        try {
          encoded = JSON.stringify(signal);
        } catch {
          return;
        }
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > maxSize) return;
      }

      io.to(target.socketId).emit(eventName, {
        from: { id: socket.user.id, username: socket.user.displayName },
        channelCode: data.code,
        sessionId: data.sessionId,
        negotiationId: data.negotiationId,
        [field]: signal || null,
      });
    });
  }

  relay('native-screen-offer', 'offer', MAX_SDP_SIZE, 'sender');
  relay('native-screen-answer', 'answer', MAX_SDP_SIZE, 'target');
  relay('native-screen-ice-candidate', 'candidate', MAX_ICE_SIZE, 'either', true);
}

module.exports = {
  MAX_SDP_SIZE,
  MAX_ICE_SIZE,
  MAX_OFFERS_PER_TARGET_WINDOW,
  SESSION_ID_PATTERN,
  NEGOTIATION_ID_PATTERN,
  NATIVE_SCREEN_SIGNAL_EVENTS,
  clearNativeScreenOfferWindows,
  nativeScreenSignalFloodScope,
  registerNativeScreenSignaling,
};
