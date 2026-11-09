'use strict';

// Pinned DMs (preference pinned_dms): each person keeps their own list of DMs
// at the top of their DM list. The server keeps only DMs that person is in,
// each once, in the order given, at most 50.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { cleanPinnedDms, MAX_PINNED_DMS } = require('../src/pinnedDms');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT, is_dm INTEGER DEFAULT 0, is_group INTEGER DEFAULT 0);
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
  `);
  const ch = db.prepare('INSERT INTO channels (id, code, is_dm, is_group) VALUES (?, ?, ?, ?)');
  ch.run(1, 'aaaa0001', 1, 0); // DM between users 1 and 2
  ch.run(2, 'aaaa0002', 1, 0); // DM between users 1 and 3
  ch.run(3, 'aaaa0003', 1, 1); // group DM with users 1, 2, 3
  ch.run(4, 'aaaa0004', 1, 0); // DM between users 2 and 3, not user 1's
  ch.run(5, 'bbbb0005', 0, 0); // ordinary channel user 1 is in
  const m = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  [[1, 1], [1, 2], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3], [4, 2], [4, 3], [5, 1]].forEach(([c, u]) => m.run(c, u));
  return db;
}

test('keeps your own DMs and group DMs in the order given', () => {
  const db = freshDb();
  assert.equal(cleanPinnedDms(db, 1, JSON.stringify(['aaaa0003', 'aaaa0001'])), JSON.stringify(['aaaa0003', 'aaaa0001']));
});

test('drops DMs you are not in, ordinary channels, repeats and junk', () => {
  const db = freshDb();
  const raw = JSON.stringify(['aaaa0004', 'bbbb0005', 'aaaa0002', 'aaaa0002', 7, null, { code: 'aaaa0001' }, '../x', 'nope']);
  assert.equal(cleanPinnedDms(db, 1, raw), JSON.stringify(['aaaa0002']));
});

test('refuses a value with nothing to keep', () => {
  const db = freshDb();
  assert.equal(cleanPinnedDms(db, 1, 'not json'), null);
  assert.equal(cleanPinnedDms(db, 1, '{"a":1}'), null);
  assert.equal(cleanPinnedDms(db, 1, '[]'), null);
  assert.equal(cleanPinnedDms(db, 1, JSON.stringify(['aaaa0004'])), null, 'someone else\'s DM');
});

test('one person\'s pins say nothing about the other person', () => {
  const db = freshDb();
  // User 2 can pin the DM with user 1 independently; user 3 cannot pin it.
  assert.equal(cleanPinnedDms(db, 2, JSON.stringify(['aaaa0001'])), JSON.stringify(['aaaa0001']));
  assert.equal(cleanPinnedDms(db, 3, JSON.stringify(['aaaa0001'])), null);
});

test(`keeps at most ${MAX_PINNED_DMS} pins`, () => {
  const db = freshDb();
  const ch = db.prepare('INSERT INTO channels (id, code, is_dm) VALUES (?, ?, 1)');
  const m = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, 1)');
  const codes = [];
  for (let i = 0; i < 70; i++) {
    const code = 'c' + String(i).padStart(7, '0');
    ch.run(100 + i, code);
    m.run(100 + i);
    codes.push(code);
  }
  const kept = JSON.parse(cleanPinnedDms(db, 1, JSON.stringify(codes)));
  assert.equal(kept.length, MAX_PINNED_DMS);
  assert.deepEqual(kept, codes.slice(0, MAX_PINNED_DMS));
});

test('set-preference accepts pinned_dms through the cleaner and it can be deleted', () => {
  const src = read('src/socketHandlers/users.js');
  assert.match(src, /'pinned_dms',\n\s*\];/);
  assert.match(src, /stored = cleanPinnedDms\(db, socket\.user\.id, value\);\n\s*if \(!stored\) return;/);
  assert.match(src, /const deletableKeys = \[[^\]]*'pinned_dms'\]/);
});

test('the sidebar draws pinned DMs before the rest', () => {
  const src = read('public/js/modules/app-channels.js');
  const split = src.indexOf('this._splitPinnedDms(sortedDms)');
  const pinnedFirst = src.indexOf('pinnedDms.forEach(ch => dmList.appendChild(renderDmItem(ch)));');
  const tagged = src.indexOf('if (hasDmTags) {', pinnedFirst);
  assert.ok(split > 0 && pinnedFirst > split && tagged > pinnedFirst);
});
