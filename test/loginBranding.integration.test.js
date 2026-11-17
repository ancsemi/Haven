'use strict';

/**
 * The login page's look (#5819): Settings > Branding can show the server
 * icon and banner on the login page, add a message, and (the admin alone)
 * custom CSS. The page reads them from /api/public-config.
 *
 *   node --test test/loginBranding.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3479;
const h = createHarness(PORT, 'login-branding');

test.before(() => h.start());
test.after(() => h.stop());

test('the login page branding settings', async (t) => {
  const admin = await h.register('admin');
  const manager = await h.register('manager');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  // Someone who may manage the server, but is not the admin.
  const role = Number(db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Manager', 60, 'server', '#ccc')").run().lastInsertRowid);
  db.prepare("INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, 'manage_server', 1)").run(role);
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)').run(manager.id, role);
  const M = await h.connect(manager.token);

  const setting = (k) => db.prepare('SELECT value FROM server_settings WHERE key = ?').get(k)?.value;
  const config = async () => (await fetch(`http://localhost:${PORT}/api/public-config`)).json();

  db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_icon', '/uploads/icon.png'), ('server_banner', '/uploads/banner.png')").run();
  let c = await config();
  assert.equal(c.login_logo, '', 'the icon is not on the login page until switched on');
  assert.equal(c.login_background, '');

  A.emit('update-server-setting', { key: 'login_show_icon', value: 'true' });
  A.emit('update-server-setting', { key: 'login_show_banner', value: 'true' });
  M.emit('update-server-setting', { key: 'login_message', value: 'Ask Sam for an invite.' });
  A.emit('update-server-setting', { key: 'login_css', value: '.auth-card { outline: 2px solid red; }' });
  await wait(400);
  c = await config();
  assert.equal(c.login_logo, '/uploads/icon.png');
  assert.equal(c.login_background, '/uploads/banner.png');
  assert.equal(c.login_message, 'Ask Sam for an invite.', 'a server manager can set the message');
  assert.equal(c.login_css, '.auth-card { outline: 2px solid red; }');

  const refused = h.next(M, 'error-msg');
  M.emit('update-server-setting', { key: 'login_css', value: 'body { display: none; }' });
  assert.match(String(await refused), /admin/, 'only the admin sets the CSS');
  assert.equal(setting('login_css'), '.auth-card { outline: 2px solid red; }');

  const tooLong = h.next(A, 'error-msg');
  A.emit('update-server-setting', { key: 'login_css', value: 'a{}'.repeat(7000) });
  assert.match(String(await tooLong), /20,000/);

  A.emit('update-server-setting', { key: 'login_show_icon', value: 'maybe' });
  await wait(200);
  assert.equal(setting('login_show_icon'), 'true', 'only true or false');
});
