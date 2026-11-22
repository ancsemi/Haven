'use strict';

// Auto-cleanup removes the files of the messages it deletes. The paths come
// from message text, so only a real attachment that nothing else uses goes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { releasableUploads } = require('../src/socketHandlers/helpers');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE upload_ownership (rel_path TEXT PRIMARY KEY, user_id INTEGER, bytes INTEGER DEFAULT 0, scope TEXT DEFAULT 'channel');
    CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, is_archived INTEGER DEFAULT 0);
    CREATE TABLE users (id INTEGER PRIMARY KEY, avatar TEXT, border TEXT, banner TEXT);
    CREATE TABLE user_personas (avatar TEXT);
    CREATE TABLE webhooks (avatar_url TEXT);
    CREATE TABLE roles (icon TEXT);
    CREATE TABLE server_settings (key TEXT, value TEXT);
    CREATE TABLE custom_sounds (filename TEXT);
    CREATE TABLE custom_emojis (filename TEXT);
    CREATE TABLE stickers (filename TEXT);
    CREATE TABLE scheduled_messages (content TEXT);
    INSERT INTO upload_ownership (rel_path, user_id, scope) VALUES
      ('attach.png', 2, 'dm'), ('shared.png', 3, 'channel'), ('avatar.png', 3, 'profile');
    INSERT INTO users (id, avatar) VALUES (3, '/uploads/avatar.png'), (4, '/uploads/old-avatar.png');
    INSERT INTO custom_emojis (filename) VALUES ('emoji.png');
    INSERT INTO custom_sounds (filename) VALUES ('sound.mp3');
    INSERT INTO server_settings (key, value) VALUES ('server_icon', '/uploads/icon.png');
    INSERT INTO messages (id, content) VALUES (1, 'still here /uploads/shared.png');
  `);
  return db;
}

test('only an attachment nothing else uses is removed', () => {
  const db = freshDb();
  const named = ['attach.png', 'shared.png', 'avatar.png', 'old-avatar.png', 'emoji.png', 'sound.mp3', 'icon.png', 'legacy.png'];
  assert.deepEqual(releasableUploads(db, named, [], { anyOwner: true }).sort(), ['attach.png', 'legacy.png']);
});

test('without the cleanup option nothing changes for a member deleting a message', () => {
  const db = freshDb();
  assert.deepEqual(releasableUploads(db, ['attach.png', 'legacy.png', 'emoji.png'], [2]), ['attach.png']);
  assert.deepEqual(releasableUploads(db, ['attach.png'], [9]), []);
  assert.deepEqual(releasableUploads(db, ['attach.png'], []), []);
});

test('both cleanup paths go through the check, and the orphan DM sweep no longer moves files itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/maintenance.js'), 'utf8');
  assert.match(src, /releasableUploads\(db, relPaths, \[\], \{ anyOwner: true \}\)/);
  assert.doesNotMatch(src, /for \(const fn of seen\) await moveUploadToDeleted\(fn\)/);
  assert.match(src, /await relocateOrphanAttachments\(\[\.\.\.seen\]\)/);
});
