/**
 * Group DM key distribution: server rule tests.
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
// Wrapped keys plus the publisher's signed statement naming the same members.
const epochFor = (users) => ({
  keys: users.map((u) => ({ recipientId: u.user.id, wrappedKey: fakeKey(u.user.id) })),
  sig: 'c2lnbmVk',
  roster: users.map((u) => ({ id: u.user.id, ecdhJwk: jwk(`e${u.user.id}`), signJwk: jwk(`s${u.user.id}`) })),
});

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    // Plain HTTP on purpose: without FORCE_HTTP a certless Haven now makes its own certificate.
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, FORCE_HTTP: 'true', ADMIN_USERNAME: 'admin' },
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

  await t.test('a signing key and its backup are stored in one step, and replies name their request', async () => {
    const erin = await register('erin');
    const E = await connect(erin.token);
    const ok = next(E, ['signing-key-conflict', 'signing-key-published']);
    E.emit('publish-signing-key', { jwk: jwk('e1'), backup: 'backup-1', rid: 'r1' });
    const first = await ok;
    assert.strictEqual(first.event, 'signing-key-published');
    assert.strictEqual(first.data.rid, 'r1');
    const lost = next(E, ['signing-key-conflict', 'signing-key-published']);
    E.emit('publish-signing-key', { jwk: jwk('e2'), backup: 'backup-2', rid: 'r2' });
    const second = await lost;
    assert.strictEqual(second.event, 'signing-key-conflict');
    assert.strictEqual(second.data.rid, 'r2');
    const got = next(E, ['encrypted-key-result']);
    E.emit('get-encrypted-key');
    const { data } = await got;
    assert.strictEqual(data.signingBackup, 'backup-1', 'a losing publish must not replace the backup');
    assert.strictEqual(data.signingKey.x, 'e1');
    E.close();
  });

  await t.test('a replaced signing key stays on record for the messages it signed', async () => {
    const frank = await register('frank');
    const F = await connect(frank.token);
    F.emit('publish-signing-key', { jwk: jwk('f1') });
    await next(F, ['signing-key-published']);
    F.emit('publish-signing-key', { jwk: jwk('f2'), force: true });
    await next(F, ['signing-key-published']);
    const r = next(A, ['signing-key-result']);
    A.emit('get-signing-key', { userId: frank.user.id });
    const { data } = await r;
    assert.strictEqual(data.jwk.x, 'f2', 'the current key is the newest');
    assert.deepStrictEqual(data.keys.map((k) => k.x), ['f2', 'f1'], 'every key ever published, newest first');
    F.close();
  });

  let code;
  await t.test('a group DM invites rather than silently joining people', async () => {
    const opened = next(A, ['group-dm-opened', 'error-msg']);
    const bobInvite = next(B, ['group-dm-invite', 'group-dm-opened']);
    const carolInvite = next(C, ['group-dm-invite', 'group-dm-opened']);
    A.emit('start-group-dm', { userIds: [bob.user.id, carol.user.id], name: 'Test Group' });
    const { event, data } = await opened;
    assert.strictEqual(event, 'group-dm-opened', `expected group-dm-opened, got ${event}`);
    assert.strictEqual(data.members.length, 1, 'only the creator is a member until others accept');
    assert.strictEqual(data.pending.length, 2);
    code = data.code;
    assert.strictEqual((await bobInvite).event, 'group-dm-invite');
    assert.strictEqual((await carolInvite).event, 'group-dm-invite');
  });

  await t.test('the same membership reuses the existing group', async () => {
    const opened = next(A, ['group-dm-opened', 'error-msg']);
    A.emit('start-group-dm', { userIds: [carol.user.id, bob.user.id], name: 'Another name' });
    const { event, data } = await opened;
    assert.strictEqual(event, 'group-dm-opened');
    assert.strictEqual(data.code, code);
  });

  await t.test('invitees join only after they accept', async () => {
    const bobOpened = next(B, ['group-dm-opened', 'error-msg']);
    B.emit('accept-group-dm', { code });
    assert.strictEqual((await bobOpened).event, 'group-dm-opened');
    const carolOpened = next(C, ['group-dm-opened', 'error-msg']);
    C.emit('accept-group-dm', { code });
    const { data } = await carolOpened;
    assert.strictEqual(data.members.length, 3);
  });

  await t.test('a two-person group is refused', async () => {
    const r = next(A, ['group-dm-opened', 'error-msg']);
    A.emit('start-group-dm', { userIds: [bob.user.id] });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('an epoch without a signed statement for the same members is REJECTED', async () => {
    const unsigned = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    const { keys } = epochFor([alice, bob, carol]);
    A.emit('publish-group-epoch', { code, epoch: 1, keys });
    assert.strictEqual((await unsigned).event, 'error-msg');
    const short = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 1, ...epochFor([alice, bob, carol]), roster: epochFor([alice, bob]).roster });
    assert.strictEqual((await short).event, 'error-msg', 'the statement must name exactly the members the key goes to');
  });

  await t.test('epoch 1 publishes when it covers every member', async () => {
    const ok = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 1, ...epochFor([alice, bob, carol]) });
    const { event, data } = await ok;
    assert.strictEqual(event, 'group-epoch-published', `expected publish, got ${event}`);
    assert.strictEqual(data.epoch, 1);
  });

  await t.test('an epoch that omits a member is REJECTED', async () => {
    // The attack this rule exists to stop: Carol is silently cut out while the
    // UI still lists her as a participant.
    const r = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 2, ...epochFor([alice, bob]) });
    const { event, data } = await r;
    assert.strictEqual(event, 'error-msg', `omitting a member must be rejected, got ${event}`);
    assert.match(String(data), /exactly one key per current member/i);
  });

  await t.test('an epoch naming a non-member is REJECTED', async () => {
    const r = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 2, ...epochFor([alice, bob, carol, dave]) });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('a non-member cannot publish an epoch', async () => {
    const r = next(D, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    D.emit('publish-group-epoch', { code, epoch: 2, ...epochFor([alice, bob, carol]) });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('epochs must be strictly sequential', async () => {
    const r = next(A, ['group-epoch-published', 'error-msg', 'group-epoch-conflict']);
    A.emit('publish-group-epoch', { code, epoch: 7, ...epochFor([alice, bob, carol]) });
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
    assert.strictEqual(data.keys[0].publishedBy, alice.user.id, 'the statement comes with the key');
    assert.strictEqual(data.keys[0].sig, 'c2lnbmVk');
    assert.deepStrictEqual(data.keys[0].roster.map((m) => m.id).sort(), [alice, bob, carol].map((u) => u.user.id).sort());
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

  await t.test('a rewrap without a request from that member is REJECTED', async () => {
    const r = next(A, ['group-key-rewrapped', 'error-msg', 'public-key-conflict']);
    A.emit('rewrap-group-key', {
      code, epoch: 1, recipientId: carol.user.id, wrappedKey: fakeKey('nope'),
      recipientPublicKey: JSON.stringify(jwk('c')),
    });
    const { event } = await r;
    assert.strictEqual(event, 'error-msg');
  });

  await t.test('a rewrap reaches only the intended recipient after they ask', async () => {
    C.emit('request-group-rewrap', { code });
    await wait(200);
    const forCarol = next(C, ['group-key-rewrapped']);
    const forBob = next(B, ['group-key-rewrapped'], 1500);
    A.emit('rewrap-group-key', {
      code, epoch: 1, recipientId: carol.user.id, wrappedKey: fakeKey('carol-rewrapped'),
      recipientPublicKey: JSON.stringify(jwk('c')),
    });
    assert.ok((await forCarol).data, 'carol was told');
    assert.strictEqual((await forBob).event, null, 'bob was not');
  });

  await t.test('the roster lists members with both keys and the current epoch', async () => {
    const r = next(B, ['group-roster', 'error-msg']);
    B.emit('get-group-roster', { code });
    const { event, data } = await r;
    assert.strictEqual(event, 'group-roster');
    assert.strictEqual(data.epoch, 1);
    assert.deepStrictEqual(data.members.map((m) => m.id).sort(), [alice, bob, carol].map((u) => u.user.id).sort());
    assert.ok(data.members.every((m) => m.publicKey && m.signingKey));
    assert.deepStrictEqual(data.pending, []);
    const k = next(B, ['group-keys']);
    B.emit('get-group-keys', { code, sinceEpoch: 0 });
    assert.strictEqual((await k).data.needsRotation, false);
  });
  await t.test('a group refuses plaintext and pairwise envelopes', async () => {
    for (const content of ['hello in the clear', JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'x' })]) {
      const r = next(A, ['error-msg'], 1500);
      const leak = next(B, ['new-message'], 1500);
      A.emit('send-message', { code, content });
      assert.match(String((await r).data), /end-to-end encrypted/);
      assert.strictEqual((await leak).event, null, 'nothing reached the other members');
    }
  });
  await t.test('a signed group envelope is delivered', async () => {
    const env = JSON.stringify({ v: 3, e: 1, prev: null, iv: 'AAAAAAAAAAAAAAAA', ct: 'Y2lwaGVy', sig: 'c2ln' });
    const got = next(C, ['new-message']);
    A.emit('send-message', { code, content: env });
    const { data } = await got;
    assert.strictEqual(data?.message?.content, env);
    const bad = next(A, ['error-msg'], 1500);
    A.emit('edit-message', { messageId: data.message.id, content: 'edited in the clear', channelCode: code });
    assert.match(String((await bad).data), /end-to-end encrypted/);
  });
  await t.test('only members can invite, and invitees see it on reconnect', async () => {
    const denied = next(D, ['error-msg']);
    D.emit('invite-group-dm', { code, userIds: [dave.user.id] });
    assert.strictEqual((await denied).event, 'error-msg');
    const invite = next(D, ['group-dm-invite']);
    const updated = next(B, ['group-dm-updated']);
    A.emit('invite-group-dm', { code, userIds: [dave.user.id] });
    assert.strictEqual((await invite).data.code, code);
    assert.strictEqual((await updated).event, 'group-dm-updated');
    const list = next(D, ['group-dm-invites']);
    D.emit('get-group-invites');
    assert.deepStrictEqual((await list).data.invites.map((i) => i.code), [code]);
    const roster = next(A, ['group-roster']);
    A.emit('get-group-roster', { code });
    assert.deepStrictEqual((await roster).data.pending.map((m) => m.id), [dave.user.id]);
  });
  await t.test('a new member flags the group for rotation', async () => {
    const opened = next(D, ['group-dm-opened', 'error-msg']);
    D.emit('accept-group-dm', { code });
    assert.strictEqual((await opened).event, 'group-dm-opened');
    const k = next(A, ['group-keys']);
    A.emit('get-group-keys', { code, sinceEpoch: 0 });
    assert.strictEqual((await k).data.needsRotation, true);
  });
  await t.test('leaving removes access and tells the rest', async () => {
    const left = next(C, ['group-dm-left']);
    const gone = next(C, ['channel-deleted']);
    const told = next(A, ['group-dm-member-left']);
    C.emit('leave-group-dm', { code });
    assert.strictEqual((await left).data.code, code);
    assert.strictEqual((await gone).data.code, code);
    assert.strictEqual((await told).data.code, code);
    const r = next(C, ['group-roster', 'group-keys', 'error-msg']);
    C.emit('get-group-keys', { code, sinceEpoch: 0 });
    assert.strictEqual((await r).event, 'error-msg');
  });
  await t.test('deleting a group from the DM list leaves it instead of deleting it for everyone', async () => {
    const left = next(D, ['group-dm-left']);
    D.emit('delete-dm', { code });
    assert.strictEqual((await left).data.code, code);
    const r = next(A, ['group-roster']);
    A.emit('get-group-roster', { code });
    assert.deepStrictEqual((await r).data.members.map((m) => m.id).sort(), [alice, bob].map((u) => u.user.id).sort());
  });
  await t.test('a group that shrinks to two is not reused as their 1:1 DM', async () => {
    const opened = next(A, ['dm-opened', 'error-msg']);
    A.emit('start-dm', { targetUserId: bob.user.id });
    const { event, data } = await opened;
    assert.strictEqual(event, 'dm-opened');
    assert.notStrictEqual(data.code, code, 'the 1:1 DM must be its own channel, not the group');
  });
  await t.test('the last member out deletes the group', async () => {
    B.emit('leave-group-dm', { code });
    await wait(300);
    const gone = next(A, ['channel-deleted']);
    A.emit('leave-group-dm', { code, attachments: [] });
    assert.strictEqual((await gone).data.code, code);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA, 'haven.db'), { readonly: true });
    const id = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    const left = ['messages', 'channel_members', 'dm_group_keys', 'dm_group_epochs', 'dm_group_invites'].map((tb) => db.prepare(`SELECT COUNT(*) AS n FROM ${tb} m WHERE m.channel_id IN (SELECT id FROM channels WHERE code = ?)`).get(code).n);
    db.close();
    assert.strictEqual(id, undefined);
    assert.deepStrictEqual(left, [0, 0, 0, 0, 0]);
  });
  await t.test('an admin who is not in a group can delete it, and its key rows go with it', async () => {
    const admin = await register('admin');
    const Z = await connect(admin.token);
    const opened = next(B, ['group-dm-opened', 'error-msg']);
    B.emit('start-group-dm', { userIds: [carol.user.id, dave.user.id] });
    const { data } = await opened;
    const published = next(B, ['group-epoch-published', 'error-msg']);
    B.emit('publish-group-epoch', { code: data.code, epoch: 1, ...epochFor([bob]) });
    assert.strictEqual((await published).event, 'group-epoch-published');
    const gone = next(B, ['channel-deleted']);
    Z.emit('delete-dm', { code: data.code });
    assert.strictEqual((await gone).data.code, data.code);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA, 'haven.db'), { readonly: true });
    const left = ['dm_group_keys', 'dm_group_epochs', 'dm_group_invites', 'dm_group_rewrap_requests'].map((tb) => db.prepare(`SELECT COUNT(*) AS n FROM ${tb} WHERE channel_id = ?`).get(data.id).n);
    db.close();
    assert.deepStrictEqual(left, [0, 0, 0, 0]);
    Z.close();
  });
  await t.test('the signing key backup round-trips and is size-capped', async () => {
    const stored = next(B, ['signing-backup-stored', 'error-msg']);
    B.emit('store-signing-backup', { backup: 'opaque-backup' });
    assert.strictEqual((await stored).event, 'signing-backup-stored');
    const got = next(B, ['encrypted-key-result']);
    B.emit('get-encrypted-key');
    const { data } = await got;
    assert.strictEqual(data.signingBackup, 'opaque-backup');
    assert.ok(data.signingKey);
    const big = next(B, ['signing-backup-stored', 'error-msg']);
    B.emit('store-signing-backup', { backup: 'x'.repeat(5000) });
    assert.strictEqual((await big).event, 'error-msg');
  });
  [A, B, C, D].forEach((s) => s.close());
});
