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
  const { initializePostgres } = require('../src/db/postgres/schema');
  const versions = () => db.prepare('SELECT version FROM haven_schema_migrations ORDER BY version').all();
  assert.equal(db.kind, 'postgres');
  assert.equal(fs.existsSync(path.join(data, 'haven.db')), false);
  assert.deepEqual(await versions(), [{ version: 1 }]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channels').get()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roles').get()).n, 4);
  const user = await db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, created_at').get('Alice', 'fixture');
  assert.equal(typeof user.id, 'number');
  assert.equal(typeof user.created_at, 'string');
  assert.deepEqual(await db.prepare('SELECT type_id FROM channels').all(), [{ type_id: null }]);

  const addKey = db.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk, created_at) VALUES (?, ?, ?, ?)');
  await addKey.run(user.id, 'z-first', '{"x":"first"}', '2026-01-01 00:00:00');
  await addKey.run(user.id, 'a-second', '{"x":"second"}', '2026-01-01 00:00:00');
  await addKey.run(user.id, '0-latest', '{"x":"newest"}', '2000-01-01 00:00:00');
  const keys = db.prepare('SELECT fp FROM user_signing_keys WHERE user_id = ? ORDER BY insertion_id DESC');
  const ordered = await keys.all(user.id);
  assert.deepEqual(ordered.map(row => row.fp), ['0-latest', 'a-second', 'z-first']);

  const channel = await db.prepare('SELECT id FROM channels').get();
  const kept = await db.prepare("INSERT INTO messages (channel_id, content, is_archived) VALUES (?, 'kept', 1) RETURNING id")
    .get(channel.id);
  await assert.rejects(db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id), /protected message/);
  assert.deepEqual(await db.prepare('SELECT is_archived FROM messages WHERE id = ?').get(kept.id), { is_archived: 1 });

  const fingerprint = db.prepare("SELECT value FROM server_settings WHERE key = 'server_fingerprint'");
  const before = await fingerprint.get();
  await initializePostgres(db);
  assert.deepEqual(await versions(), [{ version: 1 }]);
  assert.deepEqual(await fingerprint.get(), before);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channels').get()).n, 1);
  assert.equal((await db.prepare('SELECT username FROM users WHERE id = ?').get(user.id)).username, 'Alice');
  assert.deepEqual(await keys.all(user.id), ordered);

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

  await db.prepare('INSERT INTO haven_schema_migrations (version) VALUES (4)').run();
  await assert.rejects(initializePostgres(db), /Use an empty test database or schema/);
  assert.deepEqual(await versions(), [{ version: 1 }, { version: 4 }]);
});
