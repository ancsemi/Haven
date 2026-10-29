/**
 * Birthdays.
 *
 * A birthday is set once and can never be changed. Hiding it keeps the date
 * but takes it off the profile and member lists. Other people only ever see
 * the month and day, unless the owner shows the year.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/birthday.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');

const PORT = 3441;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-birthday-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = [];
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  // session-info can arrive immediately after Socket.IO's connect packet,
  // before the promise below resumes and a caller can attach a listener.
  s.firstSessionInfo = new Promise((resolve) => s.once('session-info', resolve));
  s.lists = new Map();
  s.memberLists = 0;
  s.on('online-users', (d) => { s.memberLists++; s.lists.set(d.channelCode, d.users); });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
// Send a birthday change and report what came back: the update, or the error
// text. A bare value is sent as the birthday, an object as the whole request.
function setBirthday(sock, change) {
  return new Promise((res) => {
    const done = (result) => {
      clearTimeout(t);
      sock.off('birthday-updated', onUpdated);
      sock.off('error-msg', onError);
      res(result);
    };
    const onUpdated = (updated) => done({ updated });
    const onError = (error) => done({ error });
    const t = setTimeout(() => done({}), 4000);
    sock.on('birthday-updated', onUpdated);
    sock.on('error-msg', onError);
    sock.emit('set-birthday', change !== null && typeof change === 'object' ? change : { birthday: change });
  });
}
async function profileOf(sock, userId) {
  const reply = next(sock, 'user-profile');
  sock.emit('get-user-profile', { userId });
  return reply;
}
async function mentionListOf(sock, code, userId) {
  const reply = next(sock, 'channel-members');
  sock.emit('get-channel-members', { code });
  return (await reply)?.members.find((m) => m.id === userId);
}
const memberListOf = (sock, code, userId) => (sock.lists.get(code) || []).find((u) => u.id === userId);

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
test.after(() => {
  for (const s of sockets) s.close();
  server?.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* the server may still hold the db open; a leftover temp dir is harmless */ }
});

test('a birthday is set once, hiding keeps the date, and the year shows only when unhidden', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'birthday123', eulaVersion: '2.0', ageVerified: true });
  const ann = await post('/api/auth/register', { username: 'ann', password: 'birthday123', eulaVersion: '2.0', ageVerified: true });
  const bob = await post('/api/auth/register', { username: 'bob', password: 'birthday123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token && ann.token && bob.token, 'all registered');
  const M = await connect(admin.token);
  const made = next(M, 'channels-list');
  M.emit('create-channel', { name: 'party' });
  const code = (await made).find((c) => c.name === 'party').code;
  const A = await connect(ann.token);
  const B = await connect(bob.token);
  for (const s of [A, B]) { s.emit('join-channel', { code }); await wait(100); s.emit('enter-channel', { code }); }
  await wait(1200);
  assert.ok(memberListOf(B, code, ann.user.id), 'ann is in the member list bob sees');

  for (const bad of ['2001-02-30', '1899-12-31', '3000-01-01', '01-02', 42]) {
    assert.ok((await setBirthday(A, bad)).error, `${bad} is refused`);
  }

  const set = await setBirthday(A, '2000-06-15');
  assert.equal(set.updated?.birthday, '2000-06-15');
  assert.ok(set.updated.birthdaySetAt, 'when it was set is kept');
  assert.equal(set.updated.birthdayHidden, false);

  assert.equal((await profileOf(B, ann.user.id)).birthday, '06-15', 'the year stays private');
  await wait(1200);
  assert.equal(memberListOf(B, code, ann.user.id)?.birthday, '06-15', 'the member list carries the day');
  assert.equal((await mentionListOf(B, code, ann.user.id))?.birthday, '06-15', 'so does the mention list');

  assert.match((await setBirthday(A, '2000-06-16')).error || '', /only be set once/, 'a second date is refused');

  const listsBefore = B.memberLists;
  const shown = await setBirthday(A, { birthday: '2000-06-15', hideYear: false });
  assert.equal(shown.updated?.birthdaySetAt, set.updated.birthdaySetAt, 'Hide birth year leaves the date alone');
  assert.equal((await profileOf(B, ann.user.id)).birthday, '2000-06-15', 'the year shows once unhidden');
  await wait(1200);
  assert.equal(B.memberLists, listsBefore, 'member lists carry no year, so they are not resent');

  // Hiding keeps the date for the owner and takes it away from everyone else.
  const hidden = await setBirthday(A, { hidden: true });
  assert.equal(hidden.updated?.birthday, '2000-06-15', 'the date is kept while hidden');
  assert.equal(hidden.updated.birthdayHidden, true);
  assert.equal((await profileOf(B, ann.user.id)).birthday, null, 'a hidden birthday is not on the profile');
  await wait(1200);
  assert.equal(memberListOf(B, code, ann.user.id)?.birthday, null, 'nor in the member list');
  assert.equal((await mentionListOf(B, code, ann.user.id))?.birthday, null, 'nor in the mention list');
  assert.match((await setBirthday(A, { birthday: '2001-01-01', hidden: false })).error || '', /only be set once/, 'hiding does not free the date');

  const A2 = await connect(ann.token);
  const session = await A2.firstSessionInfo;
  assert.equal(session.birthday, '2000-06-15', 'the owner still gets the date on connect');
  assert.equal(session.birthdayHidden, true);
  assert.equal(session.birthdayHideYear, false);
  assert.equal(session.birthdaySetAt, set.updated.birthdaySetAt);
  A2.close();

  const back = await setBirthday(A, { hidden: false });
  assert.equal(back.updated?.birthdayHidden, false);
  assert.equal((await profileOf(B, ann.user.id)).birthday, '2000-06-15', 'showing it brings the same date back');

  // Clients from before hiding existed sent null to unset; that now hides.
  const old = await setBirthday(A, null);
  assert.equal(old.updated?.birthday, '2000-06-15', 'null keeps the date');
  assert.equal(old.updated.birthdayHidden, true, 'null hides it');
  assert.equal((await profileOf(B, ann.user.id)).birthday, null);

  // There is no waiting it out: years later a different date is still refused.
  const db = new Database(path.join(DATA, 'haven.db'));
  db.prepare("UPDATE users SET birthday_set_at = ? WHERE username = 'ann'")
    .run(new Date(Date.now() - 3 * 365 * 86400000).toISOString());
  db.close();
  assert.match((await setBirthday(A, '2000-07-01')).error || '', /only be set once/, 'still refused much later');
  const A3 = await connect(ann.token);
  assert.equal((await A3.firstSessionInfo)?.birthday, '2000-06-15', 'the date never changed');
  A3.close();
});
