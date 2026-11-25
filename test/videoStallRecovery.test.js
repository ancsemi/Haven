'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const registerVoice = require('../src/socketHandlers/voice');
const VideoStallWatch = require('../public/js/video-stall.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public/js', f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const report = (framesDecoded) => new Map([['i', { type: 'inbound-rtp', kind: 'video', framesDecoded }]]);
function rig(extra = {}) {
  const clock = { t: 0 }, fired = [], frames = { n: 0 }, track = { id: 'v1', readyState: 'live' };
  const target = { key: 'k', track, stats: async () => report(frames.n), ...extra };
  const watch = new VideoStallWatch({ targets: () => [target], onStall: async (t, step) => { fired.push([clock.t / 1000, step]); return extra.verdict && extra.verdict(); }, now: () => clock.t });
  const run = async (seconds, perTick) => { for (let i = 0; i < seconds / 2; i++) { clock.t += 2000; perTick && perTick(); await watch.tick(); } };
  return { clock, fired, frames, track, target, watch, run };
}
test('a video that keeps decoding is never reported', async () => {
  const r = rig();
  await r.run(60, () => { r.frames.n += 30; });
  assert.deepEqual(r.fired, []);
});
test('a video that stops decoding is reported in two steps, then retried, and clears when frames resume', async () => {
  const r = rig();
  await r.run(10, () => { r.frames.n += 30; });
  await r.run(40);
  assert.deepEqual(r.fired.slice(0, 3), [[18, 1], [24, 2], [40, 2]]);
  const seen = r.fired.length;
  await r.run(4, () => { r.frames.n += 30; });
  await r.run(6);
  assert.equal(r.fired.length, seen, 'a recovered video starts over instead of continuing');
  await r.run(4);
  assert.equal(r.fired.length, seen + 1);
  assert.deepEqual(r.fired.at(-1)[1], 1);
});
test('a video that never decoded a frame is left to the black-tile watchdog', async () => {
  const r = rig();
  await r.run(60);
  assert.deepEqual(r.fired, []);
});
test('an ended track, a replaced track and a held target do not escalate', async () => {
  const r = rig();
  await r.run(4, () => { r.frames.n += 30; });
  r.track.readyState = 'ended';
  await r.run(30);
  assert.deepEqual(r.fired, []);
  const h = rig({ verdict: () => 'hold' });
  await h.run(4, () => { h.frames.n += 30; });
  await h.run(40);
  assert.ok(h.fired.every(([, step]) => step === 1), 'held target stays at step one');
  assert.ok(h.fired.length >= 2 && h.fired.length <= 5);
});
test('the relay session asks for a keyframe and swaps in a fresh consumer on request', async () => {
  const sandbox = { window: {}, document: { createElement: () => ({}), head: { appendChild() {} } }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout };
  vm.runInContext(read('voice-relay.js'), vm.createContext(sandbox), { filename: 'voice-relay.js' });
  const sent = [], delivered = [];
  const socket = { on() {}, off() {}, emit(event, data, cb) { sent.push([event, data]); cb(event === 'relay:consume' ? { consumer: { id: 'c2', producerId: 'p1', kind: 'video', rtpParameters: {}, userId: 7, source: 'screen' } } : event === 'relay:keyframe' ? { paused: data.consumerId === 'paused' } : {}); } };
  const session = new sandbox.window.HavenRelaySession(socket, 'CODE', { onTrack: (t) => delivered.push(t), onTrackEnded: () => delivered.push('ended') });
  const closed = [];
  const old = { id: 'c1', kind: 'video', closed: false, track: { id: 't1' }, getStats: async () => report(1), on() {}, close() { closed.push('c1'); } };
  session.consumers.set('p1', { consumer: old, userId: 7, source: 'screen' });
  session.consumers.set('pa', { consumer: { id: 'x', kind: 'audio', closed: false, track: {} }, userId: 7, source: 'mic' });
  session.device = { rtpCapabilities: { codecs: [] } };
  session.recvTransport = { consume: async (o) => ({ id: o.id, kind: o.kind, closed: false, track: { id: 't2' }, on() {}, close() {} }) };
  const targets = session.stallTargets();
  assert.deepEqual(plain(targets.map((t) => [t.key, t.producerId, t.source])), [['relay:screen:7', 'p1', 'screen']]);
  assert.equal(await session.requestKeyFrame('p1'), null);
  assert.deepEqual(plain(sent.pop()), ['relay:keyframe', { code: 'CODE', consumerId: 'c1' }]);
  session.consumers.get('p1').consumer.id = 'paused';
  assert.equal(await session.requestKeyFrame('p1'), 'hold');
  session.consumers.get('p1').consumer.id = 'c1';
  await session.resubscribe('p1');
  assert.deepEqual(sent.filter(([e]) => e === 'relay:consume')[0][1].fresh, true);
  assert.deepEqual(plain(closed), ['c1']);
  assert.equal(session.consumers.get('p1').consumer.id, 'c2');
  assert.deepEqual(plain(delivered).map((d) => d === 'ended' ? d : d.track.id), ['t2'], 'the tile gets the new track without an ended notice in between');
  assert.equal(await session.resubscribe('missing'), null);
});
function loadVoice() {
  const context = vm.createContext({ module: { exports: {} }, navigator: { userAgent: '', platform: '', maxTouchPoints: 0 }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, console: { log() {}, warn() {}, error() {} }, RTCSessionDescription: function (d) { return d; }, setTimeout, clearTimeout, Date });
  vm.runInContext(`${read('voice.js')}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return context.module.exports;
}
function voiceWith(peers) {
  const voice = Object.create(loadVoice().prototype), emitted = [];
  Object.assign(voice, { peers: new Map(peers), inVoice: true, currentChannel: 'aaaaaaaa', screenSharers: new Set([2]), webcamUsers: new Set(), _callTransport: 'direct', _relay: null, socket: { emit: (...a) => emitted.push(a), on() {} } });
  voice._isRelayedPeer = () => false;
  voice._screenTileTrackId = () => null;
  return { voice, emitted };
}
const receiver = (id, kind = 'video') => ({ track: { id, kind, readyState: 'live' }, getStats: async () => report(5) });
test('the viewer finds the sharer\'s screen receiver and asks for a keyframe, then a renegotiation', async () => {
  const peer = { connection: { connectionState: 'connected', getReceivers: () => [receiver('a', 'audio'), receiver('scr')] }, _screenTrackId: 'scr' };
  const { voice, emitted } = voiceWith([[2, peer]]);
  const targets = voice._stallTargets();
  assert.deepEqual(plain(targets.map((t) => [t.key, t.userId, t.source])), [['p2p:screen:2', 2, 'screen']]);
  assert.equal((await targets[0].stats()).size, 1);
  voice.requestScreenStream = (id) => emitted.push(['renegotiate', id]);
  await voice._recoverStalledVideo(targets[0], 1);
  await voice._recoverStalledVideo(targets[0], 2);
  assert.deepEqual(plain(emitted), [['request-video-keyframe', { code: 'aaaaaaaa', sharerId: 2, source: 'screen' }], ['request-video-keyframe', { code: 'aaaaaaaa', sharerId: 2, source: 'screen' }], ['renegotiate', 2]]);
});
test('a stalled relayed video is recovered through the relay session', async () => {
  const { voice } = voiceWith([]);
  const calls = [];
  voice._relay = { stallTargets: () => [{ key: 'relay:screen:2', producerId: 'p1', userId: 2, source: 'screen' }], requestKeyFrame: async (id) => { calls.push(['key', id]); return 'hold'; }, resubscribe: async (id) => { calls.push(['sub', id]); } };
  const [target] = voice._stallTargets();
  assert.equal(await voice._recoverStalledVideo(target, 1), 'hold');
  await voice._recoverStalledVideo(target, 2);
  assert.deepEqual(plain(calls), [['key', 'p1'], ['sub', 'p1']]);
});
test('the sharer answers a keyframe request by nudging only the matching sender', () => {
  const { voice } = voiceWith([]);
  const handlers = {};
  voice.socket = { on: (e, h) => { handlers[e] = h; } };
  voice._setupSocketListeners();
  const nudged = [];
  const screen = { id: 's' }, cam = { id: 'c' };
  const sender = (track) => ({ track, generateKeyFrame: () => { nudged.push(track.id); return Promise.resolve(); } });
  voice.peers = new Map([[9, { connection: { getSenders: () => [sender(screen), sender(cam)] } }]]);
  Object.assign(voice, { isScreenSharing: true, screenStream: { getVideoTracks: () => [screen] }, isWebcamActive: true, webcamStream: { getVideoTracks: () => [cam] } });
  handlers['video-keyframe-request']({ channelCode: 'aaaaaaaa', targetUserId: 9, source: 'screen' });
  handlers['video-keyframe-request']({ channelCode: 'aaaaaaaa', targetUserId: 9, source: 'webcam' });
  handlers['video-keyframe-request']({ channelCode: 'bbbbbbbb', targetUserId: 9, source: 'screen' });
  assert.deepEqual(plain(nudged), ['s', 'c']);
});
test('the server forwards a keyframe request only to a live sharer in the same call', () => {
  const handlers = new Map(), out = [];
  const socket = { id: 'v', user: { id: 1, username: 'viewer', isAdmin: false }, on: (e, h) => handlers.set(e, h), emit() {} };
  const voiceUsers = new Map([['11111111', new Map([[1, { id: 1, socketId: 'v' }], [2, { id: 2, socketId: 's' }]])]]);
  const state = { channelUsers: new Map(), voiceUsers, voiceLastActivity: new Map(), activeMusic: new Map(), activeScreenSharers: new Map([['11111111', new Set([2])]]), activeWebcamUsers: new Map(), streamViewers: new Map(), pendingTempDelete: new Map(), pendingVoiceLeave: new Map() };
  const io = { sockets: { sockets: new Map() }, to: (target) => ({ emit: (event, payload) => out.push({ target, event, payload }), to() { return this; } }) };
  registerVoice(socket, { io, db: {}, state, userHasPermission: () => true, getUserEffectiveLevel: () => 0, getUserHighestRole: () => null, broadcastVoiceUsers() {}, emitOnlineUsers() {}, handleVoiceLeave() {}, touchVoiceActivity() {}, pruneStaleVoiceUsers: () => [], getMentionableChannelMembers: () => [], getActiveMusicSyncState: () => null, getMusicQueuePayload: () => ({}) });
  const ask = handlers.get('request-video-keyframe');
  ask({ code: '11111111', sharerId: 2, source: 'screen' });
  ask({ code: '11111111', sharerId: 2, source: 'webcam' });
  ask({ code: '11111111', sharerId: 3, source: 'screen' });
  ask({ code: '22222222', sharerId: 2, source: 'screen' });
  ask('junk');
  assert.deepEqual(out, [{ target: 's', event: 'video-keyframe-request', payload: { targetUserId: 1, channelCode: '11111111', source: 'screen' } }]);
});
test('the default timers work when called as methods of the timers object', () => {
  const watch = new VideoStallWatch({ targets: () => [], onStall() {}, intervalMs: 1000 });
  watch.start();
  assert.ok(watch.timer);
  watch.stop();
  assert.equal(watch.timer, null);
});
