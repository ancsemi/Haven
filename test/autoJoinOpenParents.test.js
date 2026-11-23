'use strict';

// An account with no channels is put into the open ones. A sub-channel of a
// private channel is not open, whatever its own setting says.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { joinDefaultChannels } = require('../src/socketHandlers/channelList');

function freshDb(defaults) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, is_dm INTEGER DEFAULT 0, is_private INTEGER DEFAULT 0,
      code_visibility TEXT, parent_channel_id INTEGER, position INTEGER DEFAULT 0);
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER, PRIMARY KEY (channel_id, user_id));
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO channels (id, name, is_private, code_visibility, parent_channel_id) VALUES
      (1, 'lobby', 0, NULL, NULL), (2, 'lobby-sub', 0, NULL, 1),
      (3, 'staff', 1, NULL, NULL), (4, 'staff-sub', 0, NULL, 3),
      (5, 'hidden-code', 0, 'private', NULL), (6, 'hidden-code-sub', 0, NULL, 5),
      (7, 'private-sub-of-open', 1, NULL, 1);
  `);
  if (defaults) db.prepare("INSERT INTO server_settings (key, value) VALUES ('default_join_channels', ?)").run(JSON.stringify(defaults));
  return db;
}
const joined = (db) => db.prepare('SELECT channel_id FROM channel_members WHERE user_id = 9 ORDER BY channel_id').all().map(r => r.channel_id);

test('with no default list, only open channels and the sub-channels of open channels are joined', () => {
  const db = freshDb();
  joinDefaultChannels(db, 9);
  assert.deepEqual(joined(db), [1, 2]);
});

test('a default list cannot name a sub-channel of a private channel', () => {
  const db = freshDb([2, 4, 6]);
  joinDefaultChannels(db, 9);
  assert.deepEqual(joined(db), [2]);
});
