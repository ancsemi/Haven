'use strict';

// A phone on a flaky link (mobile data, hairpin NAT) gets its socket
// dropped with "ping timeout" after about a minute. Socket.IO connects
// again and the handshake succeeds, but the open channel stays silent:
// new messages never show up, and the page only recovers on a full reload.
// The channels-list watchdog treats that handshake as healthy, so it never
// reloads. (#5875)
//
//   node --test test/silentReconnect.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createHarness, wait } = require('./socketServerHarness');

const ROOT = path.join(__dirname, '..');
const SOCKET_FILES = ['app-socket.js', 'app-socket-channels.js', 'app-socket-events.js'];

function loadSocketMethods() {
  const methods = {};
  for (const name of SOCKET_FILES) {
    const source = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  }
  return methods;
}

const timers = [];
function setTimeout(fn, ms) {
  const t = { fn, ms, cleared: false };
  timers.push(t);
  return t;
}
function clearTimeout(t) { if (t) t.cleared = true; }
function setInterval() { return {}; }
function clearInterval() {}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  URLSearchParams,
  t: (key) => key,
  localStorage: {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  },
  document: {
    hidden: false,
    hasFocus: () => true,
    addEventListener() {},
    getElementById() {
      return {
        textContent: '',
        className: '',
        style: { display: 'none' },
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
    },
  },
};

function flushTimers() {
  const batch = timers.splice(0, timers.length).filter(t => !t.cleared);
  for (const t of batch) if (!t.cleared) t.fn();
}

function fakeSocket() {
  const handlers = new Map();
  return {
    connected: true,
    handlers,
    emits: [],
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    once(ev, fn) { this.on(ev, fn); },
    off() {},
    emit(ev, data) { this.emits.push({ ev, data }); },
    fire(ev, data) {
      for (const fn of handlers.get(ev) || []) fn(data);
    },
  };
}

function clientApp() {
  timers.length = 0;
  const reloads = [];
  // Installed before the modules are evaluated so their `window` lookup
  // sees this object. Each call gets its own reload list.
  sandbox.window = {
    addEventListener() {},
    location: {
      search: '',
      pathname: '/app',
      reload() { reloads.push(1); },
    },
    history: { replaceState() {} },
  };
  const methods = loadSocketMethods();
  const socket = fakeSocket();
  const app = Object.assign({
    socket,
    user: { id: 7, username: 'ada' },
    channels: [{ id: 1, code: 'abcd1234', name: 'general' }],
    currentChannel: 'abcd1234',
    unreadCounts: {},
    voice: null,
    _setLed() {},
    _startPingMonitor() {},
    _setupFerrySocket() {},
    _renderChannels() {},
    _updateReadOnlyNote() {},
    _updateTabTitle() {},
    _updateDesktopBadge() {},
    _updateDmSectionBadge() {},
    _renderOnlineUsers() {},
    _decryptMessages: async () => {},
    notifications: { play() {}, speak() {} },
  }, methods);
  app.window = sandbox.window = {
    addEventListener() {},
    location: {
      search: '',
      pathname: '/app',
      reload() { reloads.push(Date.now()); },
    },
    history: { replaceState() {} },
  };
  // The module calls the global `window`, which the vm context does not
  // have unless it is installed there. Re-bind by evaluating against the
  // same sandbox the modules already closed over: they look up `window`
  // on the context at call time, so setting sandbox.window is enough.
  methods._listenSession.call(app);
  methods._listenChannelsAndMessages.call(app);
  methods._listenPresenceAndVoice.call(app);
  return { app, socket, reloads };
}

function emitted(socket, ev) {
  return socket.emits.filter(e => e.ev === ev);
}

test('a reconnect whose handshake succeeds but whose channel stays silent reloads', () => {
  const { socket, reloads } = clientApp();
  const before = emitted(socket, 'enter-channel').length;
  socket.fire('connect');
  // The sidebar list arrived, which is all the old watchdog required.
  socket.fire('channels-list', [{ id: 1, code: 'abcd1234', name: 'general', unreadCount: 0 }]);
  assert.equal(reloads.length, 0, 'reload waits to see whether the channel itself comes back');

  flushTimers();
  const resubscribed = emitted(socket, 'enter-channel').length > before + 1;
  assert.equal(resubscribed, true, 'the first miss hard-resubscribes the open channel');
  assert.equal(reloads.length, 0, 'one miss is a retry, not a reload');

  flushTimers();
  assert.equal(reloads.length, 1, 'still silent after the retry: full reload, the only recovery');
});

test('channel traffic after reconnect counts as recovered and does not reload', () => {
  const { socket, reloads } = clientApp();
  socket.fire('connect');
  socket.fire('channels-list', [{ id: 1, code: 'abcd1234', name: 'general', unreadCount: 0 }]);
  socket.fire('online-users', { channelCode: 'abcd1234', users: [], visibilityMode: 'online' });
  flushTimers();
  flushTimers();
  assert.equal(reloads.length, 0);
});

const h = createHarness(3621, 'silent-reconnect');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

test('a new connection from the same tab drops the stale socket and still receives messages', async () => {
  const admin = await h.register('admin');
  const first = await h.connect(admin.token, { auth: { tabId: 'phone-tab-1111' }, reconnection: false });
  const list = h.next(first, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'general'));
  first.emit('create-channel', { name: 'general' });
  const code = (await list).find((c) => c.name === 'general').code;
  first.emit('enter-channel', { code });
  await wait(200);

  const second = await h.connect(admin.token, { auth: { tabId: 'phone-tab-1111' }, reconnection: false });
  await wait(300);
  assert.equal(first.connected, false, 'the tab\'s previous socket is gone instead of lingering until ping timeout');
  assert.equal(second.connected, true);

  const desktop = await h.connect(admin.token, { auth: { tabId: 'desktop-tab-2222' }, reconnection: false });
  await wait(200);
  assert.equal(second.connected, true, 'another device of the same account stays connected');
  assert.equal(desktop.connected, true);

  second.emit('enter-channel', { code });
  desktop.emit('enter-channel', { code });
  await wait(200);
  const got = h.next(second, 'new-message', (d) => d && d.channelCode === code && d.message.content === 'after reconnect');
  desktop.emit('send-message', { code, content: 'after reconnect' });
  const msg = await got;
  assert.ok(msg, 'the replacement socket is in the channel and receives live messages');
});

test('sockets that do not say which tab they are leave each other alone', async () => {
  const bob = await h.register('bob');
  const a = await h.connect(bob.token, { reconnection: false });
  const b = await h.connect(bob.token, { reconnection: false });
  await wait(200);
  assert.equal(a.connected, true);
  assert.equal(b.connected, true);
});
