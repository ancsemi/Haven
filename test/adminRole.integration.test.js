/**
 * The Admin role (#5707) follows admin: a new server's first admin gets it,
 * a transfer hands it to the new admin, and a server converted by the first
 * version of the migration (which did not note the role's id) is picked up.
 *
 *   node --test test/adminRole.integration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');

const PORT = 3398;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), `haven-admin-role-${Date.now()}`);

let server;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}

function serverRoles(userId) {
  const db = new Database(path.join(DATA, 'haven.db'), { readonly: true });
  try {
    return db.prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.channel_id IS NULL ORDER BY r.name`).all(userId).map((r) => r.name);
  } finally { db.close(); }
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', FORCE_HTTP: 'true', HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});

test.after(() => {
  server?.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a new server\'s admin wears the Admin role, and a transfer passes it on', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'rolecheckpw1', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.body.token, 'admin registered');
  const bob = await post('/api/auth/register', { username: 'bob', password: 'rolecheckpw2', eulaVersion: '2.0', ageVerified: true });
  assert.ok(bob.body.token, 'bob registered');
  const adminId = admin.body.user.id;
  const bobId = bob.body.user.id;

  assert.ok(serverRoles(adminId).includes('Admin'), 'the first admin has the Admin role');
  assert.ok(!serverRoles(bobId).includes('Admin'));

  const s = await connect(admin.body.token);
  const res = await new Promise((r) => s.emit('transfer-admin', { userId: bobId, password: 'rolecheckpw1' }, r));
  assert.ok(res && res.success, `transfer failed: ${JSON.stringify(res)}`);
  s.close();

  assert.ok(serverRoles(bobId).includes('Admin'), 'the new admin has the Admin role');
  assert.deepEqual(serverRoles(adminId), ['Former Admin'], 'the old admin keeps Former Admin only');

  // Reset roles to default: the Admin role comes back, on the current admin,
  // and admin_role_id points at it rather than at a deleted role.
  const sb = await connect(bob.body.token);
  const reset = await new Promise((r) => sb.emit('reset-roles-to-default', {}, r));
  assert.ok(reset && !reset.error, `reset failed: ${JSON.stringify(reset)}`);
  sb.close();
  assert.ok(serverRoles(bobId).includes('Admin'), 'the admin wears the Admin role after a reset');
  const db = new Database(path.join(DATA, 'haven.db'), { readonly: true });
  try {
    const id = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get().value;
    assert.equal(db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name, 'Admin', 'admin_role_id points at the new Admin role');
  } finally { db.close(); }
});

test('a converted server whose admin deleted the Admin role does not get it back', () => {
  const dir = path.join(os.tmpdir(), `haven-admin-role-gone-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (code) => execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, HAVEN_DATA_DIR: dir }, encoding: 'utf8' });
  try {
    run(`
      const db = require('./src/database').initDatabase();
      db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('boss', 'x', 1)").run();
      const role = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get().value;
      db.prepare('DELETE FROM roles WHERE id = ?').run(role);
      db.prepare("DELETE FROM server_settings WHERE key = 'admin_role_id'").run();
      db.close();
    `);
    const out = run(`
      const db = require('./src/database').initDatabase();
      const id = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get().value;
      const count = db.prepare("SELECT COUNT(*) c FROM roles WHERE level = 99").get().c;
      process.stdout.write(JSON.stringify({ id, count }));
    `);
    const { id, count } = JSON.parse(out.slice(out.lastIndexOf('{"id"')));
    assert.equal(id, 'none', 'noted as having no Admin role');
    assert.equal(count, 0, 'no Admin role is made');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('a server converted by the first version of the migration gets its role id noted', () => {
  const dir = path.join(os.tmpdir(), `haven-admin-role-old-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (code) => execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, HAVEN_DATA_DIR: dir }, encoding: 'utf8' });
  try {
    // Build the state the first version left: an admin holding a level 99
    // "Admin" role, the converted flag set, and no admin_role_id.
    run(`
      const db = require('./src/database').initDatabase();
      db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('boss', 'x', 1)").run();
      const role = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get().value;
      db.prepare('DELETE FROM roles WHERE id = ?').run(role);
      const id = db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Admin', 99, 'server', '#e74c3c')").run().lastInsertRowid;
      db.prepare("INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (1, ?, NULL, 1)").run(id);
      db.prepare("DELETE FROM server_settings WHERE key = 'admin_role_id'").run();
      db.close();
    `);
    const out = run(`
      const db = require('./src/database').initDatabase();
      const id = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get().value;
      const role = db.prepare('SELECT name, level FROM roles WHERE id = ?').get(id);
      const count = db.prepare("SELECT COUNT(*) c FROM roles WHERE level = 99").get().c;
      process.stdout.write(JSON.stringify({ role, count }));
    `);
    const { role, count } = JSON.parse(out.slice(out.lastIndexOf('{"role"')));
    assert.deepEqual(role, { name: 'Admin', level: 99 }, 'the role the admin already wears is the one noted');
    assert.equal(count, 1, 'no second Admin role is made');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
