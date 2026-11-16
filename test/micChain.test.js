'use strict';

// The mic chain a call sends (noise gate and AI suppression) is built by one
// piece of voice.js, used by joining, switching microphone, and the settings
// mic test (MicChain). The test must sound like a call, and must never touch
// a running call's chain.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');

// A small Web Audio stand-in: nodes remember what they connect to.
function fakeNode(kind, extra = {}) {
  const node = {
    kind,
    targets: new Set(),
    connect(target) { node.targets.add(target); return target; },
    disconnect(target) { if (target) node.targets.delete(target); else node.targets.clear(); },
    ...extra,
  };
  return node;
}
function fakeAudioContext() {
  const contexts = [];
  class Ctx {
    constructor(opts) {
      this.opts = opts;
      this.sampleRate = opts?.sampleRate || 44100;
      this.currentTime = 0;
      this.closed = false;
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    createMediaStreamSource(stream) { return fakeNode('source', { stream }); }
    createAnalyser() {
      return fakeNode('analyser', {
        fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 8, level: 25,
        getByteFrequencyData(arr) { arr.fill(this.level); },
      });
    }
    createGain() { return fakeNode('gain', { gain: { value: 1, setTargetAtTime(v) { this.value = v; } } }); }
    createMediaStreamDestination() { return fakeNode('dest', { stream: { id: 'processed' } }); }
    close() { this.closed = true; }
  }
  Ctx.contexts = contexts;
  return Ctx;
}

function load({ saved = {} } = {}) {
  const store = { ...saved };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  global.AudioContext = fakeAudioContext();
  const workletNodes = [];
  global.AudioWorkletNode = class {
    constructor() {
      Object.assign(this, fakeNode('rnnoise'));
      this.messages = [];
      this.port = { postMessage: (m) => this.messages.push(m.type), onmessage: null, onmessageerror: null };
      workletNodes.push(this);
    }
  };
  delete require.cache[require.resolve('../public/js/voice.js')];
  const { VoiceManager, MicChain } = require('../public/js/voice.js');
  return { VoiceManager, MicChain, store, workletNodes, Ctx: global.AudioContext };
}

// MicChain with AI suppression "loaded" (the real loader fetches the model).
function chainWithModel(MicChain, stream, opts) {
  const chain = new MicChain(stream, opts);
  chain._initRNNoise = async () => { chain._rnnoiseWasmBytes = new ArrayBuffer(4096); };
  return chain;
}

test.afterEach(() => {
  delete global.localStorage;
  delete global.AudioContext;
  delete global.AudioWorkletNode;
});

test('the settings mic test runs the call\'s own gate and suppression code', () => {
  const { VoiceManager, MicChain } = load();
  for (const name of ['_buildMicChain', '_applyStartingNoiseMode', '_applyNoiseMode', 'setNoiseSensitivity',
    '_initRNNoise', '_enableRNNoise', '_disableRNNoise', '_startNoiseGate', '_stopNoiseGate']) {
    assert.equal(MicChain.prototype[name], VoiceManager.prototype[name], `${name} is the call's method`);
  }
});

test('joining and switching microphone build the chain in one place', () => {
  assert.equal((SOURCE.match(/this\._buildMicChain\(this\.rawStream\)/g) || []).length, 2);
  assert.equal((SOURCE.match(/createMediaStreamSource\(rawStream\)/g) || []).length, 1, 'one copy of the wiring');
  assert.equal((SOURCE.match(/this\._applyStartingNoiseMode\(\)/g) || []).length, 3, 'join, switch, and the test');
});

test('the chain sends the raw mic through the gate, with the meter analyser on the raw mic', () => {
  const { MicChain, Ctx } = load();
  const chain = new MicChain({ id: 'raw' });
  const ctx = Ctx.contexts[0];
  assert.equal(ctx.opts.sampleRate, 48000, 'the rate RNNoise needs, as in a call');
  const source = chain._rnnoiseSource;
  assert.equal(source.stream.id, 'raw');
  const analyser = chain._noiseGateAnalyser;
  assert.equal(analyser.fftSize, 2048);
  assert.equal(analyser.smoothingTimeConstant, 0.3);
  assert.ok(source.targets.has(analyser));
  assert.ok(source.targets.has(chain._noiseGateGain));
  assert.equal(chain.stream.id, 'processed');
  chain.destroy();
});

test('gate mode uses the saved sensitivity and the gate closes on quiet input', async () => {
  const { MicChain } = load({ saved: { haven_ns_value: '60' } });
  const chain = chainWithModel(MicChain, {}, { noiseMode: 'gate' });
  await chain.ready();
  assert.equal(chain.noiseSensitivity, 60);
  assert.ok(chain._noiseGateInterval, 'the gate loop runs');
  chain.destroy();
  assert.equal(chain._noiseGateInterval, null);
});

test('suppress mode wires AI suppression in front of the gate', async () => {
  const { MicChain, workletNodes } = load();
  const chain = chainWithModel(MicChain, {}, { noiseMode: 'suppress' });
  await chain.ready();
  assert.equal(workletNodes.length, 1);
  const node = workletNodes[0];
  assert.ok(chain._rnnoiseSource.targets.has(node));
  assert.ok(!chain._rnnoiseSource.targets.has(chain._noiseGateGain), 'the raw mic no longer bypasses it');
  assert.ok(node.targets.has(chain._noiseGateGain));
  assert.equal(chain.noiseSensitivity, 0);
  assert.deepEqual(node.messages, ['wasm-bytes']);
  chain.destroy();
  assert.deepEqual(node.messages, ['wasm-bytes', 'destroy']);
});

test('changing mode during the test applies it without saving it', async () => {
  const { MicChain, store, workletNodes } = load({ saved: { haven_noise_mode: 'gate', haven_ns_value: '30' } });
  const chain = chainWithModel(MicChain, {}, { noiseMode: 'gate' });
  await chain.ready();
  chain.setNoiseMode('suppress');
  assert.equal(workletNodes.length, 1);
  chain.setNoiseMode('off');
  assert.equal(chain._rnnoiseNode, null);
  assert.equal(chain.noiseSensitivity, 0);
  chain.setNoiseMode('gate');
  assert.equal(chain.noiseSensitivity, 30);
  assert.equal(store.haven_noise_mode, 'gate', 'the test never writes the setting; the settings layer does');
  chain.destroy();
});

test('destroy closes the test\'s own context and nothing else', async () => {
  const { MicChain, Ctx } = load();
  const a = chainWithModel(MicChain, {}, { noiseMode: 'gate' });
  const b = chainWithModel(MicChain, {}, { noiseMode: 'gate' });
  await a.ready();
  a.destroy();
  assert.equal(Ctx.contexts[0].closed, true);
  assert.equal(Ctx.contexts[1].closed, false);
  assert.doesNotThrow(() => a.destroy(), 'twice is fine');
  b.destroy();
});

test('a call still saves its noise mode and applies it', () => {
  const { VoiceManager, store } = load();
  const voice = Object.create(VoiceManager.prototype);
  const applied = [];
  voice._applyNoiseMode = (mode) => applied.push(mode);
  voice.setNoiseMode('off');
  assert.equal(voice.noiseMode, 'off');
  assert.equal(store.haven_noise_mode, 'off');
  assert.deepEqual(applied, ['off']);
});

test('after switching microphone the soundboard still mixes into what is sent', () => {
  // Join sets _vcDest; switching microphone built a new chain and left the
  // soundboard on the old one, so clips stopped reaching the call.
  const start = SOURCE.indexOf('async switchInputDevice(');
  const end = SOURCE.indexOf('\n  }\n', start);
  const body = SOURCE.slice(start, end);
  const build = body.indexOf('const dest = this._buildMicChain(this.rawStream);');
  assert.ok(build > 0);
  assert.ok(body.indexOf('this._vcDest = dest;', build) > build);
});
