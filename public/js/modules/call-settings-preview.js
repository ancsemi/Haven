// Microphone and camera previews for changing call settings outside a call
// (no UI). Each preview opens its own stream and closes it on stop(), so
// nothing stays open after the settings page is left.
//
//   const mic = createMicPreview();
//   const { fellBack } = await mic.start(deviceId);   // level() 0 to 100
//   mic.stop();
//
// A saved device that is not plugged in any more falls back to the default
// one; start() says so (`fellBack`) so the page can tell the user. Any other
// failure (permission refused, device busy) is thrown for the page to show.

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
// What browsers throw when an exact deviceId is not there.
const MISSING_DEVICE = new Set(['OverconstrainedError', 'NotFoundError']);

async function openDevice(mediaDevices, kind, deviceId, constraintsFor) {
  const open = (id) => mediaDevices.getUserMedia({ [kind]: constraintsFor(id) });
  try {
    return { stream: await open(deviceId), fellBack: false };
  } catch (err) {
    if (!deviceId || !MISSING_DEVICE.has(err?.name)) throw err;
    return { stream: await open(''), fellBack: true };
  }
}

// Shared start/stop bookkeeping: a start that is overtaken by a newer start or
// by stop() closes the stream it opened instead of leaving it running.
function createPreview({ kind, mediaDevices, constraintsFor, onOpen, onClose }) {
  const media = () => mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
  let generation = 0;
  let stream = null;

  const close = () => {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    onClose?.();
  };

  return {
    get active() { return !!stream; },
    get stream() { return stream; },
    async start(deviceId = '') {
      const mine = ++generation;
      close();
      const md = media();
      if (!md?.getUserMedia) throw Object.assign(new Error('Media devices are not available'), { name: 'NotSupportedError' });
      const opened = await openDevice(md, kind, deviceId, constraintsFor);
      if (mine !== generation) {
        opened.stream.getTracks().forEach((track) => track.stop());
        return { fellBack: opened.fellBack, superseded: true };
      }
      stream = opened.stream;
      onOpen?.(stream);
      return { fellBack: opened.fellBack };
    },
    stop() {
      generation++;
      close();
    },
  };
}

/**
 * @param {object} [options]
 * @param {MediaDevices} [options.mediaDevices]
 * @param {(stream: MediaStream) => object} [options.createChain]  the call's
 *   own mic processing (voice.js MicChain): { stream, currentMicLevel,
 *   ready(), setNoiseMode(), setNoiseSensitivity(), destroy() }. With it the
 *   test plays and measures what a call would send.
 * @param {typeof AudioContext} [options.AudioContext]  level meter without a chain
 * @param {() => HTMLAudioElement} [options.createAudio]  for playing the mic back
 * @param {() => void} [options.onOutputMissing]  the chosen output is not there
 */
export function createMicPreview(options = {}) {
  const AudioCtx = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
  const createAudio = options.createAudio || (() => (typeof Audio === 'function' ? new Audio() : null));
  let chain = null;
  // Without a chain: a plain analyser, for the meter only.
  let ctx = null;
  let analyser = null;
  let data = null;
  // Hearing yourself: the mic plays on an <audio> element, which can be sent
  // to the chosen output device (setSinkId) where the browser allows it.
  let audio = null;
  let playback = false;
  let outputId = '';
  let deviceId = '';

  const routeOutput = () => {
    if (!audio || typeof audio.setSinkId !== 'function') return;
    const target = audio;
    target.setSinkId(outputId || '').catch((err) => {
      if (!outputId || err?.name !== 'NotFoundError' || audio !== target) {
        console.warn('[CallSettings] could not use that output for the test', err);
        return;
      }
      // The chosen speaker is not plugged in: play on the default one.
      target.setSinkId('').catch(() => { /* the browser's default stays */ });
      options.onOutputMissing?.();
    });
  };
  const applyPlayback = () => {
    if (!audio) return;
    audio.muted = !playback;
    if (playback) audio.play?.()?.catch?.(() => { /* starts with the next user action */ });
    else audio.pause?.();
  };

  const preview = createPreview({
    kind: 'audio',
    mediaDevices: options.mediaDevices,
    // While the user hears themselves, echo cancellation is off: it would
    // take their own voice coming back out as an echo and keep cutting it
    // out, so the test (and its meter) would pump in and out. A call never
    // plays your own voice back, so this is closer to what a call sends.
    constraintsFor: (id) => ({ ...AUDIO, echoCancellation: !playback, ...(id ? { deviceId: { exact: id } } : {}) }),
    onOpen(stream) {
      let heard = stream;
      try {
        chain = options.createChain ? options.createChain(stream) : null;
      } catch (err) {
        console.warn('[CallSettings] the call\'s noise processing could not start; testing the raw microphone', err);
        chain = null;
      }
      if (chain) {
        heard = chain.stream;
        chain.ready?.()?.catch?.((err) => console.warn('[CallSettings] AI suppression could not load for the test', err));
      } else if (AudioCtx) {
        ctx = new AudioCtx();
        analyser = ctx.createAnalyser();
        analyser.smoothingTimeConstant = 0.3; // as the call's noise gate analyser
        ctx.createMediaStreamSource(stream).connect(analyser);
        data = new Uint8Array(analyser.frequencyBinCount);
      }
      audio = createAudio();
      if (audio) {
        audio.autoplay = true;
        audio.srcObject = heard;
        routeOutput();
        applyPlayback();
      }
    },
    onClose() {
      try { chain?.destroy(); } catch (err) { console.warn('[CallSettings] closing the test chain failed', err); }
      chain = null;
      try { ctx?.close(); } catch { /* already closed */ }
      ctx = analyser = data = null;
      if (audio) {
        audio.pause?.();
        audio.srcObject = null;
        audio = null;
      }
    },
  });
  return {
    get active() { return preview.active; },
    get playback() { return playback; },
    start(id = '') {
      deviceId = id;
      return preview.start(id);
    },
    stop: preview.stop,
    // Play the microphone back so the user hears how they sound. Turning it
    // on or off during a test reopens the microphone with echo cancellation
    // to match.
    setPlayback(on) {
      const changed = playback !== !!on;
      playback = !!on;
      applyPlayback();
      if (changed && preview.active) {
        preview.start(deviceId).catch((err) => console.warn('[CallSettings] could not reopen the microphone', err));
      }
    },
    // The speaker or headset the playback goes to ('' = the default).
    setOutput(deviceId) {
      outputId = deviceId || '';
      routeOutput();
    },
    // A noise setting changed during the test: hear it straight away.
    setNoiseMode(mode) { chain?.setNoiseMode(mode); },
    setNoiseSensitivity(value) { chain?.setNoiseSensitivity(value); },
    // Same scale as VoiceManager.currentMicLevel, so the meter and the gate
    // marker read the same before and during a call.
    level() {
      if (chain) return chain.currentMicLevel || 0;
      if (!analyser) return 0;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      return Math.min(100, (sum / data.length / 50) * 100);
    },
  };
}

/**
 * @param {object} options
 * @param {(deviceId: string) => object} options.constraintsFor  video constraints for a camera (size and frame rate from Camera Quality)
 * @param {MediaDevices} [options.mediaDevices]
 */
export function createCameraPreview(options = {}) {
  const constraintsFor = options.constraintsFor || ((id) => (id ? { deviceId: { exact: id } } : true));
  return createPreview({ kind: 'video', mediaDevices: options.mediaDevices, constraintsFor });
}
