// ═══════════════════════════════════════════════════════════
// Haven — Stream/Voice Debug Logger
// ═══════════════════════════════════════════════════════════
//
// Attach via:  window._streamDebug = new StreamDebugLogger(voiceManager);
//
// The logger patches VoiceManager internals non-destructively so it can
// be toggled on/off at runtime without reloading the page.
//
// In the browser console:
//   window._streamDebug.enable()   — start recording
//   window._streamDebug.disable()  — stop recording
//   window._streamDebug.dump()     — print full log to console
//   window._streamDebug.download() — save log as a .txt file
//   window._streamDebug.clear()    — wipe the log

class StreamDebugLogger {
  constructor(voice) {
    this._voice = voice;
    this._entries = [];
    this._enabled = false;
    this._patchedPeers = new Set();   // peerIds we've already instrumented
    this._origAddPeer = null;
    this._socketWatchers = [];

    // Make it easy to find in the console
    console.log('[StreamDebug] Logger attached. Call window._streamDebug.enable() to start.');
  }

  // ── Public API ────────────────────────────────────────────

  enable() {
    if (this._enabled) { console.log('[StreamDebug] Already enabled.'); return; }
    this._enabled = true;
    this._patchSocketEvents();
    this._patchScreenSharers();
    this._patchExistingPeers();
    this._patchCreatePeer();
    this._log('system', 'Logger ENABLED');
    console.log('[StreamDebug] Enabled. Reproducing the bug will now capture everything. Call .dump() or .download() afterwards.');
  }

  disable() {
    this._enabled = false;
    this._unpatchSocketEvents();
    this._log('system', 'Logger DISABLED');
    console.log('[StreamDebug] Disabled.');
  }

  dump() {
    const out = this._format();
    console.log(out);
    return out;
  }

  download() {
    const text = this._format();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `haven-stream-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    console.log('[StreamDebug] Log downloaded.');
  }

  clear() {
    this._entries = [];
    this._patchedPeers.clear();
    console.log('[StreamDebug] Log cleared.');
  }

  // ── Internal helpers ──────────────────────────────────────

  _ts() {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  }

  _log(category, msg, extra) {
    const entry = { ts: this._ts(), cat: category, msg };
    if (extra !== undefined) entry.extra = extra;
    this._entries.push(entry);
    if (this._enabled) {
      const extraStr = extra !== undefined ? '  ' + JSON.stringify(extra) : '';
      console.debug(`[StreamDebug][${entry.ts}][${category}] ${msg}${extraStr}`);
    }
  }

  _format() {
    const lines = [
      '═══════════════════════════════════════════════',
      '  Haven Stream Debug Log',
      `  Generated: ${new Date().toISOString()}`,
      `  Local user: ${this._voice.localUserId ?? '?'}`,
      `  Current channel: ${this._voice.currentChannel ?? '?'}`,
      `  inVoice: ${this._voice.inVoice}`,
      `  isScreenSharing: ${this._voice.isScreenSharing}`,
      `  screenSharers: [${[...this._voice.screenSharers].join(', ')}]`,
      `  peers: [${[...this._voice.peers.keys()].join(', ')}]`,
      '═══════════════════════════════════════════════',
      '',
    ];
    for (const e of this._entries) {
      const extra = e.extra !== undefined ? '  ' + JSON.stringify(e.extra) : '';
      lines.push(`[${e.ts}][${e.cat.padEnd(12)}] ${e.msg}${extra}`);
    }
    lines.push('');
    lines.push('═══════════════════════════════════════════════');
    return lines.join('\n');
  }

  // ── Socket event patching ─────────────────────────────────

  _patchSocketEvents() {
    const WATCH = [
      'screen-share-started', 'screen-share-stopped',
      'renegotiate-screen', 'renegotiate-webcam',
      'active-screen-sharers', 'active-webcam-users',
      'voice-offer', 'voice-answer', 'voice-ice-candidate',
      'voice-user-joined', 'voice-user-left', 'voice-existing-users',
      'stream-viewers-update',
    ];

    const sock = this._voice.socket;
    const originalOn = sock.constructor.prototype.on;
    const originalEmit = sock.constructor.prototype.emit;
    const self = this;

    WATCH.forEach(event => {
      const handler = (data) => {
        if (!self._enabled) return;
        self._log('socket-in', `← ${event}`, self._summarize(data));
      };
      sock.on(event, handler);
      this._socketWatchers.push({ event, handler });
    });

    // Patch outgoing emit for the events we care about
    const _origEmit = sock.emit.bind(sock);
    this._origEmit = _origEmit;
    sock.emit = function(event, ...args) {
      if (self._enabled && WATCH.includes(event)) {
        self._log('socket-out', `→ ${event}`, self._summarize(args[0]));
      }
      return _origEmit(event, ...args);
    };
  }

  _unpatchSocketEvents() {
    const sock = this._voice.socket;
    this._socketWatchers.forEach(({ event, handler }) => {
      sock.off(event, handler);
    });
    this._socketWatchers = [];
    if (this._origEmit) {
      sock.emit = this._origEmit;
      this._origEmit = null;
    }
  }

  // ── screenSharers Set patching ────────────────────────────

  _patchScreenSharers() {
    const self = this;
    const orig = this._voice.screenSharers;
    const proxy = new Proxy(orig, {
      get(target, prop) {
        const val = Reflect.get(target, prop);
        if (prop === 'add') {
          return (id) => {
            self._log('sharers', `screenSharers.add(${id})`);
            return Reflect.apply(val, target, [id]);
          };
        }
        if (prop === 'delete') {
          return (id) => {
            self._log('sharers', `screenSharers.delete(${id})`);
            return Reflect.apply(val, target, [id]);
          };
        }
        if (prop === 'clear') {
          return () => {
            self._log('sharers', 'screenSharers.clear()');
            return Reflect.apply(val, target, []);
          };
        }
        if (typeof val === 'function') return val.bind(target);
        return val;
      }
    });
    this._voice.screenSharers = proxy;
  }

  // ── Peer connection instrumentation ──────────────────────

  _patchExistingPeers() {
    for (const [userId, peer] of this._voice.peers.entries()) {
      this._instrumentPeer(userId, peer.connection);
    }
  }

  _patchCreatePeer() {
    // Wrap _createPeer so every new connection gets logged
    const self = this;
    const voice = this._voice;
    const origCreate = voice._createPeer.bind(voice);
    voice._createPeer = async function(userId, createOffer) {
      self._log('peer', `_createPeer(${userId}, createOffer=${createOffer})`);
      const result = await origCreate(userId, createOffer);
      // After creation, instrument the new peer
      const peer = voice.peers.get(userId);
      if (peer) self._instrumentPeer(userId, peer.connection);
      return result;
    };
    this._origCreatePeer = origCreate;
  }

  _instrumentPeer(userId, conn) {
    if (this._patchedPeers.has(userId)) return;
    this._patchedPeers.add(userId);
    const self = this;

    // Connection state
    const origConnChange = conn.onconnectionstatechange;
    conn.addEventListener('connectionstatechange', () => {
      self._log('peer', `[${userId}] connectionState → ${conn.connectionState}`);
    });

    // ICE state
    conn.addEventListener('icegatheringstatechange', () => {
      self._log('peer', `[${userId}] iceGatheringState → ${conn.iceGatheringState}`);
    });
    conn.addEventListener('iceconnectionstatechange', () => {
      self._log('peer', `[${userId}] iceConnectionState → ${conn.iceConnectionState}`);
    });
    conn.addEventListener('signalingstatechange', () => {
      self._log('peer', `[${userId}] signalingState → ${conn.signalingState}`);
    });

    // Track events — the critical part for diagnosing stream issues
    conn.addEventListener('track', (event) => {
      const track = event.track;
      const src = event.streams?.[0];
      const settings = track.kind === 'video' && track.getSettings ? track.getSettings() : {};
      const peerIsSharing = self._voice.screenSharers.has(userId);
      const streamHasVideo = src && src.getVideoTracks().length > 0;
      const info = {
        kind: track.kind,
        id: track.id.slice(0, 8),
        streamId: src?.id?.slice(0, 8) ?? 'none',
        muted: track.muted,
        readyState: track.readyState,
        displaySurface: settings.displaySurface ?? 'n/a',
        peerIsSharing,
        streamHasVideo,
      };
      self._log('track', `[${userId}] ontrack — ${track.kind} track received`, info);

      // Also log when the track unmutes / ends
      track.addEventListener('unmute', () => {
        self._log('track', `[${userId}] track UNMUTED  kind=${track.kind} id=${track.id.slice(0,8)}`);
      });
      track.addEventListener('ended', () => {
        self._log('track', `[${userId}] track ENDED   kind=${track.kind} id=${track.id.slice(0,8)}`);
      });
      track.addEventListener('mute', () => {
        self._log('track', `[${userId}] track MUTED   kind=${track.kind} id=${track.id.slice(0,8)}`);
      });
    });

    this._log('peer', `[${userId}] instrumented (state=${conn.connectionState}, ice=${conn.iceConnectionState})`);
  }

  // ── Summarize data for logging ────────────────────────────

  _summarize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const safe = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'offer' || k === 'answer') {
        safe[k] = `[SDP ${v?.type ?? '?'}]`;
      } else if (k === 'candidate' && v) {
        safe[k] = `[ICE ${v.candidate?.slice(0, 40) ?? '?'}...]`;
      } else {
        safe[k] = v;
      }
    }
    return safe;
  }
}

// Auto-attach once voice manager is available
(function autoAttach() {
  const tryAttach = () => {
    // VoiceManager is typically stored on window.app.voice or window._voice
    const voice = window.app?.voice || window._voice || window.voiceManager;
    if (voice) {
      window._streamDebug = new StreamDebugLogger(voice);
      return true;
    }
    return false;
  };

  if (!tryAttach()) {
    // Poll briefly until app initializes
    let tries = 0;
    const interval = setInterval(() => {
      if (tryAttach() || ++tries > 60) clearInterval(interval);
    }, 500);
  }
})();
