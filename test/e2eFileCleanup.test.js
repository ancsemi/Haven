/**
 * Files sent in end-to-end encrypted DMs are cleaned up with their messages (#5699).
 *
 * The server cannot read an encrypted message to find the file it points at,
 * so the sender names the file alongside it. Only the sender's own uploads
 * are accepted there, and deleting the DM notes those files for the sweep
 * that moves them to deleted-attachments.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/e2eFileCleanup.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');

const PORT = 3402;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-e2e-files-${Date.now()}`);
let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'e2e-files-test-123', eulaVersion: '2.0', ageVerified: true });
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 5000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
async function upload(token) {
  const fd = new FormData();
  fd.append('scope', 'dm');
  fd.append('file', new Blob([Buffer.from('not really encrypted, just bytes')], { type: 'application/octet-stream' }), 'e2e-file.enc');
  const r = await fetch(`${BASE}/api/upload-file`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return r.json();
}
const readDb = (sql, ...args) => {
  const db = new Database(path.join(DATA, 'haven.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'nobody-admin', FORCE_HTTP: 'true' },
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
test.after(() => { server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

test('an encrypted DM file is noted for cleanup when the DM is deleted', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  assert.ok(alice.token && bob.token, 'both registered');
  const A = await connect(alice.token);
  const B = await connect(bob.token);

  const opened = next(A, 'dm-opened');
  A.emit('start-dm', { targetUserId: bob.user.id });
  const dm = await opened;
  assert.ok(dm && dm.code, 'DM opened');

  const mine = await upload(alice.token);
  const theirs = await upload(bob.token);
  assert.ok(mine.url && theirs.url, `uploads: ${JSON.stringify(mine)} ${JSON.stringify(theirs)}`);
  const myRel = mine.url.replace('/uploads/', '');

  const arrived = next(A, 'new-message', (d) => d.channelCode === dm.code);
  A.emit('send-message', {
    code: dm.code,
    content: JSON.stringify({ v: 1, ct: 'ciphertext-stand-in', iv: 'x' }),
    encrypted: true,
    // Someone else's file and a path escape are ignored; only her own counts.
    files: [mine.url, theirs.url, '/uploads/../haven.db'],
  });
  const msg = await arrived;
  assert.ok(msg, 'the encrypted message went through');

  const stored = readDb('SELECT e2e_files FROM messages WHERE id = ?', msg.message.id)[0];
  assert.deepStrictEqual(JSON.parse(stored.e2e_files), [myRel], 'only the sender\'s own upload is recorded');

  A.emit('delete-dm', { code: dm.code });
  let released = [];
  for (let i = 0; i < 20 && !released.length; i++) {
    await wait(200);
    released = readDb('SELECT rel_path FROM released_uploads').map(r => r.rel_path);
  }
  assert.deepStrictEqual(released, [myRel], 'deleting the DM notes its file for cleanup');

  A.disconnect(); B.disconnect();
});
