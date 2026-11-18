'use strict';

/**
 * Fullscreen call controls: the toolbar and stream picker drawn over a camera
 * or screen-share tile in fullscreen, and how they follow Haven's existing
 * voice actions and the tile's lifecycle.
 *
 *   node --test test/appFullscreenCallControls.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-screen-webcam.js'),
  'utf8'
);
const voiceSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-voice.js'),
  'utf8'
);
const voiceControlsSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-voice-controls.js'),
  'utf8'
);
const masterVolumeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-master-volume.js'),
  'utf8'
);
const streamTilesSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-stream-tiles.js'),
  'utf8'
);

function makeClassList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
    toggle(value, force) {
      const shouldAdd = force === undefined ? !values.has(value) : force;
      if (shouldAdd) values.add(value);
      else values.delete(value);
      return shouldAdd;
    },
  };
}

function makeVideoTrack() {
  const listeners = {};
  return {
    readyState: 'live',
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) { listeners[type] = (listeners[type] || []).filter(item => item !== listener); },
    end() {
      this.readyState = 'ended';
      (listeners.ended || []).forEach(listener => listener());
    },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.classList = makeClassList();
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.parentNode = null;
    this.srcObject = null;
    this.attributes = {};
  }

  get options() {
    return this.children;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    children.forEach(child => this.appendChild(child));
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName);
    ['id', 'className', 'title', 'textContent', 'value', 'disabled', 'type', 'min', 'max', 'selected'].forEach(key => {
      if (this[key] !== undefined) clone[key] = this[key];
    });
    clone.dataset = { ...this.dataset };
    clone.attributes = { ...this.attributes };
    if (deep) this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
    return clone;
  }

  matches(selector) {
    if (selector === ':hover') return !!this.hovered;
    const attribute = selector.match(/^([a-z]+)?\[data-([a-z-]+)\]$/i);
    if (attribute) {
      const key = attribute[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return (!attribute[1] || this.tagName === attribute[1]) && this.dataset[key] !== undefined;
    }
    if (selector[0] === '.') return (this.className || '').split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map(item => item.trim());
    const found = [];
    for (const child of this.children) {
      if (selectors.some(part => child.matches(part))) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  focus() {}

  play() {
    return Promise.resolve();
  }
}

function loadMethods(globals) {
  const context = vm.createContext({
    module: { exports: {} },
    t: key => key,
    setTimeout: () => 0,
    clearTimeout: () => {},
    ...globals,
  });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, {
    filename: 'app-screen-webcam.js',
  });
  return context.module.exports;
}

function loadVoiceMethods(document) {
  const context = vm.createContext({ module: { exports: {} }, document, t: key => key });
  vm.runInContext(voiceSource.replace(/^export default/m, 'module.exports ='), context, {
    filename: 'app-voice.js',
  });
  return context.module.exports;
}

function loadVoiceControlMethods(document, localStorage) {
  const context = vm.createContext({ module: { exports: {} }, document, localStorage, t: key => key });
  vm.runInContext(voiceControlsSource.replace(/^export default/m, 'module.exports ='), context, {
    filename: 'app-voice-controls.js',
  });
  return context.module.exports;
}

function loadMasterVolumeMethods(document, localStorage) {
  const context = vm.createContext({ module: { exports: {} }, document, localStorage, t: key => key });
  vm.runInContext(masterVolumeSource.replace(/^export default/m, 'module.exports ='), context, {
    filename: 'app-master-volume.js',
  });
  return context.module.exports;
}

function loadStreamTileMethods(document) {
  const context = vm.createContext({ module: { exports: {} }, document, t: key => key });
  vm.runInContext(streamTilesSource.replace(/^export default/m, 'module.exports ='), context, {
    filename: 'app-stream-tiles.js',
  });
  return context.module.exports;
}

function renderWebcamTile(globals = {}) {
  const container = new FakeElement('div');
  const grid = new FakeElement('div');
  const label = new FakeElement('div');
  const masterVolume = new FakeElement('input');
  masterVolume.value = '100';
  const cameraButton = new FakeElement('button');
  const inputDevice = new FakeElement('select');
  const cameraDevice = new FakeElement('select');
  const outputDevice = new FakeElement('select');
  const addOption = (select, value, text) => {
    const option = new FakeElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  };
  addOption(inputDevice, '', 'Default microphone');
  addOption(inputDevice, 'mic-2', 'USB microphone');
  inputDevice.value = 'mic-2';
  addOption(cameraDevice, '', 'Default camera');
  addOption(cameraDevice, 'camera-4', 'USB camera');
  cameraDevice.value = 'camera-4';
  addOption(outputDevice, '', 'Default speaker');
  addOption(outputDevice, 'speaker-3', 'USB speaker');
  outputDevice.value = 'speaker-3';
  outputDevice.disabled = true;
  outputDevice.title = 'Output selection is unsupported';
  const elements = new Map([
    ['webcam-container', container],
    ['webcam-grid', grid],
    ['webcam-label', label],
    ['voice-master-volume', masterVolume],
    ['voice-cam-btn', cameraButton],
    ['voice-input-device', inputDevice],
    ['voice-cam-device', cameraDevice],
    ['voice-output-device', outputDevice],
  ]);
  const documentListeners = {};
  const document = {
    fullscreenElement: null,
    createElement: tag => new FakeElement(tag),
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
    addEventListener: (type, listener) => { (documentListeners[type] ||= []).push(listener); },
    dispatch: type => (documentListeners[type] || []).forEach(listener => listener()),
  };
  const localStorage = { getItem: () => null, setItem() {} };
  const methods = loadMethods({
    document,
    localStorage,
    ...globals,
  });
  const voiceMethods = loadVoiceMethods(document);
  const voiceControlMethods = loadVoiceControlMethods(document, localStorage);
  const app = Object.assign({
    user: { id: 'self' },
    voice: { peerName: () => 'Participant', inVoice: true, currentChannel: 'room' },
    socket: { emit() {} },
    channels: [{ code: 'room', streams_enabled: 1 }],
    _showToast() {},
    _updateWebcamVisibility: methods._updateWebcamVisibility,
  }, methods, voiceMethods, voiceControlMethods);
  app._populateAudioDevices = async () => {};
  const stream = { id: 'camera-stream' };
  app._handleWebcamStream('peer-1', stream);
  const tile = grid.children[0];
  elements.set('webcam-tile-peer-1', tile);
  return { app, document, tile, stream, masterVolume };
}

function renderScreenShareTile() {
  const container = new FakeElement('div');
  const grid = new FakeElement('div');
  const label = new FakeElement('div');
  const elements = new Map([
    ['screen-share-container', container],
    ['screen-share-grid', grid],
    ['screen-share-label', label],
  ]);
  const documentListeners = {};
  const document = {
    fullscreenElement: null,
    createElement: tag => new FakeElement(tag),
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
    addEventListener: (type, listener) => { (documentListeners[type] ||= []).push(listener); },
    dispatch: type => (documentListeners[type] || []).forEach(listener => listener()),
  };
  const methods = loadMethods({
    document,
    localStorage: { getItem: () => null },
  });
  const app = Object.assign({
    user: { id: 'self' },
    voice: { inVoice: false, peerName: () => 'Participant' },
    _startStreamStallWatchdog() {},
    _updateHiddenStreamsBar() {},
    _removeScreenShareIndicator() {},
    _updateScreenShareVisibility() {},
  }, methods);
  app._startStreamStallWatchdog = () => {};
  const stream = {
    getVideoTracks: () => [{ readyState: 'live' }],
  };
  app._handleScreenStream('peer-1', stream);
  const tile = grid.children[0];
  return { document, tile };
}

function renderBothMediaTiles({ localCamera = false } = {}) {
  const webcamContainer = new FakeElement('div');
  const webcamGrid = new FakeElement('div');
  const webcamLabel = new FakeElement('div');
  const screenContainer = new FakeElement('div');
  const screenGrid = new FakeElement('div');
  const screenLabel = new FakeElement('div');
  const elements = new Map([
    ['webcam-container', webcamContainer], ['webcam-grid', webcamGrid], ['webcam-label', webcamLabel],
    ['screen-share-container', screenContainer], ['screen-share-grid', screenGrid], ['screen-share-label', screenLabel],
  ]);
  const documentListeners = {};
  const roots = [webcamGrid, screenGrid];
  const document = {
    fullscreenElement: null,
    createElement: tag => new FakeElement(tag),
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => roots.flatMap(root => root.querySelectorAll(selector)),
    addEventListener: (type, listener) => { (documentListeners[type] ||= []).push(listener); },
    dispatch: type => (documentListeners[type] || []).forEach(listener => listener()),
  };
  const methods = loadMethods({ document, localStorage: { getItem: () => null } });
  const voice = { inVoice: true, currentChannel: 'room', peerName: () => 'Participant' };
  const app = Object.assign({
    user: { id: localCamera ? 'peer-1' : 'self' },
    voice,
    socket: { emit() {} },
    channels: [{ code: 'room', streams_enabled: 1 }],
    _startStreamStallWatchdog() {},
    _updateHiddenStreamsBar() {},
    _removeScreenShareIndicator() {},
    _updateScreenShareVisibility() {},
  }, methods, loadVoiceMethods(document));
  app._startStreamStallWatchdog = () => {};
  const cameraTrack = makeVideoTrack();
  const shareTrack = makeVideoTrack();
  const cameraStream = { getVideoTracks: () => [cameraTrack] };
  const shareStream = { getVideoTracks: () => [shareTrack] };
  app._handleWebcamStream('peer-1', cameraStream);
  const cameraTile = webcamGrid.children[0];
  elements.set(cameraTile.id, cameraTile);
  app._handleScreenStream('peer-1', shareStream);
  const shareTile = screenGrid.children[0];
  elements.set(shareTile.id, shareTile);
  app._refreshFullscreenStreamPicker?.();
  return { app, document, cameraTile, shareTile, webcamContainer, cameraStream, shareStream, cameraTrack, shareTrack };
}

function streamChoices(tile) {
  return tile.querySelectorAll('.fullscreen-stream-option');
}

function streamChoiceValues(tile) {
  return streamChoices(tile).map(box => box.value);
}

function streamChoiceLabels(tile) {
  return tile.querySelectorAll('.fullscreen-stream-choice-label').map(label => label.textContent);
}

function setStreamShown(tile, sourceTileId, shown) {
  const box = streamChoices(tile).find(item => item.value === sourceTileId);
  assert.ok(box, `${sourceTileId} is offered in the stream list`);
  box.checked = shown;
  box.listeners.change[0]({ stopPropagation() {} });
}

// The old single-stream picker as a checklist: tick the stream, untick the rest.
function showOnlyStream(tile, sourceTile) {
  setStreamShown(tile, sourceTile.id, true);
  for (const box of streamChoices(tile)) {
    if (box.value !== sourceTile.id && box.checked) setStreamShown(tile, box.value, false);
  }
}

test('the webcam fullscreen button requests fullscreen on its tile wrapper', () => {
  const { document, tile } = renderWebcamTile();
  let fullscreenTarget = null;
  tile.requestFullscreen = () => {
    fullscreenTarget = tile;
    return Promise.resolve();
  };
  const video = tile.querySelector('video');
  video.requestFullscreen = () => {
    fullscreenTarget = video;
    return Promise.resolve();
  };

  const button = tile.querySelector('.stream-fullscreen-btn');
  assert.ok(button, 'the rendered tile has a fullscreen button');
  button.listeners.click[0]({ stopPropagation() {} });

  assert.equal(fullscreenTarget, tile);
  assert.equal(document.fullscreenElement, null);
});

test('the fullscreen toolbar follows browser fullscreen entry and exit', () => {
  const { document, tile } = renderWebcamTile();
  const toolbar = tile.querySelector('.fullscreen-call-toolbar');
  assert.ok(toolbar, 'the toolbar is inside the fullscreen tile wrapper');
  assert.equal(toolbar.hidden, true);

  const button = tile.querySelector('.stream-fullscreen-btn');
  tile.requestFullscreen = () => {
    document.fullscreenElement = tile;
    return Promise.resolve();
  };
  button.listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
  assert.equal(toolbar.hidden, false);
  assert.equal(tile.classList.contains('is-fullscreen'), true);

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(toolbar.hidden, true);
  assert.equal(tile.classList.contains('is-fullscreen'), false);
});

test('fullscreen call controls render in the same sequence as the regular voice toolbar', () => {
  const { cameraTile } = renderBothMediaTiles();
  const toolbar = cameraTile.querySelector('.fullscreen-call-toolbar');
  const controls = Array.from(toolbar.children)
    .filter(child => child.className.split(/\s+/).includes('fullscreen-call-control'))
    .map(child => child.className.split(/\s+/).find(name => name.startsWith('fullscreen-call-') && name !== 'fullscreen-call-control'));

  assert.deepEqual(controls, [
    'fullscreen-call-mute',
    'fullscreen-call-deafen',
    'fullscreen-call-camera',
    'fullscreen-call-share',
    'fullscreen-call-streams',
    'fullscreen-call-audio',
    'fullscreen-call-leave',
    'fullscreen-call-exit',
  ]);
});

test('fullscreen leave control uses the red-circle X icon', () => {
  const { tile } = renderWebcamTile();
  assert.equal(tile.querySelector('.fullscreen-call-leave').textContent, '✕');
});

test('fullscreen exit control keeps the square fullscreen icon', () => {
  const { tile } = renderWebcamTile();
  assert.equal(tile.querySelector('.fullscreen-call-exit').textContent, '⛶');
});

test('fullscreen controls auto-hide over the video and reveal on touch or toolbar hover', () => {
  const timers = [];
  const { app, document, tile } = renderWebcamTile({
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {},
  });
  const toolbar = tile.querySelector('.fullscreen-call-toolbar');
  tile.requestFullscreen = () => {
    document.fullscreenElement = tile;
    return Promise.resolve();
  };
  tile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');

  tile.hovered = true;
  toolbar.hovered = false;
  timers.at(-1)();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), true);

  toolbar.hovered = true;
  tile.listeners.mousemove[0]();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false);
  timers.at(-1)();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false);

  toolbar.hovered = false;
  tile.listeners.touchstart[0]();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false);
});

test('the fullscreen microphone control delegates to the existing mute action', () => {
  const { app, tile } = renderWebcamTile();
  let muteCalls = 0;
  app._toggleMute = () => { muteCalls++; };
  const button = tile.querySelector('.fullscreen-call-mute');
  assert.ok(button, 'the fullscreen toolbar has a microphone control');
  let propagationStopped = false;
  button.listeners.click[0]({ stopPropagation: () => { propagationStopped = true; } });
  assert.equal(muteCalls, 1);
  assert.equal(propagationStopped, true);
});

test('the fullscreen speaker control delegates to Haven deafen and reflects its state', () => {
  const { app, tile } = renderWebcamTile();
  let deafenCalls = 0;
  app.voice.isDeafened = false;
  app._toggleDeafen = () => {
    deafenCalls++;
    app.voice.isDeafened = true;
    app._syncFullscreenCallControls();
  };
  const deafen = tile.querySelector('.fullscreen-call-deafen');

  deafen.listeners.click[0]({ stopPropagation() {} });

  assert.equal(deafenCalls, 1);
  assert.equal(deafen.classList.contains('deafened'), true);
  assert.equal(deafen.attributes['aria-pressed'], 'true');
});

test('fullscreen controls reconcile after the shared voice UI state changes', () => {
  const { app, tile } = renderWebcamTile();
  const mute = tile.querySelector('.fullscreen-call-mute');
  const camera = tile.querySelector('.fullscreen-call-camera');
  const share = tile.querySelector('.fullscreen-call-share');

  app.voice.isMuted = true;
  app.voice.isWebcamActive = true;
  app.voice.isScreenSharing = true;
  app.channels[0].streams_enabled = 0;
  app._syncMuteDeafenButtons();
  app._applyVoiceRoomLimits();

  assert.equal(mute.attributes['aria-pressed'], 'true');
  assert.equal(mute.classList.contains('muted'), true);
  assert.equal(camera.classList.contains('sharing'), true);
  assert.equal(share.classList.contains('sharing'), true);
  assert.equal(camera.disabled, true);
  assert.equal(share.disabled, true);
});

test('the screen-share fullscreen button requests fullscreen on its tile wrapper', () => {
  const { tile } = renderScreenShareTile();
  let fullscreenTarget = null;
  tile.requestFullscreen = () => {
    fullscreenTarget = tile;
    return Promise.resolve();
  };
  const video = tile.querySelector('video');
  video.requestFullscreen = () => {
    fullscreenTarget = video;
    return Promise.resolve();
  };

  const button = tile.querySelector('.stream-fullscreen-btn');
  assert.ok(button, 'the rendered tile has a fullscreen button');
  button.listeners.click[0]({ stopPropagation() {} });

  assert.equal(fullscreenTarget, tile);
});

test('the fullscreen stream picker keeps one participant camera and share as separate live options', () => {
  const { app, cameraTile, shareTile } = renderBothMediaTiles();
  const fsTile = cameraTile;
  const pickerButton = cameraTile.querySelector('.fullscreen-call-streams');
  assert.ok(pickerButton, 'each fullscreen toolbar has a stream picker');
  assert.equal(pickerButton.attributes['aria-label'], 'voice_runtime.streams');
  assert.equal(cameraTile.querySelector('.fullscreen-stream-popover').attributes['aria-label'], 'voice_runtime.streams');
  assert.deepEqual(streamChoiceLabels(fsTile), [
    'Participant · voice.panel.camera',
    'Participant · voice.screen_share',
  ]);
  assert.deepEqual(streamChoiceValues(fsTile), [cameraTile.id, shareTile.id]);
  assert.equal(app.voice.inVoice, true);
});

test('switching a mirrored fullscreen camera to a screen share clears the mirror transform', () => {
  const { document, cameraTile, shareTile, cameraStream, shareStream } = renderBothMediaTiles({ localCamera: true });
  const cameraVideo = cameraTile.querySelector('video');
  assert.equal(cameraVideo.style.transform, 'scaleX(-1)');
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');

  const fsTile = cameraTile;
  showOnlyStream(fsTile, shareTile);

  assert.equal(cameraVideo.srcObject, shareStream);
  assert.equal(cameraVideo.style.transform, '', 'the screen share should not inherit the camera mirror');

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');

  assert.equal(cameraVideo.srcObject, cameraStream);
  assert.equal(cameraVideo.style.transform, 'scaleX(-1)', 'the camera mirror should be restored with the original source');
});

test('the fullscreen stream label follows the selected source and restores on exit', () => {
  const { app, document, cameraTile, shareTile } = renderBothMediaTiles();
  const cameraLabel = cameraTile.querySelector('.webcam-tile-label');
  const originalLabel = cameraLabel.textContent;
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');

  const fsTile = cameraTile;
  showOnlyStream(fsTile, shareTile);

  assert.equal(cameraLabel.textContent, 'Participant · voice.screen_share');
  app._refreshFullscreenStreamPicker();
  assert.deepEqual(streamChoiceLabels(fsTile), [
    'Participant · voice.panel.camera',
    'Participant · voice.screen_share',
  ]);

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(cameraLabel.textContent, originalLabel);
});

test('fullscreen local stream labels use the account username instead of You', () => {
  const { app, document, cameraTile, shareTile } = renderBothMediaTiles({ localCamera: true });
  app.user.username = 'niko';
  const cameraLabel = cameraTile.querySelector('.webcam-tile-label');
  assert.equal(cameraLabel.textContent, 'voice_runtime.you', 'the ordinary tile keeps its existing label');
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');

  const fsTile = cameraTile;
  assert.deepEqual(streamChoiceLabels(fsTile), [
    'niko · voice.panel.camera',
    'niko · voice.screen_share',
  ]);
  assert.equal(cameraLabel.textContent, 'niko · voice.panel.camera');
  showOnlyStream(fsTile, shareTile);
  assert.equal(cameraLabel.textContent, 'niko · voice.screen_share');

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(cameraLabel.textContent, 'voice_runtime.you');
});

test('switching a fullscreen screen share to the local camera mirrors it and restores the share transform on exit', () => {
  const { document, cameraTile, shareTile, cameraStream, shareStream } = renderBothMediaTiles({ localCamera: true });
  const shareVideo = shareTile.querySelector('video');
  assert.equal(shareVideo.style.transform || '', '');
  shareTile.requestFullscreen = () => {
    document.fullscreenElement = shareTile;
    return Promise.resolve();
  };
  shareTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');

  const fsTile = shareTile;
  showOnlyStream(fsTile, cameraTile);
  assert.equal(shareVideo.srcObject, cameraStream);
  assert.equal(shareVideo.style.transform, 'scaleX(-1)', 'the selected local camera should be mirrored');

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');

  assert.equal(shareVideo.srcObject, shareStream);
  assert.equal(shareVideo.style.transform || '', '', 'the original screen share should no longer be mirrored');
});

test('the fullscreen picker keeps camera labels correct after the wrapper gains fullscreen classes', () => {
  const { app, cameraTile } = renderBothMediaTiles();
  cameraTile.className = 'webcam-tile is-fullscreen fullscreen-controls-idle';

  app._refreshFullscreenStreamPicker();

  assert.equal(streamChoiceLabels(cameraTile)[0], 'Participant · voice.panel.camera');
});

test('the fullscreen picker excludes cameras inside a collapsed webcam container', () => {
  const { app, cameraTile, shareTile, webcamContainer } = renderBothMediaTiles();
  webcamContainer.style.display = 'none';

  app._refreshFullscreenStreamPicker();

  const fsTile = shareTile;
  assert.deepEqual(streamChoiceValues(fsTile), [shareTile.id]);
});

test('the fullscreen stream picker drops a webcam as soon as its tile ends', () => {
  const { app, cameraTile, shareTile } = renderBothMediaTiles();
  const fsTile = shareTile;

  app._handleWebcamStream('peer-1', null);

  assert.deepEqual(streamChoiceValues(fsTile), [shareTile.id]);
});

test('hiding a live screen-share tile immediately removes it from the fullscreen picker', () => {
  const { app, document, cameraTile, shareTile } = renderBothMediaTiles();
  app._hideStreamTile = loadStreamTileMethods(document)._hideStreamTile;
  const fsTile = cameraTile;

  app._hideStreamTile(shareTile, 'peer-1', 'Participant');

  assert.deepEqual(streamChoiceValues(fsTile), [cameraTile.id]);
});

test('hiding the selected source restores another live stream without leaving fullscreen', () => {
  const { app, document, cameraTile, shareTile, cameraStream } = renderBothMediaTiles();
  app._hideStreamTile = loadStreamTileMethods(document)._hideStreamTile;
  const fsTile = cameraTile;
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
  showOnlyStream(fsTile, shareTile);

  app._hideStreamTile(shareTile, 'peer-1', 'Participant');

  assert.equal(document.fullscreenElement, cameraTile);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream);
  assert.deepEqual(streamChoiceValues(fsTile), [cameraTile.id]);
});

test('switching the fullscreen picker rebinds the stable wrapper and restores its original stream on exit', () => {
  const { app, document, cameraTile, shareTile, cameraStream, shareStream } = renderBothMediaTiles();
  const cameraVideo = cameraTile.querySelector('video');
  const fsTile = cameraTile;
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');

  showOnlyStream(fsTile, shareTile);

  assert.equal(document.fullscreenElement, cameraTile);
  assert.equal(cameraVideo.srcObject, shareStream);
  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(cameraVideo.srcObject, cameraStream);
  assert.equal(app.voice.inVoice, true);
});

test('ending the selected source removes its option and restores the still-live source in fullscreen', () => {
  const { app, document, cameraTile, shareTile, cameraStream, shareStream } = renderBothMediaTiles();
  app._cancelScreenNoAudioTimer = () => {};
  app._removeScreenSharePiP = () => {};
  app._stopStreamStallWatchdog = () => {};
  const fsTile = cameraTile;
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
  showOnlyStream(fsTile, shareTile);
  assert.equal(cameraTile.querySelector('video').srcObject, shareStream, 'the selected share is displayed');

  app._handleScreenStream('peer-1', null);

  assert.equal(document.fullscreenElement, cameraTile);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream, 'the original camera stream is restored');
  assert.deepEqual(streamChoiceValues(fsTile), [cameraTile.id]);
});

test('an ended selected video track falls back without moving focus from the picker', () => {
  const { app, document, cameraTile, shareTile, cameraStream, shareTrack } = renderBothMediaTiles();
  const fsTile = cameraTile;
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
  showOnlyStream(fsTile, shareTile);
  const picker = streamChoices(fsTile).find(box => box.value === shareTile.id);
  document.activeElement = picker;

  shareTrack.end();

  assert.equal(document.fullscreenElement, cameraTile);
  assert.equal(document.activeElement, picker);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream);
  assert.deepEqual(streamChoiceValues(fsTile), [cameraTile.id]);
});

test('exiting after the original fullscreen track ends does not leave another participant in that tile', () => {
  const { app, document, cameraTile, shareTile, shareStream, cameraTrack } = renderBothMediaTiles();
  const fsTile = cameraTile;
  cameraTile.requestFullscreen = () => {
    document.fullscreenElement = cameraTile;
    return Promise.resolve();
  };
  cameraTile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
  showOnlyStream(fsTile, shareTile);
  cameraTrack.end();
  assert.equal(cameraTile.querySelector('video').srcObject, shareStream);

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');

  assert.equal(cameraTile.querySelector('video').srcObject, null);
});

test('fullscreen device selectors reuse Haven input, output, and camera switch paths', () => {
  const stored = [];
  const switched = [];
  const localStorage = { setItem: (...args) => stored.push(args) };
  const document = { getElementById: () => null };
  const methods = loadVoiceControlMethods(document, localStorage);
  const app = Object.assign({
    voice: {
      inVoice: true,
      isWebcamActive: true,
      switchInputDevice: id => switched.push(['input', id]),
      switchOutputDevice: id => switched.push(['output', id]),
      switchCamera: id => switched.push(['camera', id]),
    },
  }, methods);

  app._applyVoiceDeviceSelection('input', 'mic-2');
  app._applyVoiceDeviceSelection('output', 'speaker-3');
  app._applyVoiceDeviceSelection('camera', 'camera-4');

  assert.deepEqual(stored, [
    ['haven_input_device', 'mic-2'],
    ['haven_output_device', 'speaker-3'],
    ['haven_cam_device', 'camera-4'],
  ]);
  assert.deepEqual(switched, [
    ['input', 'mic-2'],
    ['output', 'speaker-3'],
    ['camera', 'camera-4'],
  ]);
});

test('the fullscreen audio popover opens and dismisses with Escape', () => {
  const { tile } = renderWebcamTile();
  const toolbar = tile.querySelector('.fullscreen-call-toolbar');
  const trigger = tile.querySelector('.fullscreen-call-audio');
  const popover = tile.querySelector('.fullscreen-audio-popover');
  assert.ok(trigger);
  assert.ok(popover);
  assert.equal(popover.hidden, true);

  trigger.listeners.click[0]({ stopPropagation() {} });
  assert.equal(popover.hidden, false);
  assert.equal(tile.classList.contains('fullscreen-popup-open'), true);
  assert.equal(trigger.attributes['aria-expanded'], 'true');

  toolbar.listeners.keydown[0]({ key: 'Escape', preventDefault() {} });
  assert.equal(popover.hidden, true);
  assert.equal(tile.classList.contains('fullscreen-popup-open'), false);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
});

test('browser fullscreen exit closes the audio popover and resets its trigger', () => {
  const { document, tile } = renderWebcamTile();
  const trigger = tile.querySelector('.fullscreen-call-audio');
  const popover = tile.querySelector('.fullscreen-audio-popover');
  tile.requestFullscreen = () => {
    document.fullscreenElement = tile;
    return Promise.resolve();
  };
  tile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
  trigger.listeners.click[0]({ stopPropagation() {} });

  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');

  assert.equal(popover.hidden, true);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  assert.equal(tile.classList.contains('fullscreen-popup-open'), false);
});

test('fullscreen tile cleanup closes popovers and resets their accessible state', () => {
  const { app, tile } = renderWebcamTile();
  const trigger = tile.querySelector('.fullscreen-call-audio');
  const popover = tile.querySelector('.fullscreen-audio-popover');
  trigger.listeners.click[0]({ stopPropagation() {} });

  app._handleFullscreenTileRemoval(tile);

  assert.equal(popover.hidden, true);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  assert.equal(tile.classList.contains('fullscreen-popup-open'), false);
});

test('the fullscreen master-volume control follows changes from voice settings', async () => {
  const { app, document, masterVolume, tile } = renderWebcamTile();
  let level = 1;
  const updates = [];
  app.voice._voiceMasterLevel = () => level;
  app.voice.setVoiceMasterVolume = value => { level = value; updates.push(value); };
  app._setupMasterVolume = loadMasterVolumeMethods(document, { getItem: () => null })._setupMasterVolume;
  app._setupMasterVolume();
  tile.querySelector('.fullscreen-call-audio').listeners.click[0]({ stopPropagation() {} });
  await Promise.resolve();
  app._syncFullscreenCallVolume();
  const popoverVolume = tile.querySelector('.fullscreen-call-volume');
  assert.equal(popoverVolume.value, '100');

  masterVolume.value = '145';
  masterVolume.listeners.input[0]();

  assert.equal(updates[0], 1.45);
  assert.equal(popoverVolume.value, '145');
});

test('the fullscreen audio popover mirrors device options and preserves unsupported output state', async () => {
  const { app, tile } = renderWebcamTile();
  const selections = [];
  app._applyVoiceDeviceSelection = (kind, value) => selections.push([kind, value]);
  const popover = tile.querySelector('.fullscreen-audio-popover');

  await app._populateFullscreenAudioPopover(popover);

  const microphone = popover.querySelector('select[data-device-kind]');
  const speaker = popover.querySelectorAll('select[data-device-kind]')[2];
  assert.equal(microphone.value, 'mic-2');
  assert.deepEqual(microphone.children.map(option => option.textContent), ['Default microphone', 'USB microphone']);
  assert.equal(speaker.disabled, true);
  assert.equal(speaker.title, 'Output selection is unsupported');

  microphone.value = 'mic-next';
  microphone.listeners.change[0]({ stopPropagation() {} });
  assert.deepEqual(selections, [['input', 'mic-next']]);
});

test('the fullscreen camera control reflects a camera started through the existing action', async () => {
  const { app, tile } = renderWebcamTile();
  app._showToast = () => {};
  app._handleWebcamStream = () => {};
  app.voice.startWebcam = async () => {
    app.voice.isWebcamActive = true;
    app.voice.webcamStream = { id: 'local-camera' };
    return true;
  };

  const camera = tile.querySelector('.fullscreen-call-camera');
  await camera.listeners.click[0]({ stopPropagation() {} });
  await Promise.resolve();

  assert.equal(camera.classList.contains('sharing'), true);
  assert.equal(camera.attributes['aria-pressed'], 'true');
});

test('canceling screen capture through the fullscreen share control leaves sharing inactive', async () => {
  const { app, tile } = renderWebcamTile();
  const emitted = [];
  app.socket.emit = (...args) => emitted.push(args);
  app.voice.isScreenSharing = false;
  app.voice.shareScreen = async () => false;
  const share = tile.querySelector('.fullscreen-call-share');

  await share.listeners.click[0]({ stopPropagation() {} });

  assert.equal(app.voice.isScreenSharing, false);
  assert.equal(share.classList.contains('sharing'), false);
  assert.equal(share.attributes['aria-pressed'], 'false');
  assert.deepEqual(emitted, []);
});

test('leaving voice clears fullscreen controls through the existing local leave action', () => {
  let leaveCalls = 0;
  let fullscreenCleanupCalls = 0;
  const document = { getElementById: () => null };
  const app = Object.assign({
    voice: { currentChannel: 'room', leave: () => { leaveCalls++; } },
    notifications: { playDirect() {} },
    voiceCounts: { room: 1 },
    voiceChannelUsers: { room: [] },
    currentChannel: 'room',
    _updateVoiceButtons() {},
    _updateVoiceStatus() {},
    _updateVoiceBar() {},
    _hideMusicPanel() {},
    _renderVoiceUsers() {},
    _updateChannelVoiceIndicators() {},
    _showToast() {},
    _cleanupFullscreenCallTiles: () => { fullscreenCleanupCalls++; },
  }, loadVoiceMethods(document));
  app._updateVoiceButtons = () => {};
  app._updateVoiceStatus = () => {};
  app._updateVoiceBar = () => {};

  app._leaveVoice();

  assert.equal(leaveCalls, 1);
  assert.equal(fullscreenCleanupCalls, 1);
});

function enterFullscreen(document, tile) {
  tile.requestFullscreen = () => {
    document.fullscreenElement = tile;
    return Promise.resolve();
  };
  tile.querySelector('.stream-fullscreen-btn').listeners.click[0]({ stopPropagation() {} });
  document.dispatch('fullscreenchange');
}

function leaveFullscreen(document) {
  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
}

test('repeated fullscreen change events do not stack the stream label or reset the chosen source', () => {
  const { document, cameraTile, shareTile, cameraStream } = renderBothMediaTiles();
  const cameraLabel = cameraTile.querySelector('.webcam-tile-label');
  const original = cameraLabel.textContent;
  enterFullscreen(document, cameraTile);
  document.dispatch('fullscreenchange');
  document.dispatch('fullscreenchange');
  assert.equal(cameraLabel.textContent, `${original} · voice.panel.camera`);

  const fsTile = cameraTile;
  showOnlyStream(fsTile, shareTile);
  document.dispatch('fullscreenchange');
  assert.equal(cameraLabel.textContent, `${original} · voice.screen_share`);

  leaveFullscreen(document);
  assert.equal(cameraLabel.textContent, original);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream);
});

test('closing the fullscreen tile puts its label and fullscreen state back', () => {
  const { app, document, cameraTile } = renderBothMediaTiles();
  const label = cameraTile.querySelector('.webcam-tile-label');
  const original = label.textContent;
  enterFullscreen(document, cameraTile);
  assert.notEqual(label.textContent, original);

  app._handleFullscreenTileRemoval(cameraTile);

  assert.equal(label.textContent, original);
  assert.equal(cameraTile.classList.contains('is-fullscreen'), false);
  assert.equal(cameraTile.querySelector('.fullscreen-call-toolbar').hidden, true);
});

test('moving fullscreen straight from one tile to another restores the first tile label', () => {
  const { document, cameraTile, shareTile } = renderBothMediaTiles();
  const shareLabel = shareTile.querySelector('.screen-share-tile-label');
  const original = shareLabel.textContent;
  enterFullscreen(document, shareTile);
  assert.equal(shareLabel.textContent, `${original} · voice.screen_share`);

  document.fullscreenElement = cameraTile;
  document.dispatch('fullscreenchange');

  assert.equal(shareLabel.textContent, original);
});

test('fullscreen controls also follow the WebKit-prefixed fullscreen API', () => {
  const { document, tile } = renderWebcamTile();
  const toolbar = tile.querySelector('.fullscreen-call-toolbar');
  let exits = 0;
  document.webkitExitFullscreen = () => {
    exits++;
    document.webkitFullscreenElement = null;
    document.dispatch('webkitfullscreenchange');
  };
  document.webkitFullscreenElement = tile;
  document.dispatch('webkitfullscreenchange');
  assert.equal(toolbar.hidden, false);
  assert.equal(tile.classList.contains('is-fullscreen'), true);

  tile.querySelector('.fullscreen-call-exit').listeners.click[0]({ stopPropagation() {} });

  assert.equal(exits, 1);
  assert.equal(toolbar.hidden, true);
  assert.equal(tile.classList.contains('is-fullscreen'), false);
});

test('fullscreen controls hide as soon as the pointer leaves the screen', () => {
  const { document, tile } = renderWebcamTile();
  enterFullscreen(document, tile);
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false);

  tile.listeners.mouseleave[0]();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), true);

  tile.listeners.mousemove[0]();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false);

  tile.classList.add('fullscreen-popup-open');
  tile.listeners.mouseleave[0]();
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false, 'an open settings popup stays up');
});

test('leaving the screen drops focus from a toolbar button but not from an open dropdown', () => {
  const { document, tile } = renderWebcamTile();
  enterFullscreen(document, tile);
  const toolbar = tile.querySelector('.fullscreen-call-toolbar');
  const button = tile.querySelector('.fullscreen-call-mute');
  const pickerButton = tile.querySelector('.fullscreen-call-streams');
  let blurred = 0;
  button.blur = () => { blurred++; };
  pickerButton.blur = () => { blurred++; };

  toolbar.contains = el => el === button;
  document.activeElement = button;
  tile.listeners.mouseleave[0]();
  assert.equal(blurred, 1);
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), true);

  tile.listeners.mousemove[0]();
  pickerButton.listeners.click[0]({ stopPropagation() {} });
  toolbar.contains = el => el === pickerButton;
  document.activeElement = pickerButton;
  tile.listeners.mouseleave[0]();
  assert.equal(blurred, 1, 'the open stream list is left alone');
  assert.equal(tile.classList.contains('fullscreen-controls-idle'), false);
});

test('the stream picker is only rebuilt when its list of streams changes', () => {
  const { app, cameraTile, shareTrack } = renderBothMediaTiles();
  const fsTile = cameraTile;
  const before = streamChoices(fsTile);
  assert.equal(before.length, 2);

  app._refreshFullscreenStreamPicker();
  app._refreshFullscreenStreamPicker();
  assert.deepEqual(streamChoices(fsTile).map((option, index) => option === before[index]), [true, true]);

  shareTrack.end();
  assert.equal(streamChoices(fsTile).length, 1);
});

test('the fullscreen settings button and popup are named Call settings', () => {
  const { tile } = renderWebcamTile();
  const gear = tile.querySelector('.fullscreen-call-audio');
  assert.equal(gear.title, 'voice.panel.call_settings');
  assert.equal(gear.attributes['aria-label'], 'voice.panel.call_settings');
  assert.equal(tile.querySelector('.fullscreen-audio-popover').attributes['aria-label'], 'voice.panel.call_settings');
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  assert.equal(en.voice.panel.call_settings, 'Call settings');
  assert.equal(en.voice.panel.settings, 'Voice Settings', 'the regular sidebar button keeps its name');
});

test('the fullscreen toolbar is named as call controls, not voice settings', () => {
  const { tile } = renderWebcamTile();
  const toolbar = tile.querySelector('.fullscreen-call-toolbar');
  assert.equal(toolbar.attributes['aria-label'], 'voice.panel.call_controls');
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  assert.equal(en.voice.panel.call_controls, 'Call controls');
});

// ── Several streams at once (#5899) ──────────────────────────────────────

function streamGrid(tile) {
  return tile.querySelector('.fullscreen-stream-grid');
}

function gridCells(tile) {
  return streamGrid(tile).querySelectorAll('.fullscreen-stream-cell');
}

test('the stream list opens from its toolbar button and closes with Escape', () => {
  const { document, cameraTile } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  const button = cameraTile.querySelector('.fullscreen-call-streams');
  const popover = cameraTile.querySelector('.fullscreen-stream-popover');
  assert.equal(popover.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');

  button.listeners.click[0]({ stopPropagation() {} });
  assert.equal(popover.hidden, false);
  assert.equal(button.attributes['aria-expanded'], 'true');
  assert.equal(cameraTile.classList.contains('fullscreen-popup-open'), true);

  cameraTile.querySelector('.fullscreen-call-toolbar').listeners.keydown[0]({ key: 'Escape', preventDefault() {} });
  assert.equal(popover.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.equal(cameraTile.classList.contains('fullscreen-popup-open'), false);
});

test('opening the stream list closes call settings, and the other way round', () => {
  const { document, cameraTile } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  const streams = cameraTile.querySelector('.fullscreen-call-streams');
  const streamPopover = cameraTile.querySelector('.fullscreen-stream-popover');
  const settings = cameraTile.querySelector('.fullscreen-call-audio');
  const settingsPopover = cameraTile.querySelector('.fullscreen-audio-popover');

  settings.listeners.click[0]({ stopPropagation() {} });
  streams.listeners.click[0]({ stopPropagation() {} });
  assert.equal(settingsPopover.hidden, true);
  assert.equal(streamPopover.hidden, false);
  assert.equal(cameraTile.classList.contains('fullscreen-popup-open'), true);

  settings.listeners.click[0]({ stopPropagation() {} });
  assert.equal(streamPopover.hidden, true);
  assert.equal(streams.attributes['aria-expanded'], 'false');
  assert.equal(settingsPopover.hidden, false);
  assert.equal(cameraTile.classList.contains('fullscreen-popup-open'), true);
});

test('the stream button is disabled while there is only one stream to show', () => {
  const { app, cameraTile, shareTrack } = renderBothMediaTiles();
  const button = cameraTile.querySelector('.fullscreen-call-streams');
  assert.equal(button.disabled, false);
  shareTrack.end();
  app._refreshFullscreenStreamPicker();
  assert.equal(button.disabled, true);
});

test('ticking a second stream shows both in a grid of their own videos', () => {
  const { document, cameraTile, shareTile, cameraStream, shareStream } = renderBothMediaTiles();
  const hostVideo = cameraTile.querySelector('video');
  enterFullscreen(document, cameraTile);
  assert.equal(streamGrid(cameraTile).hidden, true, 'one stream needs no grid');
  assert.deepEqual(streamChoices(cameraTile).map(box => box.checked), [true, false]);

  setStreamShown(cameraTile, shareTile.id, true);

  assert.equal(streamGrid(cameraTile).hidden, false);
  assert.equal(cameraTile.classList.contains('fullscreen-grid-active'), true);
  const cells = gridCells(cameraTile);
  assert.deepEqual(cells.map(cell => cell.dataset.sourceId), [cameraTile.id, shareTile.id]);
  const videos = cells.map(cell => cell.querySelector('video'));
  assert.deepEqual(videos.map(video => video.srcObject), [cameraStream, shareStream]);
  assert.deepEqual(videos.map(video => video.muted), [true, true], 'sound plays elsewhere, never from a grid copy');
  assert.deepEqual(cells.map(cell => cell.querySelector('.fullscreen-stream-cell-label').textContent), [
    'Participant · voice.panel.camera',
    'Participant · voice.screen_share',
  ]);
  assert.equal(cameraTile.querySelector('video'), hostVideo, "the tile's own video stays its first video");
  assert.equal(hostVideo.srcObject, cameraStream);
  assert.deepEqual(streamChoices(cameraTile).map(box => box.checked), [true, true]);
});

test('unticking back to one stream closes the grid and shows that stream full size', () => {
  const { document, cameraTile, shareTile, shareStream } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  setStreamShown(cameraTile, shareTile.id, true);
  const videos = gridCells(cameraTile).map(cell => cell.querySelector('video'));

  setStreamShown(cameraTile, cameraTile.id, false);

  assert.equal(streamGrid(cameraTile).hidden, true);
  assert.equal(gridCells(cameraTile).length, 0);
  assert.deepEqual(videos.map(video => video.srcObject), [null, null], 'grid copies let go of their streams');
  assert.equal(cameraTile.classList.contains('fullscreen-grid-active'), false);
  assert.equal(cameraTile.querySelector('video').srcObject, shareStream);
});

test('the last stream shown cannot be unticked', () => {
  const { document, cameraTile, cameraStream } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  const cameraBox = streamChoices(cameraTile).find(box => box.value === cameraTile.id);
  assert.equal(cameraBox.disabled, true);

  setStreamShown(cameraTile, cameraTile.id, false);

  assert.equal(cameraBox.checked, true);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream);
});

test('a mirrored local camera stays mirrored in its grid cell', () => {
  const { document, cameraTile, shareTile } = renderBothMediaTiles({ localCamera: true });
  enterFullscreen(document, shareTile);
  setStreamShown(shareTile, cameraTile.id, true);

  const transforms = gridCells(shareTile).map(cell => cell.querySelector('video').style.transform || '');
  assert.deepEqual(transforms, ['scaleX(-1)', '']);
});

test('a stream that ends leaves the grid and the one left fills the screen', () => {
  const { document, cameraTile, shareTile, cameraStream, shareTrack } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  setStreamShown(cameraTile, shareTile.id, true);

  shareTrack.end();

  assert.equal(document.fullscreenElement, cameraTile);
  assert.equal(streamGrid(cameraTile).hidden, true);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream);
  assert.deepEqual(streamChoiceValues(cameraTile), [cameraTile.id]);
});

test('closing the shown tile of a grid keeps fullscreen on the others', () => {
  const { app, document, cameraTile, shareTile, shareStream } = renderBothMediaTiles();
  app._hideStreamTile = loadStreamTileMethods(document)._hideStreamTile;
  const third = { getVideoTracks: () => [makeVideoTrack()] };
  app._handleScreenStream('peer-2', third);
  enterFullscreen(document, cameraTile);
  setStreamShown(cameraTile, shareTile.id, true);
  const secondShare = streamChoices(cameraTile)[2].value;
  setStreamShown(cameraTile, secondShare, true);
  assert.equal(gridCells(cameraTile).length, 3);

  app._hideStreamTile(shareTile, 'peer-1', 'Participant');

  assert.equal(document.fullscreenElement, cameraTile);
  assert.deepEqual(gridCells(cameraTile).map(cell => cell.dataset.sourceId), [cameraTile.id, secondShare]);
  assert.equal(gridCells(cameraTile).some(cell => cell.querySelector('video').srcObject === shareStream), false);
});

test('leaving fullscreen takes the grid down and puts the tile back', () => {
  const { document, cameraTile, shareTile, cameraStream } = renderBothMediaTiles();
  const label = cameraTile.querySelector('.webcam-tile-label');
  const original = label.textContent;
  enterFullscreen(document, cameraTile);
  setStreamShown(cameraTile, shareTile.id, true);
  const videos = gridCells(cameraTile).map(cell => cell.querySelector('video'));

  leaveFullscreen(document);

  assert.equal(streamGrid(cameraTile).hidden, true);
  assert.equal(gridCells(cameraTile).length, 0);
  assert.deepEqual(videos.map(video => video.srcObject), [null, null]);
  assert.equal(cameraTile.classList.contains('fullscreen-grid-active'), false);
  assert.equal(cameraTile.querySelector('video').srcObject, cameraStream);
  assert.equal(label.textContent, original);

  enterFullscreen(document, cameraTile);
  assert.equal(streamGrid(cameraTile).hidden, true, 'the next fullscreen starts with one stream again');
  assert.deepEqual(streamChoices(cameraTile).map(box => box.checked), [true, false]);
});

test('Show all puts every stream in the grid and adds streams that start later', () => {
  const { app, document, cameraTile } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  const showAll = cameraTile.querySelector('.fullscreen-stream-all');
  assert.equal(showAll.checked, false);

  showAll.checked = true;
  showAll.listeners.change[0]({ stopPropagation() {} });
  assert.equal(gridCells(cameraTile).length, 2);

  app._handleScreenStream('peer-2', { getVideoTracks: () => [makeVideoTrack()] });
  assert.equal(gridCells(cameraTile).length, 3, 'a new stream joins the grid');
  assert.equal(showAll.checked, true);

  setStreamShown(cameraTile, streamChoices(cameraTile)[1].value, false);
  assert.equal(showAll.checked, false, 'picking streams by hand turns Show all off');
  assert.equal(gridCells(cameraTile).length, 2);

  app._handleScreenStream('peer-3', { getVideoTracks: () => [makeVideoTrack()] });
  assert.equal(gridCells(cameraTile).length, 2, 'without Show all a new stream is only offered');
  assert.equal(streamChoices(cameraTile).length, 4);
});

test('unticking Show all goes back to the stream fullscreen started on', () => {
  const { document, cameraTile, shareTile, shareStream } = renderBothMediaTiles();
  enterFullscreen(document, shareTile);
  const showAll = shareTile.querySelector('.fullscreen-stream-all');
  showAll.checked = true;
  showAll.listeners.change[0]({ stopPropagation() {} });
  showAll.checked = false;
  showAll.listeners.change[0]({ stopPropagation() {} });

  assert.equal(streamGrid(shareTile).hidden, true);
  assert.equal(shareTile.querySelector('video').srcObject, shareStream);
  assert.deepEqual(streamChoices(shareTile).map(box => box.checked), [false, true]);
  assert.ok(cameraTile);
});

test('the stream button names the stream shown, or says how many', () => {
  const { document, cameraTile, shareTile } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  const button = cameraTile.querySelector('.fullscreen-call-streams');
  assert.equal(button.textContent, 'Participant · voice.panel.camera');

  setStreamShown(cameraTile, shareTile.id, true);
  assert.equal(button.textContent, 'voice_runtime.stream');
});

test('grid cells are placed by the layout and follow a stream changing shape', () => {
  const { document, cameraTile, shareTile } = renderBothMediaTiles();
  enterFullscreen(document, cameraTile);
  setStreamShown(cameraTile, shareTile.id, true);
  const [cameraCell, shareCell] = gridCells(cameraTile);
  const width = cell => parseFloat(cell.style.width);
  const top = cell => parseFloat(cell.style.top);
  assert.ok(width(cameraCell) > 0 && Math.abs(width(cameraCell) - width(shareCell)) < 0.01,
    'two streams of unknown shape share the screen equally');
  assert.ok(Math.abs(top(cameraCell) - top(shareCell)) < 0.01, 'side by side on a wide screen');

  const cameraVideo = cameraCell.querySelector('video');
  cameraVideo.videoWidth = 720;
  cameraVideo.videoHeight = 1280;
  cameraVideo.listeners.resize.forEach(listener => listener());

  assert.ok(width(cameraCell) < width(shareCell) / 2, 'an upright camera gets a narrow slot');
});

test('the grid sits before the toolbar so the controls stay on top', () => {
  const { cameraTile } = renderBothMediaTiles();
  const children = cameraTile.children;
  const grid = children.indexOf(streamGrid(cameraTile));
  const toolbar = children.indexOf(cameraTile.querySelector('.fullscreen-call-toolbar'));
  const video = children.indexOf(cameraTile.querySelector('video'));
  assert.ok(video < grid && grid < toolbar);
});
