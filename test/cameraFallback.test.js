'use strict';

// Turning the camera on in a call when the saved camera is not plugged in:
// the default camera is used instead (as joining does for the microphone),
// the saved choice is kept, and the user is told.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Node has a read-only navigator of its own: swap it for the test and put it back.
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

function load({ savedCam = '', present = ['cam-a'], refuse = null } = {}) {
  const store = savedCam ? { haven_cam_device: savedCam } : {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const requests = [];
  setNavigator({
    mediaDevices: {
      async getUserMedia(constraints) {
        requests.push(constraints.video);
        if (refuse) throw Object.assign(new Error('refused'), { name: refuse });
        const wanted = constraints.video?.deviceId?.exact;
        if (wanted && !present.includes(wanted)) throw Object.assign(new Error('missing'), { name: 'OverconstrainedError' });
        const track = { kind: 'video', deviceId: wanted || 'default', onended: null, stop() {} };
        return { id: 'cam-stream', getTracks: () => [track], getVideoTracks: () => [track] };
      },
    },
  });
  delete require.cache[require.resolve('../public/js/voice.js')];
  const { VoiceManager } = require('../public/js/voice.js');
  const emitted = [];
  const voice = Object.assign(Object.create(VoiceManager.prototype), {
    inVoice: true, isWebcamActive: false, peers: new Map(), _relay: null, currentChannel: 'room',
    socket: { emit: (...args) => emitted.push(args) },
  });
  return { voice, requests, store, emitted };
}

test.afterEach(() => {
  delete global.localStorage;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
});

test('an unplugged saved camera turns on the default one and keeps the choice', async () => {
  const { voice, requests, store, emitted } = load({ savedCam: 'cam-gone' });
  const errors = console.warn;
  console.warn = () => {};
  let ok;
  try { ok = await voice.startWebcam(); } finally { console.warn = errors; }
  assert.equal(ok, true);
  assert.equal(voice.isWebcamActive, true);
  assert.equal(voice.webcamFellBack, true);
  assert.deepEqual(requests[0].deviceId, { exact: 'cam-gone' });
  assert.equal(requests[1].deviceId, undefined, 'the second try asks for any camera');
  assert.equal(requests[1].height.ideal, requests[0].height.ideal, 'at the same Camera Quality');
  assert.equal(store.haven_cam_device, 'cam-gone', 'kept for when it is plugged back in');
  assert.equal(emitted[0][0], 'webcam-started');
});

test('a saved camera that is there is used, with no fallback', async () => {
  const { voice, requests } = load({ savedCam: 'cam-a' });
  assert.equal(await voice.startWebcam(), true);
  assert.equal(voice.webcamFellBack, false);
  assert.equal(requests.length, 1);
});

test('a refused camera is not retried on another one', async () => {
  const { voice, requests } = load({ savedCam: 'cam-a', refuse: 'NotAllowedError' });
  const errors = console.error;
  console.error = () => {};
  try { assert.equal(await voice.startWebcam(), false); } finally { console.error = errors; }
  assert.equal(requests.length, 1);
  assert.equal(voice.isWebcamActive, false);
});

test('the camera button says when the default camera was used instead', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-screen-webcam.js'), 'utf8');
  assert.match(src, /if \(this\.voice\.webcamFellBack\) this\._showToast\(t\('voice\.camera_fallback'\), 'info'\);/);
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  assert.ok(en.voice.camera_fallback);
});
