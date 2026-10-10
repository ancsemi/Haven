'use strict';

// Defaults that changed after servers were already running move only on
// servers whose admin never touched them.
//
//   node --test test/settingDefaults.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { applyDefaultUpdates, UPDATES } = require('../src/settingDefaults');

const ESC = UPDATES.find(u => u.key === 'automod_escalation');

function db(value, audited) {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT, target_name TEXT)`);
  if (value !== undefined) d.prepare('INSERT INTO server_settings VALUES (?, ?)').run('automod_escalation', value);
  if (audited) d.prepare("INSERT INTO audit_log (action, target_name) VALUES ('server_setting_update', 'automod_escalation')").run();
  return d;
}
const value = (d) => d.prepare("SELECT value FROM server_settings WHERE key = 'automod_escalation'").get()?.value;

test('an untouched old default moves to the new one, once', () => {
  const d = db(ESC.from, false);
  applyDefaultUpdates(d);
  assert.equal(value(d), ESC.to);
  assert.equal(JSON.parse(value(d)).banAt, 0, 'Auto-Mod no longer bans on its own');
  // An admin who later sets the old value back keeps it.
  d.prepare("UPDATE server_settings SET value = ? WHERE key = 'automod_escalation'").run(ESC.from);
  applyDefaultUpdates(d);
  assert.equal(value(d), ESC.from);
});

test('a value the admin saved is never changed', () => {
  const custom = '{"windowHours":12,"warnAt":1,"muteAt":2,"muteMinutes":30,"banAt":4}';
  const d1 = db(custom, false);
  applyDefaultUpdates(d1);
  assert.equal(value(d1), custom);
  // Saved the same value as the old default on purpose: the audit log shows it.
  const d2 = db(ESC.from, true);
  applyDefaultUpdates(d2);
  assert.equal(value(d2), ESC.from);
});

test('a new install gets the new default from the database seed', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'database.js'), 'utf8');
  assert.ok(src.includes(`insertSetting.run('automod_escalation', '${ESC.to}')`));
});
