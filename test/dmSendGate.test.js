'use strict';

// Every DM send asks _dmSendGate first. A DM used to go out unencrypted,
// without asking, whenever a key was missing, and a partner's key could be
// swapped without anyone noticing. The gate asks before either happens and
// remembers each partner's key on this device.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-platform.js'), 'utf8');

function createStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function loadPlatform(localStorage) {
  const context = vm.createContext({
    module: { exports: {} },
    localStorage,
    window: { crypto: { subtle: {} } },
    HavenE2E: function HavenE2E() {},
    document: { getElementById: () => null },
    t: (key, vars) => (vars && vars.name ? `${key}:${vars.name}` : key),
    console,
  });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-platform.js' });
  return context.module.exports;
}

const KEY_A = { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'AAA' };
const KEY_B = { kty: 'EC', crv: 'P-256', x: 'bbb', y: 'BBB' };

// A stand-in app: one DM with user 7, E2E ready unless told otherwise, and a
// question box that answers with whatever the test queues up.
function makeApp({ serverKey = KEY_A, ready = true, answers = [] } = {}) {
  const methods = loadPlatform(createStorage());
  const app = Object.assign(Object.create(null), methods, {
    user: { id: 1 },
    currentChannel: 'dm000001',
    channels: [
      { code: 'dm000001', is_dm: 1, dm_target: { id: 7, username: 'sam' } },
      { code: 'general1', is_dm: 0 },
    ],
    _dmPublicKeys: {},
    _e2eNoKey: new Set(),
    _e2eKeyNotices: new Map(),
    _plainDmOk: new Set(),
    _dmGateAsking: new Map(),
    socket: {},
    asked: [],
    unlockPrompts: 0,
    e2e: {
      ready,
      requestPartnerKey: async () => serverKey,
    },
    _askChoice(title, message, buttons) {
      // Copied into this realm: the module runs in its own vm context.
      this.asked.push({ title, message, buttons: Array.from(buttons, b => b.id) });
      return Promise.resolve(answers.shift() ?? null);
    },
    _requireE2E() { this.unlockPrompts++; },
    _showE2EVerification() { this.verified = true; },
    _fmtDateTime: () => 'now',
  });
  return app;
}

test('a channel that is not a DM goes straight through', async () => {
  const app = makeApp();
  assert.equal((await app._dmSendGate('general1')).partner, null);
  assert.equal(app.asked.length, 0);
});

test('a DM with a key is encrypted without asking, and the key is remembered', async () => {
  const app = makeApp();
  const gate = await app._dmSendGate('dm000001');
  assert.equal(gate.partner.publicKeyJwk, KEY_A);
  assert.equal(app.asked.length, 0);
  assert.equal(app._e2ePinCheck(7, KEY_A), 'same');
});

test('a changed key is not used until the sender trusts it', async () => {
  const app = makeApp({ answers: ['cancel', 'verify', 'trust'] });
  app._e2ePinSet(7, KEY_A);
  app.e2e.requestPartnerKey = async () => KEY_B;

  assert.equal(await app._dmSendGate('dm000001'), null, 'cancel stops the send');
  assert.equal(app.asked[0].title, 'platform.e2e.key_changed_title:sam');
  assert.deepEqual(app.asked[0].buttons, ['cancel', 'verify', 'trust']);

  assert.equal(await app._dmSendGate('dm000001'), null, 'checking codes stops the send too');
  assert.equal(app.verified, true);

  const gate = await app._dmSendGate('dm000001');
  assert.equal(gate.partner.publicKeyJwk, KEY_B, 'trusted, it encrypts to the new key');
  assert.equal(app._e2ePinCheck(7, KEY_B), 'same', 'and the new key is the remembered one');
  assert.equal(app.asked.length, 3);
});

test('no key for the partner: ask, and remember a yes for the session', async () => {
  const app = makeApp({ serverKey: null, answers: [null, 'send'] });
  assert.equal(await app._dmSendGate('dm000001'), null, 'Escape or a click outside stops the send');
  assert.equal(app.asked[0].message, 'platform.e2e.plain_no_key:sam');
  assert.deepEqual(app.asked[0].buttons, ['cancel', 'send']);

  assert.equal((await app._dmSendGate('dm000001')).partner, null);
  assert.equal((await app._dmSendGate('dm000001')).partner, null);
  assert.equal(app.asked.length, 2, 'asked once more, then not again');
});

test('locked encryption offers to unlock instead of sending', async () => {
  const app = makeApp({ ready: false, answers: ['unlock'] });
  assert.equal(await app._dmSendGate('dm000001'), null);
  assert.equal(app.asked[0].message, 'platform.e2e.plain_locked');
  assert.deepEqual(app.asked[0].buttons, ['cancel', 'unlock', 'send']);
  assert.equal(app.unlockPrompts, 1);
});

test('a batch sent at once asks one question', async () => {
  const app = makeApp({ serverKey: null, answers: ['send'] });
  const results = await Promise.all([1, 2, 3].map(() => app._dmSendGate('dm000001')));
  assert.equal(app.asked.length, 1);
  for (const r of results) assert.equal(r.partner, null);
});
