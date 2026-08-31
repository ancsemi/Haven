'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const registerVoice = require('../src/socketHandlers/voice');

const ROOT = path.join(__dirname, '..');
const VOICE_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');

function createStorage() {
  return {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  };
}

function loadVoiceManager(globals = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: createStorage(),
    console: { log() {}, warn() {}, error() {} },
    RTCSessionDescription: function RTCSessionDescription(description) { return description; },
    setTimeout,
    clearTimeout,
    Date,
    ...globals
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return context.module.exports;
}

function createRelayHarness() {
  const handlers = new Map();
  const outgoing = [];
  const socket = {
    id: 'sender-socket',
    user: { id: 1, username: 'sender', displayName: 'Sender', isAdmin: false },
    on(event, handler) { handlers.set(event, handler); },
    emit() {}
  };
  const voiceUsers = new Map([['11111111', new Map([
    [1, { id: 1, username: 'Sender', socketId: socket.id }],
    [2, { id: 2, username: 'Viewer', socketId: 'viewer-socket' }]
  ])]]);
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        emit(event, payload) { outgoing.push({ target, event, payload }); },
        to() { return this; }
      };
    }
  };
  const state = {
    channelUsers: new Map(),
    voiceUsers,
    voiceLastActivity: new Map(),
    activeMusic: new Map(),
    activeScreenSharers: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    pendingTempDelete: new Map(),
    pendingVoiceLeave: new Map()
  };
  registerVoice(socket, {
    io,
    db: {},
    state,
    userHasPermission: () => true,
    getUserEffectiveLevel: () => 0,
    getUserHighestRole: () => null,
    broadcastVoiceUsers() {},
    emitOnlineUsers() {},
    handleVoiceLeave() {},
    touchVoiceActivity() {},
    pruneStaleVoiceUsers: () => [],
    getMentionableChannelMembers: () => [],
    getActiveMusicSyncState: () => null,
    getMusicQueuePayload: () => ({})
  });
  return { handlers, outgoing };
}

test('voice relay accepts large gathered SDP and preserves offer correlation', () => {
  const { handlers, outgoing } = createRelayHarness();
  const largeSdp = `v=0\r\n${'a=candidate:screen-share-candidate\r\n'.repeat(1000)}`;

  handlers.get('voice-offer')({
    code: '11111111',
    targetUserId: 2,
    offerId: '1-screen-offer-1',
    offer: { type: 'offer', sdp: largeSdp }
  });

  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].target, 'viewer-socket');
  assert.equal(outgoing[0].event, 'voice-offer');
  assert.equal(outgoing[0].payload.offerId, '1-screen-offer-1');
  assert.equal(outgoing[0].payload.offer.sdp, largeSdp);

  handlers.get('voice-answer')({
    code: '11111111',
    targetUserId: 2,
    offerId: '1-screen-offer-1',
    answer: { type: 'answer', sdp: largeSdp }
  });
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[1].payload.offerId, '1-screen-offer-1');

  handlers.get('voice-offer')({
    code: '11111111',
    targetUserId: 2,
    offerId: 'too-large',
    offer: { type: 'offer', sdp: 'x'.repeat(66000) }
  });
  assert.equal(outgoing.length, 2);
});

test('an unanswered offer is rolled back and queued for retry', async () => {
  const VoiceManager = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  let rollback = null;
  let drainCalls = 0;
  const connection = {
    signalingState: 'have-local-offer',
    async setLocalDescription(description) {
      rollback = description;
      this.signalingState = 'stable';
    }
  };
  const peer = {
    connection,
    _awaitingAnswer: true,
    _activeOfferId: 'offer-current',
    _offerAnswerTimer: null,
    _offerTimeoutCount: 0,
    _offerIsIceRestart: false,
    _offerChannelCode: '11111111',
    _renegotiateQueued: false
  };
  voice.peers = new Map([[2, peer]]);
  voice._drainQueuedRenegotiation = userId => {
    assert.equal(userId, 2);
    drainCalls++;
  };

  assert.equal(await voice._recoverTimedOutOffer(2, connection, 'offer-stale'), false);
  assert.equal(rollback, null);

  assert.equal(await voice._recoverTimedOutOffer(2, connection, 'offer-current'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(rollback)), { type: 'rollback' });
  assert.equal(peer._awaitingAnswer, false);
  assert.equal(peer._activeOfferId, null);
  assert.equal(peer._renegotiateQueued, true);
  assert.equal(peer._offerTimeoutCount, 1);
  assert.equal(drainCalls, 1);
});

test('a late answer cannot satisfy a newer correlated offer', async () => {
  const VoiceManager = loadVoiceManager();
  const handlers = {};
  const voice = Object.create(VoiceManager.prototype);
  voice.socket = { on: (event, handler) => { handlers[event] = handler; } };
  voice.peers = new Map();
  voice._setupSocketListeners();

  let applied = 0;
  const connection = {
    signalingState: 'have-local-offer',
    async setRemoteDescription() {
      applied++;
      this.signalingState = 'stable';
    }
  };
  const peer = {
    connection,
    _awaitingAnswer: true,
    _activeOfferId: 'offer-new',
    _offerAnswerTimer: null,
    _offerTimeoutCount: 2,
    _renegotiateQueued: false,
    _pendingCandidates: []
  };
  voice.peers.set(2, peer);

  await handlers['voice-answer']({
    from: { id: 2 },
    offerId: 'offer-old',
    answer: { type: 'answer', sdp: 'stale' }
  });
  assert.equal(applied, 0);
  assert.equal(peer._activeOfferId, 'offer-new');

  await handlers['voice-answer']({
    from: { id: 2 },
    answer: { type: 'answer', sdp: 'legacy-stale' }
  });
  assert.equal(applied, 0);
  assert.equal(peer._activeOfferId, 'offer-new');

  await handlers['voice-answer']({
    from: { id: 2 },
    offerId: 'offer-new',
    answer: { type: 'answer', sdp: 'current' }
  });
  assert.equal(applied, 1);
  assert.equal(peer._awaitingAnswer, false);
  assert.equal(peer._activeOfferId, null);
  assert.equal(peer._offerTimeoutCount, 0);
});

test('rollback failure preserves the pending offer and rearms recovery', async () => {
  const VoiceManager = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  let scheduled = null;
  const connection = {
    signalingState: 'have-local-offer',
    async setLocalDescription() { throw new Error('rollback failed'); }
  };
  const peer = {
    connection,
    _awaitingAnswer: true,
    _activeOfferId: 'offer-current',
    _offerAnswerTimer: null,
    _offerTimeoutCount: 0,
    _renegotiateQueued: false
  };
  voice.peers = new Map([[2, peer]]);
  voice._scheduleOfferAnswerTimeout = (userId, conn, offerId) => {
    scheduled = { userId, conn, offerId };
  };

  assert.equal(await voice._recoverTimedOutOffer(2, connection, 'offer-current'), false);
  assert.equal(peer._awaitingAnswer, true);
  assert.equal(peer._activeOfferId, 'offer-current');
  assert.equal(peer._recoveringTimedOutOffer, false);
  assert.deepEqual(scheduled, { userId: 2, conn: connection, offerId: 'offer-current' });
});

test('automatic offer recovery stops after its bounded retry budget', async () => {
  const VoiceManager = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  let drainCalls = 0;
  const connection = {
    signalingState: 'have-local-offer',
    async setLocalDescription() { this.signalingState = 'stable'; }
  };
  const peer = {
    connection,
    _awaitingAnswer: true,
    _activeOfferId: 'offer-four',
    _offerAnswerTimer: null,
    _offerTimeoutCount: 3,
    _renegotiateQueued: false
  };
  voice.peers = new Map([[2, peer]]);
  voice._drainQueuedRenegotiation = () => { drainCalls++; };

  assert.equal(await voice._recoverTimedOutOffer(2, connection, 'offer-four'), true);
  assert.equal(peer._offerTimeoutCount, 4);
  assert.equal(peer._renegotiateQueued, false);
  assert.equal(peer._offerRecoveryExhausted, true);
  assert.equal(drainCalls, 0);
});

test('a peer that advertised offer IDs cannot answer without correlation', async () => {
  const VoiceManager = loadVoiceManager();
  const handlers = {};
  const voice = Object.create(VoiceManager.prototype);
  voice.socket = { on: (event, handler) => { handlers[event] = handler; } };
  voice.peers = new Map();
  voice._setupSocketListeners();

  let applied = 0;
  const peer = {
    connection: {
      signalingState: 'have-local-offer',
      async setRemoteDescription() { applied++; }
    },
    _awaitingAnswer: true,
    _activeOfferId: 'offer-current',
    _offerTimeoutCount: 0,
    _supportsOfferIds: true
  };
  voice.peers.set(2, peer);

  await handlers['voice-answer']({
    from: { id: 2 },
    answer: { type: 'answer', sdp: 'uncorrelated' }
  });
  assert.equal(applied, 0);
  assert.equal(peer._awaitingAnswer, true);
});

test('a new media event restarts an exhausted offer recovery budget', async () => {
  const VoiceManager = loadVoiceManager();
  const voice = Object.create(VoiceManager.prototype);
  const emissions = [];
  const connection = {
    signalingState: 'stable',
    async createOffer() { return { type: 'offer', sdp: 'fresh' }; },
    async setLocalDescription() { this.signalingState = 'have-local-offer'; }
  };
  const peer = {
    connection,
    _makingOffer: false,
    _awaitingAnswer: false,
    _offerTimeoutCount: 4,
    _offerRecoveryExhausted: true,
    _renegotiateQueued: false,
    _queuedIceRestart: false
  };
  voice.peers = new Map([[2, peer]]);
  voice.currentChannel = '11111111';
  voice.localUserId = 1;
  voice.socket = { emit: (event, payload) => emissions.push({ event, payload }) };
  voice._scheduleOfferAnswerTimeout = () => {};

  assert.equal(await voice._renegotiate(2, connection), true);
  assert.equal(peer._offerRecoveryExhausted, false);
  assert.equal(peer._offerTimeoutCount, 0);
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].event, 'voice-offer');
  assert.equal(emissions[0].payload.offerId, peer._activeOfferId);
});

test('signaling state guards defer cleanup and drain during recovery', async () => {
  class FakeMediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
  }
  class FakePeerConnection {
    constructor() {
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.listeners = {};
    }
    addEventListener(event, handler) { this.listeners[event] = handler; }
    getReceivers() { return []; }
    close() {}
  }
  const VoiceManager = loadVoiceManager({
    MediaStream: FakeMediaStream,
    RTCPeerConnection: FakePeerConnection
  });
  const voice = Object.create(VoiceManager.prototype);
  voice.peers = new Map();
  voice.rtcConfig = {};
  voice.localStream = null;
  voice.audioBitrate = 0;
  voice.screenStream = null;
  voice.isScreenSharing = false;
  voice.webcamStream = null;
  voice.isWebcamActive = false;
  voice.screenSharers = new Set();
  voice.webcamUsers = new Set();
  voice._screenDelivered = new Set();
  let drainCalls = 0;
  voice._drainQueuedRenegotiation = () => { drainCalls++; };

  await voice._createPeer(2, 'Viewer', false);
  const peer = voice.peers.get(2);
  peer._awaitingAnswer = true;
  peer._activeOfferId = 'offer-current';
  peer._renegotiateQueued = true;
  peer._recoveringTimedOutOffer = true;
  peer.connection.listeners.signalingstatechange();
  assert.equal(peer._awaitingAnswer, true);
  assert.equal(peer._activeOfferId, 'offer-current');
  assert.equal(drainCalls, 0);

  peer._recoveringTimedOutOffer = false;
  peer._awaitingAnswer = false;
  peer._handlingRemoteOffer = true;
  peer.connection.listeners.signalingstatechange();
  assert.equal(drainCalls, 0);

  peer._handlingRemoteOffer = false;
  peer.connection.listeners.signalingstatechange();
  assert.equal(drainCalls, 1);
});

test('glare rollback failure preserves the outgoing offer and rearms its timer', async () => {
  const VoiceManager = loadVoiceManager();
  const handlers = {};
  const voice = Object.create(VoiceManager.prototype);
  voice.socket = { on: (event, handler) => { handlers[event] = handler; } };
  voice.localUserId = 1;
  voice.peers = new Map();
  voice._setupSocketListeners();

  let scheduled = null;
  const connection = {
    signalingState: 'have-local-offer',
    connectionState: 'connected',
    iceConnectionState: 'connected',
    async setLocalDescription() { throw new Error('rollback failed'); }
  };
  const peer = {
    connection,
    _makingOffer: false,
    _awaitingAnswer: true,
    _activeOfferId: 'offer-current',
    _offerAnswerTimer: null,
    _offerIsIceRestart: false,
    _renegotiateQueued: false
  };
  voice.peers.set(2, peer);
  voice._scheduleOfferAnswerTimeout = (userId, conn, offerId) => {
    scheduled = { userId, conn, offerId };
  };

  await handlers['voice-offer']({
    from: { id: 2, username: 'Viewer' },
    offerId: 'remote-offer',
    offer: { type: 'offer', sdp: 'remote' }
  });
  assert.equal(peer._awaitingAnswer, true);
  assert.equal(peer._activeOfferId, 'offer-current');
  assert.equal(peer._handlingRemoteOffer, false);
  assert.deepEqual(scheduled, { userId: 2, conn: connection, offerId: 'offer-current' });
});

test('removing a peer cancels its pending offer timer', () => {
  const cleared = [];
  const VoiceManager = loadVoiceManager({
    clearTimeout: handle => { cleared.push(handle); },
    document: { getElementById: () => null }
  });
  const voice = Object.create(VoiceManager.prototype);
  let closed = false;
  voice.peers = new Map([[2, {
    connection: { close() { closed = true; } },
    _offerAnswerTimer: 42
  }]]);
  voice.screenGainNodes = new Map();
  voice.gainNodes = new Map();
  voice._screenDelivered = new Set();
  voice._stopAnalyser = () => {};

  voice._removePeer(2);
  assert.deepEqual(cleared, [42]);
  assert.equal(closed, true);
  assert.equal(voice.peers.has(2), false);
});
