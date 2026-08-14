/**
 * Group DM key distribution — server rule tests.
 *
 * These cover what the crypto tests cannot: the structural rules only the
 * server can enforce, because no client can see the whole membership list or
 * another member's blobs.
 *
 * Needs a running Haven server. Boots one on a scratch port and data dir:
 *   node --test test/group-e2e-server.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-group-e2e-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const register = (username) =>
  post('/api/auth/register', { username, password: 'grouptest123', eulaVersion: '1.0', ageVerified: true });

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}

/** Wait for one of several events, whichever lands first. */
function next(sock, events, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { cleanup(); res({ event: null, data: null }); }, ms);
    const handlers = events.map((e) => {
      const h = (data) => { cleanup(); res({ event: e, data }); };
      sock.on(e, h); return [e, h];
    });
    function cleanup() { clearTimeout(t); handlers.forEach(([e, h]) => sock.off(e, h)); }
  });
}

// Any well-formed key blob will do; these tests are about the rules around the
// blobs, not the crypto, which test/e2e-group.test.js covers.
const fakeKey = (id) => JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: `wrapped-for-${id}` });
const jwk = (x) => ({ kty: 'EC', crv: 'P-256', x, y: `y${x}` });

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA },
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

test('group DM rules', async (t) => {
  const alice = await register('alice');
  const bob = await register('bob');
  const carol = await register('carol');
  const dave = await register('dave');
  assert.ok(alice.token && bob.token && carol.token && dave.token, 'all users registered');

  const A = await connect(alice.token);
  const B = await connect(bob.token);
  const C = await connect(carol.token);
  const D = await connect(dave.token);

  // Every member needs both keys published or the group cannot be formed.
  for (const [sock, tag] of [[A, 'a'], [B, 'b'], [C, 'c'], [D, 'd']]) {
    sock.emit('publish-public-key', { jwk: jwk(tag) });
    sock.emit('publish-signing-key', { jwk: jwk(`s${tag}`) });
  }
  await wait(600);

  await t.test('a signing key cannot be silently overwritten', async () => {
    const p = next(A, ['signing-key-conflict', 'signing-key-published']);
    A.emit('publish-signing-key', { jwk: jwk('attacker') });
    const { event } = await p;
    assert.strictEqual(event, 'signing-key-conflict', 'a changed signing key must raise a conflict, not replace silently');
  });

  let code;
  await t.test('a group DM can be created with three members', async () => {
    const opened = next(A, ['group-dm-opened', 'error-msg']);
    A.emit('start-group-dm', { userIds: [bob.user.id, carol.user.id], name: 'Test Group' });
    const { event, data } = await opened;
    assert.strictEqual(event, 'group-dm-opened', `expected group-dm-opened, got ${event}`);
    assert.strictEqual(data.members.length, 3);
    code = data.code;
  });

  await t.test('a two-person group is refused', async () => {
    const r = next(A, ['group-dm-opened', 'error-msg']);
    A.emit('start-group-dm', { userIds: [bob.user.id] });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('epoch 1 publishes when it covers every member', async () => {
    const ok = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 1, keys: [alice, bob, carol].map((u) => ({ recipientId: u.user.id, wrappedKey: fakeKey(u.user.id) })) });
    const { event, data } = await ok;
    assert.strictEqual(event, 'group-epoch-published', `expected publish, got ${event}`);
    assert.strictEqual(data.epoch, 1);
  });

  await t.test('an epoch that omits a member is REJECTED', async () => {
    // The attack this rule exists to stop: Carol is silently cut out while the
    // UI still lists her as a participant.
    const r = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 2, keys: [alice, bob].map((u) => ({ recipientId: u.user.id, wrappedKey: fakeKey(u.user.id) })) });
    const { event, data } = await r;
    assert.strictEqual(event, 'error-msg', `omitting a member must be rejected, got ${event}`);
    assert.match(String(data), /exactly one key per current member/i);
  });

  await t.test('an epoch naming a non-member is REJECTED', async () => {
    const r = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 2, keys: [alice, bob, carol, dave].map((u) => ({ recipientId: u.user.id, wrappedKey: fakeKey(u.user.id) })) });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('a non-member cannot publish an epoch', async () => {
    const r = next(D, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    D.emit('publish-group-epoch', { code, epoch: 2, keys: [alice, bob, carol].map((u) => ({ recipientId: u.user.id, wrappedKey: fakeKey(u.user.id) })) });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('epochs must be strictly sequential', async () => {
    const r = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 7, keys: [alice, bob, carol].map((u) => ({ recipientId: u.user.id, wrappedKey: fakeKey(u.user.id) })) });
    const { event, data } = await r;
    assert.strictEqual(event, 'group-epoch-conflict', 'a skipped epoch must conflict');
    assert.strictEqual(data.currentEpoch, 1);
  });

  await t.test('a member receives only their own wrapped key', async () => {
    const p = next(B, ['group-keys']);
    B.emit('get-group-keys', { code, sinceEpoch: 0 });
    const { data } = await p;
    assert.ok(data, 'bob got a key list');
    assert.strictEqual(data.keys.length, 1);
    assert.match(data.keys[0].wrappedKey, new RegExp(`wrapped-for-${bob.user.id}`));
    // The decisive check: nothing addressed to anyone else came back.
    const others = [alice.user.id, carol.user.id].map((id) => `wrapped-for-${id}`);
    for (const o of others) assert.ok(!JSON.stringify(data.keys).includes(o), `must not leak ${o}`);
  });

  await t.test('a non-member cannot read group keys at all', async () => {
    const r = next(D, ['group-keys', 'error-msg']);
    D.emit('get-group-keys', { code, sinceEpoch: 0 });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('a rewrap reaches only the intended recipient', async () => {
    const forCarol = next(C, ['group-key-rewrapped']);
    const forBob = next(B, ['group-key-rewrapped'], 1500);
    A.emit('rewrap-group-key', { code, epoch: 1, recipientId: carol.user.id, wrappedKey: fakeKey('carol-rewrapped') });
    assert.ok((await forCarol).data, 'carol was told');
    assert.strictEqual((await forBob).event, null, 'bob was not');
  });

  [A, B, C, D].forEach((s) => s.close());
});
