'use strict';

// PostgreSQL query binding, result shapes and connection lifecycle, with
// no server or open database connection needed.
//
//   node --test test/postgresDatabase.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresDatabase } = require('../src/db/postgres');

function fake(result = { rows: [{ value: 1 }], rowCount: 1 }) {
  const calls = [];
  let ended = 0;
  const db = new PostgresDatabase({ pool: {
    async query(text, params) { calls.push({ text, params }); return result; },
    async end() { ended++; },
  } });
  return { db, calls, ended: () => ended };
}

test('get/all/run bind values and keep SQLite-compatible results', async () => {
  const { db, calls } = fake();
  const value = "name' OR 1=1 --";
  assert.deepEqual(await db.prepare('SELECT ? AS value').get(value), { value: 1 });
  assert.deepEqual(calls[0], { text: 'SELECT $1 AS value', params: [value] });
  assert.deepEqual(await db.prepare('SELECT ? AS value').all(2), [{ value: 1 }]);
  assert.deepEqual(await db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(null, 4), { changes: 1 });
  assert.deepEqual(calls[2], { text: 'UPDATE users SET avatar = $1 WHERE id = $2', params: [null, 4] });
  assert.equal(await fake({ rows: [], rowCount: 0 }).db.prepare('SELECT 1').get(), undefined);
});

test('placeholder translation skips quotes, comments and dollar-quoted bodies', async () => {
  const { db, calls } = fake();
  const sql = `SELECT '?', 'it''s ?', "odd?column", $$?$$, $body$?$body$, ?
-- ?
/* ? /* nested ? */ ? */ WHERE id = ?`;
  await db.prepare(sql).get('a', 3);
  assert.equal(calls[0].text, sql.replace(', ?\n', ', $1\n').replace('id = ?', 'id = $2'));
  assert.deepEqual(calls[0].params, ['a', 3]);
  const escaped = String.raw`SELECT E'it\'s ?', ?`;
  await db.prepare(escaped).get(1);
  assert.equal(calls[1].text, escaped.replace(', ?', ', $1'));
});

test('unsupported or malformed bindings reject before sending a query', async () => {
  const { db, calls } = fake();
  await assert.rejects(db.prepare('SELECT ?').get(), /Expected 1 SQL parameters/);
  await assert.rejects(db.prepare('SELECT 1').get('extra'), /Expected 0 SQL parameters/);
  await assert.rejects(db.prepare('SELECT @name').get({ name: 'x' }), /named bindings are not supported yet/);
  for (const sql of ["SELECT '? ", 'SELECT /* ?', 'SELECT $tag$?']) {
    await assert.rejects(db.prepare(sql).get(), /Unterminated SQL/);
  }
  await assert.rejects(db.prepare(null).get(), /SQL must be a string/);
  assert.equal(calls.length, 0);
});

test('ids and counts are safe numbers, including zero; null stays null', async () => {
  const { db } = fake({ rows: [{ id: '123', count: '0', missing: null }], rowCount: 1,
    fields: ['id', 'count', 'missing'].map(name => ({ name, dataTypeID: 20 })) });
  assert.deepEqual(await db.prepare('SELECT 1').get(), { id: 123, count: 0, missing: null });
  const huge = fake({ rows: [{ id: '9007199254740993' }], rowCount: 1, fields: [{ name: 'id', dataTypeID: 20 }] });
  await assert.rejects(huge.db.prepare('SELECT 1').get(), /safe integer range/);
});

test('query errors and multiple result sets are rejected', async () => {
  const failed = new PostgresDatabase({ pool: { async query() { throw new Error('offline'); } } });
  await assert.rejects(failed.prepare('SELECT 1').get(), /offline/);
  await assert.rejects(fake([]).db.prepare('SELECT 1; SELECT 2').all(), /single statement/);
});

test('close ends its connection once and later queries reject', async () => {
  const { db, ended } = fake();
  const closing = db.close();
  assert.equal(db.close(), closing);
  await closing;
  assert.equal(ended(), 1);
  await assert.rejects(db.prepare('SELECT 1').get(), /not open/);
});

test('transactions pin all awaited queries to one client and release it on commit or rollback', async () => {
  const clients = [];
  const db = new PostgresDatabase({ pool: {
    async query() { throw new Error('transaction escaped to the pool'); },
    async connect() {
      const calls = [], releases = [];
      const client = {
        calls, releases,
        async query(sql, params) { calls.push({ sql, params }); return { rows: [{ value: params?.[0] }], rowCount: 1 }; },
        release(err) { releases.push(err); },
      };
      clients.push(client);
      return client;
    },
  } });
  let escaped;
  assert.equal(await db.withTransaction(async tx => {
    escaped = tx;
    await Promise.resolve();
    await assert.rejects(tx.withTransaction(() => {}), /Nested/);
    return (await tx.prepare('SELECT ?').get('bound')).value;
  }), 'bound');
  assert.deepEqual(clients[0].calls.map(call => call.sql), ['BEGIN', 'SELECT $1', 'COMMIT']);
  assert.deepEqual(clients[0].releases, [undefined]);
  await assert.rejects(escaped.prepare('SELECT 1').get(), /not open/);
  const failure = new Error('application failure');
  await assert.rejects(db.withTransaction(async tx => {
    await tx.prepare('SELECT ?').get('undone');
    throw failure;
  }), err => err === failure);
  assert.deepEqual(clients[1].calls.map(call => call.sql), ['BEGIN', 'SELECT $1', 'ROLLBACK']);
  assert.deepEqual(clients[1].releases, [undefined]);
});

test('a failed rollback discards its client and preserves the original error', async () => {
  const failure = new Error('original query failure');
  const rollback = new Error('connection lost');
  let released;
  const db = new PostgresDatabase({ pool: {
    async connect() {
      return {
        async query(sql) { if (sql === 'ROLLBACK') throw rollback; return { rows: [] }; },
        release(err) { released = err; },
      };
    },
  } });
  await assert.rejects(db.withTransaction(async () => { throw failure; }), err => err === failure);
  assert.equal(released, rollback);
});
