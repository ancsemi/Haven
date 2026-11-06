'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');
const track = (kind) => {
  const listeners = [];
  const t = { kind, readyState: 'live', enabled: true, stop: () => { t.readyState = 'ended'; }, addEventListener: (e, f) => { if (e === 'ended') listeners.push(f); }, lose: () => { t.readyState = 'ended'; listeners.forEach((f) => f()); } };
  return t;
};
const stream = (tracks) => ({ getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => [] });
const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} }, frequencyBinCount: 8, getByteFrequencyData() {} });
const made = [];
test.afterEach(() => made.splice(0).forEach((v) => v.leave()));
function setup({ store = {}, failing = [] } = {}) {
  const raws = [];
  const asked = [];
  const deviceChange = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = node(); }
    addEventListener() {}
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createAnalyser() { return node(); }
    createGain() { return node(); }
    createMediaStreamDestination() { return Object.assign(node(), { stream: stream([track('audio')]) }); }
  }
  const mediaDevices = {
    getUserMedia: async (c) => {
      const id = c.audio.deviceId ? c.audio.deviceId.exact : '';
      asked.push(id);
      if (failing.includes(id)) throw new Error('NotFoundError');
      const t = track('audio');
      raws.push(t);
      return stream([t]);
    },
    addEventListener: (e, f) => { if (e === 'devicechange') deviceChange.push(f); }
  };
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0, mediaDevices },
    document: { getElementById: () => null },
    window: { AudioContext },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console: { log() {}, warn() {}, error() {} },
    AudioContext,
    MediaStream: function MediaStream(t) { return stream(t || []); },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const voice = new context.module.exports({ connected: true, on() {}, emit() {} });
  voice._fetchIceServers = async () => {};
  voice._ensureStunProbed = () => {};
  voice._initRNNoise = async () => {};
  voice.getRelayClientInfo = () => ({});
  made.push(voice);
  return { voice, raws, asked, store, deviceChange, failing };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const liveRaws = (raws) => raws.filter((t) => t.readyState === 'live').length;
test('a microphone that ends mid-call is opened again', async () => {
  const { voice, raws } = setup();
  await voice.join('aaaaaaaa');
  raws[0].lose();
  await tick();
  assert.equal(raws.length, 2);
  assert.equal(liveRaws(raws), 1);
  assert.equal(voice.rawStream.getAudioTracks()[0], raws[1]);
  assert.equal(voice.inVoice, true);
  voice.leave();
  assert.equal(liveRaws(raws), 0);
});
test('a lost saved microphone falls back to the default and keeps the saved choice', async () => {
  const { voice, raws, asked, store, failing } = setup({ store: { haven_input_device: 'usb' } });
  await voice.join('aaaaaaaa');
  failing.push('usb');
  raws[0].lose();
  await tick();
  assert.deepEqual(asked, ['usb', 'usb', '']);
  assert.equal(liveRaws(raws), 1);
  assert.equal(store.haven_input_device, 'usb');
});
test('when no microphone can be opened it waits for a device change and tries again', async () => {
  const { voice, raws, deviceChange } = setup();
  await voice.join('aaaaaaaa');
  voice.switchInputDevice = async () => false;
  raws[0].lose();
  await tick();
  assert.equal(deviceChange.length, 1);
  voice.switchInputDevice = async () => true;
  deviceChange[0]();
  await tick();
  assert.equal(deviceChange.length, 1);
  voice.leave();
});
test('a microphone that keeps ending right after it is reopened is not reopened in a loop', async () => {
  const { voice, raws, asked, deviceChange } = setup();
  await voice.join('aaaaaaaa');
  raws[0].lose();
  await tick();
  raws[1].lose();
  await tick();
  assert.equal(asked.length, 2);
  assert.equal(deviceChange.length, 1);
  voice.leave();
});
test('a microphone that ends after leaving, or after a manual switch, is ignored', async () => {
  const left = setup();
  await left.voice.join('aaaaaaaa');
  left.voice.leave();
  left.raws[0].lose();
  await tick();
  assert.equal(left.raws.length, 1);
  const switched = setup();
  await switched.voice.join('aaaaaaaa');
  await switched.voice.switchInputDevice('other');
  switched.raws[0].lose();
  await tick();
  assert.equal(switched.raws.length, 2);
  assert.equal(liveRaws(switched.raws), 1);
  switched.voice.leave();
});
test('leaving while the lost microphone is being reopened leaves no microphone on', async () => {
  const { voice, raws } = setup();
  await voice.join('aaaaaaaa');
  raws[0].lose();
  voice.leave();
  await tick();
  assert.equal(liveRaws(raws), 0);
});
test('a muted call stays muted on the reopened microphone', async () => {
  const { voice, raws } = setup();
  await voice.join('aaaaaaaa');
  voice.isMuted = true;
  voice._applyMuteStateToLocalTracks();
  raws[0].lose();
  await tick();
  assert.equal(raws[1].enabled, false);
  voice.leave();
});
