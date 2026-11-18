'use strict';

// Microphone and camera previews for the Voice & video settings page
// (call-settings-preview.js), and the page that uses them
// (app-call-settings.js, _mountCallSettingsPage).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeDocument } = require('./fakeDom');

const ROOT = path.join(__dirname, '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
const tr = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en) ?? key;

let createMicPreview;
let createCameraPreview;
let createCallSettings;
test.before(async () => {
  ({ createMicPreview, createCameraPreview } = await load('public/js/modules/call-settings-preview.js'));
  ({ createCallSettings } = await load('public/js/modules/call-settings.js'));
});

// A browser's media devices: knows which device ids are plugged in, records
// every stream it hands out, and can be told to refuse or to answer late.
function fakeMedia({ present = ['mic-a', 'cam-a'], refuse = null } = {}) {
  const opened = [];
  const media = {
    opened,
    requests: [],
    hold: null,
    async getUserMedia(constraints) {
      media.requests.push(constraints);
      if (refuse) throw Object.assign(new Error('refused'), { name: refuse });
      const kind = constraints.audio ? 'audio' : 'video';
      const wanted = constraints[kind]?.deviceId?.exact;
      if (wanted && !present.includes(wanted)) throw Object.assign(new Error('missing'), { name: 'OverconstrainedError' });
      if (media.hold) await media.hold;
      const track = { kind, deviceId: wanted || 'default', readyState: 'live', stop() { this.readyState = 'ended'; } };
      const stream = { getTracks: () => [track], track };
      opened.push(stream);
      return stream;
    },
    live: () => opened.filter((s) => s.track.readyState === 'live').length,
  };
  return media;
}

function fakeAudioContext(bins = [100, 100, 0, 0]) {
  const made = [];
  class Ctx {
    constructor() { made.push(this); this.closed = false; }
    createAnalyser() {
      return { frequencyBinCount: bins.length, getByteFrequencyData: (a) => bins.forEach((v, i) => { a[i] = v; }) };
    }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; }
  }
  Ctx.made = made;
  return Ctx;
}

test('the mic preview opens the chosen microphone and closes it on stop', async () => {
  const media = fakeMedia();
  const Ctx = fakeAudioContext();
  const mic = createMicPreview({ mediaDevices: media, AudioContext: Ctx });
  const result = await mic.start('mic-a');
  assert.equal(result.fellBack, false);
  assert.equal(mic.active, true);
  assert.deepEqual(media.requests[0].audio.deviceId, { exact: 'mic-a' });
  assert.equal(media.requests[0].audio.echoCancellation, true, 'the same processing a call asks for');
  mic.stop();
  assert.equal(mic.active, false);
  assert.equal(media.live(), 0);
  assert.equal(Ctx.made[0].closed, true);
  assert.equal(mic.level(), 0);
});

function fakeAudioElement() {
  const el = {
    muted: false, playing: false, sinks: [], srcObject: null,
    play() { el.playing = true; return Promise.resolve(); },
    pause() { el.playing = false; },
    setSinkId(id) { el.sinks.push(id); return Promise.resolve(); },
  };
  return el;
}

test('the mic test plays the microphone back only while asked, on the chosen output', async () => {
  const audio = fakeAudioElement();
  const mic = createMicPreview({ mediaDevices: fakeMedia(), AudioContext: fakeAudioContext(), createAudio: () => audio });
  mic.setOutput('spk-a');
  mic.setPlayback(false);
  await mic.start('mic-a');
  assert.equal(audio.srcObject.track.kind, 'audio');
  assert.deepEqual(audio.sinks, ['spk-a']);
  assert.equal(audio.muted, true, 'playback off: nothing is heard');
  mic.setPlayback(true);
  await new Promise((r) => setImmediate(r)); // the mic reopens without echo cancellation
  assert.equal(audio.srcObject.track.readyState, 'live');
  assert.equal(audio.muted, false);
  assert.equal(audio.playing, true);
  mic.setOutput('');
  assert.deepEqual(audio.sinks, ['spk-a', 'spk-a', ''], 'the reopened test keeps the output; a new one applies straight away');
  mic.stop();
  assert.equal(audio.srcObject, null);
  assert.equal(audio.playing, false);
});

test('echo cancellation is off while you hear yourself, so it does not cut your voice in and out', async () => {
  const media = fakeMedia();
  const mic = createMicPreview({ mediaDevices: media, AudioContext: fakeAudioContext(), createAudio: fakeAudioElement });
  mic.setPlayback(true);
  await mic.start('mic-a');
  assert.equal(media.requests[0].audio.echoCancellation, false);
  assert.equal(media.requests[0].audio.noiseSuppression, true, 'the rest of a call\'s processing stays on');
  assert.equal(media.requests[0].audio.autoGainControl, true);

  // Turning it off during the test reopens the same mic with echo cancellation.
  mic.setPlayback(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(media.requests.length, 2);
  assert.equal(media.requests[1].audio.echoCancellation, true);
  assert.deepEqual(media.requests[1].audio.deviceId, { exact: 'mic-a' });
  assert.equal(media.live(), 1, 'the first stream was closed');

  mic.setPlayback(false);
  assert.equal(media.requests.length, 2, 'no reopen when nothing changed');
  mic.stop();
  mic.setPlayback(true);
  assert.equal(media.requests.length, 2, 'no reopen when no test is running');
});

test('playback works where the browser cannot pick an output', async () => {
  const audio = fakeAudioElement();
  delete audio.setSinkId;
  const mic = createMicPreview({ mediaDevices: fakeMedia(), AudioContext: fakeAudioContext(), createAudio: () => audio });
  mic.setOutput('spk-a');
  mic.setPlayback(true);
  await mic.start('');
  assert.equal(audio.playing, true);
});

function fakeChain() {
  const chain = {
    stream: { id: 'processed' }, currentMicLevel: 42, modes: [], sensitivities: [], destroyed: 0, readied: 0,
    ready: async () => { chain.readied += 1; },
    setNoiseMode: (m) => chain.modes.push(m),
    setNoiseSensitivity: (v) => chain.sensitivities.push(v),
    destroy: () => { chain.destroyed += 1; },
  };
  return chain;
}

test('with the call\'s chain, the test plays and measures what a call would send', async () => {
  const audio = fakeAudioElement();
  const chain = fakeChain();
  let given = null;
  const mic = createMicPreview({
    mediaDevices: fakeMedia(), createAudio: () => audio,
    createChain: (stream) => { given = stream; return chain; },
  });
  mic.setPlayback(true);
  await mic.start('mic-a');
  assert.equal(given.track.kind, 'audio', 'the chain gets the raw mic');
  assert.equal(audio.srcObject, chain.stream, 'you hear the processed sound');
  assert.equal(chain.readied, 1, 'AI suppression is loaded');
  assert.equal(mic.level(), 42, 'the meter reads the chain, as in a call');
  mic.setNoiseMode('suppress');
  mic.setNoiseSensitivity(55);
  assert.deepEqual(chain.modes, ['suppress']);
  assert.deepEqual(chain.sensitivities, [55]);
  mic.stop();
  assert.equal(chain.destroyed, 1);
  assert.doesNotThrow(() => mic.setNoiseMode('off'), 'no chain after stop');
});

test('if the chain cannot start, the raw microphone is tested instead', async () => {
  const audio = fakeAudioElement();
  const mic = createMicPreview({
    mediaDevices: fakeMedia(), AudioContext: fakeAudioContext(), createAudio: () => audio,
    createChain: () => { throw new Error('no AudioContext'); },
  });
  const warn = console.warn;
  console.warn = () => {};
  try { await mic.start(''); } finally { console.warn = warn; }
  assert.equal(audio.srcObject.track.kind, 'audio');
  assert.ok(mic.level() > 0);
});

test('a chosen speaker that is unplugged plays the test on the default one and says so', async () => {
  const audio = fakeAudioElement();
  audio.setSinkId = (id) => {
    audio.sinks.push(id);
    return id === 'spk-gone' ? Promise.reject(Object.assign(new Error('gone'), { name: 'NotFoundError' })) : Promise.resolve();
  };
  let missing = 0;
  const mic = createMicPreview({
    mediaDevices: fakeMedia(), AudioContext: fakeAudioContext(), createAudio: () => audio,
    onOutputMissing: () => { missing += 1; },
  });
  mic.setOutput('spk-gone');
  await mic.start('');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(audio.sinks, ['spk-gone', '']);
  assert.equal(missing, 1);
});

test('the mic level uses the same scale as the call meter', async () => {
  // Average 50 out of 255 is full scale on the call meter.
  const mic = createMicPreview({ mediaDevices: fakeMedia(), AudioContext: fakeAudioContext([50, 50, 50, 50]) });
  await mic.start('');
  assert.equal(mic.level(), 100);
  const quiet = createMicPreview({ mediaDevices: fakeMedia(), AudioContext: fakeAudioContext([10, 10, 0, 0]) });
  await quiet.start('');
  assert.equal(quiet.level(), 10);
});

test('a saved device that is unplugged falls back to the default and says so', async () => {
  const media = fakeMedia({ present: [] });
  const camera = createCameraPreview({ mediaDevices: media });
  const result = await camera.start('cam-gone');
  assert.equal(result.fellBack, true);
  assert.equal(camera.active, true);
  assert.equal(media.requests.length, 2);
  assert.equal(media.live(), 1);
});

test('a refused permission is reported, not swapped for another device', async () => {
  const media = fakeMedia({ refuse: 'NotAllowedError' });
  const mic = createMicPreview({ mediaDevices: media, AudioContext: fakeAudioContext() });
  await assert.rejects(mic.start('mic-a'), { name: 'NotAllowedError' });
  assert.equal(media.requests.length, 1);
  assert.equal(mic.active, false);
});

test('camera constraints come from the caller, so Camera Quality is honored', async () => {
  const media = fakeMedia();
  const camera = createCameraPreview({
    mediaDevices: media,
    constraintsFor: (id) => ({ height: { ideal: 720 }, ...(id ? { deviceId: { exact: id } } : {}) }),
  });
  await camera.start('cam-a');
  assert.deepEqual(media.requests[0].video, { height: { ideal: 720 }, deviceId: { exact: 'cam-a' } });
});

test('starting again closes the earlier stream first', async () => {
  const media = fakeMedia();
  const camera = createCameraPreview({ mediaDevices: media });
  await camera.start('cam-a');
  await camera.start('');
  assert.equal(media.opened.length, 2);
  assert.equal(media.live(), 1);
});

test('a stop while the browser is still opening the device closes it when it arrives', async () => {
  const media = fakeMedia();
  let release;
  media.hold = new Promise((r) => { release = r; });
  const camera = createCameraPreview({ mediaDevices: media });
  const pending = camera.start('cam-a');
  camera.stop();
  release();
  const result = await pending;
  assert.equal(result.superseded, true);
  assert.equal(camera.active, false);
  assert.equal(media.live(), 0, 'the late stream is not left running');
});

// ── The settings page ───────────────────────────────────────────────────

async function setupPage({ voice = {}, present } = {}) {
  const Methods = (await load('public/js/modules/app-call-settings.js')).default;
  const doc = makeDocument();
  const section = doc.createElement('div');
  section.setAttribute('id', 'section-call-settings');
  const make = (tag, id, text) => {
    const node = doc.createElement(tag);
    node.setAttribute('id', id);
    if (text) { const span = doc.createElement('span'); span.textContent = text; node.appendChild(span); }
    section.appendChild(node);
    return node;
  };
  const micButton = make('button', 'call-preview-mic', 'Test microphone');
  const camButton = make('button', 'call-preview-camera', 'Test camera');
  const status = make('small', 'call-preview-status');
  const video = make('video', 'call-preview-video');
  const loopback = make('input', 'call-preview-loopback');
  loopback.checked = true;
  const host = make('div', 'call-settings-page-panel');
  doc.body.appendChild(section);

  const media = fakeMedia({ present });
  let observer = null;
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    AudioContext: globalThis.AudioContext,
    IntersectionObserver: globalThis.IntersectionObserver,
    Audio: globalThis.Audio,
  };
  const audios = [];
  globalThis.Audio = function Audio() { const el = fakeAudioElement(); audios.push(el); return el; };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: media }, configurable: true, writable: true });
  globalThis.AudioContext = fakeAudioContext();
  globalThis.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; }
    observe(target) { this.targets.push(target); if (target === section) observer = this; }
    disconnect() {}
  };
  globalThis.document = doc;
  globalThis.t = tr;

  const storage = { data: {}, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); } };
  const app = Object.assign({ voice: { inVoice: false, isWebcamActive: false, ...voice } }, Methods);
  app.callSettings = createCallSettings({ storage, getVoice: () => app.voice });
  app._mountCallSettingsPage();

  const flush = () => new Promise((r) => setImmediate(r));
  const visible = (on) => observer.cb([{ isIntersecting: on }]);
  const done = () => {
    app.callSettingsPage.destroy();
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
    else delete globalThis.navigator;
    globalThis.AudioContext = saved.AudioContext;
    globalThis.IntersectionObserver = saved.IntersectionObserver;
    globalThis.Audio = saved.Audio;
    delete globalThis.document;
    delete globalThis.t;
  };
  return { app, doc, host, micButton, camButton, loopback, audios, status, video, media, storage, flush, visible, done };
}

const buttonText = (button) => button.querySelector('span').textContent;

test('the page shows every call setting and the voice volume, with no legacy ids', async () => {
  const { host, done } = await setupPage();
  try {
    const shown = new Set(host.querySelectorAll('[data-setting]').map((n) => n.getAttribute('data-setting')));
    assert.ok(shown.has('voiceVolume'));
    assert.ok(shown.has('inputDevice') && shown.has('cameraDevice') && shown.has('screenBitrate'));
    assert.equal(host.querySelectorAll('[id]').length, 0);
  } finally { done(); }
});

test('nothing is opened until a test button is pressed', async () => {
  const { media, visible, flush, done } = await setupPage();
  try {
    visible(true);
    await flush();
    assert.equal(media.live(), 0);
  } finally { done(); }
});

test('the test buttons start and stop the previews and say what they do', async () => {
  const { micButton, camButton, video, media, flush, done } = await setupPage();
  try {
    micButton.dispatch('click');
    camButton.dispatch('click');
    await flush();
    assert.equal(media.live(), 2);
    assert.equal(buttonText(micButton), en.settings.call.stop_mic);
    assert.equal(buttonText(camButton), en.settings.call.stop_camera);
    assert.equal(micButton.getAttribute('aria-pressed'), 'true');
    assert.equal(video.hidden, false);
    assert.equal(video.srcObject.track.kind, 'video');

    camButton.dispatch('click');
    assert.equal(video.hidden, true);
    assert.equal(video.srcObject, null);
    assert.equal(buttonText(camButton), en.settings.call.test_camera);
    assert.equal(media.live(), 1, 'the mic test keeps running');
  } finally { done(); }
});

test('leaving the page or closing settings stops every test', async () => {
  const { micButton, camButton, media, visible, flush, done } = await setupPage();
  try {
    visible(true);
    micButton.dispatch('click');
    camButton.dispatch('click');
    await flush();
    assert.equal(media.live(), 2);
    visible(false);
    assert.equal(media.live(), 0);
    assert.equal(buttonText(micButton), en.settings.call.test_mic);
  } finally { done(); }
});

test('the meter follows the microphone test outside a call', async () => {
  const { app, micButton, flush, done } = await setupPage();
  try {
    micButton.dispatch('click');
    await flush();
    assert.ok(app.callSettingsPreview.mic.active);
    assert.ok(app.callSettingsPreview.mic.level() > 0);
  } finally { done(); }
});

test('the mic test plays back by default, follows the checkbox and the chosen output', async () => {
  const { app, micButton, loopback, audios, flush, done } = await setupPage();
  try {
    app.callSettings.set('outputDevice', 'spk-a');
    micButton.dispatch('click');
    await flush();
    const audio = audios.at(-1);
    assert.equal(audio.muted, false, 'on by default');
    assert.equal(audio.sinks.at(-1), 'spk-a');
    loopback.checked = false;
    loopback.dispatch('change');
    assert.equal(audio.muted, true);
    await flush(); // the mic reopens with echo cancellation on
    const reopened = audios.at(-1);
    assert.notEqual(reopened, audio);
    assert.equal(reopened.muted, true);
    assert.equal(reopened.sinks.at(-1), 'spk-a');
    app.callSettings.set('outputDevice', 'spk-b');
    assert.equal(reopened.sinks.at(-1), 'spk-b');
  } finally { done(); }
});

test('nothing plays back while deafened in a call, and it comes back on undeafen', async () => {
  const { app, micButton, audios, flush, done } = await setupPage({ voice: { inVoice: true, isDeafened: true } });
  try {
    micButton.dispatch('click');
    await flush();
    const audio = audios.at(-1);
    assert.equal(audio.muted, true);
    app.voice.isDeafened = false;
    app._syncCallSettingsPlayback();
    assert.equal(audio.muted, false);
  } finally { done(); }
});

test('noise changes on the page reach a running test through the call\'s chain', async () => {
  const chains = [];
  globalThis.MicChain = class {
    constructor(stream, opts) { Object.assign(this, fakeChain(), { opts }); chains.push(this); }
  };
  try {
    const { app, micButton, audios, flush, done } = await setupPage();
    try {
      app.callSettings.set('noiseMode', 'off');
      micButton.dispatch('click');
      await flush();
      assert.equal(chains.length, 1);
      assert.equal(chains[0].opts.noiseMode, 'off', 'starts with the saved mode');
      assert.equal(audios.at(-1).srcObject, chains[0].stream);
      app.callSettings.set('noiseMode', 'suppress');
      app.callSettings.set('noiseSensitivity', 70);
      assert.deepEqual(chains[0].modes, ['suppress']);
      assert.deepEqual(chains[0].sensitivities, [70]);
    } finally { done(); }
  } finally {
    delete globalThis.MicChain;
  }
});

test('picking another device during a test switches the test to it', async () => {
  const { app, camButton, media, flush, done } = await setupPage({ present: ['cam-a', 'cam-b'] });
  try {
    camButton.dispatch('click');
    await flush();
    app.callSettings.set('cameraDevice', 'cam-b');
    await flush();
    assert.equal(media.live(), 1);
    assert.equal(media.opened.at(-1).track.deviceId, 'cam-b');
    app.callSettings.set('cameraQuality', '720');
    await flush();
    assert.equal(media.opened.length, 3, 'a new quality reopens the camera');
    assert.equal(media.live(), 1);
  } finally { done(); }
});

test('an unplugged saved camera is tested on the default one, with a note', async () => {
  const { app, camButton, status, media, flush, done } = await setupPage({ present: [] });
  try {
    app.callSettings.set('cameraDevice', 'cam-gone');
    camButton.dispatch('click');
    await flush();
    assert.equal(media.live(), 1);
    assert.equal(status.textContent, en.settings.call.camera_missing);
    assert.equal(status.hidden, false);
    assert.equal(app.callSettings.get('cameraDevice'), 'cam-gone', 'the choice is kept for when it comes back');
  } finally { done(); }
});

test('the camera test does not fight a call that already uses the camera', async () => {
  const { camButton, status, media, flush, done } = await setupPage({ voice: { inVoice: true, isWebcamActive: true } });
  try {
    camButton.dispatch('click');
    await flush();
    assert.equal(media.requests.length, 0);
    assert.equal(status.textContent, en.settings.call.camera_in_call);
  } finally { done(); }
});

test('the page is listed in Settings and every new label exists in English', () => {
  const pages = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-settings-pages.js'), 'utf8');
  assert.match(pages, /\['voice', '🎧', 'settings\.pages\.voice', 'Voice & video', \['section-call-settings'\]\]/);
  const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  assert.match(html, /data-target="section-call-settings"/);
  assert.equal((html.match(/id="section-call-settings"/g) || []).length, 1);
  for (const key of ['title', 'hint', 'test_mic', 'stop_mic', 'hear_myself', 'hear_myself_hint', 'output_missing', 'test_camera', 'stop_camera', 'mic_missing',
    'camera_missing', 'camera_in_call', 'permission_denied', 'preview_failed']) {
    assert.ok(en.settings.call[key], `settings.call.${key}`);
  }
  assert.ok(en.settings.pages.voice);
  assert.ok(en.settings.nav.call_settings);
});
