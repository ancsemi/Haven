'use strict';
/**
 * The voice relay, whichever kind the admin picked in Large Server Setup.
 *
 *   off      - calls go peer to peer, as always
 *   builtin  - mediasoup, running inside Haven (./mediasoup.js)
 *   livekit  - reserved for a LiveKit server the admin runs themselves
 *
 * The rest of Haven talks to the relay only through this module, so a second
 * kind can be added without touching the voice code that uses it.
 *
 * A call keeps the kind it started with until everyone has left, so turning
 * the relay on never splits a call in two. Turning it off (or it failing to
 * restart) moves relayed calls over to direct connections: onRelayEnded
 * tells the people in each one to connect to each other directly.
 */

const fs = require('fs');
const { MediasoupRelay } = require('./mediasoup');
const addon = require('./addon');

const MODES = ['off', 'builtin'];
const DEFAULT_PORT = 40000;
const MAX_WORKERS = 8;

function createVoiceRelay({ getSetting, onRoomLost, onRelayEnded = () => {} }) {
  const readSettings = () => {
    const port = parseInt(getSetting('voice_relay_port'), 10);
    const workers = parseInt(getSetting('voice_relay_workers'), 10);
    return {
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 - MAX_WORKERS ? port : DEFAULT_PORT,
      workers: Number.isInteger(workers) && workers >= 1 ? Math.min(workers, MAX_WORKERS) : 1,
      address: String(getSetting('voice_relay_address') || '').trim(),
    };
  };
  const mode = () => {
    const m = getSetting('voice_relay_mode');
    return MODES.includes(m) ? m : 'off';
  };

  const builtin = new MediasoupRelay({ settings: readSettings, onRoomLost });
  // Restarts run one after another, so two quick saves never overlap.
  let applying = Promise.resolve();
  // code -> 'relay' | 'direct', fixed for as long as the call has anyone in it
  const callKinds = new Map();

  return {
    MODES,
    DEFAULT_PORT,
    MAX_WORKERS,
    mode,
    readSettings,
    available: () => MediasoupRelay.available(),

    status() {
      return {
        mode: mode(), available: MediasoupRelay.available(), installing: addon.isInstalling(),
        // In Docker the port also has to be mapped in docker-compose.yml.
        docker: fs.existsSync('/.dockerenv'),
        ...builtin.status(),
      };
    },

    /** Installs the media engine (Large Server Setup). */
    install: (onLine) => addon.install(onLine),

    /** Called when the admin saves relay settings: start, stop or restart. */
    apply() {
      applying = applying.catch(() => { /* the caller of the previous apply already reported it */ }).then(async () => {
        await builtin.stop();
        const running = mode() === 'builtin' && await builtin.start();
        if (!running) {
          for (const [code, kind] of callKinds) {
            if (kind !== 'relay') continue;
            callKinds.set(code, 'direct');
            onRelayEnded(code);
          }
        }
        return this.status();
      });
      return applying;
    },

    /** Starts the relay at boot when it is switched on. */
    async boot() {
      if (mode() === 'builtin') await builtin.start();
    },

    /**
     * Which way a call goes: decided by the first person in, kept until the
     * last one leaves. `occupied` says whether anyone is in the call already.
     */
    kindFor(code, occupied) {
      if (occupied && callKinds.has(code)) return callKinds.get(code);
      const kind = mode() === 'builtin' && MediasoupRelay.available() ? 'relay' : 'direct';
      callKinds.set(code, kind);
      return kind;
    },
    currentKind: (code) => callKinds.get(code) || null,
    callEnded(code) { callKinds.delete(code); },

    // The relayed-call operations, passed straight to the running relay.
    join: (...a) => {
      if (mode() !== 'builtin') return Promise.reject(new Error('The voice relay is off'));
      return builtin.join(...a);
    },
    connect: (...a) => builtin.connect(...a),
    produce: (...a) => builtin.produce(...a),
    closeProducer: (...a) => builtin.closeProducer(...a),
    setProducerPaused: (...a) => builtin.setProducerPaused(...a),
    producers: (...a) => builtin.producers(...a),
    consume: (...a) => builtin.consume(...a),
    resumeConsumer: (...a) => builtin.resumeConsumer(...a),
    setWatching: (...a) => builtin.setWatching(...a),
    closeSources: (...a) => builtin.closeSources(...a),
    sessions: () => builtin.sessions(),
    leave: (...a) => builtin.leave(...a),
    inCall: (...a) => builtin.inCall(...a),
  };
}

module.exports = { createVoiceRelay };
