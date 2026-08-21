'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  getAccessibleVoiceChannels,
  getBotVoiceAccessFailure,
  registerBotVoiceSocket
} = require('../src/botVoice');

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
      soundboard_enabled INTEGER DEFAULT 1,
      voice_user_limit INTEGER DEFAULT 0,
      voice_bitrate INTEGER DEFAULT 0
    );
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
    CREATE TABLE webhooks (
      id INTEGER PRIMARY KEY,
      name TEXT,
      channel_id INTEGER,
      created_by INTEGER,
      is_active INTEGER DEFAULT 1,
      can_use_voice INTEGER DEFAULT 0
    );
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

test('voice channel access is scoped to assignment, membership, or admin ownership', t => {
  const db = createDb();
  t.after(() => db.close());

  const memberChannels = getAccessibleVoiceChannels(db, { channel_id: 1, created_by: 10 });
  assert.deepEqual(memberChannels.map(channel => channel.code), ['11111111', '22222222']);

  const adminChannels = getAccessibleVoiceChannels(db, { channel_id: 1, created_by: 11 });
  assert.deepEqual(adminChannels.map(channel => channel.code), ['11111111', '22222222', '44444444']);
});

test('active bot access detects membership, channel, and permission revocation', t => {
  const db = createDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO webhooks (id, name, channel_id, created_by, is_active, can_use_voice)
    VALUES (7, 'Listener', 1, 10, 1, 1)
  `).run();

  assert.equal(getBotVoiceAccessFailure(db, 7, ['11111111', '22222222']), null);
  db.prepare('DELETE FROM channel_members WHERE channel_id = 2 AND user_id = 10').run();
  assert.match(getBotVoiceAccessFailure(db, 7, ['22222222']), /no longer has access/);
  db.prepare('UPDATE channels SET voice_enabled = 0 WHERE id = 1').run();
  assert.match(getBotVoiceAccessFailure(db, 7, ['11111111']), /Voice was disabled/);
  assert.equal(getBotVoiceAccessFailure(db, 7, []), null);
  db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE id = 7').run();
  assert.match(getBotVoiceAccessFailure(db, 7, []), /permission was revoked/);
});

test('bot voice gateway joins visibly and relays signaling', t => {
  const db = createDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO webhooks (id, name, channel_id, created_by, is_active, can_use_voice)
    VALUES (7, 'Listener', 1, 10, 1, 1)
  `).run();

  const outgoing = [];
  const handlers = new Map();
  let packetMiddleware;
  let disconnected = false;
  const socket = {
    id: 'bot-socket',
    user: { id: -7, webhookId: 7, displayName: 'Listener', channelCode: '11111111' },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { outgoing.push({ target: 'bot-socket', event, payload }); },
    use(handler) { packetMiddleware = handler; },
    disconnect() { disconnected = true; },
    join(room) { outgoing.push({ target: 'join', event: room }); },
    leave(room) { outgoing.push({ target: 'leave', event: room }); }
  };
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        emit(event, payload) { outgoing.push({ target, event, payload }); }
      };
    }
  };
  const state = {
    voiceUsers: new Map([['11111111', new Map([[
      42,
      { id: 42, username: 'Human', socketId: 'human-socket', isMuted: false, isDeafened: false }
    ]])]]),
    voiceLastActivity: new Map(),
    activity: null,
    activeScreenSharers: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    activeMusic: new Map(),
    musicQueues: new Map(),
    pendingTempDelete: new Map()
  };
  let broadcasts = 0;
  registerBotVoiceSocket(socket, {
    io,
    db,
    state,
    broadcastVoiceUsers() { broadcasts++; },
    handleVoiceLeave(leavingSocket, code) {
      state.voiceUsers.get(code)?.delete(leavingSocket.user.id);
    }
  });

  let acknowledgement;
  handlers.get('voice-join')({ code: '11111111' }, result => { acknowledgement = result; });
  assert.equal(acknowledgement.success, true);
  assert.equal(state.voiceUsers.get('11111111').get(-7).isListening, true);
  assert.equal(broadcasts, 1);
  assert.ok(outgoing.some(item => item.target === 'human-socket' && item.event === 'voice-user-joined' && item.payload.user.isBot));

  handlers.get('voice-offer')({
    code: '11111111',
    targetUserId: 42,
    offer: { type: 'offer', sdp: 'test' }
  });
  assert.ok(outgoing.some(item => item.target === 'human-socket' && item.event === 'voice-offer' && item.payload.from.isBot));

  state.voiceLastActivity.set(-7, 1);
  handlers.get('voice-speaking')({ speaking: true });
  assert.ok(state.voiceLastActivity.get(-7) > 1);
  state.voiceLastActivity.set(-7, 1);
  handlers.get('voice-activity')();
  assert.ok(state.voiceLastActivity.get(-7) > 1);

  db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE id = 7').run();
  let middlewareError;
  packetMiddleware(['voice-speaking', { speaking: true }], error => { middlewareError = error; });
  assert.match(middlewareError.message, /permission is disabled/);
  assert.equal(disconnected, true);
  assert.equal(state.voiceUsers.get('11111111').has(-7), false);
});

test('a replaced bot socket is disconnected and cannot signal as its replacement', t => {
  const db = createDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO webhooks (id, name, channel_id, created_by, is_active, can_use_voice)
    VALUES (7, 'Listener', 1, 10, 1, 1)
  `).run();

  const outgoing = [];
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to(target) {
      return { emit(event, payload) { outgoing.push({ target, event, payload }); } };
    }
  };
  const state = {
    voiceUsers: new Map([['11111111', new Map([[
      42,
      { id: 42, username: 'Human', socketId: 'human-socket', isMuted: false, isDeafened: false }
    ]])]]),
    voiceLastActivity: new Map()
  };
  let leaveCalls = 0;
  function createSocket(id) {
    const handlers = new Map();
    const socket = {
      id,
      handlers,
      disconnected: false,
      user: { id: -7, webhookId: 7, displayName: 'Listener', channelCode: '11111111' },
      on(event, handler) { handlers.set(event, handler); },
      emit(event, payload) { outgoing.push({ target: id, event, payload }); },
      use() {},
      disconnect() { this.disconnected = true; },
      join() {},
      leave() {}
    };
    sockets.set(id, socket);
    registerBotVoiceSocket(socket, {
      io,
      db,
      state,
      broadcastVoiceUsers() {},
      handleVoiceLeave(leavingSocket, code) {
        leaveCalls++;
        const room = state.voiceUsers.get(code);
        if (room?.get(leavingSocket.user.id)?.socketId === leavingSocket.id) room.delete(leavingSocket.user.id);
      }
    });
    return socket;
  }

  const first = createSocket('bot-old');
  first.handlers.get('voice-join')({ code: '11111111' }, () => {});
  const second = createSocket('bot-new');
  second.handlers.get('voice-join')({ code: '11111111' }, () => {});

  assert.equal(first.disconnected, true);
  assert.equal(leaveCalls, 0);
  assert.equal(state.voiceUsers.get('11111111').get(-7).socketId, 'bot-new');
  const before = outgoing.length;
  first.handlers.get('voice-offer')({
    code: '11111111', targetUserId: 42, offer: { type: 'offer', sdp: 'stale' }
  });
  assert.equal(outgoing.length, before);
});

test('a failed join to a full channel keeps the bot in its current channel', t => {
  const db = createDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO webhooks (id, name, channel_id, created_by, is_active, can_use_voice)
    VALUES (7, 'Listener', 1, 10, 1, 1)
  `).run();
  db.prepare('UPDATE channels SET voice_user_limit = 1 WHERE id = 2').run();

  const handlers = new Map();
  const socket = {
    id: 'bot-socket',
    user: { id: -7, webhookId: 7, displayName: 'Listener', channelCode: '11111111' },
    on(event, handler) { handlers.set(event, handler); },
    emit() {},
    use() {},
    disconnect() {},
    join() {},
    leave() {}
  };
  const io = {
    sockets: { sockets: new Map() },
    to() { return { emit() {} }; }
  };
  const state = {
    voiceUsers: new Map([
      ['11111111', new Map()],
      ['22222222', new Map([[42, { id: 42, username: 'Human', socketId: 'human-socket' }]])]
    ]),
    voiceLastActivity: new Map()
  };
  registerBotVoiceSocket(socket, {
    io,
    db,
    state,
    broadcastVoiceUsers() {},
    handleVoiceLeave(leavingSocket, code) { state.voiceUsers.get(code)?.delete(leavingSocket.user.id); }
  });

  handlers.get('voice-join')({ code: '11111111' }, () => {});
  let result;
  handlers.get('voice-join')({ code: '22222222' }, response => { result = response; });
  assert.match(result.error, /Voice is full/);
  assert.equal(state.voiceUsers.get('11111111').get(-7).socketId, 'bot-socket');
});
