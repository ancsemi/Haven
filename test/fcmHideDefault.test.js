'use strict';

// Message text stays out of pushes to phone apps that cannot take the
// encrypted kind, unless the admin allows it. A new server starts that way;
// a server from before 4.30, seeded with the text shown, is switched once
// and the admin's later choice is kept.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-fcm-hide-'));
test.after(() => fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Each start of the server is its own process, like a real restart.
// `before` runs against the database before it starts (when there is one).
function start(before = '') {
  const script = `
    const Database = require('better-sqlite3');
    const path = require('node:path');
    const file = path.join(process.env.HAVEN_DATA_DIR, 'haven.db');
    if (${JSON.stringify(before)}) { const pre = new Database(file); pre.exec(${JSON.stringify(before)}); pre.close(); }
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'database'))}).initDatabase();
    const get = (k) => db.prepare('SELECT value FROM server_settings WHERE key = ?').get(k)?.value ?? null;
    process.stdout.write('RESULT ' + JSON.stringify({ hide: get('fcm_hide_content'), applied: get('fcm_hide_default_applied') }));
    db.close();
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, HAVEN_DATA_DIR: DATA },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out.slice(out.lastIndexOf('RESULT ') + 7));
}

test('message text is hidden from older apps by default, switched once on older servers', () => {
  assert.deepEqual(start(), { hide: 'true', applied: 'true' }, 'a new server');

  // A server from before 4.30: text shown, and no marker yet.
  const old = "UPDATE server_settings SET value = 'false' WHERE key = 'fcm_hide_content'; DELETE FROM server_settings WHERE key = 'fcm_hide_default_applied';";
  assert.deepEqual(start(old), { hide: 'true', applied: 'true' }, 'switched on the first start');

  // The admin turns it off afterwards: the next start leaves it off.
  const choice = "UPDATE server_settings SET value = 'false' WHERE key = 'fcm_hide_content';";
  assert.deepEqual(start(choice), { hide: 'false', applied: 'true' }, 'the admin\'s choice is kept');
});

test('the settings screen and the marker match the default', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('public/js/modules/app-moderation.js'), /bool\('fcm-hide-content', 'fcm_hide_content', 'true'\);/);
  const { NEVER_SENT_SETTINGS } = require('../src/socketHandlers/settingEffects');
  assert.ok(NEVER_SENT_SETTINGS.has('fcm_hide_default_applied'), 'the marker is not sent to clients');
  const seed = JSON.parse(read('src/db/postgres/001-seed.json'));
  const flat = JSON.stringify(seed);
  assert.ok(flat.includes('"key":"fcm_hide_content","value":"true"'));
  assert.ok(flat.includes('"key":"fcm_hide_default_applied","value":"true"'));
});
