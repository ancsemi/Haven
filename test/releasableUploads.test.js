'use strict';

// Deleting a message takes its files with it, but only the author's own
// attachments that nothing else uses. Naming someone else's avatar, emoji or
// attachment in your own message and deleting it must leave that file alone.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { releasableUploads } = require('../src/socketHandlers/helpers');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE upload_ownership (rel_path TEXT PRIMARY KEY, user_id INTEGER, bytes INTEGER, scope TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, avatar TEXT, border TEXT);
    CREATE TABLE user_personas (id INTEGER PRIMARY KEY, avatar TEXT);
    CREATE TABLE webhooks (id INTEGER PRIMARY KEY, avatar_url TEXT);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, icon TEXT);
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE custom_sounds (id INTEGER PRIMARY KEY, filename TEXT);
    CREATE TABLE custom_emojis (id INTEGER PRIMARY KEY, filename TEXT);
    CREATE TABLE stickers (id INTEGER PRIMARY KEY, filename TEXT);
  `);
  const own = db.prepare('INSERT INTO upload_ownership (rel_path, user_id, bytes, scope) VALUES (?, ?, 0, ?)');
  own.run('mine.png', 1, 'channel');
  own.run('mine-dm.bin', 1, 'dm');
  own.run('theirs.png', 2, 'channel');
  own.run('my-avatar.png', 1, 'profile');
  own.run('reposted.png', 1, 'channel');
  own.run('icon.png', 1, 'channel');
  own.run('boop.mp3', 1, 'channel');
  db.prepare('INSERT INTO messages (content) VALUES (?)').run('look again /uploads/reposted.png');
  db.prepare('INSERT INTO roles (icon) VALUES (?)').run('/uploads/icon.png');
  db.prepare('INSERT INTO custom_sounds (filename) VALUES (?)').run('boop.mp3');
  return db;
}

test('only the author\'s own, unused attachments are released', () => {
  const db = fixture();
  const out = releasableUploads(db, [
    'mine.png', 'mine-dm.bin', 'theirs.png', 'my-avatar.png', 'reposted.png', 'icon.png', 'boop.mp3', 'unknown-legacy.png',
  ], [1]);
  assert.deepEqual(out.sort(), ['mine-dm.bin', 'mine.png']);
});

test('someone else\'s file is never released, whoever deletes', () => {
  const db = fixture();
  assert.deepEqual(releasableUploads(db, ['theirs.png'], [1]), []);
  assert.deepEqual(releasableUploads(db, ['theirs.png'], [2]), ['theirs.png']);
  assert.deepEqual(releasableUploads(db, ['theirs.png'], [null, undefined]), []);
});
