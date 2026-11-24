'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createHarness } = require('./socketServerHarness');
const { SECRET, listen, close, send, fakeBird } = require('./birchFakeBot');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const get = (port, path, token, extra = {}) => send(port, path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...extra });
let on, off, onPort, offPort, bird, admin, member;
test.before(async () => {
  bird = fakeBird();
  const botPort = await listen(bird.server);
  [onPort, offPort] = [await freePort(), await freePort()];
  on = createHarness(onPort, 'birch-on', { JWT_SECRET: SECRET, BIRCH_PROXY_URL: `http://127.0.0.1:${botPort}` });
  off = createHarness(offPort, 'birch-off', { JWT_SECRET: SECRET, BIRCH_PROXY_URL: '' });
  await Promise.all([on.start(), off.start()]);
  admin = await on.register('admin');
  member = await on.register('bob');
});
test.after(async () => {
  await Promise.all([on?.stop(), off?.stop()]);
  bird?.server.listening && await close(bird.server);
});
test('a Haven with a running Birch tells signed-in members so, and only them', async () => {
  assert.equal((await get(onPort, '/api/birch/status')).status, 401);
  assert.equal((await get(onPort, '/api/birch/status', 'not.a.token')).status, 401);
  const asMember = await get(onPort, '/api/birch/status', member.token);
  assert.equal(asMember.status, 200);
  assert.deepEqual(JSON.parse(asMember.body), { enabled: true });
  assert.equal(asMember.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse((await get(onPort, '/api/birch/status', admin.token)).body), { enabled: true, reason: 'ok' });
});
test('Birch loads through Haven under Haven\'s own security headers', async () => {
  const page = await get(onPort, '/birch/index.html');
  assert.equal(page.status, 200);
  assert.equal(page.body, '<html>birch</html>');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /default-src \*/);
  assert.match(page.headers['permissions-policy'], /camera=\(self\)/);
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await get(onPort, '/birch/')).body, '<html>birch</html>');
});
test('the game calls and the phone apps\' state probe pass through with the member\'s token', async () => {
  const state = await get(onPort, '/birch/api/v1/state', member.token);
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).me.id, member.id);
  const payload = JSON.stringify({ action: 'fish', args: '' });
  const action = await get(onPort, '/birch/api/v1/action', member.token, { method: 'POST', headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, body: payload });
  assert.equal(JSON.parse(action.body).got, payload);
  assert.equal((await get(onPort, '/birch/api/v1/state')).status, 401);
  assert.equal((await get(onPort, '/birch/api/webhooks/x', member.token)).status, 404);
});
test('a Haven without Birch has no card and no Birch path', async () => {
  const token = (await off.register('admin')).token;
  assert.deepEqual(JSON.parse((await get(offPort, '/api/birch/status', token)).body), { enabled: false, reason: 'off' });
  const state = await get(offPort, '/birch/api/v1/state', token);
  assert.equal(state.status, 404);
  assert.equal(JSON.parse(state.body).me, undefined);
  assert.equal((await get(offPort, '/birch/index.html')).status, 404);
});
test('when the bot stops, the card goes at once and Birch answers 502', async () => {
  await close(bird.server);
  assert.equal((await get(onPort, '/birch/api/v1/state', member.token)).status, 502);
  assert.deepEqual(JSON.parse((await get(onPort, '/api/birch/status', admin.token)).body), { enabled: false, reason: 'unreachable' });
  assert.deepEqual(JSON.parse((await get(onPort, '/api/birch/status', member.token)).body), { enabled: false });
});
