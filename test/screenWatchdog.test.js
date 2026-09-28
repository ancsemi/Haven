/**
 * Screen watchdog recovery for the GPU black-tile shape.
 *
 * A live-but-never-decoded receiver (videoWidth === 0) must trigger a
 * renegotiate request — not a re-adoption of the same receiver, which would
 * mark the share delivered and stall recovery until a rejoin.
 *
 *   node --test test/screenWatchdog.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');

function loadVoiceManager(documentStub) {
  let pendingTimer = null;
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    document: documentStub,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    RTCSessionDescription: function RTCSessionDescription(d) { return d; },
    MediaStream: function MediaStream(tracks) { this.tracks = tracks || []; },
    setTimeout: (fn) => { pendingTimer = fn; return 1; },
    clearTimeout: () => { pendingTimer = null; },
    Date
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return { VoiceManager: context.module.exports, fireTimer: () => pendingTimer && pendingTimer() };
}

// Viewer of sharer 7 with a live, unmuted screen receiver. tileVideo is the
// <video> element the UI tile holds (null = no tile yet).
function makeViewer(VoiceManager, tileVideo) {
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live', muted: false, id: 'screen-track-1' };
  voice.peers = new Map([[
    7,
    {
      connection: { getReceivers: () => [{ track }] },
      username: 'sharer'
    }
  ]]);
  voice.screenSharers = new Set([7]);
  voice._screenDelivered = new Set([7]);
  voice._screenWatchdogTimers = new Map();
  voice.inVoice = true;
  voice.currentChannel = '22222222';
  voice.emitted = [];
  voice.socket = { connected: true, emit: (event, payload) => voice.emitted.push({ event, payload }) };
  voice.delivered = [];
  voice.onScreenStream = (userId, stream) => voice.delivered.push({ userId, stream });
  voice._tileVideo = tileVideo === undefined ? null : tileVideo;
  voice._tileTrack = track;
  return voice;
}

function tileDoc(videoOrNull) {
  return { getElementById: (id) => (id === 'screen-tile-7' && videoOrNull ? { querySelector: () => videoOrNull } : null) };
}

test('a black tile with a live receiver requests renegotiation instead of re-adopting', () => {
  const blackVideo = { srcObject: null, videoWidth: 0 };
  const { VoiceManager, fireTimer } = loadVoiceManager(tileDoc(blackVideo));
  const voice = makeViewer(VoiceManager, blackVideo);
  blackVideo.srcObject = { getVideoTracks: () => [voice._tileTrack] };
  voice._watchForScreenStream(7, 1);
  fireTimer();
  assert.equal(voice.delivered.length, 0, 'same receiver must not be re-adopted');
  assert.ok(
    voice.emitted.some(e => e.event === 'request-screen-renegotiate'),
    'sharer must be asked to renegotiate (and force a keyframe)'
  );
  assert.equal(voice._screenDelivered.has(7), false);
});

test('a tile with decoded frames counts as live and stops recovery', () => {
  const liveVideo = { srcObject: null, videoWidth: 1920 };
  const { VoiceManager, fireTimer } = loadVoiceManager(tileDoc(liveVideo));
  const voice = makeViewer(VoiceManager, liveVideo);
  liveVideo.srcObject = { getVideoTracks: () => [voice._tileTrack] };
  voice._watchForScreenStream(7, 1);
  fireTimer();
  assert.equal(voice.emitted.length, 0, 'no renegotiate for a healthy tile');
  assert.equal(voice._screenDelivered.has(7), true);
});

test('without a tile, a live receiver is still adopted', () => {
  const { VoiceManager, fireTimer } = loadVoiceManager(tileDoc(null));
  const voice = makeViewer(VoiceManager, null);
  voice._screenDelivered.delete(7); // never delivered — watchdog armed by screen-share-started
  voice._watchForScreenStream(7, 1);
  fireTimer();
  assert.equal(voice.delivered.length, 1, 'receiver adopted when no tile exists');
  assert.equal(voice.emitted.length, 0, 'no signalling needed');
});
