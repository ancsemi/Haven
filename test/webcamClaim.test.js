/**
 * A camera's track can arrive before the webcam-started that says what it
 * is. It used to be dropped, and the camera stayed invisible until someone
 * reconnected; now the announcement shows the track that was waiting.
 *
 *   node --test test/webcamClaim.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');

function loadVoiceManager(globals = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    document: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console: { log() {}, warn() {}, error() {} },
    MediaStream: function MediaStream(tracks) { this.tracks = tracks || []; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    ...globals,
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return context.module.exports;
}

function viewer(VoiceManager, peer) {
  const voice = Object.create(VoiceManager.prototype);
  voice.peers = new Map([[7, peer]]);
  voice.screenSharers = new Set();
  voice.webcamUsers = new Set();
  voice.screenStreamIds = new Map();
  voice.webcamStreamIds = new Map();
  voice.shown = [];
  voice.onWebcamStream = (userId, stream) => voice.shown.push({ userId, stream });
  return voice;
}

test('webcam-started shows a camera track that arrived first', () => {
  const VoiceManager = loadVoiceManager();
  const track = { kind: 'video', readyState: 'live', id: 'cam-1' };
  const stream = { id: 'cam-stream' };
  const peer = { _unclaimedVideo: { track, stream } };
  const voice = viewer(VoiceManager, peer);
  voice._claimWebcamTrack(7);
  assert.equal(voice.shown.length, 1);
  assert.equal(voice.shown[0].userId, 7);
  assert.equal(voice.shown[0].stream, stream);
  assert.equal(peer._webcamTrackId, 'cam-1', 'remembered so screen recovery skips it');
  assert.equal(peer._unclaimedVideo, null);
  // Later events on the track still reach the tile.
  track.onended();
  assert.equal(voice.shown.at(-1).stream, null);
});

test('nothing waiting, an ended track, or the screen track: no camera tile', () => {
  const VoiceManager = loadVoiceManager();
  const none = viewer(VoiceManager, {});
  none._claimWebcamTrack(7);
  none._claimWebcamTrack(99);
  assert.equal(none.shown.length, 0);

  const ended = viewer(VoiceManager, { _unclaimedVideo: { track: { readyState: 'ended', id: 'a' } } });
  ended._claimWebcamTrack(7);
  assert.equal(ended.shown.length, 0);

  const screen = viewer(VoiceManager, { _screenTrackId: 's', _unclaimedVideo: { track: { readyState: 'live', id: 's' } } });
  screen._claimWebcamTrack(7);
  assert.equal(screen.shown.length, 0);
});

test('switchCamera updates the local preview to the replacement stream', async () => {
  const oldTrack = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  const oldStream = { getTracks: () => [oldTrack] };
  const newTrack = { kind: 'video', onended: null };
  const newStream = { getVideoTracks: () => [newTrack] };
  const VoiceManager = loadVoiceManager({
    navigator: {
      userAgent: '', platform: '', maxTouchPoints: 0,
      mediaDevices: { getUserMedia: async () => newStream }
    }
  });
  const voice = viewer(VoiceManager, {});
  voice.peers = new Map();
  voice.isWebcamActive = true;
  voice.webcamStream = oldStream;
  voice.localUserId = 42;

  await voice.switchCamera('camera-2');

  assert.equal(oldTrack.stopped, true, 'old camera track is stopped');
  assert.equal(voice.webcamStream, newStream, 'VoiceManager now owns the replacement stream');
  assert.deepEqual(voice.shown, [{ userId: 42, stream: newStream }], 'local preview is rebound to the replacement stream');
});

test('switchCamera keeps the newest selection when captures resolve out of order', async () => {
  const requests = [];
  const qualities = ['720', '1080'];
  const oldTrack = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  const oldStream = { getTracks: () => [oldTrack] };
  const VoiceManager = loadVoiceManager({
    navigator: {
      userAgent: '', platform: '', maxTouchPoints: 0,
      mediaDevices: {
        getUserMedia: ({ video }) => new Promise(resolve => requests.push({ resolve, height: video.height.ideal }))
      }
    },
    localStorage: {
      getItem: key => key === 'haven_cam_quality' ? qualities.shift() : null,
      setItem() {}, removeItem() {}
    }
  });
  const voice = viewer(VoiceManager, {});
  voice.peers = new Map();
  voice.isWebcamActive = true;
  voice.webcamStream = oldStream;
  voice.localUserId = 42;

  const olderRequest = voice.switchCamera('');
  const newerRequest = voice.switchCamera('');
  assert.deepEqual(requests.map(request => request.height), [720, 1080]);

  const newerTrack = { kind: 'video', stopped: false, onended: null, stop() { this.stopped = true; } };
  const newerStream = { getVideoTracks: () => [newerTrack], getTracks: () => [newerTrack] };
  requests[1].resolve(newerStream);
  await newerRequest;

  const olderTrack = { kind: 'video', stopped: false, onended: null, stop() { this.stopped = true; } };
  const olderStream = { getVideoTracks: () => [olderTrack], getTracks: () => [olderTrack] };
  requests[0].resolve(olderStream);
  await olderRequest;

  assert.equal(voice.webcamStream, newerStream, 'late older capture does not replace the latest selection');
  assert.equal(olderTrack.stopped, true, 'stale captured track is stopped');
  assert.equal(newerTrack.stopped, false, 'current track remains live');
  assert.equal(voice.shown.at(-1).stream, newerStream, 'preview remains on the latest stream');
});

test('switchCamera discards a capture when webcam stop starts before it resolves', async () => {
  let finishCapture;
  let finishUnpublish;
  let relayReplacements = 0;
  const capture = new Promise(resolve => { finishCapture = resolve; });
  const unpublish = new Promise(resolve => { finishUnpublish = resolve; });
  const oldTrack = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  const oldStream = { getTracks: () => [oldTrack] };
  const VoiceManager = loadVoiceManager({
    navigator: {
      userAgent: '', platform: '', maxTouchPoints: 0,
      mediaDevices: { getUserMedia: async () => capture }
    }
  });
  const voice = viewer(VoiceManager, {});
  voice.peers = new Map();
  voice.isWebcamActive = true;
  voice.webcamStream = oldStream;
  voice.localUserId = 42;
  voice.socket = { emit() {} };
  voice._relay = {
    unpublish: () => unpublish,
    replace: async () => { relayReplacements++; }
  };

  const switching = voice.switchCamera('camera-2');
  const stopping = voice.stopWebcam();
  const replacementTrack = { kind: 'video', stopped: false, onended: null, stop() { this.stopped = true; } };
  const replacementStream = { getVideoTracks: () => [replacementTrack], getTracks: () => [replacementTrack] };
  finishCapture(replacementStream);
  await switching;
  finishUnpublish();
  await stopping;

  assert.equal(relayReplacements, 0, 'late capture is not sent to the relay after stop starts');
  assert.equal(replacementTrack.stopped, true, 'late captured track is stopped');
  assert.equal(voice.webcamStream, null);
  assert.equal(voice.isWebcamActive, false);
  assert.equal(voice.shown.at(-1).stream, null, 'preview stays stopped');
});
