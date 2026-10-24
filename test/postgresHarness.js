'use strict';

// An isolated PostgreSQL fixture for converted app flows. It copies only
// test rows from SQLite into a new, randomly named schema, then drops that
// schema on cleanup. No production schema or data migration is performed.
// HAVEN_TEST_POSTGRES_URL must point at a disposable test database.

const crypto = require('node:crypto');
const { PostgresDatabase } = require('../src/db/postgres');

const quote = name => '"' + String(name).replace(/"/g, '""') + '"';

async function createPostgresFixture(sqlite, tables) {
  const { Client } = require('../src/db/pgAddon').loadPg();
  const client = new Client({ connectionString: process.env.HAVEN_TEST_POSTGRES_URL, connectionTimeoutMillis: 5000 });
  const schema = 'haven_test_' + crypto.randomBytes(8).toString('hex');
  const db = new PostgresDatabase({ pool: client });
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    created = true;
    await client.query(`SET search_path TO ${quote(schema)}`);
    for (const table of tables) {
      const columns = sqlite.pragma(`table_info(${quote(table)})`);
      const definitions = columns.map(c => quote(c.name) + (/INT/i.test(c.type) ? ' BIGINT' : ' TEXT'));
      await db.prepare(`CREATE TABLE ${quote(table)} (${definitions.join(', ')})`).run();
      const names = columns.map(c => quote(c.name)).join(', ');
      const values = columns.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO ${quote(table)} (${names}) VALUES (${values})`);
      for (const row of sqlite.prepare(`SELECT * FROM ${quote(table)}`).all()) {
        await insert.run(...columns.map(c => row[c.name]));
      }
    }
    return {
      db,
      async close() {
        try { await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`); }
        finally { await db.close(); }
      },
    };
  } catch (err) {
    if (created) await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`).catch(() => {});
    await db.close();
    throw err;
  }
}

module.exports = { createPostgresFixture };
