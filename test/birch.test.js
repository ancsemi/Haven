'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createBirch, parseTarget, upstreamPath, classify, UP_MS, DOWN_MS } = require('../src/birch');
const { SECRET, listen, close, send, fakeBird } = require('./birchFakeBot');
async function withApp(url, run, extra = {}) {
  const birch = createBirch({ url, secret: SECRET, log: { log() {}, warn() {} }, ...extra });
  const app = express();
  app.use('/birch', birch.proxy);
  app.use(express.json());
  const server = http.createServer(app);
  const port = await listen(server);
  try { return await run({ birch, port }); } finally { await close(server); }
}
test('parseTarget takes http and https addresses and nothing else', () => {
  assert.equal(parseTarget(''), null);
  assert.equal(parseTarget(undefined), null);
  assert.equal(parseTarget('not a url'), null);
  assert.equal(parseTarget('ftp://127.0.0.1:3001'), null);
  assert.equal(parseTarget('http://user:pw@127.0.0.1:3001'), null);
  const t = parseTarget(' http://127.0.0.1:3001/ ');
  assert.deepEqual([t.hostname, t.port, t.base], ['127.0.0.1', 3001, '']);
  assert.equal(parseTarget('https://birch.example').port, 443);
  assert.equal(parseTarget('http://birch').port, 80);
  assert.equal(parseTarget('http://[::1]:3001').hostname, '::1');
  assert.equal(parseTarget('http://127.0.0.1:3001/games-root/').base, '/games-root');
});
test('only the game client and its three API calls are reachable', () => {
  assert.equal(upstreamPath('/'), '/games/index.html');
  assert.equal(upstreamPath('/index.html?view=2d'), '/games/index.html?view=2d');
  assert.equal(upstreamPath('/assets/town.jpg'), '/games/assets/town.jpg');
  assert.equal(upstreamPath('/api/v1/state'), '/api/v1/state');
  assert.equal(upstreamPath('/api/v1/events?after=7'), '/api/v1/events?after=7');
  assert.equal(upstreamPath('/api/v1/action'), '/api/v1/action');
  for (const blocked of ['/api/v1/other', '/api/webhooks/x', '/api/', '/../health', '/a/../b', '/%2e%2e/health', '/a%2f..%2fb', '/a\\b', '/%00', '/%zz']) assert.equal(upstreamPath(blocked), null, blocked);
});
test('a reply is Birch only when it is the game API answering a check', () => {
  assert.equal(classify(null), 'unreachable');
  assert.equal(classify({ status: 200, body: '{"ok":true,"events":[]}' }), 'ok');
  assert.equal(classify({ status: 401, body: '{"ok":false,"error":"invalid signature"}' }), 'secret');
  assert.equal(classify({ status: 403, body: '{"ok":false,"error":"nope"}' }), 'secret');
  assert.equal(classify({ status: 401, body: 'Unauthorized' }), 'not-birch');
  assert.equal(classify({ status: 200, body: '<html></html>' }), 'not-birch');
  assert.equal(classify({ status: 200, body: '{"ok":true}' }), 'not-birch');
  assert.equal(classify({ status: 404, body: '{"error":"not found"}' }), 'not-birch');
});
test('with no address set Birch is off and nothing is probed', async () => {
  const birch = createBirch({ url: '', secret: SECRET });
  assert.equal(birch.enabled, false);
  assert.deepEqual(await birch.status(), { available: false, reason: 'off' });
});
test('status is available only when the bot answers and accepts the shared secret', async () => {
  const good = fakeBird();
  const goodPort = await listen(good.server);
  const wrong = fakeBird('some-other-secret-some-other-secret-0123');
  const wrongPort = await listen(wrong.server);
  const other = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>'); });
  const otherPort = await listen(other);
  const gone = http.createServer();
  const gonePort = await listen(gone);
  await close(gone);
  const quiet = { log() {}, warn() {} };
  try {
    assert.deepEqual(await createBirch({ url: `http://127.0.0.1:${goodPort}`, secret: SECRET, log: quiet }).status(), { available: true, reason: 'ok' });
    assert.deepEqual(await createBirch({ url: `http://127.0.0.1:${wrongPort}`, secret: SECRET, log: quiet }).status(), { available: false, reason: 'secret' });
    assert.deepEqual(await createBirch({ url: `http://127.0.0.1:${otherPort}`, secret: SECRET, log: quiet }).status(), { available: false, reason: 'not-birch' });
    assert.deepEqual(await createBirch({ url: `http://127.0.0.1:${gonePort}`, secret: SECRET, log: quiet }).status(), { available: false, reason: 'unreachable' });
    const probe = good.seen[0];
    assert.equal(probe.url, '/api/v1/events?after=2147483647');
    const claims = jwt.verify(probe.headers.authorization.slice(7), SECRET);
    assert.equal(claims.id, 2147483647);
    assert.ok(claims.exp - claims.iat <= 10);
    assert.equal(claims.purpose, undefined);
  } finally { await Promise.all([close(good.server), close(wrong.server), close(other)]); }
});
test('the answer is kept briefly: longer when up, shorter when down, one probe at a time', async () => {
  const bird = fakeBird();
  const port = await listen(bird.server);
  let clock = 1000000;
  const birch = createBirch({ url: `http://127.0.0.1:${port}`, secret: SECRET, now: () => clock, log: { log() {}, warn() {} } });
  try {
    const burst = await Promise.all([birch.status(), birch.status(), birch.status()]);
    assert.ok(burst.every((s) => s.available));
    assert.equal(bird.seen.length, 1);
    clock += UP_MS - 1;
    await birch.status();
    assert.equal(bird.seen.length, 1);
    clock += 2;
    await birch.status();
    assert.equal(bird.seen.length, 2);
    await close(bird.server);
    clock += UP_MS + 1;
    assert.equal((await birch.status()).available, false);
    clock += DOWN_MS - 1;
    assert.equal((await birch.status()).reason, 'unreachable');
    const again = fakeBird();
    again.server.listen(port, '127.0.0.1');
    await new Promise((r) => again.server.once('listening', r));
    clock += 2;
    assert.equal((await birch.status()).available, true);
    await close(again.server);
  } finally { bird.server.listening && await close(bird.server); }
});
test('a change in the answer is logged once, not on every check', async () => {
  const bird = fakeBird();
  const port = await listen(bird.server);
  let clock = 1000000;
  const lines = [];
  const birch = createBirch({ url: `http://127.0.0.1:${port}`, secret: SECRET, now: () => clock, log: { log: (m) => lines.push(['log', m]), warn: (m) => lines.push(['warn', m]) } });
  await birch.status();
  clock += UP_MS + 1;
  await birch.status();
  await close(bird.server);
  clock += UP_MS + 1;
  await birch.status();
  clock += DOWN_MS + 1;
  await birch.status();
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0], 'log');
  assert.match(lines[0][1], /Birch is running/);
  assert.equal(lines[1][0], 'warn');
  assert.match(lines[1][1], /nothing answers/);
});
test('the proxy serves the game client without the bot\'s own security headers or cookies', async () => {
  const bird = fakeBird();
  const botPort = await listen(bird.server);
  try {
    await withApp(`http://127.0.0.1:${botPort}`, async ({ port }) => {
      const page = await send(port, '/birch/', { headers: { Cookie: 'haven_session=secret', Authorization: 'Bearer abc', Accept: 'text/html' } });
      assert.equal(page.status, 200);
      assert.equal(page.body, '<html>birch</html>');
      assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(page.headers.etag, '"v1"');
      for (const dropped of ['set-cookie', 'content-security-policy', 'permissions-policy', 'access-control-allow-origin', 'x-frame-options']) assert.equal(page.headers[dropped], undefined, dropped);
      const got = bird.seen.at(-1);
      assert.equal(got.url, '/games/index.html');
      assert.equal(got.headers.cookie, undefined);
      assert.equal(got.headers.authorization, 'Bearer abc');
      assert.equal(got.headers.host, `127.0.0.1:${botPort}`);
    });
  } finally { await close(bird.server); }
});
test('a game action reaches the bot with its body and length intact, even behind a JSON parser', async () => {
  const bird = fakeBird();
  const botPort = await listen(bird.server);
  try {
    await withApp(`http://127.0.0.1:${botPort}`, async ({ port }) => {
      const payload = JSON.stringify({ action: 'pose', args: 'x,y,z' });
      const res = await send(port, '/birch/api/v1/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer abc' }, body: payload });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).got, payload);
      const got = bird.seen.at(-1);
      assert.equal(got.method, 'POST');
      assert.equal(got.headers['content-length'], String(Buffer.byteLength(payload)));
      assert.equal(got.headers['transfer-encoding'], undefined);
    });
  } finally { await close(bird.server); }
});
test('the state call the phone apps make comes back as the bot answered it', async () => {
  const bird = fakeBird();
  const botPort = await listen(bird.server);
  try {
    await withApp(`http://127.0.0.1:${botPort}`, async ({ port }) => {
      const token = jwt.sign({ id: 7, username: 'amy' }, SECRET);
      const ok = await send(port, '/birch/api/v1/state', { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(ok.status, 200);
      assert.equal(JSON.parse(ok.body).me.id, 7);
      const denied = await send(port, '/birch/api/v1/state');
      assert.equal(denied.status, 401);
      assert.equal(JSON.parse(denied.body).me, undefined);
    });
  } finally { await close(bird.server); }
});
test('everything else on the bot stays out of reach, and odd requests are turned away', async () => {
  const bird = fakeBird();
  const botPort = await listen(bird.server);
  try {
    await withApp(`http://127.0.0.1:${botPort}`, async ({ port }) => {
      const before = bird.seen.length;
      for (const path of ['/birch/api/v1/other', '/birch/api/webhooks/x', '/birch/%2e%2e/health', '/birch/a/../../health']) assert.equal((await send(port, path)).status, 404, path);
      assert.equal((await send(port, '/birch/', { method: 'PUT' })).status, 405);
      assert.equal((await send(port, '/birch/', { method: 'DELETE' })).status, 405);
      assert.equal(bird.seen.length, before);
      const bare = await send(port, '/birch?view=2d');
      assert.equal(bare.status, 302);
      assert.equal(bare.headers.location, '/birch/?view=2d');
    });
  } finally { await close(bird.server); }
});
test('with Birch off the path answers 404 JSON so apps and pages see nothing', async () => {
  await withApp('', async ({ port }) => {
    const res = await send(port, '/birch/api/v1/state');
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /json/);
    assert.ok(JSON.parse(res.body).error);
    assert.equal((await send(port, '/birch/index.html')).status, 404);
  });
});
test('a bot that stops answering gives 502 and takes the card away at once', async () => {
  const bird = fakeBird();
  const botPort = await listen(bird.server);
  await withApp(`http://127.0.0.1:${botPort}`, async ({ birch, port }) => {
    assert.equal((await birch.status()).available, true);
    await close(bird.server);
    const res = await send(port, '/birch/api/v1/state');
    assert.equal(res.status, 502);
    assert.ok(JSON.parse(res.body).error);
    assert.deepEqual(await birch.status(), { available: false, reason: 'unreachable' });
  });
});
