'use strict';

/**
 * Single sign-on settings belong to the admin alone. Whoever sets the
 * identity provider's address decides who can sign in as whom, so a role
 * that may manage the server cannot repoint it, switch it on, or let it
 * create accounts.
 *
 *   node --test test/ssoAdminOnly.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3499;
const h = createHarness(PORT, 'sso-admin-only');

test.before(() => h.start());
test.after(() => h.stop());

test('only the admin changes single sign-on settings', async (t) => {
  const admin = await h.register('admin');
  const manager = await h.register('manager');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const role = Number(db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Manager', 60, 'server', '#ccc')").run().lastInsertRowid);
  db.prepare("INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, 'manage_server', 1)").run(role);
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)').run(manager.id, role);
  const M = await h.connect(manager.token);
  const setting = (k) => db.prepare('SELECT value FROM server_settings WHERE key = ?').get(k)?.value;

  A.emit('update-server-setting', { key: 'oidc_issuer_url', value: 'https://id.example.com' });
  A.emit('update-server-setting', { key: 'oidc_client_id', value: 'haven' });
  await wait(300);
  assert.equal(setting('oidc_issuer_url'), 'https://id.example.com');
  assert.equal(setting('oidc_client_id'), 'haven');

  const attempts = {
    oidc_issuer_url: 'https://evil.example.net',
    oidc_client_id: 'other',
    oidc_enabled: '1',
    oidc_create_users: '1',
    oidc_scopes: 'openid email',
    oidc_button_label: 'Sign in here',
  };
  const before = Object.fromEntries(Object.keys(attempts).map(k => [k, setting(k)]));
  for (const [key, value] of Object.entries(attempts)) {
    const refused = h.next(M, 'error-msg');
    M.emit('update-server-setting', { key, value });
    assert.match(String(await refused), /admin/, key);
    assert.equal(setting(key), before[key], key + ' is unchanged');
  }

  // The manager's other settings still save.
  M.emit('update-server-setting', { key: 'login_message', value: 'Hello' });
  await wait(300);
  assert.equal(setting('login_message'), 'Hello');
});
