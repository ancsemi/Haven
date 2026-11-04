'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 3;

async function initializePostgres(db) {
  await db.withTransaction(async tx => {
    // Migrations on one schema run once, even with two server starts at once.
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':haven_schema'))").get();
    await tx.exec(`CREATE TABLE IF NOT EXISTS haven_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const versions = await tx.prepare('SELECT version FROM haven_schema_migrations ORDER BY version').all();
    const current = versions.length ? versions[versions.length - 1].version : 0;
    if (current > VERSION) throw new Error('The PostgreSQL schema is newer than this Haven version');
    if (current === VERSION) return;
    if (current === 0) {
      const existing = await tx.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'users'").get();
      if (existing) throw new Error('The PostgreSQL schema has Haven tables without a migration version; use an empty test database/schema');

      await tx.exec(fs.readFileSync(path.join(__dirname, '001-schema.sql'), 'utf8'));
      const seed = require('./001-seed.json');
      // Roles precede their permissions and badges; ids are pinned only for the
      // initial stock rows. Identity sequences advance past them below.
      for (const table of ['roles', 'role_permissions', 'automod_domains', 'badges', 'server_settings']) {
        for (const row of seed[table]) {
          const columns = Object.keys(row);
          const names = columns.map(name => '"' + name + '"').join(', ');
          const marks = columns.map(() => '?').join(', ');
          await tx.prepare(`INSERT INTO "${table}" (${names}) VALUES (${marks})`).run(...Object.values(row));
        }
      }
      for (const table of ['roles', 'badges']) {
        await tx.prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM "${table}"))`).get();
      }
      const setting = tx.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?)');
      await setting.run('server_fingerprint', crypto.randomUUID());
      await setting.run('server_code', '');
      await setting.run('registration_token', '');
      // A fresh preview has one room to exercise the browser without manually
      // inserting fixtures. It belongs to the server until an admin signs up.
      const general = await tx.prepare("INSERT INTO channels (name, code) VALUES ('General', ?) RETURNING id").get(crypto.randomBytes(4).toString('hex'));
      await tx.prepare("UPDATE server_settings SET value = ? WHERE key = 'default_join_channels'").run(JSON.stringify([general.id]));
      await tx.prepare('INSERT INTO haven_schema_migrations (version) VALUES (?)').run(1);
    }
    if (current < 2) {
      // Upstream's channel-type link is part of every room-list row. Upgrade
      // existing preview databases too, without reseeding their data.
      await tx.exec('ALTER TABLE channels ADD COLUMN type_id BIGINT DEFAULT NULL');
      await tx.prepare('INSERT INTO haven_schema_migrations (version) VALUES (?)').run(2);
    }
    await tx.exec(fs.readFileSync(path.join(__dirname, '003-signing-key-order.sql'), 'utf8'));
    await tx.prepare('INSERT INTO haven_schema_migrations (version) VALUES (?)').run(VERSION);
  });
}

module.exports = { initializePostgres, VERSION };
