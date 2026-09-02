// ═══════════════════════════════════════════════════════════
// Haven — WebRTC Voice Chat Manager
// ═══════════════════════════════════════════════════════════

// iOS Safari (and every "browser" on iOS, since they all wrap WebKit) has a
// long-standing bug where MediaStreamAudioSourceNode produces silence for
// audio tracks received from an RTCPeerConnection. The track is alive and
// audible if attached directly to an <audio> element, but routing it
// through createMediaStreamSource() → ... → destination gives you nothing.
// Detect iOS so _playAudio / _playScreenAudio can skip the Web Audio graph
// and use native element playback instead. (#5388-ish, iOS Web fix)
const _IS_IOS_WEBKIT = (() => {
  try {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // Treat all iOS browsers as WebKit (they are, by App Store policy).
    return isIOS;
  } catch { return false; }
})();

class VoiceManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;        // Processed stream (sent to peers)
    this.rawStream = null;          // Raw mic stream (for local talk detection)
    this.screenStream = null;       // Screen share MediaStream
    this.webcamStream = null;       // Webcam video MediaStream
    this.isScreenSharing = false;
    this.isWebcamActive = false;
    this.peers = new Map();         // userId → { connection, stream, username }
    this.currentChannel = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.inVoice = false;
    this.noiseSensitivity = 10;     // Noise gate sensitivity 0 (off) to 100 (aggressive)
    this.currentMicLevel = 0;       // Real-time mic input level 0-100 for UI meter
    this.audioCtx = null;           // Web Audio context for volume boost
    this.gainNodes = new Map();     // userId → GainNode
    this.localUserId = null;        // set by app.js so stopScreenShare can reference own tile
    this.onScreenStream = null;     // callback(userId, stream|null) — set by app.js
    this.onWebcamStream = null;     // callback(userId, stream|null) — set by app.js
    this.onVoiceJoin = null;        // callback(userId, username)
    this.onVoiceLeave = null;       // callback(userId, username)
    this.onTalkingChange = null;    // callback(userId, isTalking)
    this.screenSharers = new Set();  // userIds currently sharing
    this.webcamUsers = new Set();    // userIds currently broadcasting webcam
    // userIds whose current screen share we have actually handed to the UI.
    // Reset on every screen-share-started so a *re*share has to prove itself
    // again — see _watchForScreenStream for why "a live receiver exists" is
    // not the same thing as "the viewer is seeing the stream".
    this._screenDelivered = new Set();
    this.screenGainNodes = new Map(); // userId → GainNode for screen share audio
    this._nativeScreenPeers = new Map(); // sharerId → { connection, sessionId }
    this._pendingNativeScreenCandidates = new Map();
    this._nativeScreenAnnouncements = new Map(); // sharerId → active native sessionId
    this._nativeScreenSenderStates = new Map(); // peer/session → answer + queued ICE state
    this._nativeScreenSharing = false;
    this._nativeScreenSessionId = null;
    this._screenStartOperation = 0;
    this._screenStartInFlight = false;
    this._pendingScreenStop = null;
    this._screenWatchdogTimers = new Map();
    this.onScreenAudio = null;       // callback(userId) — screen share audio available
    this.talkingState = new Map();  // userId → boolean
    this.analysers = new Map();     // userId → { analyser, dataArray, interval }
    this.onScreenShareStarted = null; // callback(userId, username) — someone started streaming
    this.onWebcamStatusChange = null; // callback() — webcam started/stopped, re-render user list
    this.onConnectivityWarning = null; // (#5399) callback(message) — fired when no STUN server responds
    this.onScreenShareWarning = null; // callback() — native transport stopped for compatibility
    this._connectivityWarned = false;  // only warn once per session to avoid toast spam
    this.deafenedUsers = new Set();   // userIds we've muted our audio towards
    this._localTalkInterval = null;
    this._noiseGateInterval = null;
    this._noiseGateGain = null;
    this._noiseGateAnalyser = null;
    this._vcDest = null;             // MediaStreamDestination node for mixing soundboard audio into VC
    this._botAudio = null;           // Current server-hosted bot audio playback

    // Voice audio bitrate cap (0 = auto, otherwise kbps from server)
    this.audioBitrate = 0;

    // RNNoise noise suppression state
    this._rnnoiseNode = null;        // AudioWorkletNode for RNNoise
    this._rnnoiseReady = false;      // true ONLY once the worklet posts {type:'ready'}
    this._rnnoiseWasmBytes = null;   // ArrayBuffer of rnnoise.wasm (posted into worklet)
    this._rnnoiseSource = null;      // MediaStreamSource feeding the chain
    // Noise mode: 'off' | 'gate' | 'suppress'
    const savedMode = localStorage.getItem('haven_noise_mode');
    this.noiseMode = savedMode || 'gate';

    // Screen share quality settings (populated from localStorage)
    const savedRes = localStorage.getItem('haven_screen_res');
    this.screenResolution = savedRes !== null ? parseInt(savedRes, 10) : 1080;  // 0 = source
    this.screenFrameRate = parseInt(localStorage.getItem('haven_screen_fps') || '30', 10) || 30;

    // Bitrate map: resolution → bits/sec  (per-resolution caps for screen-share encoding).
    // 3.18.1 (#5379): bumped 2-3x because the previous values (1.5 / 3 / 5 Mbps) were
    // well below what modern home internet can comfortably push, and WebRTC was dropping
    // framerate to fit inside the cap instead of using the headroom users actually have.
    // Reference points: YouTube live recommends 4.5-9 Mbps for 1080p60; OBS default for
    // 1080p60 is 8 Mbps. We sit between "good" and "high" so two-person sessions on
    // typical broadband stop being framerate-starved.
    this._screenBitrates = {
      0:    8_000_000,   // 8 Mbps fallback for unconstrained (source)
      720:  4_000_000,   // 4 Mbps  (was 1.5)
      1080: 8_000_000,   // 8 Mbps  (was 3)
      1440: 14_000_000,  // 14 Mbps (was 5)
    };

    // Default STUN pool — non-Google by preference. Each entry is tried
    // simultaneously by the browser during ICE gathering, so listing several
    // gives natural redundancy. If admin configures their own servers via
    // /api/ice-servers (typically with a TURN), that takes precedence over
    // everything here.
    //
    // 3.20.1 (#5399): the previous defaults (stun.stunprotocol.org and
    // stun.nextcloud.com) both went offline. stunprotocol's domain is gone
    // entirely; nextcloud's STUN stopped responding to binding requests.
    // Result was every Haven server using default ICE config lost external
    // WebRTC simultaneously — LAN-to-LAN still worked because host
    // candidates don't need STUN, but anyone outside the server's subnet
    // got stuck on "ICE: Connecting...". The defaults below are a pool of
    // three independent, non-Google providers. If they all fail the runtime
    // probe the client keeps them and warns the user to configure STUN/TURN,
    // rather than falling back to Google.
    this._stunPreferred = [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.relay.metered.ca:80',
      'stun:global.stun.twilio.com:3478',
    ];
    this.rtcConfig = {
      iceServers: this._stunPreferred.map(urls => ({ urls })),
    };
    // True once /api/ice-servers has returned admin-configured servers; the
    // probe must not overwrite those.
    this._adminIceServersLoaded = false;

    // Fetch server-provided ICE config (may include TURN)
    this._fetchIceServers();

    // Probe the default pool in the background and prune dead servers so
    // future RTCPeerConnections don't waste gathering time on them. Only
    // applies if the admin hasn't configured their own ICE servers.
    this._probeDefaultStun();

    this._setupSocketListeners();
    this._setupNativeScreenBridge();
  }

  // ── Fetch ICE servers from backend (STUN + optional TURN) ──

  async _fetchIceServers() {
    try {
      const token = localStorage.getItem('haven_token');
      if (!token) return;
      // 4s hard cap — if the server is restarting or unreachable, we
      // fall back to the default STUN-only config rather than hanging
      // join() indefinitely. Without the timeout, a click on Start Voice
      // during a server reboot stays in-flight while the user mashes the
      // button, queuing up duplicate voice-join emits that all fire once
      // the socket reconnects (#voice-spam-click).
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
      let res;
      try {
        res = await fetch('/api/ice-servers', {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: ctrl ? ctrl.signal : undefined
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res && res.ok) {
        const data = await res.json();
        if (data.iceServers && data.iceServers.length) {
          this.rtcConfig.iceServers = data.iceServers;
          this._adminIceServersLoaded = true;
          console.log(`🧊 ICE servers loaded (${data.iceServers.length} servers${data.iceServers.some(s => String(s.urls).includes('turn:')) ? ', TURN enabled' : ''})`);
        }
        // Relay-only mode (v3.42.0). The server sends this when the admin has
        // enabled voice_force_relay and a TURN server is actually configured.
        // It makes the browser drop host and srflx candidates, so peers in a
        // call never learn each other's real IP addresses. Also suppress the
        // STUN health probe below, which exists to pick good srflx servers and
        // is meaningless (and would log spurious failures) when srflx
        // candidates are being discarded on purpose.
        if (data.iceTransportPolicy === 'relay') {
          this.rtcConfig.iceTransportPolicy = 'relay';
          this._relayOnly = true;
          console.log('🧊 Relay-only voice: peer IP addresses stay hidden behind TURN');
        } else {
          delete this.rtcConfig.iceTransportPolicy;
          this._relayOnly = false;
        }
        // After the relay-only flag is settled, not before: the probe measures
        // srflx candidates, which relay-only discards on purpose, so running it
        // any earlier reports every server dead on a perfectly healthy setup.
        // Fire and forget; a dead entry here used to fail completely silently.
        if (this._adminIceServersLoaded) this._probeConfiguredStun(data.iceServers);
      }
    } catch (err) {
      console.warn('Could not fetch ICE servers, using defaults:', err && err.message);
    }
  }

  // ── Runtime STUN health probe ──────────────────────────
  //
  // Validates each default STUN URL by spinning up a throwaway
  // RTCPeerConnection and waiting for a srflx (server-reflexive)
  // candidate, which only appears if the STUN server actually responds.
  // Survivors replace the iceServers list. If every server is dead, the
  // client keeps the list and warns the user to configure STUN/TURN.

  // Does this STUN server actually answer a binding request? A server that
  // resolves and accepts packets but never produces a srflx candidate is
  // indistinguishable from a working one until a call fails, which is the whole
  // problem this measures.
  // Test one ICE server the way a real call would use it, and report what came
  // back rather than just pass or fail.
  //
  // Written for the admin-facing connectivity test. Every thread about voice not
  // working has gone the same way: it fails for users, the admin has no way to
  // see why, and the answer only turns up after someone walks them through a
  // third-party ICE test page and reads the candidate list for them. The browser
  // already knows all of this at gathering time. (#5542)
  _probeIceServer(server, timeoutMs = 5000) {
    return new Promise(resolve => {
      const urls = [].concat((server && server.urls) || []).map(String);
      const isTurn = urls.some(u => /^turns?:/i.test(u));
      const result = { urls: urls.join(', '), isTurn, srflx: false, relay: false, error: '' };
      let settled = false;
      let pc;
      const done = () => {
        if (settled) return;
        settled = true;
        try { pc && pc.close(); } catch { /* ignore */ }
        resolve(result);
      };
      try {
        pc = new RTCPeerConnection({ iceServers: [server] });
        // The browser reports why a server could not be used here: a bad
        // hostname, a refused allocation, a timeout. That message is the single
        // most useful thing in the whole test, so keep the first one.
        pc.onicecandidateerror = e => {
          if (result.error) return;
          const text = (e && e.errorText) || '';
          const code = (e && e.errorCode) || 0;
          if (text || code) result.error = text ? `${text}${code ? ` (${code})` : ''}` : `error ${code}`;
        };
        pc.createDataChannel('probe');
        pc.onicecandidate = e => {
          // A null candidate means gathering finished on its own.
          if (!e.candidate) return done();
          const cand = e.candidate.candidate || '';
          if (cand.includes('typ srflx')) result.srflx = true;
          if (cand.includes('typ relay')) result.relay = true;
          // Stop as soon as we have the answer this server was asked for.
          if (isTurn ? result.relay : result.srflx) done();
        };
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => done());
        setTimeout(done, timeoutMs);
      } catch {
        done();
      }
    });
  }

  // Run the whole configured ICE list and turn it into something an admin can
  // act on. Returns plain data; the wording lives in the settings panel.
  async diagnoseConnectivity(iceServers) {
    const servers = (iceServers || []).filter(s => s && s.urls);
    const results = await Promise.all(servers.map(s => this._probeIceServer(s)));

    const stun = results.filter(r => !r.isTurn);
    const turn = results.filter(r => r.isTurn);
    const liveStun = stun.filter(r => r.srflx);
    const liveTurn = turn.filter(r => r.relay);

    return {
      results,
      stunTotal: stun.length,
      stunLive: liveStun.length,
      deadStun: stun.filter(r => !r.srflx),
      turnTotal: turn.length,
      turnLive: liveTurn.length,
      deadTurn: turn.filter(r => !r.relay),
      // No server-reflexive candidate anywhere means nobody learns their own
      // public address, and two people on different networks have nothing to
      // exchange. That is the failure this whole test exists to catch early.
      canCrossNetworks: liveStun.length > 0 || liveTurn.length > 0,
      hasRelay: liveTurn.length > 0
    };
  }

  _probeStunUrl(url, timeoutMs = 2500) {
    return new Promise(resolve => {
      let settled = false;
      let pc;
      const done = ok => {
        if (settled) return;
        settled = true;
        try { pc && pc.close(); } catch { /* ignore */ }
        resolve({ url, ok });
      };
      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: url }] });
        // DataChannel forces ICE gathering even without media tracks.
        pc.createDataChannel('probe');
        pc.onicecandidate = e => {
          if (!e.candidate) return;
          const cand = e.candidate.candidate || '';
          if (cand.includes('typ srflx')) done(true);
        };
        pc.createOffer()
          .then(o => pc.setLocalDescription(o))
          .catch(() => done(false));
        setTimeout(() => done(false), timeoutMs);
      } catch {
        done(false);
      }
    });
  }

  // Check the STUN servers an admin configured, and say so when they are dead.
  //
  // The default pool has been probed since #5399, but a configured list was
  // exempt on the grounds that the probe must not overwrite an admin's choice.
  // That left the worst case unreported: setting STUN_URLS replaces the working
  // defaults wholesale and skips the probe, so a list containing a decommissioned
  // server produces no srflx candidates and nothing anywhere says why. Browsers
  // publish only mDNS host candidates now, so with no srflx two browsers on
  // different networks have nothing left to try, while native clients keep
  // working because they still publish a real address. That combination reads as
  // "Haven broke web calls" rather than "this STUN server is gone", and it cost
  // one admin days (#5542).
  //
  // This only reports. The configuration is left exactly as the admin set it.
  async _probeConfiguredStun(iceServers) {
    try {
      // Relay-only deliberately discards srflx candidates, so every server
      // would probe as dead. Same reason the default probe skips it.
      if (this._relayOnly) return;
      const urls = [];
      for (const entry of iceServers || []) {
        for (const u of [].concat(entry && entry.urls || [])) {
          if (typeof u === 'string' && /^stuns?:/i.test(u)) urls.push(u);
        }
      }
      if (!urls.length) return;

      const results = await Promise.all(urls.map(u => this._probeStunUrl(u)));
      const dead = results.filter(r => !r.ok).map(r => r.url);
      if (!dead.length) return;

      const hasTurn = (iceServers || []).some(entry =>
        [].concat(entry && entry.urls || []).some(u => /^turns?:/i.test(String(u))));

      console.error(`[Voice] Configured STUN server(s) not responding: ${dead.join(', ')}`);
      if (dead.length < urls.length || hasTurn) return;

      // Nothing configured works and there is no relay, so as it stands calls
      // between two networks cannot connect at all. Reporting that was the
      // first half of #5542; this is the other half.
      //
      // Setting STUN_URLS replaces the built-in pool rather than adding to it,
      // so a single typo in one entry takes browser-to-browser voice out
      // entirely for everyone off the LAN. That is never what the admin was
      // choosing. "Use my server" is a preference; "have no working voice" is
      // not something anyone picks on purpose, and the reporter here lost days
      // to a mistyped port before the difference was visible anywhere.
      //
      // Narrow on purpose. It engages only when every configured server failed
      // the probe AND there is no TURN, which is exactly the case where the
      // alternative is nothing at all. An admin who deliberately wants only
      // their own servers has a relay configured too, and that path returns
      // above without reaching this. The stored setting is never written to;
      // this lasts for the session and the warning still names what to fix.
      const revived = await Promise.all(this._stunPreferred.map(u => this._probeStunUrl(u)));
      const live = revived.filter(r => r.ok).map(r => r.url);

      if (live.length) {
        const keep = (iceServers || []).filter(entry =>
          ![].concat(entry && entry.urls || []).some(u => /^stuns?:/i.test(String(u))));
        this.rtcConfig.iceServers = keep.concat(live.map(urls => ({ urls })));
        console.warn(
          `[Voice] Falling back to Haven's built-in STUN pool for this session (${live.join(', ')}). ` +
          'The configured servers stay saved and untouched.'
        );
      }

      if (!this._connectivityWarned && typeof this.onConnectivityWarning === 'function') {
        this._connectivityWarned = true;
        this.onConnectivityWarning(live.length
          ? `None of this server's configured STUN servers are responding (${dead.join(', ')}). ` +
            'Haven is using its built-in servers for now so calls keep working, but an admin ' +
            'should fix or clear that setting in Settings, Voice & Connectivity.'
          : `None of this server's configured STUN servers are responding (${dead.join(', ')}). ` +
            'Calls will only work on your local network until an admin fixes them in ' +
            'Settings, Voice & Connectivity, or clears the setting to fall back on the defaults.'
        );
      }
    } catch (err) {
      console.warn('[Voice] Configured STUN probe failed:', err && err.message);
    }
  }

  async _probeDefaultStun() {
    try {
      // Need a tiny delay so _fetchIceServers can win the race if the
      // admin has configured their own servers; we don't want to clobber
      // those with probe results.
      await new Promise(r => setTimeout(r, 250));
      if (this._adminIceServersLoaded) return;
      // Relay-only deliberately discards srflx candidates, which is exactly
      // what this probe measures. Probing would report every STUN server dead.
      if (this._relayOnly) return;

      const preferred = await Promise.all(this._stunPreferred.map(u => this._probeStunUrl(u)));
      const livePreferred = preferred.filter(p => p.ok).map(p => p.url);

      if (this._adminIceServersLoaded) return; // admin won the race after all

      if (livePreferred.length) {
        this.rtcConfig.iceServers = livePreferred.map(urls => ({ urls }));
        console.log(`🧊 STUN probe: ${livePreferred.length}/${this._stunPreferred.length} preferred servers alive (${livePreferred.join(', ')})`);
        return;
      }

      // Every preferred server is unresponsive. Keep the original list
      // anyway: peers on the same LAN still connect via host candidates, and
      // one of the providers may come back up mid-call. We no longer fall
      // back to Google STUN; three independent providers is enough redundancy.
      console.error('[Voice] All preferred STUN servers failed probe; external WebRTC will be impaired until an admin configures STUN/TURN.');
      // Surface this to the user instead of leaving them stuck on
      // "ICE: Connecting..." with no explanation (#5399). LAN calls still
      // work, so keep it a warning, not a hard error.
      if (!this._connectivityWarned && typeof this.onConnectivityWarning === 'function') {
        this._connectivityWarned = true;
        this.onConnectivityWarning('Voice connection servers (STUN) are unreachable. Calls may only work on your local network until an admin sets STUN/TURN in Settings → Voice & Connectivity.');
      }
    } catch (err) {
      console.warn('[Voice] STUN probe failed:', err && err.message);
    }
  }

  // ── Session truth & self-repair ─────────────────────────
  //
  // `inVoice` / `currentChannel` are local bookkeeping, and the whole UI is
  // driven off them by fire-and-forget calls scattered across half a dozen
  // call sites. When they get out of step with reality there is nothing that
  // ever puts them back — the user is stranded looking at a "Join Voice"
  // button while still talking to their friends. The peer connections are the
  // real source of truth: if any of them is still connected, we are in voice,
  // whatever the flags say.

  liveVoicePeerCount() {
    let n = 0;
    for (const [, peer] of this.peers) {
      const cs = peer && peer.connection && peer.connection.connectionState;
      // Only 'connected' counts. 'new'/'connecting' would also match a peer
      // that is on its way out, and we must not resurrect a session the user
      // genuinely left.
      if (cs === 'connected') n++;
    }
    return n;
  }

  /**
   * Repair the "UI says I left but the media session is alive" desync.
   * Returns true if state was actually repaired.
   */
  reassertSessionIfLive() {
    if (this.inVoice && this.currentChannel) return false; // flags already agree
    const live = this.liveVoicePeerCount();
    const micLive = !!(this.localStream &&
      this.localStream.getTracks().some(t => t.readyState === 'live'));
    // Peers OR a still-live local mic count as "session alive". After a
    // maximize-triggered socket blip the peer map can briefly report 0
    // connected while the mic track and remote audio elements are still up.
    if (live === 0 && !micLive) return false;              // genuinely not in voice
    let code = this.currentChannel || this._softLeftChannel;
    if (!code) {
      try { code = localStorage.getItem('haven_voice_channel'); } catch { /* ignore */ }
    }
    if (!code) return false; // live media but no idea which channel — leave it alone
    console.warn('[Voice] Local state said not-in-voice but media is live',
      `(peers=${live}, micLive=${micLive}) — restoring session state for`, code);
    this.currentChannel = code;
    this.inVoice = true;
    this._voiceSessionGeneration = (this._voiceSessionGeneration || 0) + 1;
    this._softLeftChannel = null;
    try { localStorage.setItem('haven_voice_channel', code); } catch { /* ignore */ }
    // Our socket may have been rebound while we thought we were out; rejoin so
    // the server roster and our peers agree with us again. Throttled so a
    // repeatedly-failing repair can't spam signalling.
    const now = Date.now();
    if (this.socket && this.socket.connected && now - (this._lastReassertAt || 0) > 3000) {
      this._lastReassertAt = now;
      this.socket.emit('voice-rejoin', { code, nativeScreenVersion: 1 });
    }
    return true;
  }

  deferChannelGone(timeoutMs = 6000) {
    // Once the server has answered, reconnect flaps must not discard that
    // answer or extend its absolute deadline beyond the original window.
    if (this._deferredChannelGone) return;
    this._deferChannelGoneUntil = Date.now() + timeoutMs;
  }

  resolveDeferredChannelGone(recoveredCode = null) {
    this._deferChannelGoneUntil = 0;
    if (this._deferredChannelGoneTimer) {
      clearTimeout(this._deferredChannelGoneTimer);
      this._deferredChannelGoneTimer = null;
    }
    const pending = this._deferredChannelGone;
    this._deferredChannelGone = null;
    const sameSession = pending &&
      pending.generation === (this._voiceSessionGeneration || 0) &&
      pending.code === this.currentChannel;
    if (!recoveredCode && sameSession && this.inVoice) {
      console.warn('[Voice] Server confirmed voice channel is gone — leaving locally:', pending.code);
      try { this.leave(); } catch (e) { console.warn('[Voice] leave() during deferred voice-channel-gone failed:', e); }
    }
  }

  /**
   * Re-deliver every active sharer's screen to the UI. Used after the tiles
   * were torn down while the media session stayed alive — the packets never
   * stopped arriving, so in the common case this restores the picture without
   * any signalling at all.
   */
  reassertScreenStreams() {
    let restored = 0;
    for (const sharerId of this.screenSharers) {
      if (sharerId === this.localUserId) continue;
      this._screenDelivered.delete(sharerId);
      if (this._deliverScreenFromReceivers(sharerId)) restored++;
      else {
        this.requestScreenStream(sharerId);
        this._watchForScreenStream(sharerId);
      }
    }
    return restored;
  }

  // ── Perfect negotiation: glare tie-break ────────────────
  //
  // Exactly one side of each pair must be "polite" (yields to an incoming
  // offer) and the other "impolite" (ignores it and lets its own offer win).
  // Comparing user ids gives both ends the same verdict without extra
  // signalling. If we somehow don't know our own id yet, be polite —
  // yielding is always safe, whereas two impolite peers would deadlock.
  _isPolite(remoteUserId) {
    const mine = this.localUserId;
    if (mine == null || remoteUserId == null) return true;
    return Number(mine) < Number(remoteUserId);
  }

  // True when an incoming offer arrives while we have an offer of our own in
  // flight — the only situation where politeness matters.
  _isCollision(peer, connection) {
    return !!(peer && (peer._makingOffer || peer._awaitingAnswer ||
      connection.signalingState !== 'stable'));
  }

  // Opt-in Debug toggle (Settings -> Debug) for the #5444 glare/ICE-restart
  // recovery. Off by default while it's unverified in the field; read live so
  // flipping it takes effect on the next renegotiation without a reload.
  _glareIceRestartFixEnabled() {
    try { return localStorage.getItem('haven_voice_glare_ice_fix') === '1'; }
    catch { return false; }
  }

  // ── Socket event listeners ──────────────────────────────

  _setupSocketListeners() {
    // Server signalled the voice channel no longer exists (DB row gone,
    // or we were never a member). Stop the watchdog/self-heal loop by
    // fully tearing down local voice state so the client stops thinking
    // it's in voice on a dead channel.
    this.socket.on('voice-channel-gone', (data) => {
      if (!this.inVoice) return;
      if (this.currentChannel && data && data.code && data.code !== this.currentChannel) return;
      const remaining = (this._deferChannelGoneUntil || 0) - Date.now();
      if (remaining > 0) {
        this._deferredChannelGone = {
          code: data?.code || this.currentChannel,
          generation: this._voiceSessionGeneration || 0
        };
        if (this._deferredChannelGoneTimer) clearTimeout(this._deferredChannelGoneTimer);
        this._deferredChannelGoneTimer = setTimeout(() => {
          this._deferredChannelGoneTimer = null;
          this.resolveDeferredChannelGone(false);
        }, remaining);
        return;
      }
      console.warn('[Voice] Server says voice channel is gone — leaving locally:', data && data.code);
      try { this.leave(); } catch (e) { console.warn('[Voice] leave() during voice-channel-gone failed:', e); }
    });

    // We just joined: create peer connections + send offers to all existing users
    this.socket.on('voice-existing-users', async (data) => {
      const channelCode = data?.channelCode;
      const voiceGeneration = this._voiceSessionGeneration || 0;
      const stillCurrent = () => this.inVoice && this.currentChannel === channelCode &&
        (this._voiceSessionGeneration || 0) === voiceGeneration;
      if (!channelCode || !stillCurrent()) return;
      this._flushPendingScreenStop(channelCode);
      // Apply audio bitrate cap from channel settings
      this.audioBitrate = data.voiceBitrate || 0;
      if (data.rejoin && !data.skipRenegotiate) {
        this._reannounceScreenShare(data.users || [], { channelCode, voiceGeneration }).catch(err => {
          console.warn('[NativeScreen] Failed to restore screen share after voice rejoin:', err);
        });
      }
      // Fast-path: server told us this is a transient rejoin and our
      // existing RTCPeerConnections are still live. Skip creating fresh
      // peers — that would tear down working audio for no reason. See
      // [VoiceDiag] fast-path in src/socketHandlers/voice.js.
      if (data.skipRenegotiate) {
        console.log('[Voice] voice-existing-users with skipRenegotiate — keeping existing peers');
        // Still re-arm screen recovery. A blip that kept the peer
        // connection "connected" can still drop the screen video track
        // (transceiver goes muted / track ends) without tearing voice
        // down. Without this, streams that were visible at startup
        // vanish until the sharer fully restreams.
        this._rearmScreenWatchdogs();
        return;
      }
      // Safety net: even without the skipRenegotiate flag, never tear down
      // a healthy session. Resize/maximize used to trigger voice-rejoin →
      // voice-existing-users without skip, and _createPeer() destroyed every
      // live peer (killing the stream tile while audio sometimes limped on
      // a half-closed path). Only build peers we don't already have.
      if (this.inVoice && this.peers.size > 0) {
        const missing = (data.users || []).filter(u => u && !this.peers.has(u.id));
        console.warn('[Voice] voice-existing-users during live session — keeping peers, adding missing only', {
          existing: this.peers.size,
          missing: missing.length
        });
        for (const user of missing) {
          if (!stillCurrent()) return;
          await this._createPeer(user.id, user.username, true);
        }
        this._rearmScreenWatchdogs();
        return;
      }
      for (const user of data.users) {
        if (!stillCurrent()) return;
        await this._createPeer(user.id, user.username, true);
      }
    });

    // Someone new joined our voice channel — they'll send us an offer
    this.socket.on('voice-user-joined', (data) => {
      // The new user handles creating offers to existing users,
      // so we just wait for their offer via 'voice-offer'.
      if (this.onVoiceJoin && data && data.user) {
        this.onVoiceJoin(data.user.id, data.user.username);
      }
    });

    // Received an offer — create peer & answer
    this.socket.on('voice-offer', async (data) => {
      const { from, offer } = data;

      let peer = this.peers.get(from.id);
      // If we have a stale peer (connection failed/closed/disconnected from a
      // previous session — e.g. the remote user just reconnected), tear it
      // down so we negotiate a clean RTCPeerConnection. Without this, the
      // setRemoteDescription below applies the new offer on top of dead ICE
      // and the audio never recovers — see #5347 ("rejoin doesn't restore
      // audio until you leave and rejoin again").
      if (peer) {
        const cs = peer.connection.connectionState;
        const ics = peer.connection.iceConnectionState;
        if (cs === 'failed' || cs === 'closed' ||
            ics === 'failed' || ics === 'closed') {
          this._removePeer(from.id);
          peer = null;
        }
      }
      if (!peer) {
        await this._createPeer(from.id, from.username, false);
        peer = this.peers.get(from.id);
        // Inherit any candidates that arrived before _createPeer ran.
        if (peer && this._pendingCandidatesByUser && this._pendingCandidatesByUser.has(from.id)) {
          peer._pendingCandidates = (peer._pendingCandidates || []).concat(
            this._pendingCandidatesByUser.get(from.id)
          );
          this._pendingCandidatesByUser.delete(from.id);
        }
      }

      try {
        const conn = peer.connection;
        peer._handlingRemoteOffer = true;

        // ── Glare handling (perfect negotiation) ──────────────
        //
        // Both sides of a Haven peer connection can initiate a renegotiation
        // (screen share start/stop, webcam, ICE restart, the server's
        // renegotiate-screen nudge to a late joiner…), so simultaneous offers
        // are routine. Until now BOTH sides rolled back their own offer and
        // answered the other's. That looks symmetric but is actually broken:
        // each peer ends up having applied the *other's* offer and its own
        // answer, and neither peer's answer is ever applied by the other. The
        // two halves describe different negotiations, so the ICE/DTLS
        // parameters don't line up and media dies in both directions — while
        // signalingState sits happily at 'stable' so nothing self-heals.
        //
        // This is the "rejoined voice and can't hear one specific person"
        // report: the joiner's fresh offer collided with the renegotiate-screen
        // offer the server asks active sharers to send to new joiners, so it
        // only ever hit whoever happened to be streaming.
        //
        // Perfect negotiation needs exactly one polite peer. Tie-break on user
        // id — deterministic and both sides compute the same answer.
        if (this._isCollision(peer, conn) && !this._isPolite(from.id)) {
          // Impolite peer: ignore the incoming offer. The polite side will roll
          // its own offer back and answer ours, so we still converge — with one
          // negotiation instead of two conflicting ones.
          console.warn('[Voice] offer glare with', from.id, '— ignoring their offer (we are impolite)');
          return;
        }

        // Polite peer: our offer yields. Clear the in-flight flags so the
        // post-answer drain can re-issue one fresh follow-up offer afterwards
        // if we still have local changes to publish.
        const hadPendingLocalChanges = peer._makingOffer || peer._awaitingAnswer;
        const rolledBackIceRestart = !!peer._offerIsIceRestart;
        const activeOfferId = peer._activeOfferId;
        if (conn.signalingState !== 'stable') {
          this._clearOfferAnswerTimer(peer);
          try {
            await conn.setLocalDescription({ type: 'rollback' });
          } catch (err) {
            if (conn.signalingState !== 'stable') {
              if (peer._awaitingAnswer && activeOfferId && conn.signalingState !== 'closed') {
                this._scheduleOfferAnswerTimeout(from.id, conn, activeOfferId);
              }
              throw err;
            }
          }
        }
        this._clearOfferAnswerTimer(peer);
        peer._makingOffer = false;
        peer._awaitingAnswer = false;
        peer._activeOfferId = null;
        peer._offerIsIceRestart = false;
        peer._offerChannelCode = null;
        // Anything we were trying to publish (added screen tracks, an ICE
        // restart) was just discarded with the rollback. Queue it so the drain
        // after this answer re-offers it, rather than silently losing it.
        if (hadPendingLocalChanges) {
          peer._renegotiateQueued = true;
          // (#5444, opt-in Debug toggle) When the offer we just rolled back was
          // an ICE restart, the drain used to re-issue it as a *plain*
          // renegotiation because the restart intent wasn't carried across the
          // rollback. On a reconnect where both peers ICE-restart at once (the
          // #5427 heal), that left the media path un-restarted and crossed the
          // two sides' ICE credentials — producing "answer indicates ICE
          // restart but offer did not request ICE restart" plus a flood of
          // "Unknown ufrag" candidate errors, and audio stayed dead until a
          // manual rejoin. Re-queuing the restart makes the follow-up offer
          // actually restart ICE. Gated behind a toggle while it's unverified
          // in the field (Settings -> Debug).
          if (rolledBackIceRestart && this._glareIceRestartFixEnabled()) {
            peer._queuedIceRestart = true;
          }
        }
        await conn.setRemoteDescription(new RTCSessionDescription(offer));
        if (typeof data.offerId === 'string') peer._supportsOfferIds = true;
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);

        this.socket.emit('voice-answer', {
          code: this.currentChannel,
          targetUserId: from.id,
          answer: answer,
          offerId: typeof data.offerId === 'string' ? data.offerId : undefined
        });

        // Flush any ICE candidates that arrived before the remote
        // description was set. Without this, intermittently a late-joiner's
        // first peer can't hear the existing user (or vice-versa) until one
        // of them rejoins the channel — the lost candidates leave the
        // connection unable to traverse NAT. (haven#vc-late-join)
        if (peer._pendingCandidates && peer._pendingCandidates.length) {
          for (const c of peer._pendingCandidates) {
            try { await conn.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* ignore */ }
          }
          peer._pendingCandidates = [];
        }
      } catch (err) {
        console.error('Error handling voice offer:', err);
      } finally {
        const latestPeer = this.peers.get(from.id);
        if (latestPeer && latestPeer.connection === peer?.connection) {
          latestPeer._handlingRemoteOffer = false;
        }
        if (latestPeer && latestPeer.connection === peer?.connection && latestPeer.connection.signalingState === 'stable') {
          latestPeer._awaitingAnswer = false;
          this._drainQueuedRenegotiation(from.id);
        }
      }
    });

    // Received an answer to our offer
    this.socket.on('voice-answer', async (data) => {
      const peer = this.peers.get(data.from.id);
      if (peer) {
        const answerOfferId = typeof data.offerId === 'string' ? data.offerId : null;
        if (answerOfferId) peer._supportsOfferIds = true;
        const staleCorrelatedAnswer = peer._activeOfferId && answerOfferId &&
          answerOfferId !== peer._activeOfferId;
        const unsafeLegacyAnswer = peer._activeOfferId && !answerOfferId &&
          (peer._supportsOfferIds || (peer._offerTimeoutCount || 0) > 0);
        if (staleCorrelatedAnswer || unsafeLegacyAnswer) {
          console.warn('[Voice] Ignoring stale answer for peer', data.from.id,
            `(expected ${peer._activeOfferId}, received ${answerOfferId || 'no offer id'})`);
          return;
        }
        try {
          // Only accept answer if we're actually waiting for one
          // (we may have rolled back our offer due to glare)
          if (peer.connection.signalingState === 'have-local-offer') {
            await peer.connection.setRemoteDescription(new RTCSessionDescription(data.answer));
            this._clearOfferAnswerTimer(peer);
            peer._awaitingAnswer = false;
            peer._activeOfferId = null;
            peer._offerTimeoutCount = 0;
            peer._offerRecoveryExhausted = false;
            peer._offerIsIceRestart = false;
            peer._offerChannelCode = null;
            // Flush buffered ICE candidates that arrived before the answer
            if (peer._pendingCandidates && peer._pendingCandidates.length) {
              for (const c of peer._pendingCandidates) {
                try { await peer.connection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* ignore */ }
              }
              peer._pendingCandidates = [];
            }
          } else if (peer._awaitingAnswer && peer.connection.signalingState === 'stable') {
            // Stale answer for a local offer we already rolled back after glare.
            this._clearOfferAnswerTimer(peer);
            peer._awaitingAnswer = false;
            peer._activeOfferId = null;
          }
        } catch (err) {
          console.error('Error handling voice answer:', err);
          if (peer._awaitingAnswer && peer.connection.signalingState === 'stable') {
            this._clearOfferAnswerTimer(peer);
            peer._awaitingAnswer = false;
            peer._activeOfferId = null;
          }
        } finally {
          if (peer.connection.signalingState === 'stable') {
            this._drainQueuedRenegotiation(data.from.id);
          }
        }
      }
    });

    // Received an ICE candidate
    this.socket.on('voice-ice-candidate', async (data) => {
      const peer = this.peers.get(data.from.id);
      if (!data.candidate) return;
      if (peer) {
        // If remote description isn't set yet, the peer connection will
        // throw when adding candidates. Buffer them until the offer is
        // applied, then flush in the voice-offer handler. This fixes the
        // intermittent "can't hear new joiner" bug where the offer and
        // candidates raced and the candidates were silently dropped.
        if (!peer.connection.remoteDescription || !peer.connection.remoteDescription.type) {
          (peer._pendingCandidates ||= []).push(data.candidate);
          return;
        }
        try {
          await peer.connection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.error('Error adding ICE candidate:', err);
        }
      } else {
        // Peer not yet created — stash the candidate so it can be applied
        // once the offer arrives and _createPeer runs.
        (this._pendingCandidatesByUser ||= new Map());
        const list = this._pendingCandidatesByUser.get(data.from.id) || [];
        list.push(data.candidate);
        this._pendingCandidatesByUser.set(data.from.id, list);
      }
    });

    // Server relays speaking state from any voice user (including self)
    this.socket.on('voice-speaking', (data) => {
      if (data && data.userId != null) {
        const uid = data.userId === this.localUserId ? 'self' : data.userId;
        // Persist to talkingState so a re-render of the voice user list
        // (e.g. after mute toggle or user join/leave) doesn't wipe the
        // talking-class highlight on the local user.  For remote users
        // _startAnalyser already keeps this in sync via WebRTC analysis,
        // but the local user has no peer analyser, so we mirror the
        // server-relayed state here.
        if (data.speaking) this.talkingState.set(uid, true);
        else this.talkingState.delete(uid);
        if (this.onTalkingChange) this.onTalkingChange(uid, !!data.speaking);
      }
    });

    // Someone left voice
    this.socket.on('voice-user-left', (data) => {
      if (this.onVoiceLeave && data && data.user) {
        this.onVoiceLeave(data.user.id, data.user.username);
      }
      this._stopAnalyser(data.user.id);
      this._removePeer(data.user.id);
      this._closeNativeScreenPeer(data.user.id);
      this._nativeScreenAnnouncements.delete(data.user.id);
      if (this._nativeScreenSharing) {
        for (const key of this._nativeScreenSenderStates.keys()) {
          if (key.startsWith(`${data.user.id}:`)) this._nativeScreenSenderStates.delete(key);
        }
        window.havenDesktop?.nativeScreen?.removePeer?.({
          peerId: data.user.id,
          sessionId: this._nativeScreenSessionId,
        }).catch(() => {});
      }
      // If they were screen sharing, clean up
      this._screenDelivered.delete(data.user.id);
      if (this.screenSharers.has(data.user.id)) {
        this.screenSharers.delete(data.user.id);
        if (this.onScreenStream) this.onScreenStream(data.user.id, null);
      }
      // If they had their webcam on, clean up
      if (this.webcamUsers.has(data.user.id)) {
        this.webcamUsers.delete(data.user.id);
        if (this.onWebcamStream) this.onWebcamStream(data.user.id, null);
      }
    });

    // Channel voice bitrate was changed mid-session
    this.socket.on('voice-bitrate-updated', (data) => {
      if (data && data.code === this.currentChannel) {
        this.audioBitrate = data.bitrate || 0;
        // Reapply to all existing peer connections
        for (const [, peer] of this.peers) {
          this._applyAudioBitrate(peer.connection);
        }
      }
    });

    // AFK auto-move: server says we've been idle too long
    this.socket.on('voice-afk-move', async (data) => {
      if (!data || !data.channelCode) return;
      // Leave current voice channel
      this.leave();
      // Notify the app layer
      if (this.onAfkMove) this.onAfkMove(data.channelCode);
    });

    // Kicked from voice because user joined from another client/tab
    this.socket.on('voice-kicked', (data) => {
      if (!data || !data.channelCode) return;
      // Only act if we're currently in the channel we got kicked from
      if (this.currentChannel !== data.channelCode) return;
      this.leave();
      if (this.onVoiceKicked) this.onVoiceKicked(data.channelCode, data.reason);
    });

    // Someone started screen sharing
    this.socket.on('screen-share-started', (data) => {
      if (!data || data.channelCode !== this.currentChannel) return;
      this.screenSharers.add(data.userId);
      this._cancelScreenWatchdog(data.userId);
      this._closeNativeScreenPeer(data.userId);
      if (data.transport === 'native' && data.sessionId) {
        this._nativeScreenAnnouncements.set(data.userId, data.sessionId);
      } else {
        this._nativeScreenAnnouncements.delete(data.userId);
      }
      // New share — the previous one's delivery says nothing about this one.
      this._screenDelivered.delete(data.userId);
      // A deliberate new share deserves a clean renegotiation budget; the
      // cap exists to stop a loop on one stuck share, not to punish someone
      // who stopped and started again. (#5426)
      if (this.onScreenShareRestart) this.onScreenShareRestart(data.userId);
      // Play stream start notification sound
      if (this.onScreenShareStarted) {
        this.onScreenShareStarted(data.userId, data.username);
      }
      // Notify UI about audio availability for this stream
      if (!data.hasAudio && this.onScreenNoAudio) {
        this.onScreenNoAudio(data.userId);
      }
      // Re-render the voice user list so the streaming indicator next to
      // the sharer's name appears immediately.  Without this the icon was
      // invisible until the local user happened to do something that
      // refreshed the list (e.g. start sharing themselves).
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();

      // Safety net: if screen-share-started fires but the video never reaches
      // our UI — the renegotiation offer was dropped, the sharer's
      // _renegotiate bailed on a non-stable signaling state, or the reshare
      // coalesced so no track event fired — recover instead of leaving the
      // viewer with a LIVE badge and an empty grid. (#5347 v3.15.5)
      this._watchForScreenStream(data.userId);
    });

    // Someone stopped screen sharing
    this.socket.on('screen-share-stopped', (data) => {
      if (!data || data.channelCode !== this.currentChannel) return;
      this.screenSharers.delete(data.userId);
      this._cancelScreenWatchdog(data.userId);
      this._screenDelivered.delete(data.userId);
      this._closeNativeScreenPeer(data.userId);
      this._nativeScreenAnnouncements.delete(data.userId);
      if (this.onScreenStream) this.onScreenStream(data.userId, null);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    this.socket.on('native-screen-incompatible-peer', data => {
      if (!this._nativeScreenSharing || data?.channelCode !== this.currentChannel ||
          data.sessionId !== this._nativeScreenSessionId) return;
      console.warn('[NativeScreen] Stopping because a viewer does not support native screen transport');
      if (this.onScreenShareWarning) this.onScreenShareWarning();
      this.stopScreenShare().catch(err => {
        console.warn('[NativeScreen] Failed to stop incompatible native share:', err);
      });
    });

    this.socket.on('native-screen-offer', data => {
      this._handleNativeScreenOffer(data).catch(err => {
        console.error('[NativeScreen] Failed to accept offer:', err);
      });
    });

    this.socket.on('native-screen-answer', data => {
      this._handleNativeScreenAnswer(data).catch(err => {
        console.warn('[NativeScreen] Failed to apply answer:', err);
      });
    });

    this.socket.on('native-screen-ice-candidate', data => {
      this._handleNativeScreenIceCandidate(data).catch(err => {
        console.warn('[NativeScreen] Failed to apply ICE candidate:', err);
      });
    });

    // Someone started their webcam
    this.socket.on('webcam-started', (data) => {
      this.webcamUsers.add(data.userId);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    // Someone stopped their webcam
    this.socket.on('webcam-stopped', (data) => {
      this.webcamUsers.delete(data.userId);
      if (this.onWebcamStream) this.onWebcamStream(data.userId, null);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    // Late joiner: server tells us about active screen sharers
    this.socket.on('active-screen-sharers', (data) => {
      if (data?.channelCode === this.currentChannel && data.sharers) {
        const active = new Map(data.sharers.map(sharer => [sharer.id, sharer]));
        for (const sharerId of Array.from(this.screenSharers)) {
          if (active.has(sharerId)) continue;
          if (sharerId === this.localUserId && this.isScreenSharing) continue;
          this.screenSharers.delete(sharerId);
          this._cancelScreenWatchdog(sharerId);
          this._screenDelivered.delete(sharerId);
          this._closeNativeScreenPeer(sharerId);
          this._nativeScreenAnnouncements.delete(sharerId);
          if (this.onScreenStream) this.onScreenStream(sharerId, null);
        }
        data.sharers.forEach(s => {
          if (s.id === this.localUserId && !this.isScreenSharing) return;
          this.screenSharers.add(s.id);
          if (s.transport === 'native' && s.sessionId) {
            const previousSession = this._nativeScreenAnnouncements.get(s.id);
            if (previousSession && previousSession !== s.sessionId) {
              this._closeNativeScreenPeer(s.id);
              this._screenDelivered.delete(s.id);
              if (this.onScreenStream) this.onScreenStream(s.id, null);
            }
            this._nativeScreenAnnouncements.set(s.id, s.sessionId);
          } else {
            if (this._nativeScreenAnnouncements.has(s.id)) {
              this._closeNativeScreenPeer(s.id);
              this._screenDelivered.delete(s.id);
              if (this.onScreenStream) this.onScreenStream(s.id, null);
            }
            this._nativeScreenAnnouncements.delete(s.id);
          }
          // Late joiners never receive 'screen-share-started', so they never
          // armed the silent-failure recovery watchdog. Arm it here so a
          // dropped or late late-join renegotiation self-heals instead of
          // stranding the viewer with a LIVE badge and no video.
          if (s.id !== this.localUserId) this._watchForScreenStream(s.id);
        });
        if (this.isScreenSharing && this.localUserId != null) {
          this.screenSharers.add(this.localUserId);
        }
        if (this.onWebcamStatusChange) this.onWebcamStatusChange();
      }
    });

    // Late joiner: server tells us about active webcam users
    this.socket.on('active-webcam-users', (data) => {
      if (data && data.users) {
        data.users.forEach(u => this.webcamUsers.add(u.id));
        if (this.onWebcamStatusChange) this.onWebcamStatusChange();
      }
    });

    // Server asks us to renegotiate our screen share with a late joiner
    this.socket.on('renegotiate-screen', async (data) => {
      if (!this.isScreenSharing || data?.channelCode !== this.currentChannel) return;
      const targetUserId = data && data.targetUserId;
      if (targetUserId == null) return;

      if (this._nativeScreenSharing) {
        this._replaceNativeScreenPeer(targetUserId).catch(err => {
          console.warn('[NativeScreen] Failed to renegotiate native peer:', err);
        });
        return;
      }
      if (!this.screenStream) return;

      // Peer may not exist yet (joiner's offer still in flight). Retry a
      // few times instead of silently dropping the request — that silent
      // drop is a common "stream visible at join, then gone forever"
      // path: server fires renegotiate-screen at T+2s, joiner's peer
      // isn't registered yet, and nothing ever re-asks.
      const tryRenegotiate = async (attemptsLeft) => {
        if (!this.screenStream || !this.isScreenSharing) return;
        const peer = this.peers.get(targetUserId);
        if (!peer) {
          if (attemptsLeft > 0) {
            setTimeout(() => { tryRenegotiate(attemptsLeft - 1); }, 750);
          } else {
            console.warn('[Voice] renegotiate-screen: no peer for', targetUserId, 'after retries');
          }
          return;
        }
        const conn = peer.connection;
        if (!conn || conn.connectionState === 'closed') {
          if (attemptsLeft > 0) setTimeout(() => { tryRenegotiate(attemptsLeft - 1); }, 750);
          return;
        }

        // Add screen share tracks if they aren't already on this peer.
        // Match by track identity — the previous "any video sender" check
        // wrongly considered a webcam sender as proof that the screen tracks
        // were already attached, leaving late joiners with audio but no
        // screen video when the sharer also had their webcam on.
        // (#5347 v3.15.5)
        const senders = conn.getSenders();
        const screenTracks = this.screenStream.getTracks().filter(t => t.readyState === 'live');
        const missing = screenTracks.filter(track => !senders.some(s => s.track === track));
        if (missing.length) {
          missing.forEach(track => conn.addTrack(track, this.screenStream));
          const res = this.screenResolution;
          const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
          this._applyScreenBitrate(conn, maxBitrate);
        }

        // Renegotiate to include the video tracks (or refresh an existing
        // screen-share m-section that the receiver lost frames on)
        await this._renegotiate(targetUserId, conn);
      };
      tryRenegotiate(6);
    });

    // Server asks us to renegotiate our webcam with a late joiner
    this.socket.on('renegotiate-webcam', async (data) => {
      if (!this.webcamStream || !this.isWebcamActive) return;
      const peer = this.peers.get(data.targetUserId);
      if (!peer) return;
      const conn = peer.connection;

      // Add webcam track if not already on this peer
      const senders = conn.getSenders();
      const webcamTrack = this.webcamStream.getVideoTracks()[0];
      const alreadySent = webcamTrack && senders.some(s => s.track === webcamTrack);
      if (!alreadySent && webcamTrack) {
        conn.addTrack(webcamTrack, this.webcamStream);
      }

      await this._renegotiate(data.targetUserId, conn);
    });
  }

  _setupNativeScreenBridge() {
    const api = window.havenDesktop?.nativeScreen;
    if (!api?.onSignal) return;
    api.onSignal(signal => {
      if (!this._nativeScreenSharing || !signal || signal.sessionId !== this._nativeScreenSessionId) return;
      if (signal.type === 'error') {
        console.error('[NativeScreen]', signal.message || 'Native media process failed');
        if (signal.fatal) this._handleNativeScreenFailure(signal.message);
        return;
      }
      const common = {
        code: this.currentChannel,
        targetUserId: signal.peerId,
        sessionId: signal.sessionId,
        negotiationId: signal.negotiationId,
      };
      if (!common.code || common.targetUserId == null || !common.negotiationId) return;
      if (signal.type === 'offer' && signal.description) {
        for (const key of this._nativeScreenSenderStates.keys()) {
          if (key.startsWith(`${signal.peerId}:`)) this._nativeScreenSenderStates.delete(key);
        }
        this._nativeScreenSenderStates.set(
          `${signal.peerId}:${signal.sessionId}:${signal.negotiationId}`,
          {
          ready: false,
          applying: null,
          candidates: [],
          }
        );
        this.socket.emit('native-screen-offer', { ...common, offer: signal.description });
      } else if (signal.type === 'ice-candidate') {
        this.socket.emit('native-screen-ice-candidate', {
          ...common,
          candidate: signal.candidate || null,
        });
      }
    });
  }

  async _handleNativeScreenOffer(data) {
    const sharerId = data?.from?.id;
    if (sharerId == null || data.channelCode !== this.currentChannel) return;
    if (!this.screenSharers.has(sharerId) || !data.offer || !data.sessionId || !data.negotiationId) return;
    if (this._nativeScreenAnnouncements.get(sharerId) !== data.sessionId) return;

    const pendingKey = `${sharerId}:${data.sessionId}:${data.negotiationId}`;
    this._closeNativeScreenPeer(sharerId, data.sessionId, data.negotiationId);
    const connection = new RTCPeerConnection(this.rtcConfig);
    const entry = {
      connection,
      sessionId: data.sessionId,
      negotiationId: data.negotiationId,
      disconnectTimer: null,
    };
    this._nativeScreenPeers.set(sharerId, entry);

    connection.onicecandidate = event => {
      if (this._nativeScreenPeers.get(sharerId) !== entry) return;
      this.socket.emit('native-screen-ice-candidate', {
        code: this.currentChannel,
        targetUserId: sharerId,
        sessionId: entry.sessionId,
        negotiationId: entry.negotiationId,
        candidate: event.candidate?.toJSON?.() || event.candidate || null,
      });
    };
    connection.ontrack = event => {
      if (this._nativeScreenPeers.get(sharerId) !== entry || event.track.kind !== 'video') return;
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this._screenDelivered.add(sharerId);
      if (this.onScreenStream) this.onScreenStream(sharerId, stream);
      event.track.onended = () => {
        if (this._nativeScreenPeers.get(sharerId) !== entry) return;
        this._recoverNativeScreenPeer(sharerId);
      };
    };
    connection.onconnectionstatechange = () => {
      if (this._nativeScreenPeers.get(sharerId) !== entry) return;
      if (connection.connectionState === 'connected' && entry.disconnectTimer) {
        clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = null;
      }
      if (connection.connectionState === 'failed') {
        this._recoverNativeScreenPeer(sharerId);
      } else if (connection.connectionState === 'disconnected' && !entry.disconnectTimer) {
        entry.disconnectTimer = setTimeout(() => {
          if (this._nativeScreenPeers.get(sharerId) !== entry ||
              connection.connectionState !== 'disconnected') return;
          this._recoverNativeScreenPeer(sharerId);
        }, 5000);
      }
    };

    await connection.setRemoteDescription(data.offer);
    if (this._nativeScreenPeers.get(sharerId) !== entry) return;
    const pending = this._pendingNativeScreenCandidates.get(pendingKey) || [];
    this._pendingNativeScreenCandidates.delete(pendingKey);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (this._nativeScreenPeers.get(sharerId) !== entry) return;
    this.socket.emit('native-screen-answer', {
      code: this.currentChannel,
      targetUserId: sharerId,
      sessionId: entry.sessionId,
      negotiationId: entry.negotiationId,
      answer: { type: answer.type, sdp: answer.sdp },
    });

    for (const candidate of pending) {
      if (candidate) await connection.addIceCandidate(candidate).catch(() => {});
    }
  }

  async _handleNativeScreenIceCandidate(data) {
    const remoteId = data?.from?.id;
    if (remoteId == null || data.channelCode !== this.currentChannel ||
        !data.sessionId || !data.negotiationId) return;

    if (this._nativeScreenSharing && data.sessionId === this._nativeScreenSessionId) {
      const key = `${remoteId}:${data.sessionId}:${data.negotiationId}`;
      const state = this._nativeScreenSenderStates.get(key);
      if (!state) return;
      if (!state.ready) {
        state.candidates.push(data.candidate || null);
        state.candidates = state.candidates.slice(-64);
        return;
      }
      const pending = window.havenDesktop?.nativeScreen?.addIceCandidate?.({
        peerId: remoteId,
        sessionId: data.sessionId,
        negotiationId: data.negotiationId,
        candidate: data.candidate || null,
      });
      await this._withNativeScreenTimeout(pending, 'add ICE candidate');
      return;
    }

    if (this._nativeScreenAnnouncements.get(remoteId) !== data.sessionId) return;

    const entry = this._nativeScreenPeers.get(remoteId);
    if (!entry || entry.sessionId !== data.sessionId ||
        entry.negotiationId !== data.negotiationId || !entry.connection.remoteDescription) {
      const key = `${remoteId}:${data.sessionId}:${data.negotiationId}`;
      const pending = this._pendingNativeScreenCandidates.get(key) || [];
      if (!this._pendingNativeScreenCandidates.has(key)) {
        const prefix = `${remoteId}:${data.sessionId}:`;
        const matching = Array.from(this._pendingNativeScreenCandidates.keys())
          .filter(candidateKey => candidateKey.startsWith(prefix));
        while (matching.length >= 4) {
          this._pendingNativeScreenCandidates.delete(matching.shift());
        }
      }
      pending.push(data.candidate || null);
      this._pendingNativeScreenCandidates.set(key, pending.slice(-64));
      return;
    }
    if (data.candidate) await entry.connection.addIceCandidate(data.candidate);
  }

  async _handleNativeScreenAnswer(data) {
    const peerId = data?.from?.id;
    if (!this._nativeScreenSharing || peerId == null ||
        data?.channelCode !== this.currentChannel ||
        data.sessionId !== this._nativeScreenSessionId || !data.negotiationId) return;
    const api = window.havenDesktop?.nativeScreen;
    if (!api?.setRemoteDescription) return;
    const key = `${peerId}:${data.sessionId}:${data.negotiationId}`;
    const state = this._nativeScreenSenderStates.get(key);
    if (!state) return;
    if (state.ready) return;
    if (state.applying) return state.applying;

    state.applying = (async () => {
      try {
        await this._withNativeScreenTimeout(api.setRemoteDescription({
          peerId,
          sessionId: data.sessionId,
          negotiationId: data.negotiationId,
          description: data.answer,
        }), 'set remote description');
        while (state.candidates.length) {
          const candidates = state.candidates.splice(0);
          for (const candidate of candidates) {
            await this._withNativeScreenTimeout(api.addIceCandidate({
              peerId,
              sessionId: data.sessionId,
              negotiationId: data.negotiationId,
              candidate,
            }), 'add ICE candidate');
          }
        }
        state.ready = true;
      } catch (err) {
        if (this._nativeScreenSenderStates.get(key) === state) {
          this._nativeScreenSenderStates.delete(key);
          await this._withNativeScreenTimeout(
            api.removePeer?.({ peerId, sessionId: data.sessionId }),
            'remove peer'
          ).catch(() => {});
        }
        throw err;
      } finally {
        if (this._nativeScreenSenderStates.get(key) === state) state.applying = null;
      }
    })();
    return state.applying;
  }

  async _replaceNativeScreenPeer(peerId, expectedSessionId = this._nativeScreenSessionId) {
    if (!this._nativeScreenSharing || peerId == null ||
        this._nativeScreenSessionId !== expectedSessionId) return;
    const api = window.havenDesktop?.nativeScreen;
    const sessionId = expectedSessionId;
    for (const key of this._nativeScreenSenderStates.keys()) {
      if (key.startsWith(`${peerId}:`)) this._nativeScreenSenderStates.delete(key);
    }
    await this._withNativeScreenTimeout(
      api?.removePeer?.({ peerId, sessionId }),
      'remove peer'
    ).catch(() => {});
    if (!this._nativeScreenSharing || this._nativeScreenSessionId !== sessionId) return;
    await this._withNativeScreenTimeout(api?.addPeer?.({ peerId, sessionId }), 'add peer');
  }

  async _reannounceScreenShare(users, context = {}) {
    const channelCode = context.channelCode || this.currentChannel;
    const voiceGeneration = context.voiceGeneration ?? (this._voiceSessionGeneration || 0);
    const nativeSessionId = this._nativeScreenSessionId;
    const screenStream = this.screenStream;
    const isCurrent = () => this.isScreenSharing && this.currentChannel === channelCode &&
      (this._voiceSessionGeneration || 0) === voiceGeneration;
    if (!channelCode || !isCurrent()) return;
    if (this._nativeScreenSharing && nativeSessionId) {
      const response = await this._emitScreenStart({
        code: channelCode,
        hasAudio: false,
        transport: 'native',
        sessionId: nativeSessionId,
      });
      if (!response.ok || !isCurrent()) {
        await this.stopScreenShare();
        return false;
      }
      const peerIds = Array.isArray(response.viewerIds) ? response.viewerIds : [];
      await Promise.allSettled(peerIds.map(peerId =>
        this._replaceNativeScreenPeer(peerId, nativeSessionId)
      ));
      return true;
    }
    if (!screenStream || this._nativeScreenSharing) return;
    const response = await this._emitScreenStart({
      code: channelCode,
      hasAudio: screenStream.getAudioTracks().length > 0,
      transport: 'browser',
    });
    if (!response.ok || !isCurrent()) {
      await this.stopScreenShare();
      return false;
    }
    return true;
  }

  _closeNativeScreenPeer(userId, preserveSessionId = null, preserveNegotiationId = null) {
    const entry = this._nativeScreenPeers.get(userId);
    if (entry) {
      this._nativeScreenPeers.delete(userId);
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      try { entry.connection.close(); } catch {}
    }
    for (const key of this._pendingNativeScreenCandidates.keys()) {
      if (key.startsWith(`${userId}:`) &&
          key !== `${userId}:${preserveSessionId}:${preserveNegotiationId}`) {
        this._pendingNativeScreenCandidates.delete(key);
      }
    }
  }

  _recoverNativeScreenPeer(userId) {
    this._screenDelivered.delete(userId);
    if (this.onScreenStream) this.onScreenStream(userId, null);
    this._closeNativeScreenPeer(userId);
    if (!this.screenSharers.has(userId)) return;
    this.requestScreenStream(userId);
    this._cancelScreenWatchdog(userId);
    this._watchForScreenStream(userId);
  }

  _closeAllNativeScreenPeers() {
    for (const userId of Array.from(this._nativeScreenPeers.keys())) {
      this._closeNativeScreenPeer(userId);
    }
    this._pendingNativeScreenCandidates.clear();
    this._nativeScreenAnnouncements.clear();
    for (const sharerId of this._screenWatchdogTimers.keys()) {
      this._cancelScreenWatchdog(sharerId);
    }
  }

  _handleNativeScreenFailure(message) {
    if (!this._nativeScreenSharing) return;
    console.error('[NativeScreen] Stopping failed native share:', message || 'unknown error');
    this.stopScreenShare().catch(err => {
      console.warn('[NativeScreen] Failed to clean up native share:', err);
    });
  }

  _withNativeScreenTimeout(promise, operation) {
    const timeoutMs = this._nativeScreenOperationTimeoutMs || 10000;
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native screen ${operation} timed out`)), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  _screenSignalCode(originalCode, voiceGeneration) {
    if (this.inVoice && this.currentChannel &&
        (this._voiceSessionGeneration || 0) === voiceGeneration) {
      return this.currentChannel;
    }
    return originalCode;
  }

  _emitScreenStart(payload) {
    return new Promise(resolve => {
      if (!this.socket || this.socket.connected === false) {
        resolve({ ok: false, error: 'disconnected' });
        return;
      }
      let settled = false;
      const finish = response => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response && typeof response === 'object'
          ? response
          : { ok: false, error: 'invalid_ack' });
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 3000);
      this.socket.emit('screen-share-started', payload, finish);
    });
  }

  _emitOrQueueScreenStop(code, sessionId = null) {
    this._pendingScreenStop = { code, sessionId };
    return this._sendPendingScreenStop();
  }

  _sendPendingScreenStop() {
    const pending = this._pendingScreenStop;
    if (!pending?.code || this.socket?.connected === false) return false;
    const payload = { code: pending.code };
    if (pending.sessionId) payload.sessionId = pending.sessionId;
    this.socket.emit('screen-share-stopped', payload, response => {
      if (response?.ok && this._pendingScreenStop === pending) {
        this._pendingScreenStop = null;
      }
    });
    return true;
  }

  _flushPendingScreenStop(channelCode = this.currentChannel) {
    if (!this._pendingScreenStop || !channelCode || this.socket?.connected === false) return false;
    this._pendingScreenStop.code = channelCode;
    return this._sendPendingScreenStop();
  }

  _isScreenStartValid(operation, channelCode, voiceGeneration) {
    return operation === this._screenStartOperation && this.inVoice &&
      this.currentChannel === channelCode &&
      this.socket?.connected !== false &&
      (this._voiceSessionGeneration || 0) === voiceGeneration;
  }

  async _tryStartNativeScreenShare(
    operation = this._screenStartOperation,
    channelCode = this.currentChannel,
    voiceGeneration = this._voiceSessionGeneration || 0
  ) {
    const api = window.havenDesktop?.nativeScreen;
    const requiredMethods = [
      'getCapabilities', 'start', 'stop', 'addPeer', 'removePeer',
      'setRemoteDescription', 'addIceCandidate', 'onSignal',
    ];
    if (!api || requiredMethods.some(method => typeof api[method] !== 'function')) return null;

    const capabilities = await this._withNativeScreenTimeout(
      api.getCapabilities(),
      'capability check'
    ).catch(() => null);
    if (!this._isScreenStartValid(operation, channelCode, voiceGeneration)) return false;
    if (!capabilities?.supported) return null;

    const res = this.screenResolution;
    let announced = false;
    let startedSessionId = null;
    try {
      const result = await api.start({
        resolution: res,
        frameRate: this.screenFrameRate,
        bitrate: this._screenBitrateFor(res),
        iceServers: this.rtcConfig.iceServers || [],
        iceTransportPolicy: this.rtcConfig.iceTransportPolicy || 'all',
      });
      if (!this._isScreenStartValid(operation, channelCode, voiceGeneration)) {
        if (result?.started) {
          await this._withNativeScreenTimeout(
            api.stop({ sessionId: result.sessionId }),
            'stop'
          ).catch(() => {});
        }
        return false;
      }
      if (!result?.started || !/^[A-Za-z0-9_-]{8,64}$/.test(String(result.sessionId || ''))) {
        await this._withNativeScreenTimeout(api.stop(), 'stop').catch(() => {});
        return result?.cancelled ? false : null;
      }

      startedSessionId = result.sessionId;
      const startResponse = await this._emitScreenStart({
        code: channelCode,
        hasAudio: false,
        transport: 'native',
        sessionId: result.sessionId,
      });
      const startStillValid = this._isScreenStartValid(operation, channelCode, voiceGeneration);
      if (!startResponse.ok || !startStillValid) {
        if (startResponse.ok || startResponse.error === 'timeout') {
          this._emitOrQueueScreenStop(
            this._screenSignalCode(channelCode, voiceGeneration),
            result.sessionId
          );
        }
        await this._withNativeScreenTimeout(
          api.stop({ sessionId: result.sessionId }),
          'stop'
        ).catch(() => {});
        return startResponse.error === 'incompatible_viewer' ? null : false;
      }

      this._nativeScreenSharing = true;
      this._nativeScreenSessionId = result.sessionId;
      this.isScreenSharing = true;
      this.screenStream = null;
      this.screenHasAudio = false;
      announced = true;

      const viewerIds = new Set(Array.isArray(startResponse.viewerIds) ? startResponse.viewerIds : []);
      const peerResults = await Promise.allSettled(Array.from(this.peers.keys())
        .filter(peerId => viewerIds.has(peerId))
        .map(peerId =>
        this._withNativeScreenTimeout(api.addPeer({
          peerId,
          sessionId: result.sessionId,
        }), 'add peer')
      ));
      if (peerResults.some(result => result.status === 'rejected')) {
        console.warn('[NativeScreen] One or more initial viewers could not be attached');
      }
      if (!this._isScreenStartValid(operation, channelCode, voiceGeneration)) {
        const signalCode = this._screenSignalCode(channelCode, voiceGeneration);
        this._emitOrQueueScreenStop(signalCode, result.sessionId);
        await this._withNativeScreenTimeout(
          api.stop({ sessionId: result.sessionId }),
          'stop'
        ).catch(() => {});
        if (this._nativeScreenSessionId === result.sessionId) {
          this._nativeScreenSharing = false;
          this._nativeScreenSessionId = null;
          this._nativeScreenSenderStates.clear();
          this.isScreenSharing = false;
          this.screenHasAudio = false;
        }
        return false;
      }
      return true;
    } catch (err) {
      const operationIsCurrent = this._screenStartOperation === operation;
      const ownsCurrentSession = !!startedSessionId &&
        this._nativeScreenSessionId === startedSessionId;
      if (startedSessionId) {
        await this._withNativeScreenTimeout(
          api.stop({ sessionId: startedSessionId }),
          'stop'
        ).catch(() => {});
      } else if (operationIsCurrent && !this._nativeScreenSessionId) {
        await this._withNativeScreenTimeout(api.stop(), 'stop').catch(() => {});
      }
      if (announced) {
        const signalCode = this._screenSignalCode(channelCode, voiceGeneration);
        this._emitOrQueueScreenStop(signalCode, startedSessionId);
      }
      if (operationIsCurrent || ownsCurrentSession) {
        if (!startedSessionId || this._nativeScreenSessionId === startedSessionId) {
          this._nativeScreenSharing = false;
          this._nativeScreenSessionId = null;
          this.isScreenSharing = false;
          this.screenStream = null;
          this.screenHasAudio = false;
        }
      }
      console.error('[NativeScreen] Native share initialization failed:', err);
      return announced ? false : null;
    }
  }

  // ── Public API ──────────────────────────────────────────

  // Ask the server to forward a renegotiate-screen to `sharerId` so they
  // (re)send their screen to us. Used by the late-joiner watchdog below and
  // by the UI when a viewer can see a stream is LIVE but has no tile yet.
  requestScreenStream(sharerId) {
    if (!this.inVoice || !this.currentChannel) return;
    this.socket.emit('request-screen-renegotiate', {
      code: this.currentChannel,
      sharerId
    });
  }

  // Hand the UI a screen stream built directly from this peer's video
  // receivers, bypassing ontrack. Returns true if a stream was delivered.
  //
  // This exists because ontrack is not a reliable signal for a *re*share. The
  // browser only fires a track event when a transceiver's direction changes
  // into receiving. When a sharer stops and immediately restarts (stop a
  // screen, start an application), addTrack reuses the transceiver the removed
  // track left behind — and if the stop and start renegotiations coalesce into
  // one SDP exchange, which they do whenever the first one is still waiting on
  // an answer, the viewer's transceiver goes sendonly → sendonly. Only the msid
  // changed, so no track event fires. Video packets arrive and decode into a
  // receiver nobody is rendering: the sharer shows LIVE, the viewer gets
  // nothing, and there is no error anywhere to notice.
  _deliverScreenFromReceivers(sharerId) {
    // Native screen media has its own peer connection. A video receiver on
    // the voice connection is a webcam or a stale browser-share transceiver.
    if (this._nativeScreenAnnouncements.has(sharerId)) return false;
    const peer = this.peers.get(sharerId);
    if (!peer || !this.screenSharers.has(sharerId)) return false;
    // A peer can be sending webcam and screen at once. We can't tell the two
    // apart from the receiver alone, so exclude whichever track ontrack
    // previously classified as their webcam.
    const camTrackId = peer._webcamTrackId || null;
    const candidates = peer.connection.getReceivers()
      .map(r => r.track)
      .filter(t => t && t.kind === 'video' && t.readyState === 'live' &&
                   !t.muted && t.id !== camTrackId);
    if (!candidates.length) return false;
    // Prefer the track we already believe is their screen; otherwise the most
    // recently negotiated one.
    const track = candidates.find(t => t.id === peer._screenTrackId) ||
                  candidates[candidates.length - 1];
    peer._screenTrackId = track.id;
    this._screenDelivered.add(sharerId);
    if (this.onScreenStream) this.onScreenStream(sharerId, new MediaStream([track]));
    return true;
  }

  // Watchdog for both the late-joiner path and the reshare path: if this
  // sharer's current share hasn't reached the UI after a short delay, recover.
  // Retries a few times because a late joiner's peer connection to the sharer
  // may still be completing its offer/answer when the first check runs.
  //
  // The check is deliberately "did we deliver a stream for *this* share",
  // not "does a live video receiver exist". The old receiver-based check was
  // the reason the reshare failure above went unrecovered for so long: a
  // reused transceiver's receiver track stays readyState 'live' across the
  // whole stop/start cycle (it only ends when the transceiver is stopped), so
  // the watchdog saw a healthy live video track and concluded all was well
  // while the viewer stared at an empty grid.
  //
  // Default attempts bumped (3 → 6) and interval shortened (3.5s → 2.5s):
  // startup races where the sharer's renegotiate-screen offer collides with
  // the joiner's voice offer used to exhaust the old budget before the peer
  // was stable, leaving the stream permanently missing until a full restream.
  _watchForScreenStream(sharerId, attemptsLeft = 6) {
    if (this._screenWatchdogTimers.has(sharerId)) return;
    const timer = setTimeout(() => {
      if (this._screenWatchdogTimers.get(sharerId) !== timer) return;
      this._screenWatchdogTimers.delete(sharerId);
      if (!this.screenSharers.has(sharerId)) return; // sharer stopped
      if (!this.inVoice || !this.currentChannel) return;
      if (this._screenDelivered.has(sharerId)) {
        // Delivered flag can go stale if the track later ended/muted. Verify
        // the UI still has a live track; if not, clear and keep recovering.
        if (this._screenStillLive(sharerId)) return;
        this._screenDelivered.delete(sharerId);
      }
      // Media may already be flowing into an unrendered receiver — adopt it
      // rather than paying for a round of signalling we don't need.
      if (this._deliverScreenFromReceivers(sharerId)) {
        console.warn('[Voice] Adopted screen stream from existing receiver for', sharerId,
          '— no track event fired for this share');
        return;
      }
      console.warn('[Voice] No video from screen sharer', sharerId, '— requesting renegotiate',
        `(attempts left after this: ${Math.max(0, attemptsLeft - 1)})`);
      this.requestScreenStream(sharerId);
      if (attemptsLeft > 1) this._watchForScreenStream(sharerId, attemptsLeft - 1);
    }, 2500);
    this._screenWatchdogTimers.set(sharerId, timer);
  }

  _cancelScreenWatchdog(sharerId) {
    const timer = this._screenWatchdogTimers.get(sharerId);
    if (timer) clearTimeout(timer);
    this._screenWatchdogTimers.delete(sharerId);
  }

  // True when we both marked the share delivered AND still have a live
  // non-muted video receiver for it (or a live <video> tile).
  _screenStillLive(sharerId) {
    try {
      const nativePeer = this._nativeScreenPeers.get(sharerId);
      if (nativePeer?.connection?.getReceivers().some(receiver => {
        const track = receiver.track;
        return track?.kind === 'video' && track.readyState === 'live' && !track.muted;
      })) return true;
    } catch { /* ignore */ }
    if (this._nativeScreenAnnouncements.has(sharerId)) return false;
    try {
      const peer = this.peers.get(sharerId);
      if (peer && peer.connection) {
        const camTrackId = peer._webcamTrackId || null;
        const live = peer.connection.getReceivers().some(r => {
          const t = r.track;
          return t && t.kind === 'video' && t.readyState === 'live' &&
            !t.muted && t.id !== camTrackId;
        });
        if (live) return true;
      }
    } catch { /* ignore */ }
    try {
      const tile = document.getElementById(`screen-tile-${sharerId}`);
      const vid = tile && tile.querySelector('video');
      const track = vid && vid.srcObject && vid.srcObject.getVideoTracks?.()[0];
      if (track && track.readyState === 'live' && vid.videoWidth > 0) return true;
    } catch { /* ignore */ }
    return false;
  }

  // Re-arm recovery for every known sharer. Cheap, idempotent, and the
  // right response after ICE heal / fast-path rejoin / UI desync restore.
  _rearmScreenWatchdogs() {
    if (!this.inVoice) return;
    for (const sharerId of this.screenSharers) {
      if (sharerId === this.localUserId) continue;
      if (this._screenDelivered.has(sharerId) && this._screenStillLive(sharerId)) continue;
      this._screenDelivered.delete(sharerId);
      if (this._deliverScreenFromReceivers(sharerId)) continue;
      this._watchForScreenStream(sharerId);
    }
  }

  async join(channelCode) {
    if (this._joinInFlight) return false;
    this._joinInFlight = true;
    this._joiningChannelCode = channelCode;
    try {
      const preservedMuteState = this.isMuted;
      const preservedDeafenState = this.isDeafened;

      // #5380 — "Always join muted" user preference. If set, force mute on
      // every join so users who like to lurk-first never accidentally hot-mic.
      let muteOnJoin = false;
      try { muteOnJoin = localStorage.getItem('haven_mute_on_join') === '1'; } catch {}

      // Don't attempt to join while the socket is disconnected. The
      // emit() would otherwise be buffered by socket.io and flushed on
      // reconnect, producing duplicate sessions if the user clicked
      // Start Voice multiple times during the outage. The 'connect'
      // handler in app-socket.js auto-rejoins voice via the persisted
      // localStorage channel once the socket comes back. (#voice-spam-click)
      if (this.socket && this.socket.connected === false) {
        console.warn('[Voice] join() ignored — socket disconnected');
        return false;
      }

      // Leave existing voice channel if connected elsewhere
      if (this.inVoice) this.leave();

      // Refresh ICE config (TURN credentials may have expired)
      await this._fetchIceServers();

      // Create/resume AudioContext with user gesture (needed for volume boost)
      this._ensureAudioCtx();
      await this.audioCtx.resume().catch(() => {});

      // Use saved input device if the user picked one
      const savedInputId = localStorage.getItem('haven_input_device') || '';
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      if (savedInputId) audioConstraints.deviceId = { exact: savedInputId };

      // #5380 — listener-only mode flag; set if mic acquisition fails or
      // the user has explicitly opted out via "Join without microphone".
      this.isListenerOnly = false;
      const lurkPref = (() => { try { return localStorage.getItem('haven_listener_only') === '1'; } catch { return false; } })();

      if (!lurkPref) {
        try {
          this.rawStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false
          });
        } catch (deviceErr) {
          if (savedInputId) {
            // Saved device may be stale — retry with default mic
            console.warn('Saved mic device failed, falling back to default:', deviceErr.message);
            localStorage.removeItem('haven_input_device');
            delete audioConstraints.deviceId;
            try {
              this.rawStream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: false
              });
            } catch (retryErr) {
              console.warn('[Voice] No mic available, falling back to listener-only mode:', retryErr.message);
              this.isListenerOnly = true;
            }
          } else {
            console.warn('[Voice] No mic available, falling back to listener-only mode:', deviceErr.message);
            this.isListenerOnly = true;
          }
        }
      } else {
        this.isListenerOnly = true;
      }

      // Opt out of Windows audio ducking (Desktop app only).
      // Must be called after getUserMedia so our audio session exists.
      if (window.havenDesktop?.audio?.optOutOfDucking) {
        setTimeout(() => window.havenDesktop.audio.optOutOfDucking().catch(() => {}), 500);
      }

      if (this.isListenerOnly) {
        // #5380 — Listener-only path: skip mic, noise gate, RNNoise, talk
        // detection. We still publish a silent placeholder track to peer
        // connections so the existing offer/answer flow doesn't need any
        // changes. The track is force-disabled (muted) so peers receive
        // pure silence. UI shows the user as muted with a "Listener" badge.
        const silentDest = this.audioCtx.createMediaStreamDestination();
        // No source connected → MediaStreamDestination produces silence.
        this._vcDest = silentDest;
        this.localStream = silentDest.stream;
        this._rnnoiseSource = null;
        this._noiseGateAnalyser = null;
        this._noiseGateGain = null;
      } else {
        // ── Noise Gate via Web Audio ──
        // Route mic through an analyser + gain node so we can silence
        // audio below a threshold before sending it to peers.
        const source = this.audioCtx.createMediaStreamSource(this.rawStream);
        this._rnnoiseSource = source;
        const gateAnalyser = this.audioCtx.createAnalyser();
        gateAnalyser.fftSize = 2048;
        gateAnalyser.smoothingTimeConstant = 0.3;
        source.connect(gateAnalyser);

        const gateGain = this.audioCtx.createGain();
        source.connect(gateGain);

        const dest = this.audioCtx.createMediaStreamDestination();
        gateGain.connect(dest);

        this._noiseGateAnalyser = gateAnalyser;
        this._noiseGateGain = gateGain;
        this._vcDest = dest;
        this.localStream = dest.stream;   // processed stream → peers
        this._startNoiseGate();

        // Initialize RNNoise and apply saved noise mode
        await this._initRNNoise();
        if (this.noiseMode === 'suppress' && this._rnnoiseWasmBytes) {
          this.setNoiseSensitivity(0);
          this._enableRNNoise();
        } else if (this.noiseMode === 'off') {
          this.setNoiseSensitivity(0);
        } else if (this.noiseMode === 'gate') {
          const saved = parseInt(localStorage.getItem('haven_ns_value') || '10', 10);
          this.setNoiseSensitivity(saved);
        }
      }

      // Do not let Socket.IO buffer a stale voice-join if the connection
      // dropped while microphone and noise processing were being prepared.
      if (this.socket && this.socket.connected === false) {
        this._disableRNNoise();
        this._stopNoiseGate();
        this._stopLocalTalkDetection();
        if (this.rawStream) {
          this.rawStream.getTracks().forEach(track => track.stop());
          this.rawStream = null;
        }
        if (this.localStream) {
          this.localStream.getTracks().forEach(track => track.stop());
          this.localStream = null;
        }
        if (this.audioCtx) {
          this.audioCtx.close().catch(() => {});
          this.audioCtx = null;
        }
        return false;
      }

      channelCode = this._joiningChannelCode || channelCode;
      this.currentChannel = channelCode;
      this.inVoice = true;
      this._voiceSessionGeneration = (this._voiceSessionGeneration || 0) + 1;
      // Listener-only is always muted (no audio to send). mute-on-join also forces mute.
      this.isMuted = this.isListenerOnly || muteOnJoin || preservedMuteState;
      this.isDeafened = preservedDeafenState;

      this._applyMuteStateToLocalTracks();

      // Persist voice channel for auto-rejoin after page refresh or server restart
      try { localStorage.setItem('haven_voice_channel', channelCode); } catch {}

      this.socket.emit('voice-join', { code: channelCode, nativeScreenVersion: 1 });
      // Inform peers / UI about our mute state so they show the muted icon
      // immediately instead of waiting for someone to query.
      if (this.isMuted) {
        try { this.socket.emit('voice-mute-state', { code: channelCode, muted: true }); } catch {}
      }

      // Start local talk indicator (use raw stream for accurate detection).
      // Skip in listener-only mode — there's no mic to detect.
      if (!this.isListenerOnly) this._startLocalTalkDetection();

      return true;
    } catch (err) {
      console.error('Voice join failed:', err);
      return false;
    } finally {
      this._joinInFlight = false;
      this._joiningChannelCode = null;
    }
  }

  leave() {
    // Breadcrumb for the maximize/resize "fake disconnect" bug — if leave()
    // runs when the user didn't click Disconnect, the stack tells us why.
    try {
      console.warn('[Voice] leave() invoked', {
        channel: this.currentChannel,
        inVoice: this.inVoice,
        peers: this.peers.size,
        stack: new Error().stack
      });
    } catch {}
    const pendingScreenStart = this._screenStartInFlight;
    this._screenStartOperation = (this._screenStartOperation || 0) + 1;
    this._screenStartInFlight = false;
    if (pendingScreenStart && !this.isScreenSharing) {
      window.havenDesktop?.nativeScreen?.stop?.().catch(() => {});
    }
    // Stop screen share and webcam first if active, in teardown mode: the
    // peers are closed a few lines down, so there is nobody to renegotiate
    // with. The normal path fired renegotiations at connections about to be
    // closed and then finished up to 8 seconds later, nulling screenStream
    // and flipping isScreenSharing even if the user had already rejoined and
    // started a fresh share in the meantime. (#5426)
    if (this.isScreenSharing) {
      this.stopScreenShare({ teardown: true });
    }
    if (this.isWebcamActive) {
      this.stopWebcam({ teardown: true });
    }

    // Stop noise gate and talk detection
    this.stopBotAudio();
    this._disableRNNoise();
    this._stopNoiseGate();
    this._stopLocalTalkDetection();
    for (const [id] of this.analysers) this._stopAnalyser(id);

    // Capture channel code BEFORE clearing state
    const leavingChannel = this.currentChannel;

    if (leavingChannel) {
      // Use Socket.IO acknowledgment to confirm server received the leave.
      // If no ack within 2s (socket glitch, transport switch), retry — but
      // ONLY if the user hasn't already rejoined a voice channel in the
      // meantime. Without this guard, the retry can fire after a quick
      // leave→rejoin and silently kick the user out of voice server-side
      // while their client still believes it's connected (#5347 — the
      // "Voice Connected" bar with an empty voice panel).
      let acked = false;
      this.socket.emit('voice-leave', { code: leavingChannel }, (response) => {
        acked = true;
      });
      setTimeout(() => {
        if (acked) return;
        if (!this.socket.connected) return;
        if (this.inVoice || this.currentChannel) return;
        console.warn('[Voice] voice-leave not acked, retrying...');
        this.socket.emit('voice-leave', { code: leavingChannel });
      }, 2000);
    }

    // Close all peer connections
    for (const [id] of this.peers) {
      this._removePeer(id);
    }
    this.gainNodes.clear();

    // Stop local tracks (both raw and processed)
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => t.stop());
      this.rawStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.currentChannel = null;
    this.inVoice = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.audioBitrate = 0;
    this.screenSharers.clear();
    this._screenDelivered.clear();
    this._closeAllNativeScreenPeers();
    this.screenGainNodes.clear();
    this.webcamUsers.clear();
    this._vcDest = null;

    // Close AudioContext to free resources
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    // Clear cached silent track
    this._cachedSilentTrack = null;
    
    // Clear persisted voice channel
    try { localStorage.removeItem('haven_voice_channel'); } catch {}
    
    // Clear any pending disconnect-recovery timers
    if (this._disconnectTimers) {
      for (const key of Object.keys(this._disconnectTimers)) {
        clearTimeout(this._disconnectTimers[key]);
      }
      this._disconnectTimers = {};
    }
  }

  /**
   * Soft-leave: clean up local voice state WITHOUT emitting to the server.
   * Used when the socket disconnects unexpectedly (e.g. mobile screen timeout)
   * so the client state is reset and the auto-rejoin on reconnect can work.
   * Intentionally keeps haven_voice_channel in localStorage for that rejoin.
   */
  _softLeave() {
    if (!this.inVoice) return;
    this.stopBotAudio();

    const pendingScreenStart = this._screenStartInFlight;
    this._screenStartOperation = (this._screenStartOperation || 0) + 1;
    this._screenStartInFlight = false;
    if (pendingScreenStart && !this.isScreenSharing) {
      window.havenDesktop?.nativeScreen?.stop?.().catch(() => {});
    }

    // Stop screen share / webcam (local cleanup only)
    if (this.isScreenSharing && this.screenStream) {
      this._pendingScreenStop = { sessionId: null };
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
      this.isScreenSharing = false;
    }
    if (this._nativeScreenSharing) {
      this._pendingScreenStop = { sessionId: this._nativeScreenSessionId };
      window.havenDesktop?.nativeScreen?.stop?.({
        sessionId: this._nativeScreenSessionId,
      }).catch(() => {});
      this._nativeScreenSharing = false;
      this._nativeScreenSessionId = null;
      this._nativeScreenSenderStates.clear();
      this.isScreenSharing = false;
    }
    if (this.isWebcamActive && this.webcamStream) {
      this.webcamStream.getTracks().forEach(t => t.stop());
      this.webcamStream = null;
      this.isWebcamActive = false;
    }

    this._stopNoiseGate();
    this._stopLocalTalkDetection();
    for (const [id] of this.analysers) this._stopAnalyser(id);

    for (const [id] of this.peers) {
      this._removePeer(id);
    }
    this.gainNodes.clear();

    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => t.stop());
      this.rawStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Remember the channel we were in so the reconnect handler can use
    // voice-rejoin (which broadcasts voice-user-left to peers, forcing them
    // to tear down stale RTCPeerConnections) instead of the slower
    // setTimeout(1500) auto-rejoin path that fires plain voice-join. The
    // auto-rejoin path leaves other peers with dead WebRTC sessions and is
    // the cause of the "rejoined but can't hear anyone" pattern in #5347.
    this._softLeftChannel = this.currentChannel;

    this.currentChannel = null;
    this.inVoice = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.screenSharers.clear();
    this._screenDelivered.clear();
    this._closeAllNativeScreenPeers();
    this.screenGainNodes.clear();
    this.webcamUsers.clear();
    this._vcDest = null;

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this._cachedSilentTrack = null;

    if (this._disconnectTimers) {
      for (const key of Object.keys(this._disconnectTimers)) {
        clearTimeout(this._disconnectTimers[key]);
      }
      this._disconnectTimers = {};
    }
    // NOTE: leaves haven_voice_channel in localStorage so auto-rejoin on reconnect works
  }

  // Play a soundboard audio file and mix it into the VC stream so other users hear it
  playSoundToVC(url, localVolume = 0.5) {
    if (!this.inVoice || !this.audioCtx || !this._vcDest) return false;
    // Use fetch + decodeAudioData for reliable mixing into VC destination
    fetch(url).then(r => r.arrayBuffer()).then(buf => {
      return this.audioCtx.decodeAudioData(buf);
    }).then(audioBuffer => {
      const bufferSource = this.audioCtx.createBufferSource();
      bufferSource.buffer = audioBuffer;
      // Mix into the VC destination so peers hear it
      const vcGain = this.audioCtx.createGain();
      vcGain.gain.value = 0.7;
      bufferSource.connect(vcGain);
      vcGain.connect(this._vcDest);
      // Also play locally for the user's own preview
      const localGain = this.audioCtx.createGain();
      localGain.gain.value = localVolume;
      bufferSource.connect(localGain);
      localGain.connect(this.audioCtx.destination);
      bufferSource.start(0);
    }).catch(() => {});
    return true;
  }

  playBotAudio(data) {
    if (!data || !data.playbackId || !data.audioUrl) return false;
    if (!this.inVoice || this.currentChannel !== data.channelCode) return false;
    this.stopBotAudio();

    const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const receivedAt = now();
    const reportedOffsetMs = Math.max(0, Number(data.offsetMs) || 0);
    const durationMs = Number(data.durationMs);
    if (Number.isFinite(durationMs) && reportedOffsetMs >= durationMs) return false;

    const audio = new Audio(data.audioUrl);
    const playback = { id: data.playbackId, channelCode: data.channelCode, audio, timer: null };
    this._botAudio = playback;
    audio.preload = 'auto';
    audio.volume = this.isDeafened ? 0 : 1;
    const savedOutput = localStorage.getItem('haven_output_device');
    const sinkReady = savedOutput && typeof audio.setSinkId === 'function'
      ? audio.setSinkId(savedOutput).catch(() => {})
      : Promise.resolve();
    audio.addEventListener('ended', () => {
      if (this._botAudio === playback) this.stopBotAudio(playback.id);
    }, { once: true });
    audio.addEventListener('error', () => {
      if (this._botAudio === playback) this.stopBotAudio(playback.id);
    }, { once: true });

    if (Number.isFinite(durationMs)) {
      playback.timer = setTimeout(
        () => this.stopBotAudio(playback.id),
        Math.max(1, durationMs - reportedOffsetMs)
      );
      playback.timer.unref?.();
    }

    const start = async () => {
      await sinkReady;
      if (this._botAudio !== playback) return;
      const offsetSeconds = (reportedOffsetMs + Math.max(0, now() - receivedAt)) / 1000;
      if (offsetSeconds > 0 && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(offsetSeconds, Math.max(0, audio.duration - 0.05));
      }
      audio.play().catch(() => {
        if (this._botAudio === playback) this.stopBotAudio(playback.id);
      });
    };
    if (audio.readyState >= 1) start();
    else audio.addEventListener('loadedmetadata', start, { once: true });
    return true;
  }

  stopBotAudio(playbackId = null) {
    if (!this._botAudio || (playbackId && this._botAudio.id !== playbackId)) return false;
    const { audio, timer } = this._botAudio;
    this._botAudio = null;
    if (timer) clearTimeout(timer);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    return true;
  }

  toggleMute() {
    // #5380 — listener-only mode has no mic; force-stay muted.
    if (this.isListenerOnly) { this.isMuted = true; return true; }
    this.isMuted = !this.isMuted;
    this._applyMuteStateToLocalTracks();
    return this.isMuted;
  }

  _applyMuteStateToLocalTracks() {
    if (this.rawStream) {
      this.rawStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    // Mute/unmute all incoming audio (voice)
    for (const [userId, gainNode] of this.gainNodes) {
      gainNode.gain.value = this.isDeafened ? 0 : this._getSavedVolume(userId);
    }
    // Mute/unmute screen share audio
    for (const [userId, gainNode] of this.screenGainNodes) {
      gainNode.gain.value = this.isDeafened ? 0 : this._getSavedStreamVolume(userId);
    }
    // Also mute all audio elements as fallback
    document.querySelectorAll('#audio-container audio').forEach(el => {
      if (this.isDeafened) {
        el.dataset.prevVolume = el.volume;
        el.volume = 0;
      } else {
        el.volume = parseFloat(el.dataset.prevVolume || 1);
      }
    });
    if (this._botAudio) this._botAudio.audio.volume = this.isDeafened ? 0 : 1;
    return this.isDeafened;
  }

  _getAppliedIncomingVolume(volume) {
    return this.isDeafened ? 0 : volume;
  }

  // ── Screen Sharing ──────────────────────────────────────

  async shareScreen() {
    if (!this.inVoice || this.socket?.connected === false || this.isScreenSharing ||
        this._screenStartInFlight || this._pendingScreenStop) return false;
    const operation = (this._screenStartOperation || 0) + 1;
    const channelCode = this.currentChannel;
    const voiceGeneration = this._voiceSessionGeneration || 0;
    this._screenStartOperation = operation;
    this._screenStartInFlight = true;
    let capturedStream = null;
    try {
      const nativeResult = await this._tryStartNativeScreenShare(
        operation, channelCode, voiceGeneration
      );
      if (nativeResult !== null) return nativeResult;
      if (!this._isScreenStartValid(operation, channelCode, voiceGeneration)) return false;

      // Build video constraints from quality settings
      const videoConstraints = { cursor: 'always' };
      const res = this.screenResolution;   // 720 | 1080 | 1440 | 0 (source)
      const fps = this.screenFrameRate;    // 15 | 30 | 60

      if (res && res !== 0) {
        // 16:9 width from height
        const widths = { 720: 1280, 1080: 1920, 1440: 2560 };
        videoConstraints.width  = { ideal: widths[res] || 1920 };
        videoConstraints.height = { ideal: res };
      }
      videoConstraints.frameRate = { ideal: fps };

      const displayMediaOptions = {
        video: videoConstraints,
        audio: true,
      };

      // #5379 — Default to raw screen audio. Chromium normally applies
      // echoCancellation / noiseSuppression / autoGainControl to
      // getDisplayMedia audio (tuned for voice), which hollows out music
      // and game audio for listeners. Power users sharing a tutorial or
      // talk where they want the captured system audio to be cleaned up
      // can opt back in via Settings → Debug → "Apply voice processing
      // to screen-share audio". Mic capture (getUserMedia) is a separate
      // stream and always gets full voice processing regardless.
      const applyVoiceProcToScreen = (() => {
        try { return localStorage.getItem('screen_share_voice_processing') === '1'; } catch { return false; }
      })();
      displayMediaOptions.audio = applyVoiceProcToScreen
        ? true
        : { echoCancellation: false, autoGainControl: false, noiseSuppression: false };

      // These options aren't supported in Electron's Chromium — only add them
      // when running in a regular browser to avoid immediate rejection.
      const isElectron = !!(window.havenDesktop || navigator.userAgent.includes('Electron'));
      if (!isElectron) {
        displayMediaOptions.surfaceSwitching = 'exclude';
        displayMediaOptions.selfBrowserSurface = 'include';
        displayMediaOptions.monitorTypeSurfaces = 'include';

        // Use CaptureController if available to manage the capture session
        if (typeof CaptureController !== 'undefined') {
          this._captureController = new CaptureController();
          displayMediaOptions.controller = this._captureController;
        }
      }

      capturedStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

      if (!this._isScreenStartValid(operation, channelCode, voiceGeneration)) {
        capturedStream.getTracks().forEach(track => track.stop());
        return false;
      }
      this.screenStream = capturedStream;

      this.isScreenSharing = true;

      // 3.18.1 (#5379) — hint the encoder that this is motion content (games,
      // videos, scrolling). Without this hint, browsers may bias toward
      // "detail" mode which sacrifices framerate for sharpness, the opposite
      // of what most screen-share use cases want.
      try {
        const vTrack = this.screenStream.getVideoTracks()[0];
        if (vTrack && 'contentHint' in vTrack) vTrack.contentHint = 'motion';
      } catch { /* unsupported — ignore */ }

      // When user clicks browser "Stop sharing" button
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      // If screen audio track dies independently, update flag
      const screenAudioTrack = this.screenStream.getAudioTracks()[0];
      if (screenAudioTrack) {
        screenAudioTrack.onended = () => { this.screenHasAudio = false; };
      }

      // Tell the server we're sharing BEFORE renegotiating with peers, so
      // every receiver has `screenSharers.has(sharerId) === true` by the
      // time their ontrack fires for the new video. Otherwise the video
      // track classifier in _createPeer falls through to a default-screen
      // route that misbehaves when the receiver has stale webcam state for
      // the same user (image: tile shown, audio works, video black).
      const hasAudio = this.screenStream.getAudioTracks().length > 0;
      this.screenHasAudio = hasAudio;
      const startResponse = await this._emitScreenStart({ code: channelCode, hasAudio });
      if (!startResponse.ok || !this._isScreenStartValid(operation, channelCode, voiceGeneration)) {
        if (startResponse.ok || startResponse.error === 'timeout') {
          this._emitOrQueueScreenStop(this._screenSignalCode(channelCode, voiceGeneration));
        }
        capturedStream.getTracks().forEach(track => track.stop());
        if (this.screenStream === capturedStream) this.screenStream = null;
        this.isScreenSharing = false;
        this.screenHasAudio = false;
        this._captureController = null;
        return false;
      }

      // Add screen tracks to all existing peer connections and cap bitrate
      const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
      // Renegotiate with every peer at once. Each peer is its own
      // RTCPeerConnection, so there is nothing to serialise, and awaiting
      // them one at a time meant the last viewer in a bigger call waited for
      // every earlier negotiation to settle before their tile started. (#5426)
      const renegotiations = [];
      for (const [userId, peer] of this.peers) {
        this.screenStream.getTracks().forEach(track => {
          peer.connection.addTrack(track, this.screenStream);
        });
        // Cap the video bitrate so WebRTC doesn't starve framerate
        this._applyScreenBitrate(peer.connection, maxBitrate);
        renegotiations.push(this._renegotiate(userId, peer.connection));
      }
      await Promise.all(renegotiations);

      if (!this._isScreenStartValid(operation, channelCode, voiceGeneration)) {
        await this.stopScreenShare();
        return false;
      }
      return true;
    } catch (err) {
      console.error('Screen share failed:', err);
      if (capturedStream && this.screenStream === capturedStream && this.isScreenSharing) {
        await this.stopScreenShare().catch(() => {});
      } else if (capturedStream) {
        capturedStream.getTracks().forEach(track => track.stop());
      }
      if (this._screenStartOperation === operation) {
        this.isScreenSharing = false;
        if (this.screenStream === capturedStream) this.screenStream = null;
      }
      return false;
    } finally {
      if (this._screenStartOperation === operation) this._screenStartInFlight = false;
    }
  }

  async stopScreenShare({ teardown = false } = {}) {
    if (!this.isScreenSharing) return;
    this._screenStartOperation = (this._screenStartOperation || 0) + 1;
    this._screenStartInFlight = false;

    if (this._nativeScreenSharing) {
      const channelCode = this.currentChannel;
      const voiceGeneration = this._voiceSessionGeneration || 0;
      const sessionId = this._nativeScreenSessionId;
      this._nativeScreenSharing = false;
      this._nativeScreenSessionId = null;
      this._nativeScreenSenderStates.clear();
      this.isScreenSharing = false;
      this.screenStream = null;
      this.screenHasAudio = false;
      this.screenSharers.delete(this.localUserId);
      this._nativeScreenAnnouncements.delete(this.localUserId);
      this._emitOrQueueScreenStop(
        this._screenSignalCode(channelCode, voiceGeneration),
        sessionId
      );
      if (this.onScreenStream) this.onScreenStream(this.localUserId, null);
      await this._withNativeScreenTimeout(
        window.havenDesktop?.nativeScreen?.stop?.({ sessionId }),
        'stop'
      ).catch(err => {
        console.warn('[NativeScreen] Failed to stop native pipeline:', err);
      });
      return;
    }
    if (!this.screenStream) return;

    const tracks = this.screenStream.getTracks();

    if (teardown) {
      // Leaving voice: every peer is about to be closed, so skip the
      // renegotiation round and release the capture right away. Nothing is
      // awaited before this point, so leave() sees the state cleared
      // synchronously. (#5426)
      tracks.forEach(t => t.stop());
      this.screenStream = null;
      this.isScreenSharing = false;
      this.screenHasAudio = false;
      this._captureController = null;
      this.screenSharers.delete(this.localUserId);
      this._nativeScreenAnnouncements.delete(this.localUserId);
      this._emitOrQueueScreenStop(this.currentChannel);
      if (this.onScreenStream) this.onScreenStream(this.localUserId, null);
      return;
    }

    // Remove screen tracks from all peer connections FIRST, then stop them.
    // Stopping tracks before all peers have removed them causes renegotiation
    // to reference dead tracks and corrupt audio.
    const renegotiations = [];
    for (const [userId, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      tracks.forEach(track => {
        const sender = senders.find(s => s.track === track);
        if (sender) {
          try { peer.connection.removeTrack(sender); } catch {}
        }
      });
      // Renegotiate and track the promise so we can wait for completion
      renegotiations.push(this._renegotiate(userId, peer.connection).catch(() => {}));
    }

    // Wait for ALL renegotiations to actually finish before tearing the
    // tracks down. The previous Promise.race(..., 3s) here was the cause of
    // the months-long "black screen on reshare" / "streaming but no tile"
    // bugs: if any peer's _renegotiate was still in flight when the 3s
    // expired (perfectly possible since _renegotiate itself can wait up to
    // 5s for signaling state to settle), this function would return, kill
    // the tracks, and leave that peer's transceiver mid-direction-change.
    // On the next startScreenShare the new addTrack would reuse that broken
    // transceiver and ontrack would never fire on the viewer side — exactly
    // the symptom users reported. Use allSettled with a generous safety cap.
    try {
      await Promise.race([
        Promise.allSettled(renegotiations),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]);
    } catch { /* proceed anyway */ }

    // Now safe to stop tracks — all peers have detached them
    tracks.forEach(t => t.stop());

    this.screenStream = null;
    this.isScreenSharing = false;
    this._captureController = null;
    this.screenSharers.delete(this.localUserId);
    this._nativeScreenAnnouncements.delete(this.localUserId);

    this._emitOrQueueScreenStop(this.currentChannel);
    // Notify local UI — pass localUserId so tile is found by its real ID
    if (this.onScreenStream) this.onScreenStream(this.localUserId, null);
  }

  // ── Webcam Video ────────────────────────────────────────

  async startWebcam() {
    if (!this.inVoice || this.isWebcamActive) return false;
    try {
      const savedCamId = localStorage.getItem('haven_cam_device') || '';
      const videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      };
      if (savedCamId) videoConstraints.deviceId = { exact: savedCamId };

      this.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false  // mic already captured separately
      });

      this.isWebcamActive = true;

      // When user revokes camera permission
      this.webcamStream.getVideoTracks()[0].onended = () => {
        this.stopWebcam();
      };

      // Add webcam video track to all existing peer connections
      const camTrack = this.webcamStream.getVideoTracks()[0];
      const renegotiations = [];
      for (const [userId, peer] of this.peers) {
        peer.connection.addTrack(camTrack, this.webcamStream);
        renegotiations.push(this._renegotiate(userId, peer.connection));
      }
      await Promise.all(renegotiations);

      // Tell the server
      this.socket.emit('webcam-started', { code: this.currentChannel });
      return true;
    } catch (err) {
      console.error('Webcam access failed:', err);
      this.isWebcamActive = false;
      this.webcamStream = null;
      return false;
    }
  }

  async stopWebcam({ teardown = false } = {}) {
    if (!this.isWebcamActive || !this.webcamStream) return;

    const tracks = this.webcamStream.getTracks();

    if (teardown) {
      // Leaving voice: see stopScreenShare. (#5426)
      tracks.forEach(t => t.stop());
      this.webcamStream = null;
      this.isWebcamActive = false;
      this.socket.emit('webcam-stopped', { code: this.currentChannel });
      if (this.onWebcamStream) this.onWebcamStream(this.localUserId, null);
      return;
    }

    // Remove webcam track from all peer connections
    const renegotiations = [];
    for (const [userId, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      tracks.forEach(track => {
        const sender = senders.find(s => s.track === track);
        if (sender) {
          try { peer.connection.removeTrack(sender); } catch {}
        }
      });
      renegotiations.push(this._renegotiate(userId, peer.connection).catch(() => {}));
    }

    try {
      await Promise.race([
        Promise.all(renegotiations),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    } catch {}

    tracks.forEach(t => t.stop());

    this.webcamStream = null;
    this.isWebcamActive = false;

    this.socket.emit('webcam-stopped', { code: this.currentChannel });
    if (this.onWebcamStream) this.onWebcamStream(this.localUserId, null);
  }

  async switchCamera(deviceId) {
    if (!this.isWebcamActive) return;
    const videoConstraints = {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 }
    };
    if (deviceId) videoConstraints.deviceId = { exact: deviceId };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    } catch (err) {
      console.error('[Voice] Failed to switch camera:', err);
      return;
    }

    const newTrack = newStream.getVideoTracks()[0];

    // Replace the track on all peers concurrently. replaceTrack needs no
    // renegotiation and each peer is independent, so waiting on them in turn
    // only delayed the last peer. (#5426)
    const swaps = [];
    for (const [, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      const camSender = senders.find(s => s.track && s.track.kind === 'video' &&
        this.webcamStream && this.webcamStream.getVideoTracks().includes(s.track));
      if (camSender) {
        swaps.push(camSender.replaceTrack(newTrack).catch(e =>
          console.warn('[Voice] replaceTrack (cam) failed:', e)
        ));
      }
    }
    await Promise.all(swaps);

    // Stop old tracks and update stream reference
    this.webcamStream.getTracks().forEach(t => t.stop());
    this.webcamStream = newStream;

    // Re-hook ended
    newTrack.onended = () => this.stopWebcam();

    localStorage.setItem('haven_cam_device', deviceId || '');
    console.log(`[Voice] Camera switched: ${deviceId || 'default'}`);
  }

  // ── Screen Share Quality Helpers ───────────────────────

  setScreenResolution(h) {
    this.screenResolution = h;   // 720 | 1080 | 1440 | 0 = source
    localStorage.setItem('haven_screen_res', h);
    if (this.isScreenSharing) this._applyLiveQualityChange();
  }

  setScreenFrameRate(fps) {
    this.screenFrameRate = fps;  // 15 | 30 | 60
    localStorage.setItem('haven_screen_fps', fps);
    if (this.isScreenSharing) this._applyLiveQualityChange();
  }

  /**
   * Apply resolution / framerate / bitrate changes to an active screen share
   * without stopping and restarting the stream.
   */
  async _applyLiveQualityChange() {
    if (!this.screenStream) return;
    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (!videoTrack) return;

    const res = this.screenResolution;
    const fps = this.screenFrameRate;

    // Apply new constraints to the live capture track
    const constraints = {};
    if (res && res !== 0) {
      const widths = { 720: 1280, 1080: 1920, 1440: 2560 };
      constraints.width = { ideal: widths[res] || 1920 };
      constraints.height = { ideal: res };
    }
    constraints.frameRate = { ideal: fps };

    try {
      await videoTrack.applyConstraints(constraints);
    } catch (e) {
      console.warn('applyConstraints failed (browser may not support live constraint changes):', e);
    }

    // Update bitrate cap on all peer senders
    const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
    for (const [, peer] of this.peers) {
      this._applyScreenBitrate(peer.connection, maxBitrate);
    }
  }

  /**
   * Cap the video bitrate on screen-share senders for a given peer connection.
   * Uses RTCRtpSender.setParameters() which is widely supported.
   *
   * 3.18.1 (#5379) — also sets `degradationPreference: 'maintain-framerate'` so
   * the encoder drops resolution before dropping frames when bandwidth gets
   * tight. Default browser behaviour is `balanced`, which on screen share
   * tends to chop framerate first (bad for motion content like games/video).
   */
  // Opt-in relay profile for screen share (#5426). Read live so flipping the
  // toggle mid-share takes effect on the next apply.
  //
  // 3.18.1 (#5379) did three things together: raised the ceilings 2-3x, pinned
  // maxFramerate, and set degradationPreference to 'maintain-framerate'. On a
  // direct connection that is what makes 1080p30 actually deliver 1080p30. Over
  // a TURN relay that has fallen back to TCP it is the opposite of what you
  // want: TCP hides packet loss, so the encoder never gets the signal to back
  // off, and pinning the framerate removes the one lever it had left. The queue
  // grows instead, which is the "fine for a minute, then stutter every few
  // seconds, getting worse" shape reported in #5426.
  //
  // This profile restores the pre-3.18.1 ceilings and hands the encoder back
  // both levers. Nobody gets it unless they turn it on.
  _screenRelayProfileEnabled() {
    try { return localStorage.getItem('haven_screen_relay_profile') === '1'; } catch { return false; }
  }

  _screenBitrateFor(res) {
    const table = this._screenRelayProfileEnabled()
      ? { 0: 3_000_000, 720: 1_500_000, 1080: 3_000_000, 1440: 5_000_000 }
      : this._screenBitrates;
    return table[res] || table[0];
  }

  // Re-apply the current cap to every peer, for when the toggle changes while
  // a share is already running.
  reapplyScreenBitrate() {
    if (!this.isScreenSharing) return;
    const maxBitrate = this._screenBitrateFor(this.screenResolution);
    for (const [, peer] of this.peers) {
      this._applyScreenBitrate(peer.connection, maxBitrate);
    }
  }

  _applyScreenBitrate(connection, maxBitrate) {
    try {
      const relayProfile = this._screenRelayProfileEnabled();
      const senders = connection.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video' &&
            this.screenStream && this.screenStream.getVideoTracks().includes(sender.track)) {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = relayProfile
            ? this._screenBitrateFor(this.screenResolution)
            : maxBitrate;
          // Per-encoding cap is the primary control; framerate hint also helps
          // browsers that respect it (Chromium-based ones do). Under the relay
          // profile the framerate stays unpinned on purpose, so the encoder can
          // shed frames instead of filling a queue it cannot drain.
          if (relayProfile) {
            delete params.encodings[0].maxFramerate;
          } else if (this.screenFrameRate) {
            params.encodings[0].maxFramerate = this.screenFrameRate;
          }
          params.degradationPreference = relayProfile ? 'balanced' : 'maintain-framerate';
          sender.setParameters(params).catch(() => {});
        }
      }
      // Protect audio from the video ramp-up. (#5426)
      this._prioritiseAudioSenders(connection);
    } catch (e) { /* setParameters not supported — adaptive bitrate remains */ }
  }

  // Mark every audio sender on this connection as high network priority.
  //
  // When a screen share negotiates up to 1080p the encoder ramps hard, and on
  // a constrained uplink that burst takes the whole pipe for a moment. Audio
  // packets queue behind it, arrive late, and NetEq fills the gap with
  // concealment — which is the robotic warble people describe. @RCCore caught
  // this in a WebRTC-internals dump: packetsLost jumping 4 -> 249 and
  // concealedSamples going from 0 to over 100k as the share started.
  //
  // Audio is a few tens of kbps against several thousand for video, so giving
  // it priority costs the video almost nothing and keeps speech intelligible
  // through the ramp. Both the DSCP marking and the send-queue ordering follow
  // from networkPriority.
  _prioritiseAudioSenders(connection) {
    try {
      for (const sender of connection.getSenders()) {
        if (!sender.track || sender.track.kind !== 'audio') continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';   // older Chromium spelling
        sender.setParameters(params).catch(() => {});
      }
    } catch { /* unsupported — audio still flows, just without the hint */ }
  }

  /**
   * Cap the audio bitrate on voice senders for a given peer connection.
   * audioBitrate is in kbps; convert to bps for setParameters.
   * 0 = no cap (remove maxBitrate constraint).
   */
  _applyAudioBitrate(connection) {
    if (!this.audioBitrate) return; // 0 = auto, nothing to cap
    try {
      const senders = connection.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'audio' &&
            this.localStream && this.localStream.getAudioTracks().includes(sender.track)) {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = this.audioBitrate * 1000;
          sender.setParameters(params).catch(() => {});
        }
      }
    } catch (e) { /* setParameters not supported */ }
  }

  async _waitForSignalingStable(connection, timeoutMs = 5000) {
    if (!connection || connection.signalingState === 'stable') return true;
    return await new Promise((resolve) => {
      let settled = false;
      const onChange = () => {
        if (settled) return;
        if (connection.signalingState === 'stable') {
          settled = true;
          connection.removeEventListener('signalingstatechange', onChange);
          resolve(true);
        }
      };
      connection.addEventListener('signalingstatechange', onChange);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        connection.removeEventListener('signalingstatechange', onChange);
        resolve(connection.signalingState === 'stable');
      }, timeoutMs);
    });
  }

  _clearOfferAnswerTimer(peer) {
    if (!peer || !peer._offerAnswerTimer) return;
    clearTimeout(peer._offerAnswerTimer);
    peer._offerAnswerTimer = null;
  }

  _scheduleOfferAnswerTimeout(userId, connection, offerId) {
    const peer = this.peers.get(userId);
    if (!peer || peer.connection !== connection) return;
    this._clearOfferAnswerTimer(peer);
    const timeoutCount = peer._offerTimeoutCount || 0;
    const timeoutMs = Math.min(8000 + (timeoutCount * 4000), 20000);
    peer._offerAnswerTimer = setTimeout(() => {
      this._recoverTimedOutOffer(userId, connection, offerId).catch(err => {
        console.warn('[Voice] Failed to recover unanswered offer for peer', userId, err);
      });
    }, timeoutMs);
  }

  async _recoverTimedOutOffer(userId, connection, offerId) {
    const peer = this.peers.get(userId);
    if (!peer || peer.connection !== connection ||
        !peer._awaitingAnswer || peer._activeOfferId !== offerId) return false;

    this._clearOfferAnswerTimer(peer);
    const alreadyQueued = !!peer._renegotiateQueued;
    peer._offerTimeoutCount = (peer._offerTimeoutCount || 0) + 1;
    peer._renegotiateQueued = alreadyQueued || peer._offerTimeoutCount <= 3;
    peer._recoveringTimedOutOffer = true;

    console.warn('[Voice] Offer answer timed out for peer', userId,
      '— rolling back and retrying negotiation');
    if (connection.signalingState === 'have-local-offer') {
      try {
        await connection.setLocalDescription({ type: 'rollback' });
      } catch (err) {
        if (connection.signalingState !== 'stable') {
          peer._recoveringTimedOutOffer = false;
          console.warn('[Voice] Could not roll back timed-out offer for peer', userId, err);
          if (connection.signalingState !== 'closed') {
            this._scheduleOfferAnswerTimeout(userId, connection, offerId);
          }
          return false;
        }
      }
    }
    peer._recoveringTimedOutOffer = false;
    peer._awaitingAnswer = false;
    peer._activeOfferId = null;
    peer._offerIsIceRestart = false;
    peer._offerChannelCode = null;
    if (connection.signalingState === 'stable') {
      if (peer._renegotiateQueued) {
        this._drainQueuedRenegotiation(userId);
      } else {
        peer._offerRecoveryExhausted = true;
        console.warn('[Voice] Automatic offer recovery exhausted for peer', userId,
          '— waiting for a new media or connection event');
      }
      return true;
    }
    return false;
  }

  _drainQueuedRenegotiation(userId) {
    const peer = this.peers.get(userId);
    if (!peer || peer._makingOffer || peer._awaitingAnswer || !peer._renegotiateQueued) return;
    const wantsIceRestart = !!peer._queuedIceRestart;
    peer._renegotiateQueued = false;
    peer._queuedIceRestart = false;
    this._renegotiate(userId, peer.connection, { iceRestart: wantsIceRestart }).catch(() => {});
  }

  async _renegotiate(userId, connection, { iceRestart = false } = {}) {
    const peer = this.peers.get(userId);
    if (!peer || peer.connection !== connection) return false;
    if (peer._makingOffer || peer._awaitingAnswer) {
      peer._renegotiateQueued = true;
      peer._queuedIceRestart = peer._queuedIceRestart || iceRestart;
      return false;
    }
    if (peer._offerRecoveryExhausted) {
      peer._offerRecoveryExhausted = false;
      peer._offerTimeoutCount = 0;
    }
    // Wait for the signaling state to be stable before issuing a fresh
    // offer. RTCPeerConnection.createOffer() throws if called while a
    // previous local-offer or remote-offer is still pending, and the only
    // catch handler used to silently swallow the error — leaving the
    // peer with no video and no retry, which is a leading cause of the
    // "audio works, video tile is black" screen-share bug. Wait up to ~5s
    // for the connection to settle, then proceed. (#5347 v3.15.5)
    peer._makingOffer = true;
    try {
      if (connection.signalingState !== 'stable') {
        const ok = await this._waitForSignalingStable(connection, 5000);
        if (!ok) {
          console.warn('[Voice] _renegotiate: signaling stayed', connection.signalingState, 'for peer', userId, '— queueing retry');
          peer._renegotiateQueued = true;
          peer._queuedIceRestart = peer._queuedIceRestart || iceRestart;
          return false;
        }
      }
      const offer = await connection.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (connection.signalingState !== 'stable') {
        // Another incoming offer won the race while createOffer() was in flight.
        // Leave one queued retry instead of forcing a stale local offer on top.
        peer._renegotiateQueued = true;
        peer._queuedIceRestart = peer._queuedIceRestart || iceRestart;
        return false;
      }
      await connection.setLocalDescription(offer);
      this._offerSequence = (this._offerSequence || 0) + 1;
      const offerId = `${this.localUserId ?? 'unknown'}-${Date.now().toString(36)}-${this._offerSequence.toString(36)}`;
      peer._awaitingAnswer = true;
      peer._activeOfferId = offerId;
      peer._offerChannelCode = this.currentChannel;
      // Remember whether the offer now in flight is an ICE restart, so that if
      // it later yields to glare the restart intent can be re-queued rather
      // than silently downgraded to a plain renegotiation (#5444).
      peer._offerIsIceRestart = iceRestart;
      this._scheduleOfferAnswerTimeout(userId, connection, offerId);
      this.socket.emit('voice-offer', {
        code: peer._offerChannelCode,
        targetUserId: userId,
        offer: offer,
        offerId
      });
      return true;
    } catch (err) {
      console.error('Renegotiation failed for peer', userId, err);
      return false;
    } finally {
      const latestPeer = this.peers.get(userId);
      if (latestPeer && latestPeer.connection === connection) {
        latestPeer._makingOffer = false;
      }
    }
  }

  // ── Private: Peer connection management ─────────────────

  async _createPeer(userId, username, createOffer) {
    // If a peer already exists for this user (e.g. a stale entry from a
    // previous session that wasn't cleaned up via voice-user-left), close
    // it before creating a new one. Without this, we'd leak the old
    // RTCPeerConnection and have two audio elements / analysers running
    // for the same userId.
    if (this.peers.has(userId)) {
      this._removePeer(userId);
    }
    const connection = new RTCPeerConnection(this.rtcConfig);

    // Add our local audio tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        connection.addTrack(track, this.localStream);
      });
    }

    // Apply audio bitrate cap if configured
    if (this.audioBitrate > 0) {
      this._applyAudioBitrate(connection);
    }

    // If we're screen sharing, add those tracks too
    if (this.screenStream && this.isScreenSharing) {
      this.screenStream.getTracks().filter(t => t.readyState === 'live').forEach(track => {
        connection.addTrack(track, this.screenStream);
      });
      // Cap bitrate for this new peer
      const res = this.screenResolution;
      const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
      this._applyScreenBitrate(connection, maxBitrate);
    }

    // If our webcam is active, add the webcam video track
    if (this.webcamStream && this.isWebcamActive) {
      const camTrack = this.webcamStream.getVideoTracks()[0];
      if (camTrack) {
        connection.addTrack(camTrack, this.webcamStream);
      }
    }

    // Handle incoming remote tracks — route audio and video separately
    const remoteAudioStream = new MediaStream();
    const knownScreenStreamIds = new Set();
    let voiceStreamId = null;
    const deferredAudio = []; // audio tracks that arrived before their video

    connection.ontrack = (event) => {
      const track = event.track;
      const sourceStream = event.streams?.[0];
      if (track.kind === 'video') {
        // Distinguish webcam from screen share:
        // - displaySurface is only set on getDisplayMedia tracks
        // - also check our signaling state (webcamUsers vs screenSharers)
        const settings = track.getSettings ? track.getSettings() : {};
        const hasNativeScreen = this._nativeScreenAnnouncements.has(userId);
        const isScreenTrack = !hasNativeScreen &&
          (!!settings.displaySurface || this.screenSharers.has(userId));
        const isWebcamTrack = !settings.displaySurface &&
          (hasNativeScreen || this.webcamUsers.has(userId));

        if (isWebcamTrack && !isScreenTrack) {
          // Route to webcam callback. Remember the track id so
          // _deliverScreenFromReceivers can exclude it when this peer is
          // sending webcam and screen at the same time.
          const p = this.peers.get(userId);
          if (p) p._webcamTrackId = track.id;
          const camStream = sourceStream || new MediaStream([track]);
          if (this.onWebcamStream) this.onWebcamStream(userId, camStream);
          track.onunmute = () => {
            setTimeout(() => {
              const freshStream = new MediaStream([track]);
              if (this.onWebcamStream) this.onWebcamStream(userId, freshStream);
            }, 150);
          };
          track.onended = () => {
            if (this.onWebcamStream) this.onWebcamStream(userId, null);
          };
        } else if (isScreenTrack) {
          // Screen share video
          if (sourceStream) knownScreenStreamIds.add(sourceStream.id);
          const p = this.peers.get(userId);
          if (p) p._screenTrackId = track.id;
          const videoStream = sourceStream || new MediaStream([track]);
          this._screenDelivered.add(userId);
          if (this.onScreenStream) this.onScreenStream(userId, videoStream);
          track.onunmute = () => {
            setTimeout(() => {
              if (this._nativeScreenAnnouncements.has(userId)) return;
              const freshStream = new MediaStream([track]);
              this._screenDelivered.add(userId);
              if (this.onScreenStream) this.onScreenStream(userId, freshStream);
            }, 150);
          };
          track.onmute = () => {};
          track.onended = () => {
            if (this._nativeScreenAnnouncements.has(userId)) return;
            // Don't tear down the tile if the sharer is in the middle of a
            // stop+restart cycle. Their old track ends naturally as part of
            // stopScreenShare, but the screenSharers set (driven by the
            // server's screen-share-started/stopped events) is still true
            // until we get screen-share-stopped. If we cleared the tile
            // here on every onended, the viewer would see the tile vanish
            // and the next track would have to recreate everything — which
            // is fine in theory but masked the stuck-transceiver bug for
            // months by making it look like "the new share never arrived".
            // Only clear when the server has actually told us they stopped.
            // Either way this track is no longer showing them anything, so
            // drop the delivered flag and let the watchdog re-adopt whatever
            // the next share negotiates.
            this._screenDelivered.delete(userId);
            if (!this.screenSharers.has(userId)) {
              if (this.onScreenStream) this.onScreenStream(userId, null);
            }
          };
          // Check if any deferred audio belongs to this screen stream
          for (let i = deferredAudio.length - 1; i >= 0; i--) {
            const d = deferredAudio[i];
            if (d.sourceStream && knownScreenStreamIds.has(d.sourceStream.id)) {
              deferredAudio.splice(i, 1);
              this._playScreenAudio(userId, d.sourceStream);
            }
          }
        }
      } else {
        // Is this audio from a screen share stream?
        //
        // We previously used a heuristic of "if the audio's stream id is
        // different from the first voice stream id we saw, treat as screen
        // audio".  That heuristic broke under renegotiation: when a peer
        // started screen-sharing, their voice track frequently re-fired
        // ontrack with a fresh stream id — getting misclassified as screen
        // audio and routed to a tile (silently) instead of the voice mixer.
        // The user lost the other person's voice the moment either side
        // started sharing.  Now we trust the server-signaled state
        // (screenSharers / webcamUsers) and the presence of video tracks
        // on the same stream.  Only NEW stream ids that arrive while the
        // peer is actively sharing are treated as screen audio; all other
        // audio is voice (and updates voiceStreamId so subsequent renegs
        // don't get re-misclassified either).
        const peerHasNativeScreen = this._nativeScreenAnnouncements.has(userId);
        const peerIsSharing = this.screenSharers.has(userId) && !peerHasNativeScreen;
        const streamHasVideo = sourceStream && sourceStream.getVideoTracks().length > 0;
        const knownAsScreen = sourceStream && knownScreenStreamIds.has(sourceStream.id);
        const isScreenAudio = !peerHasNativeScreen &&
          (knownAsScreen || (peerIsSharing && streamHasVideo));

        // Track order across an m-section is not guaranteed: the audio of a
        // screen share can arrive before its video, in which case none of the
        // signals above have fired yet and this would be filed as voice
        // permanently. deferredAudio existed for exactly this and was drained
        // in the video branch, but nothing ever pushed into it, so the case
        // was unreachable. Park it briefly instead, and fall back to voice if
        // no video shows up — never silently drop someone's speech. (#5426)
        const mayBeScreenAudio = !isScreenAudio && peerIsSharing && !streamHasVideo &&
                                 sourceStream && sourceStream.id !== voiceStreamId;
        if (mayBeScreenAudio) {
          deferredAudio.push({ track, sourceStream });
          setTimeout(() => {
            const idx = deferredAudio.findIndex(d => d.track === track);
            if (idx === -1) return;              // the video branch claimed it
            deferredAudio.splice(idx, 1);
            if (track.readyState !== 'live') return;
            remoteAudioStream.addTrack(track);
            this._playAudio(userId, remoteAudioStream);
          }, 1500);
          return;
        }

        if (isScreenAudio) {
          this._playScreenAudio(userId, sourceStream);
        } else {
          // Voice path \u2014 update voiceStreamId so it tracks the latest
          // negotiation rather than being permanently pinned to the first.
          if (sourceStream) voiceStreamId = sourceStream.id;
          remoteAudioStream.addTrack(track);
          this._playAudio(userId, remoteAudioStream);
        }
      }
    };

    // Send ICE candidates to the remote peer via server
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('voice-ice-candidate', {
          code: this.currentChannel,
          targetUserId: userId,
          candidate: event.candidate
        });
      }
    };

    connection.addEventListener('signalingstatechange', () => {
      const latestPeer = this.peers.get(userId);
      if (!latestPeer || latestPeer.connection !== connection) return;
      if (connection.signalingState === 'stable') {
        if (latestPeer._awaitingAnswer && !latestPeer._recoveringTimedOutOffer) {
          this._clearOfferAnswerTimer(latestPeer);
          latestPeer._awaitingAnswer = false;
          latestPeer._activeOfferId = null;
          latestPeer._offerTimeoutCount = 0;
          latestPeer._offerRecoveryExhausted = false;
        }
        latestPeer._offerChannelCode = null;
        if (!latestPeer._recoveringTimedOutOffer && !latestPeer._handlingRemoteOffer) {
          this._drainQueuedRenegotiation(userId);
        }
      }
    });

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'failed') {
        // Try ICE restart before giving up
        this._restartIce(userId, connection);
      } else if (state === 'disconnected') {
        // 'disconnected' is often transient during renegotiation (e.g. after
        // screen-share stops). Give the connection time to recover before
        // tearing it down — Chrome frequently goes disconnected→connected.
        if (!this._disconnectTimers) this._disconnectTimers = {};
        if (this._disconnectTimers[userId]) clearTimeout(this._disconnectTimers[userId]);
        this._disconnectTimers[userId] = setTimeout(() => {
          if (connection.connectionState === 'disconnected' ||
              connection.connectionState === 'failed') {
            this._restartIce(userId, connection);
          }
          delete this._disconnectTimers[userId];
        }, 8000);
      } else if (state === 'connected') {
        // Clear any pending disconnect timer — connection recovered
        if (this._disconnectTimers?.[userId]) {
          clearTimeout(this._disconnectTimers[userId]);
          delete this._disconnectTimers[userId];
        }
        // ICE/DTLS just came (back) up. If this peer is screen-sharing,
        // the video m-line may need a fresh delivery into the UI — ontrack
        // does not always re-fire after an ICE restart, so the tile that
        // was live before the blip can stay black/missing until we adopt
        // the receiver track ourselves.
        if (this.screenSharers.has(userId)) {
          if (!this._deliverScreenFromReceivers(userId)) {
            this._screenDelivered.delete(userId);
            this._watchForScreenStream(userId);
          }
        }
      }
    };

    this.peers.set(userId, {
      connection,
      stream: remoteAudioStream,
      username,
      _makingOffer: false,
      _awaitingAnswer: false,
      _activeOfferId: null,
      _offerAnswerTimer: null,
      _offerTimeoutCount: 0,
      _offerRecoveryExhausted: false,
      _recoveringTimedOutOffer: false,
      _handlingRemoteOffer: false,
      _supportsOfferIds: false,
      _renegotiateQueued: false,
      _queuedIceRestart: false,
      _offerIsIceRestart: false,
      _offerChannelCode: null,
    });

    // If we're the initiator, create and send an offer
    if (createOffer) {
      await this._renegotiate(userId, connection);
    }
  }

  _removePeer(userId) {
    // Cancel any pending ICE-restart-recovery check so a departed peer can't
    // be re-restarted after removal (voice-user-left, leave, stale-peer
    // teardown all route through here). (#5444)
    if (this._iceHealTimers && this._iceHealTimers[userId]) {
      clearTimeout(this._iceHealTimers[userId]);
      delete this._iceHealTimers[userId];
    }
    const peer = this.peers.get(userId);
    if (peer) {
      this._clearOfferAnswerTimer(peer);
      peer.connection.close();
      const audioEl = document.getElementById(`voice-audio-${userId}`);
      if (audioEl) audioEl.remove();
      const screenAudioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (screenAudioEl) screenAudioEl.remove();
      this.screenGainNodes.delete(userId);
      this.gainNodes.delete(userId);
      this._screenDelivered.delete(userId);
      this.peers.delete(userId);
      // Always stop the analyser here too, not just in voice-user-left.
      // _restartIce failure calls _removePeer directly (without _stopAnalyser),
      // which would leave an orphaned interval connected to the dead stream.
      // On reconnect _startAnalyser would then hit the analysers.has() guard
      // and return early, making voice-activity indicators permanently dead for
      // that peer without this cleanup.
      this._stopAnalyser(userId);
    }
  }

  async _restartIce(userId, connection, attempt = 0) {
    // _renegotiate swallows its own errors and returns false instead of
    // throwing, so the try/catch that used to wrap this call was dead code:
    // a stuck or un-issuable ICE restart silently left the peer with a dead
    // media path and no retry. That is the "rejoined voice but still can't
    // hear one person until I leave and rejoin" report (#5444). Verify the
    // connection actually recovers, and if it's still broken a few seconds
    // later, re-attempt the ICE restart a bounded number of times. An ICE
    // restart continues the SAME RTCPeerConnection and is applied bilaterally
    // by the remote via 'voice-offer', so re-issuing it is safe and
    // near-seamless on a healthy pair — unlike tearing the peer down, which
    // would need both sides to rebuild in lock-step.
    await this._renegotiate(userId, connection, { iceRestart: true });

    if (!this._iceHealTimers) this._iceHealTimers = {};
    if (this._iceHealTimers[userId]) clearTimeout(this._iceHealTimers[userId]);
    this._iceHealTimers[userId] = setTimeout(() => {
      delete this._iceHealTimers[userId];
      const peer = this.peers.get(userId);
      // Peer was replaced, removed, or we left voice — nothing to do.
      if (!this.inVoice || !peer || peer.connection !== connection) return;
      const cs = connection.connectionState;
      const ics = connection.iceConnectionState;
      // Only intervene when the path is definitively broken. 'connecting' /
      // 'checking' / 'new' mean the restart is still negotiating (slow TURN
      // relay), so leave those to finish instead of restarting underneath.
      const broken = cs === 'failed' || cs === 'disconnected' ||
                     ics === 'failed' || ics === 'disconnected';
      if (!broken) return;
      if (attempt >= 2) {
        console.warn('[Voice] ICE restart exhausted for', userId,
          `(conn=${cs}, ice=${ics}) — leaving peer for the next reconnect/heal sweep`);
        return;
      }
      console.warn('[Voice] ICE restart did not recover peer', userId,
        `(conn=${cs}, ice=${ics}) — re-attempting (retry ${attempt + 1})`);
      this._restartIce(userId, connection, attempt + 1);
    }, 5000);
  }

  // (#5427) Proactive recovery sweep, called after a socket reconnect while
  // still in voice.
  //
  // The first cut of this only ICE-restarted peers whose connection reported
  // 'failed'/'disconnected'. That turned out to be a no-op for the exact
  // population that hit the bug: web clients on Firefox/Edge, where after a
  // brief socket flap the RTCPeerConnection to a now-dead relayed path keeps
  // reporting 'connected'/'completed' even though no media is flowing. The
  // server's fast-path rejoin keeps everyone's existing peer connections (no
  // voice-user-left / -joined churn), so the *other* peers also never rebuild
  // their side — leaving the rejoiner audible to some people and silent to
  // others, with nothing on either end self-correcting. That's the
  // "voice activity shows server-side but some people can't hear me" report.
  //
  // We can't trust connectionState here, so don't try to be clever: ICE-restart
  // *every* peer. A single RTCPeerConnection carries both directions, so a
  // restart initiated from the rejoiner repairs the media path both ways for
  // that pair (the remote handles our iceRestart offer in 'voice-offer'). On a
  // genuinely-healthy connection an ICE restart is cheap and near-seamless —
  // media keeps flowing on the old candidate pair until the new one validates —
  // so over-restarting is far better than leaving a dead path silent. This only
  // runs in response to an actual socket reconnect, not routinely, so the cost
  // is bounded to the rare flap that triggered it. Stagger the restarts so we
  // don't fire a burst of simultaneous offers through signaling.
  _healPeerConnections() {
    if (!this.inVoice) return;
    // After the ICE sweep, re-check every active screen share. A heal that
    // restores voice audio often leaves screen video undelivered because
    // ontrack doesn't re-fire for an already-negotiated transceiver.
    setTimeout(() => { try { this._rearmScreenWatchdogs(); } catch {} }, 2500);
    let i = 0;
    for (const [userId, peer] of this.peers) {
      const conn = peer && peer.connection;
      if (!conn || conn.connectionState === 'closed') continue;
      const delay = (i++) * 200;
      setTimeout(() => {
        const current = this.peers.get(userId);
        // Bail if the peer was torn down/replaced while we were waiting.
        if (!this.inVoice || !current || current.connection !== conn) return;
        if (conn.connectionState === 'closed') return;
        console.warn('[Voice] post-reconnect heal: ICE-restarting peer', userId,
          `(conn=${conn.connectionState}, ice=${conn.iceConnectionState})`);
        this._restartIce(userId, conn);
      }, delay);
    }
  }

  async _healPeerConnectionsAfterChannelRotation(oldCode) {
    const rollbacks = [];
    for (const [, peer] of this.peers) {
      const connection = peer?.connection;
      if (!connection || peer._offerChannelCode !== oldCode) continue;
      peer._makingOffer = false;
      this._clearOfferAnswerTimer(peer);
      peer._awaitingAnswer = false;
      peer._activeOfferId = null;
      peer._offerTimeoutCount = 0;
      peer._offerRecoveryExhausted = false;
      peer._recoveringTimedOutOffer = false;
      peer._offerIsIceRestart = false;
      peer._offerChannelCode = null;
      if (connection.signalingState === 'have-local-offer') {
        rollbacks.push(connection.setLocalDescription({ type: 'rollback' }).catch(() => {}));
      }
    }
    if (rollbacks.length) await Promise.all(rollbacks);
    this._flushPendingScreenStop(this.currentChannel);
    if (this.isScreenSharing && this.currentChannel) {
      this._reannounceScreenShare([], {
        channelCode: this.currentChannel,
        voiceGeneration: this._voiceSessionGeneration || 0,
      }).catch(err => {
        console.warn('[Voice] Failed to restore screen share after channel rotation:', err);
      });
    }
    this._healPeerConnections();
  }

  // ── Volume Control ──────────────────────────────────────

  setVolume(userId, volume) {
    const gainNode = this.gainNodes.get(userId);
    if (gainNode) {
      // Web Audio GainNode supports values > 1.0 for boost
      gainNode.gain.value = Math.max(0, Math.min(2, volume));
    } else {
      // Fallback: HTMLAudioElement volume (capped at 1.0, no boost)
      const audioEl = document.getElementById(`voice-audio-${userId}`);
      if (audioEl) audioEl.volume = Math.max(0, Math.min(1, volume));
    }
  }

  // ── Per-user Deafen (stop sending our audio to a specific peer) ──

  deafenUser(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.deafenedUsers.add(userId);

    // Replace our audio track with a silent one for this peer
    const senders = peer.connection.getSenders();
    const audioSender = senders.find(s => s.track && s.track.kind === 'audio' &&
      (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)));
    if (audioSender) {
      // Create a silent audio track
      const silentTrack = this._createSilentAudioTrack();
      // Store original track for restore
      peer._originalAudioTrack = audioSender.track;
      audioSender.replaceTrack(silentTrack).catch(() => {});
    }
  }

  undeafenUser(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.deafenedUsers.delete(userId);

    // Restore the original audio track
    if (peer._originalAudioTrack) {
      const senders = peer.connection.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio' &&
        (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)));
      if (audioSender) {
        audioSender.replaceTrack(peer._originalAudioTrack).catch(() => {});
      }
      peer._originalAudioTrack = null;
    }
  }

  isUserDeafened(userId) {
    return this.deafenedUsers.has(userId);
  }

  _createSilentAudioTrack() {
    // Reuse cached silent track to avoid creating new AudioContext/oscillator on every deafen
    if (this._cachedSilentTrack && this._cachedSilentTrack.readyState === 'live') {
      return this._cachedSilentTrack;
    }
    const ctx = this._ensureAudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0; // completely silent
    oscillator.connect(gain);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    oscillator.start();
    this._cachedSilentTrack = dest.stream.getAudioTracks()[0];
    return this._cachedSilentTrack;
  }

  _getSavedVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem('haven_voice_volumes') || '{}');
      return (vols[userId] ?? 100) / 100;
    } catch { return 1; }
  }

  // ── Live Device Switching ────────────────────────────────

  /**
   * Switch the active microphone (input device) while in a voice call.
   * Re-acquires getUserMedia with the new deviceId, rebuilds the noise-gate
   * chain, and replaces the audio track on every peer connection.
   * @param {string} deviceId - MediaDeviceInfo.deviceId (empty = system default)
   */
  async switchInputDevice(deviceId) {
    if (!this.inVoice) return;

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    let newRawStream;
    try {
      newRawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (err) {
      console.error('[Voice] Failed to switch input device:', err);
      return;
    }

    // Stop old raw tracks
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => t.stop());
    }
    this.rawStream = newRawStream;

    // Rebuild noise gate chain
    this._disableRNNoise();
    this._stopNoiseGate();
    this._stopLocalTalkDetection();

    const source = this.audioCtx.createMediaStreamSource(this.rawStream);
    this._rnnoiseSource = source;
    const gateAnalyser = this.audioCtx.createAnalyser();
    gateAnalyser.fftSize = 2048;
    gateAnalyser.smoothingTimeConstant = 0.3;
    source.connect(gateAnalyser);

    const gateGain = this.audioCtx.createGain();
    source.connect(gateGain);

    const dest = this.audioCtx.createMediaStreamDestination();
    gateGain.connect(dest);

    this._noiseGateAnalyser = gateAnalyser;
    this._noiseGateGain = gateGain;

    const oldLocalStream = this.localStream;
    this.localStream = dest.stream;
    this._startNoiseGate();
    this._startLocalTalkDetection();

    // Re-enable RNNoise if it was active (bytes loaded is enough to re-arm;
    // _rnnoiseReady flips true asynchronously when the worklet confirms).
    if (this.noiseMode === 'suppress' && this._rnnoiseWasmBytes) {
      this.setNoiseSensitivity(0);
      this._enableRNNoise();
    } else if (this.noiseMode === 'gate') {
      const saved = parseInt(localStorage.getItem('haven_ns_value') || '10', 10);
      this.setNoiseSensitivity(saved);
    } else if (this.noiseMode === 'off') {
      this.setNoiseSensitivity(0);
    }

    // Replace the audio track on every peer connection, concurrently (see
    // switchCamera). (#5426)
    const newTrack = this.localStream.getAudioTracks()[0];
    const swaps = [];
    for (const [, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio' &&
        (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)));
      if (audioSender) {
        swaps.push(audioSender.replaceTrack(newTrack).catch(e =>
          console.warn('[Voice] replaceTrack failed for peer:', e)
        ));
      }
    }
    await Promise.all(swaps);

    // Re-apply mute state
    if (this.isMuted) {
      this.rawStream.getAudioTracks().forEach(t => { t.enabled = false; });
      this.localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    }

    // Clean up old local stream
    if (oldLocalStream) {
      oldLocalStream.getTracks().forEach(t => t.stop());
    }

    // Persist preference
    localStorage.setItem('haven_input_device', deviceId || '');
    console.log(`[Voice] Input device switched: ${deviceId || 'default'}`);
  }

  /**
   * Switch the output device (speaker/headphones) for all voice audio.
   * Routes through both HTMLMediaElement.setSinkId() AND AudioContext.setSinkId()
   * since voice audio is piped through Web Audio API gain nodes.
   * @param {string} deviceId - MediaDeviceInfo.deviceId (empty = system default)
   */
  async switchOutputDevice(deviceId) {
    localStorage.setItem('haven_output_device', deviceId || '');

    // 1. Switch the AudioContext output (this is where voice audio actually plays)
    if (this.audioCtx && typeof this.audioCtx.setSinkId === 'function') {
      try {
        await this.audioCtx.setSinkId(deviceId || '');
        console.log(`[Voice] AudioContext sink switched: ${deviceId || 'default'}`);
      } catch (e) {
        console.warn('[Voice] AudioContext.setSinkId failed:', e);
      }
    }

    // 2. Also switch any HTMLMediaElements (fallback audio, screen share, etc.)
    const elements = Array.from(document.querySelectorAll('audio, video'));
    if (this._botAudio && !elements.includes(this._botAudio.audio)) elements.push(this._botAudio.audio);
    for (const el of elements) {
      if (typeof el.setSinkId === 'function') {
        try { await el.setSinkId(deviceId || ''); } catch (e) {
          console.warn('[Voice] setSinkId failed on element:', e);
        }
      }
    }
    console.log(`[Voice] Output device switched: ${deviceId || 'default'}`);
  }

  // ── Screen Share Audio ────────────────────────────────

  _playScreenAudio(userId, stream) {
    const key = `screen-${userId}`;
    let audioEl = document.getElementById(`voice-audio-${key}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `voice-audio-${key}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.getElementById('audio-container').appendChild(audioEl);

      // Apply saved output device
      const savedOutput = localStorage.getItem('haven_output_device');
      if (savedOutput && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(savedOutput).catch(() => {});
      }
    }
    audioEl.srcObject = stream;

    // If a gain node already exists but the stream changed, tear it down
    // so we rebuild the AudioContext chain for the new source.
    const existingGain = this.screenGainNodes.get(userId);
    if (existingGain) {
      try { existingGain.disconnect(); } catch {}
      this.screenGainNodes.delete(userId);
    }

    // Native element playout is the DEFAULT for incoming screen-share audio.
    // Routing a relayed remote stream through createMediaStreamSource → gain →
    // destination fights WebRTC's adaptive jitter buffer (NetEq): the AudioCtx
    // pulls at its own fixed clock while NetEq is busy adapting to relay jitter,
    // so the two clocks drift apart. Over a TURN relay this builds up over a
    // minute or two and then stutters/desyncs from the video continuously (LAN
    // is jitter-free so it never shows there) — exactly the #5426 report. Native
    // <audio> playout keeps NetEq in charge end to end, so it stays in sync.
    //
    // This used to be an opt-in Debug toggle that defaulted to the broken Web
    // Audio path; it's now inverted. The Web Audio mixer is only needed for the
    // >100% per-stream volume boost, so it's strictly opt-in via Settings →
    // Debug ("Web Audio mixing for screen-share audio"). iOS/WebKit always uses
    // native playout (createMediaStreamSource yields silence there).
    let _useWebAudioScreen = false;
    try { _useWebAudioScreen = localStorage.getItem('screen_audio_webaudio') === '1'; } catch {}
    if (_IS_IOS_WEBKIT || !_useWebAudioScreen) {
      const savedVolume = Math.min(1, this._getSavedStreamVolume(userId));
      if (this.isDeafened) {
        audioEl.dataset.prevVolume = String(savedVolume);
        audioEl.volume = 0;
      } else {
        audioEl.volume = savedVolume;
      }
      audioEl.play().catch(() => {});
      // Native playout is now the default path, so still announce that this
      // share has audio — this is what reveals the 🔊 badge and the per-stream
      // volume controls on the tile. (#5426)
      if (this.onScreenAudio) this.onScreenAudio(userId);
      return;
    }

    try {
      this._ensureAudioCtx();
      const source = this.audioCtx.createMediaStreamSource(stream);
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getAppliedIncomingVolume(this._getSavedStreamVolume(userId));
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.screenGainNodes.set(userId, gainNode);
      audioEl.volume = 0;
    } catch {
      const savedVolume = Math.min(1, this._getSavedStreamVolume(userId));
      if (this.isDeafened) {
        audioEl.dataset.prevVolume = String(savedVolume);
        audioEl.volume = 0;
      } else {
        audioEl.volume = savedVolume;
      }
    }
    if (this.onScreenAudio) this.onScreenAudio(userId);
  }

  // Re-route every screen-share audio stream that's currently playing to match
  // the current "Web Audio mixing for screen-share audio" debug setting, so
  // flipping the toggle takes effect immediately instead of on the next
  // reshare. _playScreenAudio tears down any existing gain node and rebuilds
  // the correct path for the new setting. (#5426)
  reapplyScreenAudioRouting() {
    document.querySelectorAll('audio[id^="voice-audio-screen-"]').forEach(el => {
      const stream = el.srcObject;
      if (!stream) return;
      const raw = el.id.replace('voice-audio-screen-', '');
      const userId = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
      this._playScreenAudio(userId, stream);
    });
  }

  setStreamVolume(userId, volume) {
    // Map keys may be number or string depending on caller — try both
    const gainNode = this.screenGainNodes.get(userId)
      || this.screenGainNodes.get(String(userId))
      || this.screenGainNodes.get(Number(userId));
    const clampedGain = Math.max(0, Math.min(2, volume));
    const clampedVol  = Math.max(0, Math.min(1, volume));
    const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (gainNode) {
      // The Web Audio graph is the active output for this stream. Drive volume
      // through the gain node and keep the <audio> element muted — if we let the
      // element play too, the screen audio comes out of BOTH the gain node and
      // the element at once, which is the "screen audio duplicates" report. The
      // old "belt-and-suspenders" element sync was the cause, not a safety net.
      // (#5426)
      gainNode.gain.value = clampedGain;
      if (audioEl) audioEl.volume = 0;
    } else if (audioEl) {
      // No gain node (iOS / Web-Audio fallback path) — the element itself is
      // the output, so volume rides on the element.
      audioEl.volume = clampedVol;
    }
  }

  _getSavedStreamVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem('haven_stream_volumes') || '{}');
      return (vols[userId] ?? 100) / 100;
    } catch { return 1; }
  }

  // ── Noise Gate ───────────────────────────────────────────

  setNoiseMode(mode) {
    // mode: 'off' | 'gate' | 'suppress'
    this.noiseMode = mode;
    localStorage.setItem('haven_noise_mode', mode);

    if (mode === 'suppress') {
      // Disable noise gate, enable RNNoise
      if (this.noiseSensitivity !== 0) {
        this.setNoiseSensitivity(0);
      }
      // _rnnoiseWasmBytes = bytes loaded on main thread.
      // _rnnoiseReady = worklet confirmed init (set asynchronously in _enableRNNoise).
      if (!this._rnnoiseWasmBytes) {
        this._initRNNoise().then(() => {
          if (this._rnnoiseWasmBytes) this._enableRNNoise();
          else console.warn('[Voice] AI suppression unavailable (WASM failed to load)');
        });
      } else {
        this._enableRNNoise();
      }
    } else if (mode === 'gate') {
      // Disable RNNoise, enable noise gate with saved sensitivity
      this._disableRNNoise();
      const saved = parseInt(localStorage.getItem('haven_ns_value') || '10', 10);
      this.setNoiseSensitivity(saved);
    } else {
      // Off — disable both
      this._disableRNNoise();
      this.setNoiseSensitivity(0);
    }
  }

  async _initRNNoise() {
    // Loads the worklet module + wasm bytes. Does NOT set _rnnoiseReady —
    // that only flips true when the worklet posts {type:'ready'} (#5458).
    if (!this.audioCtx) return;
    // addModule() registers the processor on ONE AudioContext, but the wasm
    // bytes are reusable across contexts. Guarding on the bytes alone meant
    // that after leave() closed the context, a rejoin built a fresh one, this
    // returned early, addModule() never ran on it, and _enableRNNoise() threw
    // "AudioWorklet does not have a valid AudioWorkletGlobalScope". Keying on
    // the context itself survives any future teardown path that forgets to
    // clear state, which clearing the bytes field would not. (#5458)
    if (this._rnnoiseModuleCtx === this.audioCtx && this._rnnoiseWasmBytes) return;
    // Capture the context: awaits below can straddle a leave/rejoin.
    const ctx = this.audioCtx;
    try {
      await ctx.audioWorklet.addModule('/js/rnnoise-processor.js');
      this._rnnoiseModuleCtx = ctx;
      if (!this._rnnoiseWasmBytes) {
        const wasmResponse = await fetch('/js/rnnoise.wasm');
        if (!wasmResponse.ok) {
          throw new Error(`rnnoise.wasm HTTP ${wasmResponse.status}`);
        }
        const wasmBytes = await wasmResponse.arrayBuffer();
        if (!wasmBytes || wasmBytes.byteLength < 1000) {
          throw new Error(`rnnoise.wasm too small (${wasmBytes ? wasmBytes.byteLength : 0} bytes)`);
        }
        // Early validity check on the main thread so a corrupt/HTML 404 body
        // fails here with a clear log, not inside the worklet.
        await WebAssembly.compile(wasmBytes.slice(0));
        this._rnnoiseWasmBytes = wasmBytes;
      }
      this._rnnoiseReady = false;
    } catch (err) {
      console.warn('[Voice] RNNoise init failed:', err);
      this._rnnoiseModuleCtx = null;
      this._rnnoiseWasmBytes = null;
      this._rnnoiseReady = false;
    }
  }

  _enableRNNoise() {
    if (!this._rnnoiseWasmBytes || !this._rnnoiseSource || this._rnnoiseNode) return;
    try {
      // RNNoise is locked to 48 kHz frames. Warn (don't hard-fail) if the
      // AudioContext landed on a different rate — suppression still runs
      // but frequency mapping is wrong and quality drops (#5458).
      if (this.audioCtx && this.audioCtx.sampleRate !== 48000) {
        console.warn(
          `[Voice] RNNoise expects 48 kHz but AudioContext is ${this.audioCtx.sampleRate} Hz — ` +
          'suppression quality will be reduced. Prefer an output device at 48 kHz.'
        );
      }

      const node = new AudioWorkletNode(this.audioCtx, 'rnnoise-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1], channelCount: 1
      });

      // Listen for worklet ready/error. Previously these messages were
      // discarded, so a silent init failure looked "healthy" (#5458).
      node.port.onmessage = (e) => {
        const data = e && e.data;
        if (!data || !data.type) return;
        if (data.type === 'ready') {
          this._rnnoiseReady = true;
          console.log('[Voice] RNNoise worklet ready', data.sampleRate ? `(sr=${data.sampleRate})` : '');
        } else if (data.type === 'error') {
          console.warn('[Voice] RNNoise worklet error:', data.message);
          this._rnnoiseReady = false;
          // Tear the dead node out so audio keeps flowing unprocessed
          // rather than sitting on a forever-passthrough worklet that
          // claims to be "AI suppression".
          try { this._disableRNNoise(); } catch {}
        }
      };
      node.port.onmessageerror = () => {
        console.warn('[Voice] RNNoise port messageerror (WASM payload failed to clone)');
        this._rnnoiseReady = false;
        try { this._disableRNNoise(); } catch {}
      };

      // Post raw bytes (transfer a copy so our cached buffer stays usable
      // for the next enable). WebAssembly.Module does NOT survive structured
      // clone into AudioWorkletGlobalScope — that was the whole bug.
      const bytesCopy = this._rnnoiseWasmBytes.slice(0);
      node.port.postMessage({ type: 'wasm-bytes', bytes: bytesCopy }, [bytesCopy]);

      // Re-wire: source → rnnoise → gateGain (gate is open since sensitivity=0).
      // Audio passes through the worklet until {type:'ready'}; then processed.
      this._rnnoiseSource.disconnect(this._noiseGateGain);
      this._rnnoiseSource.connect(node);
      node.connect(this._noiseGateGain);
      this._rnnoiseNode = node;
      this._rnnoiseReady = false; // stays false until worklet confirms
    } catch (err) {
      console.warn('[Voice] Failed to enable RNNoise:', err);
      this._rnnoiseReady = false;
    }
  }

  _disableRNNoise() {
    if (!this._rnnoiseNode) return;
    try {
      this._rnnoiseNode.port.postMessage({ type: 'destroy' });
      this._rnnoiseNode.disconnect();
      this._rnnoiseNode = null;
      this._rnnoiseReady = false;
      // Re-wire: source → gateGain directly
      if (this._rnnoiseSource && this._noiseGateGain) {
        this._rnnoiseSource.connect(this._noiseGateGain);
      }
    } catch (err) {
      console.warn('[Voice] Failed to disable RNNoise:', err);
    }
  }

  setNoiseSensitivity(value) {
    // value: 0 (off / gate open) → 100 (aggressive gating)
    this.noiseSensitivity = Math.max(0, Math.min(100, value));
    // Immediately open gate if set to 0
    if (this.noiseSensitivity === 0 && this._noiseGateGain) {
      this._noiseGateGain.gain.setTargetAtTime(1, this.audioCtx.currentTime, 0.01);
    }
    return this.noiseSensitivity;
  }

  _startNoiseGate() {
    if (this._noiseGateInterval) return;
    const analyser = this._noiseGateAnalyser;
    const gain = this._noiseGateGain;
    if (!analyser || !gain) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const ATTACK = 0.015;    // Gate opens fast (seconds, ~15ms)
    const RELEASE = 0.12;    // Gate closes gently (seconds, ~120ms)
    const HOLD_MS = 250;     // Keep gate open 250ms after level drops below threshold
    const OPEN_CONFIRM = 1;  // Require signal above threshold for this many extra polls
                             // before opening (filters transient clicks/taps, ~20ms at 20ms poll)
    let gateOpen = false;
    let holdTimeout = null;
    let aboveCount = 0;      // consecutive polls above threshold

    this._noiseGateInterval = setInterval(() => {
      if (this.noiseSensitivity === 0) {
        gain.gain.value = 1;
        this.currentMicLevel = 0;
        gateOpen = false;
        aboveCount = 0;
        if (holdTimeout) { clearTimeout(holdTimeout); holdTimeout = null; }
        return;
      }
      // Map sensitivity 1-100 → threshold 2-40
      const threshold = 2 + (this.noiseSensitivity / 100) * 38;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;

      // Expose current level for UI meter (0-100 scale, capped)
      this.currentMicLevel = Math.min(100, (avg / 50) * 100);

      // Guard against audioCtx being torn down between ticks (leave()
      // nulls it but the interval can still fire once before we clear it).
      if (!this.audioCtx) return;
      if (avg > threshold) {
        // Signal is above threshold — confirm it sustains before opening
        aboveCount++;
        if (holdTimeout) { clearTimeout(holdTimeout); holdTimeout = null; }
        if (!gateOpen && aboveCount > OPEN_CONFIRM) {
          gain.gain.setTargetAtTime(1, this.audioCtx.currentTime, ATTACK);
          gateOpen = true;
        }
      } else {
        aboveCount = 0;
        if (gateOpen && !holdTimeout) {
          // Signal dropped below threshold — start hold timer before closing
          holdTimeout = setTimeout(() => {
            if (!this.audioCtx) return;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, RELEASE);
            gateOpen = false;
            holdTimeout = null;
          }, HOLD_MS);
        }
      }
    }, 20);
  }

  _stopNoiseGate() {
    if (this._noiseGateInterval) {
      clearInterval(this._noiseGateInterval);
      this._noiseGateInterval = null;
    }
    this._noiseGateAnalyser = null;
    this._noiseGateGain = null;
    this._rnnoiseSource = null;
    this.currentMicLevel = 0;
  }

  // ── AudioContext lifecycle ──────────────────────────────

  /**
   * Create (or reuse) the shared AudioContext and attach a one-time
   * statechange watchdog that auto-resumes whenever Chromium suspends it.
   * Chromium (including Electron) automatically suspends an AudioContext
   * when document.hidden becomes true (window minimised).  Without this
   * watchdog the talking-detection analysers return zeros after the window
   * is restored, making all voice-activity indicators go dark permanently.
   */
  _ensureAudioCtx() {
    if (!this.audioCtx) {
      // Honor the user's persisted output device at construction time.
      // Without this, the context defaults to the system default playout
      // and switchOutputDevice() never fires until the user opens the
      // device picker, which is exactly the symptom in #184 (audio routes
      // to speakers when the user already chose their headset).
      //
      // sampleRate: 48000 — RNNoise is fixed at 48 kHz frames. Leaving the
      // context free to follow a 96 kHz headset silently halves the model's
      // frequency mapping and defeats AI suppression even when WASM loads
      // correctly (#5458). Browsers resample to the device as needed.
      const savedOutput = localStorage.getItem('haven_output_device') || '';
      const ctxOpts = { sampleRate: 48000 };
      if (savedOutput && typeof AudioContext !== 'undefined' &&
          AudioContext.prototype && 'setSinkId' in AudioContext.prototype) {
        ctxOpts.sinkId = savedOutput;
      }
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(ctxOpts);
      } catch {
        // Older Chromium throws when sinkId is passed in options — retry
        // with just sampleRate, then fully bare.
        try {
          this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        } catch {
          this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
      }
      // Best-effort: if sinkId-in-options wasn't honored but setSinkId() is
      // available on the instance, apply it now.
      if (savedOutput && typeof this.audioCtx.setSinkId === 'function') {
        this.audioCtx.setSinkId(savedOutput).catch(() => {});
      }
      // Attach watchdog once so it survives future suspend/resume cycles.
      this.audioCtx.addEventListener('statechange', () => {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
      });
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  // ── Talking Detection ───────────────────────────────────

  _startAnalyser(userId, analyserNode, dataArray) {
    // Reuse an already-connected AnalyserNode; just start polling
    if (this.analysers.has(userId)) return; // already running

    const THRESHOLD = 20;
    let wasTalking = false;
    let holdTimer = null;
    const HOLD_MS = 300; // keep indicator lit for 300ms after speech stops

    const interval = setInterval(() => {
      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const isTalking = avg > THRESHOLD;

      if (isTalking) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (!wasTalking) {
          wasTalking = true;
          this.talkingState.set(userId, true);
          if (this.onTalkingChange) this.onTalkingChange(userId, true);
        }
      } else if (wasTalking && !holdTimer) {
        // Start hold timer — keep "talking" for HOLD_MS after silence
        holdTimer = setTimeout(() => {
          wasTalking = false;
          holdTimer = null;
          this.talkingState.set(userId, false);
          if (this.onTalkingChange) this.onTalkingChange(userId, false);
        }, HOLD_MS);
      }
    }, 60);

    this.analysers.set(userId, { analyser: analyserNode, dataArray, interval });
  }

  _stopAnalyser(userId) {
    const a = this.analysers.get(userId);
    if (a) {
      clearInterval(a.interval);
      this.analysers.delete(userId);
      this.talkingState.delete(userId);
      if (this.onTalkingChange) this.onTalkingChange(userId, false);
    }
  }

  _startLocalTalkDetection() {
    if (!this.rawStream || this._localTalkInterval) return;
    try {
      this._ensureAudioCtx();

      const source = this.audioCtx.createMediaStreamSource(this.rawStream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const THRESHOLD = 15; // Slightly higher than noise gate to avoid flickering
      let wasTalking = false;
      let holdTimer = null;
      const HOLD_MS = 300;

      this._localTalkAnalyser = { analyser, source };
      const setSelfTalking = (talking) => {
        // Always update the self-speaking indicator directly from the local
        // analyser rather than waiting for the server echo.  The server echo
        // path (voice-speaking → server → broadcast back) is unreliable for
        // self: if the socket ever briefly loses voice-room membership (e.g.
        // after a reconnect grace-period window), the echo never arrives and
        // the indicator stays permanently dark.  Audio and the server-side
        // speaking events for OTHER users are unaffected — we still emit
        // voice-speaking to the server so peers see the indicator too.
        if (talking) this.talkingState.set('self', true);
        else this.talkingState.delete('self');
        if (this.onTalkingChange) this.onTalkingChange('self', talking);
      };
      this._localTalkInterval = setInterval(() => {
        if (this.isMuted) {
          if (wasTalking) {
            wasTalking = false;
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            setSelfTalking(false);
            if (this.socket && this.inVoice) this.socket.emit('voice-speaking', { speaking: false });
          }
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isTalking = avg > THRESHOLD;

        if (isTalking) {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          if (!wasTalking) {
            wasTalking = true;
            setSelfTalking(true);
            if (this.socket && this.inVoice) this.socket.emit('voice-speaking', { speaking: true });
          }
          // Notify server of voice activity for AFK tracking (throttled to once per 15s)
          if (this.socket && this.inVoice && (!this._lastVoiceSpeakPing || Date.now() - this._lastVoiceSpeakPing > 15000)) {
            this._lastVoiceSpeakPing = Date.now();
            this.socket.emit('voice-activity');
          }
        } else if (wasTalking && !holdTimer) {
          holdTimer = setTimeout(() => {
            wasTalking = false;
            holdTimer = null;
            setSelfTalking(false);
            if (this.socket && this.inVoice) this.socket.emit('voice-speaking', { speaking: false });
          }, HOLD_MS);
        }
      }, 60);
    } catch { /* analyser not available */ }
  }

  _stopLocalTalkDetection() {
    if (this._localTalkInterval) {
      clearInterval(this._localTalkInterval);
      this._localTalkInterval = null;
      this._localTalkAnalyser = null;
      this.talkingState.delete('self');
      if (this.socket && this.inVoice) this.socket.emit('voice-speaking', { speaking: false });
      if (this.onTalkingChange) this.onTalkingChange('self', false);
    }
  }

  _playAudio(userId, stream) {
    let audioEl = document.getElementById(`voice-audio-${userId}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `voice-audio-${userId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.getElementById('audio-container').appendChild(audioEl);

      // Apply saved output device
      const savedOutput = localStorage.getItem('haven_output_device');
      if (savedOutput && typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId(savedOutput).catch(() => {});
      }
    }
    audioEl.srcObject = stream;

    // Only set up the Web Audio graph once per user.
    // ontrack fires per-track, so _playAudio can be called several times
    // for the same user when tracks are added (mic + screen audio).
    if (this.gainNodes.has(userId)) {
      audioEl.volume = 0;
      return;
    }

    // iOS Safari / WebKit: createMediaStreamSource() from a remote PC track
    // is silent (WebKit bug, unfixed for years). Skip the entire Web Audio
    // routing and let the <audio> element play natively. Trade-off: no
    // per-user volume boost above 100% and no remote-speaker analyser, but
    // audio actually plays — which is the whole point. Local mic talk
    // detection still works because that's getUserMedia-side, not PC-side.
    if (_IS_IOS_WEBKIT) {
      const savedVolume = Math.min(1, this._getSavedVolume(userId));
      if (this.isDeafened) {
        audioEl.dataset.prevVolume = String(savedVolume);
        audioEl.volume = 0;
      } else {
        audioEl.volume = savedVolume;
      }
      // iOS also blocks play() outside a user gesture; ontrack fires after
      // the join-voice tap so we should be fine, but kick play() anyway
      // for safety and swallow the rejection if it ever happens.
      audioEl.play().catch(() => {});
      return;
    }

    // Route through Web Audio API for volume boost AND talking analysis
    // CRITICAL: use ONE MediaStreamSource for both analyser & gain to avoid
    // browsers muting the stream when multiple sources compete.
    try {
      this._ensureAudioCtx();

      const source = this.audioCtx.createMediaStreamSource(stream);

      // Analyser branch (tee off from source)
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      this._startAnalyser(userId, analyser, dataArray);

      // Gain branch (source → gain → destination)
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getAppliedIncomingVolume(this._getSavedVolume(userId));
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.gainNodes.set(userId, gainNode);

      // Mute element playback — audio routes through GainNode instead
      audioEl.volume = 0;
    } catch {
      // Fallback: use element volume directly (no boost beyond 100%)
      const savedVolume = Math.min(1, this._getSavedVolume(userId));
      if (this.isDeafened) {
        audioEl.dataset.prevVolume = String(savedVolume);
        audioEl.volume = 0;
      } else {
        audioEl.volume = savedVolume;
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { VoiceManager };
