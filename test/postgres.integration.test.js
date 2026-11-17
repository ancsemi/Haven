'use strict';

// Exercise the actual lazy pg pool against PostgreSQL.
// No tables are changed; use a disposable database.
//
//   HAVEN_TEST_POSTGRES_URL=postgres://... node --test test/postgres.integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-pg-pool-'));
process.env.HAVEN_DATA_DIR = DATA;
const { fromEnv } = require('../src/db');
test.after(() => fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

test('PostgreSQL pool binds queries and normalizes ids and counts', { skip: !process.env.HAVEN_TEST_POSTGRES_URL }, async (t) => {
  const db = fromEnv({ HAVEN_DATABASE_URL: process.env.HAVEN_TEST_POSTGRES_URL });
  t.after(() => db.close());
  assert.equal(db.kind, 'postgres');
  const value = "name' OR 1=1 -- ?";
  assert.deepEqual(await db.prepare('SELECT ?::text AS name, 123::bigint AS id').get(value), { name: value, id: 123 });
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS count FROM (SELECT 1 WHERE false) t').get(), { count: 0 });
  assert.deepEqual(await db.prepare('SELECT 1 AS n UNION ALL SELECT 2 AS n ORDER BY n').all(), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(await db.prepare('SELECT 1').run(), { changes: 1 });
  await assert.rejects(db.prepare('SELECT * FROM haven_intentionally_missing_table').get(), { code: '42P01' });
  assert.equal((await db.prepare('SELECT 1 AS n').get()).n, 1, 'a failed query does not poison the pool');
});
