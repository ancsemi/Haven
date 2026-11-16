'use strict';

// Push notifications follow your own mutes: a member muted for you sends
// you none; a muted server sends none except DMs, and with "except
// @mentions" also messages that mention you.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { quietRecipients, pingedRecipients } = require('../src/pushMutes');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, is_dm INTEGER DEFAULT 0);
    CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, mentionable INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER, channel_id INTEGER);
  `);
  db.prepare('INSERT INTO users (id, username, display_name) VALUES (1, ?, ?), (2, ?, ?), (3, ?, ?), (4, ?, ?)')
    .run('sender', 'Sender', 'ann', 'Ann', 'bob', 'Bobby', 'cat', null);
  db.prepare('INSERT INTO channels (id, is_dm) VALUES (10, 0), (20, 1)').run();
  const pref = db.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)');
  pref.run(2, 'server_mute', 'all');
  pref.run(3, 'server_mute', 'mentions');
  pref.run(4, 'muted_users', JSON.stringify([1]));
  return db;
}

test('a muted server is quiet except for DMs; mentions get through "except @mentions"', () => {
  const db = freshDb();
  const plain = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'hello all' });
  assert.deepEqual([...plain].sort(), [2, 3, 4]);
  const mention = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'hey @Bobby look' });
  assert.ok(mention.has(2), 'Mute all stays quiet for a mention');
  assert.ok(!mention.has(3), 'except @mentions lets a mention through (display name)');
  const everyone = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: '@everyone meeting' });
  assert.ok(!everyone.has(3));
  const dm = quietRecipients(db, { channelId: 20, senderUserId: 1, messageContent: 'just you' });
  assert.ok(!dm.has(2) && !dm.has(3), 'DMs come through a muted server');
  const reply = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'sounds good', replyToUserId: 3 });
  assert.ok(!reply.has(3), 'except @mentions lets a reply to you through');
  assert.ok(quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'sounds good', replyToUserId: 2 }).has(2), 'Mute all stays quiet for a reply');
});

test('a member you muted sends you no push, even in a DM or a mention', () => {
  const db = freshDb();
  assert.ok(quietRecipients(db, { channelId: 20, senderUserId: 1, messageContent: '@cat hi' }).has(4));
  assert.ok(!quietRecipients(db, { channelId: 10, senderUserId: 2, messageContent: 'hi' }).has(4), 'others still reach them');
});

test('a mention of a longer name is not a mention of you', () => {
  const db = freshDb();
  db.prepare('UPDATE user_preferences SET value = ? WHERE user_id = 3').run('mentions');
  db.prepare('UPDATE users SET display_name = NULL WHERE id = 3').run();
  assert.ok(quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'hi @bobcat' }).has(3));
  assert.ok(!quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'hi @bob, look' }).has(3));
});

test('a mentions-only device is pushed DMs, replies and pings only', () => {
  const db = freshDb();
  db.prepare("INSERT INTO roles (id, name) VALUES (1, 'Mods'), (2, 'Elsewhere')").run();
  db.prepare("INSERT INTO roles (id, name, mentionable) VALUES (3, 'Gamers', 0)").run();
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (2, 1, NULL), (3, 2, 99), (4, 3, NULL)').run();
  const all = [2, 3, 4];
  const pinged = (messageContent, extra = {}) =>
    [...pingedRecipients(db, { channelId: 10, messageContent, userIds: all, ...extra })].sort();
  assert.deepEqual(pinged('just chatting'), [], 'an ordinary message pushes nobody');
  assert.deepEqual(pinged('hey @ann'), [2]);
  assert.deepEqual(pinged('hey @Bobby'), [3], 'display names count');
  assert.deepEqual(pinged('hey @annabel'), [], 'a longer name is someone else');
  assert.deepEqual(pinged('@here standup'), all);
  assert.deepEqual(pinged('ping @mods'), [2], 'a role you hold');
  assert.deepEqual(pinged('ping @Elsewhere'), [], 'a role held only in another channel');
  assert.deepEqual(pinged('ping @Gamers'), [], 'a role switched off for mentions (#5822)');
  assert.deepEqual(pinged('ping @​mods'), [], 'a defused role ping');
  assert.deepEqual(pinged('sounds good', { replyToUserId: 4 }), [4], 'a reply to you');
  assert.deepEqual([...pingedRecipients(db, { channelId: 20, messageContent: 'psst', userIds: [4] })], [4], 'every DM');
  assert.deepEqual([...pingedRecipients(db, { channelId: 10, messageContent: '@ann', userIds: [] })], []);
});
