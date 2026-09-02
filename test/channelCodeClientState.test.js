'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOCKET_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-socket.js'), 'utf8');
const VOICE_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');

function loadSocketMethods(globals = {}) {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, ...globals });
  vm.runInContext(SOCKET_SOURCE.replace(/^export default/, 'module.exports ='), context, {
    filename: 'app-socket.js'
  });
  return context.module.exports;
}

function createStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    get length() { return data.size; },
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    key: index => [...data.keys()][index] || null
  };
}

test('channel code migration updates runtime caches and persisted state', () => {
  const oldCode = '11111111';
  const newCode = '22222222';
  const storage = createStorage({
    haven_voice_channel: oldCode,
    haven_muted_channels: JSON.stringify([oldCode, 'aaaaaaaa']),
    haven_hidden_channels: JSON.stringify([oldCode]),
    [`haven_seen_pin_max_${oldCode}`]: '42',
    [`haven_subtag_collapsed_${oldCode}_news`]: '1'
  });
  const methods = loadSocketMethods({ localStorage: storage, document: { getElementById: () => null } });
  const app = {
    unreadCounts: { [oldCode]: 3 },
    voiceCounts: { [oldCode]: 2 },
    voiceChannelUsers: { [oldCode]: [{ id: 1 }] },
    _pinnedCountByChannel: { [oldCode]: 1 },
    _unreadPinIdByChannel: { [oldCode]: 9 },
    _threadMentions: { [oldCode]: [7] },
    _persistThreadMentions() { this.persistedMentions = true; },
    currentChannel: oldCode,
    _lastVoiceUsersChannel: oldCode,
    _pendingChannelHistoryCode: oldCode,
    _pinsPipChannelCode: oldCode,
    _organizeParentCode: oldCode,
    voice: { currentChannel: oldCode, _softLeftChannel: oldCode, _joiningChannelCode: oldCode },
    channels: [{ afk_sub_code: oldCode }]
  };

  methods._migrateChannelCodeState.call(app, oldCode, newCode);

  for (const store of [
    app.unreadCounts,
    app.voiceCounts,
    app.voiceChannelUsers,
    app._pinnedCountByChannel,
    app._unreadPinIdByChannel,
    app._threadMentions
  ]) {
    assert.equal(Object.hasOwn(store, oldCode), false);
    assert.equal(Object.hasOwn(store, newCode), true);
  }
  assert.equal(app.currentChannel, newCode);
  assert.equal(app.voice.currentChannel, newCode);
  assert.equal(app.voice._softLeftChannel, newCode);
  assert.equal(app.voice._joiningChannelCode, newCode);
  assert.equal(app.channels[0].afk_sub_code, newCode);
  assert.equal(app.persistedMentions, true);
  assert.equal(storage.getItem('haven_voice_channel'), newCode);
  assert.deepEqual(JSON.parse(storage.getItem('haven_muted_channels')), [newCode, 'aaaaaaaa']);
  assert.equal(storage.getItem(`haven_seen_pin_max_${oldCode}`), null);
  assert.equal(storage.getItem(`haven_seen_pin_max_${newCode}`), '42');
  assert.equal(storage.getItem(`haven_subtag_collapsed_${newCode}_news`), '1');
});

test('channel lists detect rotations by stable id across memory and cold starts', () => {
  const storage = createStorage({
    haven_channel_codes_by_id: JSON.stringify({
      ownerId: '7',
      codes: { 1: '11111111', 2: 'aaaaaaaa' }
    })
  });
  const methods = loadSocketMethods({ localStorage: storage });
  const app = Object.assign({
    user: { id: 7 },
    channels: [{ id: 2, code: 'bbbbbbbb' }]
  }, methods);
  const channels = [
    { id: 1, code: '22222222' },
    { id: 2, code: 'cccccccc' }
  ];

  const rotations = methods._collectChannelCodeRotations.call(app, channels);
  assert.deepEqual(JSON.parse(JSON.stringify(rotations)), [
    { channelId: 1, oldCode: '11111111', newCode: '22222222' },
    { channelId: 2, oldCode: 'aaaaaaaa', newCode: 'cccccccc' },
    { channelId: 2, oldCode: 'bbbbbbbb', newCode: 'cccccccc' }
  ]);

  methods._persistChannelCodeMap.call(app, channels);
  assert.deepEqual(JSON.parse(storage.getItem('haven_channel_codes_by_id')), {
    ownerId: '7',
    codes: {
      1: '22222222',
      2: 'cccccccc'
    }
  });

  methods._updatePersistedChannelCode.call(app, 2, 'dddddddd');
  assert.equal(methods._readChannelCodeMap.call(app)[2], 'dddddddd');
  const nextRotations = methods._collectChannelCodeRotations.call(
    { ...app, channels: [] },
    [{ id: 2, code: 'eeeeeeee' }]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(nextRotations)), [
    { channelId: 2, oldCode: 'dddddddd', newCode: 'eeeeeeee' }
  ]);

  const otherUser = Object.assign({ user: { id: 8 }, channels: [] }, methods);
  assert.deepEqual(JSON.parse(JSON.stringify(
    methods._collectChannelCodeRotations.call(otherUser, channels)
  )), []);
  methods._clearChannelCodeMap.call(app);
  assert.equal(storage.getItem('haven_channel_codes_by_id'), null);
});

test('voice-channel-gone can be repaired by channels-list without delaying rejoin', () => {
  const handlers = {};
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: createStorage(),
    console: { log() {}, warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    Date
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const VoiceManager = context.module.exports;
  const voice = Object.create(VoiceManager.prototype);
  voice.socket = { on: (event, handler) => { handlers[event] = handler; } };
  voice.inVoice = true;
  voice.currentChannel = '11111111';
  voice.leaveCalls = 0;
  voice.leave = () => { voice.leaveCalls++; voice.inVoice = false; };
  voice._setupSocketListeners();

  voice.deferChannelGone(6000);
  handlers['voice-channel-gone']({ code: '11111111' });
  assert.equal(voice.leaveCalls, 0);
  voice.currentChannel = '22222222';
  voice.resolveDeferredChannelGone('22222222');
  assert.equal(voice.leaveCalls, 0);

  voice.inVoice = true;
  voice._voiceSessionGeneration = 1;
  voice.deferChannelGone(6000);
  handlers['voice-channel-gone']({ code: '22222222' });
  voice.currentChannel = '33333333';
  voice._voiceSessionGeneration = 2;
  voice.resolveDeferredChannelGone(null);
  assert.equal(voice.leaveCalls, 0);

  voice.inVoice = true;
  voice.deferChannelGone(6000);
  handlers['voice-channel-gone']({ code: '33333333' });
  const originalDeadline = voice._deferChannelGoneUntil;
  const originalTimer = voice._deferredChannelGoneTimer;
  voice.deferChannelGone(6000);
  assert.ok(voice._deferredChannelGone);
  assert.equal(voice._deferChannelGoneUntil, originalDeadline);
  assert.equal(voice._deferredChannelGoneTimer, originalTimer);
  voice.resolveDeferredChannelGone(null);
  assert.equal(voice.leaveCalls, 1);

  const connectHandler = SOCKET_SOURCE.slice(
    SOCKET_SOURCE.indexOf("this.socket.on('connect'"),
    SOCKET_SOURCE.indexOf("this.socket.on('disconnect'")
  );
  assert.match(connectHandler, /emit\('enter-channel'/);
  assert.match(connectHandler, /emit\('voice-rejoin'/);
  assert.doesNotMatch(connectHandler, /await[^;]+channels-list|_resumeChannelsAfterList/);
  const channelListHandler = SOCKET_SOURCE.slice(
    SOCKET_SOURCE.indexOf("this.socket.on('channels-list'"),
    SOCKET_SOURCE.indexOf("this.socket.on('message-history'")
  );
  assert.match(channelListHandler, /voiceRotation[\s\S]+_healPeerConnectionsAfterChannelRotation/);
});

test('rotation recovery rolls back an unanswered offer sent with the old code', async () => {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: createStorage(),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const VoiceManager = context.module.exports;
  const voice = Object.create(VoiceManager.prototype);
  let rollback;
  let healCalls = 0;
  const connection = {
    signalingState: 'have-local-offer',
    async setLocalDescription(description) {
      rollback = description;
      this.signalingState = 'stable';
    }
  };
  const peer = {
    connection,
    _makingOffer: false,
    _awaitingAnswer: true,
    _offerIsIceRestart: true,
    _offerChannelCode: '11111111'
  };
  voice.peers = new Map([[7, peer]]);
  voice._healPeerConnections = () => { healCalls++; };

  await voice._healPeerConnectionsAfterChannelRotation('11111111');

  assert.deepEqual(JSON.parse(JSON.stringify(rollback)), { type: 'rollback' });
  assert.equal(peer._awaitingAnswer, false);
  assert.equal(peer._offerChannelCode, null);
  assert.equal(healCalls, 1);
});

test('voice joins are single-flight while async setup is pending', async () => {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: createStorage(),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const VoiceManager = context.module.exports;
  const voice = Object.create(VoiceManager.prototype);
  voice.socket = { connected: true };
  voice.inVoice = false;
  let rejectSetup;
  voice._fetchIceServers = () => new Promise((resolve, reject) => { rejectSetup = reject; });

  const firstJoin = voice.join('11111111');
  await Promise.resolve();
  assert.equal(voice._joinInFlight, true);
  assert.equal(await voice.join('11111111'), false);
  rejectSetup(new Error('stop setup'));
  assert.equal(await firstJoin, false);
  assert.equal(voice._joinInFlight, false);
  assert.equal(voice._joiningChannelCode, null);
});

test('an async voice join uses a rotated code and does not emit while disconnected', async () => {
  const emissions = [];
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: createStorage({ haven_listener_only: '1' }),
    console: { log() {}, warn() {}, error() {} },
    window: {},
    setTimeout,
    clearTimeout,
    Date
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const VoiceManager = context.module.exports;
  const createVoice = () => {
    const voice = Object.create(VoiceManager.prototype);
    voice.socket = {
      connected: true,
      emit: (event, data) => emissions.push({ event, data })
    };
    voice.inVoice = false;
    voice.isMuted = false;
    voice.isDeafened = false;
    voice._ensureAudioCtx = () => {};
    voice.audioCtx = {
      resume: async () => {},
      close: async () => {},
      createMediaStreamDestination: () => ({ stream: { getTracks: () => [] } })
    };
    voice._applyMuteStateToLocalTracks = () => {};
    voice._disableRNNoise = () => {};
    voice._stopNoiseGate = () => {};
    voice._stopLocalTalkDetection = () => {};
    return voice;
  };

  const rotatedVoice = createVoice();
  let finishSetup;
  rotatedVoice._fetchIceServers = () => new Promise(resolve => { finishSetup = resolve; });
  const rotatedJoin = rotatedVoice.join('11111111');
  rotatedVoice._joiningChannelCode = '22222222';
  finishSetup();
  assert.equal(await rotatedJoin, true);
  assert.deepEqual(JSON.parse(JSON.stringify(
    emissions.find(item => item.event === 'voice-join')
  )), {
    event: 'voice-join',
    data: { code: '22222222' }
  });

  emissions.length = 0;
  const disconnectedVoice = createVoice();
  let finishDisconnectedSetup;
  disconnectedVoice._fetchIceServers = () => new Promise(resolve => { finishDisconnectedSetup = resolve; });
  const disconnectedJoin = disconnectedVoice.join('33333333');
  disconnectedVoice.socket.connected = false;
  finishDisconnectedSetup();
  assert.equal(await disconnectedJoin, false);
  assert.equal(emissions.some(item => item.event === 'voice-join'), false);
});
