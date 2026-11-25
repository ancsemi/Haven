/**
 * Links to thread replies (and to replies in forum topics). A thread reply
 * never shows in its channel, but get-messages with `around` = a reply used
 * to hand the reply back as if it were a channel message, among the channel
 * messages around its id. The server now centres the window on the reply's
 * thread parent and names the reply in `threadReply`, so the client can open
 * the thread at it.
 *
 * Needs a running Haven server. Boots one on a scratch port and data dir:
 *   node --test test/threadReplyLinks.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3441;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-threadlinks-${Date.now()}`);

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

async function makeChannel(A, name, forum) {
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
  A.emit('create-channel', { name });
  const code = (await list).find((c) => c.name === name).code;
  if (forum) {
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 1));
    A.emit('toggle-channel-permission', { code, permission: 'forum' });
    assert.ok(await list, 'forum mode on');
  }
  A.emit('enter-channel', { code });
  await wait(150);
  return code;
}

async function send(A, code, content) {
  const got = next(A, 'new-message', (d) => d && d.channelCode === code && d.message && d.message.content === content);
  A.emit('send-message', { code, content });
  return (await got).message.id;
}

async function reply(A, parentId, content) {
  await new Promise((res) => A.emit('send-thread-message', { parentId, content }, res));
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
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

test('a link to a thread reply is placed in its thread', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'threadlinks123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  const code = await makeChannel(A, 'general', false);
  const before = await send(A, code, 'before the thread');
  const parent = await send(A, code, 'thread parent');
  await reply(A, parent, 'first reply');
  await reply(A, parent, 'the linked reply');
  const after = await send(A, code, 'after the thread');
  const thread = await new Promise((res) => {
    A.once('thread-messages', res);
    A.emit('get-thread-messages', { parentId: parent });
  });
  const linked = thread.messages.find((m) => m.content === 'the linked reply').id;

  await t.test('around a thread reply: the window centres on its parent', async () => {
    const h = await history(A, code, { around: linked });
    assert.deepStrictEqual(h.threadReply, { parentId: parent, messageId: linked });
    assert.strictEqual(h.around, parent, 'around names the message the window is centred on');
    assert.deepStrictEqual(h.messages.map((m) => m.id), [before, parent, after]);
    assert.ok(!h.messages.some((m) => m.id === linked), 'the reply is not drawn as a channel message');
  });

  await t.test('around a channel message: unchanged, no threadReply', async () => {
    const h = await history(A, code, { around: before });
    assert.strictEqual(h.around, before);
    assert.strictEqual(h.threadReply, undefined);
    assert.ok(h.messages.some((m) => m.id === before));
  });

  await t.test('a reply id from another channel is not looked up', async () => {
    const other = await makeChannel(A, 'other', false);
    const h = await history(A, other, { around: linked });
    assert.strictEqual(h.threadReply, undefined);
    assert.strictEqual(h.around, linked);
  });

  await t.test('around a reply in a forum topic: the topic comes back, the reply is named', async () => {
    const forum = await makeChannel(A, 'ideas', true);
    const topic = await send(A, forum, 'a topic');
    await reply(A, topic, 'forum reply one');
    await reply(A, topic, 'the linked forum reply');
    const tm = await new Promise((res) => {
      A.once('thread-messages', res);
      A.emit('get-thread-messages', { parentId: topic });
    });
    const forumReply = tm.messages.find((m) => m.content === 'the linked forum reply').id;
    let h = await history(A, forum, { around: forumReply });
    assert.deepStrictEqual(h.threadReply, { parentId: topic, messageId: forumReply });
    assert.strictEqual(h.around, topic);
    assert.deepStrictEqual(h.messages.map((m) => m.id), [topic]);
    h = await history(A, forum, { around: topic });
    assert.strictEqual(h.threadReply, undefined, 'a topic is not a reply');
    assert.deepStrictEqual(h.messages.map((m) => m.id), [topic]);
  });

  A.close();
});
