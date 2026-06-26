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
    this.screenGainNodes = new Map(); // userId → GainNode for screen share audio
    this.onScreenAudio = null;       // callback(userId) — screen share audio available
    this.talkingState = new Map();  // userId → boolean
    this.analysers = new Map();     // userId → { analyser, dataArray, interval }
    this.onScreenShareStarted = null; // callback(userId, username) — someone started streaming
    this.onWebcamStatusChange = null; // callback() — webcam started/stopped, re-render user list
    this.onConnectivityWarning = null; // (#5399) callback(message) — fired when no STUN server responds
    this._connectivityWarned = false;  // only warn once per session to avoid toast spam
    this.deafenedUsers = new Set();   // userIds we've muted our audio towards
    this._localTalkInterval = null;
    this._noiseGateInterval = null;
    this._noiseGateGain = null;
    this._noiseGateAnalyser = null;
    this._vcDest = null;             // MediaStreamDestination node for mixing soundboard audio into VC

    // Voice audio bitrate cap (0 = auto, otherwise kbps from server)
    this.audioBitrate = 0;

    // RNNoise noise suppression state
    this._rnnoiseNode = null;        // AudioWorkletNode for RNNoise
    this._rnnoiseReady = false;      // true once WASM is loaded in the worklet
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
    // got stuck on "ICE: Connecting...". Defaults below are split into a
    // preferred non-Google pool plus a Google fallback that only engages
    // if every preferred server fails the runtime probe.
    this._stunPreferred = [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.relay.metered.ca:80',
      'stun:global.stun.twilio.com:3478',
    ];
    this._stunFallback = [
      // Last-ditch only. Google is widely reliable but we'd rather not send
      // our users' NAT-discovery traffic there if we can avoid it.
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
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
  // Survivors replace the iceServers list. If every preferred server is
  // dead, the Google fallback pool is brought in so users aren't left
  // with zero working STUN.

  async _probeDefaultStun() {
    try {
      // Need a tiny delay so _fetchIceServers can win the race if the
      // admin has configured their own servers; we don't want to clobber
      // those with probe results.
      await new Promise(r => setTimeout(r, 250));
      if (this._adminIceServersLoaded) return;

      const probeOne = (url, timeoutMs = 2500) => new Promise(resolve => {
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

      const preferred = await Promise.all(this._stunPreferred.map(u => probeOne(u)));
      const livePreferred = preferred.filter(p => p.ok).map(p => p.url);

      if (this._adminIceServersLoaded) return; // admin won the race after all

      if (livePreferred.length) {
        this.rtcConfig.iceServers = livePreferred.map(urls => ({ urls }));
        console.log(`🧊 STUN probe: ${livePreferred.length}/${this._stunPreferred.length} preferred servers alive (${livePreferred.join(', ')})`);
        return;
      }

      // All preferred dead — bring in the fallback pool. Probe those too
      // so we don't list servers that themselves happen to be unreachable.
      console.warn('[Voice] All preferred STUN servers failed probe; trying fallback pool.');
      const fallback = await Promise.all(this._stunFallback.map(u => probeOne(u)));
      const liveFallback = fallback.filter(p => p.ok).map(p => p.url);

      if (this._adminIceServersLoaded) return;

      if (liveFallback.length) {
        this.rtcConfig.iceServers = liveFallback.map(urls => ({ urls }));
        console.warn(`🧊 Using fallback STUN pool (${liveFallback.length} alive): ${liveFallback.join(', ')}`);
      } else {
        // Every server we know about is unresponsive. Keep the original
        // preferred list anyway — peers on the same LAN can still connect
        // via host candidates and at least one server might come back up
        // mid-call.
        console.error('[Voice] All known STUN servers failed probe — external WebRTC will be impaired until an admin configures TURN.');
        // Surface this to the user instead of leaving them stuck on
        // "ICE: Connecting..." with no explanation (#5399). LAN calls still
        // work, so keep it a warning, not a hard error.
        if (!this._connectivityWarned && typeof this.onConnectivityWarning === 'function') {
          this._connectivityWarned = true;
          this.onConnectivityWarning('Voice connection servers (STUN) are unreachable. Calls may only work on your local network until an admin sets STUN/TURN in Settings → Voice & Connectivity.');
        }
      }
    } catch (err) {
      console.warn('[Voice] STUN probe failed:', err && err.message);
    }
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
      console.warn('[Voice] Server says voice channel is gone — leaving locally:', data && data.code);
      try { this.leave(); } catch (e) { console.warn('[Voice] leave() during voice-channel-gone failed:', e); }
    });

    // We just joined: create peer connections + send offers to all existing users
    this.socket.on('voice-existing-users', async (data) => {
      // Apply audio bitrate cap from channel settings
      this.audioBitrate = data.voiceBitrate || 0;
      // Fast-path: server told us this is a transient rejoin and our
      // existing RTCPeerConnections are still live. Skip creating fresh
      // peers — that would tear down working audio for no reason. See
      // [VoiceDiag] fast-path in src/socketHandlers/voice.js.
      if (data.skipRenegotiate) {
        console.log('[Voice] voice-existing-users with skipRenegotiate — keeping existing peers');
        return;
      }
      for (const user of data.users) {
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
        // An incoming offer supersedes any local offer we were preparing or
        // waiting to have answered. Clear those flags so the post-answer drain
        // can safely issue one fresh follow-up offer if local changes are still pending.
        peer._makingOffer = false;
        peer._awaitingAnswer = false;
        // Handle renegotiation glare: if we have a pending local offer,
        // roll it back first so we can accept the incoming one.
        if (conn.signalingState !== 'stable') {
          await conn.setLocalDescription({ type: 'rollback' });
        }
        await conn.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);

        this.socket.emit('voice-answer', {
          code: this.currentChannel,
          targetUserId: from.id,
          answer: answer
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
        try {
          // Only accept answer if we're actually waiting for one
          // (we may have rolled back our offer due to glare)
          if (peer.connection.signalingState === 'have-local-offer') {
            await peer.connection.setRemoteDescription(new RTCSessionDescription(data.answer));
            peer._awaitingAnswer = false;
            // Flush buffered ICE candidates that arrived before the answer
            if (peer._pendingCandidates && peer._pendingCandidates.length) {
              for (const c of peer._pendingCandidates) {
                try { await peer.connection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* ignore */ }
              }
              peer._pendingCandidates = [];
            }
          } else if (peer._awaitingAnswer && peer.connection.signalingState === 'stable') {
            // Stale answer for a local offer we already rolled back after glare.
            peer._awaitingAnswer = false;
          }
        } catch (err) {
          console.error('Error handling voice answer:', err);
          if (peer._awaitingAnswer && peer.connection.signalingState === 'stable') {
            peer._awaitingAnswer = false;
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
      // If they were screen sharing, clean up
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
      this.screenSharers.add(data.userId);
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

      // Safety net: if screen-share-started fires but the renegotiation
      // offer carrying the video track never reaches us (dropped event,
      // sharer's _renegotiate failed silently because of a non-stable
      // signaling state, etc.), the receiver gets no tile at all. Check
      // ~3s later whether the peer connection has any video receiver from
      // the sharer; if not, ask the server to forward a renegotiate-screen
      // back to the sharer. This is the silent-failure recovery path for
      // the long-standing \"sharer goes live but nothing appears on my
      // end\" bug. (#5347 v3.15.5)
      setTimeout(() => {
        if (!this.screenSharers.has(data.userId)) return;
        const peer = this.peers.get(data.userId);
        if (!peer) return;
        const hasVideoReceiver = peer.connection.getReceivers().some(r =>
          r.track && r.track.kind === 'video' && r.track.readyState === 'live'
        );
        if (!hasVideoReceiver && this.inVoice && this.currentChannel) {
          console.warn('[Voice] No video track from screen sharer', data.userId, 'after 3s, requesting renegotiate');
          this.socket.emit('request-screen-renegotiate', {
            code: this.currentChannel,
            sharerId: data.userId
          });
        }
      }, 3000);
    });

    // Someone stopped screen sharing
    this.socket.on('screen-share-stopped', (data) => {
      this.screenSharers.delete(data.userId);
      if (this.onScreenStream) this.onScreenStream(data.userId, null);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
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
      if (data && data.sharers) {
        data.sharers.forEach(s => {
          this.screenSharers.add(s.id);
          // Late joiners never receive 'screen-share-started', so they never
          // armed the silent-failure recovery watchdog. Arm it here so a
          // dropped or late late-join renegotiation self-heals instead of
          // stranding the viewer with a LIVE badge and no video.
          this._watchForScreenStream(s.id);
        });
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
      if (!this.screenStream || !this.isScreenSharing) return;
      const peer = this.peers.get(data.targetUserId);
      if (!peer) return;
      const conn = peer.connection;

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
      await this._renegotiate(data.targetUserId, conn);
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

  // Watchdog for the late-joiner path: if no live video track has arrived
  // from `sharerId` after a short delay, ask for a renegotiation. Retries a
  // few times because a late joiner's peer connection to the sharer may still
  // be completing its offer/answer when the first check runs. (late-join heal)
  _watchForScreenStream(sharerId, attemptsLeft = 3) {
    setTimeout(() => {
      if (!this.screenSharers.has(sharerId)) return; // sharer stopped
      if (!this.inVoice || !this.currentChannel) return;
      const peer = this.peers.get(sharerId);
      const hasVideo = peer && peer.connection.getReceivers().some(r =>
        r.track && r.track.kind === 'video' && r.track.readyState === 'live'
      );
      if (hasVideo) return; // already receiving — nothing to do
      console.warn('[Voice] No video from screen sharer', sharerId, '— requesting renegotiate (late-join heal)');
      this.requestScreenStream(sharerId);
      if (attemptsLeft > 1) this._watchForScreenStream(sharerId, attemptsLeft - 1);
    }, 3500);
  }

  async join(channelCode) {
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
        if (this.noiseMode === 'suppress' && this._rnnoiseReady) {
          this.setNoiseSensitivity(0);
          this._enableRNNoise();
        } else if (this.noiseMode === 'off') {
          this.setNoiseSensitivity(0);
        } else if (this.noiseMode === 'gate') {
          const saved = parseInt(localStorage.getItem('haven_ns_value') || '10', 10);
          this.setNoiseSensitivity(saved);
        }
      }

      this.currentChannel = channelCode;
      this.inVoice = true;
      // Listener-only is always muted (no audio to send). mute-on-join also forces mute.
      this.isMuted = this.isListenerOnly || muteOnJoin || preservedMuteState;
      this.isDeafened = preservedDeafenState;

      this._applyMuteStateToLocalTracks();

      // Persist voice channel for auto-rejoin after page refresh or server restart
      try { localStorage.setItem('haven_voice_channel', channelCode); } catch {}

      this.socket.emit('voice-join', { code: channelCode });
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
    }
  }

  leave() {
    // Stop screen share first if active
    if (this.isScreenSharing) {
      this.stopScreenShare();
    }
    // Stop webcam if active
    if (this.isWebcamActive) {
      this.stopWebcam();
    }

    // Stop noise gate and talk detection
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

    // Stop screen share / webcam (local cleanup only)
    if (this.isScreenSharing && this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
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
    return this.isDeafened;
  }

  _getAppliedIncomingVolume(volume) {
    return this.isDeafened ? 0 : volume;
  }

  // ── Screen Sharing ──────────────────────────────────────

  async shareScreen() {
    if (!this.inVoice || this.isScreenSharing) return false;
    try {
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

      this.screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

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
      this.socket.emit('screen-share-started', { code: this.currentChannel, hasAudio });

      // Add screen tracks to all existing peer connections and cap bitrate
      const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
      for (const [userId, peer] of this.peers) {
        this.screenStream.getTracks().forEach(track => {
          peer.connection.addTrack(track, this.screenStream);
        });
        // Cap the video bitrate so WebRTC doesn't starve framerate
        this._applyScreenBitrate(peer.connection, maxBitrate);
        // Renegotiate with each peer
        await this._renegotiate(userId, peer.connection);
      }

      return true;
    } catch (err) {
      console.error('Screen share failed:', err);
      this.isScreenSharing = false;
      this.screenStream = null;
      return false;
    }
  }

  async stopScreenShare() {
    if (!this.isScreenSharing || !this.screenStream) return;

    const tracks = this.screenStream.getTracks();

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

    this.socket.emit('screen-share-stopped', { code: this.currentChannel });
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
      for (const [userId, peer] of this.peers) {
        peer.connection.addTrack(camTrack, this.webcamStream);
        await this._renegotiate(userId, peer.connection);
      }

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

  async stopWebcam() {
    if (!this.isWebcamActive || !this.webcamStream) return;

    const tracks = this.webcamStream.getTracks();

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

    // Replace track on all peers
    for (const [, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      const camSender = senders.find(s => s.track && s.track.kind === 'video' &&
        this.webcamStream && this.webcamStream.getVideoTracks().includes(s.track));
      if (camSender) {
        await camSender.replaceTrack(newTrack).catch(e =>
          console.warn('[Voice] replaceTrack (cam) failed:', e)
        );
      }
    }

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
  _applyScreenBitrate(connection, maxBitrate) {
    try {
      const senders = connection.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video' &&
            this.screenStream && this.screenStream.getVideoTracks().includes(sender.track)) {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = maxBitrate;
          // Per-encoding cap is the primary control; framerate hint also helps
          // browsers that respect it (Chromium-based ones do).
          if (this.screenFrameRate) {
            params.encodings[0].maxFramerate = this.screenFrameRate;
          }
          params.degradationPreference = 'maintain-framerate';
          sender.setParameters(params).catch(() => {});
        }
      }
    } catch (e) { /* setParameters not supported — adaptive bitrate remains */ }
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
      peer._awaitingAnswer = true;
      this.socket.emit('voice-offer', {
        code: this.currentChannel,
        targetUserId: userId,
        offer: offer
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
        const isScreenTrack = !!settings.displaySurface || this.screenSharers.has(userId);
        const isWebcamTrack = !settings.displaySurface && this.webcamUsers.has(userId);

        if (isWebcamTrack && !isScreenTrack) {
          // Route to webcam callback
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
        } else {
          // Screen share video
          if (sourceStream) knownScreenStreamIds.add(sourceStream.id);
          const videoStream = sourceStream || new MediaStream([track]);
          if (this.onScreenStream) this.onScreenStream(userId, videoStream);
          track.onunmute = () => {
            setTimeout(() => {
              const freshStream = new MediaStream([track]);
              if (this.onScreenStream) this.onScreenStream(userId, freshStream);
            }, 150);
          };
          track.onmute = () => {};
          track.onended = () => {
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
        const peerIsSharing = this.screenSharers.has(userId);
        const streamHasVideo = sourceStream && sourceStream.getVideoTracks().length > 0;
        const knownAsScreen = sourceStream && knownScreenStreamIds.has(sourceStream.id);
        const isScreenAudio = knownAsScreen || (peerIsSharing && streamHasVideo);

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
        if (latestPeer._awaitingAnswer) {
          latestPeer._awaitingAnswer = false;
        }
        this._drainQueuedRenegotiation(userId);
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
      }
    };

    this.peers.set(userId, {
      connection,
      stream: remoteAudioStream,
      username,
      _makingOffer: false,
      _awaitingAnswer: false,
      _renegotiateQueued: false,
      _queuedIceRestart: false,
    });

    // If we're the initiator, create and send an offer
    if (createOffer) {
      await this._renegotiate(userId, connection);
    }
  }

  _removePeer(userId) {
    const peer = this.peers.get(userId);
    if (peer) {
      peer.connection.close();
      const audioEl = document.getElementById(`voice-audio-${userId}`);
      if (audioEl) audioEl.remove();
      const screenAudioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (screenAudioEl) screenAudioEl.remove();
      this.screenGainNodes.delete(userId);
      this.gainNodes.delete(userId);
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

  async _restartIce(userId, connection) {
    try {
      await this._renegotiate(userId, connection, { iceRestart: true });
    } catch (err) {
      console.error('ICE restart failed for', userId, '— removing peer:', err);
      this._removePeer(userId);
    }
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

    // Re-enable RNNoise if it was active
    if (this.noiseMode === 'suppress' && this._rnnoiseReady) {
      this.setNoiseSensitivity(0);
      this._enableRNNoise();
    } else if (this.noiseMode === 'gate') {
      const saved = parseInt(localStorage.getItem('haven_ns_value') || '10', 10);
      this.setNoiseSensitivity(saved);
    } else if (this.noiseMode === 'off') {
      this.setNoiseSensitivity(0);
    }

    // Replace the audio track on every peer connection
    const newTrack = this.localStream.getAudioTracks()[0];
    for (const [, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio' &&
        (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)));
      if (audioSender) {
        await audioSender.replaceTrack(newTrack).catch(e =>
          console.warn('[Voice] replaceTrack failed for peer:', e)
        );
      }
    }

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
    const elements = document.querySelectorAll('audio, video');
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
      if (!this._rnnoiseReady) {
        this._initRNNoise().then(() => {
          if (this._rnnoiseReady) this._enableRNNoise();
          else console.warn('[Voice] AI suppression unavailable');
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
    if (this._rnnoiseReady || !this.audioCtx) return;
    try {
      await this.audioCtx.audioWorklet.addModule('/js/rnnoise-processor.js');
      const wasmResponse = await fetch('/js/rnnoise.wasm');
      const wasmBytes = await wasmResponse.arrayBuffer();
      const wasmModule = await WebAssembly.compile(wasmBytes);
      this._rnnoiseWasmModule = wasmModule;
      this._rnnoiseReady = true;
    } catch (err) {
      console.warn('[Voice] RNNoise init failed:', err);
      this._rnnoiseReady = false;
    }
  }

  _enableRNNoise() {
    if (!this._rnnoiseReady || !this._rnnoiseSource || this._rnnoiseNode) return;
    try {
      const node = new AudioWorkletNode(this.audioCtx, 'rnnoise-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1], channelCount: 1
      });
      node.port.postMessage({ type: 'wasm-module', module: this._rnnoiseWasmModule });
      // Re-wire: source → rnnoise → gateGain (gate is open since sensitivity=0)
      this._rnnoiseSource.disconnect(this._noiseGateGain);
      this._rnnoiseSource.connect(node);
      node.connect(this._noiseGateGain);
      this._rnnoiseNode = node;
    } catch (err) {
      console.warn('[Voice] Failed to enable RNNoise:', err);
    }
  }

  _disableRNNoise() {
    if (!this._rnnoiseNode) return;
    try {
      this._rnnoiseNode.port.postMessage({ type: 'destroy' });
      this._rnnoiseNode.disconnect();
      this._rnnoiseNode = null;
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
      const savedOutput = localStorage.getItem('haven_output_device') || '';
      const ctxOpts = {};
      if (savedOutput && typeof AudioContext !== 'undefined' &&
          AudioContext.prototype && 'setSinkId' in AudioContext.prototype) {
        ctxOpts.sinkId = savedOutput;
      }
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(ctxOpts);
      } catch {
        // Older Chromium throws when sinkId is passed in options.
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
