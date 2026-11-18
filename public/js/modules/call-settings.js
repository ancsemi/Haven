// Call settings layer (no UI). One module owns every call setting: the
// localStorage key it is saved under, its default, how a value is checked, and
// how a change reaches the voice engine.
//
//   get(id)             the saved value, or the default
//   set(id, value)      check, save, apply (live if it can be), tell subscribers
//   subscribe(id, fn)   hear changes; returns a function that stops listening
//
// Anything that shows a call setting (the voice sidebar, the fullscreen
// popup, a future pre-call page) reads and writes through here, so none of
// them talks to the voice engine or to localStorage on its own, and several
// copies of one control stay in step through subscribe.
//
// With no call running, set only saves. The engine reads the saved value when
// the next call starts, so changing a setting outside a call is safe.

export const CALL_SETTING_KEYS = Object.freeze({
  inputDevice: 'haven_input_device',
  outputDevice: 'haven_output_device',
  cameraDevice: 'haven_cam_device',
  voiceVolume: 'haven_voice_master_volume',
  cameraQuality: 'haven_cam_quality',
  noiseMode: 'haven_noise_mode',
  noiseSensitivity: 'haven_ns_value',
  screenResolution: 'haven_screen_res',
  screenFrameRate: 'haven_screen_fps',
  screenBitrate: 'haven_screen_bitrate',
});

const CAMERA_QUALITIES = ['480', '720', '720p60', '1080', '1080p60'];
const NOISE_MODES = ['off', 'gate', 'suppress'];
const SCREEN_RESOLUTIONS = [0, 720, 1080, 1440]; // 0 = the source's own size
const SCREEN_FRAME_RATES = [15, 30, 60];

const clampNumber = (value, min, max, fallback) => {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const intOr = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

// Same rule as VoiceManager._normalizeScreenBitrate: 300 to 10000 Kbps,
// below clamps to 300, above wraps to unlimited (0), default 8000.
function normalizeBitrate(value) {
  if (value === null || value === undefined || value === '') return 8000;
  const n = parseInt(value, 10);
  if (!Number.isSafeInteger(n)) return 8000;
  if (n === 0) return 0;
  if (n < 300) return 300;
  if (n > 10000) return 0;
  return n;
}

const oneOf = (list, fallback, parse = (v) => v) => (value) => {
  const v = parse(value);
  return list.includes(v) ? v : fallback;
};

// How each setting is checked. `save` turns the value into the stored text.
const DEFINITIONS = {
  inputDevice: { default: '', normalize: (v) => String(v ?? '') },
  outputDevice: { default: '', normalize: (v) => String(v ?? '') },
  cameraDevice: { default: '', normalize: (v) => String(v ?? '') },
  voiceVolume: { default: 1, normalize: (v) => clampNumber(v, 0, 2, 1) },
  cameraQuality: { default: '480', normalize: oneOf(CAMERA_QUALITIES, '480', String) },
  noiseMode: { default: 'gate', normalize: oneOf(NOISE_MODES, 'gate', String) },
  noiseSensitivity: { default: 10, normalize: (v) => Math.round(clampNumber(v, 0, 100, 10)) },
  screenResolution: { default: 1080, normalize: oneOf(SCREEN_RESOLUTIONS, 1080, (v) => intOr(v, NaN)) },
  screenFrameRate: { default: 30, normalize: oneOf(SCREEN_FRAME_RATES, 30, (v) => intOr(v, NaN)) },
  screenBitrate: { default: 8000, normalize: normalizeBitrate },
};

/**
 * @param {object} options
 * @param {Storage} [options.storage]   defaults to window.localStorage
 * @param {() => object|null} options.getVoice  returns the VoiceManager, if any
 */
export function createCallSettings({ storage, getVoice } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const voiceNow = () => (typeof getVoice === 'function' ? getVoice() : null) || null;
  const subscribers = Object.fromEntries(Object.keys(DEFINITIONS).map((id) => [id, new Set()]));
  const session = {};        // values that could not be saved (storage blocked)
  const notifying = new Set();

  const definition = (id) => {
    if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, id)) {
      throw new Error(`Unknown call setting: ${id}`);
    }
    return DEFINITIONS[id];
  };

  // The one place that touches storage, so a profile key (per mic or
  // camera) can be added here later.
  const read = (id) => {
    // A value that could not be saved wins over what storage still holds:
    // some browsers (a full quota, older Safari private mode) allow reads but
    // refuse writes.
    if (Object.prototype.hasOwnProperty.call(session, id)) return String(session[id]);
    try {
      return store ? store.getItem(CALL_SETTING_KEYS[id]) : null;
    } catch {
      return null; // private mode: storage is unreadable, so the default applies
    }
  };
  const write = (id, value) => {
    try {
      if (!store) throw new Error('no storage');
      store.setItem(CALL_SETTING_KEYS[id], String(value));
      delete session[id];
    } catch {
      session[id] = value; // private mode: the value holds for this visit only
    }
  };

  const get = (id) => {
    const def = definition(id);
    const raw = read(id);
    if (raw === null || raw === undefined) return def.default;
    // Stored text that does not pass the check falls back to the default.
    const value = def.normalize(raw);
    if ((id === 'noiseMode' || id === 'cameraQuality' || id === 'screenResolution' || id === 'screenFrameRate')
      && String(value) !== String(raw).trim()) return def.default;
    return value;
  };

  // Hands a saved value to the voice engine. Without a call it only reaches
  // state the engine reads at the next join. Returns the engine's promise for
  // the device switches, which are async.
  const apply = (id, value) => {
    const voice = voiceNow();
    if (!voice) return undefined;
    switch (id) {
      case 'inputDevice':
        return voice.inVoice ? voice.switchInputDevice(value) : undefined;
      case 'outputDevice':
        return voice.switchOutputDevice(value);
      case 'cameraDevice':
        return voice.isWebcamActive ? voice.switchCamera(value) : undefined;
      case 'cameraQuality':
        // A camera that is on picks the new size up straight away.
        return voice.isWebcamActive ? voice.switchCamera(get('cameraDevice')) : undefined;
      case 'voiceVolume':
        voice.setVoiceMasterVolume(value);
        break;
      case 'noiseMode':
        if (voice.inVoice) voice.setNoiseMode(value);
        else voice.noiseMode = value; // used when the next call starts
        break;
      case 'noiseSensitivity':
        if (voice.inVoice) voice.setNoiseSensitivity(value);
        break;
      case 'screenResolution':
        voice.setScreenResolution(value);
        break;
      case 'screenFrameRate':
        voice.setScreenFrameRate(value);
        break;
      case 'screenBitrate':
        voice.setScreenBitrate(value);
        break;
      default:
        break;
    }
    return undefined;
  };

  const set = (id, value) => {
    const def = definition(id);
    const raw = value;
    let next = def.normalize(raw);
    // A value that is not one of the choices is refused, not swapped for the
    // default: the setting stays as it was.
    if ((id === 'noiseMode' || id === 'cameraQuality') && next !== String(raw)) return get(id);
    if (notifying.has(id) && next === get(id)) return next; // a subscriber echoing the value back
    write(id, next);
    // The value is saved either way, so a failure in the engine must not keep
    // the other copies of the control from showing it.
    try {
      const pending = apply(id, next);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => console.error(`[CallSettings] applying ${id} failed`, err));
      }
    } catch (err) {
      console.error(`[CallSettings] applying ${id} failed`, err);
    }
    // The engine may normalize further (and saves for itself); the layer's
    // value is the one it was given.
    notifying.add(id);
    try {
      for (const fn of [...subscribers[id]]) {
        try { fn(next); } catch (err) { console.error(`[CallSettings] subscriber for ${id} failed`, err); }
      }
    } finally {
      notifying.delete(id);
    }
    return next;
  };

  const subscribe = (id, fn) => {
    definition(id);
    subscribers[id].add(fn);
    return () => { subscribers[id].delete(fn); };
  };

  return { get, set, subscribe };
}
