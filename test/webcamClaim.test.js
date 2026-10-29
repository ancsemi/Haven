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

function loadVoiceManager() {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    document: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console: { log() {}, warn() {}, error() {} },
    MediaStream: function MediaStream(tracks) { this.tracks = tracks || []; },
    setTimeout: () => 1,
    clearTimeout: () => {},
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
