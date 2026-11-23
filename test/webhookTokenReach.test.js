'use strict';

// A webhook token works only while the person who made the webhook could
// still open its channel.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { tokenStillReaches } = require('../src/botAccess');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE bans (user_id INTEGER UNIQUE);
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER, channel_id INTEGER);
    INSERT INTO users (id, is_admin) VALUES (1, 1), (2, 0), (3, 0);
    INSERT INTO channel_members (channel_id, user_id) VALUES (10, 2), (11, 2);
    INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (2, 7, NULL);
  `);
  return db;
}
const GATE = '{"mode":"any","roles":[7]}';

test('the token works while its maker can open the channel', () => {
  const db = freshDb();
  assert.equal(tokenStillReaches(db, { created_by: 2, channel_id: 10, role_gate: null }), true);
  assert.equal(tokenStillReaches(db, { created_by: 2, channel_id: 11, role_gate: GATE }), true);
  assert.equal(tokenStillReaches(db, { created_by: 1, channel_id: 99, role_gate: null }), true, 'the admin reaches every channel');
});

test('it stops when the maker is kicked from the channel, loses the required role or is banned', () => {
  const db = freshDb();
  db.prepare('DELETE FROM channel_members WHERE channel_id = 10 AND user_id = 2').run();
  assert.equal(tokenStillReaches(db, { created_by: 2, channel_id: 10, role_gate: null }), false);
  db.prepare('DELETE FROM user_roles WHERE user_id = 2').run();
  assert.equal(tokenStillReaches(db, { created_by: 2, channel_id: 11, role_gate: GATE }), false);
  db.prepare('INSERT INTO bans (user_id) VALUES (2)').run();
  assert.equal(tokenStillReaches(db, { created_by: 2, channel_id: 11, role_gate: null }), false);
  assert.equal(tokenStillReaches(db, { created_by: 3, channel_id: 10, role_gate: null }), false, 'never a member');
});

test('a webhook with no maker on record keeps working, and no row means no', () => {
  const db = freshDb();
  assert.equal(tokenStillReaches(db, { created_by: null, channel_id: 10, role_gate: null }), true);
  assert.equal(tokenStillReaches(db, null), false);
});

test('both token lookups apply it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.equal((src.match(/tokenStillReaches\(/g) || []).length, 2);
});
