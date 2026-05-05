// ═══════════════════════════════════════════════════════════
// Haven — WebRTC Voice Chat Manager
// ═══════════════════════════════════════════════════════════

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

    // Bitrate map: resolution → bits/sec  (sensible defaults per resolution)
    this._screenBitrates = {
      0:    4_000_000,   // 4 Mbps fallback for unconstrained (source)
      720:  1_500_000,   // 1.5 Mbps
      1080: 3_000_000,   // 3 Mbps
      1440: 5_000_000,   // 5 Mbps
    };

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.stunprotocol.org:3478' },
        { urls: 'stun:stun.nextcloud.com:3478' }
      ]
    };

    // Fetch server-provided ICE config (may include TURN)
    this._fetchIceServers();

    this._setupSocketListeners();
  }

  // ── Fetch ICE servers from backend (STUN + optional TURN) ──

  async _fetchIceServers() {
    try {
      const token = localStorage.getItem('haven_token');
      if (!token) return;
      const res = await fetch('/api/ice-servers', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.iceServers && data.iceServers.length) {
          this.rtcConfig.iceServers = data.iceServers;
          console.log(`🧊 ICE servers loaded (${data.iceServers.length} servers${data.iceServers.some(s => String(s.urls).includes('turn:')) ? ', TURN enabled' : ''})`);
        }
      }
    } catch (err) {
      console.warn('Could not fetch ICE servers, using defaults:', err.message);
    }
  }

  // ── Socket event listeners ──────────────────────────────

  _setupSocketListeners() {
    // We just joined: create peer connections + send offers to all existing users
    this.socket.on('voice-existing-users', async (data) => {
      // Apply audio bitrate cap from channel settings
      this.audioBitrate = data.voiceBitrate || 0;
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
            // Flush buffered ICE candidates that arrived before the answer
            if (peer._pendingCandidates && peer._pendingCandidates.length) {
              for (const c of peer._pendingCandidates) {
                try { await peer.connection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* ignore */ }
              }
              peer._pendingCandidates = [];
            }
          }
        } catch (err) {
          console.error('Error handling voice answer:', err);
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
        data.sharers.forEach(s => this.screenSharers.add(s.id));
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

      // Add screen share tracks if they weren't negotiated in the initial exchange
      const senders = conn.getSenders();
      const hasVideo = senders.some(s => s.track && s.track.kind === 'video');
      if (!hasVideo) {
        this.screenStream.getTracks().filter(t => t.readyState === 'live').forEach(track => {
          conn.addTrack(track, this.screenStream);
        });
        // Cap bitrate for this peer
        const res = this.screenResolution;
        const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
        this._applyScreenBitrate(conn, maxBitrate);
      }

      // Renegotiate to include the video tracks
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

  async join(channelCode) {
    try {
      const preservedMuteState = this.isMuted;
      const preservedDeafenState = this.isDeafened;

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
          this.rawStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false
          });
        } else {
          throw deviceErr;
        }
      }

      // Opt out of Windows audio ducking (Desktop app only).
      // Must be called after getUserMedia so our audio session exists.
      if (window.havenDesktop?.audio?.optOutOfDucking) {
        setTimeout(() => window.havenDesktop.audio.optOutOfDucking().catch(() => {}), 500);
      }

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

      this.currentChannel = channelCode;
      this.inVoice = true;
      this.isMuted = preservedMuteState;
      this.isDeafened = preservedDeafenState;

      this._applyMuteStateToLocalTracks();
      
      // Persist voice channel for auto-rejoin after page refresh or server restart
      try { localStorage.setItem('haven_voice_channel', channelCode); } catch {}

      this.socket.emit('voice-join', { code: channelCode });

      // Start local talk indicator (use raw stream for accurate detection)
      this._startLocalTalkDetection();

      return true;
    } catch (err) {
      console.error('Microphone access failed:', err);
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
      // If no ack within 2s (socket glitch, transport switch), retry.
      let acked = false;
      this.socket.emit('voice-leave', { code: leavingChannel }, (response) => {
        acked = true;
      });
      setTimeout(() => {
        if (!acked && this.socket.connected) {
          console.warn('[Voice] voice-leave not acked, retrying...');
          this.socket.emit('voice-leave', { code: leavingChannel });
        }
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

      // When user clicks browser "Stop sharing" button
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      // If screen audio track dies independently, update flag
      const screenAudioTrack = this.screenStream.getAudioTracks()[0];
      if (screenAudioTrack) {
        screenAudioTrack.onended = () => { this.screenHasAudio = false; };
      }

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

      // Tell the server we're sharing (include audio availability)
      const hasAudio = this.screenStream.getAudioTracks().length > 0;
      this.screenHasAudio = hasAudio;
      this.socket.emit('screen-share-started', { code: this.currentChannel, hasAudio });

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

    // Wait for all renegotiations to complete (with a timeout so we don't hang forever)
    try {
      await Promise.race([
        Promise.all(renegotiations),
        new Promise(resolve => setTimeout(resolve, 3000))
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

  async _renegotiate(userId, connection) {
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.socket.emit('voice-offer', {
        code: this.currentChannel,
        targetUserId: userId,
        offer: offer
      });
    } catch (err) {
      console.error('Renegotiation failed:', err);
    }
  }

  // ── Private: Peer connection management ─────────────────

  async _createPeer(userId, username, createOffer) {
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
            if (this.onScreenStream) this.onScreenStream(userId, null);
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

    this.peers.set(userId, { connection, stream: remoteAudioStream, username });

    // If we're the initiator, create and send an offer
    if (createOffer) {
      try {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);

        this.socket.emit('voice-offer', {
          code: this.currentChannel,
          targetUserId: userId,
          offer: offer
        });
      } catch (err) {
        console.error('Error creating voice offer:', err);
      }
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
      const offer = await connection.createOffer({ iceRestart: true });
      await connection.setLocalDescription(offer);
      this.socket.emit('voice-offer', {
        code: this.currentChannel,
        targetUserId: userId,
        offer: offer
      });
    } catch (err) {
      console.error('ICE restart failed for', userId, '— removing peer:', err);
      this._removePeer(userId);
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

  setStreamVolume(userId, volume) {
    // Map keys may be number or string depending on caller — try both
    const gainNode = this.screenGainNodes.get(userId)
      || this.screenGainNodes.get(String(userId))
      || this.screenGainNodes.get(Number(userId));
    const clampedGain = Math.max(0, Math.min(2, volume));
    const clampedVol  = Math.max(0, Math.min(1, volume));
    if (gainNode) {
      gainNode.gain.value = clampedGain;
    }
    // Always sync the underlying <audio> element too (belt-and-suspenders)
    const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (audioEl) audioEl.volume = clampedVol;
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
