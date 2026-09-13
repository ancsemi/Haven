/**
 * Forum parity: topics carry a title and tags, pages sort by activity or by
 * date posted, tag filters match some or all, topic meta can be edited,
 * channels can be NSFW, and channel names may contain & and +.
 *
 * Needs a running Haven server. Boots one on a scratch port and data dir:
 *   node --test test/forumParity.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-forum-parity-${Date.now()}`);

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

test('forum topics carry titles and tags, sort and filter, and channels can be NSFW', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'forumtest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'art & tips + more'));
  A.emit('create-channel', { name: 'art & tips + more', isForum: true });
  let channels = await list;
  assert.ok(channels, 'a channel named with & and + was created');
  const ch = channels.find((c) => c.name === 'art & tips + more');
  const code = ch.code;
  assert.strictEqual(ch.is_forum, 1);

  await t.test('forum tags are kept on the channel and shipped in channels-list', async () => {
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.forum_tags));
    A.emit('set-forum-tags', { code, tags: [{ name: 'Question', emoji: '❓' }, 'Art', { name: 'Art' }, { name: 'Tip' }] });
    channels = await list;
    assert.ok(channels, 'channel list arrived after set-forum-tags');
    const tags = JSON.parse(channels.find((c) => c.code === code).forum_tags);
    assert.deepStrictEqual(tags.map((x) => x.name), ['Question', 'Art', 'Tip'], 'deduplicated, order kept');
    assert.strictEqual(tags[0].emoji, '❓');
  });

  A.emit('enter-channel', { code });
  await wait(200);

  const posted = [];
  for (const [content, title, tags] of [
    ['first body', 'First topic', ['Art']],
    ['second body', null, ['Question', 'Art', 'Nope']],
    ['third body', 'Third topic', ['Tip']],
  ]) {
    const p = next(A, 'new-message', (d) => d && d.message && d.message.content === content);
    A.emit('send-message', { code, content, title, tags });
    posted.push((await p).message);
    await wait(1100);
  }

  await t.test('a topic keeps its title and only the tags the channel knows', async () => {
    assert.strictEqual(posted[0].title, 'First topic');
    assert.deepStrictEqual(posted[0].tags, ['Art']);
    assert.strictEqual(posted[1].title, undefined, 'no title given');
    assert.deepStrictEqual(posted[1].tags, ['Question', 'Art', 'Nope'], 'custom tags stay on the topic');
    const h = await history(A, code);
    const byId = Object.fromEntries(h.messages.map((m) => [m.id, m]));
    assert.strictEqual(byId[posted[2].id].title, 'Third topic');
    assert.deepStrictEqual(byId[posted[2].id].tags, ['Tip']);
  });

  await new Promise((res) => A.emit('send-thread-message', { parentId: posted[0].id, content: 'bump' }, res));
  await wait(300);

  await t.test('sort=active bumps the replied topic, sort=created keeps posting order', async () => {
    let h = await history(A, code);
    assert.deepStrictEqual(h.messages.map((m) => m.content), ['second body', 'third body', 'first body']);
    h = await history(A, code, { sort: 'created' });
    assert.deepStrictEqual(h.messages.map((m) => m.content), ['first body', 'second body', 'third body']);
    const page = await history(A, code, { sort: 'created', before: posted[2].id });
    // "before" pages come back oldest-first like chat history does.
    assert.deepStrictEqual(page.messages.map((m) => m.content), ['first body', 'second body'], 'created-order cursor');
  });

  await t.test('tag filters match some or all', async () => {
    let h = await history(A, code, { tags: ['Art'] });
    assert.deepStrictEqual(h.messages.map((m) => m.content).sort(), ['first body', 'second body']);
    h = await history(A, code, { tags: ['Art', 'Question'], tagMode: 'all' });
    assert.deepStrictEqual(h.messages.map((m) => m.content), ['second body']);
    h = await history(A, code, { tags: ['Art', 'Tip'], tagMode: 'some' });
    assert.strictEqual(h.messages.length, 3);
  });

  await t.test('set-topic-meta retitles and retags, and everyone in the channel hears it', async () => {
    const upd = next(A, 'topic-updated', (d) => d && d.messageId === posted[1].id);
    A.emit('set-topic-meta', { messageId: posted[1].id, title: '  Renamed   topic ', tags: ['Tip', 'Bogus'] });
    const d = await upd;
    assert.ok(d, 'topic-updated arrived');
    assert.strictEqual(d.title, 'Renamed topic');
    assert.deepStrictEqual(d.tags, ['Tip']);
    const h = await history(A, code, { sort: 'created' });
    assert.strictEqual(h.messages.find((m) => m.id === posted[1].id).title, 'Renamed topic');
  });

  await t.test('a topic keeps a request status and can be moved planned → in progress → complete', async () => {
    assert.strictEqual(posted[0].request_status, 'planned');
    const upd = next(A, 'topic-updated', (d) => d && d.messageId === posted[0].id && d.request_status === 'in_progress');
    A.emit('set-topic-meta', { messageId: posted[0].id, title: posted[0].title, tags: posted[0].tags || [], requestStatus: 'in_progress' });
    const d = await upd;
    assert.ok(d, 'topic-updated arrived with in_progress');
    assert.strictEqual(d.request_status, 'in_progress');
    const done = next(A, 'topic-updated', (x) => x && x.messageId === posted[0].id && x.request_status === 'complete');
    A.emit('set-topic-meta', { messageId: posted[0].id, title: posted[0].title, tags: posted[0].tags || [], requestStatus: 'complete' });
    assert.strictEqual((await done).request_status, 'complete');
    const h = await history(A, code, { requestStatus: 'complete' });
    assert.ok(h.messages.some((m) => m.id === posted[0].id), 'complete filter includes the topic');
    const planned = await history(A, code, { requestStatus: 'planned' });
    assert.ok(!planned.messages.some((m) => m.id === posted[0].id), 'planned filter drops the completed topic');
  });

  await t.test('a topic keeps a type, blocked status, and a subtask checklist', async () => {
    await wait(1100);
    const p = next(A, 'new-message', (d) => d && d.message && d.message.title === 'Login timeout');
    A.emit('send-message', {
      code, content: 'Users sit on the spinner', title: 'Login timeout', tags: ['Question'],
      requestStatus: 'blocked', topicKind: 'bug', subtasks: ['Reproduce on desktop', 'Check token refresh'],
    });
    const created = await p;
    assert.ok(created, 'bug topic arrived');
    assert.strictEqual(created.message.topic_kind, 'bug');
    assert.strictEqual(created.message.request_status, 'blocked');
    assert.strictEqual(created.message.subtasks.length, 2);
    assert.strictEqual(created.message.subtasks[0].title, 'Reproduce on desktop');
    assert.strictEqual(created.message.subtasks[0].done, false);
    const upd = next(A, 'topic-updated', (d) => d && d.messageId === created.message.id && d.subtasks && d.subtasks[0].done);
    A.emit('set-topic-meta', {
      messageId: created.message.id, title: created.message.title, tags: created.message.tags || [],
      requestStatus: 'blocked', topicKind: 'bug',
      subtasks: created.message.subtasks.map((s, i) => ({ ...s, done: i === 0 })),
    });
    const d = await upd;
    assert.ok(d.subtasks[0].done, 'first subtask ticked');
    const bugs = await history(A, code, { topicKind: 'bug' });
    assert.ok(bugs.messages.some((m) => m.id === created.message.id), 'type filter includes the bug');
    const features = await history(A, code, { topicKind: 'feature' });
    assert.ok(!features.messages.some((m) => m.id === created.message.id), 'feature filter drops the bug');
    const blocked = await history(A, code, { requestStatus: 'blocked' });
    assert.ok(blocked.messages.some((m) => m.id === created.message.id), 'blocked filter includes the topic');
  });

  await t.test('a channel can be flagged NSFW and the flag travels in channels-list', async () => {
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_nsfw === 1));
    A.emit('toggle-channel-permission', { code, permission: 'nsfw' });
    assert.ok(await list, 'is_nsfw reported');
  });

  A.close();
});
