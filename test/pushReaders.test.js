'use strict';

// A push carries message text, so it goes only to people who could open
// the channel: not to a banned account, and not past a channel's required
// roles.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { pushReaders } = require('../src/pushReaders');
const { roleGateAllows } = require('../src/roleGate');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, role_gate TEXT, is_dm INTEGER DEFAULT 0);
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
    CREATE TABLE bans (user_id INTEGER UNIQUE);
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER, channel_id INTEGER);
    INSERT INTO users (id, is_admin) VALUES (1, 1), (2, 0), (3, 0), (4, 0);
    INSERT INTO channels (id, role_gate, is_dm) VALUES (10, NULL, 0), (11, '{"mode":"any","roles":[7]}', 0), (12, '{"mode":"any","roles":[7]}', 1);
    INSERT INTO channel_members (channel_id, user_id) VALUES (10, 1), (10, 2), (10, 3), (10, 4), (11, 1), (11, 2), (11, 3), (12, 2), (12, 3);
    INSERT INTO bans (user_id) VALUES (4);
    INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (2, 7, NULL);
  `);
  return db;
}
const gate = (db) => (userId, channel) => roleGateAllows(db, userId, channel);

test('a banned member is not pushed, everyone else in an open channel is', () => {
  const db = freshDb();
  const canRead = pushReaders(db, 10, gate(db));
  assert.deepEqual([1, 2, 3, 4].map(canRead), [true, true, true, false]);
});

test('a channel with required roles pushes only those who hold them, and the admin', () => {
  const db = freshDb();
  const canRead = pushReaders(db, 11, gate(db));
  assert.deepEqual([1, 2, 3].map(canRead), [true, true, false]);
});

test('a DM has no required roles to pass', () => {
  const db = freshDb();
  const canRead = pushReaders(db, 12, gate(db));
  assert.deepEqual([2, 3].map(canRead), [true, true]);
});

test('when the check cannot be made, nobody is pushed', () => {
  const db = freshDb();
  assert.equal(pushReaders(db, 999, gate(db))(2), false, 'no such channel');
  const throwing = pushReaders(db, 11, () => { throw new Error('boom'); });
  assert.equal(throwing(3), false);
  db.exec('DROP TABLE bans');
  assert.equal(pushReaders(db, 10, gate(db))(2), false);
});

test('web push and phone push both go through the check', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/socketHandlers/index.js'), 'utf8');
  assert.match(src, /const canRead = pushReaders\(db, channelId, roleGateAllows\);/);
  assert.match(src, /\(!only \|\| only\.has\(s\.user_id\)\) && canRead\(s\.user_id\)/);
  assert.match(src, /\.filter\(m => canRead\(m\.user_id\)\)/);
});
