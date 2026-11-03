'use strict';

// Backend selection, SQLite compatibility and restarting an existing server.
//
//   node --test test/databaseBackend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-db-backend-'));
process.env.HAVEN_DATA_DIR = DATA;
delete process.env.HAVEN_DATABASE_URL;
const { fromEnv } = require('../src/db');
const { SqliteDatabase } = require('../src/db/sqlite');

test.after(() => fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

test('PostgreSQL selects its on-demand client without opening a connection; invalid schemes still fail', async (t) => {
  const addon = require('../src/db/pgAddon');
  const load = t.mock.method(addon, 'loadPg', () => ({}));
  for (const url of ['postgres://user:secret@db/haven', ' postgresql://user:secret@db/haven ']) {
    const db = fromEnv({ HAVEN_DATABASE_URL: url });
    assert.equal(db.kind, 'postgres');
    assert.equal(db.async, db);
    await db.close();
  }
  for (const url of ['mysql://db/haven', 'sqlite:///tmp/haven.db', 'typo']) {
    assert.throws(() => fromEnv({ HAVEN_DATABASE_URL: url }), /must be a postgres:\/\/ or postgresql:\/\/ URL/);
  }
  assert.equal(fs.existsSync(path.join(DATA, 'haven.db')), false);
  assert.equal(load.mock.callCount(), 2, 'only valid PostgreSQL URLs select the client');
});

test('full PostgreSQL server startup is guarded without opening SQLite or exposing credentials', (t) => {
  const addon = require('../src/db/pgAddon');
  const load = t.mock.method(addon, 'loadPg', () => ({}));
  const { initDatabase } = require('../src/database');
  process.env.HAVEN_DATABASE_URL = 'postgres://user:secret@db/haven';
  try {
    assert.throws(initDatabase, (err) => {
      assert.match(err.message, /PostgreSQL full server startup is not supported yet/);
      assert.doesNotMatch(err.message, /secret|user:|@db/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(DATA, 'haven.db')), false);
    assert.equal(load.mock.callCount(), 0, 'nothing is downloaded just to refuse');
  } finally { delete process.env.HAVEN_DATABASE_URL; }
});

test('unset, empty and whitespace URLs keep SQLite and its existing settings', () => {
  for (const env of [undefined, {}, { HAVEN_DATABASE_URL: '' }, { HAVEN_DATABASE_URL: '  ' }]) {
    const db = fromEnv(env);
    try {
      assert.equal(db.kind, 'sqlite');
      assert.equal(db.name, path.join(DATA, 'haven.db'));
      for (const [setting, expected] of [
        ['journal_mode', 'wal'], ['foreign_keys', 1], ['synchronous', 1],
        ['cache_size', -8000], ['busy_timeout', 5000], ['temp_store', 2],
        ['secure_delete', 1], ['mmap_size', 33554432],
        ['soft_heap_limit', 33554432], ['hard_heap_limit', 67108864],
      ]) {
        assert.equal(db.pragma(setting, { simple: true }), expected, setting);
      }
    } finally { db.close(); }
  }
});

test('statements support legacy and awaited calls, parameters and iteration', async (t) => {
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
  assert.equal(insert.run('first').lastInsertRowid, 1);
  assert.equal((await insert.run('second')).changes, 1);
  assert.deepEqual(db.prepare('SELECT * FROM items WHERE id = ?').get(1), { id: 1, name: 'first' });
  assert.deepEqual(await db.prepare('SELECT * FROM items WHERE id = @id').get({ id: 2 }), { id: 2, name: 'second' });
  const all = db.prepare('SELECT name FROM items ORDER BY id');
  assert.deepEqual(await all.all(), [{ name: 'first' }, { name: 'second' }]);
  assert.deepEqual([...all.iterate()], [{ name: 'first' }, { name: 'second' }]);
});

test('the async SQLite interface returns promises for reads, writes and failures', async (t) => {
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.async.prepare('INSERT INTO items (name) VALUES (?)');
  const written = insert.run('first');
  assert.ok(written instanceof Promise);
  assert.equal((await written).lastInsertRowid, 1);
  // The legacy interface and the async facade share the same connection.
  db.prepare('INSERT INTO items (name) VALUES (?)').run('second');
  const read = db.async.prepare('SELECT name FROM items WHERE id = @id').get({ id: 1 });
  assert.ok(read instanceof Promise);
  assert.deepEqual(await read, { name: 'first' });
  const rows = db.async.prepare('SELECT name FROM items ORDER BY id').all();
  assert.ok(rows instanceof Promise);
  assert.deepEqual(await rows, [{ name: 'first' }, { name: 'second' }]);
  const failed = db.async.prepare('SELECT * FROM missing').all();
  assert.ok(failed instanceof Promise);
  await assert.rejects(failed, /no such table/);
  await assert.rejects(db.async.prepare('INSERT INTO items (id) VALUES (1)').run(), /UNIQUE constraint/);
  db.close();
  await assert.rejects(db.async.prepare('SELECT 1').get(), /not open/);
});

test('legacy transactions keep commit, rollback and nested savepoints', (t) => {
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO items VALUES (?)');
  const inner = db.transaction(() => { insert.run(2); throw new Error('undo inner'); });
  const outer = db.transaction(() => {
    insert.run(1);
    assert.throws(inner, /undo inner/);
    insert.run(3);
  });
  outer.immediate();
  assert.deepEqual(db.prepare('SELECT id FROM items ORDER BY id').all(), [{ id: 1 }, { id: 3 }]);
  assert.throws(db.transaction(() => { insert.run(4); throw new Error('undo outer'); }), /undo outer/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
});

test('schema helpers quote identifiers, add columns once and report real failures', (t) => {
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE "odd""table" (id INTEGER PRIMARY KEY)');
  assert.equal(db.hasTable('missing'), false);
  assert.equal(db.hasTable('odd"table'), true);
  assert.equal(db.hasColumn('odd"table', 'new"column'), false);
  assert.equal(db.addColumn('odd"table', 'new"column', 'TEXT'), true);
  assert.equal(db.hasColumn('odd"table', 'new"column'), true);
  assert.equal(db.addColumn('odd"table', 'new"column', 'TEXT'), false);
  assert.throws(() => db.addColumn('missing', 'value', 'TEXT'), /Database upgrade failed while adding missing.value/);
  assert.throws(() => db.addColumn('odd"table', 'broken', 'INVALID SYNTAX ('), /Database upgrade failed/);
});

test('the bounded statement cache belongs to one connection and clears on close', (t) => {
  const a = new SqliteDatabase(':memory:');
  const b = new SqliteDatabase(':memory:');
  t.after(() => { a.close(); b.close(); });
  const sql = 'SELECT 1 AS n';
  const first = a.prepare(sql);
  assert.equal(a.prepare(sql), first);
  assert.notEqual(b.prepare(sql), first);
  for (let i = 2; i <= 501; i++) a.prepare(`SELECT ${i} AS n`);
  assert.notEqual(a.prepare(sql), first, 'oldest statements are evicted');
  assert.deepEqual(first.get(), { n: 1 }, 'eviction does not invalidate a statement in use');
  a.close();
  assert.throws(() => a.prepare(sql), /not open/);
});

test('database-open failures still explain file ownership and preserve the cause', () => {
  // SQLite cannot open a directory as a database file.
  assert.throws(() => new SqliteDatabase(DATA), (err) => {
    assert.match(err.message, /Haven cannot open its database at/);
    assert.ok(err.message.includes(DATA));
    assert.match(err.message, /readable and writable/);
    assert.match(err.cause.code, /^SQLITE_/);
    return true;
  });
});

test('full schema initialization reopens the same database without stale statements or lost data', () => {
  const { initDatabase, getDb, getAsyncDb } = require('../src/database');
  let db = initDatabase();
  try {
    assert.equal(getDb(), db);
    assert.equal(getAsyncDb(), db.async);
    assert.equal(db.kind, 'sqlite');
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('kept', 'hash');
    const query = db.prepare('SELECT username FROM users WHERE username = ?');
    assert.deepEqual(query.get('kept'), { username: 'kept' });
    db.close();
    db = initDatabase();
    assert.equal(getDb(), db);
    assert.equal(getAsyncDb(), db.async);
    assert.notEqual(db.prepare('SELECT username FROM users WHERE username = ?'), query);
    assert.deepEqual(db.prepare('SELECT username FROM users WHERE username = ?').get('kept'), { username: 'kept' });
    assert.equal(db.hasTable('listening_tokens'), true);
    assert.equal(db.hasColumn('users', 'password_version'), true);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM users WHERE ${db.async.sql.caseInsensitiveEqual('username')}`).all('KEPT');
    assert.ok(plan.some(row => /SEARCH users USING INDEX/.test(row.detail)), 'case-insensitive login retains the username index');
  } finally { db.close(); }
});

test('ordinary PostgreSQL startup stays blocked even with the preview flag set', {
  // PostgreSQL startup tests deliberately run with the source guard removed.
  skip: !!process.env.HAVEN_TEST_POSTGRES_URL,
}, async (t) => {
  const originalUrl = process.env.HAVEN_DATABASE_URL;
  const originalPreview = process.env.HAVEN_POSTGRES_PREVIEW;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.HAVEN_DATABASE_URL;
    else process.env.HAVEN_DATABASE_URL = originalUrl;
    if (originalPreview === undefined) delete process.env.HAVEN_POSTGRES_PREVIEW;
    else process.env.HAVEN_POSTGRES_PREVIEW = originalPreview;
  });
  process.env.HAVEN_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
  const { initDatabaseAsync } = require('../src/database');
  for (const flag of ['', '1']) {
    process.env.HAVEN_POSTGRES_PREVIEW = flag;
    await assert.rejects(initDatabaseAsync(), /PostgreSQL server startup is disabled while database migration is in progress/);
  }
});
