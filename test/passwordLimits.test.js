/**
 * Wrong passwords are limited per account, but a stranger guessing cannot lock
 * the owner out from an address they have used before. The password check for
 * E2E backups only answers for the signed-in account.
 *
 *   node --test test/passwordLimits.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const PORT = 3423;
const DATA = path.join(os.tmpdir(), `haven-pw-limits-${Date.now()}`);
let server;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// TRUST_PROXY lets the test speak for many addresses through X-Forwarded-For.
const post = (p, body, { ip, token } = {}) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
  if (ip) headers['X-Forwarded-For'] = ip;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST', headers },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch { j = { raw: b }; } res({ status: x.statusCode, body: j }); }); });
  r.on('error', rej); r.write(d); r.end();
});

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true', TRUST_PROXY: 'loopback' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`http://localhost:${PORT}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
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

test('guessing from many addresses closes the account to strangers, not to its owner', async () => {
  const PW = 'limitstest123';
  const reg = await post('/api/auth/register', { username: 'owner', password: PW, eulaVersion: '2.0', ageVerified: true }, { ip: '198.51.100.1' });
  assert.ok(reg.body.token, JSON.stringify(reg.body));
  // The owner has used this address before (the socket layer records it).
  const db = new Database(path.join(DATA, 'haven.db'));
  try { db.prepare('INSERT OR REPLACE INTO user_ips (user_id, ip) VALUES (?, ?)').run(reg.body.user.id, '198.51.100.1'); } finally { db.close(); }

  const login = (password, ip) => post('/api/auth/login', { username: 'owner', password, eulaVersion: '2.0', ageVerified: true }, { ip });
  for (let i = 0; i < 20; i++) {
    const r = await login('wrong-guess', `203.0.113.${i + 1}`);
    assert.strictEqual(r.status, 401, `guess ${i} is just wrong`);
  }
  const stranger = await login(PW, '203.0.113.200');
  assert.strictEqual(stranger.status, 429, 'a new address is refused even with the right password');
  const owner = await login(PW, '198.51.100.1');
  assert.strictEqual(owner.status, 200, 'the owner still gets in: ' + JSON.stringify(owner.body));

  // verify-password answers only for the signed-in account.
  const anon = await post('/api/auth/verify-password', { username: 'owner', password: PW }, { ip: '198.51.100.1' });
  assert.strictEqual(anon.status, 401, 'no session, no answer');
  const own = await post('/api/auth/verify-password', { password: PW }, { ip: '198.51.100.1', token: owner.body.token });
  assert.strictEqual(own.body.valid, true);

  // admin-recover gives a wrong name the same answer as a wrong password.
  const notAdmin = await post('/api/auth/admin-recover', { username: 'owner', password: PW }, { ip: '198.51.100.7' });
  assert.strictEqual(notAdmin.status, 401);
});

test('admin recovery holds the admin password to the same per-account limit', async () => {
  const PW = 'recoverlimits123';
  const reg = await post('/api/auth/register', { username: 'admin', password: PW, eulaVersion: '2.0', ageVerified: true }, { ip: '198.51.100.20' });
  assert.ok(reg.body.token, JSON.stringify(reg.body));
  const recover = (password, ip) => post('/api/auth/admin-recover', { username: 'admin', password }, { ip });
  for (let i = 0; i < 20; i++) {
    const r = await recover('wrong-guess', `192.0.2.${i + 1}`);
    assert.strictEqual(r.status, 401, `guess ${i} is just wrong`);
  }
  const stranger = await recover(PW, '192.0.2.200');
  assert.strictEqual(stranger.status, 429, 'a new address is refused even with the right password');
});
