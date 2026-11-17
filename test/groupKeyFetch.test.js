'use strict';

// How often a group member's app asks the server for keys. Opening a group
// with history from before you joined used to ask for the group's keys once
// per locked message: a page of fifty locked rows was fifty lookups, which ran
// through the general rate limit, so the member saw "Slow down" and the
// dropped lookups left the page waiting on timeouts. The app now asks once,
// shares that one request between every message waiting on it, and pauses
// after a lookup goes unanswered.
//
//   node --test test/groupKeyFetch.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'public/js/e2e-group.js'));
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-groups.js'), 'utf8');
const subtle = webcrypto.subtle;

function loadGroups(timers) {
  const context = vm.createContext({
    module: { exports: {} }, HavenGroupCrypto: G, crypto: webcrypto, console,
    document: { getElementById: () => null, querySelector: () => null },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-groups.js' });
  return context.module.exports;
}

const pub = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });

async function identity(id) {
  const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const sign = await G.generateSigningKeyPair();
  return { id, ecdh, ecdhJwk: pub(await subtle.exportKey('jwk', ecdh.publicKey)), sign, signJwk: await G.exportPublicJwk(sign.publicKey) };
}

async function pairKey(me, theirJwk) {
  const theirs = await subtle.importKey('jwk', { ...theirJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return subtle.deriveKey({ name: 'ECDH', public: theirs }, me.ecdh.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// A stand-in server for one group (channel 5, code g1) that counts what each
// member asks for, and can stop answering like a rate-limited server.
function makeServer(members) {
  const server = { epoch: 0, rows: [], statements: new Map(), asked: [], silent: false };
  server.reply = (asker, ev, payload) => {
    server.asked.push({ asker, ev });
    if (server.silent) return null;
    const m = (id) => members.find(x => x.id === id);
    if (ev === 'get-signing-key') return { ev: 'signing-key-result', data: { userId: payload.userId, jwk: m(payload.userId).signJwk, keys: [m(payload.userId).signJwk] } };
    if (ev === 'get-public-key') return { ev: 'public-key-result', data: { userId: payload.userId, jwk: m(payload.userId).ecdhJwk } };
    if (ev === 'get-group-roster') {
      return { ev: 'group-roster', data: { code: 'g1', id: 5, epoch: server.epoch, members: members.map(x => ({ id: x.id, username: `u${x.id}`, publicKey: x.ecdhJwk, signingKey: x.signJwk })), pending: [] } };
    }
    if (ev === 'get-group-keys') {
      const keys = server.rows.filter(r => r.recipientId === asker && r.epoch > payload.sinceEpoch)
        .map(r => ({ epoch: r.epoch, wrappedKey: r.wrappedKey, wrappedBy: r.wrappedBy, ...server.statements.get(r.epoch) }));
      return { ev: 'group-keys', data: { code: 'g1', currentEpoch: server.epoch, keys, needsRotation: server.epoch === 0 } };
    }
    if (ev === 'publish-group-epoch') {
      server.epoch = payload.epoch;
      for (const k of payload.keys) server.rows.push({ epoch: payload.epoch, recipientId: k.recipientId, wrappedKey: k.wrappedKey, wrappedBy: asker });
      server.statements.set(payload.epoch, { publishedBy: asker, sig: payload.sig, roster: payload.roster });
      return { ev: 'group-epoch-published', data: { code: 'g1', epoch: payload.epoch } };
    }
    return null;
  };
  return server;
}

// Timers the test runs by hand, so a back-off can be checked without waiting.
function manualTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimeout: (t) => pending.delete(t),
    async runAll() { const due = [...pending.values()]; pending.clear(); for (const t of due) await t.fn(); },
  };
}

function makeApp(me, server, timers = manualTimers()) {
  const handlers = new Map();
  const app = Object.assign(Object.create(null), loadGroups(timers), {
    user: { id: me.id }, timers, reloads: 0,
    channels: [{ id: 5, code: 'g1', is_dm: 1, is_group: 1 }],
    currentChannel: 'g1',
    socket: { on: (ev, h) => handlers.set(ev, h), off() {}, emit: (ev, payload) => server.reply(me.id, ev, payload), connected: false },
    fire: (ev, data) => handlers.get(ev)?.(data),
    e2e: {
      ready: true, _publicKeyJwk: me.ecdhJwk, signingPrivateKey: me.sign.privateKey, signingPublicJwk: me.signJwk,
      pairKey: (id, jwk) => pairKey(me, jwk),
      requestPartnerKey: async () => null,
      initSigning: async () => true,
    },
    _groupReq: async (ev, payload) => server.reply(me.id, ev, payload),
    _e2ePinCheck: () => 'same',
    _showToast() {},
    _getNickname: (id, name) => name,
    _groupRerender() { this.reloads++; },
  });
  return app;
}

// Alice, Bob and Carol talk in epoch 1. Dave joins and the group moves to
// epoch 2, so everything before that is locked for him.
async function lateJoiner(count = 50) {
  const [alice, bob, carol, dave] = await Promise.all([identity(1), identity(2), identity(3), identity(4)]);
  const server = makeServer([alice, bob, carol, dave]);
  const a = makeApp(alice, server);
  await a._groupRotate('g1');
  server.rows = server.rows.filter(r => r.recipientId !== dave.id);
  const before = [];
  for (let i = 0; i < count; i++) before.push({ id: i + 1, user_id: 1, content: await a._groupEncrypt('g1', `before ${i}`) });
  await a._groupRotate('g1');
  const after = { id: count + 1, user_id: 1, content: await a._groupEncrypt('g1', 'after') };
  const d = makeApp(dave, server);
  d._setupGroupListeners();
  server.asked.length = 0;
  return { server, a, d, before, after };
}

const keyLookups = (server, asker = 4) => server.asked.filter(x => x.asker === asker && x.ev === 'get-group-keys').length;

test('opening a page of locked history asks for the group keys once', async () => {
  const { server, d, before, after } = await lateJoiner();
  const page = [...before, after];
  await d._decryptGroupMessages(page, { code: 'g1' });
  assert.equal(keyLookups(server), 1);
  assert.equal(page.filter(m => m.content === 'groups.before_join').length, 50);
  assert.equal(page.at(-1).content, 'after');
  // Scrolling back or drawing the page again costs nothing more.
  await d._decryptGroupMessages(before.map(m => ({ ...m })), { code: 'g1' });
  assert.equal(keyLookups(server), 1);
});

test('messages waiting on keys at the same time share one request', async () => {
  const { server, d, before } = await lateJoiner(20);
  await Promise.all(before.map(m => d._groupDecrypt('g1', m.content, 1, m.id)));
  assert.equal(keyLookups(server), 1);
});

test('a key for a newer epoch than the app knows about is still fetched', async () => {
  const { server, a, d, after } = await lateJoiner(3);
  assert.equal((await d._groupDecrypt('g1', after.content, 1)).ok, true);
  await a._groupRotate('g1');
  const newer = await a._groupEncrypt('g1', 'epoch three');
  server.asked.length = 0;
  const r = await d._groupDecrypt('g1', newer, 1);
  assert.equal(r.ok, true);
  assert.equal(r.plaintext, 'epoch three');
  assert.equal(keyLookups(server), 1);
});

test('a missing key newer than the ones held reads as waiting, not as before joining', async () => {
  const { server, a, d, after } = await lateJoiner(3);
  assert.equal((await d._groupDecrypt('g1', after.content, 1)).ok, true);
  await a._groupRotate('g1');
  // Dave's copy of the new key has not been shared with him yet.
  server.rows = server.rows.filter(r => !(r.recipientId === 4 && r.epoch === server.epoch));
  const newer = await a._groupEncrypt('g1', 'epoch three');
  assert.equal((await d._groupDecrypt('g1', newer, 1)).reason, 'no-key');
});

test('an unanswered lookup pauses the rest, then retries once and redraws', async () => {
  const { server, d, before } = await lateJoiner(30);
  server.silent = true;
  await d._decryptGroupMessages(before.map(m => ({ ...m })), { code: 'g1' });
  assert.equal(keyLookups(server), 1, 'one lookup, not one per message');
  assert.equal(d.timers.pending.size, 1, 'one retry is scheduled');
  const [{ ms }] = d.timers.pending.values();
  assert.ok(ms >= 2000, `retry waits out the pause (${ms} ms)`);
  server.silent = false;
  d._groupBackoff.until = 0;
  await d.timers.runAll();
  assert.equal(keyLookups(server), 2);
  assert.equal(d.reloads, 1, 'the group is drawn again with the keys it now has');
});

test('a rate-limit warning from the server pauses key lookups', async () => {
  const { server, d, before } = await lateJoiner(5);
  d.fire('error-msg', 'Slow down: too many requests');
  await d._decryptGroupMessages(before.map(m => ({ ...m })), { code: 'g1' });
  assert.equal(keyLookups(server), 0);
  d.fire('error-msg', 'Something else went wrong');
  d._groupBackoff.until = 0;
  await d._decryptGroupMessages(before.map(m => ({ ...m })), { code: 'g1' });
  assert.equal(keyLookups(server), 1);
});

test('a reconnect forgets what the app learned, since events may have been missed', async () => {
  const { server, d, before } = await lateJoiner(5);
  await d._decryptGroupMessages(before.map(m => ({ ...m })), { code: 'g1' });
  d.fire('connect');
  await d._decryptGroupMessages(before.map(m => ({ ...m })), { code: 'g1' });
  assert.equal(keyLookups(server), 2);
});
