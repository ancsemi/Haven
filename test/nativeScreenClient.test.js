'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/voice.js'),
  'utf8'
);

function loadVoiceManager(globals = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    ...globals,
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, {
    filename: 'voice.js',
  });
  return context.module.exports;
}

function completeNativeApi(overrides = {}) {
  return {
    getCapabilities: async () => ({ supported: true }),
    start: async () => ({ started: true, sessionId: 'native-session-1234' }),
    stop: async () => {},
    addPeer: async () => {},
    removePeer: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    onSignal() {},
    ...overrides,
  };
}

test('native screen start is transactional when the helper returns invalid state', async () => {
  let stopCalls = 0;
  const api = completeNativeApi({
    start: async () => ({ started: true, sessionId: '../invalid' }),
    stop: async () => { stopCalls++; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    currentChannel: 'a1b2c3d4',
    inVoice: true,
    socket: { emit() {} },
  });

  assert.equal(await voice._tryStartNativeScreenShare(), null);
  assert.equal(stopCalls, 1);
  assert.notEqual(voice._nativeScreenSharing, true);
});

test('native picker cancellation does not fall through to another picker', async () => {
  const api = completeNativeApi({
    start: async () => ({ started: false, cancelled: true }),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    currentChannel: 'a1b2c3d4',
    inVoice: true,
    socket: { emit() {} },
  });

  assert.equal(await voice._tryStartNativeScreenShare(), false);
});

test('native transport falls back when a viewer does not support the protocol', async () => {
  let stopCalls = 0;
  const api = completeNativeApi({ stop: async () => { stopCalls++; } });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: false, error: 'incompatible_viewer' });
      },
    },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), null);
  assert.equal(stopCalls, 1);
  assert.notEqual(voice._nativeScreenSharing, true);
});

test('screen sharing cannot start while signaling is disconnected', async () => {
  let startCalls = 0;
  const api = completeNativeApi({ start: async () => { startCalls++; } });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    isScreenSharing: false,
    _screenStartInFlight: false,
    socket: { connected: false },
  });

  assert.equal(await voice.shareScreen(), false);
  assert.equal(startCalls, 0);
});

test('rebuilding a voice peer does not tear down its independent native screen peer', () => {
  let closed = 0;
  let nativeCloseCalls = 0;
  let nativeRemoveCalls = 0;
  const api = completeNativeApi({ removePeer: async () => { nativeRemoveCalls++; } });
  const VoiceManager = loadVoiceManager({
    window: { havenDesktop: { nativeScreen: api } },
    document: { getElementById: () => null },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map([[7, { connection: { close: () => { closed++; } } }]]),
    gainNodes: new Map(),
    screenGainNodes: new Map(),
    _screenDelivered: new Set(),
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _closeNativeScreenPeer: () => { nativeCloseCalls++; },
    _stopAnalyser() {},
  });

  voice._removePeer(7);

  assert.equal(closed, 1);
  assert.equal(nativeCloseCalls, 0);
  assert.equal(nativeRemoveCalls, 0);
});

test('native recovery ignores video receivers on the voice connection', () => {
  const VoiceManager = loadVoiceManager({ window: {} });
  const track = { kind: 'video', readyState: 'live', muted: false, id: 'camera-track' };
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _nativeScreenPeers: new Map(),
    peers: new Map([[7, {
      connection: { getReceivers: () => [{ track }] },
    }]]),
    screenSharers: new Set([7]),
  });

  assert.equal(voice._deliverScreenFromReceivers(7), false);
  assert.equal(voice._screenStillLive(7), false);
});

test('native screen announcements keep voice video and audio on their own paths', async () => {
  let connection;
  let webcamStreams = 0;
  let screenStreams = 0;
  let voiceAudio = 0;
  let screenAudio = 0;
  class FakeMediaStream {
    constructor(tracks = []) {
      this.tracks = [...tracks];
      this.id = `stream-${Math.random()}`;
    }
    addTrack(track) { this.tracks.push(track); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class FakePeerConnection {
    constructor() {
      connection = this;
      this.signalingState = 'stable';
    }
    addEventListener() {}
  }
  const VoiceManager = loadVoiceManager({
    window: {},
    MediaStream: FakeMediaStream,
    RTCPeerConnection: FakePeerConnection,
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map(),
    rtcConfig: {},
    localStream: null,
    audioBitrate: 0,
    screenStream: null,
    isScreenSharing: false,
    webcamStream: null,
    isWebcamActive: false,
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    _screenDelivered: new Set(),
    socket: { emit() {} },
    onWebcamStream: () => { webcamStreams++; },
    onScreenStream: () => { screenStreams++; },
    _playAudio: () => { voiceAudio++; },
    _playScreenAudio: () => { screenAudio++; },
  });

  await voice._createPeer(7, 'Viewer', false);
  const videoTrack = {
    kind: 'video', id: 'camera-track', readyState: 'live', getSettings: () => ({}),
  };
  connection.ontrack({
    track: videoTrack,
    streams: [new FakeMediaStream([videoTrack])],
  });
  const audioTrack = { kind: 'audio', id: 'voice-track', readyState: 'live' };
  connection.ontrack({
    track: audioTrack,
    streams: [new FakeMediaStream([audioTrack])],
  });

  assert.equal(webcamStreams, 1);
  assert.equal(screenStreams, 0);
  assert.equal(voice._screenDelivered.has(7), false);
  assert.equal(voiceAudio, 1);
  assert.equal(screenAudio, 0);
});

test('stale browser track callbacks cannot overwrite a native share', async () => {
  let connection;
  let screenStreams = 0;
  class FakeMediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    addTrack(track) { this.tracks.push(track); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class FakePeerConnection {
    constructor() {
      connection = this;
      this.signalingState = 'stable';
    }
    addEventListener() {}
  }
  const VoiceManager = loadVoiceManager({
    window: {},
    MediaStream: FakeMediaStream,
    RTCPeerConnection: FakePeerConnection,
    setTimeout: callback => { callback(); return 1; },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map(),
    rtcConfig: {},
    localStream: null,
    audioBitrate: 0,
    screenStream: null,
    isScreenSharing: false,
    webcamStream: null,
    isWebcamActive: false,
    _nativeScreenAnnouncements: new Map(),
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    _screenDelivered: new Set(),
    socket: { emit() {} },
    onScreenStream: () => { screenStreams++; },
  });

  await voice._createPeer(7, 'Viewer', false);
  const track = {
    kind: 'video', id: 'browser-screen', readyState: 'live', getSettings: () => ({}),
  };
  connection.ontrack({ track, streams: [new FakeMediaStream([track])] });
  assert.equal(screenStreams, 1);

  voice._nativeScreenAnnouncements.set(7, 'native-session-1234');
  voice._screenDelivered.add(7);
  track.onunmute();
  track.onended();

  assert.equal(screenStreams, 1);
  assert.equal(voice._screenDelivered.has(7), true);
});

test('native receiver drains ICE that arrives while applying the offer', async () => {
  let releaseRemoteDescription;
  const addedCandidates = [];
  class FakePeerConnection {
    constructor() {
      this.remoteDescription = null;
      this.connectionState = 'new';
    }
    setRemoteDescription() {
      return new Promise(resolve => {
        releaseRemoteDescription = () => {
          this.remoteDescription = { type: 'offer' };
          resolve();
        };
      });
    }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription() {}
    async addIceCandidate(candidate) { addedCandidates.push(candidate); }
    close() {}
  }
  const emitted = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {},
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    currentChannel: 'a1b2c3d4',
    rtcConfig: {},
    screenSharers: new Set([7]),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    socket: {
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
  });

  const offerPromise = voice._handleNativeScreenOffer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    offer: { type: 'offer', sdp: 'v=0' },
  });
  await Promise.resolve();
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: { candidate: 'candidate:1' },
  });
  releaseRemoteDescription();
  await offerPromise;

  assert.deepEqual(addedCandidates, [{ candidate: 'candidate:1' }]);
  assert.equal(emitted.at(-1).event, 'native-screen-answer');
});

test('fatal helper errors without a peer stop the native share', async () => {
  let signalHandler;
  let stopCalls = 0;
  const api = completeNativeApi({
    onSignal: handler => { signalHandler = handler; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    currentChannel: 'a1b2c3d4',
    socket: { emit() {} },
    stopScreenShare: async () => { stopCalls++; },
  });

  voice._setupNativeScreenBridge();
  signalHandler({
    type: 'error',
    sessionId: 'native-session-1234',
    peerId: null,
    message: 'pipeline failed',
    fatal: true,
  });
  await Promise.resolve();

  assert.equal(stopCalls, 1);
});

test('sender queues native ICE until the browser answer is applied', async () => {
  let releaseAnswer;
  const calls = [];
  const api = completeNativeApi({
    setRemoteDescription: async () => {
      calls.push('answer-start');
      await new Promise(resolve => { releaseAnswer = resolve; });
      calls.push('answer-done');
    },
    addIceCandidate: async ({ candidate }) => {
      calls.push(candidate ? candidate.candidate : 'end-of-candidates');
    },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map([[
      '7:native-session-1234:negotiation-1234',
      { ready: false, applying: null, candidates: [] },
    ]]),
    currentChannel: 'a1b2c3d4',
  });

  const answer = voice._handleNativeScreenAnswer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    answer: { type: 'answer', sdp: 'v=0' },
  });
  await Promise.resolve();
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: { candidate: 'candidate:1' },
  });
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: null,
  });
  assert.deepEqual(calls, ['answer-start']);
  releaseAnswer();
  await answer;
  assert.deepEqual(calls, ['answer-start', 'answer-done', 'candidate:1', 'end-of-candidates']);
});

test('native start is stopped without announcement after leaving during the picker', async () => {
  let resolveStart;
  let stopCalls = 0;
  const emitted = [];
  const api = completeNativeApi({
    start: () => new Promise(resolve => { resolveStart = resolve; }),
    stop: async () => { stopCalls++; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    socket: {
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice.inVoice = false;
  voice.currentChannel = null;
  voice._screenStartOperation++;
  resolveStart({ started: true, sessionId: 'native-session-1234' });

  assert.equal(await pending, false);
  assert.equal(stopCalls, 1);
  assert.equal(emitted.length, 0);
  assert.notEqual(voice._nativeScreenSharing, true);
});

test('a stale rejected start cannot stop or clear a newer native session', async () => {
  let rejectStart;
  const stops = [];
  const api = completeNativeApi({
    start: () => new Promise((_, reject) => { rejectStart = reject; }),
    stop: async data => { stops.push(data || 'all'); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    socket: { connected: true, emit() {} },
  });

  const staleStart = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice._screenStartOperation = 9;
  voice._nativeScreenSharing = true;
  voice._nativeScreenSessionId = 'native-session-new1';
  voice.isScreenSharing = true;
  rejectStart(new Error('old start failed'));

  assert.equal(await staleStart, null);
  assert.deepEqual(stops, []);
  assert.equal(voice._nativeScreenSharing, true);
  assert.equal(voice._nativeScreenSessionId, 'native-session-new1');
  assert.equal(voice.isScreenSharing, true);
});

test('stale native answers cannot replace the current viewer negotiation', async () => {
  let applyCalls = 0;
  const api = completeNativeApi({
    setRemoteDescription: async () => { applyCalls++; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map([[
      '7:native-session-1234:negotiation-current',
      { ready: false, applying: null, candidates: [] },
    ]]),
    currentChannel: 'a1b2c3d4',
  });

  await voice._handleNativeScreenAnswer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-stale',
    answer: { type: 'answer', sdp: 'v=0' },
  });

  assert.equal(applyCalls, 0);
});

test('an empty screen snapshot removes stale local sharers', () => {
  const handlers = new Map();
  const removed = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({ channelCode: 'a1b2c3d4', sharers: [] });

  assert.equal(voice.screenSharers.size, 0);
  assert.equal(voice._nativeScreenAnnouncements.size, 0);
  assert.deepEqual(removed, [{ userId: 7, stream: null }]);
});

test('an empty recovery snapshot preserves an active local share', () => {
  const handlers = new Map();
  const removed = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    isScreenSharing: true,
    screenSharers: new Set([1]),
    webcamUsers: new Set(),
    _screenDelivered: new Set([1]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[1, 'native-session-1234']]),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({ channelCode: 'a1b2c3d4', sharers: [] });

  assert.equal(voice.screenSharers.has(1), true);
  assert.equal(removed.length, 0);
});

test('a stale server snapshot cannot restore a stopped local share', () => {
  const handlers = new Map();
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    isScreenSharing: false,
    screenSharers: new Set(),
    webcamUsers: new Set(),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map(),
    _screenWatchdogTimers: new Map(),
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({
    channelCode: 'a1b2c3d4',
    sharers: [{
      id: 1,
      username: 'Local user',
      transport: 'native',
      sessionId: 'native-session-1234',
    }],
  });

  assert.equal(voice.screenSharers.has(1), false);
  assert.equal(voice._nativeScreenAnnouncements.has(1), false);
});

test('browser screen sharing is reannounced after voice rejoin', async () => {
  const emitted = [];
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: false,
    currentChannel: 'a1b2c3d4',
    screenStream: { getAudioTracks: () => [{}] },
    socket: {
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        callback?.({ ok: true, viewerIds: [] });
      },
    },
  });

  await voice._reannounceScreenShare([]);

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    event: 'screen-share-started',
    payload: { code: 'a1b2c3d4', hasAudio: true, transport: 'browser' },
  }]);
});

test('screen reannouncement stops local sharing when the server rejects it', async () => {
  let stopCalls = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: false,
    currentChannel: 'a1b2c3d4',
    screenStream: { getAudioTracks: () => [] },
    socket: {
      emit(event, payload, callback) {
        callback?.({ ok: false, error: 'rate_limited' });
      },
    },
    stopScreenShare: async () => { stopCalls++; },
  });

  assert.equal(await voice._reannounceScreenShare([]), false);
  assert.equal(stopCalls, 1);
});

test('unknown native ICE negotiations are bounded per sharer session', async () => {
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: false,
    currentChannel: 'a1b2c3d4',
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
  });

  for (let index = 0; index < 10; index++) {
    await voice._handleNativeScreenIceCandidate({
      from: { id: 7 },
      channelCode: 'a1b2c3d4',
      sessionId: 'native-session-1234',
      negotiationId: `negotiation-${index}`,
      candidate: { candidate: `candidate:${index}` },
    });
  }

  assert.equal(voice._pendingNativeScreenCandidates.size, 4);
});

test('native peer recovery clears stale UI and rearms retries', () => {
  const removed = [];
  let requested = 0;
  let watched = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenSharers: new Set([7]),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
    requestScreenStream: () => { requested++; },
    _watchForScreenStream: () => { watched++; },
  });

  voice._recoverNativeScreenPeer(7);

  assert.equal(voice._screenDelivered.has(7), false);
  assert.deepEqual(removed, [{ userId: 7, stream: null }]);
  assert.equal(requested, 1);
  assert.equal(watched, 1);
});

test('a no-op voice rejoin does not churn native screen peers', async () => {
  const handlers = new Map();
  let reannounced = 0;
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    peers: new Map(),
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 2,
    _reannounceScreenShare: async () => { reannounced++; },
    _rearmScreenWatchdogs() {},
  });
  voice._setupSocketListeners();

  await handlers.get('voice-existing-users')({
    channelCode: 'a1b2c3d4',
    users: [],
    rejoin: true,
    skipRenegotiate: true,
  });

  assert.equal(reannounced, 0);
});

test('voice rejoin flushes a screen stop queued while disconnected', async () => {
  const handlers = new Map();
  const emitted = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: {
      connected: true,
      on: (event, handler) => handlers.set(event, handler),
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        callback?.({ ok: true });
      },
    },
    peers: new Map(),
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 2,
    _pendingScreenStop: { code: 'a1b2c3d4', sessionId: 'native-session-1234' },
    _rearmScreenWatchdogs() {},
  });
  voice._setupSocketListeners();

  await handlers.get('voice-existing-users')({
    channelCode: 'a1b2c3d4',
    users: [],
    rejoin: true,
    skipRenegotiate: true,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0])), {
    event: 'screen-share-stopped',
    payload: { code: 'a1b2c3d4', sessionId: 'native-session-1234' },
  });
  assert.equal(voice._pendingScreenStop, null);
});

test('native start revalidates voice ownership after attaching initial peers', async () => {
  let resolvePeer;
  const stops = [];
  const emitted = [];
  const api = completeNativeApi({
    addPeer: () => new Promise(resolve => { resolvePeer = resolve; }),
    stop: async data => { stops.push(data); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice.inVoice = false;
  voice.currentChannel = null;
  voice._screenStartOperation++;
  resolvePeer();

  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [{ sessionId: 'native-session-1234' }]);
  assert.equal(emitted.at(-1).event, 'screen-share-stopped');
  assert.equal(voice.isScreenSharing, false);
});

test('native start cleanup follows a channel code rotation', async () => {
  let resolvePeer;
  const emitted = [];
  const api = completeNativeApi({
    addPeer: () => new Promise(resolve => { resolvePeer = resolve; }),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      connected: true,
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice.currentChannel = 'd4c3b2a1';
  resolvePeer();

  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted.at(-1))), {
    event: 'screen-share-stopped',
    payload: { code: 'd4c3b2a1', sessionId: 'native-session-1234' },
  });
});

test('an active native share is reannounced after channel rotation', async () => {
  const emitted = [];
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map(),
    inVoice: true,
    currentChannel: 'd4c3b2a1',
    _voiceSessionGeneration: 3,
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    socket: {
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [] });
      },
    },
    _healPeerConnections() {},
  });

  await voice._healPeerConnectionsAfterChannelRotation('a1b2c3d4');
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0])), {
    event: 'screen-share-started',
    payload: {
      code: 'd4c3b2a1',
      hasAudio: false,
      transport: 'native',
      sessionId: 'native-session-1234',
    },
  });
});

test('native stop signals the server even when the helper hangs', async () => {
  const emitted = [];
  let screenCleanupCalls = 0;
  const api = completeNativeApi({ stop: () => new Promise(() => {}) });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    localUserId: 1,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _nativeScreenOperationTimeoutMs: 5,
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map(),
    screenSharers: new Set([1]),
    _nativeScreenAnnouncements: new Map([[1, 'native-session-1234']]),
    socket: {
      connected: true,
      emit: (event, payload) => emitted.push({ event, payload }),
    },
    onScreenStream: () => { screenCleanupCalls++; },
  });

  const stopping = voice.stopScreenShare();
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0])), {
    event: 'screen-share-stopped',
    payload: { code: 'a1b2c3d4', sessionId: 'native-session-1234' },
  });
  assert.equal(screenCleanupCalls, 1);
  await stopping;
  assert.equal(voice.isScreenSharing, false);
  assert.equal(screenCleanupCalls, 1);
});

test('native stop is queued until signaling reconnects', async () => {
  const emitted = [];
  const api = completeNativeApi();
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const socket = {
    connected: false,
    emit: (event, payload) => emitted.push({ event, payload }),
  };
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    localUserId: 1,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map(),
    screenSharers: new Set([1]),
    _nativeScreenAnnouncements: new Map([[1, 'native-session-1234']]),
    socket,
  });

  await voice.stopScreenShare();
  assert.equal(emitted.length, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(voice._pendingScreenStop)),
    { code: 'a1b2c3d4', sessionId: 'native-session-1234' }
  );

  socket.connected = true;
  assert.equal(voice._flushPendingScreenStop('a1b2c3d4'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0])), {
    event: 'screen-share-stopped',
    payload: { code: 'a1b2c3d4', sessionId: 'native-session-1234' },
  });
});

test('native start uses the gentler relay bitrate profile', async () => {
  let startOptions;
  const api = completeNativeApi({
    start: async options => {
      startOptions = options;
      return { started: true, sessionId: 'native-session-1234' };
    },
  });
  const VoiceManager = loadVoiceManager({
    window: { havenDesktop: { nativeScreen: api } },
    localStorage: {
      getItem: key => key === 'haven_screen_relay_profile' ? '1' : null,
      setItem() {},
      removeItem() {},
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [] });
      },
    },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), true);
  assert.equal(startOptions.bitrate, 3_000_000);
});

test('fatal helper failure invalidates a start waiting on initial peers', async () => {
  let resolvePeer;
  const api = completeNativeApi({
    addPeer: () => new Promise(resolve => { resolvePeer = resolve; }),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    screenSharers: new Set(),
    _nativeScreenAnnouncements: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice._handleNativeScreenFailure('pipeline failed');
  await new Promise(resolve => setImmediate(resolve));
  resolvePeer();

  assert.equal(await pending, false);
  assert.equal(voice.isScreenSharing, false);
});

test('an ended native track uses the retrying recovery path', async () => {
  let connection;
  class FakePeerConnection {
    constructor() {
      connection = this;
      this.connectionState = 'new';
      this.remoteDescription = null;
    }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription() {}
    close() {}
  }
  const VoiceManager = loadVoiceManager({
    window: {},
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {},
  });
  const voice = Object.create(VoiceManager.prototype);
  let recoveries = 0;
  Object.assign(voice, {
    currentChannel: 'a1b2c3d4',
    rtcConfig: {},
    screenSharers: new Set([7]),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _recoverNativeScreenPeer: () => { recoveries++; },
    socket: { emit() {} },
  });
  await voice._handleNativeScreenOffer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    offer: { type: 'offer', sdp: 'v=0' },
  });
  const track = { kind: 'video' };
  connection.ontrack({ track, streams: [{}] });
  track.onended();

  assert.equal(recoveries, 1);
});

test('stopping a native share removes a local snapshot badge', async () => {
  const api = completeNativeApi();
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    localUserId: 1,
    currentChannel: 'a1b2c3d4',
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map(),
    screenSharers: new Set([1]),
    _nativeScreenAnnouncements: new Map([[1, 'native-session-1234']]),
    socket: { emit() {} },
  });

  await voice.stopScreenShare();

  assert.equal(voice.screenSharers.has(1), false);
  assert.equal(voice._nativeScreenAnnouncements.has(1), false);
});

test('browser fallback revalidates the voice operation after renegotiation', async () => {
  let resolveRenegotiation;
  let renegotiationCalls = 0;
  let stopCalls = 0;
  const emitted = [];
  const videoTrack = { kind: 'video', readyState: 'live', stop() { stopCalls++; } };
  const stream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [],
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    navigator: {
      userAgent: '', platform: '', maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia: async () => stream },
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: false,
    isScreenSharing: false,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {
      connection: { addTrack() {}, getSenders: () => [], removeTrack() {} },
    }]]),
    localUserId: 1,
    screenSharers: new Set([1]),
    _nativeScreenAnnouncements: new Map(),
    socket: {
      connected: true,
      emit: (event, payload, callback) => {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
    _applyScreenBitrate() {},
    _renegotiate: () => {
      if (renegotiationCalls++ > 0) return Promise.resolve();
      return new Promise(resolve => { resolveRenegotiation = resolve; });
    },
  });

  const pending = voice.shareScreen();
  await new Promise(resolve => setImmediate(resolve));
  voice.currentChannel = 'd4c3b2a1';
  voice._screenStartOperation++;
  resolveRenegotiation();

  assert.equal(await pending, false);
  assert.equal(stopCalls, 1);
  assert.equal(voice.isScreenSharing, false);
  assert.equal(voice.screenStream, null);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted.at(-1))), {
    event: 'screen-share-stopped',
    payload: { code: 'd4c3b2a1' },
  });
});

test('browser capture is rolled back when the server rejects screen start', async () => {
  let stopCalls = 0;
  const videoTrack = { kind: 'video', readyState: 'live', stop() { stopCalls++; } };
  const stream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [],
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    navigator: {
      userAgent: '', platform: '', maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia: async () => stream },
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: false,
    isScreenSharing: false,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    peers: new Map(),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: false, error: 'streams_disabled' });
      },
    },
  });

  assert.equal(await voice.shareScreen(), false);
  assert.equal(stopCalls, 1);
  assert.equal(voice.isScreenSharing, false);
  assert.equal(voice.screenStream, null);
});

test('an incompatible late viewer stops an active native share', async () => {
  const handlers = new Map();
  let stopCalls = 0;
  let warnings = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    onScreenShareWarning: () => { warnings++; },
    stopScreenShare: async () => { stopCalls++; },
  });
  voice._setupSocketListeners();

  handlers.get('native-screen-incompatible-peer')({
    channelCode: 'a1b2c3d4',
    userId: 7,
    sessionId: 'native-session-old1',
  });
  await Promise.resolve();

  assert.equal(stopCalls, 0);
  assert.equal(warnings, 0);

  handlers.get('native-screen-incompatible-peer')({
    channelCode: 'a1b2c3d4',
    userId: 7,
    sessionId: 'native-session-1234',
  });
  await Promise.resolve();

  assert.equal(stopCalls, 1);
  assert.equal(warnings, 1);
});
