'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createDmCalls = require('../src/dmCalls');
function setup() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, code TEXT, is_dm INTEGER DEFAULT 0); CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);');
  const addChannel = (name, code, isDm, members) => {
    const id = db.prepare('INSERT INTO channels (name, code, is_dm) VALUES (?, ?, ?)').run(name, code, isDm).lastInsertRowid;
    for (const m of members) db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, m);
  };
  addChannel('Crew', 'aaaaaaaa', 1, [1, 2, 3]);
  addChannel('DM', 'bbbbbbbb', 1, [1, 2]);
  addChannel('general', 'cccccccc', 0, [1, 2, 3]);
  const got = [];
  const mkSocket = (userId, sid) => ({ id: sid, user: { id: userId, username: `u${userId}` }, emit: (ev, data) => got.push({ to: `user${userId}`, sid, ev, data }) });
  const sockets = new Map([['s1', mkSocket(1, 's1')], ['s2', mkSocket(2, 's2')], ['s2b', mkSocket(2, 's2b')], ['s3', mkSocket(3, 's3')]]);
  const io = { sockets: { sockets }, to: (room) => ({ emit: (ev, data) => got.push({ to: room, ev, data }) }) };
  const voiceUsers = new Map();
  const pushes = [];
  const calls = createDmCalls({ io, db, voiceUsers, sendPushNotifications: (...a) => pushes.push(a) });
  const enter = (code, userId) => { if (!voiceUsers.has(code)) voiceUsers.set(code, new Map()); voiceUsers.get(code).set(userId, { id: userId }); };
  const leave = (code, userId) => { voiceUsers.get(code)?.delete(userId); if (voiceUsers.get(code)?.size === 0) voiceUsers.delete(code); calls.sync(code); };
  const events = (ev, to) => got.filter(g => g.ev === ev && (!to || g.to === to));
  return { calls, got, sockets, enter, leave, events, pushes };
}
test('starting voice in a group DM rings every other member on every device', () => {
  const t = setup();
  t.enter('aaaaaaaa', 1);
  t.calls.joined('aaaaaaaa', { id: 1, username: 'u1' });
  assert.equal(t.events('dm-call-ring', 'user2').length, 2);
  assert.equal(t.events('dm-call-ring', 'user3').length, 1);
  assert.equal(t.events('dm-call-ring', 'user1').length, 0);
  assert.equal(t.events('dm-call-ring')[0].data.isGroup, true);
  assert.equal(t.events('dm-call-ring')[0].data.groupName, 'Crew');
  assert.equal(t.pushes.length, 1);
  t.leave('aaaaaaaa', 1);
});
test('voice in a regular channel rings nobody', () => {
  const t = setup();
  t.enter('cccccccc', 1);
  t.calls.joined('cccccccc', { id: 1, username: 'u1' });
  assert.equal(t.events('dm-call-ring').length, 0);
});
test('answering stops the ring on that member\'s other devices, and an empty room ends the call', () => {
  const t = setup();
  t.enter('aaaaaaaa', 1);
  t.calls.joined('aaaaaaaa', { id: 1, username: 'u1' });
  t.enter('aaaaaaaa', 2);
  t.calls.joined('aaaaaaaa', { id: 2, username: 'u2' });
  assert.deepEqual(t.events('dm-call-ring-stop', 'user2').map(e => e.data.reason), ['answered', 'answered']);
  assert.equal(t.events('dm-call-ring-stop', 'user3').length, 0);
  t.leave('aaaaaaaa', 1);
  assert.equal(t.events('dm-call-ended').length, 0);
  t.leave('aaaaaaaa', 2);
  assert.equal(t.events('dm-call-ended', 'channel:aaaaaaaa').length, 1);
  assert.deepEqual(t.events('dm-call-ring-stop', 'user3').map(e => e.data.reason), ['ended']);
});
test('a declined 1:1 call tells the caller, and only rung members can decline', () => {
  const t = setup();
  t.enter('bbbbbbbb', 1);
  t.calls.joined('bbbbbbbb', { id: 1, username: 'u1' });
  t.calls.decline('bbbbbbbb', { id: 3, username: 'u3' });
  assert.equal(t.events('dm-call-declined').length, 0);
  t.calls.decline('bbbbbbbb', { id: 2, username: 'u2' });
  assert.equal(t.events('dm-call-declined', 'voice:bbbbbbbb').length, 1);
  assert.equal(t.events('dm-call-unanswered', 'user1')[0].data.reason, 'declined');
  t.leave('bbbbbbbb', 1);
});
test('a socket that connects mid-ring gets the call in its snapshot', () => {
  const t = setup();
  t.enter('aaaaaaaa', 1);
  t.calls.joined('aaaaaaaa', { id: 1, username: 'u1' });
  t.calls.snapshotFor(t.sockets.get('s3'));
  const snap = t.events('dm-call-state', 'user3')[0].data.calls;
  assert.equal(snap.length, 1);
  assert.equal(snap[0].ringing, true);
  t.leave('aaaaaaaa', 1);
});
test('rejoining a DM to ring someone again is held to one ring per 30 s, and six per 5 minutes across DMs', () => {
  const t = setup();
  for (let i = 0; i < 3; i++) {
    t.enter('bbbbbbbb', 1);
    t.calls.joined('bbbbbbbb', { id: 1, username: 'u1' });
    t.leave('bbbbbbbb', 1);
  }
  assert.equal(t.events('dm-call-ring', 'user2').length, 2);
  assert.equal(t.pushes.length, 1);
  t.enter('bbbbbbbb', 1);
  t.calls.joined('bbbbbbbb', { id: 1, username: 'u1' });
  t.enter('bbbbbbbb', 2);
  t.calls.joined('bbbbbbbb', { id: 2, username: 'u2' });
  assert.equal(t.events('dm-call-unanswered').length, 0);
  t.leave('bbbbbbbb', 1);
  t.leave('bbbbbbbb', 2);
});
