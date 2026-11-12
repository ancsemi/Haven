'use strict';

/**
 * The call settings layer: one place that owns each call setting's storage
 * key, default, validation and how it reaches the voice engine. It has no UI.
 *
 *   node --test test/callSettings.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

let createCallSettings;
let CALL_SETTING_KEYS;
test.before(async () => {
  ({ createCallSettings, CALL_SETTING_KEYS } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public/js/modules/call-settings.js')).href
  ));
});

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

function makeVoice(overrides = {}) {
  const calls = [];
  const voice = {
    inVoice: false,
    isWebcamActive: false,
    calls,
    switchInputDevice: (id) => calls.push(['switchInputDevice', id]),
    switchOutputDevice: (id) => calls.push(['switchOutputDevice', id]),
    switchCamera: (id) => calls.push(['switchCamera', id]),
    setVoiceMasterVolume: (v) => calls.push(['setVoiceMasterVolume', v]),
    setNoiseMode: (m) => calls.push(['setNoiseMode', m]),
    setNoiseSensitivity: (v) => calls.push(['setNoiseSensitivity', v]),
    setScreenResolution: (v) => calls.push(['setScreenResolution', v]),
    setScreenFrameRate: (v) => calls.push(['setScreenFrameRate', v]),
    setScreenBitrate: (v) => calls.push(['setScreenBitrate', v]),
    ...overrides,
  };
  return voice;
}

function setup({ storage = makeStorage(), voice = makeVoice() } = {}) {
  const settings = createCallSettings({ storage, getVoice: () => voice });
  return { settings, storage, voice };
}

test('storage keys are the ones the app already uses', () => {
  assert.deepEqual({ ...CALL_SETTING_KEYS }, {
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
});

test('get returns the default for every setting when nothing is saved', () => {
  const { settings } = setup();
  assert.equal(settings.get('inputDevice'), '');
  assert.equal(settings.get('outputDevice'), '');
  assert.equal(settings.get('cameraDevice'), '');
  assert.equal(settings.get('voiceVolume'), 1);
  assert.equal(settings.get('cameraQuality'), '480');
  assert.equal(settings.get('noiseMode'), 'gate');
  assert.equal(settings.get('noiseSensitivity'), 10);
  assert.equal(settings.get('screenResolution'), 1080);
  assert.equal(settings.get('screenFrameRate'), 30);
  assert.equal(settings.get('screenBitrate'), 8000);
});

test('get reads saved values and falls back on invalid ones', () => {
  const storage = makeStorage({
    haven_input_device: 'mic-1',
    haven_voice_master_volume: '1.5',
    haven_cam_quality: '720p60',
    haven_noise_mode: 'suppress',
    haven_ns_value: '40',
    haven_screen_res: '0',
    haven_screen_fps: '60',
    haven_screen_bitrate: '2500',
  });
  const { settings } = setup({ storage });
  assert.equal(settings.get('inputDevice'), 'mic-1');
  assert.equal(settings.get('voiceVolume'), 1.5);
  assert.equal(settings.get('cameraQuality'), '720p60');
  assert.equal(settings.get('noiseMode'), 'suppress');
  assert.equal(settings.get('noiseSensitivity'), 40);
  assert.equal(settings.get('screenResolution'), 0);
  assert.equal(settings.get('screenFrameRate'), 60);
  assert.equal(settings.get('screenBitrate'), 2500);

  const bad = setup({ storage: makeStorage({
    haven_voice_master_volume: 'loud',
    haven_cam_quality: '4k',
    haven_noise_mode: 'bogus',
    haven_ns_value: 'x',
    haven_screen_res: 'x',
    haven_screen_fps: '0',
    haven_screen_bitrate: 'x',
  }) }).settings;
  assert.equal(bad.get('voiceVolume'), 1);
  assert.equal(bad.get('cameraQuality'), '480');
  assert.equal(bad.get('noiseMode'), 'gate');
  assert.equal(bad.get('noiseSensitivity'), 10);
  assert.equal(bad.get('screenResolution'), 1080);
  assert.equal(bad.get('screenFrameRate'), 30);
  assert.equal(bad.get('screenBitrate'), 8000);
});

test('get still works when storage throws (private mode)', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const { settings } = setup({ storage });
  assert.equal(settings.get('noiseMode'), 'gate');
  assert.doesNotThrow(() => settings.set('noiseMode', 'off'));
  assert.equal(settings.get('noiseMode'), 'off', 'the value holds for this visit');
});

test('set clamps and normalizes before saving', () => {
  const { settings, storage } = setup();
  assert.equal(settings.set('voiceVolume', 5), 2);
  assert.equal(storage.data.haven_voice_master_volume, '2');
  assert.equal(settings.set('voiceVolume', -1), 0);
  assert.equal(settings.set('noiseSensitivity', 150), 100);
  assert.equal(storage.data.haven_ns_value, '100');
  assert.equal(settings.set('noiseSensitivity', -4), 0);
  assert.equal(settings.set('screenBitrate', 100), 300);
  assert.equal(settings.set('screenBitrate', 20000), 0, 'above the range wraps to unlimited');
  assert.equal(settings.set('screenBitrate', 0), 0);
  assert.equal(storage.data.haven_screen_bitrate, '0');
});

test('set ignores a value that is not valid for a choice setting', () => {
  const { settings, storage, voice } = setup();
  assert.equal(settings.set('noiseMode', 'bogus'), 'gate');
  assert.equal(settings.set('cameraQuality', '4k'), '480');
  assert.equal(storage.data.haven_noise_mode, undefined);
  assert.equal(storage.data.haven_cam_quality, undefined);
  assert.deepEqual(voice.calls, []);
});

test('with no call, set only saves (devices, noise, sensitivity, camera)', () => {
  const { settings, storage, voice } = setup();
  settings.set('inputDevice', 'mic-2');
  settings.set('cameraDevice', 'cam-2');
  settings.set('cameraQuality', '1080');
  settings.set('noiseSensitivity', 55);
  settings.set('noiseMode', 'suppress');
  assert.equal(storage.data.haven_input_device, 'mic-2');
  assert.equal(storage.data.haven_cam_device, 'cam-2');
  assert.equal(storage.data.haven_cam_quality, '1080');
  assert.equal(storage.data.haven_ns_value, '55');
  assert.equal(storage.data.haven_noise_mode, 'suppress');
  assert.deepEqual(voice.calls, [], 'nothing reaches the audio graph without a call');
  assert.equal(voice.noiseMode, 'suppress', 'the engine picks the mode up for the next join');
});

test('in a call, devices, noise and sensitivity apply live', () => {
  const { settings, voice } = setup({ voice: makeVoice({ inVoice: true }) });
  settings.set('inputDevice', 'mic-2');
  settings.set('noiseMode', 'off');
  settings.set('noiseSensitivity', 30);
  assert.deepEqual(voice.calls, [
    ['switchInputDevice', 'mic-2'],
    ['setNoiseMode', 'off'],
    ['setNoiseSensitivity', 30],
  ]);
});

test('the camera device and quality apply only while the camera is on', () => {
  const on = setup({ voice: makeVoice({ inVoice: true, isWebcamActive: true }) });
  on.settings.set('cameraDevice', 'cam-9');
  on.settings.set('cameraQuality', '720');
  assert.deepEqual(on.voice.calls, [
    ['switchCamera', 'cam-9'],
    ['switchCamera', 'cam-9'],
  ], 'a quality change restarts the camera on the saved device');

  const off = setup({ voice: makeVoice({ inVoice: true }) });
  off.settings.set('cameraDevice', 'cam-9');
  off.settings.set('cameraQuality', '720');
  assert.deepEqual(off.voice.calls, []);
});

test('output device, volume and screen settings go to the engine whenever it exists', () => {
  const { settings, voice } = setup();
  settings.set('outputDevice', 'spk-1');
  settings.set('voiceVolume', 0.5);
  settings.set('screenResolution', 720);
  settings.set('screenFrameRate', 60);
  settings.set('screenBitrate', 4000);
  assert.deepEqual(voice.calls, [
    ['switchOutputDevice', 'spk-1'],
    ['setVoiceMasterVolume', 0.5],
    ['setScreenResolution', 720],
    ['setScreenFrameRate', 60],
    ['setScreenBitrate', 4000],
  ]);
});

test('set works before the engine exists', () => {
  const storage = makeStorage();
  const settings = createCallSettings({ storage, getVoice: () => null });
  assert.doesNotThrow(() => {
    settings.set('outputDevice', 'spk-1');
    settings.set('noiseMode', 'off');
    settings.set('screenBitrate', 3000);
  });
  assert.equal(storage.data.haven_output_device, 'spk-1');
  assert.equal(storage.data.haven_screen_bitrate, '3000');
});

test('subscribers hear changes for their setting only, and can unsubscribe', () => {
  const { settings } = setup();
  const heard = [];
  const other = [];
  const off = settings.subscribe('noiseMode', (v) => heard.push(v));
  settings.subscribe('voiceVolume', (v) => other.push(v));
  settings.set('noiseMode', 'off');
  settings.set('noiseMode', 'suppress');
  off();
  settings.set('noiseMode', 'gate');
  assert.deepEqual(heard, ['off', 'suppress']);
  assert.deepEqual(other, []);
});

test('a subscriber that calls set does not loop', () => {
  const { settings } = setup();
  let heard = 0;
  settings.subscribe('noiseSensitivity', (v) => {
    heard += 1;
    settings.set('noiseSensitivity', v);
  });
  settings.set('noiseSensitivity', 20);
  assert.equal(heard, 1);
  assert.equal(settings.get('noiseSensitivity'), 20);
});

test('a failing subscriber does not stop the others or the save', () => {
  const { settings, storage } = setup();
  const heard = [];
  settings.subscribe('noiseMode', () => { throw new Error('boom'); });
  settings.subscribe('noiseMode', (v) => heard.push(v));
  const original = console.error;
  console.error = () => {};
  try { settings.set('noiseMode', 'off'); } finally { console.error = original; }
  assert.deepEqual(heard, ['off']);
  assert.equal(storage.data.haven_noise_mode, 'off');
});

test('unknown setting ids throw so typos are caught', () => {
  const { settings } = setup();
  assert.throws(() => settings.get('nope'), /Unknown call setting/);
  assert.throws(() => settings.set('nope', 1), /Unknown call setting/);
  assert.throws(() => settings.subscribe('nope', () => {}), /Unknown call setting/);
});

test('screen bitrate rules match the voice engine', () => {
  const voiceSource = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');
  const vm = require('node:vm');
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  });
  vm.runInContext(`${voiceSource}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const normalize = (v) => context.module.exports.prototype._normalizeScreenBitrate.call({}, v);
  const { settings } = setup();
  for (const input of [0, 100, 299, 300, 8000, 10000, 10001, 99999]) {
    assert.equal(settings.set('screenBitrate', input), normalize(input), `bitrate ${input}`);
  }
});

test('voice.js and the layer use the same storage keys', () => {
  const fs = require('node:fs');
  const voiceSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');
  const used = new Set(voiceSource.match(/haven_(?:input_device|output_device|cam_device|voice_master_volume|cam_quality|noise_mode|ns_value|screen_res|screen_fps|screen_bitrate)\b/g));
  const known = new Set(Object.values(CALL_SETTING_KEYS));
  for (const key of used) assert.ok(known.has(key), `${key} is not in CALL_SETTING_KEYS`);
  // voice.js is a classic script and cannot import the layer, so every key it
  // reads for a call setting must be one the layer owns, with the same default.
  for (const key of ['haven_noise_mode', 'haven_screen_res', 'haven_screen_fps', 'haven_screen_bitrate', 'haven_ns_value']) {
    assert.ok(used.has(key), `voice.js no longer reads ${key}; update this test`);
  }
});

test('app modules go through the layer instead of reading call-setting keys', () => {
  const fs = require('node:fs');
  for (const file of ['app-voice-controls.js', 'app-voice.js', 'app-master-volume.js', 'app-screen-webcam.js', 'app-composer.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules', file), 'utf8');
    for (const key of Object.values(CALL_SETTING_KEYS)) {
      assert.ok(!src.includes(`'${key}'`), `${file} still touches ${key} directly`);
    }
  }
});
