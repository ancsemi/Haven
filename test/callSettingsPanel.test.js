'use strict';

/**
 * The call settings panel builder: it must produce the sidebar panel exactly as
 * the static markup in app.html did (same controls, order, labels, ids, classes
 * and saved keys), keep copies in step, and clean up after itself.
 *
 *   node --test test/callSettingsPanel.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeDocument, parseHtml, toTree } = require('./fakeDom');

const ROOT = path.join(__dirname, '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
const tr = (key, params = {}) => {
  const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), en);
  if (value == null) return key;
  return Object.entries(params).reduce((s, [k, v]) => s.replace(`{{${k}}}`, v), String(value));
};

let createCallSettings;
let createCallSettingsPanel;
let createDeviceList;
let CONTROLS;
test.before(async () => {
  ({ createCallSettings } = await load('public/js/modules/call-settings.js'));
  ({ createCallSettingsPanel, createDeviceList, CONTROLS } = await load('public/js/modules/call-settings-panel.js'));
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

function makeVoice() {
  const calls = [];
  const voice = { inVoice: false, isWebcamActive: false, calls };
  for (const name of ['switchInputDevice', 'switchOutputDevice', 'switchCamera', 'setVoiceMasterVolume',
    'setNoiseMode', 'setNoiseSensitivity', 'setScreenResolution', 'setScreenFrameRate', 'setScreenBitrate']) {
    voice[name] = (...args) => calls.push([name, ...args]);
  }
  return voice;
}

const DEVICES = [
  { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk Mic' },
  { kind: 'audioinput', deviceId: 'mic-b', label: '' },
  { kind: 'audiooutput', deviceId: 'spk-a', label: 'Headset' },
  { kind: 'videoinput', deviceId: 'cam-a', label: 'Webcam' },
];

function fakeMediaDevices(list = DEVICES) {
  const stats = { enumerate: 0, getUserMedia: 0, stopped: 0 };
  let labelled = list.every((d) => d.label);
  return {
    stats,
    async enumerateDevices() {
      stats.enumerate += 1;
      return list.map((d) => ({ ...d, label: labelled ? d.label : '' }));
    },
    async getUserMedia() {
      stats.getUserMedia += 1;
      labelled = true;
      return { getTracks: () => [{ stop: () => { stats.stopped += 1; } }] };
    },
  };
}

function setup({ legacyIds = true, storage = makeStorage(), voice = makeVoice(), host, doc, extra = {} } = {}) {
  const document = doc || makeDocument();
  const settings = createCallSettings({ storage, getVoice: () => voice });
  const mediaDevices = fakeMediaDevices();
  const devices = createDeviceList({ mediaDevices });
  const target = host || document.createElement('div');
  if (!host) document.body.appendChild(target);
  const panel = createCallSettingsPanel(target, {
    settings, devices, legacyIds, t: tr, supportsOutputSelection: true, ...extra,
  });
  return { document, settings, devices, voice, storage, panel, host: target, mediaDevices };
}

// ── Parity with the markup that used to be in app.html ──────────────────

// Attributes the old code set from JavaScript, or that only exist at run time,
// are not part of the layout being compared.
const RUNTIME_ONLY = new Set(['selected', 'data-setting', 'data-bitrate-step', 'style']);

function normalize(node) {
  if (node.text !== undefined) return { text: node.text.trim() };
  const attrs = {};
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (RUNTIME_ONLY.has(k)) continue;
    // An option's value is part of the layout; an input's value is its current state.
    if (k === 'value' && node.tag !== 'option') continue;
    attrs[k] = v;
  }
  const children = [];
  for (const child of node.children) {
    const n = normalize(child);
    if (n.text === '') continue;
    // adjacent text pieces merge, as the browser would show them
    if (n.text !== undefined && children.length && children[children.length - 1].text !== undefined) {
      children[children.length - 1].text += n.text;
    } else children.push(n);
  }
  return { tag: node.tag, attrs, children };
}

// Options of a device list are filled in by the device list, not the markup:
// compare the always-present first option and ignore the rest.
function trimDeviceOptions(tree) {
  if (tree.tag === 'select' && ['voice-input-device', 'voice-output-device', 'voice-cam-device'].includes(tree.attrs.id)) {
    return { ...tree, children: tree.children.slice(0, 1) };
  }
  return { ...tree, children: (tree.children || []).map((c) => (c.tag ? trimDeviceOptions(c) : c)) };
}

test('the sidebar panel matches the old static markup: controls, order, labels, ids, classes', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/voice-settings-panel.html'), 'utf8');
  const expected = parseHtml(fixture).map(normalize);
  const { host } = setup();
  const actual = host.childNodes.filter((n) => !(n.nodeType === 3 && !n.textContent.trim()))
    .map((n) => trimDeviceOptions(normalize(toTree(n))));
  assert.equal(actual.length, expected.length, 'same number of top-level blocks');
  for (let i = 0; i < expected.length; i += 1) {
    assert.deepEqual(actual[i], trimDeviceOptions(expected[i]), `block ${i} differs`);
  }
});

test('every element id the old panel had is present exactly once in the sidebar copy', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/voice-settings-panel.html'), 'utf8');
  const oldIds = [...fixture.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const { host } = setup();
  for (const id of oldIds) {
    assert.equal(host.querySelectorAll(`#${id}`).length, 1, `#${id}`);
  }
});

test('a secondary copy has no ids at all, so ids stay unique', () => {
  const { document, host } = setup({ legacyIds: true });
  const second = setup({ legacyIds: false, doc: document });
  const withId = (root) => root.querySelectorAll('[id]');
  assert.equal(withId(second.host).length, 0);
  assert.ok(withId(host).length > 10);
  const ids = withId(document.body).map((n) => n.attributes.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids on the page');
});

test('every control carries a data-setting naming its setting', () => {
  const { host } = setup({ legacyIds: false });
  const found = new Set(host.querySelectorAll('[data-setting]').map((n) => n.attributes['data-setting']));
  const expected = CONTROLS.filter((c) => c.setting && !c.optional).map((c) => c.setting);
  assert.deepEqual([...found].sort(), expected.sort());
});

test('optional controls are built only where asked for, so the sidebar keeps its layout', () => {
  assert.deepEqual(CONTROLS.filter((c) => c.optional).map((c) => c.setting), ['voiceVolume']);
  const sidebar = setup();
  assert.equal(sidebar.host.querySelector('[data-setting="voiceVolume"]'), null);
  const popup = setup({ legacyIds: false, extra: { include: ['voiceVolume'] } });
  const slider = popup.host.querySelector('[data-setting="voiceVolume"]');
  assert.equal(slider.getAttribute('min'), '0');
  assert.equal(slider.getAttribute('max'), '200');
  assert.equal(slider.value, '100', '1.0 shows as 100%');
  popup.settings.set('voiceVolume', 0.4);
  assert.equal(slider.value, '40');
});

test('every label key used by the panel exists in en.json', () => {
  const { host } = setup();
  for (const node of host.querySelectorAll('[data-i18n]')) {
    assert.notEqual(tr(node.attributes['data-i18n']), node.attributes['data-i18n'], node.attributes['data-i18n']);
  }
  for (const node of host.querySelectorAll('[data-i18n-title]')) {
    assert.notEqual(tr(node.attributes['data-i18n-title']), node.attributes['data-i18n-title']);
  }
});

// ── Saved keys and voice calls ──────────────────────────────────────────

const byId = (host, id) => host.querySelector(`#${id}`);

test('controls start on the saved values', () => {
  const storage = makeStorage({
    haven_cam_quality: '720p60', haven_noise_mode: 'suppress', haven_ns_value: '40',
    haven_screen_res: '0', haven_screen_fps: '60', haven_screen_bitrate: '2500',
  });
  const { host } = setup({ storage });
  assert.equal(byId(host, 'voice-cam-quality').value, '720p60');
  assert.equal(byId(host, 'voice-noise-mode').value, 'suppress');
  assert.equal(byId(host, 'voice-ns-slider').value, '40');
  assert.equal(byId(host, 'screen-res-select').value, 'source');
  assert.equal(byId(host, 'screen-fps-select').value, '60');
  assert.equal(byId(host, 'screen-bitrate-value').value, '2500 Kbps');
});

test('defaults show when nothing is saved', () => {
  const { host } = setup();
  assert.equal(byId(host, 'voice-cam-quality').value, '480');
  assert.equal(byId(host, 'voice-noise-mode').value, 'gate');
  assert.equal(byId(host, 'voice-ns-slider').value, '10');
  assert.equal(byId(host, 'screen-res-select').value, '1080');
  assert.equal(byId(host, 'screen-fps-select').value, '30');
  assert.equal(byId(host, 'screen-bitrate-value').value, '8000 Kbps');
});

test('changing a control saves under the same key the app always used', () => {
  const { host, storage } = setup();
  const change = (id, value) => { const n = byId(host, id); n.value = value; n.dispatch('change'); };
  change('voice-cam-quality', '1080');
  change('voice-noise-mode', 'off');
  change('screen-res-select', 'source');
  change('screen-fps-select', '60');
  const slider = byId(host, 'voice-ns-slider');
  slider.value = '55';
  slider.dispatch('input');
  assert.equal(storage.data.haven_cam_quality, '1080');
  assert.equal(storage.data.haven_noise_mode, 'off');
  assert.equal(storage.data.haven_screen_res, '0');
  assert.equal(storage.data.haven_screen_fps, '60');
  assert.equal(storage.data.haven_ns_value, '55');
});

test('device pickers save and switch devices through the layer', async () => {
  const voice = makeVoice();
  voice.inVoice = true;
  voice.isWebcamActive = true;
  const { host, storage, devices } = setup({ voice });
  await devices.refresh();
  const input = byId(host, 'voice-input-device');
  input.value = 'mic-a';
  input.dispatch('change');
  const cam = byId(host, 'voice-cam-device');
  cam.value = 'cam-a';
  cam.dispatch('change');
  assert.equal(storage.data.haven_input_device, 'mic-a');
  assert.equal(storage.data.haven_cam_device, 'cam-a');
  assert.deepEqual(voice.calls, [['switchInputDevice', 'mic-a'], ['switchCamera', 'cam-a']]);
});

test('outside a call, changing noise mode saves without touching the audio graph', () => {
  const { host, voice, storage } = setup();
  const mode = byId(host, 'voice-noise-mode');
  mode.value = 'suppress';
  mode.dispatch('change');
  assert.equal(storage.data.haven_noise_mode, 'suppress');
  assert.deepEqual(voice.calls, []);
});

test('the gate sensitivity row shows only in gate mode', () => {
  const { host, settings } = setup();
  const row = byId(host, 'noise-gate-row');
  assert.equal(row.style.display, '');
  settings.set('noiseMode', 'suppress');
  assert.equal(row.style.display, 'none');
  settings.set('noiseMode', 'gate');
  assert.equal(row.style.display, '');
});

test('the gate marker on the mic meter follows mode and sensitivity', () => {
  const { host, settings } = setup();
  const marker = byId(host, 'mic-meter-threshold');
  settings.set('noiseSensitivity', 50);
  assert.equal(marker.style.display, '');
  assert.equal(marker.style.left, `${((2 + 0.5 * 38) / 50) * 100}%`);
  settings.set('noiseMode', 'off');
  assert.equal(marker.style.display, 'none');
  settings.set('noiseMode', 'gate');
  settings.set('noiseSensitivity', 0);
  assert.equal(marker.style.display, 'none');
});

// ── Bitrate field ───────────────────────────────────────────────────────

test('bitrate: typing a number and pressing Enter commits it, clamped', () => {
  const { host, storage } = setup();
  const field = byId(host, 'screen-bitrate-value');
  field.value = '2500';
  field.dispatch('keydown', { key: 'Enter' });
  assert.equal(storage.data.haven_screen_bitrate, '2500');
  assert.equal(field.value, '2500 Kbps');
  field.value = '50';
  field.dispatch('keydown', { key: 'Enter' });
  assert.equal(storage.data.haven_screen_bitrate, '300');
  field.value = '99999';
  field.dispatch('keydown', { key: 'Enter' });
  assert.equal(storage.data.haven_screen_bitrate, '0');
  assert.equal(field.value, 'Unlimited');
});

test('bitrate: leaving the field commits once, Escape discards', () => {
  const { host, storage, voice, document } = setup();
  const field = byId(host, 'screen-bitrate-value');
  field.value = '4000';
  field.dispatch('blur');
  assert.equal(storage.data.haven_screen_bitrate, '4000');
  assert.equal(voice.calls.filter((c) => c[0] === 'setScreenBitrate').length, 1);

  field.value = '9000';
  document.activeElement = field;
  field.dispatch('keydown', { key: 'Escape' });
  assert.equal(storage.data.haven_screen_bitrate, '4000', 'Escape did not apply the typed value');
  assert.equal(field.value, '4000 Kbps');
});

test('bitrate: nonsense in the field puts the saved value back', () => {
  const { host, storage } = setup();
  const field = byId(host, 'screen-bitrate-value');
  field.value = 'abc';
  field.dispatch('keydown', { key: 'Enter' });
  assert.equal(storage.data.haven_screen_bitrate, undefined);
  assert.equal(field.value, '8000 Kbps');
});

test('bitrate: the step buttons move 100, wrap to unlimited at the top and back down', () => {
  const { host, storage } = setup({ storage: makeStorage({ haven_screen_bitrate: '9900' }) });
  const plus = host.querySelector('[data-bitrate-step="1"]');
  const minus = host.querySelector('[data-bitrate-step="-1"]');
  plus.dispatch('click', { detail: 0 });
  assert.equal(storage.data.haven_screen_bitrate, '10000');
  plus.dispatch('click', { detail: 0 });
  assert.equal(storage.data.haven_screen_bitrate, '0', 'past the top is unlimited');
  assert.equal(byId(host, 'screen-bitrate-value').value, 'Unlimited');
  minus.dispatch('click', { detail: 0 });
  assert.equal(storage.data.haven_screen_bitrate, '10000');
  plus.dispatch('click', { detail: 0 });
  plus.dispatch('click', { detail: 0 });
  assert.equal(storage.data.haven_screen_bitrate, '300', 'from unlimited, plus starts at the bottom');
});

test('bitrate: holding a step button repeats and stops on release', async () => {
  const { host, storage } = setup({ storage: makeStorage({ haven_screen_bitrate: '5000' }) });
  const plus = host.querySelector('[data-bitrate-step="1"]');
  plus.dispatch('pointerdown', { pointerId: 1 });
  assert.equal(storage.data.haven_screen_bitrate, '5100', 'one step right away');
  await new Promise((r) => setTimeout(r, 560));
  const afterHold = Number(storage.data.haven_screen_bitrate);
  assert.ok(afterHold > 5100, 'the hold kept stepping');
  plus.dispatch('pointerup', { pointerId: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(Number(storage.data.haven_screen_bitrate), afterHold, 'nothing after release');
});

test('bitrate: a second finger is ignored while the first holds', () => {
  const { host, storage } = setup({ storage: makeStorage({ haven_screen_bitrate: '5000' }) });
  const plus = host.querySelector('[data-bitrate-step="1"]');
  plus.dispatch('pointerdown', { pointerId: 1 });
  plus.dispatch('pointerdown', { pointerId: 2 });
  assert.equal(storage.data.haven_screen_bitrate, '5100', 'only one step for two fingers');
  plus.dispatch('pointerup', { pointerId: 2 });
  plus.dispatch('pointerup', { pointerId: 1 });
});

// ── Two copies, device list, destroy ────────────────────────────────────

test('two live copies stay in step in both directions', () => {
  const first = setup();
  const secondHost = first.document.createElement('div');
  first.document.body.appendChild(secondHost);
  createCallSettingsPanel(secondHost, {
    settings: first.settings, devices: first.devices, t: tr, supportsOutputSelection: true,
  });

  const quality = byId(first.host, 'voice-cam-quality');
  const mirror = secondHost.querySelector('[data-setting="cameraQuality"]');
  quality.value = '1080';
  quality.dispatch('change');
  assert.equal(mirror.value, '1080');

  mirror.value = '720';
  mirror.dispatch('change');
  assert.equal(quality.value, '720');
});

test('copies do not loop: one change reaches the voice engine once', () => {
  const { settings, host, voice, document, devices } = setup();
  const otherHost = document.createElement('div');
  document.body.appendChild(otherHost);
  createCallSettingsPanel(otherHost, { settings, devices, t: tr, supportsOutputSelection: true });
  voice.inVoice = true;
  const slider = byId(host, 'voice-ns-slider');
  slider.value = '60';
  slider.dispatch('input');
  assert.equal(voice.calls.filter((c) => c[0] === 'setNoiseSensitivity').length, 1);
});

test('the device list is asked for once however many copies refresh', async () => {
  const { devices, mediaDevices } = setup();
  await Promise.all([devices.refresh(), devices.refresh(), devices.refresh()]);
  assert.equal(mediaDevices.stats.getUserMedia, 1, 'the mic opened once, for the names');
  assert.equal(mediaDevices.stats.stopped, 1, 'and was closed again');
  assert.equal(mediaDevices.stats.enumerate, 2, 'one pass before the names, one after');
});

test('device options fill in every copy when the list arrives, and keep the saved choice', async () => {
  const storage = makeStorage({ haven_input_device: 'mic-a', haven_cam_device: 'cam-a' });
  const { host, devices } = setup({ storage });
  await devices.refresh();
  const input = byId(host, 'voice-input-device');
  assert.deepEqual(input.options.map((o) => o.textContent), ['Default Microphone', 'Desk Mic', 'Microphone 2']);
  assert.equal(input.value, 'mic-a');
  assert.equal(byId(host, 'voice-cam-device').value, 'cam-a');
  assert.deepEqual(byId(host, 'voice-output-device').options.map((o) => o.textContent), ['Default Speaker', 'Headset']);
});

test('a saved device that is not plugged in shows the default entry, not a blank picker', async () => {
  const storage = makeStorage({ haven_input_device: 'mic-gone', haven_cam_device: 'cam-a' });
  const { host, devices, settings } = setup({ storage });
  const input = byId(host, 'voice-input-device');
  const camera = byId(host, 'voice-cam-device');
  // Before the list arrives only the default entry exists.
  assert.equal(input.selectedIndex, 0);
  assert.equal(camera.selectedIndex, 0);
  await devices.refresh();
  assert.equal(input.selectedIndex, 0, 'the unplugged mic falls back to the default entry');
  assert.equal(camera.value, 'cam-a');
  assert.equal(settings.get('inputDevice'), 'mic-gone', 'the saved choice is kept for when it comes back');
  settings.set('cameraDevice', 'cam-gone');
  assert.equal(camera.selectedIndex, 0);
});

test('a refused microphone still lists devices, without names', async () => {
  const media = fakeMediaDevices();
  media.getUserMedia = async () => { throw new Error('denied'); };
  const devices = createDeviceList({ mediaDevices: media });
  const list = await devices.refresh();
  assert.equal(list.inputs.length, 2);
});

test('an output picker is disabled with a hint where the browser cannot switch outputs', () => {
  const { host } = setup({ extra: { supportsOutputSelection: false } });
  const output = byId(host, 'voice-output-device');
  assert.equal(output.disabled, true);
  assert.equal(output.title, en.voice_settings.output_unsupported_title);
  assert.ok(byId(host, 'voice-output-unsupported-hint'));
});

test('the mic meter loop runs only while visible and stops with destroy', () => {
  const frames = [];
  let nextId = 1;
  const cancelled = [];
  let observerCallback = null;
  let disconnected = false;
  class FakeObserver {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  let level = 30;
  const { host, panel } = setup({
    extra: {
      IntersectionObserver: FakeObserver,
      requestAnimationFrame: (fn) => { const id = nextId++; frames.push({ id, fn }); return id; },
      cancelAnimationFrame: (id) => cancelled.push(id),
      getMicLevel: () => level,
    },
  });
  const fill = byId(host, 'mic-meter-fill');
  assert.equal(frames.length, 0, 'no loop while off screen');

  observerCallback([{ isIntersecting: true }]);
  assert.equal(frames.length, 1);
  frames.shift().fn();
  assert.equal(fill.style.width, '30%');
  level = 30.4;
  frames.shift().fn();
  assert.equal(fill.style.width, '30%', 'whole percents only');

  observerCallback([{ isIntersecting: false }]);
  assert.equal(cancelled.length, 1);
  assert.equal(fill.style.width, '0%');

  observerCallback([{ isIntersecting: true }]);
  panel.destroy();
  assert.equal(disconnected, true);
  assert.equal(cancelled.length, 2, 'the running loop was cancelled');
});

test('destroy removes every listener it added and empties the host', () => {
  const { host, panel, settings } = setup();
  const nodes = [host, ...host.querySelectorAll('*')];
  assert.ok(nodes.some((n) => n.listenerCount() > 0));
  panel.destroy();
  assert.equal(host.childNodes.length, 0);
  assert.equal(nodes.reduce((sum, n) => sum + n.listenerCount(), 0), 0, 'no listeners left');
  assert.doesNotThrow(() => settings.set('noiseMode', 'off'));
  assert.doesNotThrow(() => panel.destroy(), 'destroy twice is fine');
});

test('destroy stops a bitrate hold in progress', async () => {
  const { host, panel, storage } = setup({ storage: makeStorage({ haven_screen_bitrate: '5000' }) });
  host.querySelector('[data-bitrate-step="1"]').dispatch('pointerdown', { pointerId: 1 });
  panel.destroy();
  const after = storage.data.haven_screen_bitrate;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(storage.data.haven_screen_bitrate, after);
});

test('a settings change after destroy does not reach the removed controls', () => {
  const { host, panel, settings } = setup();
  const quality = byId(host, 'voice-cam-quality');
  panel.destroy();
  settings.set('cameraQuality', '1080');
  assert.notEqual(quality.value, '1080');
});

// ── The sidebar mount ───────────────────────────────────────────────────

test('the app mounts the sidebar panel into #voice-settings-panel and keeps the region attribute', async () => {
  const Methods = (await load('public/js/modules/app-call-settings.js')).default;
  const doc = makeDocument();
  const host = doc.createElement('div');
  host.setAttribute('id', 'voice-settings-panel');
  host.setAttribute('data-haven-region', 'voice-settings');
  doc.body.appendChild(host);
  const storage = makeStorage();
  const app = Object.assign({ voice: makeVoice() }, Methods);
  app.callSettings = createCallSettings({ storage, getVoice: () => app.voice });
  globalThis.document = doc;
  globalThis.t = tr;
  try {
    app._mountVoiceSettingsPanel();
    assert.ok(app.callSettingsDevices.refresh, 'shared device list exists');
    assert.equal(host.getAttribute('data-haven-region'), 'voice-settings');
    assert.equal(host.getAttribute('id'), 'voice-settings-panel');
    assert.ok(doc.getElementById('voice-noise-mode'));
    // mounting again replaces the panel instead of stacking a second one
    app._mountVoiceSettingsPanel();
    assert.equal(host.querySelectorAll('#voice-noise-mode').length, 1);
    app.voiceSettingsPanel.destroy();
  } finally {
    delete globalThis.document;
    delete globalThis.t;
  }
});

// ── The fullscreen call popup ───────────────────────────────────────────

// The popup's open and close methods from app-screen-webcam.js, loaded the
// way the app's own tests load it (that file cannot use import).
function loadScreenWebcamMethods(document) {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-screen-webcam.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, document, t: tr, setTimeout, clearTimeout });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-screen-webcam.js' });
  return context.module.exports;
}

async function setupSidebarAndPopup() {
  const Methods = (await load('public/js/modules/app-call-settings.js')).default;
  const doc = makeDocument();
  const sidebar = doc.createElement('div');
  sidebar.setAttribute('id', 'voice-settings-panel');
  doc.body.appendChild(sidebar);
  const tile = doc.createElement('div');
  const popover = doc.createElement('div');
  popover.className = 'fullscreen-audio-popover';
  popover.hidden = true;
  const trigger = doc.createElement('button');
  tile.append(trigger, popover);
  doc.body.appendChild(tile);
  const storage = makeStorage();
  const voice = makeVoice();
  const screen = loadScreenWebcamMethods(doc);
  const app = Object.assign({ voice }, Methods, {
    _toggleFullscreenAudioPopover: screen._toggleFullscreenAudioPopover,
    _closeFullscreenPopover: screen._closeFullscreenPopover,
    _watchFullscreenPopoverOutside: screen._watchFullscreenPopoverOutside,
  });
  app.callSettings = createCallSettings({ storage, getVoice: () => voice });
  globalThis.document = doc;
  globalThis.t = tr;
  app._mountVoiceSettingsPanel();
  const open = () => app._toggleFullscreenAudioPopover(tile, popover, trigger);
  const close = () => app._closeFullscreenPopover(tile, popover, trigger);
  const done = () => { app.voiceSettingsPanel.destroy(); delete globalThis.document; delete globalThis.t; };
  return { app, doc, sidebar, popover, tile, trigger, storage, voice, open, close, done };
}

const inPopup = (popover, setting) => popover.querySelector(`[data-setting="${setting}"]`);

test('the popup holds every call setting plus the voice volume, with no element ids', async () => {
  const { doc, popover, open, done } = await setupSidebarAndPopup();
  try {
    open();
    const shown = new Set(popover.querySelectorAll('[data-setting]').map((n) => n.getAttribute('data-setting')));
    const { CALL_SETTING_KEYS } = await load('public/js/modules/call-settings.js');
    assert.deepEqual([...shown].sort(), Object.keys(CALL_SETTING_KEYS).sort());
    assert.equal(popover.querySelectorAll('[id]').length, 0);
    const ids = [doc.body, ...doc.body.querySelectorAll('*')].map((n) => n.getAttribute('id')).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'no id appears twice with both copies mounted');
    for (const control of popover.querySelectorAll('select, input')) {
      assert.ok(control.getAttribute('aria-label'), `${control.getAttribute('data-setting')} has a name`);
    }
  } finally { done(); }
});

test('the sidebar and the popup stay in step in both directions', async () => {
  const { doc, popover, open, storage, voice, done } = await setupSidebarAndPopup();
  try {
    open();
    const popupMode = inPopup(popover, 'noiseMode');
    popupMode.value = 'off';
    popupMode.dispatch('change');
    assert.equal(doc.getElementById('voice-noise-mode').value, 'off');
    assert.equal(doc.getElementById('noise-gate-row').style.display, 'none');

    const sidebarFps = doc.getElementById('screen-fps-select');
    sidebarFps.value = '60';
    sidebarFps.dispatch('change');
    assert.equal(inPopup(popover, 'screenFrameRate').value, '60');
    assert.equal(voice.calls.filter(([name]) => name === 'setScreenFrameRate').length, 1, 'applied once, no loop');

    const volume = inPopup(popover, 'voiceVolume');
    assert.equal(volume.value, '100');
    volume.value = '150';
    volume.dispatch('input');
    assert.equal(storage.data.haven_voice_master_volume, '1.5');
    assert.deepEqual(voice.calls.at(-1), ['setVoiceMasterVolume', 1.5]);
  } finally { done(); }
});

test('closing the popup leaves no listeners, subscriptions or meter loop behind', async () => {
  const frames = new Set();
  let nextFrame = 1;
  globalThis.requestAnimationFrame = () => { const id = nextFrame++; frames.add(id); return id; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const { app, doc, popover, open, close, done } = await setupSidebarAndPopup();
  try {
    const sidebarFrames = frames.size;
    open();
    assert.equal(frames.size, sidebarFrames + 1, 'the popup meter runs while open');
    assert.equal((doc.listeners.pointerdown || []).length, 1, 'a click outside is watched while open');
    const nodes = popover.querySelectorAll('*');
    close();
    assert.equal((doc.listeners.pointerdown || []).length, 0, 'and no longer once closed');
    assert.equal(frames.size, sidebarFrames, 'its loop is cancelled on close');
    assert.equal(popover.childNodes.length, 0);
    assert.equal(nodes.reduce((sum, n) => sum + n.listenerCount(), 0), 0);
    assert.equal(popover._callSettingsPanel, null);
    assert.doesNotThrow(() => app.callSettings.set('noiseMode', 'suppress'));
    assert.doesNotThrow(close, 'closing twice is fine');
  } finally {
    done();
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

test('reopening the popup builds one copy, not a second one on top', async () => {
  const { popover, open, close, done } = await setupSidebarAndPopup();
  try {
    open(); close(); open();
    assert.equal(popover.querySelectorAll('[data-setting="noiseMode"]').length, 1);
  } finally { done(); }
});

test('the sidebar markup is an empty host: the builder is the only source of the controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  const start = html.indexOf('id="voice-settings-panel"');
  const end = html.indexOf('Voice controls bar (pinned above settings)');
  const block = html.slice(start, end);
  assert.ok(!/<select|<input|<button/.test(block), 'no hand-written controls left');
  assert.match(html.slice(start - 10, start + 200), /data-haven-region="voice-settings"/);
});

test('other app modules no longer reach for the panel controls by id', () => {
  for (const file of ['app-voice-controls.js', 'app-voice.js', 'app-screen-webcam.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/modules', file), 'utf8');
    for (const id of ['voice-ns-slider', 'voice-noise-mode', 'screen-res-select', 'screen-fps-select',
      'screen-bitrate-value', 'mic-meter-fill', 'noise-gate-row', 'voice-cam-quality']) {
      assert.ok(!src.includes(`'${id}'`), `${file} still looks up #${id}`);
    }
  }
});
