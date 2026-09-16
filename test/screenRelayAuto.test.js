/**
 * Automatic relay profile for screen share (#5426).
 *
 * The "Gentler screen share for relay connections" toggle was confirmed on
 * two setups as the thing a relayed share needs. This applies it by itself,
 * per viewer: once a peer connection settles, its selected candidate pair
 * says whether the path runs through a TURN relay, and only that viewer's
 * sender gets the gentler encoder settings.
 *
 *   node --test test/screenRelayAuto.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');

function loadVoiceManager(storage = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem(k, v) { storage[k] = String(v); },
      removeItem(k) { delete storage[k]; }
    },
    console: { log() {}, warn() {}, error() {} },
    RTCSessionDescription: function RTCSessionDescription(d) { return d; },
    setTimeout,
    clearTimeout,
    Date
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return context.module.exports;
}

// A peer connection whose stats say the selected pair is relayed or direct,
// with one screen-share video sender that records what it was told.
function fakeConnection(localType, remoteType, videoTrack) {
  const stats = new Map([
    ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' }],
    ['P1', { id: 'P1', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' }],
    ['L1', { id: 'L1', type: 'local-candidate', candidateType: localType }],
    ['R1', { id: 'R1', type: 'remote-candidate', candidateType: remoteType }]
  ]);
  const sender = {
    track: videoTrack,
    applied: null,
    getParameters() { return { encodings: [{}] }; },
    setParameters(p) { this.applied = p; return Promise.resolve(); }
  };
  return {
    sender,
    getStats: async () => stats,
    getSenders: () => [sender]
  };
}

function makeSharer(VoiceManager, { local = 'host', remote = 'srflx' } = {}) {
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 1080;
  voice.screenFrameRate = 30;
  voice._screenBitrates = { 0: 8_000_000, 720: 4_000_000, 1080: 8_000_000, 1440: 14_000_000 };
  const connection = fakeConnection(local, remote, track);
  voice.peers.set(2, { connection, username: 'viewer' });
  return { voice, connection };
}

test('a relayed viewer gets the gentler profile on their sender only', async () => {
  const VoiceManager = loadVoiceManager();
  const { voice, connection } = makeSharer(VoiceManager, { local: 'relay' });
  await voice._detectRelayPath(2, connection);
  assert.equal(voice._relayPeers.has(2), true);
  const p = connection.sender.applied;
  assert.ok(p, 'sender parameters were re-applied once the relay was detected');
  assert.equal(p.encodings[0].maxBitrate, 3_000_000, 'gentler 1080p ceiling');
  assert.equal(p.encodings[0].maxFramerate, undefined, 'framerate left unpinned');
  assert.equal(p.degradationPreference, 'balanced');
});

test('the remote end being a relay counts too', async () => {
  const VoiceManager = loadVoiceManager();
  const { voice, connection } = makeSharer(VoiceManager, { local: 'srflx', remote: 'relay' });
  await voice._detectRelayPath(2, connection);
  assert.equal(voice._relayPeers.has(2), true);
});

test('a direct viewer keeps the full-quality profile', async () => {
  const VoiceManager = loadVoiceManager();
  const { voice, connection } = makeSharer(VoiceManager);
  await voice._detectRelayPath(2, connection);
  assert.equal(voice._relayPeers.has(2), false);
  // Nothing changed, so nothing was re-applied by detection; apply explicitly
  // the way shareScreen does and check the full profile is what goes out.
  voice._applyScreenBitrate(connection, voice._screenBitrates[1080], 2);
  const p = connection.sender.applied;
  assert.equal(p.encodings[0].maxBitrate, 8_000_000);
  assert.equal(p.encodings[0].maxFramerate, 30);
  assert.equal(p.degradationPreference, 'maintain-framerate');
});

test('switching the detection off in Debug leaves relayed viewers on the full profile', async () => {
  const VoiceManager = loadVoiceManager({ haven_screen_relay_auto: '0' });
  const { voice, connection } = makeSharer(VoiceManager, { local: 'relay' });
  await voice._detectRelayPath(2, connection);
  assert.equal(voice._relayPeers.has(2), true, 'the path is still recorded');
  voice._applyScreenBitrate(connection, voice._screenBitrates[1080], 2);
  assert.equal(connection.sender.applied.encodings[0].maxBitrate, 8_000_000);
  assert.equal(connection.sender.applied.degradationPreference, 'maintain-framerate');
});

test('the manual toggle still applies the gentler profile to everyone', () => {
  const VoiceManager = loadVoiceManager({ haven_screen_relay_profile: '1' });
  const { voice, connection } = makeSharer(VoiceManager);
  voice._applyScreenBitrate(connection, voice._screenBitrates[1080], 2);
  assert.equal(connection.sender.applied.encodings[0].maxBitrate, 3_000_000);
  assert.equal(connection.sender.applied.degradationPreference, 'balanced');
});

test('a peer torn down while stats were pending is not recorded', async () => {
  const VoiceManager = loadVoiceManager();
  const { voice, connection } = makeSharer(VoiceManager, { local: 'relay' });
  const slow = { ...connection, getStats: () => new Promise((res) => setTimeout(() => res(connection.getStats()), 20)) };
  voice.peers.set(2, { connection: slow, username: 'viewer' });
  const pending = voice._detectRelayPath(2, slow);
  voice.peers.delete(2);
  await pending;
  assert.equal(voice._relayPeers.has(2), false);
  assert.equal(connection.sender.applied, null, 'nothing applied to a closed peer');
});

test('the userId is recovered from the connection when a caller does not pass it', async () => {
  const VoiceManager = loadVoiceManager();
  const { voice, connection } = makeSharer(VoiceManager, { local: 'relay' });
  await voice._detectRelayPath(2, connection);
  connection.sender.applied = null;
  voice._applyScreenBitrate(connection, voice._screenBitrates[1080]);
  assert.equal(connection.sender.applied.encodings[0].maxBitrate, 3_000_000);
});
