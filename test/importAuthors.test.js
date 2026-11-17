'use strict';

// Imported Discord messages belong to no Haven account (#5771): earlier
// imports are moved over once, and the admin who imported them is not
// suddenly shown them all as unread.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateImportedAuthors } = require('../src/importAuthors');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, user_id INTEGER, content TEXT, imported_from TEXT);
    CREATE TABLE read_positions (user_id INTEGER, channel_id INTEGER, last_read_message_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, channel_id));
  `);
  db.prepare('INSERT INTO users (id, username) VALUES (1, ?), (2, ?)').run('admin', 'bob');
  db.prepare('INSERT INTO channels (id, name) VALUES (10, ?), (11, ?)').run('imported', 'native');
  const add = db.prepare('INSERT INTO messages (channel_id, user_id, content, imported_from) VALUES (?, ?, ?, ?)');
  add.run(10, 1, 'from discord', 'discord');
  add.run(10, 1, 'from discord again', 'discord');
  add.run(11, 2, 'native', null);
  add.run(10, 2, 'native reply in the imported channel', null);
  return db;
}

test('imported messages lose the importing admin; native messages keep their author', () => {
  const db = freshDb();
  migrateImportedAuthors(db);
  const rows = db.prepare('SELECT content, user_id FROM messages ORDER BY id').all();
  assert.deepEqual(rows.map(r => r.user_id), [null, null, 2, 2]);
});

test('the importing admin has the imported channel read up to the import, not further', () => {
  const db = freshDb();
  db.prepare('INSERT INTO read_positions (user_id, channel_id, last_read_message_id) VALUES (1, 10, 1)').run();
  migrateImportedAuthors(db);
  assert.equal(db.prepare('SELECT last_read_message_id AS n FROM read_positions WHERE user_id = 1 AND channel_id = 10').get().n, 2);
  // Nobody else gets a read position out of it.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM read_positions WHERE user_id = 2').get().n, 0);
});

test('it runs once', () => {
  const db = freshDb();
  migrateImportedAuthors(db);
  db.prepare("INSERT INTO messages (channel_id, user_id, content, imported_from) VALUES (10, 1, 'later', 'discord')").run();
  migrateImportedAuthors(db);
  assert.equal(db.prepare("SELECT user_id FROM messages WHERE content = 'later'").get().user_id, 1);
});

test('new imports are stored with no account, and unread counts include account-less messages', () => {
  const importRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'import.js'), 'utf8');
  assert.match(importRoute, /INSERT OR IGNORE INTO messages \(channel_id, user_id, content,[^)]*\)\s*VALUES \(\?, NULL,/);
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'src', 'socketHandlers', 'channelList.js'), 'utf8');
  assert.match(handlers, /AND \(user_id IS NULL OR user_id != \?\) AND thread_id IS NULL /);
});
