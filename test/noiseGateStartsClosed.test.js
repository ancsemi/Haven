'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const real = { setInterval, clearInterval, setTimeout, clearTimeout };
const node = () => ({ connect() {}, disconnect() {} });
function rig(sensitivity) {
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const intervals = [];
  const timeouts = new Set();
  global.setInterval = (fn) => (intervals.push(fn), intervals.length);
  global.clearInterval = () => {};
  global.setTimeout = (fn) => { const t = { fn }; timeouts.add(t); return t; };
  global.clearTimeout = (t) => timeouts.delete(t);
  delete require.cache[require.resolve('../public/js/voice.js')];
  const { VoiceManager } = require('../public/js/voice.js');
  const gain = Object.assign(node(), { gain: { value: 1, setTargetAtTime(v) { this.value = v; } } });
  const analyser = () => Object.assign(node(), { raw: 0, frequencyBinCount: 8, getByteFrequencyData(arr) { arr.fill(this.raw * (this.tap ? gain.gain.value : 1)); } });
  const gateAnalyser = analyser();
  const tap = [];
  const sent = [];
  const voice = Object.assign(Object.create(VoiceManager.prototype), {
    audioCtx: { currentTime: 0, createMediaStreamSource: node, createAnalyser: () => { const a = Object.assign(analyser(), { tap: true }); tap.push(a); return a; } },
    inVoice: true,
    isMuted: false,
    rawStream: {},
    noiseSensitivity: sensitivity,
    talkingState: new Map(),
    onTalkingChange() {},
    socket: { emit: (name, data) => sent.push([name, data && data.speaking]) },
    _noiseGateAnalyser: gateAnalyser,
    _noiseGateGain: gain,
  });
  voice._startNoiseGate();
  voice._startLocalTalkDetection();
  const [gateTick, talkTick] = intervals;
  const level = (v) => { gateAnalyser.raw = v; tap[0].raw = v; };
  const flush = () => { for (const t of [...timeouts]) { timeouts.delete(t); t.fn(); } };
  const run = (n) => { for (let i = 0; i < n; i++) { gateTick(); talkTick(); } };
  return { level, run, flush, gain, sent, voice, lit: () => voice.talkingState.has('self') };
}
test.afterEach(() => {
  delete global.localStorage;
  Object.assign(global, real);
});
test('a gate that never heard speech is closed, so steady noise below the threshold is not sent or lit', () => {
  const r = rig(100);
  r.level(20);
  r.run(6);
  assert.equal(r.gain.gain.value, 0);
  assert.equal(r.lit(), false);
  assert.deepEqual(r.sent.filter(([, s]) => s === true), []);
});
test('a closed gate opens for speech and closes again after it', () => {
  const r = rig(100);
  r.level(20);
  r.run(4);
  r.level(50);
  r.run(4);
  assert.equal(r.gain.gain.value, 1);
  assert.equal(r.lit(), true);
  r.level(20);
  r.run(2);
  r.flush();
  r.run(2);
  r.flush();
  assert.equal(r.gain.gain.value, 0);
  assert.equal(r.lit(), false);
});
test('with the gate off the mic stays open', () => {
  const r = rig(0);
  r.level(20);
  r.run(4);
  assert.equal(r.gain.gain.value, 1);
  assert.equal(r.lit(), true);
});
test('turning the gate on while the mic is open closes it on the next quiet moment', () => {
  const r = rig(0);
  r.level(20);
  r.run(2);
  r.voice.setNoiseSensitivity(100);
  r.run(2);
  assert.equal(r.gain.gain.value, 0);
});
