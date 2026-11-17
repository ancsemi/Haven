'use strict';

// Public server discovery and a member's notification preferences use the
// real HTTP routes with SQLite and, when requested, an isolated PostgreSQL
// fixture. Bulk replacement still belongs to the legacy transaction path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-bootstrap-async-'));
process.env.HAVEN_DATA_DIR = DATA;
process.env.JWT_SECRET = 'bootstrap-async-test-secret';
process.env.SERVER_NAME = 'Environment Haven';
delete process.env.HAVEN_DATABASE_URL;

const express = require('express');
const jwt = require('jsonwebtoken');
const database = require('../src/database');
const { createPostgresFixture } = require('./postgresHarness');
const db = database.initDatabase();
const sqliteAsync = db.async;
const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
const alice = insertUser.run('alice', 'hash').lastInsertRowid;
const bob = insertUser.run('bob', 'hash').lastInsertRowid;
const token = jwt.sign({ id: alice, username: 'alice', pwv: 1 }, process.env.JWT_SECRET);
const bobToken = jwt.sign({ id: bob, username: 'bob', pwv: 1 }, process.env.JWT_SECRET);
const settings = { server_name: 'Test Haven', server_icon: '/uploads/icon.png', server_fingerprint: 'public-fingerprint' };
for (const [key, value] of Object.entries(settings)) {
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
}
db.prepare('INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (?, ?, ?)').run(alice, 'shared', 1);
db.prepare('INSERT INTO user_channel_prefs (user_id, channel_code, muted) VALUES (?, ?, ?)').run(bob, 'bob-only', 1);

const intervals = [];
const nativeSetInterval = global.setInterval;
const timerMock = test.mock.method(global, 'setInterval', (...args) => {
  const timer = nativeSetInterval(...args);
  intervals.push(timer);
  return timer;
});
let verifyToken;
try { ({ verifyToken } = require('../src/auth')); }
finally { timerMock.mock.restore(); }
const app = express();
require('../src/routes/health')({ app });
require('../src/routes/channel-prefs')({ app, verifyToken });
const healthBody = { status: 'online', name: settings.server_name, icon: settings.server_icon, fingerprint: settings.server_fingerprint };
let server, base;

test.before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const timer of intervals) clearInterval(timer);
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(method, route, body, auth = token) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, body: await res.json() };
}
const prefs = (auth) => call('GET', '/api/user/channel-prefs', null, auth);
const mute = (code, muted, auth) => call('POST', '/api/user/channel-prefs/mute', { code, muted }, auth);

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend} server discovery and notification preferences`, {
    skip: backend === 'postgres' && !process.env.HAVEN_TEST_POSTGRES_URL,
  }, async (t) => {
    const fixture = backend === 'postgres' ? await createPostgresFixture(db, ['server_settings', 'user_channel_prefs']) : null;
    const driver = fixture ? fixture.db : sqliteAsync;
    if (fixture) await driver.prepare('CREATE UNIQUE INDEX channel_prefs_key ON user_channel_prefs (user_id, channel_code)').run();
    db.async = driver;
    t.after(async () => { db.async = sqliteAsync; if (fixture) await fixture.close(); });

    await t.test('health keeps its public fields and cross-origin headers', async () => {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(10000) });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), healthBody);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(res.headers.get('vary'), 'Origin');
    });

    await t.test('mute insert, update and unmute affect only the signed-in member', async () => {
      assert.deepEqual(await prefs(), { status: 200, body: { muted: ['shared'] } });
      assert.deepEqual(await prefs(bobToken), { status: 200, body: { muted: ['bob-only'] } });
      const code = "new'; SELECT 1; --";
      assert.deepEqual(await mute(code, true), { status: 200, body: { ok: true } });
      assert.deepEqual(await mute(code, true), { status: 200, body: { ok: true } });
      assert.deepEqual(new Set((await prefs()).body.muted), new Set(['shared', code]));
      assert.deepEqual(await mute(code, false), { status: 200, body: { ok: true } });
      assert.deepEqual(await prefs(), { status: 200, body: { muted: ['shared'] } });
      assert.deepEqual(await prefs(bobToken), { status: 200, body: { muted: ['bob-only'] } });
    });

    await t.test('late query results preserve discovery and saved notification preferences', async (t) => {
      const prepare = driver.prepare.bind(driver);
      const called = [];
      t.mock.method(driver, 'prepare', sql => Object.fromEntries(['get', 'all', 'run'].map(method => [
        method, async (...params) => {
          await nextTurn();
          called.push(sql);
          return prepare(sql)[method](...params);
        },
      ])));
      assert.deepEqual(await call('GET', '/api/health', null, ''), { status: 200, body: healthBody });
      assert.deepEqual(await mute('delayed', true), { status: 200, body: { ok: true } });
      assert.ok((await prefs()).body.muted.includes('delayed'));
      assert.equal(called.length, 5);
      await mute('delayed', false);
    });

    await t.test('empty or absent health settings retain the environment defaults', async () => {
      try {
        for (const value of ['', null]) {
          for (const key of Object.keys(settings)) {
            if (value === null) await driver.prepare('DELETE FROM server_settings WHERE key = ?').run(key);
            else await driver.prepare('UPDATE server_settings SET value = ? WHERE key = ?').run(value, key);
          }
          assert.deepEqual(await call('GET', '/api/health', null, ''), { status: 200, body: {
            status: 'online', name: 'Environment Haven', icon: null, fingerprint: null,
          } });
        }
      } finally {
        for (const [key, value] of Object.entries(settings)) {
          await driver.prepare('DELETE FROM server_settings WHERE key = ?').run(key);
          await driver.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
        }
      }
    });

    await t.test('a failed health read keeps the same defaults and already-read fields', async (t) => {
      const keys = Object.keys(settings);
      for (let failed = 0; failed < keys.length; failed++) {
        await t.test(keys[failed], async (t) => {
          const prepare = driver.prepare.bind(driver);
          t.mock.method(driver, 'prepare', sql => ({
            async get(...params) {
              await nextTurn();
              if (sql.includes("'" + keys[failed] + "'")) throw new Error('backend unavailable');
              return prepare(sql).get(...params);
            },
          }));
          assert.deepEqual(await call('GET', '/api/health', null, ''), { status: 200, body: {
            status: 'online', name: failed > 0 ? settings.server_name : 'Environment Haven',
            icon: failed > 1 ? settings.server_icon : null, fingerprint: null,
          } });
        });
      }
    });

    await t.test('a rejected notification read or write returns the existing error and leaves prefs intact', async (t) => {
      t.mock.method(console, 'error', () => {});
      t.mock.method(driver, 'prepare', () => ({
        async all() { await nextTurn(); throw new Error('backend unavailable'); },
        async run() { await nextTurn(); throw new Error('backend unavailable'); },
      }));
      const failure = { status: 500, body: { error: 'Internal server error' } };
      assert.deepEqual(await prefs(), failure);
      assert.deepEqual(await mute('shared', false), failure);
    });
    assert.deepEqual(await prefs(), { status: 200, body: { muted: ['shared'] } });

    await t.test('bad tokens and invalid channel codes are refused before querying', async (t) => {
      t.mock.method(driver, 'prepare', () => { throw new Error('must not query'); });
      const challenge = jwt.sign({ id: alice, purpose: 'totp_challenge' }, process.env.JWT_SECRET);
      for (const auth of ['', 'invalid', challenge]) {
        assert.deepEqual(await prefs(auth), { status: 401, body: { error: 'Unauthorized' } });
        assert.deepEqual(await mute('shared', false, auth), { status: 401, body: { error: 'Unauthorized' } });
      }
      for (const code of ['', 'a'.repeat(65), null, 3]) {
        assert.deepEqual(await mute(code, true), { status: 400, body: { error: 'Invalid code' } });
      }
    });

    if (fixture) {
      await t.test('these routes finish with legacy SQLite queries blocked after session validation', async (t) => {
        // verifyToken's password-version lookup is still synchronous; warm
        // its short cache before proving the migrated route bodies stand alone.
        assert.ok(verifyToken(token));
        t.mock.method(db, 'prepare', () => { throw new Error('Unconverted SQLite call'); });
        assert.deepEqual(await call('GET', '/api/health', null, ''), { status: 200, body: healthBody });
        assert.deepEqual(await mute('postgres-only', true), { status: 200, body: { ok: true } });
        assert.ok((await prefs()).body.muted.includes('postgres-only'));
        await mute('postgres-only', false);
      });
    }
  });
}
