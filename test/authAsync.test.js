'use strict';

// Auth entry-point reads run through the same HTTP routes on both backends.
// The legacy SQLite fixture remains only for unconverted auth helpers; this
// split is test-only and initDatabase() never enables it for a live server.
//
//   node --test test/authAsync.test.js
//   HAVEN_TEST_POSTGRES_URL=postgres://... node --test test/authAsync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-auth-async-'));
process.env.HAVEN_DATA_DIR = DATA;
process.env.JWT_SECRET = 'auth-async-test-secret';
delete process.env.HAVEN_DATABASE_URL;

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const database = require('../src/database');
const { createPostgresFixture } = require('./postgresHarness');
const db = database.initDatabase();
const sqliteAsync = db.async;
const PASSWORD = 'flowtest12345';
const hash = bcrypt.hashSync(PASSWORD, 4);
const insertUser = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)');
const admin = insertUser.run('admin', hash, 1).lastInsertRowid;
const alice = insertUser.run('alice', hash, 0).lastInsertRowid;
const banned = insertUser.run('banned', hash, 0).lastInsertRowid;
const totp = insertUser.run('totp', hash, 0).lastInsertRowid;
const sso = insertUser.run('sso', '', 0).lastInsertRowid;
db.prepare('UPDATE users SET display_name = ?, avatar = ?, encrypted_servers = ? WHERE id = ?')
  .run('Alice Example', '/uploads/alice.png', 'opaque-server-list', alice);
db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(totp);
db.prepare('UPDATE users SET oidc_subject = ? WHERE id = ?').run('external-subject', sso);
db.prepare('INSERT INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)').run(banned, admin, 'Test ban');
db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('guests_enabled', 'true')").run();
for (const used of [0, 0, 1]) db.prepare('INSERT INTO totp_backup_codes (user_id, code_hash, used) VALUES (?, ?, ?)').run(alice, 'fixture', used);
for (const used of [0, 1]) db.prepare('INSERT INTO account_recovery_codes (user_id, code_hash, used) VALUES (?, ?, ?)').run(alice, 'fixture', used);
const registrationSettings = {
  registration_token_enabled: 'true',
  invites_bypass_registration_token: 'true',
  registration_token: 'private-registration-token',
  registration_captcha_enabled: 'true',
  turnstile_site_key: '  public-site-key  ',
};
const setSetting = db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(registrationSettings)) setSetting.run(key, value);
const registrationInfo = {
  requiresToken: true, invitesBypassToken: true, captchaEnabled: true, turnstileSiteKey: 'public-site-key',
};
const registrationFallback = { requiresToken: false, captchaEnabled: false, turnstileSiteKey: '' };
const token = jwt.sign({ id: alice, username: 'alice', pwv: 1 }, process.env.JWT_SECRET);

// Only these process-lifetime auth cleanup timers belong to this import.
const importIntervals = [];
const nativeSetInterval = global.setInterval;
const importTimerMock = test.mock.method(global, 'setInterval', (...args) => {
  const timer = nativeSetInterval(...args);
  importIntervals.push(timer);
  return timer;
});
let router;
try { ({ router } = require('../src/auth')); }
finally { importTimerMock.mock.restore(); }

const SQL = {
  registrationFlags: "SELECT key, value FROM server_settings WHERE key IN ('registration_token_enabled', 'invites_bypass_registration_token')",
  registrationToken: "SELECT value FROM server_settings WHERE key = 'registration_token'",
  registrationCaptcha: "SELECT value FROM server_settings WHERE key = 'registration_captcha_enabled'",
  registrationSiteKey: "SELECT value FROM server_settings WHERE key = 'turnstile_site_key'",
  login: 'SELECT * FROM users WHERE LOWER(username) = LOWER(?)',
  ban: 'SELECT reason FROM bans WHERE user_id = ?',
  validate: 'SELECT username, display_name, avatar FROM users WHERE id = ?',
  password: 'SELECT id, password_hash FROM users WHERE id = ?',
  totp: 'SELECT totp_enabled FROM users WHERE id = ?',
  backup: 'SELECT COUNT(*) as count FROM totp_backup_codes WHERE user_id = ? AND used = 0',
  recovery: 'SELECT COUNT(*) as count FROM account_recovery_codes WHERE user_id = ? AND used = 0',
  servers: 'SELECT encrypted_servers FROM users WHERE id = ?',
  guest: "SELECT value FROM server_settings WHERE key = 'guests_enabled'",
};
const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json());
app.use('/api/auth', router);
let server, base;
let requestId = 0;

test.before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const timer of importIntervals) clearInterval(timer);
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(method, route, body, auth = token) {
  const res = await fetch(base + route, {
    method,
    headers: {
      'X-Forwarded-For': `198.51.100.${++requestId % 200 + 1}`,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, body: await res.json() };
}
const login = (username = 'aLiCe', password = PASSWORD) => call('POST', '/login',
  { username, password, eulaVersion: '2.0', ageVerified: true }, '');

async function flows() {
  const registration = await call('GET', '/registration-info', null, '');
  assert.deepEqual(registration, { status: 200, body: registrationInfo });
  assert.ok(!JSON.stringify(registration).includes(registrationSettings.registration_token), 'the registration token stays private');
  const signedIn = await login();
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.user.id, alice);
  assert.equal(signedIn.body.user.isAdmin, false);
  assert.equal(jwt.verify(signedIn.body.token, process.env.JWT_SECRET).id, alice);
  assert.deepEqual(await call('GET', '/validate'), { status: 200, body: {
    username: 'alice', displayName: 'Alice Example', avatar: '/uploads/alice.png',
  } });
  assert.deepEqual(await call('POST', '/verify-password', { password: PASSWORD }), { status: 200, body: { valid: true } });
  assert.deepEqual(await call('GET', '/totp/status'), { status: 200, body: { enabled: false, backupCodesRemaining: 2 } });
  assert.deepEqual(await call('GET', '/recovery-codes/status'), { status: 200, body: { count: 1 } });
  assert.deepEqual(await call('GET', '/user-servers'), { status: 200, body: { blob: 'opaque-server-list' } });
  assert.deepEqual(await call('GET', '/guest-info', null, ''), { status: 200, body: { guestsEnabled: true } });
}

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend} auth lookups`, { skip: backend === 'postgres' && !process.env.HAVEN_TEST_POSTGRES_URL }, async (t) => {
    const fixture = backend === 'postgres' ? await createPostgresFixture(db, [
      'users', 'bans', 'server_settings', 'totp_backup_codes', 'account_recovery_codes',
    ]) : null;
    const driver = fixture ? fixture.db : sqliteAsync;
    db.async = driver;
    SQL.login = `SELECT * FROM users WHERE ${driver.sql.caseInsensitiveEqual('username')}`;
    const expectedQueries = Object.values(SQL);
    t.after(async () => { db.async = sqliteAsync; if (fixture) await fixture.close(); });

    await t.test('the real backend preserves every entry-point query result', flows);

    await t.test('every lookup awaits results that arrive on a later event-loop turn', async (t) => {
      const prepare = driver.prepare.bind(driver);
      const calls = [];
      t.mock.method(driver, 'prepare', sql => ({
        async get(...params) {
          await nextTurn();
          calls.push(sql);
          return prepare(sql).get(...params);
        },
        async all(...params) {
          await nextTurn();
          calls.push(sql);
          return prepare(sql).all(...params);
        },
      }));
      await flows();
      assert.deepEqual(calls, expectedQueries);
    });

    await t.test('registration handles disabled, empty and missing settings without exposing secrets', async () => {
      const update = driver.prepare('UPDATE server_settings SET value = ? WHERE key = ?');
      const remove = driver.prepare('DELETE FROM server_settings WHERE key = ?');
      const insert = driver.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?)');
      try {
        for (const key of ['registration_token_enabled', 'invites_bypass_registration_token', 'registration_captcha_enabled']) {
          await update.run('false', key);
        }
        assert.deepEqual(await call('GET', '/registration-info', null, ''), { status: 200, body: {
          requiresToken: false, invitesBypassToken: false, captchaEnabled: false, turnstileSiteKey: '',
        } });

        await update.run('true', 'registration_token_enabled');
        await update.run('true', 'invites_bypass_registration_token');
        await update.run('', 'registration_token');
        await update.run('true', 'registration_captcha_enabled');
        await update.run('   ', 'turnstile_site_key');
        assert.deepEqual(await call('GET', '/registration-info', null, ''), { status: 200, body: {
          requiresToken: false, invitesBypassToken: true, captchaEnabled: false, turnstileSiteKey: '',
        } });

        for (const key of Object.keys(registrationSettings)) await remove.run(key);
        assert.deepEqual(await call('GET', '/registration-info', null, ''), { status: 200, body: {
          requiresToken: false, invitesBypassToken: false, captchaEnabled: false, turnstileSiteKey: '',
        } });
      } finally {
        for (const [key, value] of Object.entries(registrationSettings)) {
          await remove.run(key);
          await insert.run(key, value);
        }
      }
    });

    await t.test('bad credentials reveal no ban reason; SSO and second-factor gates remain', async (t) => {
      const prepare = driver.prepare.bind(driver);
      const calls = [];
      t.mock.method(driver, 'prepare', sql => ({
        async get(...params) { calls.push(sql); return prepare(sql).get(...params); },
      }));
      assert.deepEqual(await login('missing'), { status: 401, body: { error: 'Invalid credentials' } });
      assert.deepEqual(await login('banned', 'wrong'), { status: 401, body: { error: 'Invalid credentials' } });
      assert.ok(!calls.includes(SQL.ban), 'ban reasons are not read before a correct password');
      assert.deepEqual(await login('banned'), { status: 403, body: {
        error: 'You have been banned from this server', banned: true, reason: 'Test ban', canAppeal: true,
      } });
      const external = await login('sso');
      assert.equal(external.status, 401);
      assert.match(external.body.error, /signs in through SSO/);
      const secondFactor = await login('totp');
      assert.equal(secondFactor.status, 200);
      assert.equal(secondFactor.body.requiresTOTP, true);
      assert.ok(secondFactor.body.challengeToken);
      assert.equal(secondFactor.body.token, undefined);
    });

    await t.test('missing accounts keep their existing 404 or 401 responses', async (t) => {
      t.mock.method(driver, 'prepare', () => ({ async get() { await nextTurn(); return undefined; } }));
      assert.deepEqual(await call('GET', '/validate'), { status: 404, body: { error: 'User not found' } });
      assert.deepEqual(await call('POST', '/verify-password', { password: PASSWORD }),
        { status: 401, body: { valid: false, error: 'Invalid credentials' } });
      assert.deepEqual(await call('GET', '/totp/status'), { status: 404, body: { error: 'User not found' } });
    });

    await t.test('a rejected query fails closed in every route', async (t) => {
      const cases = [
        ...[SQL.registrationFlags, SQL.registrationToken, SQL.registrationCaptcha, SQL.registrationSiteKey].map(sql =>
          [sql, () => call('GET', '/registration-info', null, ''), 200, registrationFallback]),
        [SQL.login, () => login(), 500, { error: 'Server error' }],
        [SQL.ban, () => login(), 500, { error: 'Server error' }],
        [SQL.validate, () => call('GET', '/validate'), 500, { error: 'Server error' }],
        [SQL.password, () => call('POST', '/verify-password', { password: PASSWORD }), 500, { valid: false, error: 'Server error' }],
        [SQL.totp, () => call('GET', '/totp/status'), 500, { error: 'Server error' }],
        [SQL.backup, () => call('GET', '/totp/status'), 500, { error: 'Server error' }],
        [SQL.recovery, () => call('GET', '/recovery-codes/status'), 401, { error: 'Invalid token' }],
        [SQL.servers, () => call('GET', '/user-servers'), 500, { error: 'Server error' }],
        [SQL.guest, () => call('GET', '/guest-info', null, ''), 200, { guestsEnabled: false }],
      ];
      for (const [failed, request, status, body] of cases) {
        await t.test(failed, async (t) => {
          const prepare = driver.prepare.bind(driver);
          t.mock.method(console, 'error', () => {});
          t.mock.method(driver, 'prepare', sql => ({
            async get(...params) {
              await nextTurn();
              if (sql === failed) throw new Error('backend unavailable');
              return prepare(sql).get(...params);
            },
            async all(...params) {
              await nextTurn();
              if (sql === failed) throw new Error('backend unavailable');
              return prepare(sql).all(...params);
            },
          }));
          assert.deepEqual(await request(), { status, body });
        });
      }
    });

    await t.test('session-only lookups refuse invalid and second-factor tokens before querying', async (t) => {
      t.mock.method(driver, 'prepare', () => { throw new Error('must not query'); });
      const challenge = jwt.sign({ id: alice, purpose: 'totp_challenge' }, process.env.JWT_SECRET);
      for (const auth of ['', 'invalid', challenge]) {
        for (const route of ['/validate', '/totp/status', '/recovery-codes/status', '/user-servers']) {
          assert.equal((await call('GET', route, null, auth)).status, 401);
        }
        assert.equal((await call('POST', '/verify-password', { password: PASSWORD }, auth)).status, 401);
      }
    });

    if (fixture) {
      await t.test('registration bootstrap completes without any legacy SQLite calls', async (t) => {
        t.mock.method(db, 'prepare', () => { throw new Error('Unconverted SQLite call'); });
        assert.deepEqual(await call('GET', '/registration-info', null, ''), { status: 200, body: registrationInfo });
      });
      await t.test('login reaches the first unconverted legacy query after both PostgreSQL reads', async (t) => {
        const query = driver._query.bind(driver);
        const reads = [];
        const legacy = [];
        t.mock.method(console, 'error', () => {});
        t.mock.method(driver, '_query', async (...args) => { reads.push(args[0].text); return query(...args); });
        t.mock.method(db, 'prepare', sql => { legacy.push(sql); throw new Error('Unconverted SQLite call'); });
        assert.deepEqual(await login(), { status: 500, body: { error: 'Server error' } });
        assert.equal(reads.length, 2);
        assert.match(reads[0], /LOWER\("username"\) = LOWER\(\$1\)/);
        assert.match(reads[1], /FROM bans WHERE user_id = \$1/);
        assert.deepEqual(legacy, ['SELECT id FROM users WHERE is_admin = 1 LIMIT 1']);
      });
    }
  });
}
