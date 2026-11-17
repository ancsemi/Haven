'use strict';

/**
 * A computer left on with Haven open used to keep someone's phone quiet for
 * as long as the window stayed open. A window that has gone away (auto-away
 * after a few idle minutes) no longer counts as being at a screen, so the
 * phone is pushed. One that is showing and not away still holds pushes back.
 *
 *   node --test test/pushAwayDevice.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createHarness, wait } = require('./socketServerHarness');

let relay;
const relayed = [];
const h = createHarness(3506, 'push-away');

test.before(async () => {
  relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { relayed.push(JSON.parse(body)); } catch { relayed.push({ raw: body }); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: 1, failure: 0, failedTokens: [] }));
    });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  process.env.FCM_RELAY_URL = `http://127.0.0.1:${relay.address().port}/push`;
  process.env.FCM_PUSH_KEY = 'push-away-test';
  await h.start();
});
test.after(async () => {
  await h.stop();
  await new Promise((r) => relay.close(r));
});

const pushesFor = (token, from) => relayed.slice(from).filter((p) => Array.isArray(p.tokens) && p.tokens.includes(token));
async function waitForPush(token, from, ms = 3000) {
  for (let t = 0; t < ms; t += 100) {
    if (pushesFor(token, from).length) return true;
    await wait(100);
  }
  return false;
}

test('an open window that has gone away does not hold back phone pushes', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const desk = await h.connect(bob.token);
  await wait(300);

  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'room'));
  A.emit('create-channel', { name: 'room' });
  const code = (await list).find((c) => c.name === 'room').code;
  desk.emit('join-channel', { code });
  await wait(300);
  A.emit('enter-channel', { code });
  await wait(200);

  const phone = 'phone-' + crypto.randomBytes(8).toString('hex');
  desk.emit('register-fcm-token', { token: phone });
  await wait(300);

  // Bob's computer shows Haven and he is there: no push.
  let from = relayed.length;
  A.emit('send-message', { code, content: 'hi @bob' });
  assert.equal(await waitForPush(phone, from, 1500), false, 'no push while he is at the screen');

  // The window is still open, but he walked away and it went away.
  desk.emit('set-status', { status: 'away', statusText: '' });
  await wait(300);
  from = relayed.length;
  A.emit('send-message', { code, content: 'still there @bob?' });
  assert.equal(await waitForPush(phone, from), true, 'his phone is pushed');
});
