'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { defaultQuietRecipients } = require('../src/pushMutes');
function freshDb(level) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, status TEXT);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT, is_dm INTEGER DEFAULT 0, default_notify TEXT DEFAULT 'all');
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
    CREATE TABLE user_channel_prefs (user_id INTEGER, channel_code TEXT, muted INTEGER DEFAULT 0, PRIMARY KEY (user_id, channel_code));
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, mentionable INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER, channel_id INTEGER);
  `);
  db.prepare('INSERT INTO users (id, username, display_name) VALUES (1, ?, ?), (2, ?, ?), (3, ?, ?), (4, ?, ?)').run('sender', 'Sender', 'ann', 'Ann', 'bob', 'Bob', 'cat', 'Cat');
  db.prepare('INSERT INTO channels (id, code, is_dm, default_notify) VALUES (10, ?, 0, ?), (20, ?, 1, ?)').run('aaaaaaaa', level, 'bbbbbbbb', level);
  db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (10, 2), (10, 3), (10, 4), (20, 2)').run();
  db.prepare('INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (3, ?, 0)').run('aaaaaaaa');
  db.prepare('INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (4, ?, 1)').run('aaaaaaaa');
  return db;
}
const ids = (set) => [...set].sort();
test('with the default on All Messages nobody is left out', () => {
  assert.deepEqual(ids(defaultQuietRecipients(freshDb('all'), { channelId: 10, messageContent: 'hello' })), []);
});
test('a Muted default leaves out everyone who made no choice for the channel', () => {
  assert.deepEqual(ids(defaultQuietRecipients(freshDb('muted'), { channelId: 10, messageContent: '@Ann hello' })), [2]);
});
test('a Mentions default lets mentions, replies and everyone pings through', () => {
  const db = freshDb('mentions');
  assert.deepEqual(ids(defaultQuietRecipients(db, { channelId: 10, messageContent: 'hello' })), [2]);
  assert.deepEqual(ids(defaultQuietRecipients(db, { channelId: 10, messageContent: 'hi @ann' })), []);
  assert.deepEqual(ids(defaultQuietRecipients(db, { channelId: 10, messageContent: 'ok', replyToUserId: 2 })), []);
  assert.deepEqual(ids(defaultQuietRecipients(db, { channelId: 10, messageContent: '@everyone hi' })), []);
});
test('a person who chose All or Muted for themselves is left to their own choice', () => {
  const db = freshDb('muted');
  assert.ok(!defaultQuietRecipients(db, { channelId: 10, messageContent: 'hi' }).has(3) && !defaultQuietRecipients(db, { channelId: 10, messageContent: 'hi' }).has(4));
});
test('a DM ignores the channel default', () => {
  assert.deepEqual(ids(defaultQuietRecipients(freshDb('muted'), { channelId: 20, messageContent: 'hi' })), []);
});
