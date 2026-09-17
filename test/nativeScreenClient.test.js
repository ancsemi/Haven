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
    RTCRtpReceiver: {
      getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }),
    },
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
    start: async () => ({
      started: true,
      sessionId: 'native-session-1234',
      codec: 'H264',
      hasAudio: false,
    }),
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

test('native screen codecs require explicit receiver capability proof', () => {
  let VoiceManager = loadVoiceManager({ RTCRtpReceiver: undefined, window: {} });
  let voice = Object.create(VoiceManager.prototype);
  assert.deepEqual(Array.from(voice._nativeScreenCodecs()), []);

  VoiceManager = loadVoiceManager({
    window: {},
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
  });
  voice = Object.create(VoiceManager.prototype);
  assert.deepEqual(Array.from(voice._nativeScreenCodecs()), []);

  VoiceManager = loadVoiceManager({
    window: {},
    RTCRtpReceiver: {
      getCapabilities: () => ({ codecs: [{ mimeType: 'video/AV1' }] }),
    },
  });
  voice = Object.create(VoiceManager.prototype);
  assert.deepEqual(Array.from(voice._nativeScreenCodecs()), ['AV1']);
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

test('voice bots do not participate in native screen codec negotiation', () => {
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map([[7, {}], [8, {}]]),
    _nativeScreenPeerCapabilities: new Map(),
    _nativeScreenCodecs: () => ['H264', 'AV1'],
  });

  voice._rememberNativeScreenPeer({
    id: 7,
    isBot: true,
    nativeScreenVersion: 0,
  });
  voice._rememberNativeScreenPeer({
    id: 8,
    nativeScreenVersion: 2,
    nativeScreenCodecs: ['H264'],
  });

  assert.deepEqual(Array.from(voice._nativeScreenCodecIntersection()), ['H264']);
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
  let screenAudioPaused = 0;
  let screenAudioRemoved = 0;
  let screenGainDisconnected = 0;
  const screenAudio = {
    srcObject: { id: 'old-screen-audio' },
    pause: () => { screenAudioPaused++; },
    remove: () => { screenAudioRemoved++; },
  };
  const api = completeNativeApi({ removePeer: async () => { nativeRemoveCalls++; } });
  const VoiceManager = loadVoiceManager({
    window: { havenDesktop: { nativeScreen: api } },
    document: {
      getElementById: id => id === 'voice-audio-screen-7' ? screenAudio : null,
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map([[7, { connection: { close: () => { closed++; } } }]]),
    gainNodes: new Map(),
    screenGainNodes: new Map([[7, {
      disconnect: () => { screenGainDisconnected++; },
    }]]),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map([[7, { connection: {} }]]),
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _closeNativeScreenPeer: () => { nativeCloseCalls++; },
    _stopAnalyser() {},
  });

  voice._removePeer(7);

  assert.equal(closed, 1);
  assert.equal(nativeCloseCalls, 0);
  assert.equal(nativeRemoveCalls, 0);
  assert.equal(screenAudioPaused, 0);
  assert.equal(screenAudioRemoved, 0);
  assert.deepEqual(screenAudio.srcObject, { id: 'old-screen-audio' });
  assert.equal(screenGainDisconnected, 0);
  assert.equal(voice._screenDelivered.has(7), true);
});

test('removing a voice peer cleans screen playback when no native receiver owns it', () => {
  let paused = 0;
  let removed = 0;
  let disconnected = 0;
  const screenAudio = {
    srcObject: { id: 'browser-screen-audio' },
    pause: () => { paused++; },
    remove: () => { removed++; },
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    document: {
      getElementById: id => id === 'voice-audio-screen-7' ? screenAudio : null,
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map([[7, { connection: { close() {} } }]]),
    gainNodes: new Map(),
    screenGainNodes: new Map([[7, { disconnect: () => { disconnected++; } }]]),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _stopAnalyser() {},
  });

  voice._removePeer(7);

  assert.equal(paused, 1);
  assert.equal(removed, 1);
  assert.equal(disconnected, 1);
  assert.equal(screenAudio.srcObject, null);
  assert.equal(voice._screenDelivered.has(7), false);
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
  let screenWatches = 0;
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
    _nativeScreenPeers: new Map([[7, { connection: {} }]]),
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    _screenDelivered: new Set([7]),
    socket: { emit() {} },
    onWebcamStream: () => { webcamStreams++; },
    onScreenStream: () => { screenStreams++; },
    _playAudio: () => { voiceAudio++; },
    _playScreenAudio: () => { screenAudio++; },
    _watchForScreenStream: () => { screenWatches++; },
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
  connection.connectionState = 'connected';
  connection.onconnectionstatechange();

  assert.equal(webcamStreams, 1);
  assert.equal(screenStreams, 0);
  assert.equal(voice._screenDelivered.has(7), true);
  assert.equal(voiceAudio, 1);
  assert.equal(screenAudio, 0);
  assert.equal(screenWatches, 0);
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
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: null,
  });
  releaseRemoteDescription();
  await offerPromise;

  assert.deepEqual(addedCandidates, [{ candidate: 'candidate:1' }, null]);
  assert.equal(emitted.at(-1).event, 'native-screen-answer');
});

test('a rejected native offer closes stale receiver state and requests recovery', async () => {
  let closed = 0;
  let requested = 0;
  let watched = 0;
  class FakePeerConnection {
    setRemoteDescription() { return Promise.reject(new Error('unsupported offer')); }
    close() { closed++; }
  }
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
    screenGainNodes: new Map(),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    socket: { emit() {} },
    requestScreenStream: () => { requested++; },
    _cancelScreenWatchdog() {},
    _watchForScreenStream: () => { watched++; },
  });

  await assert.rejects(voice._handleNativeScreenOffer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    offer: { type: 'offer', sdp: 'v=0' },
  }), /unsupported offer/);

  assert.equal(voice._nativeScreenPeers.has(7), false);
  assert.equal(closed, 1);
  assert.equal(requested, 1);
  assert.equal(watched, 1);
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

test('fatal helper failure invalidates a start waiting for the server acknowledgement', async () => {
  let signalHandler;
  let acknowledgeStart;
  const stops = [];
  const emitted = [];
  const api = completeNativeApi({
    onSignal: handler => { signalHandler = handler; },
    stop: async data => { stops.push(data); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: true,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') acknowledgeStart = callback;
      },
    },
  });
  voice._setupNativeScreenBridge();

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  signalHandler({
    type: 'error',
    sessionId: 'native-session-1234',
    peerId: null,
    message: 'pipeline failed',
    fatal: true,
  });
  acknowledgeStart({ ok: true, viewerIds: [] });

  assert.equal(await pending, false);
  assert.ok(stops.some(stop => stop?.sessionId === 'native-session-1234'));
  assert.equal(emitted.at(-1).event, 'screen-share-stopped');
  assert.notEqual(voice._nativeScreenSharing, true);
  assert.equal(voice._pendingNativeScreenSessionId, null);
});

test('fatal helper failure before native start resolves aborts and cleans up startup', async () => {
  let signalHandler;
  let resolveStart;
  let startRequestId;
  const stops = [];
  const emitted = [];
  const api = completeNativeApi({
    onSignal: handler => { signalHandler = handler; },
    start: options => {
      startRequestId = options.startRequestId;
      return new Promise(resolve => { resolveStart = resolve; });
    },
    stop: async data => { stops.push(data); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: true,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [] });
      },
    },
  });
  voice._setupNativeScreenBridge();

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  signalHandler({
    type: 'error',
    sessionId: 'native-session-1234',
    startRequestId,
    peerId: null,
    message: 'pipeline failed during startup',
    fatal: true,
  });

  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [{ sessionId: 'native-session-1234' }]);
  assert.equal(emitted.some(item => item.event === 'screen-share-started'), false);
  assert.equal(voice._nativeScreenStartState, null);
  assert.notEqual(voice._nativeScreenSharing, true);
  resolveStart({
    started: true,
    sessionId: 'native-session-1234',
    codec: 'H264',
    hasAudio: false,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [
    { sessionId: 'native-session-1234' },
    { sessionId: 'native-session-1234' },
  ]);
});

test('a stale fatal signal cannot reject a newer native start', async () => {
  let signalHandler;
  let resolveStart;
  let currentStartRequestId;
  const stops = [];
  const api = completeNativeApi({
    onSignal: handler => { signalHandler = handler; },
    start: options => {
      currentStartRequestId = options.startRequestId;
      return new Promise(resolve => { resolveStart = resolve; });
    },
    stop: async data => { stops.push(data); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: true,
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
  voice._setupNativeScreenBridge();

  let settled = false;
  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  pending.finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(currentStartRequestId, /^[A-Za-z0-9_-]{8,64}$/);
  signalHandler({
    type: 'error',
    sessionId: 'native-session-old1',
    startRequestId: 'native-start-old1',
    message: 'late fatal from an old helper',
    fatal: true,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  resolveStart({
    started: true,
    sessionId: 'native-session-1234',
    startRequestId: currentStartRequestId,
    codec: 'H264',
    hasAudio: false,
  });
  assert.equal(await pending, true);
  assert.deepEqual(stops, []);
  assert.equal(voice._nativeScreenSessionId, 'native-session-1234');
});

test('a hung native start times out without opening the browser picker', async () => {
  const stops = [];
  const api = completeNativeApi({
    start: () => new Promise(() => {}),
    stop: async data => { stops.push(data); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: true,
    _nativeScreenStartTimeoutMs: 5,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: { connected: true, emit() {} },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), false);
  assert.deepEqual(stops, [undefined]);
  assert.equal(voice._nativeScreenStartState, null);
});

test('native start attaches every authoritative viewer even without a voice peer', async () => {
  const added = [];
  const api = completeNativeApi({
    addPeer: async data => { added.push(data); },
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
    peers: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), true);
  assert.deepEqual(JSON.parse(JSON.stringify(added)), [{
    peerId: 7,
    sessionId: 'native-session-1234',
  }]);
});

test('native start rolls back its announcement when an initial peer fails', async () => {
  const stops = [];
  const emitted = [];
  const api = completeNativeApi({
    addPeer: async () => { throw new Error('peer rejected'); },
    stop: async data => { stops.push(data); },
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
    peers: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      connected: true,
      emit(event, payload, callback) {
        emitted.push({ event, payload });
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
        if (event === 'screen-share-stopped') callback?.({ ok: true });
      },
    },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), false);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [{ sessionId: 'native-session-1234' }]);
  assert.equal(emitted.at(-1).event, 'screen-share-stopped');
  assert.equal(voice.isScreenSharing, false);
  assert.equal(voice._nativeScreenSessionId, null);
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

test('an active screen snapshot preserves the authoritative no-audio state', () => {
  const handlers = new Map();
  const noAudio = [];
  const events = [];
  let noAudioPending = false;
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    screenSharers: new Set(),
    webcamUsers: new Set(),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-old1']]),
    _screenWatchdogTimers: new Map(),
    _watchForScreenStream() {},
    onScreenStream: (userId, stream) => {
      assert.equal(stream, null);
      events.push(`cleanup:${userId}`);
      noAudioPending = false;
    },
    onScreenNoAudio: userId => {
      events.push(`no-audio:${userId}`);
      noAudioPending = true;
      noAudio.push(userId);
    },
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({
    channelCode: 'a1b2c3d4',
    sharers: [{
      id: 7,
      username: 'Remote user',
      transport: 'native',
      sessionId: 'native-session-1234',
      codec: 'H264',
      hasAudio: false,
    }],
  });

  assert.deepEqual(noAudio, [7]);
  assert.deepEqual(events, ['cleanup:7', 'no-audio:7']);
  assert.equal(noAudioPending, true);
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

test('the first active snapshot does not reset a local native share', () => {
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
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    screenSharers: new Set([1]),
    webcamUsers: new Set(),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map(),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({
    channelCode: 'a1b2c3d4',
    sharers: [{
      id: 1,
      username: 'Local user',
      transport: 'native',
      sessionId: 'native-session-1234',
      codec: 'H264',
      hasAudio: true,
    }],
  });

  assert.equal(voice.screenSharers.has(1), true);
  assert.equal(voice._nativeScreenAnnouncements.get(1), 'native-session-1234');
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
      codec: 'H264',
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

test('browser screen reshare preserves existing browser audio playback', () => {
  const handlers = new Map();
  let paused = 0;
  let removed = 0;
  let disconnected = 0;
  const audioEl = {
    srcObject: { id: 'browser-screen-stream' },
    pause: () => { paused++; },
    remove: () => { removed++; },
  };
  const gainNode = { disconnect: () => { disconnected++; } };
  const VoiceManager = loadVoiceManager({
    window: {},
    document: {
      getElementById: id => id === 'voice-audio-screen-7' ? audioEl : null,
      querySelectorAll: () => [],
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    screenGainNodes: new Map([[7, gainNode]]),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map(),
    _screenWatchdogTimers: new Map(),
    _watchForScreenStream() {},
  });
  voice._setupSocketListeners();

  handlers.get('screen-share-started')({
    channelCode: 'a1b2c3d4',
    userId: 7,
    username: 'Remote user',
    transport: 'browser',
    hasAudio: true,
  });

  assert.equal(paused, 0);
  assert.equal(removed, 0);
  assert.equal(disconnected, 0);
  assert.equal(audioEl.srcObject.id, 'browser-screen-stream');
  assert.equal(voice.screenGainNodes.get(7), gainNode);
});

test('browser screen stop removes its audio playback', () => {
  const handlers = new Map();
  let paused = 0;
  let removed = 0;
  let disconnected = 0;
  const audioEl = {
    srcObject: { id: 'browser-screen-stream' },
    pause: () => { paused++; },
    remove: () => { removed++; },
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    document: {
      getElementById: id => id === 'voice-audio-screen-7' ? audioEl : null,
      querySelectorAll: () => [],
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    screenGainNodes: new Map([[7, { disconnect: () => { disconnected++; } }]]),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map(),
    _screenWatchdogTimers: new Map(),
    _cancelScreenWatchdog() {},
  });
  voice._setupSocketListeners();

  handlers.get('screen-share-stopped')({ channelCode: 'a1b2c3d4', userId: 7 });

  assert.equal(paused, 1);
  assert.equal(removed, 1);
  assert.equal(disconnected, 1);
  assert.equal(audioEl.srcObject, null);
  assert.equal(voice.screenGainNodes.has(7), false);
});

test('browser-to-native transition removes browser audio playback', () => {
  const handlers = new Map();
  let removed = 0;
  const audioEl = {
    srcObject: { id: 'browser-screen-stream' },
    pause() {},
    remove: () => { removed++; },
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    document: {
      getElementById: id => id === 'voice-audio-screen-7' ? audioEl : null,
      querySelectorAll: () => [],
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    screenGainNodes: new Map(),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map(),
    _screenWatchdogTimers: new Map(),
    _watchForScreenStream() {},
  });
  voice._setupSocketListeners();

  handlers.get('screen-share-started')({
    channelCode: 'a1b2c3d4',
    userId: 7,
    username: 'Remote user',
    transport: 'native',
    sessionId: 'native-session-1234',
    hasAudio: true,
  });

  assert.equal(removed, 1);
  assert.equal(audioEl.srcObject, null);
  assert.equal(voice._nativeScreenAnnouncements.get(7), 'native-session-1234');
});

test('native-to-browser transition removes native audio playback', () => {
  let peerClosed = 0;
  let paused = 0;
  let removed = 0;
  let disconnected = 0;
  const audioEl = {
    srcObject: { id: 'native-screen-stream' },
    pause: () => { paused++; },
    remove: () => { removed++; },
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { getElementById: () => audioEl },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenGainNodes: new Map([[7, { disconnect: () => { disconnected++; } }]]),
    _nativeScreenPeers: new Map([[7, {
      connection: { close: () => { peerClosed++; } },
      sessionId: 'native-session-1234',
    }]]),
    _pendingNativeScreenCandidates: new Map(),
  });

  voice._closeNativeScreenPeer(7);

  assert.equal(peerClosed, 1);
  assert.equal(paused, 1);
  assert.equal(removed, 1);
  assert.equal(disconnected, 1);
  assert.equal(audioEl.srcObject, null);
  assert.equal(voice.screenGainNodes.has(7), false);
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

test('stale native reannouncement rejection does not stop a replacement session', async () => {
  let rejectPeer;
  let stopCalls = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenCodec: 'H264',
    screenStream: null,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    socket: {
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: true, viewerIds: [7] });
      },
    },
    _replaceNativeScreenPeer: () => new Promise((resolve, reject) => { rejectPeer = reject; }),
    stopScreenShare: async () => { stopCalls++; },
  });

  const pending = voice._reannounceScreenShare([], {
    channelCode: 'a1b2c3d4',
    voiceGeneration: 3,
  });
  await new Promise(resolve => setImmediate(resolve));
  voice._nativeScreenSessionId = 'native-session-5678';
  rejectPeer(new Error('stale peer failure'));

  assert.equal(await pending, false);
  assert.equal(stopCalls, 0);
  assert.equal(voice._nativeScreenSessionId, 'native-session-5678');
  assert.equal(voice.isScreenSharing, true);
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
      codec: 'H264',
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
      return {
        started: true,
        sessionId: 'native-session-1234',
        codec: 'H264',
        hasAudio: false,
      };
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
