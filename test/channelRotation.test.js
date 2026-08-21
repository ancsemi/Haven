'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { persistChannelCodeRotation, rotateLiveChannelState } = require('../src/channelRotation');

test('channel rotation updates durable preferences and AFK references atomically', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
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
      PRIMARY KEY (user_id, channel_code)
    );
    INSERT INTO channels (id, code, code_rotation_counter) VALUES (1, '11111111', 5);
    INSERT INTO channels (id, code, afk_sub_code) VALUES (2, 'aaaaaaaa', '11111111');
    INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (3, '11111111', 1);
  `);

  persistChannelCodeRotation(db, 1, '11111111', '22222222');

  assert.equal(db.prepare('SELECT code FROM channels WHERE id = 1').get().code, '22222222');
  assert.equal(db.prepare('SELECT afk_sub_code FROM channels WHERE id = 2').get().afk_sub_code, '22222222');
  assert.equal(db.prepare('SELECT channel_code FROM user_channel_prefs WHERE user_id = 3').get().channel_code, '22222222');
});

test('channel rotation migrates text, voice, media, bot audio, and grace state', () => {
  const oldCode = '11111111';
  const newCode = '22222222';
  const roomMoves = [];
  const socket = {
    currentChannel: oldCode,
    user: { isBot: true, channelId: 9, channelCode: oldCode },
    leave(room) { roomMoves.push(['leave', room]); },
    join(room) { roomMoves.push(['join', room]); }
  };
  const passiveEvents = [];
  const passiveBot = {
    user: { isBot: true, channelId: 9, channelCode: oldCode },
    emit(event, payload) { passiveEvents.push({ event, payload }); }
  };
  let emitted;
  const io = {
    sockets: {
      adapter: { rooms: new Map([
        [`channel:${oldCode}`, new Set(['socket-1'])],
        [`voice:${oldCode}`, new Set(['socket-1'])]
      ]) },
      sockets: new Map([['socket-1', socket], ['passive-bot', passiveBot]])
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
  const pending = { code: oldCode };
  const pendingTemp = { timer: null, code: oldCode };
  const state = {
    channelUsers: new Map([[oldCode, new Map([[1, { id: 1 }]])]]),
    voiceUsers: new Map([[oldCode, new Map([[1, { id: 1 }]])]]),
    activeMusic: new Map([[oldCode, { id: 'track' }]]),
    musicQueues: new Map([[oldCode, ['next']]]),
    activeScreenSharers: new Map([[oldCode, new Set([1])]]),
    activeWebcamUsers: new Map([[oldCode, new Set([1])]]),
    streamViewers: new Map([[`${oldCode}:1:screen`, new Set([2])]]),
    pendingVoiceLeave: new Map([[`1:${oldCode}`, pending]]),
    pendingTempDelete: new Map([[oldCode, pendingTemp]])
  };
  let renamed;
  const botAudioManager = {
    renameChannel(from, to) { renamed = [from, to]; }
  };

  rotateLiveChannelState(io, state, botAudioManager, 9, oldCode, newCode);

  assert.equal(socket.currentChannel, newCode);
  assert.equal(socket.user.channelCode, newCode);
  assert.equal(passiveBot.user.channelCode, newCode);
  assert.equal(passiveEvents[0].event, 'channel-code-rotated');
  assert.ok(roomMoves.some(move => move[0] === 'join' && move[1] === `channel:${newCode}`));
  assert.ok(roomMoves.some(move => move[0] === 'join' && move[1] === `voice:${newCode}`));
  for (const name of ['channelUsers', 'voiceUsers', 'activeMusic', 'musicQueues', 'activeScreenSharers', 'activeWebcamUsers']) {
    assert.equal(state[name].has(oldCode), false, `${name} kept the old code`);
    assert.equal(state[name].has(newCode), true, `${name} missed the new code`);
  }
  assert.equal(state.streamViewers.has(`${newCode}:1:screen`), true);
  assert.equal(state.pendingVoiceLeave.has(`1:${newCode}`), true);
  assert.equal(pending.code, newCode);
  assert.equal(state.pendingTempDelete.has(newCode), true);
  assert.equal(pendingTemp.code, newCode);
  assert.deepEqual(renamed, [oldCode, newCode]);
  assert.deepEqual(emitted, {
    firstRoom: `channel:${newCode}`,
    secondRoom: `voice:${newCode}`,
    event: 'channel-code-rotated',
    payload: { channelId: 9, oldCode, newCode }
  });
});
