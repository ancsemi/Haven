'use strict';

// The first three migrated queries: real SQLite promises and delayed or
// rejected backend results must keep the sound-list HTTP response intact.
//
//   node --test test/soundsAsync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-sounds-async-'));
process.env.HAVEN_DATA_DIR = DATA;
process.env.JWT_SECRET = 'sounds-async-test-secret';
delete process.env.HAVEN_DATABASE_URL;

const express = require('express');
const jwt = require('jsonwebtoken');
const database = require('../src/database');
const db = database.initDatabase();
const userId = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('listener', 'hash').lastInsertRowid;
const token = jwt.sign({ id: userId, username: 'listener', pwv: 1 }, process.env.JWT_SECRET);
const app = express();
const pass = (req, res, next) => next();
// auth.js installs process-lifetime cleanup intervals when imported. Track
// only intervals created by this import and remove them when this test ends.
const importIntervals = [];
const nativeSetInterval = global.setInterval;
const importTimerMock = test.mock.method(global, 'setInterval', (...args) => {
  const timer = nativeSetInterval(...args);
  importIntervals.push(timer);
  return timer;
});
let registerMediaLibrary;
try {
  registerMediaLibrary = require('../src/routes/media-library');
} finally {
  importTimerMock.mock.restore();
}
const { BUILTIN_SOUNDS } = registerMediaLibrary({
  app, uploadDir: path.join(DATA, 'uploads'),
  uploadLimiter: pass, uploadDiskGuard: pass,
});
const SQL = [
  'SELECT name FROM disabled_builtin_sounds',
  'SELECT name, filename FROM custom_sounds ORDER BY name',
  'SELECT sound_name, volume FROM sound_volumes',
];
const disabled = BUILTIN_SOUNDS[0].name;
const quiet = BUILTIN_SOUNDS[1].name;
const rows = [
  [{ name: disabled }],
  [{ name: 'Custom', filename: 'custom.mp3' }],
  [{ sound_name: quiet, volume: 40 }, { sound_name: 'Custom', volume: 0 }],
];
let server, base;

test.before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const timer of importIntervals) clearInterval(timer);
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function sounds(auth = token) {
  const res = await fetch(base + '/api/sounds', {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.json() };
}

function expectedSounds() {
  return [
    ...BUILTIN_SOUNDS.filter(s => s.name !== disabled).map(s => s.name === quiet ? { ...s, volume: 40 } : s),
    { name: 'Custom', url: '/uploads/custom.mp3', volume: 0 },
  ];
}

test('the async SQLite interface preserves disabled, custom and volume responses', async () => {
  db.prepare('INSERT INTO disabled_builtin_sounds (name) VALUES (?)').run(disabled);
  db.prepare('INSERT INTO custom_sounds (name, filename) VALUES (?, ?)').run('Custom', 'custom.mp3');
  const volume = db.prepare('INSERT INTO sound_volumes (sound_name, volume) VALUES (?, ?)');
  volume.run(quiet, 40);
  volume.run('Custom', 0);
  assert.deepEqual(await sounds(), { status: 200, body: { sounds: expectedSounds() } });
});

test('all three queries accept results that arrive on a later event-loop turn', async (t) => {
  const called = [];
  t.mock.method(database, 'getAsyncDb', () => ({
    prepare(sql) {
      const index = SQL.indexOf(sql);
      assert.notEqual(index, -1);
      return { async all() {
        await nextTurn();
        called.push(sql);
        return rows[index];
      } };
    },
  }));
  assert.deepEqual(await sounds(), { status: 200, body: { sounds: expectedSounds() } });
  assert.deepEqual(called, SQL);
});

test('a rejection from any query keeps the existing built-in fallback', async (t) => {
  for (let failed = 0; failed < SQL.length; failed++) {
    await t.test(SQL[failed], async (t) => {
      const called = [];
      t.mock.method(database, 'getAsyncDb', () => ({
        prepare(sql) {
          called.push(sql);
          return { async all() {
            await nextTurn();
            if (sql === SQL[failed]) throw new Error('backend unavailable');
            return rows[SQL.indexOf(sql)];
          } };
        },
      }));
      assert.deepEqual(await sounds(), { status: 200, body: { sounds: BUILTIN_SOUNDS } });
      assert.deepEqual(called, SQL.slice(0, failed + 1));
    });
  }
});

test('a preparation failure is also contained by the route', async (t) => {
  t.mock.method(database, 'getAsyncDb', () => ({
    prepare() { throw new Error('cannot prepare'); },
  }));
  assert.deepEqual(await sounds(), { status: 200, body: { sounds: BUILTIN_SOUNDS } });
});

test('unauthenticated requests still return 401 before reading the sound tables', async (t) => {
  t.mock.method(database, 'getAsyncDb', () => { throw new Error('must not reach database'); });
  for (const auth of ['', 'invalid-token']) {
    assert.deepEqual(await sounds(auth), { status: 401, body: { error: 'Unauthorized' } });
  }
});

test('PostgreSQL returns the same disabled, custom and volume sound list', { skip: !process.env.HAVEN_TEST_POSTGRES_URL }, async (t) => {
  const { createPostgresFixture } = require('./postgresHarness');
  const fixture = await createPostgresFixture(db, ['disabled_builtin_sounds', 'custom_sounds', 'sound_volumes']);
  const original = db.async;
  db.async = fixture.db;
  t.after(async () => { db.async = original; await fixture.close(); });
  assert.deepEqual(await sounds(), { status: 200, body: { sounds: expectedSounds() } });
});


// These lists load alongside the sound library as members open the app.
db.prepare('INSERT INTO custom_emojis (name, filename) VALUES (?, ?)').run('z_wave', 'wave.gif');
db.prepare('INSERT INTO custom_emojis (name, filename) VALUES (?, ?)').run('a_smile', 'smile.png');
const otherUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('other', 'hash').lastInsertRowid;
const insertPref = db.prepare('INSERT INTO sound_preferences (user_id, sound_name, hidden, custom_order) VALUES (?, ?, ?, ?)');
insertPref.run(userId, 'Custom', 1, 0);
insertPref.run(userId, quiet, 0, null);
insertPref.run(otherUser, 'Other private preference', 1, 2);
const listCases = [
  { route: '/api/emojis', body: { emojis: [
    { name: 'a_smile', url: '/uploads/smile.png' },
    { name: 'z_wave', url: '/uploads/wave.gif' },
  ] }, fallback: { emojis: [] }, table: 'custom_emojis' },
  { route: '/api/user-sound-prefs', body: { prefs: {
    Custom: { hidden: true, customOrder: 0 },
    [quiet]: { hidden: false, customOrder: null },
  } }, fallback: { prefs: {} }, table: 'sound_preferences' },
];

async function list(route, auth = token) {
  const res = await fetch(base + route, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, body: await res.json() };
}

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend} emoji and per-user sound lists`, {
    skip: backend === 'postgres' && !process.env.HAVEN_TEST_POSTGRES_URL,
  }, async (t) => {
    const fixture = backend === 'postgres'
      ? await require('./postgresHarness').createPostgresFixture(db, ['custom_emojis', 'sound_preferences'])
      : null;
    const original = db.async;
    const driver = fixture ? fixture.db : original;
    db.async = driver;
    t.after(async () => { db.async = original; if (fixture) await fixture.close(); });

    await t.test('emoji ordering and private sound preference values stay intact', async () => {
      for (const item of listCases) assert.deepEqual(await list(item.route), { status: 200, body: item.body });
    });

    await t.test('both routes await late results', async (t) => {
      const prepare = driver.prepare.bind(driver);
      const called = [];
      t.mock.method(driver, 'prepare', sql => ({
        async all(...params) {
          await nextTurn();
          called.push(sql);
          return prepare(sql).all(...params);
        },
      }));
      for (const item of listCases) assert.deepEqual(await list(item.route), { status: 200, body: item.body });
      assert.equal(called.length, 2);
    });

    await t.test('rejected reads keep the existing empty-list fallbacks', async (t) => {
      t.mock.method(driver, 'prepare', () => ({
        async all() { await nextTurn(); throw new Error('backend unavailable'); },
      }));
      for (const item of listCases) assert.deepEqual(await list(item.route), { status: 200, body: item.fallback });
    });

    await t.test('missing user preferences or an empty emoji library stay empty', async () => {
      for (const item of listCases) {
        const rows = await driver.prepare(`SELECT * FROM ${item.table}`).all();
        try {
          await driver.prepare(`DELETE FROM ${item.table}`).run();
          assert.deepEqual(await list(item.route), { status: 200, body: item.fallback });
        } finally {
          for (const row of rows) {
            const columns = Object.keys(row);
            await driver.prepare(`INSERT INTO ${item.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
              .run(...Object.values(row));
          }
        }
      }
    });

    await t.test('invalid or missing tokens are refused before reading either table', async (t) => {
      t.mock.method(driver, 'prepare', () => { throw new Error('must not query'); });
      const challenge = jwt.sign({ id: userId, purpose: 'totp_challenge' }, process.env.JWT_SECRET);
      for (const auth of ['', 'invalid', challenge]) {
        for (const item of listCases) assert.deepEqual(await list(item.route, auth), { status: 401, body: { error: 'Unauthorized' } });
      }
    });
  });
}
