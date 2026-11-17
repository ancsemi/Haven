'use strict';

// Shared by the socket access tests: boot a throwaway server on a scratch
// port and data dir, register accounts, connect sockets and wait for events.
// Loading this file on its own does nothing.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createHarness(port, name) {
  const BASE = `http://localhost:${port}`;
  const DATA = path.join(os.tmpdir(), `haven-${name}-${Date.now()}`);
  const sockets = [];
  let server;

  const post = (p, body) => new Promise((res, rej) => {
    const d = JSON.stringify(body);
    const r = http.request({ host: 'localhost', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
    r.on('error', rej); r.write(d); r.end();
  });

  async function start() {
    fs.mkdirSync(DATA, { recursive: true });
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try {
        await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
        return;
      } catch { await wait(500); }
    }
    throw new Error('server did not start');
  }

  // Waits for the server to exit before removing its data folder: Windows
  // will not delete files a running process still holds open, which left a
  // test folder behind in the temp directory on every run.
  async function stop() {
    for (const s of sockets) s.close();
    if (server && server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill();
      await exited;
    }
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn('could not remove test data:', err.message); }
  }

  async function register(username) {
    const r = await post('/api/auth/register', { username, password: 'access12345', eulaVersion: '2.0', ageVerified: true });
    if (!r.token) throw new Error(`register ${username} failed: ${JSON.stringify(r)}`);
    return { token: r.token, id: r.user.id };
  }

  // `options.auth` is merged into the handshake (a per-tab id, for example).
  // Reconnection stays on unless a test asks to keep a kicked socket down.
  function connect(token, options = {}) {
    const s = io(BASE, {
      auth: Object.assign({ token }, options.auth),
      transports: ['websocket'],
      forceNew: true,
      reconnection: options.reconnection !== false,
    });
    sockets.push(s);
    return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
  }

  // The next matching event, or null after `ms`.
  function next(sock, event, filter = () => true, ms = 3000) {
    return new Promise((res) => {
      const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
      const h = (...args) => { if (!filter(...args)) return; clearTimeout(t); sock.off(event, h); res(args.length > 1 ? args : args[0]); };
      sock.on(event, h);
    });
  }

  // Emit with an acknowledgement callback.
  const ask = (sock, event, data, ms = 3000) => new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    sock.emit(event, data, (reply) => { clearTimeout(t); res(reply); });
  });

  // Every channel the socket's user can see, by name.
  async function channels(sock) {
    const list = next(sock, 'channels-list');
    sock.emit('get-channels');
    return (await list) || [];
  }

  return { start, stop, register, connect, next, ask, channels, post, dataDir: DATA };
}

module.exports = { createHarness, wait };
