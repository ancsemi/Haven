/**
 * Channel types (src/channelTypes.js): a saved set of Channel Functions with a
 * sidebar icon. Setting a channel's type gives it those functions, editing the
 * type updates its channels, changing a function by hand unlinks the channel,
 * and deleting the type leaves the functions alone.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/channelTypes.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const types = require('../src/channelTypes');

const PORT = 3517;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-channel-types-${Date.now()}`);
let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'channel-types-test-123', eulaVersion: '2.0', ageVerified: true });
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
const ask = (s, ev, data) => new Promise((res) => s.timeout(5000).emit(ev, data, (err, r) => res(err ? { error: 'timeout' } : r)));
async function channel(s, name) {
  for (let i = 0; i < 20; i++) {
    const list = await new Promise((res) => { s.once('channels-list', res); s.emit('get-channels'); });
    const ch = list.find(c => c.name === name);
    if (ch) return ch;
    await wait(150);
  }
  return null;
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'boss', FORCE_HTTP: 'true' },
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

test('normalizeType trims, limits and keeps voice-only functions off without voice', () => {
  assert.match(types.normalizeType({ name: ' ', icon: '🎧' }).error, /name/);
  assert.match(types.normalizeType({ name: 'x', icon: '' }).error, /icon/);
  assert.match(types.normalizeType({ name: 'x', icon: 'a'.repeat(13) }).error, /at most/);
  const t = types.normalizeType({ name: '  Hang   out ', icon: '🎧', functions: { voice: 0, music: 1, streams: 1, text: 1 } });
  assert.strictEqual(t.name, 'Hang out');
  assert.deepStrictEqual(t.functions, { text: 1, media: 0, reactions: 0, read_only: 0, voice: 0, streams: 0, music: 0, soundboard: 0 });
});

test('a type sets, follows edits, unlinks on a hand change, and deleting keeps the functions', async () => {
  const boss = await register('boss');
  const member = await register('member');
  const A = await connect(boss.token);
  const M = await connect(member.token);

  const start = await ask(A, 'get-channel-types', {});
  assert.deepStrictEqual(start.types.map(t => t.name), ['Voice only', 'Text only', 'Announcements'], 'three to start from');

  A.emit('create-channel', { name: 'hangout' });
  let ch = await channel(A, 'hangout');
  assert.ok(ch, 'channel made');

  const made = await ask(A, 'save-channel-type', { name: 'Hangout', icon: '🎧', functions: { voice: 1, music: 1, text: 0, media: 0 } });
  assert.ok(made.ok, JSON.stringify(made));
  assert.deepStrictEqual((await ask(M, 'save-channel-type', { name: 'Nope', icon: '❌' })).error.includes('Manage Server'), true, 'members cannot make types');

  assert.ok((await ask(A, 'set-channel-type', { code: ch.code, typeId: made.type.id })).ok);
  ch = await channel(A, 'hangout');
  assert.strictEqual(ch.type_id, made.type.id);
  assert.strictEqual(ch.text_enabled, 0);
  assert.strictEqual(ch.media_enabled, 0);
  assert.strictEqual(ch.voice_enabled, 1);
  assert.strictEqual(ch.streams_enabled, 0, 'screen share off, as the type says');
  assert.strictEqual(ch.music_enabled, 1);

  // Editing the type changes the channel too.
  assert.ok((await ask(A, 'save-channel-type', { id: made.type.id, name: 'Hangout', icon: '🎧', functions: { voice: 1, music: 1, streams: 1, text: 1 } })).ok);
  ch = await channel(A, 'hangout');
  assert.strictEqual(ch.text_enabled, 1);
  assert.strictEqual(ch.streams_enabled, 1);
  assert.strictEqual(ch.type_id, made.type.id);

  // A function changed by hand takes the channel out of its type.
  A.emit('toggle-channel-permission', { code: ch.code, permission: 'text' });
  await wait(300);
  ch = await channel(A, 'hangout');
  assert.strictEqual(ch.text_enabled, 0);
  assert.strictEqual(ch.type_id, null);

  // Deleting a type unlinks its channels and leaves their functions as they are.
  assert.ok((await ask(A, 'set-channel-type', { code: ch.code, typeId: made.type.id })).ok);
  assert.ok((await ask(A, 'delete-channel-type', { id: made.type.id })).ok);
  ch = await channel(A, 'hangout');
  assert.strictEqual(ch.type_id, null);
  assert.strictEqual(ch.text_enabled, 1);
  assert.strictEqual(ch.music_enabled, 1);

  assert.match((await ask(M, 'set-channel-type', { code: ch.code, typeId: null })).error, /permission/, 'members cannot set a type');
  A.disconnect(); M.disconnect();
});
