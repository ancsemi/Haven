'use strict';

/**
 * A temporary channel goes when its time is up, not when the server's date
 * changes. Its expiry is stored as an ISO time and used to be compared as
 * text with SQLite's own format, so a 1 hour channel lived until the next day.
 * The cleanup runs once a minute, so this test takes about that long.
 *
 *   node --test test/tempChannelExpiry.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3511, 'temp-channel-expiry');
test.before(() => h.start());
test.after(() => h.stop());

test('a temporary channel is deleted once its hour is up', async (t) => {
  const admin = await h.register('admin');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'popup'));
  A.emit('create-channel', { name: 'popup', temporary: true, duration: 1 });
  const ch = (await made).find((c) => c.name === 'popup');
  assert.ok(ch.expires_at && ch.expires_at.includes('T'), 'stored as an ISO time: ' + ch.expires_at);

  // Its hour ran out a minute ago, on the same date.
  db.prepare('UPDATE channels SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60000).toISOString(), ch.code);
  let gone = false;
  for (let i = 0; i < 70 && !gone; i++) {
    await wait(1000);
    gone = !db.prepare('SELECT 1 FROM channels WHERE code = ?').get(ch.code);
  }
  assert.ok(gone, 'the channel was deleted');
  A.disconnect();
});
