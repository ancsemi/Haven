'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  disconnectDuplicateBotSockets,
  getAccessibleVoiceChannels,
  getBotVoiceAccessFailure,
  isolateBotVoiceSocket,
  reconcileBotVoiceAccess,
  registerBotVoiceSocket
} = require('../src/botVoice');
const registerAdmin = require('../src/socketHandlers/admin');
const registerVoice = require('../src/socketHandlers/voice');

const BOT_TOKEN = 'a'.repeat(64);

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY,
      code TEXT,
      name TEXT,
      is_dm INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      voice_enabled INTEGER DEFAULT 1,
      voice_user_limit INTEGER DEFAULT 0,
      voice_bitrate INTEGER DEFAULT 0
    );
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
    CREATE TABLE webhooks (
      id INTEGER PRIMARY KEY,
      name TEXT,
      token TEXT,
      channel_id INTEGER,
      created_by INTEGER,
      avatar_url TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      callback_url TEXT,
      callback_secret TEXT,
      subscribed_events TEXT DEFAULT '*',
      last_delivery_status INTEGER,
      last_delivery_at TEXT,
      last_delivery_error TEXT,
      failure_count INTEGER DEFAULT 0,
      can_moderate INTEGER DEFAULT 0,
      can_use_voice INTEGER DEFAULT 0
    );
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO users (id, is_admin) VALUES (?, ?)').run(10, 0);
  db.prepare('INSERT INTO users (id, is_admin) VALUES (?, ?)').run(11, 1);
  const insertChannel = db.prepare(`
    INSERT INTO channels (id, code, name, is_dm, position, voice_enabled, voice_user_limit, voice_bitrate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertChannel.run(1, '11111111', 'Assigned', 0, 1, 1, 0, 64);
  insertChannel.run(2, '22222222', 'Member', 0, 2, 1, 0, 64);
  insertChannel.run(3, '33333333', 'Private DM', 1, 3, 1, 0, 64);
  insertChannel.run(4, '44444444', 'Restricted', 0, 4, 1, 0, 64);
  db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(2, 10);
  return db;
}

function insertBot(db, overrides = {}) {
  const bot = {
    id: 7,
    name: 'Listener',
    token: BOT_TOKEN,
    channel_id: 1,
    created_by: 10,
    is_active: 1,
    can_use_voice: 1,
    ...overrides
  };
  db.prepare(`
    INSERT INTO webhooks (id, name, token, channel_id, created_by, is_active, can_use_voice)
    VALUES (@id, @name, @token, @channel_id, @created_by, @is_active, @can_use_voice)
  `).run(bot);
  return bot;
}

function createSocket(id = 'bot-socket') {
  const outgoing = [];
  const handlers = new Map();
  const rooms = new Set([id]);
  let packetMiddleware = null;
  const socket = {
    id,
    connected: true,
    outgoing,
    handlers,
    rooms,
    user: {
      id: -7,
      webhookId: 7,
      botToken: BOT_TOKEN,
      username: 'bot-7',
      displayName: 'Listener',
      channelCode: '11111111',
      isBot: true
    },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { outgoing.push({ target: id, event, payload }); },
    use(handler) { packetMiddleware = handler; },
    disconnect() { this.connected = false; },
    join(room) {
      const joined = Array.isArray(room) ? room : [room];
      for (const item of joined) rooms.add(item);
      outgoing.push({ target: 'join', event: room });
      return Promise.resolve();
    },
    leave(room) {
      rooms.delete(room);
      outgoing.push({ target: 'leave', event: room });
      return Promise.resolve();
    },
    get packetMiddleware() { return packetMiddleware; }
  };
  return socket;
}

function createGatewayHarness(db, initialVoiceUsers = null) {
  const outgoing = [];
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to(target) {
      return {
        emit(event, payload) { outgoing.push({ target, event, payload }); }
      };
    }
  };
  const state = {
    voiceUsers: initialVoiceUsers || new Map(),
    voiceLastActivity: new Map()
  };
  let broadcasts = 0;
  function handleVoiceLeave(socket, code) {
    const room = state.voiceUsers.get(code);
    if (room?.get(socket.user.id)?.socketId !== socket.id) return;
    room.delete(socket.user.id);
    socket.leave(`voice:${code}`);
    if (room.size === 0) state.voiceUsers.delete(code);
    state.voiceLastActivity.delete(socket.user.id);
  }
  function register(socket) {
    sockets.set(socket.id, socket);
    registerBotVoiceSocket(socket, {
      io,
      db,
      state,
      broadcastVoiceUsers() { broadcasts++; },
      handleVoiceLeave
    });
    return socket;
  }
  return { io, state, outgoing, register, handleVoiceLeave, get broadcasts() { return broadcasts; } };
}

function createAdminHarness(db, user, io = null) {
  const handlers = new Map();
  const outgoing = [];
  const socket = {
    user,
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { outgoing.push({ event, payload }); }
  };
  const actualIo = io || {
    sockets: { sockets: new Map() },
    of() { return { sockets: new Map() }; },
    except() { return { emit() {} }; }
  };
  const revoked = [];
  registerAdmin(socket, {
    io: actualIo,
    db,
    state: { channelUsers: new Map() },
    userHasPermission: () => true,
    getUserEffectiveLevel: () => 0,
    getUserPermissions: () => [],
    getUserRoles: () => [],
    getUserHighestRole: () => null,
    emitOnlineUsers() {},
    broadcastChannelLists() {},
    generateUniqueSharedCode: () => '99999999',
    logAudit() {},
    fireWebhookEvent() {},
    onReferrerPolicyChange() {},
    automod: { invalidate() {}, settings: () => ({}) },
    getIdleOnlineUsers: () => [],
    getUploadUsage: () => ({ byUser: new Map() }),
    revokeBotVoiceAccess(webhookId, reason) { revoked.push({ webhookId, reason }); }
  });
  return { handlers, outgoing, revoked };
}

test('voice channel access is scoped to assignment, membership, or admin ownership', t => {
  const db = createDb();
  t.after(() => db.close());

  const memberChannels = getAccessibleVoiceChannels(db, { channel_id: 1, created_by: 10 });
  assert.deepEqual(memberChannels.map(channel => channel.code), ['11111111', '22222222']);

  const adminChannels = getAccessibleVoiceChannels(db, { channel_id: 1, created_by: 11 });
  assert.deepEqual(adminChannels.map(channel => channel.code), ['11111111', '22222222', '44444444']);
});

test('active bot access detects token, membership, channel, and permission revocation', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);

  assert.equal(getBotVoiceAccessFailure(db, 7, ['11111111', '22222222'], BOT_TOKEN), null);
  db.prepare('DELETE FROM channel_members WHERE channel_id = 2 AND user_id = 10').run();
  assert.match(getBotVoiceAccessFailure(db, 7, ['22222222'], BOT_TOKEN), /no longer has access/);
  db.prepare('UPDATE channels SET voice_enabled = 0 WHERE id = 1').run();
  assert.match(getBotVoiceAccessFailure(db, 7, ['11111111'], BOT_TOKEN), /Voice was disabled/);
  assert.equal(getBotVoiceAccessFailure(db, 7, [], BOT_TOKEN), null);
  db.prepare("UPDATE webhooks SET token = ? WHERE id = 7").run('b'.repeat(64));
  assert.match(getBotVoiceAccessFailure(db, 7, [], BOT_TOKEN), /token was rotated/);
  db.prepare('UPDATE webhooks SET token = ?, can_use_voice = 0 WHERE id = 7').run(BOT_TOKEN);
  assert.match(getBotVoiceAccessFailure(db, 7, [], BOT_TOKEN), /permission was revoked/);
});

test('bot voice gateway joins visibly, relays authorized signaling, and refreshes AFK activity', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  const room = new Map([[
    42,
    { id: 42, username: 'Human', socketId: 'human-socket', isMuted: false, isDeafened: false }
  ]]);
  const harness = createGatewayHarness(db, new Map([['11111111', room]]));
  const socket = harness.register(createSocket());

  let acknowledgement;
  socket.handlers.get('voice-join')({ code: '11111111' }, result => { acknowledgement = result; });
  assert.equal(acknowledgement.success, true);
  assert.equal(harness.state.voiceUsers.get('11111111').get(-7).isListening, true);
  assert.equal(harness.broadcasts, 1);
  assert.ok(harness.outgoing.some(item =>
    item.target === 'human-socket' && item.event === 'voice-user-joined' && item.payload.user.isBot
  ));

  socket.handlers.get('voice-offer')({
    code: '11111111',
    targetUserId: 42,
    offer: { type: 'offer', sdp: 'test' }
  });
  assert.ok(harness.outgoing.some(item =>
    item.target === 'human-socket' && item.event === 'voice-offer' && item.payload.from.isBot
  ));

  harness.state.voiceLastActivity.set(-7, 1);
  socket.handlers.get('voice-speaking')({ speaking: true });
  assert.ok(harness.state.voiceLastActivity.get(-7) > 1);
  harness.state.voiceLastActivity.set(-7, 1);
  socket.handlers.get('voice-activity')();
  assert.ok(harness.state.voiceLastActivity.get(-7) > 1);

  db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE id = 7').run();
  let middlewareError;
  socket.packetMiddleware(['voice-speaking', { speaking: true }], error => { middlewareError = error; });
  assert.match(middlewareError.message, /permission was revoked/);
  assert.equal(socket.connected, false);
  assert.equal(harness.state.voiceUsers.get('11111111').has(-7), false);
});

test('a replaced bot socket is disconnected and cannot signal as its replacement', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  const room = new Map([[
    42,
    { id: 42, username: 'Human', socketId: 'human-socket', isMuted: false, isDeafened: false }
  ]]);
  const harness = createGatewayHarness(db, new Map([['11111111', room]]));
  const first = harness.register(createSocket('bot-old'));
  first.handlers.get('voice-join')({ code: '11111111' }, () => {});
  const second = harness.register(createSocket('bot-new'));
  second.handlers.get('voice-join')({ code: '11111111' }, () => {});

  assert.equal(first.connected, false);
  assert.equal(harness.state.voiceUsers.get('11111111').get(-7).socketId, 'bot-new');
  const before = harness.outgoing.length;
  first.handlers.get('voice-offer')({
    code: '11111111', targetUserId: 42, offer: { type: 'offer', sdp: 'stale' }
  });
  assert.equal(harness.outgoing.length, before);
});

test('a failed join to a full channel keeps the bot in its current channel', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  db.prepare('UPDATE channels SET voice_user_limit = 1 WHERE id = 2').run();
  const harness = createGatewayHarness(db, new Map([
    ['11111111', new Map()],
    ['22222222', new Map([[42, { id: 42, username: 'Human', socketId: 'human-socket' }]])]
  ]));
  const socket = harness.register(createSocket());

  socket.handlers.get('voice-join')({ code: '11111111' }, () => {});
  let result;
  socket.handlers.get('voice-join')({ code: '22222222' }, response => { result = response; });
  assert.match(result.error, /Voice is full/);
  assert.equal(harness.state.voiceUsers.get('11111111').get(-7).socketId, socket.id);
});

test('a voice-disabled channel rejects join without leaving the current channel', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  db.prepare('UPDATE channels SET voice_enabled = 0 WHERE id = 2').run();
  const harness = createGatewayHarness(db);
  const socket = harness.register(createSocket());
  socket.handlers.get('voice-join')({ code: '11111111' }, () => {});

  let result;
  socket.handlers.get('voice-join')({ code: '22222222' }, response => { result = response; });
  assert.match(result.error, /Voice is disabled/);
  assert.equal(harness.state.voiceUsers.get('11111111').get(-7).socketId, socket.id);
});

test('periodic reconciliation revokes an idle bot without waiting for another packet', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  const socket = createSocket();
  socket.rooms.add('voice:11111111');
  const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
  const state = { voiceUsers: new Map() };
  db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE id = 7').run();
  const revoked = [];

  const count = reconcileBotVoiceAccess(io, db, state, (webhookId, reason) => {
    revoked.push({ webhookId, reason });
  });
  assert.equal(count, 1);
  assert.deepEqual(revoked, [{ webhookId: 7, reason: 'Bot voice permission was revoked' }]);
});

test('duplicate process protection disconnects the previous bot before it can keep voice ownership', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  const oldSocket = createSocket('bot-old');
  const newSocket = createSocket('bot-new');
  const state = {
    voiceUsers: new Map([['11111111', new Map([[-7, {
      id: -7, username: 'Listener', socketId: oldSocket.id, isBot: true
    }]])]]),
    voiceLastActivity: new Map([[-7, Date.now()]])
  };
  const io = { sockets: { sockets: new Map([[oldSocket.id, oldSocket], [newSocket.id, newSocket]]) } };
  function handleVoiceLeave(socket, code) {
    const room = state.voiceUsers.get(code);
    if (room?.get(socket.user.id)?.socketId === socket.id) room.delete(socket.user.id);
  }

  assert.equal(disconnectDuplicateBotSockets(newSocket, { io, state, handleVoiceLeave }), 1);
  assert.equal(oldSocket.connected, false);
  assert.equal(state.voiceUsers.get('11111111').has(-7), false);
});

test('bot sockets can join voice rooms but cannot join or receive textual/global rooms', () => {
  const socket = createSocket();
  isolateBotVoiceSocket(socket);
  socket.join('channel:11111111');
  socket.join(['voice:11111111', 'admins', 'channel:22222222']);

  assert.equal(socket.rooms.has('bot-sockets'), true);
  assert.equal(socket.rooms.has('voice:11111111'), true);
  assert.equal(socket.rooms.has('channel:11111111'), false);
  assert.equal(socket.rooms.has('channel:22222222'), false);
  assert.equal(socket.rooms.has('admins'), false);
});

test('only admins can change voice permission and revocation is immediate', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db, { can_use_voice: 0 });

  const moderator = createAdminHarness(db, { id: 20, isAdmin: false });
  moderator.handlers.get('update-webhook')({ id: 7, can_use_voice: 1 });
  assert.equal(db.prepare('SELECT can_use_voice FROM webhooks WHERE id = 7').get().can_use_voice, 0);
  assert.match(moderator.outgoing.at(-1).payload, /Only admins/);

  const admin = createAdminHarness(db, { id: 11, isAdmin: true });
  admin.handlers.get('update-webhook')({ id: 7, can_use_voice: 1 });
  assert.equal(db.prepare('SELECT can_use_voice FROM webhooks WHERE id = 7').get().can_use_voice, 1);
  admin.handlers.get('update-webhook')({ id: 7, can_use_voice: 0 });
  assert.equal(db.prepare('SELECT can_use_voice FROM webhooks WHERE id = 7').get().can_use_voice, 0);
  assert.match(admin.revoked.at(-1).reason, /permission was revoked/);
});

test('non-admin integration managers cannot obtain privileged bot tokens owned by someone else', t => {
  const db = createDb();
  t.after(() => db.close());
  insertBot(db);
  insertBot(db, {
    id: 8,
    name: 'Admin Listener',
    token: 'd'.repeat(64),
    created_by: 11,
    can_use_voice: 0
  });
  const moderator = createAdminHarness(db, { id: 10, isAdmin: false });

  moderator.handlers.get('get-webhooks')();
  let list = moderator.outgoing.filter(item => item.event === 'webhooks-list').at(-1).payload.webhooks;
  assert.equal(list.find(webhook => webhook.id === 7).token, BOT_TOKEN);
  assert.equal(list.find(webhook => webhook.id === 8).token, null);

  db.prepare('UPDATE webhooks SET can_use_voice = 1 WHERE id = 8').run();
  moderator.handlers.get('get-webhooks')();
  list = moderator.outgoing.filter(item => item.event === 'webhooks-list').at(-1).payload.webhooks;
  assert.equal(list.find(webhook => webhook.id === 8).token, null);
});

test('human voice snapshots preserve bot identity and listening state', t => {
  const db = createDb();
  t.after(() => db.close());
  const handlers = new Map();
  const outgoing = [];
  const socket = {
    id: 'human-socket',
    user: { id: 10, username: 'human', displayName: 'Human', isAdmin: false },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { outgoing.push({ event, payload }); }
  };
  const state = {
    channelUsers: new Map(),
    voiceUsers: new Map([['11111111', new Map([[-7, {
      id: -7,
      username: 'Listener',
      socketId: 'bot-socket',
      isMuted: false,
      isDeafened: false,
      isBot: true,
      isListening: true
    }]])]]),
    voiceLastActivity: new Map(),
    activeMusic: new Map(),
    activeScreenSharers: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    pendingTempDelete: new Map(),
    pendingVoiceLeave: new Map()
  };
  registerVoice(socket, {
    io: { to() { return { emit() {}, to() { return { emit() {} }; } }; } },
    db,
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

  handlers.get('request-voice-users')({ code: '11111111' });
  handlers.get('get-voice-counts')();
  const roster = outgoing.find(item => item.event === 'voice-users-update').payload.users[0];
  const count = outgoing.find(item => item.event === 'voice-count-update').payload.users[0];
  assert.equal(roster.isBot, true);
  assert.equal(roster.isListening, true);
  assert.equal(count.isBot, true);
  assert.equal(count.isListening, true);
});

test('kicking a bot from voice clears its dynamic audio queue', t => {
  const db = createDb();
  t.after(() => db.close());
  const handlers = new Map();
  const moderator = {
    id: 'human-socket',
    user: { id: 10, username: 'human', displayName: 'Human', isAdmin: true },
    on(event, handler) { handlers.set(event, handler); },
    emit() {}
  };
  const botSocket = { leave() {} };
  const state = {
    channelUsers: new Map(),
    voiceUsers: new Map([['11111111', new Map([
      [10, { id: 10, username: 'Human', socketId: 'human-socket' }],
      [-7, { id: -7, username: 'Listener', socketId: 'bot-socket', isBot: true }]
    ])]]),
    voiceLastActivity: new Map(),
    activeMusic: new Map(),
    activeScreenSharers: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    pendingTempDelete: new Map(),
    pendingVoiceLeave: new Map()
  };
  const stopped = [];
  registerVoice(moderator, {
    io: {
      sockets: { sockets: new Map([['bot-socket', botSocket]]) },
      to() { return { emit() {}, to() { return { emit() {} }; } }; }
    },
    db,
    state,
    userHasPermission: () => true,
    getUserEffectiveLevel: userId => userId === 10 ? 10 : 0,
    getUserHighestRole: () => null,
    broadcastVoiceUsers() {},
    emitOnlineUsers() {},
    handleVoiceLeave() {},
    touchVoiceActivity() {},
    pruneStaleVoiceUsers: () => [],
    getMentionableChannelMembers: () => [],
    getActiveMusicSyncState: () => null,
    getMusicQueuePayload: () => ({}),
    botAudioManager: { stopWebhook(webhookId) { stopped.push(webhookId); } }
  });

  handlers.get('voice-kick')({ code: '11111111', userId: -7 });
  assert.deepEqual(stopped, [7]);
  assert.equal(state.voiceUsers.get('11111111').has(-7), false);
});

test('administrative global broadcasts explicitly exclude bot sockets', t => {
  const db = createDb();
  t.after(() => db.close());
  const broadcasts = [];
  const io = {
    sockets: { sockets: new Map() },
    of() { return { sockets: new Map() }; },
    emit(event) { broadcasts.push({ room: null, event }); },
    except(room) {
      return { emit(event, payload) { broadcasts.push({ room, event, payload }); } };
    }
  };
  const admin = createAdminHarness(db, { id: 11, isAdmin: true }, io);
  admin.handlers.get('update-server-setting')({ key: 'server_name', value: 'Gateway Test' });

  assert.equal(broadcasts.some(item => item.room === null), false);
  assert.ok(broadcasts.some(item => item.room === 'bot-sockets' && item.event === 'server-setting-changed'));
});

test('server namespace broadcasts always declare the bot exclusion room', () => {
  const root = path.resolve(__dirname, '..');
  const files = [
    path.join(root, 'src/channelRotation.js'),
    ...fs.readdirSync(path.join(root, 'src/socketHandlers'))
      .filter(file => file.endsWith('.js'))
      .map(file => path.join(root, 'src/socketHandlers', file))
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bio\.emit\(/, `${path.basename(file)} has an unrestricted io.emit`);
    assert.doesNotMatch(source, /\bsocket\.broadcast\.emit\(/, `${path.basename(file)} has an unrestricted broadcast.emit`);
  }
});
