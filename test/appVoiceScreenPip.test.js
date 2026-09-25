'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-voice.js'),
  'utf8'
);

function loadMethods(globals = {}) {
  const context = vm.createContext({ module: { exports: {} }, t: key => key, ...globals });
  vm.runInContext(SOURCE.replace(/^export default/, 'module.exports ='), context, {
    filename: 'app-voice.js',
  });
  return context.module.exports;
}

function createClassList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
  };
}

test('a reset invalidates a pending native screen PiP continuation', async () => {
  let resolvePictureInPicture;
  let exitCalls = 0;
  const button = { textContent: '', title: '' };
  const video = {
    srcObject: { id: 'old-stream' },
    disablePictureInPicture: false,
    requestPictureInPicture: () => new Promise(resolve => {
      resolvePictureInPicture = resolve;
    }),
    addEventListener() {},
  };
  const tile = {
    classList: createClassList(),
    contains: element => element === video,
    querySelector: selector => selector === 'video' ? video : button,
  };
  const document = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    getElementById: id => id === 'screen-tile-7' ? tile : null,
    exitPictureInPicture: async () => {
      exitCalls++;
      document.pictureInPictureElement = null;
    },
    querySelector: () => null,
  };
  const methods = loadMethods({ document });
  const app = Object.assign({ _updateStreamContainerCollapse() {} }, methods);

  app._popOutStream(tile, 7);
  app._removeScreenSharePiP(7);
  document.pictureInPictureElement = video;
  resolvePictureInPicture();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(exitCalls, 1);
  assert.equal(tile.classList.contains('stream-popped-out'), false);
  assert.equal(button.title, 'media.pop_out_stream');
});

test('screen PiP cleanup restores the previous track onended handler', () => {
  let previousCalls = 0;
  let pipCalls = 0;
  const previousOnEnded = () => { previousCalls++; };
  const track = { onended: previousOnEnded };
  const document = {
    pictureInPictureElement: null,
    getElementById: () => null,
    querySelector: () => null,
  };
  const methods = loadMethods({ document });
  const app = Object.assign({ _updateStreamContainerCollapse() {} }, methods);

  app._bindScreenPipTrack(7, track, () => { pipCalls++; });
  const wrappedOnEnded = track.onended;
  wrappedOnEnded();
  assert.equal(previousCalls, 1);
  assert.equal(pipCalls, 1);

  app._removeScreenSharePiP(7);
  assert.equal(track.onended, previousOnEnded);
  assert.equal(app._screenPipTrackCleanups.has(7), false);
});

test('an old PiP completion does not close a newer request on the same video', async () => {
  const resolvers = [];
  let exitCalls = 0;
  const button = { textContent: '', title: '' };
  const video = {
    srcObject: { id: 'current-stream' },
    disablePictureInPicture: false,
    requestPictureInPicture: () => new Promise(resolve => { resolvers.push(resolve); }),
    addEventListener() {},
  };
  const tile = {
    classList: createClassList(),
    contains: element => element === video,
    querySelector: selector => selector === 'video' ? video : button,
  };
  const document = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    getElementById: id => id === 'screen-tile-7' ? tile : null,
    exitPictureInPicture: async () => { exitCalls++; },
    querySelector: () => null,
  };
  const methods = loadMethods({ document });
  const app = Object.assign({ _updateStreamContainerCollapse() {} }, methods);

  app._popOutStream(tile, 7);
  app._removeScreenSharePiP(7);
  app._popOutStream(tile, 7);
  document.pictureInPictureElement = video;
  resolvers[1]();
  await Promise.resolve();
  await Promise.resolve();
  resolvers[0]();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(exitCalls, 0);
  assert.equal(tile.classList.contains('stream-popped-out'), true);
  assert.equal(button.title, 'media.pop_in_stream');
});

test('a rejected replacement adopts an older PiP that finished while it was pending', async () => {
  const requests = [];
  let exitCalls = 0;
  let fallbackCalls = 0;
  const button = { textContent: '', title: '' };
  const video = {
    srcObject: { id: 'current-stream' },
    disablePictureInPicture: false,
    requestPictureInPicture: () => new Promise((resolve, reject) => {
      requests.push({ resolve, reject });
    }),
    addEventListener() {},
  };
  const tile = {
    classList: createClassList(),
    contains: element => element === video,
    querySelector: selector => selector === 'video' ? video : button,
  };
  const document = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    getElementById: id => id === 'screen-tile-7' ? tile : null,
    exitPictureInPicture: async () => { exitCalls++; },
    querySelector: () => null,
  };
  const methods = loadMethods({ document });
  const app = Object.assign({ _updateStreamContainerCollapse() {} }, methods);
  app._popOutStreamWindow = () => { fallbackCalls++; };

  app._popOutStream(tile, 7);
  app._removeScreenSharePiP(7);
  app._popOutStream(tile, 7);
  document.pictureInPictureElement = video;
  requests[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  requests[1].reject(new Error('replacement rejected'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(exitCalls, 0);
  assert.equal(fallbackCalls, 0);
  assert.equal(tile.classList.contains('stream-popped-out'), true);
  assert.equal(button.title, 'media.pop_in_stream');
});
