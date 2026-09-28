'use strict';
/**
 * Socket messages for relayed calls (see src/voiceRelay).
 *
 * A relayed call still joins through voice-join like any other, so every
 * check there (membership, role gate, voice permission, user limit) has
 * already passed. These messages only move media: each one first confirms
 * the socket is the one in the call, and that the call really is relayed.
 *
 *   relay:join       -> router capabilities + a sending and a receiving connection
 *   relay:connect    -> finish connecting one of them
 *   relay:produce    -> start sending a track (mic, screen, screen-audio, webcam)
 *   relay:producers  -> what everyone else is sending right now
 *   relay:consume    -> start receiving one of those
 *   relay:resume     -> unpause a received track once it is wired up
 *   relay:close-producer -> stop sending a track
 *
 * The server announces relay:new-producer and relay:producer-closed to the
 * rest of the call, and relay:lost when the relay itself went away.
 */

const SOURCES = new Set(['mic', 'screen', 'screen-audio', 'webcam']);
// What each source must carry.
const SOURCE_KIND = { mic: 'audio', 'screen-audio': 'audio', screen: 'video', webcam: 'video' };
// Joining a big call is a burst of these (two per track in the call), so the
// limit is generous; it only stops a client hammering the relay.
const RATE = { max: 800, windowMs: 10000 };
const ID = /^[A-Za-z0-9-]{1,64}$/;

module.exports = function registerVoiceRelay(socket, ctx) {
  const { io, state } = ctx;
  const { voiceUsers, activeScreenSharers, activeWebcamUsers, voiceRelay } = state;
  if (!voiceRelay) return;

  const peerId = () => `u${socket.user.id}`;

  // The socket is the one in this relayed call, or null.
  function inRelayedCall(code) {
    if (typeof code !== 'string' || !/^[a-f0-9]{8}$/i.test(code)) return false;
    const entry = voiceUsers.get(code)?.get(socket.user.id);
    return !!entry && entry.socketId === socket.id && voiceRelay.currentKind(code) === 'relay';
  }

  let windowStart = 0;
  let used = 0;
  const overLimit = () => {
    const now = Date.now();
    if (now - windowStart > RATE.windowMs) { windowStart = now; used = 0; }
    return ++used > RATE.max;
  };

  // Every handler answers through the ack: { ok: true, ... } or { error }.
  function handle(event, fn) {
    socket.on(event, async (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (overLimit()) return reply({ error: 'Slow down' });
      try {
        if (!data || typeof data !== 'object' || !inRelayedCall(data.code)) {
          return reply({ error: 'Not in a relayed call' });
        }
        reply({ ok: true, ...(await fn(data)) });
      } catch (err) {
        reply({ error: err.message || 'Relay error' });
      }
    });
  }

  handle('relay:join', async ({ code }) => {
    // Joining again (a reconnect) replaces the old session; tell the call
    // its tracks stopped so nobody keeps a dead one.
    if (voiceRelay.inCall(code, peerId())) {
      for (const producerId of voiceRelay.leave(code, peerId())) {
        socket.to(`voice:${code}`).emit('relay:producer-closed', { channelCode: code, producerId, userId: socket.user.id });
      }
    }
    return voiceRelay.join(code, peerId(), socket.user.id);
  });

  handle('relay:connect', async ({ code, transportId, dtlsParameters }) => {
    if (!ID.test(String(transportId)) || !dtlsParameters || typeof dtlsParameters !== 'object') throw new Error('Bad request');
    await voiceRelay.connect(code, peerId(), transportId, dtlsParameters);
    return {};
  });

  handle('relay:produce', async ({ code, transportId, kind, rtpParameters, source }) => {
    if (!ID.test(String(transportId)) || !SOURCES.has(source) || SOURCE_KIND[source] !== kind) throw new Error('Bad request');
    if (!rtpParameters || typeof rtpParameters !== 'object') throw new Error('Bad request');
    // Screen and webcam go through the same announcements as a direct call,
    // which is where streams_enabled and the rest are checked.
    if ((source === 'screen' || source === 'screen-audio') && !activeScreenSharers.get(code)?.has(socket.user.id)) {
      throw new Error('Start the screen share first');
    }
    if (source === 'webcam' && !activeWebcamUsers.get(code)?.has(socket.user.id)) {
      throw new Error('Start the camera first');
    }
    const producerId = await voiceRelay.produce(code, peerId(), transportId, kind, rtpParameters, source);
    socket.to(`voice:${code}`).emit('relay:new-producer', {
      channelCode: code, producerId, userId: socket.user.id, source, kind,
    });
    return { producerId };
  });

  handle('relay:producers', async ({ code }) => {
    // A session the relay no longer has (the server restarted) must hear so,
    // or the client keeps a dead connection that "has nothing to receive".
    if (!voiceRelay.inCall(code, peerId())) throw new Error('Not in this call');
    return { producers: voiceRelay.producers(code, peerId()) };
  });

  handle('relay:consume', async ({ code, producerId, rtpCapabilities }) => {
    if (!ID.test(String(producerId)) || !rtpCapabilities || typeof rtpCapabilities !== 'object') throw new Error('Bad request');
    const consumer = await voiceRelay.consume(code, peerId(), producerId, rtpCapabilities);
    if (!consumer) throw new Error('This track cannot be played here');
    return { consumer };
  });

  handle('relay:resume', async ({ code, consumerId }) => {
    if (!ID.test(String(consumerId))) throw new Error('Bad request');
    await voiceRelay.resumeConsumer(code, peerId(), consumerId);
    return {};
  });

  handle('relay:close-producer', async ({ code, producerId, source }) => {
    if (!ID.test(String(producerId))) throw new Error('Bad request');
    if (voiceRelay.closeProducer(code, peerId(), producerId)) {
      socket.to(`voice:${code}`).emit('relay:producer-closed', {
        channelCode: code, producerId, userId: socket.user.id, source: SOURCES.has(source) ? source : null,
      });
    }
    return {};
  });
};

module.exports.RELAY_EVENTS = [
  'relay:join', 'relay:connect', 'relay:produce', 'relay:producers',
  'relay:consume', 'relay:resume', 'relay:close-producer',
];
