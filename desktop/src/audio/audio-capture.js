/**
 * Haven Desktop — Audio Capture Stream
 *
 * Captures audio from a virtual audio cable endpoint and provides it
 * as a MediaStream that can be piped into WebRTC (Haven voice chat).
 *
 * This module runs in the renderer process and uses the Web Audio API
 * to capture from the virtual cable device, then creates a MediaStream
 * that the Haven voice system can use as an additional audio source.
 */

class AudioCaptureStream {
  constructor() {
    this.audioContext = null;
    this.mediaStream  = null;
    this.sourceNode   = null;
    this.gainNode     = null;
    this.destination  = null;
    this.isCapturing  = false;
    this.volume       = 1.0;
  }

  /**
   * Start capturing audio from a specific device.
   * @param {string} deviceId  - MediaDevices device ID of the virtual cable output
   * @param {number} [volume]  - Initial volume (0.0 - 1.0)
   * @returns {MediaStream} A MediaStream containing the captured audio
   */
  async start(deviceId, volume = 1.0) {
    if (this.isCapturing) await this.stop();

    this.audioContext = new AudioContext({ sampleRate: 48000 });

    // Capture audio from the virtual cable's output endpoint
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,    // don't process — we want raw audio
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
      },
      video: false,
    });

    // Build audio graph: source -> gain -> destination (output stream)
    this.sourceNode  = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.gainNode    = this.audioContext.createGain();
    this.destination = this.audioContext.createMediaStreamDestination();

    this.gainNode.gain.value = volume;
    this.volume = volume;

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.destination);

    this.isCapturing = true;

    // Return the output stream — this gets mixed into voice chat
    return this.destination.stream;
  }

  /**
   * Set the capture volume.
   * @param {number} vol - 0.0 to 2.0
   */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(2.0, vol));
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(this.volume, this.audioContext.currentTime);
    }
  }

  /** Stop capturing. */
  async stop() {
    if (this.sourceNode)  this.sourceNode.disconnect();
    if (this.gainNode)    this.gainNode.disconnect();
    if (this.destination) this.destination.disconnect();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

    this.isCapturing  = false;
    this.audioContext  = null;
    this.mediaStream   = null;
    this.sourceNode    = null;
    this.gainNode      = null;
    this.destination   = null;
  }

  /** Get current state. */
  getState() {
    return {
      isCapturing: this.isCapturing,
      volume: this.volume,
    };
  }
}

/**
 * AudioMixer — Mixes microphone + one or more app audio captures
 * into a single MediaStream for WebRTC.
 */
class AudioMixer {
  constructor() {
    this.audioContext = null;
    this.destination  = null;
    this.sources      = new Map();  // id -> { source, gain }
    this.micSource    = null;
    this.micGain      = null;
  }

  /** Initialize the mixer. Returns the mixed output stream. */
  async init() {
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    this.destination  = this.audioContext.createMediaStreamDestination();
    return this.destination.stream;
  }

  /**
   * Add a microphone stream to the mix.
   * @param {MediaStream} micStream
   * @param {number} [volume=1.0]
   */
  addMicrophone(micStream, volume = 1.0) {
    if (this.micSource) {
      this.micSource.disconnect();
      this.micGain.disconnect();
    }
    this.micSource = this.audioContext.createMediaStreamSource(micStream);
    this.micGain   = this.audioContext.createGain();
    this.micGain.gain.value = volume;
    this.micSource.connect(this.micGain);
    this.micGain.connect(this.destination);
  }

  /**
   * Add an app audio capture stream to the mix.
   * @param {string} id - Unique identifier (process name)
   * @param {MediaStream} stream - From AudioCaptureStream
   * @param {number} [volume=0.8]
   */
  addAppAudio(id, stream, volume = 0.8) {
    // Remove existing if any
    this.removeAppAudio(id);

    const source = this.audioContext.createMediaStreamSource(stream);
    const gain   = this.audioContext.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.destination);
    this.sources.set(id, { source, gain });
  }

  /**
   * Adjust volume for an app audio source.
   * @param {string} id
   * @param {number} vol
   */
  setAppVolume(id, vol) {
    const entry = this.sources.get(id);
    if (entry) {
      entry.gain.gain.setValueAtTime(
        Math.max(0, Math.min(2.0, vol)),
        this.audioContext.currentTime
      );
    }
  }

  /** Remove an app audio source from the mix. */
  removeAppAudio(id) {
    const entry = this.sources.get(id);
    if (entry) {
      entry.source.disconnect();
      entry.gain.disconnect();
      this.sources.delete(id);
    }
  }

  /** Get the final mixed output stream (for WebRTC). */
  getOutputStream() {
    return this.destination?.stream || null;
  }

  /** Tear down. */
  async destroy() {
    for (const [id] of this.sources) this.removeAppAudio(id);
    if (this.micSource) this.micSource.disconnect();
    if (this.micGain)   this.micGain.disconnect();
    if (this.audioContext?.state !== 'closed') {
      await this.audioContext?.close();
    }
  }
}

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioCaptureStream, AudioMixer };
} else {
  window.HavenAudio = { AudioCaptureStream, AudioMixer };
}
