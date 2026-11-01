'use strict';

// PostgreSQL app/startup tests require manually commenting out the explicit
// throw in src/database.js initDatabaseAsync() during migration. Restore the
// throw before committing: ordinary server startup must remain blocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('PostgreSQL preview installs a real constrained schema and rolls transactions back', {
  skip: !process.env.HAVEN_TEST_POSTGRES_URL,
}, async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-postgres-startup-'));
  process.env.HAVEN_DATA_DIR = data;
  const { Client } = require('../src/db/pgAddon').loadPg();
  const client = new Client({ connectionString: process.env.HAVEN_TEST_POSTGRES_URL });
  await client.connect();
  const schema = 'haven_startup_' + crypto.randomBytes(8).toString('hex');
  await client.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.HAVEN_TEST_POSTGRES_URL);
  url.searchParams.set('options', '-c search_path=' + schema);
  process.env.HAVEN_DATABASE_URL = url.href;
  process.env.HAVEN_POSTGRES_PREVIEW = '1';
  let db;
  t.after(async () => {
    if (db) await db.close();
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
    delete process.env.HAVEN_DATABASE_URL;
    delete process.env.HAVEN_POSTGRES_PREVIEW;
    fs.rmSync(data, { recursive: true, force: true });
  });
  db = await require('../src/database').initDatabaseAsync();
  assert.equal(db.kind, 'postgres');
  assert.equal(fs.existsSync(path.join(data, 'haven.db')), false);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channels').get()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roles').get()).n, 4);
  await require('../src/db/postgres/schema').initializePostgres(db);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channels').get()).n, 1);
  const user = await db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, created_at').get('Alice', 'fixture');
  assert.equal(typeof user.id, 'number');
  assert.equal(typeof user.created_at, 'string');
  assert.deepEqual(await db.prepare('SELECT type_id FROM channels').all(), [{ type_id: null }]);
  // Recreate the previous preview schema, with an existing account, and
  // upgrade it without resetting identities, settings or the default room.
  const fingerprint = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_fingerprint'").get();
  await db.exec('ALTER TABLE channels DROP COLUMN type_id; ALTER TABLE user_signing_keys DROP COLUMN insertion_id; DELETE FROM haven_schema_migrations WHERE version >= 2');
  for (const fp of ['a-legacy', 'z-legacy']) {
    await db.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, fp, JSON.stringify({ x: fp }), '2026-01-01 00:00:00');
  }
  await require('../src/db/postgres/schema').initializePostgres(db);
  assert.deepEqual(await db.prepare('SELECT version FROM haven_schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }, { version: 3 }]);
  assert.deepEqual(await db.prepare('SELECT type_id FROM channels').all(), [{ type_id: null }]);
  assert.deepEqual(await db.prepare("SELECT value FROM server_settings WHERE key = 'server_fingerprint'").get(), fingerprint);
  assert.equal((await db.prepare('SELECT username FROM users WHERE id = ?').get(user.id)).username, 'Alice');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roles').get()).n, 4);
  assert.deepEqual((await db.prepare('SELECT fp FROM user_signing_keys WHERE user_id = ? ORDER BY insertion_id DESC').all(user.id)).map(row => row.fp), ['z-legacy', 'a-legacy']);
  await db.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk, created_at) VALUES (?, ?, ?, ?)')
    .run(user.id, '0-latest', '{"x":"newest"}', '2000-01-01 00:00:00');
  assert.equal((await db.prepare('SELECT fp FROM user_signing_keys WHERE user_id = ? ORDER BY insertion_id DESC LIMIT 1').get(user.id)).fp, '0-latest');
  // A version-2 preview already has type_id; only the key sequence is added.
  await db.exec('ALTER TABLE user_signing_keys DROP COLUMN insertion_id; DELETE FROM haven_schema_migrations WHERE version = 3');
  await require('../src/db/postgres/schema').initializePostgres(db);
  assert.deepEqual(await db.prepare('SELECT type_id FROM channels').all(), [{ type_id: null }]);
  await db.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk, created_at) VALUES (?, ?, ?, ?)')
    .run(user.id, '00-current', '{"x":"after-upgrade"}', '1999-01-01 00:00:00');
  const ordered = await db.prepare('SELECT fp FROM user_signing_keys WHERE user_id = ? ORDER BY insertion_id DESC').all(user.id);
  assert.deepEqual(ordered.map(row => row.fp), ['00-current', 'z-legacy', 'a-legacy', '0-latest']);
  await require('../src/db/postgres/schema').initializePostgres(db);
  assert.deepEqual(await db.prepare('SELECT fp FROM user_signing_keys WHERE user_id = ? ORDER BY insertion_id DESC').all(user.id), ordered);
  assert.match(user.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  await assert.rejects(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('aLiCe', 'fixture'), err => err.code === '23505');
  await assert.rejects(db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(9999, user.id), err => err.code === '23503');
  await assert.rejects(db.withTransaction(async tx => {
    await tx.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('rolled_back', 'fixture');
    throw new Error('rollback test');
  }), /rollback test/);
  assert.equal(await db.prepare('SELECT id FROM users WHERE username = ?').get('rolled_back'), undefined);
  let escaped;
  await db.withTransaction(async tx => { escaped = tx; });
  await assert.rejects(escaped.prepare('SELECT 1').get(), /not open/);
});
