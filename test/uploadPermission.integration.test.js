/**
 * Uploads follow the same permission rules as the rest of Haven: a role, the
 * level thresholds, or a permission set on the person, with a person's own
 * deny winning over a role.
 *
 *   node --test test/uploadPermission.integration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const PORT = 3397;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-upload-perm-${Date.now()}`);

let server;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function uploadAs(token) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  const r = await fetch(`${BASE}/api/upload-file`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return r.status;
}

function withDb(fn) {
  const db = new Database(path.join(DATA, 'haven.db'));
  try { return fn(db); } finally { db.close(); }
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
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

test('uploads honour level thresholds and permissions set on the person', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'uploadcheck1', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.body.token, 'admin registered');
  const bob = await post('/api/auth/register', { username: 'bob', password: 'uploadcheck2', eulaVersion: '2.0', ageVerified: true });
  assert.ok(bob.body.token, 'bob registered');
  const bobId = bob.body.user.id;

  // Take uploads off every role, so nothing a role gives covers bob.
  const memberRole = withDb((db) => {
    db.prepare("DELETE FROM role_permissions WHERE permission = 'upload_files'").run();
    return db.prepare("SELECT ur.role_id FROM user_roles ur WHERE ur.user_id = ? AND ur.channel_id IS NULL LIMIT 1").get(bobId);
  });
  assert.equal(await uploadAs(bob.body.token), 403, 'no permission anywhere: refused');

  // Level threshold: everyone at level 1 or above may upload.
  withDb((db) => db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('permission_thresholds', ?)").run(JSON.stringify({ upload_files: 1 })));
  assert.equal(await uploadAs(bob.body.token), 200, 'allowed by the level threshold');
  withDb((db) => db.prepare("DELETE FROM server_settings WHERE key = 'permission_thresholds'").run());
  assert.equal(await uploadAs(bob.body.token), 403, 'threshold removed: refused again');

  // Granted to bob on his own.
  assert.ok(memberRole, 'bob holds a server role to hang the grant on');
  withDb((db) => db.prepare('INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed) VALUES (?, ?, NULL, ?, 1)')
    .run(bobId, memberRole.role_id, 'upload_files'));
  assert.equal(await uploadAs(bob.body.token), 200, 'allowed by a permission set on him');

  // Denied to bob on his own, while his role allows it: the deny wins.
  withDb((db) => {
    db.prepare("UPDATE user_role_perms SET allowed = 0 WHERE user_id = ? AND permission = 'upload_files'").run(bobId);
    db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)').run(memberRole.role_id, 'upload_files');
  });
  assert.equal(await uploadAs(bob.body.token), 403, 'his own deny beats the role');

  // Without the deny, the role alone allows it, as before.
  withDb((db) => db.prepare("DELETE FROM user_role_perms WHERE user_id = ? AND permission = 'upload_files'").run(bobId));
  assert.equal(await uploadAs(bob.body.token), 200, 'the role allows it');

  assert.equal(await uploadAs(admin.body.token), 200, 'the admin always can');
});
