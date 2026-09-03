/**
 * Forum channels (#144): topics are ordered by their latest thread activity,
 * and the pagination cursors follow that order.
 *
 * Needs a running Haven server. Boots one on a scratch port and data dir:
 *   node --test test/forumChannels.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3398;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-forum-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}

/** Resolve with the next `event` payload that passes `filter`, or null on timeout. */
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}

function history(sock, code, opts = {}) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code, ...opts });
  return p;
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin' },
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

test('forum channels order topics by latest activity', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'forumtest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  // Create a channel and flip it to forum mode.
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'topics'));
  A.emit('create-channel', { name: 'topics' });
  let channels = await list;
  assert.ok(channels, 'channel list arrived after create');
  const code = channels.find((c) => c.name === 'topics').code;

  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 1));
  A.emit('toggle-channel-permission', { code, permission: 'forum' });
  channels = await list;
  assert.ok(channels, 'the channel list reports is_forum after the toggle');

  A.emit('enter-channel', { code });
  await wait(200);

  // Three topics, then a reply to the first one after the clock has ticked over
  // (created_at has one second resolution, and equal stamps fall back to id order).
  for (const content of ['topic one', 'topic two', 'topic three']) {
    A.emit('send-message', { code, content });
    await wait(150);
  }
  let h = await history(A, code);
  assert.ok(h, 'history arrived');
  assert.deepStrictEqual(h.messages.map((m) => m.content), ['topic one', 'topic two', 'topic three'], 'no replies yet: creation order');
  const [one, two, three] = h.messages;

  await wait(1100);
  await new Promise((res) => A.emit('send-thread-message', { parentId: one.id, content: 'a reply' }, res));

  await t.test('a reply bumps its topic to the newest end', async () => {
    h = await history(A, code);
    assert.deepStrictEqual(h.messages.map((m) => m.content), ['topic two', 'topic three', 'topic one']);
    const bumped = h.messages[2];
    assert.strictEqual(bumped.thread && bumped.thread.count, 1, 'the topic carries its reply count');
  });

  await t.test('pagination cursors follow activity order', async () => {
    // "Older than topic one" now means everything less recently active than it.
    let page = await history(A, code, { before: one.id });
    assert.deepStrictEqual(page.messages.map((m) => m.id), [two.id, three.id]);
    // Topic two is the least recently active, so nothing is older than it.
    page = await history(A, code, { before: two.id });
    assert.deepStrictEqual(page.messages, []);
    // And "newer than topic three" is just the bumped topic.
    page = await history(A, code, { after: three.id });
    assert.deepStrictEqual(page.messages.map((m) => m.id), [one.id]);
  });

  await t.test('turning forum mode off restores creation order', async () => {
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 0));
    A.emit('toggle-channel-permission', { code, permission: 'forum' });
    assert.ok(await list, 'the channel list reports the flag cleared');
    h = await history(A, code);
    assert.deepStrictEqual(h.messages.map((m) => m.content), ['topic one', 'topic two', 'topic three']);
  });

  A.close();
});
