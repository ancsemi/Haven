/**
 * Voice relay (Large Server Setup).
 *
 * Turns the built-in relay on through voice-relay-save, has two people join a
 * call, sends one person's mic through the relay and receives it on the other
 * side, using mediasoup-client's fake handler in place of a browser. Checks
 * the guards along the way: only the admin changes the relay, only people in
 * the call use it, screen tracks need a screen share, and turning the relay
 * off moves the call to direct connections.
 *
 * Needs mediasoup-client (a dev dependency) and mediasoup, which servers
 * install on demand from Large Server Setup rather than with Haven. Skipped
 * without it; to run it:
 *
 *   npm install --no-save mediasoup@3.27.1
 *   node --test test/voiceRelay.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

let mediasoupClient = null, FakeHandler = null, fakeParameters = null, FakeMediaStreamTrack = null;
let haveRelay = false;
try {
  require.resolve('mediasoup');
  mediasoupClient = require('mediasoup-client');
  ({ FakeHandler } = require('mediasoup-client/handlers/FakeHandler'));
  fakeParameters = require('mediasoup-client/fakeParameters');
  ({ FakeMediaStreamTrack } = require('fake-mediastreamtrack'));
  haveRelay = true;
} catch { /* skipped below */ }

const PORT = 3401;
const RELAY_PORT = 40400;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-voice-relay-${Date.now()}`);
let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'relay-test-12345', eulaVersion: '2.0', ageVerified: true });
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 5000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
const ask = (sock, event, data) => new Promise((res) => sock.emit(event, data, res));

// A browser-less relay session: device, the two transports wired to the socket.
async function relaySession(sock, code) {
  const joined = await ask(sock, 'relay:join', { code });
  assert.ok(joined.ok, `relay:join: ${joined.error}`);
  const device = new mediasoupClient.Device({ handlerFactory: FakeHandler.createFactory(fakeParameters) });
  await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
  const wire = (t) => t.on('connect', ({ dtlsParameters }, done, fail) => {
    ask(sock, 'relay:connect', { code, transportId: t.id, dtlsParameters }).then(r => r.ok ? done() : fail(new Error(r.error)));
  });
  const send = device.createSendTransport(joined.send);
  const recv = device.createRecvTransport(joined.recv);
  wire(send); wire(recv);
  send.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
    ask(sock, 'relay:produce', { code, transportId: send.id, kind, rtpParameters, source: appData.source })
      .then(r => r.ok ? done({ id: r.producerId }) : fail(new Error(r.error)));
  });
  return { device, send, recv };
}

test.before(async () => {
  if (!haveRelay) return;
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

test('a call goes through the voice relay once the admin turns it on', { skip: !haveRelay && 'mediasoup not installed' }, async () => {
  const admin = await register('admin');
  const bob = await register('bob');
  assert.ok(admin.token && bob.token, 'both registered');
  const A = await connect(admin.token);
  const B = await connect(bob.token);

  // Only the admin changes the relay, and the values are checked.
  const refused = await ask(B, 'voice-relay-save', { mode: 'builtin', port: String(RELAY_PORT), workers: '1', address: '127.0.0.1' });
  assert.ok(refused.error, 'a member cannot turn the relay on');
  const badPort = await ask(A, 'voice-relay-save', { mode: 'builtin', port: '80', workers: '1', address: '' });
  assert.match(badPort.error || '', /port/i, 'a port below 1024 is refused');
  const saved = await ask(A, 'voice-relay-save', { mode: 'builtin', port: String(RELAY_PORT), workers: '1', address: '127.0.0.1' });
  assert.ok(saved.ok, `saved: ${saved.error}`);
  assert.strictEqual(saved.status.state, 'running');
  assert.deepStrictEqual(saved.status.ports, [RELAY_PORT]);

  const made = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'hall'));
  A.emit('create-channel', { name: 'hall' });
  const code = (await made).find((c) => c.name === 'hall').code;
  B.emit('join-channel', { code });
  await wait(300);

  // Not in the call yet: no relay.
  const early = await ask(B, 'relay:join', { code });
  assert.match(early.error || '', /Not in a relayed call/, 'the relay is only for people in the call');

  const aJoined = next(A, 'voice-existing-users', (d) => d.channelCode === code);
  A.emit('voice-join', { code, relay: 1 });
  assert.strictEqual((await aJoined).transport, 'relay', 'a new call goes through the relay');
  const bJoined = next(B, 'voice-existing-users', (d) => d.channelCode === code);
  B.emit('voice-join', { code, relay: 1 });
  const bList = await bJoined;
  assert.strictEqual(bList.transport, 'relay');
  assert.strictEqual(bList.users.find(u => u.username === 'admin')?.relayCapable, true, 'the roster says who can use the relay');

  // Admin sends a mic track; Bob hears about it and receives it.
  const aSession = await relaySession(A, code);
  const bSession = await relaySession(B, code);
  const announced = next(B, 'relay:new-producer', (d) => d.channelCode === code);
  const track = new FakeMediaStreamTrack({ kind: 'audio' });
  const producer = await aSession.send.produce({ track, appData: { source: 'mic' } });
  const news = await announced;
  assert.ok(news, 'the call is told about the new track');
  assert.strictEqual(news.source, 'mic');
  assert.strictEqual(news.producerId, producer.id);

  const listed = await ask(B, 'relay:producers', { code });
  assert.ok(listed.ok && listed.producers.some(p => p.producerId === producer.id), 'the track is listed');
  const got = await ask(B, 'relay:consume', { code, producerId: producer.id, rtpCapabilities: bSession.device.rtpCapabilities });
  assert.ok(got.ok, `consume: ${got.error}`);
  const consumer = await bSession.recv.consume({ id: got.consumer.id, producerId: producer.id, kind: got.consumer.kind, rtpParameters: got.consumer.rtpParameters });
  assert.strictEqual(consumer.kind, 'audio');
  assert.ok((await ask(B, 'relay:resume', { code, consumerId: got.consumer.id })).ok, 'resumed');

  // Asking for the same track again gets the same consumer, not another copy.
  const twice = await ask(B, 'relay:consume', { code, producerId: producer.id, rtpCapabilities: bSession.device.rtpCapabilities });
  assert.strictEqual(twice.consumer?.id, got.consumer.id, 'one consumer per track');

  // A screen track needs a screen share first, and each source carries its own kind.
  const screen = await ask(A, 'relay:produce', { code, transportId: aSession.send.id, kind: 'video', rtpParameters: {}, source: 'screen' });
  assert.match(screen.error || '', /screen share/i);
  const wrongKind = await ask(A, 'relay:produce', { code, transportId: aSession.send.id, kind: 'video', rtpParameters: {}, source: 'screen-audio' });
  assert.match(wrongKind.error || '', /Bad request/, 'screen audio must be audio');

  // Kicked from voice: their tracks stop for everyone and the relay drops them.
  const bobTrack = await bSession.send.produce({ track: new FakeMediaStreamTrack({ kind: 'audio' }), appData: { source: 'mic' } });
  const bobClosed = next(A, 'relay:producer-closed', (d) => d.producerId === bobTrack.id);
  A.emit('voice-kick', { code, userId: bob.user.id });
  assert.ok(await bobClosed, 'a kicked person stops being heard');
  const afterKick = await ask(B, 'relay:producers', { code });
  assert.ok(afterKick.error, 'and can no longer use the relay');
  const bBack = next(B, 'voice-existing-users', (d) => d.channelCode === code);
  B.emit('voice-join', { code, relay: 1 });
  assert.ok(await bBack, 'rejoined after the kick');
  await relaySession(B, code);

  // Leaving stops the admin's tracks for everyone else.
  const closed = next(B, 'relay:producer-closed', (d) => d.producerId === producer.id);
  A.emit('voice-leave', { code });
  assert.ok(await closed, 'the call is told the track stopped');

  // Turning the relay off moves the call still going to direct connections.
  const ended = next(B, 'relay:ended', (d) => d.channelCode === code);
  const off = await ask(A, 'voice-relay-save', { mode: 'off', port: String(RELAY_PORT), workers: '1', address: '127.0.0.1' });
  assert.ok(off.ok, `turned off: ${off.error}`);
  assert.ok(await ended, 'the call is told to carry on directly');
  const after = await ask(B, 'relay:join', { code });
  assert.ok(after.error, 'no relay once it is off');

  A.disconnect(); B.disconnect();
});
