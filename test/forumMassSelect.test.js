'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const css = require('./coreCss').readCoreCss();

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const forum = read('public/js/modules/app-forum.js');
const tools = read('public/js/modules/app-message-tools.js');
const html = read('public/app.html');
const en = JSON.parse(read('public/locales/en.json'));
const PORT = 3414;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-forum-mass-select-${Date.now()}`);
let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (token) => new Promise((res, rej) => {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const next = (sock, event, filter = () => true, ms = 4000) => new Promise((res) => {
  const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
  const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
  sock.on(event, h);
});
const ask = (sock, event, data) => new Promise((res) => sock.emit(event, data, res));
const history = (sock, code) => {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code });
  return p;
};

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej)); return; } catch { await wait(500); }
  }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

test('several forum topics move to another forum and are deleted in one go, replies included', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'forumtest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);
  const made = async (name) => {
    const l = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
    A.emit('create-channel', { name, isForum: true });
    return (await l).find((c) => c.name === name).code;
  };
  const from = await made('notes');
  const to = await made('archive');
  A.emit('enter-channel', { code: from });
  await wait(200);
  const topics = [];
  for (const n of [1, 2, 3, 4]) {
    const p = next(A, 'new-message', (d) => d && d.message && d.message.content === `body ${n}`);
    A.emit('send-message', { code: from, content: `body ${n}`, title: `Note ${n}` });
    topics.push((await p).message);
  }
  const reply = next(A, 'new-thread-message', (d) => d && d.message && d.message.content === 'a reply');
  A.emit('send-thread-message', { parentId: topics[0].id, content: 'a reply' });
  assert.ok(await reply, 'reply posted under the first topic');

  const moved = await ask(A, 'move-messages', { messageIds: [topics[0].id, topics[1].id], fromChannel: from, toChannel: to });
  assert.strictEqual(moved.success, true);
  assert.strictEqual(moved.moved, 2);
  assert.strictEqual(moved.brought, 1, 'the reply came along');
  let h = await history(A, from);
  assert.deepStrictEqual(h.messages.filter((m) => !m.thread_id).map((m) => m.title).sort(), ['Note 3', 'Note 4']);
  A.emit('enter-channel', { code: to });
  h = await history(A, to);
  assert.deepStrictEqual(h.messages.filter((m) => !m.thread_id).map((m) => m.title).sort(), ['Note 1', 'Note 2']);

  const gone = await ask(A, 'delete-messages', { code: from, messageIds: [topics[2].id, topics[3].id] });
  assert.strictEqual(gone.success, true);
  assert.strictEqual(gone.deleted, 2);
  A.emit('enter-channel', { code: from });
  h = await history(A, from);
  assert.strictEqual(h.messages.length, 0);
  A.close();
});

test('the forum has its own way into selection mode, on the toolbar and in the topic menu', () => {
  assert.match(forum, /_forumCanSelect\(\) \{ return !!\(this\.user\?\.isAdmin \|\| this\._canModerate\?\.\(\)\); \}/);
  assert.match(forum, /id="forum-select-btn"/);
  assert.match(forum, /bar\.querySelector\('#forum-select-btn'\)\?\.addEventListener\('click', \(\) => this\._moveSelectionActive \? this\._exitMoveSelectionMode\(\) : this\._enterMoveSelectionMode\(\)\)/);
  assert.match(forum, /if \(this\._forumCanSelect\(\)\) items\.push\(item\('select'/);
  assert.match(forum, /action === 'select'/);
  assert.match(forum, /this\._enterMoveSelectionMode\(\);\s+card && this\._toggleMoveSelect\(card\);/);
});

test('moving a selection of forum topics offers forums only and closes the selection', () => {
  assert.match(tools, /if \(this\._isForumChannel\?\.\(this\._moveSourceChannel \|\| this\.currentChannel\)\) return this\._forumShowMovePicker\(\[\.\.\.this\._moveSelectedIds\], \(\) => this\._exitMoveSelectionMode\(\)\)/);
  assert.match(forum, /_forumShowMovePicker\(ids, done\)/);
  assert.match(forum, /for \(const ch of this\._forumMoveTargets\(\)\)/);
  assert.match(forum, /_forumShowMovePicker\(\[msg\.id\]\)/);
  assert.match(forum, /done\?\.\(\)/);
});

test('selected topics stay marked across a reload and unseen ones are dropped', () => {
  assert.match(forum, /this\._moveSelectionActive && this\._moveSelectedIds\.has\(msg\.id\) \? ' move-selected' : ''/);
  assert.match(forum, /this\._forumTopics\.has\(id\) \|\| this\._moveSelectedIds\.delete\(id\)/);
  assert.match(forum, /if \(this\._moveSelectionActive && !this\._moveSourceThread\)/);
});

test('Select all sits in the selection toolbar, shows for forums only, and stops at 200', () => {
  assert.match(html, /id="move-msg-all-btn" style="display:none"/);
  assert.match(tools, /document\.getElementById\('move-msg-all-btn'\)\?\.addEventListener\('click', \(\) => this\._forumSelectAll\(\)\)/);
  assert.match(tools, /this\._forumSyncSelectAll\?\.\(\)/);
  assert.match(forum, /this\._moveSelectedIds\.size >= 200\) return this\._showToast/);
  for (const k of ['select', 'select_title', 'select_all', 'select_none', 'move_topics_desc', 'move_topics_done']) assert.ok(en.forum[k], `forum.${k} is in en.json`);
});

test('the selection toolbar wraps inside a phone screen and selected cards show a check', () => {
  assert.match(css, /\.move-msg-toolbar \{[^}]*flex-wrap: wrap;[^}]*max-width: calc\(100vw - 1rem\);/);
  assert.match(css, /\.move-selection-mode \.messages \.forum-topic\.move-selected::after \{ content: '✓';/);
});
