'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  createTempChannelDeleteCallback,
  generateUniqueChannelCode,
  persistChannelCodeRotation,
  rotateLiveChannelState,
  schedulePendingVoiceLeave
} = require('../src/channelRotation');

test('channel code generation avoids every shared invite namespace', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
      CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE invite_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
      INSERT INTO channels (id, code) VALUES (1, '22222222');
      INSERT INTO server_settings (key, value) VALUES ('server_code', '33333333'), ('vanity_code', '44444444');
      INSERT INTO invite_codes (id, code) VALUES (1, '55555555');
    `);
    const candidates = ['invalid!', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666'];
    const generated = generateUniqueChannelCode(db, () => candidates.shift(), '11111111');
    assert.equal(generated, '66666666');
  } finally {
    db.close();
  }
});

test('channel rotation updates the channel and durable code references atomically', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY,
        code TEXT UNIQUE,
        code_rotation_counter INTEGER DEFAULT 0,
        code_last_rotated TEXT,
        afk_sub_code TEXT
      );
      CREATE TABLE user_channel_prefs (
        user_id INTEGER,
        channel_code TEXT,
        muted INTEGER,
        updated_at TEXT,
        PRIMARY KEY (user_id, channel_code)
      );
      CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO channels (id, code, code_rotation_counter) VALUES (1, '11111111', 5);
      INSERT INTO channels (id, code, afk_sub_code) VALUES (2, 'aaaaaaaa', '11111111');
      INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (3, '11111111', 1);
      INSERT INTO server_settings (key, value) VALUES ('automod_log_channel', '11111111');
    `);

    assert.equal(persistChannelCodeRotation(db, 1, '11111111', '22222222'), true);

    const rotated = db.prepare('SELECT code, code_rotation_counter, code_last_rotated FROM channels WHERE id = 1').get();
    assert.equal(rotated.code, '22222222');
    assert.equal(rotated.code_rotation_counter, 0);
    assert.ok(rotated.code_last_rotated);
    assert.equal(db.prepare('SELECT afk_sub_code FROM channels WHERE id = 2').get().afk_sub_code, '22222222');
    assert.equal(db.prepare('SELECT channel_code FROM user_channel_prefs WHERE user_id = 3').get().channel_code, '22222222');
    assert.equal(db.prepare("SELECT value FROM server_settings WHERE key = 'automod_log_channel'").get().value, '22222222');
    db.prepare("INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (3, '33333333', 0)").run();
    assert.throws(
      () => persistChannelCodeRotation(db, 1, '22222222', '33333333'),
      /UNIQUE constraint failed/
    );
    assert.equal(db.prepare('SELECT code FROM channels WHERE id = 1').get().code, '22222222');
    assert.equal(db.prepare('SELECT afk_sub_code FROM channels WHERE id = 2').get().afk_sub_code, '22222222');
    assert.equal(db.prepare("SELECT value FROM server_settings WHERE key = 'automod_log_channel'").get().value, '22222222');
    assert.throws(
      () => persistChannelCodeRotation(db, 1, 'stale-code', '33333333'),
      /changed before rotation completed/
    );
    assert.equal(db.prepare('SELECT code FROM channels WHERE id = 1').get().code, '22222222');
  } finally {
    db.close();
  }
});

test('channel rotation migrates text, voice, media, stream, and pending state', () => {
  const oldCode = '11111111';
  const newCode = '22222222';
  const roomMoves = [];
  const textSocket = {
    currentChannel: oldCode,
    leave(room) { roomMoves.push(['text-leave', room]); },
    join(room) { roomMoves.push(['text-join', room]); }
  };
  const voiceSocket = {
    user: { isBot: true, channelCode: oldCode },
    leave(room) { roomMoves.push(['voice-leave', room]); },
    join(room) { roomMoves.push(['voice-join', room]); }
  };
  const idleBotEvents = [];
  const idleBotSocket = {
    user: { isBot: true, channelId: 9, channelCode: oldCode },
    emit(event, payload) { idleBotEvents.push({ event, payload }); }
  };
  let emitted;
  const io = {
    sockets: {
      adapter: { rooms: new Map([
        [`channel:${oldCode}`, new Set(['text-socket'])],
        [`voice:${oldCode}`, new Set(['voice-socket'])]
      ]) },
      sockets: new Map([
        ['text-socket', textSocket],
        ['voice-socket', voiceSocket],
        ['idle-bot-socket', idleBotSocket]
      ])
    },
    to(firstRoom) {
      return {
        to(secondRoom) {
          return {
            emit(event, payload) { emitted = { firstRoom, secondRoom, event, payload }; }
          };
        }
      };
    }
  };
  const pendingVoice = { timer: null, oldSocketId: 'voice-socket', code: oldCode };
  const pendingTempTimer = { id: 'temp-timer' };
  let botAudioRotation;
  const state = {
    channelUsers: new Map([[oldCode, new Map([[1, { id: 1 }]])]]),
    voiceUsers: new Map([[oldCode, new Map([[1, { id: 1 }]])]]),
    activeMusic: new Map([[oldCode, { id: 'track' }]]),
    musicQueues: new Map([[oldCode, ['next']]]),
    activeScreenSharers: new Map([[oldCode, new Set([1])]]),
    activeWebcamUsers: new Map([[oldCode, new Set([1])]]),
    streamViewers: new Map([[`${oldCode}:1`, new Set([2])]]),
    pendingVoiceLeave: new Map([[`1:${oldCode}`, pendingVoice]]),
    pendingTempDelete: new Map([[oldCode, pendingTempTimer]]),
    botAudioManager: {
      renameChannel(from, to) { botAudioRotation = { from, to }; }
    }
  };

  rotateLiveChannelState(io, state, 9, oldCode, newCode);

  assert.equal(textSocket.currentChannel, newCode);
  assert.ok(roomMoves.some(move => move[0] === 'text-join' && move[1] === `channel:${newCode}`));
  assert.ok(roomMoves.some(move => move[0] === 'voice-join' && move[1] === `voice:${newCode}`));
  assert.equal(voiceSocket.user.channelCode, newCode);
  assert.equal(idleBotSocket.user.channelCode, newCode);
  assert.deepEqual(idleBotEvents, [{
    event: 'channel-code-rotated',
    payload: { channelId: 9, oldCode, newCode }
  }]);
  for (const name of ['channelUsers', 'voiceUsers', 'activeMusic', 'musicQueues', 'activeScreenSharers', 'activeWebcamUsers']) {
    assert.equal(state[name].has(oldCode), false, `${name} kept the old code`);
    assert.equal(state[name].has(newCode), true, `${name} missed the new code`);
  }
  assert.equal(state.streamViewers.has(`${newCode}:1`), true);
  assert.equal(state.pendingVoiceLeave.has(`1:${newCode}`), true);
  assert.equal(pendingVoice.code, newCode);
  assert.equal(state.pendingTempDelete.get(newCode), pendingTempTimer);
  assert.deepEqual(botAudioRotation, { from: oldCode, to: newCode });
  assert.deepEqual(emitted, {
    firstRoom: `channel:${newCode}`,
    secondRoom: `voice:${newCode}`,
    event: 'channel-code-rotated',
    payload: { channelId: 9, oldCode, newCode }
  });

  assert.throws(
    () => rotateLiveChannelState(io, state, 9, newCode, newCode),
    /must differ/
  );
  assert.equal(state.voiceUsers.has(newCode), true);
});

test('a pending voice eviction uses the rotated code when its timer fires', () => {
  const oldCode = '11111111';
  const newCode = '22222222';
  let callback;
  let leave;
  const socket = { id: 'old-socket', user: { id: 1, username: 'alice' } };
  const voiceUsers = new Map([[oldCode, new Map([[1, { id: 1, socketId: socket.id }]])]]);
  const pendingVoiceLeave = new Map();
  schedulePendingVoiceLeave({
    pendingVoiceLeave,
    voiceUsers,
    socket,
    userId: 1,
    code: oldCode,
    oldSocketId: socket.id,
    handleVoiceLeave: (_socket, code, options) => { leave = { code, options }; },
    setTimer: fn => { callback = fn; return { id: 'timer' }; },
    log: () => {}
  });

  const io = {
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
    to() { return { to() { return { emit() {} }; } }; }
  };
  const state = {
    channelUsers: new Map(),
    voiceUsers,
    activeMusic: new Map(),
    musicQueues: new Map(),
    activeScreenSharers: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    pendingVoiceLeave,
    pendingTempDelete: new Map()
  };
  rotateLiveChannelState(io, state, 9, oldCode, newCode);
  callback();

  assert.deepEqual(leave, { code: newCode, options: { softDisconnect: true } });
  assert.equal(pendingVoiceLeave.size, 0);
});

test('a temporary-channel timer deletes by stable id after code rotation', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT UNIQUE, is_temp_voice INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER);
      CREATE TABLE reactions (message_id INTEGER);
      CREATE TABLE pinned_messages (channel_id INTEGER);
      CREATE TABLE channel_members (channel_id INTEGER);
      INSERT INTO channels (id, code, is_temp_voice) VALUES (1, '11111111', 1);
    `);
    const channelUsers = new Map([['22222222', new Map()]]);
    const voiceUsers = new Map([['22222222', new Map()]]);
    const pendingTempDelete = new Map([['22222222', { id: 'timer' }]]);
    let deleted;
    let stoppedAudio;
    const callback = createTempChannelDeleteCallback({
      db,
      io: { emit: (event, payload) => { deleted = { event, payload }; } },
      state: {
        channelUsers,
        voiceUsers,
        pendingTempDelete,
        botAudioManager: {
          stopChannel(code, reason) { stoppedAudio = { code, reason }; }
        }
      },
      channelId: 1,
      log: () => {}
    });

    db.prepare("UPDATE channels SET code = '22222222' WHERE id = 1").run();
    callback();

    assert.equal(db.prepare('SELECT 1 FROM channels WHERE id = 1').get(), undefined);
    assert.deepEqual(deleted, {
      event: 'channel-deleted',
      payload: { code: '22222222', reason: 'temp-empty' }
    });
    assert.equal(channelUsers.has('22222222'), false);
    assert.equal(voiceUsers.has('22222222'), false);
    assert.equal(pendingTempDelete.has('22222222'), false);
    assert.deepEqual(stoppedAudio, { code: '22222222', reason: 'channel-deleted' });
  } finally {
    db.close();
  }
});

test('temporary-channel deletion rolls back completely on failure', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT UNIQUE, is_temp_voice INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER);
      CREATE TABLE reactions (message_id INTEGER);
      CREATE TABLE pinned_messages (channel_id INTEGER);
      CREATE TABLE channel_members (channel_id INTEGER);
      INSERT INTO channels (id, code, is_temp_voice) VALUES (1, '11111111', 1);
      INSERT INTO messages (id, channel_id) VALUES (1, 1);
      INSERT INTO channel_members (channel_id) VALUES (1);
      CREATE TRIGGER reject_temp_delete BEFORE DELETE ON channels
      BEGIN
        SELECT RAISE(ABORT, 'delete blocked');
      END;
    `);
    const pendingTempDelete = new Map([['11111111', { id: 'timer' }]]);
    const warnings = [];
    const callback = createTempChannelDeleteCallback({
      db,
      io: { emit() {} },
      state: {
        channelUsers: new Map([['11111111', new Map()]]),
        voiceUsers: new Map([['11111111', new Map()]]),
        pendingTempDelete
      },
      channelId: 1,
      log: () => {},
      warn: (...args) => warnings.push(args.join(' '))
    });

    callback();

    assert.ok(db.prepare('SELECT 1 FROM channels WHERE id = 1').get());
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_id = 1').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM channel_members WHERE channel_id = 1').get().count, 1);
    assert.equal(pendingTempDelete.has('11111111'), false);
    assert.match(warnings[0], /delete blocked/);
  } finally {
    db.close();
  }
});

test('an expired temp-delete timer clears its marker when the room is occupied', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT UNIQUE, is_temp_voice INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER);
      CREATE TABLE reactions (message_id INTEGER);
      CREATE TABLE pinned_messages (channel_id INTEGER);
      CREATE TABLE channel_members (channel_id INTEGER);
      INSERT INTO channels (id, code, is_temp_voice) VALUES (1, '11111111', 1);
    `);
    const pendingTempDelete = new Map([['11111111', { id: 'timer' }]]);
    const callback = createTempChannelDeleteCallback({
      db,
      io: { emit() {} },
      state: {
        channelUsers: new Map(),
        voiceUsers: new Map([['11111111', new Map([[1, { id: 1 }]])]]),
        pendingTempDelete
      },
      channelId: 1,
      log: () => {}
    });

    assert.equal(callback(), false);
    assert.ok(db.prepare('SELECT 1 FROM channels WHERE id = 1').get());
    assert.equal(pendingTempDelete.has('11111111'), false);
  } finally {
    db.close();
  }
});

test('temporary-channel grace is armed before stale-user pruning', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/socketHandlers/index.js'), 'utf8');
  const voiceSource = fs.readFileSync(path.join(__dirname, '../src/socketHandlers/voice.js'), 'utf8');
  const handleVoiceLeave = source.slice(
    source.indexOf('function handleVoiceLeave'),
    source.indexOf('// ── Push notification helper')
  );
  assert.ok(handleVoiceLeave.indexOf('pendingTempDelete.set(code, timer)') < handleVoiceLeave.indexOf('broadcastVoiceUsers(code)'));
  assert.match(source, /ch && ch\.is_temp_voice && !pendingTempDelete\.has\(code\)/);
  assert.match(source, /if \(pendingTempDelete\.has\(ch\.code\)\) continue/);
  assert.match(source, /pendingVoiceLeave\.has\(`\$\{userId\}:\$\{ch\.code\}`\)/);
  assert.match(voiceSource, /if \(pendingTempDelete\?\.has\(code\)\)[\s\S]+Grace-period deletion cancelled/);
  assert.match(source, /persistChannelCodeRotation\([\s\S]+automod\.invalidate\(\)/);
});
