'use strict';

/**
 * A bot's post in a channel pushes the members' phones like anyone's
 * message. It used to push nobody, so people with push turned on heard
 * nothing from bots. A silent bot post stays silent.
 *
 *   node --test test/webhookPush.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createHarness, wait } = require('./socketServerHarness');

let relay;
const relayed = [];
const h = createHarness(3512, 'webhook-push');

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
  process.env.FCM_PUSH_KEY = 'webhook-push-test';
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

test('a bot post pushes the channel members', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);

  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'alerts'));
  A.emit('create-channel', { name: 'alerts' });
  const code = (await list).find((c) => c.name === 'alerts').code;
  B.emit('join-channel', { code });
  await wait(300);

  const made = h.next(A, 'webhook-created', (w) => w && w.name === 'Watcher');
  A.emit('create-webhook', { channelCode: code, name: 'Watcher' });
  const hook = await made;
  assert.ok(hook && hook.token, 'webhook made');

  const phone = 'phone-' + crypto.randomBytes(8).toString('hex');
  B.emit('register-fcm-token', { token: phone });
  await wait(300);
  B.disconnect();
  await wait(300);

  let from = relayed.length;
  const posted = await h.post(`/api/webhooks/${hook.token}`, { content: 'disk is full' });
  assert.ok(posted.success, JSON.stringify(posted));
  assert.equal(await waitForPush(phone, from), true, 'bob\'s phone is pushed');
  const push = pushesFor(phone, from)[0];
  assert.match(JSON.stringify(push), /Watcher/, 'named after the bot');

  from = relayed.length;
  await h.post(`/api/webhooks/${hook.token}`, { content: 'quiet note', silent: true });
  assert.equal(await waitForPush(phone, from, 1500), false, 'a silent bot post pushes nobody');

  // Opening the link in a browser explains itself instead of "Not found".
  const opened = await new Promise((resolve, reject) => {
    http.get(`http://localhost:3512/api/webhooks/${hook.token}`, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
  assert.equal(opened.status, 405);
  assert.match(opened.body.error, /POST/);

  A.disconnect();
});
