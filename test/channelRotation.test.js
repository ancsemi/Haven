'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  generateUniqueChannelCode,
  persistChannelCodeRotation,
  rotateLiveChannelState
} = require('../src/channelRotation');

test('channel code generation avoids every shared invite namespace', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
      CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE invite_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
      CREATE TABLE channel_code_history (old_code TEXT PRIMARY KEY, channel_id INTEGER);
      INSERT INTO channels (id, code) VALUES (1, '22222222');
      INSERT INTO server_settings (key, value) VALUES ('server_code', '33333333'), ('vanity_code', '44444444');
      INSERT INTO invite_codes (id, code) VALUES (1, '55555555');
      INSERT INTO channel_code_history (old_code, channel_id) VALUES ('66666666', 1);
    `);
    const candidates = ['invalid!', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777'];
    const generated = generateUniqueChannelCode(db, () => candidates.shift(), '11111111');
    assert.equal(generated, '77777777');
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
      CREATE TABLE channel_code_history (
        old_code TEXT PRIMARY KEY,
        channel_id INTEGER,
        rotated_at TEXT
      );
      INSERT INTO channels (id, code, code_rotation_counter) VALUES (1, '11111111', 5);
      INSERT INTO channels (id, code, afk_sub_code) VALUES (2, 'aaaaaaaa', '11111111');
      INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (3, '11111111', 1);
    `);

    persistChannelCodeRotation(db, 1, '11111111', '22222222');

    const rotated = db.prepare('SELECT code, code_rotation_counter, code_last_rotated FROM channels WHERE id = 1').get();
    assert.equal(rotated.code, '22222222');
    assert.equal(rotated.code_rotation_counter, 0);
    assert.ok(rotated.code_last_rotated);
    assert.equal(db.prepare('SELECT afk_sub_code FROM channels WHERE id = 2').get().afk_sub_code, '22222222');
    assert.equal(db.prepare('SELECT channel_code FROM user_channel_prefs WHERE user_id = 3').get().channel_code, '22222222');
    assert.equal(db.prepare("SELECT channel_id FROM channel_code_history WHERE old_code = '11111111'").get().channel_id, 1);

    db.prepare("INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (3, '33333333', 0)").run();
    assert.throws(
      () => persistChannelCodeRotation(db, 1, '22222222', '33333333'),
      /UNIQUE constraint failed/
    );
    assert.equal(db.prepare('SELECT code FROM channels WHERE id = 1').get().code, '22222222');
    assert.equal(db.prepare('SELECT afk_sub_code FROM channels WHERE id = 2').get().afk_sub_code, '22222222');
    assert.equal(db.prepare("SELECT 1 FROM channel_code_history WHERE old_code = '22222222'").get(), undefined);

    assert.throws(
      () => persistChannelCodeRotation(db, 1, 'stale-code', '33333333'),
      /changed before rotation completed/
    );
    assert.equal(db.prepare('SELECT code FROM channels WHERE id = 1').get().code, '22222222');
  } finally {
    db.close();
  }
});

test('channel rotation permanently reserves prior codes', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT UNIQUE, code_rotation_counter INTEGER DEFAULT 0, code_last_rotated TEXT, afk_sub_code TEXT);
      CREATE TABLE user_channel_prefs (user_id INTEGER, channel_code TEXT, updated_at TEXT, PRIMARY KEY (user_id, channel_code));
      CREATE TABLE channel_code_history (old_code TEXT PRIMARY KEY, channel_id INTEGER, rotated_at TEXT);
      INSERT INTO channels (id, code) VALUES (1, '00000000');
    `);
    let oldCode = '00000000';
    for (let index = 1; index <= 1025; index++) {
      const newCode = index.toString(16).padStart(8, '0');
      persistChannelCodeRotation(db, 1, oldCode, newCode);
      oldCode = newCode;
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM channel_code_history WHERE channel_id = 1').get().count, 1025);
    assert.ok(db.prepare("SELECT 1 FROM channel_code_history WHERE old_code = '00000000'").get());
    assert.ok(db.prepare("SELECT 1 FROM channel_code_history WHERE old_code = '00000001'").get());
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
    leave(room) { roomMoves.push(['voice-leave', room]); },
    join(room) { roomMoves.push(['voice-join', room]); }
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
        ['voice-socket', voiceSocket]
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
  const state = {
    channelUsers: new Map([[oldCode, new Map([[1, { id: 1 }]])]]),
    voiceUsers: new Map([[oldCode, new Map([[1, { id: 1 }]])]]),
    activeMusic: new Map([[oldCode, { id: 'track' }]]),
    musicQueues: new Map([[oldCode, ['next']]]),
    activeScreenSharers: new Map([[oldCode, new Set([1])]]),
    activeWebcamUsers: new Map([[oldCode, new Set([1])]]),
    streamViewers: new Map([[`${oldCode}:1`, new Set([2])]]),
    pendingVoiceLeave: new Map([[`1:${oldCode}`, pendingVoice]]),
    pendingTempDelete: new Map([[oldCode, pendingTempTimer]])
  };

  rotateLiveChannelState(io, state, 9, oldCode, newCode);

  assert.equal(textSocket.currentChannel, newCode);
  assert.ok(roomMoves.some(move => move[0] === 'text-join' && move[1] === `channel:${newCode}`));
  assert.ok(roomMoves.some(move => move[0] === 'voice-join' && move[1] === `voice:${newCode}`));
  for (const name of ['channelUsers', 'voiceUsers', 'activeMusic', 'musicQueues', 'activeScreenSharers', 'activeWebcamUsers']) {
    assert.equal(state[name].has(oldCode), false, `${name} kept the old code`);
    assert.equal(state[name].has(newCode), true, `${name} missed the new code`);
  }
  assert.equal(state.streamViewers.has(`${newCode}:1`), true);
  assert.equal(state.pendingVoiceLeave.has(`1:${newCode}`), true);
  assert.equal(pendingVoice.code, newCode);
  assert.deepEqual(pendingVoice.previousCodes, [oldCode]);
  assert.equal(state.pendingTempDelete.get(newCode), pendingTempTimer);
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
