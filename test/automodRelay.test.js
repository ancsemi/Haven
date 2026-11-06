'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registerAutomodRelay = require('../src/routes/automodRelay');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automod-'));
const PROFILE = path.join(tmp, 'automod-local.json');
fs.writeFileSync(PROFILE, JSON.stringify({ recommendedProvider: 'ollama', recommendedEndpoint: 'http://127.0.0.1:11434/v1/chat/completions', recommendedModel: 'granite4.2:latest', hardware: { gpu: 'Radeon', ramGb: 60 } }));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const setup = ({ auth = { user: { id: 1 }, isAdmin: true }, user = { id: 1 }, fetchImpl, profilePath = PROFILE, enabled = true, pluginPath } = {}) => {
  const routes = {}, seen = [], kv = new Map(enabled ? [['automod_ai_enabled', 'true']] : []);
  const ollama = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    seen.push({ url, init, body });
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: 'granite4.2:latest' }] }) };
    if (url.endsWith('/api/chat')) { await tick(10); const bad = /scam/.test(body.messages[1].content); return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: JSON.stringify({ safe: !bad, reason: bad ? 'Phishing' : 'Clean' }) } }) }; }
    if (url.endsWith('/api/generate')) return { ok: true, status: 200, text: async () => '{}' };
    return { ok: false, status: 401, text: async () => '{"error":"bad key"}' };
  };
  const engine = registerAutomodRelay({
    app: { get: (p, ...f) => { routes[`GET ${p}`] = f.at(-1); }, post: (p, ...f) => { routes[`POST ${p}`] = f.at(-1); }, put: (p, ...f) => { routes[`PUT ${p}`] = f.at(-1); } },
    getModUser: () => auth,
    verifyToken: t => (t === 'good' || t === 'banned') ? { ...user, id: t === 'banned' ? 99 : user.id } : null,
    isBanned: id => id === 99,
    rateLimit: () => (q, s, n) => n(),
    fetchImpl: fetchImpl || ollama,
    profilePath,
    ...(pluginPath ? { pluginPath } : {}),
    settings: { get: k => kv.get(k) || '', set: (k, v) => kv.set(k, v) }
  });
  const call = async (route, body, token = 'good') => { const out = { code: 200, body: null, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await routes[route]({ body, headers: { authorization: token ? `Bearer ${token}` : '' } }, out); return out; };
  return { call, seen, engine, kv, chats: () => seen.filter(s => s.url.endsWith('/api/chat')) };
};
const ok = { url: 'https://api.meta.ai/v1/chat/completions', headers: { Authorization: 'Bearer k', Cookie: 'sid=1', 'X-Forwarded-For': '1.2.3.4' }, body: { model: 'muse-spark-1.3', messages: [] } };
test('relay forwards to known AI hosts with only the auth headers', async () => {
  const { call, seen } = setup();
  const res = await call('POST /api/automod/relay', ok);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { status: 401, body: '{"error":"bad key"}' });
  assert.equal(seen[0].url, 'https://api.meta.ai/v1/chat/completions');
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json', authorization: 'Bearer k' });
  assert.equal(seen[0].init.redirect, 'error');
});
test('relay refuses non-moderators and scoped tokens', async () => {
  assert.equal((await setup({ auth: { error: 'Insufficient permissions', status: 403 } }).call('POST /api/automod/relay', ok)).code, 403);
  assert.equal((await setup({ auth: { user: { id: 2, purpose: 'link' } } }).call('POST /api/automod/relay', ok)).code, 401);
});
test('relay only reaches allowlisted https hosts', async () => {
  const { call, seen } = setup();
  for (const url of ['http://api.meta.ai/v1/chat/completions', 'https://127.0.0.1/v1', 'https://evil.example/v1', 'https://api.meta.ai:8443/v1', 'https://user:pw@api.meta.ai/v1', 'not a url']) assert.equal((await call('POST /api/automod/relay', { ...ok, url })).code, 400, url);
  assert.equal((await call('POST /api/automod/relay', { ...ok, body: 'text' })).code, 400);
  assert.equal(seen.length, 0);
});
test('relay reports upstream network failures as 502', async () => {
  const res = await setup({ fetchImpl: async () => { throw new Error('ECONNRESET'); } }).call('POST /api/automod/relay', ok);
  assert.equal(res.code, 502);
  assert.match(res.body.error, /ECONNRESET/);
});
test('local-status needs a login and never shows the hardware profile', async () => {
  const { call } = setup();
  assert.equal((await call('GET /api/automod/local-status', null, '')).code, 401);
  const res = await call('GET /api/automod/local-status');
  assert.deepEqual(res.body, { available: true, model: 'granite4.2:latest', rules: '', reason: '' });
  const none = await setup({ profilePath: path.join(tmp, 'missing.json') }).call('GET /api/automod/local-status');
  assert.equal(none.body.available, false);
  assert.match(none.body.reason, /setup-automod-ai\.sh/);
  const down = await setup({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }).call('GET /api/automod/local-status');
  assert.match(down.body.reason, /Ollama is not running/);
});
test('server AI scans one link at a time, shares verdicts and unloads the model when the queue empties', async () => {
  const { call, seen, chats } = setup();
  const [a, b, c] = await Promise.all(['https://scam-gift.org/login', 'https://docs.example.org/a', 'https://scam-gift.org/login'].map(url => call('POST /api/automod/scan', { url })));
  assert.deepEqual([a.body.safe, b.body.safe, c.body.safe], [false, true, false]);
  assert.equal(a.body.source, 'haven_ai');
  assert.equal(chats().length, 2, 'the same url is scanned once for everyone');
  assert.ok(chats().every(x => x.body.keep_alive === '2m' && x.body.format === 'json' && x.body.think === false && x.body.model === 'granite4.2:latest'), 'thinking models must answer, not think');
  const ends = chats().map(x => seen.indexOf(x));
  assert.equal(seen.filter(s => s.url.endsWith('/api/generate')).length, 1);
  assert.ok(seen.findIndex(s => s.url.endsWith('/api/generate')) > Math.max(...ends), 'unload comes after the last scan');
  assert.deepEqual(seen.find(s => s.url.endsWith('/api/generate')).body, { model: 'granite4.2:latest', keep_alive: 0 });
  await call('POST /api/automod/scan', { url: 'https://docs.example.org/a' });
  assert.equal(chats().length, 2, 'cached verdicts skip the GPU');
});
test('members only read verdicts; moderators start new scans', async () => {
  const s = setup({ auth: { error: 'Insufficient permissions', status: 403 } });
  assert.equal((await s.call('POST /api/automod/scan', { url: 'https://new.example.org/' })).code, 202);
  assert.equal(s.chats().length, 0);
  s.engine.sweep('look https://scam-site.org/x', 7);
  const res = await s.call('POST /api/automod/scan', { url: 'https://scam-site.org/x' });
  assert.equal(res.body.safe, false, 'members get the swept verdict');
  assert.equal((await s.call('POST /api/automod/scan', { url: 'https://x.org/' }, '')).code, 401);
  assert.equal((await s.call('POST /api/automod/scan', { url: 'javascript:alert(1)' })).code, 400);
  assert.equal((await setup({ profilePath: path.join(tmp, 'missing.json') }).call('POST /api/automod/scan', { url: 'https://x.org/' })).code, 404);
});
test('the sweep scans posted links automatically but skips trusted and already-blocked hosts', async () => {
  const s = setup();
  const sockets = [], handlers = {};
  s.engine.attachSweep({ on: (ev, fn) => ev === 'connection' && sockets.push(fn) });
  sockets[0]({ user: { id: 1 }, on: (ev, fn) => { handlers[ev] = fn; } });
  assert.deepEqual(Object.keys(handlers).sort(), ['edit-message', 'send-message', 'send-thread-message']);
  handlers['send-message']({ code: 'abcd1234', content: 'see https://github.com/x and https://unknown-shop.net/deal and https://grabify.link/abc' });
  handlers['send-message'](null);
  await tick(40);
  assert.deepEqual(s.chats().map(c => c.body.messages[1].content.match(/Target URL: "([^"]+)"/)[1]), ['https://unknown-shop.net/deal']);
  assert.equal(setup({ profilePath: path.join(tmp, 'missing.json') }).engine.sweep('https://unknown-shop.net/deal', 1), undefined);
});
test('warnings are claimed once across moderators', async () => {
  const s = setup();
  assert.deepEqual((await s.call('POST /api/automod/claim-warn', { key: 'c1:42:https://scam.org/' })).body, { claimed: true });
  assert.deepEqual((await s.call('POST /api/automod/claim-warn', { key: 'c1:42:https://scam.org/' })).body, { claimed: false });
  assert.equal((await setup({ auth: { error: 'Insufficient permissions', status: 403 } }).call('POST /api/automod/claim-warn', { key: 'k' })).code, 403);
});
test('only admins set the server AI rules, and new rules clear old verdicts', async () => {
  const s = setup();
  await s.call('POST /api/automod/scan', { url: 'https://shop.example.org/' });
  assert.equal((await setup({ auth: { user: { id: 3 }, isAdmin: false } }).call('PUT /api/automod/rules', { rules: 'x' })).code, 403);
  assert.deepEqual((await s.call('PUT /api/automod/rules', { rules: 'No crypto shilling.' })).body, { rules: 'No crypto shilling.' });
  assert.equal((await s.call('GET /api/automod/local-status')).body.rules, 'No crypto shilling.');
  await s.call('POST /api/automod/scan', { url: 'https://shop.example.org/' });
  assert.equal(s.chats().length, 2);
  assert.match(s.chats()[1].body.messages[0].content, /No crypto shilling\./);
});
test('empty or malformed model replies are never cached as safe', async () => {
  const replies = ['', '{"reason":"thinking ran out"}', JSON.stringify({ safe: false, reason: 'Phishing' })];
  const s = setup({ fetchImpl: async (url, init) => url.endsWith('/api/chat') ? { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: replies.shift() } }) } : { ok: true, status: 200, text: async () => '{}' } });
  assert.equal((await s.call('POST /api/automod/scan', { url: 'https://scam-gift.org/' })).code, 503);
  assert.equal((await s.call('POST /api/automod/scan', { url: 'https://scam-gift.org/' })).code, 503);
  assert.deepEqual((await s.call('POST /api/automod/scan', { url: 'https://scam-gift.org/' })).body, { safe: false, reason: 'Phishing', source: 'haven_ai' });
});
test('everything stays off until an admin turns AI link checks on', async () => {
  const s = setup({ enabled: false });
  assert.equal((await s.call('GET /api/automod/local-status')).code, 404);
  assert.equal((await s.call('POST /api/automod/scan', { url: 'https://unknown-shop.net/deal' })).code, 404);
  assert.equal((await s.call('POST /api/automod/claim-warn', { key: 'k' })).code, 404);
  assert.equal((await s.call('PUT /api/automod/rules', { rules: 'x' })).code, 404);
  assert.equal((await s.call('POST /api/automod/relay', ok)).code, 404);
  s.engine.sweep('see https://unknown-shop.net/deal', 1);
  await tick(20);
  assert.equal(s.seen.length, 0, 'nothing reaches Ollama or a cloud host');
  s.kv.set('automod_ai_enabled', 'true');
  assert.equal((await s.call('GET /api/automod/local-status')).code, 200, 'turning it on takes effect without a restart');
});
test('a missing plugin file leaves the server running with the checks off', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = setup({ pluginPath: path.join(tmp, 'gone.plugin.js') });
    assert.equal((await s.call('POST /api/automod/scan', { url: 'https://unknown-shop.net/deal' })).code, 404);
    assert.doesNotThrow(() => s.engine.sweep('see https://unknown-shop.net/deal', 1));
  } finally {
    console.warn = warn;
  }
});
test('the AI is shown the link only, never the message around it', async () => {
  const s = setup();
  s.engine.sweep('my password is hunter2, see https://unknown-shop.net/deal', 1);
  await tick(40);
  assert.equal(s.chats().length, 1);
  assert.doesNotMatch(JSON.stringify(s.chats()[0].body), /hunter2/);
});
test('one member posting links cannot crowd out a moderator', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const s = setup({ fetchImpl: async (url, init) => {
    if (url.endsWith('/api/chat')) {
      await gate;
      const u = JSON.parse(init.body).messages[1].content;
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: JSON.stringify({ safe: !/mod-check/.test(u), reason: 'r' }) } }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  } });
  for (let i = 0; i < 40; i++) s.engine.sweep(`https://spam${i}.example.net/x`, 9);
  const mod = s.call('POST /api/automod/scan', { url: 'https://mod-check.example.net/' });
  release();
  assert.equal((await mod).body.safe, false, 'the moderator still gets an answer');
  await tick(40);
  assert.ok(s.chats().length <= 11, `one member gets a limited share of the queue (${s.chats().length} scans)`);
});
test('a banned account gets nothing from the scan routes', async () => {
  const { call } = setup();
  assert.equal((await call('POST /api/automod/scan', { url: 'https://example.com/' }, 'banned')).code, 401);
  assert.equal((await call('GET /api/automod/local-status', null, 'banned')).code, 401);
});
