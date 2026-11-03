'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

// mediaProxy loads the data folder paths: keep them away from a real server's.
process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-media-token-'));
const mediaProxy = require('../src/mediaProxy');

test('a media token stops working once its account is banned or deleted', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, password_version INTEGER DEFAULT 1); CREATE TABLE bans (user_id INTEGER PRIMARY KEY);');
  db.prepare('INSERT INTO users (id) VALUES (3)').run();
  const asyncDb = { prepare: sql => ({
    async get(...params) {
      await new Promise(resolve => setImmediate(resolve));
      return db.prepare(sql).get(...params);
    },
  }) };
  const token = mediaProxy.issueToken(3, 1);
  assert.equal(mediaProxy.verifyToken(token, db), 3);
  assert.equal(await mediaProxy.verifyTokenAsync(token, asyncDb), 3);
  assert.equal(await mediaProxy.verifyTokenAsync('3.' + 'é'.repeat(32), asyncDb), null);
  // A password change (or "sign out other sessions") ends it.
  db.prepare('UPDATE users SET password_version = 2 WHERE id = 3').run();
  assert.equal(mediaProxy.verifyToken(token, db), null);
  assert.equal(await mediaProxy.verifyTokenAsync(token, asyncDb), null);
  db.prepare('UPDATE users SET password_version = 1 WHERE id = 3').run();
  assert.equal(mediaProxy.verifyToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), db), null);
  db.prepare('INSERT INTO bans (user_id) VALUES (3)').run();
  assert.equal(mediaProxy.verifyToken(token, db), null);
  assert.equal(await mediaProxy.verifyTokenAsync(token, asyncDb), null);
  db.prepare('DELETE FROM bans').run();
  db.prepare('DELETE FROM users').run();
  assert.equal(mediaProxy.verifyToken(token, db), null);
  assert.equal(await mediaProxy.verifyTokenAsync(token, asyncDb), null);
});
