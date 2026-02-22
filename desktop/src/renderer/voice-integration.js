/**
 * Haven Desktop — Voice Pipeline Integration (Renderer)
 *
 * Hooks into Haven's VoiceManager to:
 *   1. Use the user's preferred input device (from device settings)
 *   2. Mix app audio streams from routed applications via AudioMixer
 *   3. Replace the voice track on all peer connections when sources change
 *
 * Only active inside the Electron desktop app (window.havenDesktop).
 *
 * How it works:
 *   - We monkey-patch VoiceManager.join() and VoiceManager.leave()
 *   - After the original join() runs, we create an AudioMixer
 *   - The mixer combines mic (localStream) + any routed app audio
 *   - We swap the active WebRTC audio track with the mixer's output
 *   - When apps are routed/unrouted, we update the mixer accordingly
 */

(function () {
  'use strict';

  if (!window.havenDesktop) return;

  const api = window.havenDesktop.audio;

  let mixer = null;                // AudioMixer instance
  let captureStreams = new Map();   // processName → AudioCaptureStream
  let voiceManager = null;         // Reference to Haven's VoiceManager
  let routeCheckInterval = null;   // Polling for route changes
  let isIntegrated = false;

  // ── AudioCaptureStream (inline, matches desktop/src/audio/audio-capture.js) ──
  // We inline these classes here because this script runs in the renderer
  // and we can't require() Node modules from the web context.

  class AudioCaptureStream {
    constructor() {
      this.audioContext = null;
      this.mediaStream = null;
      this.sourceNode = null;
      this.gainNode = null;
      this.destination = null;
      this.isCapturing = false;
      this.volume = 1.0;
    }

    async start(deviceId, volume = 1.0) {
      if (this.isCapturing) await this.stop();
      this.audioContext = new AudioContext({ sampleRate: 48000 });
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
        },
        video: false,
      });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.gainNode = this.audioContext.createGain();
      this.destination = this.audioContext.createMediaStreamDestination();
      this.gainNode.gain.value = volume;
      this.volume = volume;
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.destination);
      this.isCapturing = true;
      return this.destination.stream;
    }

    setVolume(vol) {
      this.volume = Math.max(0, Math.min(2.0, vol));
      if (this.gainNode) {
        this.gainNode.gain.setValueAtTime(this.volume, this.audioContext.currentTime);
      }
    }

    async stop() {
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.gainNode) this.gainNode.disconnect();
      if (this.destination) this.destination.disconnect();
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
      }
      this.isCapturing = false;
      this.audioContext = null;
      this.mediaStream = null;
      this.sourceNode = null;
      this.gainNode = null;
      this.destination = null;
    }
  }

  class AudioMixer {
    constructor() {
      this.audioContext = null;
      this.destination = null;
      this.sources = new Map();
      this.micSource = null;
      this.micGain = null;
    }

    async init() {
      this.audioContext = new AudioContext({ sampleRate: 48000 });
      this.destination = this.audioContext.createMediaStreamDestination();
      return this.destination.stream;
    }

    addMicrophone(micStream, volume = 1.0) {
      if (this.micSource) {
        this.micSource.disconnect();
        this.micGain.disconnect();
      }
      this.micSource = this.audioContext.createMediaStreamSource(micStream);
      this.micGain = this.audioContext.createGain();
      this.micGain.gain.value = volume;
      this.micSource.connect(this.micGain);
      this.micGain.connect(this.destination);
    }

    addAppAudio(id, stream, volume = 0.8) {
      this.removeAppAudio(id);
      const source = this.audioContext.createMediaStreamSource(stream);
      const gain = this.audioContext.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(this.destination);
      this.sources.set(id, { source, gain });
    }

    setAppVolume(id, vol) {
      const entry = this.sources.get(id);
      if (entry) {
        entry.gain.gain.setValueAtTime(
          Math.max(0, Math.min(2.0, vol)),
          this.audioContext.currentTime
        );
      }
    }

    removeAppAudio(id) {
      const entry = this.sources.get(id);
      if (entry) {
        entry.source.disconnect();
        entry.gain.disconnect();
        this.sources.delete(id);
      }
    }

    getOutputStream() {
      return this.destination?.stream || null;
    }

    async destroy() {
      for (const [id] of this.sources) this.removeAppAudio(id);
      if (this.micSource) this.micSource.disconnect();
      if (this.micGain) this.micGain.disconnect();
      if (this.audioContext?.state !== 'closed') {
        await this.audioContext?.close();
      }
      this.audioContext = null;
      this.destination = null;
      this.sources.clear();
    }
  }

  // ── Hook into VoiceManager ───────────────────────────────

  /**
   * Find Haven's VoiceManager instance and patch join/leave.
   */
  function hookVoice() {
    // Haven's app.js creates `this.voice = new VoiceManager(socket)`
    // and stores it on the HavenApp instance. We need to find it.
    // Strategy: look for a global or check common patterns.

    // Try window.app.voice (Haven stores app globally in some builds)
    if (window.app && window.app.voice) {
      patchVoiceManager(window.app.voice);
      return;
    }

    // Try looking for VoiceManager on any global
    for (const key of Object.keys(window)) {
      const obj = window[key];
      if (obj && obj.voice && obj.voice.constructor && obj.voice.constructor.name === 'VoiceManager') {
        patchVoiceManager(obj.voice);
        return;
      }
    }

    // Not found yet — retry (Haven may not have initialized)
    setTimeout(hookVoice, 2000);
  }

  /**
   * Monkey-patch VoiceManager.join() and .leave() to integrate the AudioMixer.
   */
  function patchVoiceManager(vm) {
    if (isIntegrated) return;
    voiceManager = vm;
    isIntegrated = true;

    console.log('[Haven Desktop] Voice pipeline integration active');

    const originalJoin = vm.join.bind(vm);
    const originalLeave = vm.leave.bind(vm);

    // ── Patch join() ───────────────────────────────────────
    vm.join = async function (channelCode) {
      // If user has a preferred input device, override getUserMedia constraints
      const preferredInput = localStorage.getItem('haven_input_device');
      if (preferredInput) {
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        const oneTimeOverride = function (constraints) {
          // Restore original after one call
          navigator.mediaDevices.getUserMedia = origGetUserMedia;
          // Inject preferred device ID
          if (constraints && constraints.audio) {
            if (typeof constraints.audio === 'boolean') {
              constraints.audio = { deviceId: { exact: preferredInput } };
            } else {
              constraints.audio.deviceId = { exact: preferredInput };
            }
          }
          return origGetUserMedia(constraints);
        };
        navigator.mediaDevices.getUserMedia = oneTimeOverride;
      }

      const success = await originalJoin(channelCode);
      if (!success) return false;

      // After join, set up the AudioMixer
      try {
        await setupMixer();
      } catch (err) {
        console.error('[Haven Desktop] Mixer setup failed (voice still works):', err);
      }

      // Start polling for route changes
      startRoutePolling();

      return true;
    };

    // ── Patch leave() ──────────────────────────────────────
    vm.leave = function () {
      stopRoutePolling();
      teardownMixer();
      originalLeave();
    };

    // Also apply output device preference for remote audio
    applyOutputDevicePref();
  }

  /**
   * Set up the AudioMixer: wraps the VoiceManager's localStream
   * with a mixer that can add app audio sources.
   */
  async function setupMixer() {
    if (!voiceManager || !voiceManager.localStream) return;

    mixer = new AudioMixer();
    const mixedStream = await mixer.init();

    // Feed the mic (noise-gated localStream) into the mixer
    mixer.addMicrophone(voiceManager.localStream);

    // Check for any existing routes and add their audio
    await syncRoutedApps();

    // Replace the audio track on all peer connections
    replaceVoiceTrack(mixedStream);

    // Store a reference so the audio panel can interact with the mixer
    window._havenMixer = mixer;
  }

  /**
   * Tear down the mixer and restore original voice behavior.
   */
  async function teardownMixer() {
    // Stop all capture streams
    for (const [name, capture] of captureStreams) {
      await capture.stop();
    }
    captureStreams.clear();

    if (mixer) {
      await mixer.destroy();
      mixer = null;
    }
    window._havenMixer = null;
  }

  /**
   * Replace the active audio track on all RTCPeerConnections with
   * the mixer's output track. This is how app audio gets to peers.
   */
  function replaceVoiceTrack(newStream) {
    if (!voiceManager || !newStream) return;

    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;

    // Replace track on all peers
    for (const [userId, peer] of voiceManager.peers) {
      const conn = peer.connection;
      if (!conn) continue;
      const senders = conn.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender) {
        audioSender.replaceTrack(newTrack).catch(err => {
          console.warn(`[Haven Desktop] Failed to replace track for peer ${userId}:`, err);
        });
      }
    }

    // Also update VoiceManager's localStream reference so new peers get the mixed track
    voiceManager.localStream = newStream;
  }

  /**
   * Sync routed apps with the mixer — add/remove capture streams
   * based on current routes from the AudioRouter.
   */
  async function syncRoutedApps() {
    if (!mixer) return;

    let routes = [];
    try {
      routes = await api.getRoutes();
    } catch {
      return;
    }

    const routedNames = new Set(routes.map(r => r.processName));

    // Remove captures for apps that are no longer routed
    for (const [name, capture] of captureStreams) {
      if (!routedNames.has(name)) {
        mixer.removeAppAudio(name);
        await capture.stop();
        captureStreams.delete(name);
      }
    }

    // Add captures for newly routed apps
    for (const route of routes) {
      if (captureStreams.has(route.processName)) {
        // Already capturing — just update volume if changed
        const vol = (route.volume || 100) / 100;
        mixer.setAppVolume(route.processName, vol);
        continue;
      }

      // Find the virtual cable output device to capture from
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const virtualDevice = devices.find(d =>
          d.kind === 'audioinput' &&
          (d.label.toLowerCase().includes('cable output') ||
           d.label.toLowerCase().includes('virtual') ||
           d.label.toLowerCase().includes('haven'))
        );

        if (virtualDevice) {
          const capture = new AudioCaptureStream();
          const vol = (route.volume || 100) / 100;
          const stream = await capture.start(virtualDevice.deviceId, vol);
          captureStreams.set(route.processName, capture);
          mixer.addAppAudio(route.processName, stream, vol);

          // After adding, replace track on all peers if needed
          const mixedStream = mixer.getOutputStream();
          if (mixedStream) replaceVoiceTrack(mixedStream);

          console.log(`[Haven Desktop] Capturing audio for ${route.processName}`);
        }
      } catch (err) {
        console.warn(`[Haven Desktop] Could not capture audio for ${route.processName}:`, err.message);
      }
    }
  }

  /**
   * Poll for route changes (when user routes/unroutes apps in the audio panel).
   */
  function startRoutePolling() {
    stopRoutePolling();
    routeCheckInterval = setInterval(syncRoutedApps, 3000);
  }

  function stopRoutePolling() {
    if (routeCheckInterval) {
      clearInterval(routeCheckInterval);
      routeCheckInterval = null;
    }
  }

  /**
   * Apply the user's preferred output device to all existing audio elements.
   */
  function applyOutputDevicePref() {
    const outputId = localStorage.getItem('haven_output_device');
    if (outputId) {
      document.querySelectorAll('audio, video').forEach(el => {
        if (typeof el.setSinkId === 'function') {
          el.setSinkId(outputId).catch(() => {});
        }
      });

      // Also watch for new audio elements
      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
              if (typeof node.setSinkId === 'function') {
                node.setSinkId(outputId).catch(() => {});
              }
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Bootstrap ────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(hookVoice, 1000));
  } else {
    setTimeout(hookVoice, 1000);
  }

})();
