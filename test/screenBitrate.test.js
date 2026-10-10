/**
 * User-configurable screen share bitrate (300 to 10000 Kbps + unlimited).
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

test('bitrate normalizes to 300 to 10000 Kbps, 0 for unlimited, 8000 default', () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  assert.equal(voice._normalizeScreenBitrate(null), 8000);
  assert.equal(voice._normalizeScreenBitrate(''), 8000);
  assert.equal(voice._normalizeScreenBitrate('abc'), 8000);
  assert.equal(voice._normalizeScreenBitrate('0'), 0);
  assert.equal(voice._normalizeScreenBitrate(0), 0);
  assert.equal(voice._normalizeScreenBitrate(299), 300);
  assert.equal(voice._normalizeScreenBitrate(300), 300);
  assert.equal(voice._normalizeScreenBitrate(4700), 4700);
  assert.equal(voice._normalizeScreenBitrate(10000), 10000);
  assert.equal(voice._normalizeScreenBitrate(10001), 0);
  assert.equal(voice._normalizeScreenBitrate(-1), 300, 'hold-repeat below range clamps to 300, never 8000');
  assert.equal(voice._normalizeScreenBitrate(-100), 300);
});

test('user cap overrides the resolution table; unlimited returns null', () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  voice.screenBitrate = 8000;
  assert.equal(voice._screenBitrateFor(1080), 8_000_000);
  assert.equal(voice._screenBitrateFor(0), 8_000_000);
  voice.screenBitrate = 0;
  assert.equal(voice._screenBitrateFor(1080), null);
  voice.screenBitrate = undefined;
  assert.equal(voice._screenBitrateFor(1080), 8_000_000);
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
  voice.screenBitrate = 8000;
  voice._relayBitrateDebounceMs = 0; // immediate for deterministic tests
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
  voice._lastRelayScreenBitrateKey = 8_000_000; // as recorded by the initial publish
  voice.setScreenBitrate(8000); // same as current → direct peers only, no relay churn
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls, [], 'unchanged cap must not re-produce the relay source');
  voice.setScreenBitrate(6000);
  await new Promise(resolve => setTimeout(resolve, 10));
  // Cross-realm objects from the vm harness: compare structurally via JSON.
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['unpublish', 'screen'],
    ['publish', 'screen', { simulcast: true, maxBitrate: 6_000_000 }]
  ]));
  voice.setScreenBitrate(0); // unlimited carries an explicit high cap (never 2.5 Mbps)
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(calls.slice(2)), JSON.stringify([
    ['unpublish', 'screen'],
    ['publish', 'screen', { simulcast: true, maxBitrate: 14_000_000 }]
  ]));
});

test('relay republish is debounced: rapid stepper holds collapse to one re-produce', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._relayBitrateDebounceMs = 50;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  const calls = [];
  voice._relay = {
    hasPublished: () => true,
    unpublish: async (source) => { calls.push(['unpublish', source, voice.screenBitrate]); },
    publish: async (source, t, opts) => { calls.push(['publish', source, opts]); }
  };
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  // Simulate holding the + stepper: a change every 80 ms used to tear down
  // the relay producer every time. With the 50 ms debounce only the last
  // value may re-produce.
  voice.setScreenBitrate(8100);
  await new Promise(resolve => setTimeout(resolve, 10));
  voice.setScreenBitrate(8200);
  await new Promise(resolve => setTimeout(resolve, 10));
  voice.setScreenBitrate(8300);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls.filter(c => c[0] === 'unpublish').length, 1, 'one teardown for the whole hold');
  assert.equal(JSON.stringify(calls[calls.length - 1][2]), JSON.stringify({ simulcast: true, maxBitrate: 8_300_000 }));
});

test('a change landing mid-republish is not dropped (latest wins)', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._relayBitrateDebounceMs = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  let unpublished = false;
  const publishedCaps = [];
  voice._relay = {
    hasPublished: () => !unpublished,
    unpublish: async () => {
      unpublished = true;
      // Change arrives while the first republish is mid-flight (after
      // unpublish, before publish). The old code dropped it via the
      // hasPublished early-return and left the relay on the middle value.
      voice.screenBitrate = 9000;
      voice._republishRelayScreenBitrate().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
    },
    publish: async (source, t, opts) => {
      unpublished = false;
      publishedCaps.push(opts.maxBitrate);
    }
  };
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  voice.screenBitrate = 8500;
  await voice._republishRelayScreenBitrate();
  // The republish re-reads the cap after unpublish, so the single publish
  // already carries the 9 Mbps latest, never the 8.5 Mbps in-between value,
  // and the overlapping change is not dropped.
  assert.deepEqual(publishedCaps, [9_000_000]);
  assert.equal(voice._lastRelayScreenBitrateKey, 9_000_000);
});

test('a failed publish recovers on retry instead of stranding the share', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 6000;
  voice._relayBitrateDebounceMs = 0;
  voice._relayPublishRetryBaseMs = 5;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  let live = true;
  let publishes = 0;
  const publishedCaps = [];
  voice._relay = {
    hasPublished: () => live,
    unpublish: async () => { live = false; },
    publish: async (source, t, opts) => {
      publishes += 1;
      if (publishes === 1) throw new Error('transport restarting');
      live = true;
      publishedCaps.push(opts.maxBitrate);
      return { id: 'p2' };
    }
  };
  await voice._republishRelayScreenBitrate();
  assert.equal(publishes, 2, 'one failed attempt plus one retry');
  assert.deepEqual(publishedCaps, [6_000_000]);
  assert.equal(voice._lastRelayScreenBitrateKey, 6_000_000);
  assert.equal(live, true);
});

test('a persistently failing publish gives up after 3 retries', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 6000;
  voice._relayBitrateDebounceMs = 0;
  voice._relayPublishRetryBaseMs = 5;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  let publishes = 0;
  voice._relay = {
    hasPublished: () => false,
    unpublish: async () => {},
    publish: async () => { publishes += 1; throw new Error('down'); }
  };
  await voice._republishRelayScreenBitrate();
  assert.equal(publishes, 4, 'initial attempt plus 3 bounded retries');
  assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000, 'key untouched so a later change recovers');
});

test('a stop during retry backoff aborts instead of publishing into teardown', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 6000;
  voice._screenStartOperation = 0;
  voice._relayBitrateDebounceMs = 0;
  voice._relayPublishRetryBaseMs = 30;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  voice._relayScreenNeedsPublish = true; // recovery path: publish despite no live producer
  let publishes = 0;
  const actions = [];
  voice._relay = {
    hasPublished: () => false,
    unpublish: async () => {},
    publish: async (source, t, opts) => {
      publishes += 1;
      actions.push(['publish', source, opts.maxBitrate]);
      if (publishes === 1) throw new Error('transport restarting');
      return { id: `p${publishes}`, closed: false, close() {} };
    }
  };
  try {
    const republish = voice._republishRelayScreenBitrate();
    // Let the first attempt fail so the retry is sleeping in backoff, then
    // simulate stopScreenShare's synchronous prefix (op bumps while
    // isScreenSharing is still true; stop awaits its unpublish first).
    await new Promise(resolve => setTimeout(resolve, 10));
    voice._screenStartOperation = 1;
    await republish;
    assert.equal(publishes, 1, 'retry woke up under the teardown generation and aborted');
    assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000, 'stale key not committed');
    // The next share starts clean: its initial publish produces instead of
    // landing on a producer the aborted retry created mid-teardown.
    const track2 = { kind: 'video', readyState: 'live' };
    voice.screenStream = { getVideoTracks: () => [track2], getTracks: () => [track2], getAudioTracks: () => [] };
    voice.isScreenSharing = true;
    voice._screenStartOperation = 2;
    voice._relayScreenNeedsPublish = false;
    voice._lastRelayScreenBitrateKey = undefined;
    voice.screenBitrate = 8000;
    await voice._publishInitialRelayScreen();
    assert.equal(publishes, 2, 'new share publishes once');
    assert.deepEqual(actions[1], ['publish', 'screen', 8_000_000]);
    assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000);
  } finally {
    try { clearTimeout(voice._relayBitrateTimer); } catch {}
  }
});

test('a republish queued behind a slow start aborts if stop lands first', async () => {
  // The identity token is bound at schedule time, not when the queued inner
  // starts: a stop landing in the serialization queue must invalidate the
  // wait, otherwise the inner adopts the teardown generation (isScreenSharing
  // still true while stop awaits its unpublish) and re-produces mid-teardown.
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._screenStartOperation = 0;
  voice._relayBitrateDebounceMs = 0;
  voice._relayPublishRetryBaseMs = 5;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  const liveProducer = { id: 'p1', closed: false, close() {} };
  const producers = new Map([['screen', liveProducer]]);
  const actions = [];
  voice._relay = {
    producers,
    hasPublished: (s) => { const p = producers.get(s); return !!p && !p.closed; },
    unpublish: async (s) => { producers.delete(s); actions.push(['unpublish', s]); },
    unpublishIf: async (s, producer) => {
      if (!producer || producers.get(s) !== producer) return false;
      producers.delete(s);
      actions.push(['unpublishIf', s, producer.id]);
      return true;
    },
    publish: async (s, t, opts) => {
      actions.push(['publish', s, opts.maxBitrate]);
      const p = { id: `p${actions.length}`, closed: false, close() {} };
      producers.set(s, p);
      return p;
    }
  };
  voice._lastRelayScreenBitrateKey = 8_000_000;
  try {
    // Block the serialization queue behind a slow op, then schedule the
    // republish for the live share (token bound to generation 0)...
    let releaseQueue;
    const gate = new Promise(r => { releaseQueue = r; });
    voice._relayScreenEnqueue(() => gate);
    voice.screenBitrate = 7500; // genuine pending change: key mismatch is real
    voice._scheduleRelayScreenRepublish(); // debounce 0 → enqueues behind the gate
    // ...then stop starts while the republish is still queued (stuck before
    // its unpublish: op bumped, everything else intact, producer live).
    voice._screenStartOperation = 1;
    releaseQueue();
    await voice._relayScreenEnqueue(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(actions, [], 'queued republish adopted nothing, published nothing');
    assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000, 'stale key not committed');
    assert.equal(producers.get('screen'), liveProducer, 'live producer untouched');
  } finally {
    try { clearTimeout(voice._relayBitrateTimer); } catch {}
  }
});

test('a queued initial publish aborts if stop lands first', async () => {
  // Same binding rule as the republish path, for the initial publish: the
  // token is bound before the enqueue, so a stop landing while the publish
  // waits behind a slow producer invalidates it instead of being adopted at
  // execution time (isScreenSharing and screenStream are still present while
  // stop awaits its unpublish).
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._screenStartOperation = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = undefined;
  const producers = new Map();
  const actions = [];
  voice._relay = {
    producers,
    hasPublished: (s) => { const p = producers.get(s); return !!p && !p.closed; },
    unpublish: async (s) => { producers.delete(s); actions.push(['unpublish', s]); },
    unpublishIf: async (s, producer) => {
      if (!producer || producers.get(s) !== producer) return false;
      producers.delete(s);
      actions.push(['unpublishIf', s, producer.id]);
      return true;
    },
    publish: async (s, t, opts) => {
      actions.push(['publish', s, opts.maxBitrate]);
      const p = { id: `p${actions.length}`, closed: false, close() {} };
      producers.set(s, p);
      return p;
    }
  };
  try {
    // Block the queue, then enqueue the initial publish exactly like
    // shareScreen does (token bound before the enqueue)...
    let releaseQueue;
    const gate = new Promise(r => { releaseQueue = r; });
    voice._relayScreenEnqueue(() => gate);
    const token = voice._relayScreenToken();
    let innerRan = false;
    const queued = voice._relayScreenEnqueue(() => {
      innerRan = true;
      return voice._publishInitialRelayScreen(token);
    });
    // ...then stop starts while the publish is still queued.
    voice._screenStartOperation = 1;
    releaseQueue();
    await queued;
    await voice._relayScreenEnqueue(() => {});
    assert.equal(innerRan, true, 'queued publish ran and decided');
    assert.deepEqual(actions, [], 'stopped share published nothing');
    assert.equal(voice._lastRelayScreenBitrateKey, undefined, 'no key committed');
    assert.equal(producers.size, 0, 'no late producer left live');
  } finally {
    try { clearTimeout(voice._relayBitrateTimer); } catch {}
  }
});

test('stopping mid-publish removes the orphan instead of leaving it live', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = { getVideoTracks: () => [track], getTracks: () => [track] };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8500;
  voice._screenStartOperation = 0;
  voice._relayBitrateDebounceMs = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  const oldProducer = { id: 'old', closed: false, close() {} };
  const producers = new Map([['screen', oldProducer]]);
  const calls = [];
  let resolveProduce;
  voice._relay = {
    producers,
    hasPublished: (s) => { const p = producers.get(s); return !!p && !p.closed; },
    unpublish: async (s) => { producers.delete(s); calls.push(['unpublish', s]); },
    unpublishIf: async (s, producer) => {
      if (!producer || producers.get(s) !== producer) return false;
      producers.delete(s);
      calls.push(['unpublishIf', s, producer.id]);
      return true;
    },
    publish: (s, t, opts) => new Promise((resolve) => {
      calls.push(['publish-start', s, opts.maxBitrate]);
      resolveProduce = () => {
        const p = { id: 'new', closed: false, close() {} };
        producers.set(s, p);
        calls.push(['publish-resolve', s]);
        resolve(p);
      };
    })
  };
  const republish = voice._republishRelayScreenBitrate();
  const deadline = Date.now() + 1000;
  while (typeof resolveProduce !== 'function' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof resolveProduce, 'function', 'republish reached the publish await');
  // Simulate stopScreenShare's synchronous prefix while produce is pending.
  voice._screenStartOperation = 1;
  voice.isScreenSharing = false;
  resolveProduce();
  await republish;
  assert.deepEqual([...producers.keys()], [], 'orphan producer removed');
  assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000, 'stale key not committed');
  assert.ok(calls.some(c => c[0] === 'unpublishIf' && c[2] === 'new'), 'exactly our producer removed');
});

test('the initial relay publish reads the latest cap, not the pre-renegotiation one', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    getAudioTracks: () => []
  };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 9000; // moved while renegotiations were in flight
  voice._relayBitrateDebounceMs = 50;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = 8_000_000;
  const calls = [];
  voice._relay = {
    hasPublished: (s) => calls.some(c => c[0] === 'publish' && c[1] === s),
    unpublish: async (s) => { calls.push(['unpublish', s]); },
    publish: async (s, t, opts) => { calls.push(['publish', s, opts.maxBitrate]); return { id: 'p' }; }
  };
  // A change during renegotiations arms the debounce timer...
  voice._scheduleRelayScreenRepublish();
  // ...but the initial publish (which runs after renegotiations settle)
  // already carries latest, and drops the now-pointless timer.
  await voice._publishInitialRelayScreen();
  assert.deepEqual(calls, [['publish', 'screen', 9_000_000]], 'single fresh publish, no churn');
  assert.equal(voice._lastRelayScreenBitrateKey, 9_000_000);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(calls, [['publish', 'screen', 9_000_000]], 'cancelled timer never re-produces');
});

test('relay unpublishIf only removes the exact producer', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice-relay.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { createElement: () => ({}), head: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'voice-relay.js' });
  const Session = sandbox.window.HavenRelaySession;
  const emitted = [];
  const socket = { on() {}, off() {}, emit(e, d, cb) { emitted.push(e); cb({}); } };
  const session = new Session(socket, 'CODE', {});
  const p1 = { id: 'p1', closed: false, close() {} };
  session.producers.set('screen', p1);
  assert.equal(await session.unpublishIf('screen', { id: 'p1' }), false, 'different identity is not removed');
  assert.equal(session.producers.get('screen'), p1);
  assert.deepEqual(emitted, []);
  assert.equal(await session.unpublishIf('screen', p1), true);
  assert.equal(session.producers.has('screen'), false);
  assert.deepEqual(emitted, ['relay:close-producer']);
});

test('a failed initial publish retries automatically', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    getAudioTracks: () => []
  };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._relayBitrateDebounceMs = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = undefined;
  let live = false;
  let publishes = 0;
  voice._relay = {
    hasPublished: () => live,
    unpublish: async () => { live = false; },
    publish: async (source, t, opts) => {
      publishes += 1;
      if (publishes === 1) throw new Error('no transport yet');
      live = true;
      return { id: 'p2' };
    }
  };
  try {
    await voice._publishInitialRelayScreen();
    // The failed start flags recovery AND schedules it: no next bitrate
    // change is needed (#5672 review). Wait for the debounced republish to
    // finish (publishes first, key commit lands just after).
    const deadline = Date.now() + 1000;
    while ((voice._lastRelayScreenBitrateKey !== 8_000_000 || voice._relayScreenNeedsPublish) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(publishes, 2, 'failed start retries without waiting for the next change');
    assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000);
    assert.equal(voice._relayScreenNeedsPublish, false);
    assert.equal(live, true);
    // A later change still re-produces with the new cap.
    voice.screenBitrate = 6000;
    await voice._republishRelayScreenBitrate();
    assert.equal(publishes, 3, 'a later change re-produces with the new cap');
    assert.equal(voice._lastRelayScreenBitrateKey, 6_000_000);
    assert.equal(voice._relayScreenNeedsPublish, false);
    assert.equal(live, true);
  } finally {
    try { clearTimeout(voice._relayBitrateTimer); } catch {}
  }
});

test('stopping during the initial publish leaves no orphan', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    getAudioTracks: () => []
  };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._screenStartOperation = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  const producers = new Map();
  let resolveProduce;
  voice._relay = {
    producers,
    hasPublished: (s) => { const p = producers.get(s); return !!p && !p.closed; },
    unpublish: async (s) => { producers.delete(s); },
    unpublishIf: async (s, producer) => {
      if (!producer || producers.get(s) !== producer) return false;
      producers.delete(s);
      return true;
    },
    publish: (s, t, opts) => new Promise((resolve) => {
      resolveProduce = () => {
        const p = { id: 'p1', closed: false, close() {} };
        producers.set(s, p);
        resolve(p);
      };
    })
  };
  const initial = voice._publishInitialRelayScreen();
  const deadline = Date.now() + 1000;
  while (typeof resolveProduce !== 'function' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof resolveProduce, 'function', 'initial publish reached produce');
  // Simulate stopScreenShare's synchronous prefix while produce is pending.
  voice._screenStartOperation = 1;
  voice.isScreenSharing = false;
  resolveProduce();
  await initial;
  assert.deepEqual([...producers.keys()], [], 'late producer cleaned up by identity');
  assert.equal(voice._lastRelayScreenBitrateKey, undefined, 'stale key not committed');
});

test('a change during the initial produce is applied after, never lost', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    getAudioTracks: () => []
  };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._screenStartOperation = 0;
  voice._relayBitrateDebounceMs = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = undefined;
  const producers = new Map();
  const publishedCaps = [];
  let resolveProduce;
  let n = 0;
  voice._relay = {
    producers,
    hasPublished: (s) => { const p = producers.get(s); return !!p && !p.closed; },
    unpublish: async (s) => { producers.delete(s); },
    unpublishIf: async (s, producer) => {
      if (!producer || producers.get(s) !== producer) return false;
      producers.delete(s);
      return true;
    },
    publish: (s, t, opts) => {
      publishedCaps.push(opts.maxBitrate);
      if (resolveProduce === undefined && s === 'screen' && publishedCaps.length === 1) {
        return new Promise((resolve) => {
          resolveProduce = () => {
            n += 1;
            const p = { id: `p${n}`, closed: false, close() {} };
            producers.set(s, p);
            resolve(p);
          };
        });
      }
      n += 1;
      const p = { id: `p${n}`, closed: false, close() {} };
      producers.set(s, p);
      return Promise.resolve(p);
    }
  };
  // Serialized: the initial publish runs first...
  const initial = voice._relayScreenEnqueue(() => voice._publishInitialRelayScreen());
  const deadline = Date.now() + 1000;
  while (typeof resolveProduce !== 'function' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof resolveProduce, 'function', 'initial publish reached produce');
  // ...a change lands while produce is pending: its republish queues behind
  // the initial instead of racing it and getting dropped.
  voice.screenBitrate = 9000;
  voice.reapplyScreenBitrate();
  resolveProduce();
  await initial;
  const doneBy = Date.now() + 1000;
  while (voice._lastRelayScreenBitrateKey !== 9_000_000 && Date.now() < doneBy) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(publishedCaps, [8_000_000, 9_000_000], 'initial cap then the newer one, nothing lost');
  assert.equal(voice._lastRelayScreenBitrateKey, 9_000_000);
  assert.equal(producers.size, 1, 'exactly one live producer');
});

test('relay screen mutations never interleave', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const first = voice._relayScreenEnqueue(async () => { order.push('first-start'); await gate; order.push('first-end'); return 'a'; });
  const second = voice._relayScreenEnqueue(async () => { order.push('second'); return 'b'; });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(order, ['first-start'], 'second waits for first');
  release();
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('a failed relay-restart publish recovers on the next change', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const track = { kind: 'video', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    getAudioTracks: () => []
  };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  voice._lastRelayScreenBitrateKey = undefined;
  let live = false;
  let publishes = 0;
  voice._relay = {
    hasPublished: () => live,
    unpublish: async () => { live = false; },
    publish: async (source, t, opts) => {
      publishes += 1;
      if (publishes === 1) throw new Error('restart racing');
      live = true;
      return { id: 'p2' };
    }
  };
  try {
    await voice._publishRelayTracks();
    assert.equal(publishes, 1);
    assert.equal(voice._lastRelayScreenBitrateKey, undefined, 'failed restart records no key');
    assert.equal(voice._relayScreenNeedsPublish, true, 'failed restart flags recovery');
    voice.screenBitrate = 6000;
    await voice._republishRelayScreenBitrate();
    assert.equal(publishes, 2, 'the next change recovers the missing producer');
    assert.equal(voice._lastRelayScreenBitrateKey, 6_000_000);
    assert.equal(voice._relayScreenNeedsPublish, false);
    assert.equal(live, true);
  } finally {
    try { clearTimeout(voice._relayBitrateTimer); } catch {}
  }
});

test('stopping during the initial audio publish leaves no audio orphan', async () => {
  const { VoiceManager } = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const videoTrack = { kind: 'video', readyState: 'live' };
  const audioTrack = { kind: 'audio', readyState: 'live' };
  voice.peers = new Map();
  voice.screenStream = {
    getVideoTracks: () => [videoTrack],
    getTracks: () => [videoTrack, audioTrack],
    getAudioTracks: () => [audioTrack]
  };
  voice.isScreenSharing = true;
  voice.screenResolution = 0;
  voice.screenFrameRate = 60;
  voice.screenBitrate = 8000;
  voice._screenStartOperation = 0;
  voice._screenRelayProfileEnabled = () => false;
  voice._screenRelayAutoEnabled = () => false;
  voice._relayPeers = new Set();
  voice._prioritiseAudioSenders = () => {};
  const producers = new Map();
  let n = 0;
  let resolveAudio;
  voice._relay = {
    producers,
    hasPublished: (s) => { const p = producers.get(s); return !!p && !p.closed; },
    unpublish: async (s) => { producers.delete(s); },
    unpublishIf: async (s, producer) => {
      if (!producer || producers.get(s) !== producer) return false;
      producers.delete(s);
      return true;
    },
    publish: (s, t, opts) => {
      if (s === 'screen-audio' && typeof resolveAudio !== 'function') {
        return new Promise((resolve) => {
          resolveAudio = () => {
            n += 1;
            const p = { id: `pa${n}`, closed: false, close() {} };
            producers.set(s, p);
            resolve(p);
          };
        });
      }
      n += 1;
      const p = { id: `p${n}`, closed: false, close() {} };
      producers.set(s, p);
      return Promise.resolve(p);
    }
  };
  const initial = voice._publishInitialRelayScreen();
  const deadline = Date.now() + 1000;
  while (typeof resolveAudio !== 'function' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof resolveAudio, 'function', 'initial publish reached audio produce');
  // Simulate stopScreenShare's synchronous prefix while audio produce pends.
  // (The video producer stays: removing it is stop's own unpublish job.)
  voice._screenStartOperation = 1;
  voice.isScreenSharing = false;
  resolveAudio();
  await initial;
  assert.equal(producers.has('screen-audio'), false, 'late audio producer cleaned up');
  assert.equal(voice._lastRelayScreenBitrateKey, 8_000_000, 'video key committed while valid');
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
