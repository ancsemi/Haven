// ═══════════════════════════════════════════════════════════
// Haven — WebRTC Voice Chat Manager
// ═══════════════════════════════════════════════════════════

class VoiceManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;        // Processed stream (sent to peers)
    this.rawStream = null;          // Raw mic stream (for local talk detection)
    this.screenStream = null;       // Screen share MediaStream
    this.isScreenSharing = false;
    this.peers = new Map();         // userId → { connection, stream, username }
    this.currentChannel = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.inVoice = false;
    this.noiseSensitivity = 10;     // Noise gate sensitivity 0 (off) to 100 (aggressive)
    this.audioCtx = null;           // Web Audio context for volume boost
    this.gainNodes = new Map();     // userId → GainNode
    this.localUserId = null;        // set by app.js so stopScreenShare can reference own tile
    this.onScreenStream = null;     // callback(userId, stream|null) — set by app.js
    this.onVoiceJoin = null;        // callback(userId, username)
    this.onVoiceLeave = null;       // callback(userId, username)
    this.onTalkingChange = null;    // callback(userId, isTalking)
    this.screenSharers = new Set();  // userIds currently sharing
    this.screenGainNodes = new Map(); // userId → GainNode for screen share audio
    this.onScreenAudio = null;       // callback(userId) — screen share audio available
    this.talkingState = new Map();  // userId → boolean
    this.analysers = new Map();     // userId → { analyser, dataArray, interval }
    this.onScreenShareStarted = null; // callback(userId, username) — someone started streaming
    this.deafenedUsers = new Set();   // userIds we've muted our audio towards
    this._localTalkInterval = null;
    this._noiseGateInterval = null;
    this._noiseGateGain = null;
    this._noiseGateAnalyser = null;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this._setupSocketListeners();
  }

  // ── Socket event listeners ──────────────────────────────

  _setupSocketListeners() {
    // We just joined: create peer connections + send offers to all existing users
    this.socket.on('voice-existing-users', async (data) => {
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
          }
        } catch (err) {
          console.error('Error handling voice answer:', err);
        }
      }
    });

    // Received an ICE candidate
    this.socket.on('voice-ice-candidate', async (data) => {
      const peer = this.peers.get(data.from.id);
      if (peer && data.candidate) {
        try {
          await peer.connection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.error('Error adding ICE candidate:', err);
        }
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
    });

    // Someone stopped screen sharing
    this.socket.on('screen-share-stopped', (data) => {
      this.screenSharers.delete(data.userId);
      if (this.onScreenStream) this.onScreenStream(data.userId, null);
    });

    // Late joiner: server tells us about active screen sharers
    this.socket.on('active-screen-sharers', (data) => {
      if (data && data.sharers) {
        data.sharers.forEach(s => this.screenSharers.add(s.id));
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
        this.screenStream.getTracks().forEach(track => {
          conn.addTrack(track, this.screenStream);
        });
      }

      // Renegotiate to include the video tracks
      await this._renegotiate(data.targetUserId, conn);
    });
  }

  // ── Public API ──────────────────────────────────────────

  async join(channelCode) {
    try {
      // Leave existing voice channel if connected elsewhere
      if (this.inVoice) this.leave();

      // Create/resume AudioContext with user gesture (needed for volume boost)
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

      this.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      // ── Noise Gate via Web Audio ──
      // Route mic through an analyser + gain node so we can silence
      // audio below a threshold before sending it to peers.
      const source = this.audioCtx.createMediaStreamSource(this.rawStream);
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
      this.localStream = dest.stream;   // processed stream → peers
      this._startNoiseGate();

      this.currentChannel = channelCode;
      this.inVoice = true;
      this.isMuted = false;

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

    // Stop noise gate and talk detection
    this._stopNoiseGate();
    this._stopLocalTalkDetection();
    for (const [id] of this.analysers) this._stopAnalyser(id);

    if (this.currentChannel) {
      this.socket.emit('voice-leave', { code: this.currentChannel });
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
    this.screenSharers.clear();
    this.screenGainNodes.clear();
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
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
    return this.isMuted;
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

  // ── Screen Sharing ──────────────────────────────────────

  async shareScreen() {
    if (!this.inVoice || this.isScreenSharing) return false;
    try {
      const displayMediaOptions = {
        video: { cursor: 'always' },
        audio: true,
        surfaceSwitching: 'exclude', // prevent re-picker on alt-tab / focus changes
        selfBrowserSurface: 'include',
        monitorTypeSurfaces: 'include',
        windowAudio: 'window'         // capture ONLY the selected window's audio (Chrome 141+)
      };

      // Use CaptureController if available to manage the capture session
      if (typeof CaptureController !== 'undefined') {
        this._captureController = new CaptureController();
        displayMediaOptions.controller = this._captureController;
      }

      this.screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

      this.isScreenSharing = true;

      // When user clicks browser "Stop sharing" button
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      // Add screen tracks to all existing peer connections
      for (const [userId, peer] of this.peers) {
        this.screenStream.getTracks().forEach(track => {
          peer.connection.addTrack(track, this.screenStream);
        });
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

  stopScreenShare() {
    if (!this.isScreenSharing || !this.screenStream) return;

    // Remove screen tracks from all peer connections
    for (const [userId, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      this.screenStream.getTracks().forEach(track => {
        const sender = senders.find(s => s.track === track);
        if (sender) peer.connection.removeTrack(sender);
        track.stop();
      });
      // Renegotiate
      this._renegotiate(userId, peer.connection).catch(() => {});
    }

    this.screenStream = null;
    this.isScreenSharing = false;
    this._captureController = null;

    this.socket.emit('screen-share-stopped', { code: this.currentChannel });
    // Notify local UI — pass localUserId so tile is found by its real ID
    if (this.onScreenStream) this.onScreenStream(this.localUserId, null);
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

    // If we're screen sharing, add those tracks too
    if (this.screenStream && this.isScreenSharing) {
      this.screenStream.getTracks().forEach(track => {
        connection.addTrack(track, this.screenStream);
      });
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
        if (sourceStream) knownScreenStreamIds.add(sourceStream.id);
        const videoStream = sourceStream || new MediaStream([track]);
        if (this.onScreenStream) this.onScreenStream(userId, videoStream);
        track.onunmute = () => {
          // Create a fresh MediaStream so the video element detects a new srcObject
          // (re-assigning the same object is a no-op in Chrome → black screen)
          const freshStream = new MediaStream(videoStream.getTracks());
          if (this.onScreenStream) this.onScreenStream(userId, freshStream);
        };
        track.onmute = () => {
          // Track temporarily stopped sending — force video to re-render
          // when it resumes via onunmute above
        };
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
      } else {
        // Is this audio from a screen share stream?
        const isScreenAudio = sourceStream && (
          knownScreenStreamIds.has(sourceStream.id) ||
          sourceStream.getVideoTracks().length > 0 ||
          (voiceStreamId && sourceStream.id !== voiceStreamId)
        );
        if (isScreenAudio) {
          this._playScreenAudio(userId, sourceStream);
        } else if (!voiceStreamId && sourceStream) {
          // First audio — assume voice, but defer re-check in case it's actually screen audio
          voiceStreamId = sourceStream.id;
          remoteAudioStream.addTrack(track);
          this._playAudio(userId, remoteAudioStream);
        } else {
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
      if (connection.connectionState === 'failed' ||
          connection.connectionState === 'disconnected') {
        this._removePeer(userId);
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
    const ctx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0; // completely silent
    oscillator.connect(gain);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    oscillator.start();
    return dest.stream.getAudioTracks()[0];
  }

  _getSavedVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem('haven_voice_volumes') || '{}');
      return (vols[userId] ?? 100) / 100;
    } catch { return 1; }
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
    }
    audioEl.srcObject = stream;

    if (this.screenGainNodes.has(userId)) { audioEl.volume = 0; return; }

    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(stream);
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getSavedStreamVolume(userId);
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.screenGainNodes.set(userId, gainNode);
      audioEl.volume = 0;
    } catch {
      audioEl.volume = Math.min(1, this._getSavedStreamVolume(userId));
    }
    if (this.onScreenAudio) this.onScreenAudio(userId);
  }

  setStreamVolume(userId, volume) {
    const gainNode = this.screenGainNodes.get(userId);
    if (gainNode) {
      gainNode.gain.value = Math.max(0, Math.min(2, volume));
    } else {
      const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (audioEl) audioEl.volume = Math.max(0, Math.min(1, volume));
    }
  }

  _getSavedStreamVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem('haven_stream_volumes') || '{}');
      return (vols[userId] ?? 100) / 100;
    } catch { return 1; }
  }

  // ── Noise Gate ───────────────────────────────────────────

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

    this._noiseGateInterval = setInterval(() => {
      if (this.noiseSensitivity === 0) {
        gain.gain.value = 1;
        return;
      }
      // Map sensitivity 1-100 → threshold 2-40
      const threshold = 2 + (this.noiseSensitivity / 100) * 38;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;

      if (avg > threshold) {
        gain.gain.setTargetAtTime(1, this.audioCtx.currentTime, ATTACK);
      } else {
        gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, RELEASE);
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
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

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
      this._localTalkInterval = setInterval(() => {
        if (this.isMuted) {
          if (wasTalking) {
            wasTalking = false;
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (this.onTalkingChange) this.onTalkingChange('self', false);
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
            if (this.onTalkingChange) this.onTalkingChange('self', true);
          }
        } else if (wasTalking && !holdTimer) {
          holdTimer = setTimeout(() => {
            wasTalking = false;
            holdTimer = null;
            if (this.onTalkingChange) this.onTalkingChange('self', false);
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
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

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
      gainNode.gain.value = this._getSavedVolume(userId);
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.gainNodes.set(userId, gainNode);

      // Mute element playback — audio routes through GainNode instead
      audioEl.volume = 0;
    } catch {
      // Fallback: use element volume directly (no boost beyond 100%)
      audioEl.volume = Math.min(1, this._getSavedVolume(userId));
    }
  }
}
