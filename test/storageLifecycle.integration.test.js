'use strict';

// Files leaving storage over their life, on a running server. A profile
// picture someone replaces or removes leaves uploads/ (into
// deleted-attachments, recoverable for the retention window) instead of
// sitting there forever, but only their own upload, and only when nothing
// else still shows it. The admin can rebuild the media index.
//
//   node --test test/storageLifecycle.integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 3633;
const BASE = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-profile-release-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server;

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex');
const json = async (method, p, token, body) => (await fetch(BASE + p, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})).json();
const upload = async (route, field, token, extra = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append(field, new Blob([PNG], { type: 'image/png' }), 'pic.png');
  const j = await (await fetch(BASE + route, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  assert.ok(j.url, JSON.stringify(j));
  return j.url;
};
const rel = (url) => url.replace('/uploads/', '');
const live = (url) => fs.existsSync(path.join(DATA, 'uploads', rel(url)));
const held = (url) => fs.existsSync(path.join(DATA, 'uploads', 'deleted-attachments', rel(url)));
// Tokens by username, so a later test can act as someone an earlier one made.
const tokens = {};
const register = async (username) => {
  const r = await json('POST', '/api/auth/register', null, { username, password: 'releasetest123', eulaVersion: '2.0', ageVerified: true });
  if (r.token) tokens[username] = r.token;
  return r;
};

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
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
test.after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('a replaced or removed avatar or border leaves uploads', async () => {
  const { token } = await register('admin');
  const first = await upload('/api/upload-avatar', 'avatar', token);
  const second = await upload('/api/upload-avatar', 'avatar', token);
  assert.ok(!live(first) && held(first), 'the replaced avatar waits in deleted-attachments');
  assert.ok(live(second));
  await json('POST', '/api/remove-avatar', token);
  assert.ok(!live(second) && held(second), 'the removed avatar too');

  const border = await upload('/api/upload-border', 'border', token);
  await json('POST', '/api/remove-border', token);
  assert.ok(!live(border) && held(border), 'and a removed border');
});

test('a picture still shown somewhere else stays', async () => {
  const { token } = await register('bob');
  const pic = await upload('/api/upload-avatar', 'avatar', token);
  assert.ok((await json('POST', '/api/personas', token, { name: 'Bobby', avatar: pic })).persona);
  await json('POST', '/api/remove-avatar', token);
  assert.ok(live(pic), 'his persona still shows it');
});

test("someone else's picture set as a persona avatar is never taken", async () => {
  const { token: carol } = await register('carol');
  const { token: dave } = await register('dave');
  const carolsPic = await upload('/api/upload-avatar', 'avatar', carol);
  const persona = (await json('POST', '/api/personas', dave, { name: 'Mask', avatar: carolsPic })).persona;
  assert.ok(persona, 'persona made');
  await json('POST', '/api/remove-avatar', carol);   // Carol's own avatar now only shows on Dave's persona
  assert.ok(live(carolsPic), "still shown on Dave's persona");
  await fetch(`${BASE}/api/personas/${persona.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${dave}` } });
  assert.ok(live(carolsPic), "deleting Dave's persona does not take Carol's file");

  const davesOwn = await upload('/api/upload-persona-avatar', 'avatar', dave);
  const p2 = (await json('POST', '/api/personas', dave, { name: 'Mask2', avatar: carolsPic })).persona;
  const next = await upload('/api/upload-persona-avatar', 'avatar', dave, { personaId: String(p2.id) });
  assert.ok(live(next));
  assert.ok(live(carolsPic), "replacing it on Dave's persona does not take it either");
  assert.ok(live(davesOwn), 'an upload not on any persona is left alone here');
  await fetch(`${BASE}/api/personas/${p2.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${dave}` } });
  assert.ok(!live(next) && held(next), "Dave's own persona avatar goes with the persona");
});

test('the admin can rebuild the media index; nobody else can', async () => {
  const account = async (username) => tokens[username] || (await register(username)).token;
  const admin = { token: await account('admin') };
  const bob = { token: await account('bob') };
  assert.ok(admin.token && bob.token);
  assert.equal((await fetch(`${BASE}/api/admin/media/reconcile`, { method: 'POST', headers: { Authorization: `Bearer ${bob.token}` } })).status, 403);
  fs.writeFileSync(path.join(DATA, 'uploads', 'dropped-in.png'), PNG);
  const first = await json('POST', '/api/admin/media/reconcile', admin.token);
  assert.equal(first.added, 1, 'a file put there by hand is indexed');
  const again = await json('POST', '/api/admin/media/reconcile', admin.token);
  assert.deepEqual([again.added, again.fixed, again.dropped], [0, 0, 0], 'and a clean index is left as it is');
});