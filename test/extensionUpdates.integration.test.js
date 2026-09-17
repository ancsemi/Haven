'use strict';

// Use the actual server.js handlers on loopback to check the HTTP authorization
// boundary. The updater is a stub here; file/download behavior lives in the
// unit tests. Flip admin status during apply to model an in-flight demotion.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const express = require('express');

test('admin API rejects anonymous and non-admin callers and rechecks authorization at apply', async t => {
  const app = express();
  app.use(express.json());
  let admin = true;
  let invoked = 0;
  // Evaluate the route section with isolated dependencies. This exercises the
  // production handlers without starting voice services or opening a user DB.
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('// ── Plugin & theme update endpoints');
  const end = source.indexOf('// ── Push notification VAPID', start);
  assert.ok(start >= 0 && end > start, 'extension route section exists');
  vm.runInNewContext(source.slice(start, end), {
    app,
    verifyToken: token => token === 'scoped' ? { id: 'admin', purpose: 'connect' } : { id: token },
    verifyAdminFromDb: user => user.id === 'admin' && admin,
    extensionUpdater: {
      check: async () => { invoked++; return {}; },
      apply: async (token, user, authorized) => {
        admin = false;
        assert.equal(authorized(), false);
        throw new Error('Administrator permission is required.');
      },
    },
    io: { emit() { assert.fail('failed update must not notify clients'); } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/extensions`;
  assert.equal((await fetch(url + '/check', { method: 'POST' })).status, 401);
  assert.equal(
    (await fetch(url + '/check', { method: 'POST', headers: { Authorization: 'Bearer member' } })).status,
    403,
  );
  assert.equal((await fetch(url + '/check', { method: 'POST', headers: { Authorization: 'Bearer scoped' } })).status, 401);
  assert.equal(invoked, 0);
  assert.equal(
    (await fetch(url + '/check', { method: 'POST', headers: { Authorization: 'Bearer admin' } })).status,
    200,
  );
  assert.equal(
    (await fetch(url + '/apply', { method: 'POST', headers: { Authorization: 'Bearer admin' } })).status,
    400,
  );
});

test('a successful update broadcasts a reload notification to connected clients', async t => {
  const app = express();
  app.use(express.json());
  const emitted = [];
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('// ── Plugin & theme update endpoints');
  const end = source.indexOf('// ── Push notification VAPID', start);
  vm.runInNewContext(source.slice(start, end), {
    app,
    verifyToken: () => ({ id: 'admin' }),
    verifyAdminFromDb: () => true,
    extensionUpdater: {
      check: async () => ({}),
      apply: async (token, user, authorized) => {
        assert.equal(token, 'approved-offer');
        assert.equal(user, 'admin');
        assert.equal(authorized(), true);
        return { version: '1.1.0', reloadRequired: true };
      },
    },
    io: { emit(event) { emitted.push(event); } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/admin/extensions/apply`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'approved-offer' }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(emitted, ['extensions-updated']);
});
