'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
function rig({ deafened }) {
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const els = new Map();
  const container = { appendChild: (el) => els.set(el.id, el) };
  global.document = {
    getElementById: (id) => id === 'audio-container' ? container : els.get(id) || null,
    createElement: () => ({ volume: 1, dataset: new Proxy({}, { set: (t, k, v) => (t[k] = String(v), true) }), play: () => Promise.resolve(), remove() { els.delete(this.id); } }),
    querySelectorAll: () => [...els.values()],
  };
  delete require.cache[require.resolve('../public/js/voice.js')];
  const { VoiceManager } = require('../public/js/voice.js');
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  const voice = Object.assign(Object.create(VoiceManager.prototype), {
    gainNodes: new Map(), screenGainNodes: new Map(), isDeafened: deafened, _botAudio: null,
    audioCtx: { createMediaStreamSource: node, createAnalyser: node, createGain: node },
    _ensureAudioCtx() {}, _startAnalyser() {}, _voiceOut: node,
  });
  return { voice, els };
}
test.afterEach(() => { delete global.localStorage; delete global.document; });
test('a person who joins while you are deafened stays on the one Web Audio path after you undeafen', () => {
  const { voice, els } = rig({ deafened: true });
  voice._playAudio(7, {});
  assert.equal(voice.gainNodes.get(7).gain.value, 0);
  voice.toggleDeafen();
  assert.equal(voice.gainNodes.get(7).gain.value, 1);
  assert.equal(els.get('voice-audio-7').volume, 0);
});
test('a person already in the room is restored to the same state after deafen and undeafen', () => {
  const { voice, els } = rig({ deafened: false });
  voice._playAudio(7, {});
  voice.toggleDeafen();
  assert.equal(voice.gainNodes.get(7).gain.value, 0);
  voice.toggleDeafen();
  assert.equal(voice.gainNodes.get(7).gain.value, 1);
  assert.equal(els.get('voice-audio-7').volume, 0);
});
test('an element played natively comes back at its saved volume after undeafen', () => {
  const { voice, els } = rig({ deafened: true });
  voice.audioCtx = { createMediaStreamSource() { throw new Error('no web audio'); } };
  voice._playAudio(7, {});
  assert.equal(els.get('voice-audio-7').volume, 0);
  voice.toggleDeafen();
  assert.equal(els.get('voice-audio-7').volume, 1);
});
