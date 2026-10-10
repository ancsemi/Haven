/**
 * New accounts wait before posting (#5742): an Auto-Mod setting that holds
 * back every kind of post from an account younger than N minutes, with
 * admins, members at the exempt role level and DMs with yourself let through.
 *
 * Boots its own Haven server on a scratch port and data dir.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');

const PORT = 3437;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-postwait-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const register = (username) => post('/api/auth/register', { username, password: 'waittest123', eulaVersion: '2.0', ageVerified: true });
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

// Write straight to the server's database: the only way to age an account.
function sql(statement, ...args) {
  const db = new Database(path.join(DATA, 'haven.db'), { fileMustExist: true });
  try { return db.prepare(statement).run(...args); } finally { db.close(); }
}

// Emit a post and report what came back first: the refusal, or the post
// arriving for everyone ('posted').
function attempt(sock, event, payload, arrived) {
  return new Promise((res) => {
    const done = (out) => {
      clearTimeout(timer);
      sock.off('new-account-wait', onRefused);
      sock.off(arrived.event, onPosted);
      res(out);
    };
    const onRefused = (d) => done({ refused: d });
    const onPosted = (d) => { if (arrived.filter(d)) done({ posted: d }); };
    const timer = setTimeout(() => done({}), 3000);
    sock.on('new-account-wait', onRefused);
    sock.on(arrived.event, onPosted);
    sock.emit(event, payload);
  });
}

async function setSetting(A, key, value) {
  A.emit('update-server-setting', { key, value });
  await wait(250);
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

test('new accounts wait before posting', async (t) => {
  const admin = await register('admin');
  const newbie = await register('newbie');
  const oldie = await register('oldie');
  assert.ok(admin.token && newbie.token && oldie.token, 'accounts registered');
  sql("UPDATE users SET created_at = datetime('now', '-2 hours') WHERE id = ?", oldie.user.id);

  const A = await connect(admin.token);
  let N = await connect(newbie.token);
  const O = await connect(oldie.token);

  const list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lounge'));
  A.emit('create-channel', { name: 'lounge' });
  const code = (await list).find((c) => c.name === 'lounge').code;
  A.emit('enter-channel', { code });
  for (const s of [N, O]) { s.emit('join-channel', { code }); await wait(150); s.emit('enter-channel', { code }); }
  await wait(300);

  const inLounge = (text) => ({ event: 'new-message', filter: (d) => d && d.channelCode === code && d.message && d.message.content === text });
  const say = (sock, text) => attempt(sock, 'send-message', { code, content: text }, inLounge(text));

  // The parent of the thread replies below.
  const parent = await say(A, 'parent message');
  assert.ok(parent.posted, 'admin posted the thread parent');
  const parentId = parent.posted.message.id;

  await t.test('0 means off', async () => {
    await setSetting(A, 'automod_new_account_post_minutes', '0');
    assert.ok((await say(N, 'hello while off')).posted, 'a brand new account posts freely');
  });

  await setSetting(A, 'automod_new_account_post_minutes', '30');

  await t.test('a young account is refused everywhere it could post', async () => {
    const msg = await say(N, 'too soon');
    assert.ok(msg.refused, 'channel message refused');
    assert.ok(msg.refused.minutes >= 29 && msg.refused.minutes <= 30, `tells how long is left (${msg.refused.minutes})`);
    assert.match(msg.refused.message, /New accounts can post in \d+ minutes/);

    const reply = await attempt(N, 'send-thread-message', { parentId, content: 'early reply' },
      { event: 'new-thread-message', filter: (d) => d && d.message && d.message.content === 'early reply' });
    assert.ok(reply.refused, 'thread reply refused');

    const poll = await attempt(N, 'create-poll', { question: 'early poll?', options: ['a', 'b'] },
      { event: 'new-message', filter: (d) => d && d.message && /early poll/.test(d.message.content) });
    assert.ok(poll.refused, 'poll refused');

    const scheduled = await new Promise((res) => N.emit('schedule-message', { code, content: 'later', sendAt: new Date(Date.now() + 3600000).toISOString() }, res));
    assert.ok(scheduled && scheduled.error && scheduled.newAccountWait > 0, 'scheduling refused');

    // Starting a new DM with someone else waits too: the conversation would
    // otherwise land in their DM list.
    const dmWait = next(N, 'new-account-wait');
    N.emit('start-dm', { targetUserId: admin.user.id });
    const held = await dmWait;
    assert.ok(held && held.minutes > 0, 'starting a DM with someone else refused');
  });

  await t.test('a DM with yourself is not held back', async () => {
    const opened = next(N, 'dm-opened', (d) => d && d.is_self_dm);
    N.emit('start-dm', { targetUserId: newbie.user.id });
    const self = await opened;
    assert.ok(self && self.code, 'notes-to-self DM opened');
    const note = await attempt(N, 'send-message', { code: self.code, content: 'note to self' },
      { event: 'new-message', filter: (d) => d && d.channelCode === self.code });
    assert.ok(note.posted, 'note posted');
  });

  await t.test('admins and older accounts are not held back', async () => {
    assert.ok((await say(A, 'admin talks')).posted, 'admin posts');
    assert.ok((await say(O, 'oldie talks')).posted, 'a two hour old account posts');
  });

  await t.test('members at the exempt level are not held back', async () => {
    await setSetting(A, 'automod_link_exempt_level', '0');
    assert.ok((await say(N, 'exempt now')).posted, 'exempt member posts');
    await setSetting(A, 'automod_link_exempt_level', '50');
    assert.ok((await say(N, 'not exempt again')).refused, 'refused again once the level is back');
  });

  await t.test('out of range values are not saved', async () => {
    await setSetting(A, 'automod_new_account_post_minutes', '10081');
    await setSetting(A, 'automod_new_account_post_minutes', '-5');
    assert.ok((await say(N, 'still waiting')).refused, 'the 30 minute rule still stands');
  });

  await t.test('once the time has passed the account posts', async () => {
    sql("UPDATE users SET created_at = datetime('now', '-31 minutes') WHERE id = ?", newbie.user.id);
    N.close();
    N = await connect(newbie.token);
    N.emit('enter-channel', { code });
    await wait(200);
    assert.ok((await say(N, 'finally')).posted, 'posts after the wait');
  });

  for (const s of [A, N, O]) s.close();
});
