/**
 * User-configurable screen share bitrate (300–10000 Kbps + unlimited).
 *
 *   node --test test/screenBitrate.test.js
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
  return { VoiceManager: context.module.exports, storage };
}

function fakeSender(videoTrack) {
  return {
    track: videoTrack,
    applied: null,
    getParameters() { return { encodings: [{}] }; },
    setParameters(p) { this.applied = p; return Promise.resolve(); }
  };
}

function makeSharer(VoiceManager, { bitrate, resolution = 0 } = {}) {
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = resolution;
  voice.screenFrameRate = 60;
  if (bitrate !== undefined) voice.screenBitrate = bitrate;
  voice._screenBitrates = { 0: 8_000_000, 720: 4_000_000, 1080: 8_000_000, 1440: 14_000_000 };
  const sender = fakeSender(track);
  const connection = { sender, getSenders: () => [sender] };
  voice.peers.set(2, { connection, username: 'viewer' });
  return { voice, connection, sender };
}

test('bitrate normalizes to 300–10000 Kbps, 0 for unlimited, 4000 default', () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  assert.equal(voice._normalizeScreenBitrate(null), 4000);
  assert.equal(voice._normalizeScreenBitrate(''), 4000);
  assert.equal(voice._normalizeScreenBitrate('abc'), 4000);
  assert.equal(voice._normalizeScreenBitrate('0'), 0);
  assert.equal(voice._normalizeScreenBitrate(0), 0);
  assert.equal(voice._normalizeScreenBitrate(299), 300);
  assert.equal(voice._normalizeScreenBitrate(300), 300);
  assert.equal(voice._normalizeScreenBitrate(4700), 4700);
  assert.equal(voice._normalizeScreenBitrate(10000), 10000);
  assert.equal(voice._normalizeScreenBitrate(10001), 0);
});

test('user cap overrides the resolution table; unlimited returns null', () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  voice.screenBitrate = 4000;
  assert.equal(voice._screenBitrateFor(1080), 4_000_000);
  assert.equal(voice._screenBitrateFor(0), 4_000_000);
  voice.screenBitrate = 0;
  assert.equal(voice._screenBitrateFor(1080), null);
  voice.screenBitrate = undefined;
  assert.equal(voice._screenBitrateFor(1080), 4_000_000);
});

test('relay profile still wins on relayed paths', () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  voice.screenBitrate = 10000;
  assert.equal(voice._screenBitrateFor(1080, true), 3_000_000);
});

test('setScreenBitrate persists and re-applies live', () => {
  const { VoiceManager, storage } = loadVoiceManager();
  const { voice, sender } = makeSharer(VoiceManager, { bitrate: 4000 });
  voice.setScreenBitrate(2500);
  assert.equal(voice.screenBitrate, 2500);
  assert.equal(storage.haven_screen_bitrate, '2500');
  assert.equal(sender.applied.encodings[0].maxBitrate, 2_500_000);
});

test('unlimited removes the sender cap instead of writing zero', () => {
  const { VoiceManager } = loadVoiceManager();
  const { voice, sender } = makeSharer(VoiceManager, { bitrate: 8000 });
  voice._applyScreenBitrate(
    voice.peers.get(2).connection,
    voice._screenBitrateFor(1080),
    2
  );
  assert.equal(sender.applied.encodings[0].maxBitrate, 8_000_000);
  voice.setScreenBitrate(0);
  assert.ok(!('maxBitrate' in sender.applied.encodings[0]), 'cap removed for unlimited');
  assert.equal(sender.applied.encodings[0].maxFramerate, 60);
  assert.equal(sender.applied.degradationPreference, 'maintain-framerate');
});

test('bitrate changes re-produce the relayed screen source live', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 4000;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  const calls = [];
  voice._relay = {
    hasPublished: (source) => source === 'screen',
    unpublish: async (source) => { calls.push(['unpublish', source]); },
    publish: async (source, t, opts) => { calls.push(['publish', source, opts]); }
  };
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 4_000_000; // as recorded by the initial publish
  voice.setScreenBitrate(4000); // same as current → direct peers only, no relay churn
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls, [], 'unchanged cap must not re-produce the relay source');
  voice.setScreenBitrate(6000);
  await new Promise(resolve => setTimeout(resolve, 10));
  // Cross-realm objects from the vm harness: compare structurally via JSON.
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['unpublish', 'screen'],
    ['publish', 'screen', { simulcast: true, maxBitrate: 6_000_000 }]
  ]));
  voice.setScreenBitrate(0); // unlimited omits the cap
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(calls.slice(2)), JSON.stringify([
    ['unpublish', 'screen'],
    ['publish', 'screen', { simulcast: true }]
  ]));
});

test('keyframe requests only touch screen video senders', () => {
  const { VoiceManager } = loadVoiceManager();
  const { voice, connection } = makeSharer(VoiceManager, { bitrate: 4000 });
  const screenTrack = voice.screenStream.getVideoTracks()[0];
  const otherTrack = { kind: 'video', readyState: 'live' };
  let keyframes = 0;
  connection.getSenders = () => [
    { track: screenTrack, generateKeyFrame() { keyframes++; return Promise.resolve(); } },
    { track: otherTrack, generateKeyFrame() { keyframes += 100; return Promise.resolve(); } },
    { track: { kind: 'audio' } }
  ];
  voice._requestScreenKeyframe();
  assert.equal(keyframes, 1);
  voice.isScreenSharing = false;
  voice._requestScreenKeyframe();
  assert.equal(keyframes, 1, 'no-op when not sharing');
});
