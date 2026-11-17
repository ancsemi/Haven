'use strict';

// Once one device/tab marks a channel read, every other connected device for
// that account should drop its notification for that channel too:
//   - the server broadcasts 'channel-read' to the account's other sockets
//     (covered by test/messageMetadataAsync.test.js)
//   - a listening tab closes its in-page Notification, asks its service
//     worker to close any push notification, and tells Haven Desktop to
//     close its native toast
//   - the service worker itself closes push notifications tagged for that
//     channel on request
//
//   node --test test/crossDeviceNotificationDismissal.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function loadChannelUnread() {
  const context = vm.createContext({
    module: { exports: {} }, console, t: (k) => k, URL, URLSearchParams,
    localStorage: { getItem: () => '[]', setItem() {} },
    window: {},
    document: { getElementById: () => null },
    JSON,
  });
  context.window.window = context.window;
  vm.runInContext(
    read('public/js/modules/app-channel-unread.js').replace(/^export default/m, 'module.exports ='),
    context
  );
  return { app: context.module.exports, window: context.window };
}

test('a channel-read event closes the in-page Notification for that channel', () => {
  const { app } = loadChannelUnread();
  const closed = [];
  app._liveNotificationsByChannel = new Map([
    ['chan-a', { close: () => closed.push('chan-a') }],
    ['chan-b', { close: () => closed.push('chan-b') }],
  ]);
  app._dismissChannelNotifications('chan-a');
  assert.deepEqual(closed, ['chan-a']);
  assert.equal(app._liveNotificationsByChannel.has('chan-b'), true);
});

test('a channel-read event asks the active service worker to close push notifications for that channel', () => {
  const { app } = loadChannelUnread();
  const posted = [];
  app._swRegistration = { active: { postMessage: (msg) => posted.push(msg) } };
  app._dismissChannelNotifications('chan-c');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'close-channel-notifications');
  assert.equal(posted[0].channelCode, 'chan-c');
});

test('a channel-read event tells Haven Desktop to close its native toast', () => {
  const { app, window } = loadChannelUnread();
  const dismissed = [];
  window.havenDesktop = { dismissNotification: (code) => dismissed.push(code) };
  app._dismissChannelNotifications('chan-d');
  assert.deepEqual(dismissed, ['chan-d']);
});

test('dismissing with no channel code is a no-op and never throws', () => {
  const { app } = loadChannelUnread();
  app._liveNotificationsByChannel = new Map([['x', { close: () => { throw new Error('should not be called'); } }]]);
  assert.doesNotThrow(() => app._dismissChannelNotifications(null));
  assert.doesNotThrow(() => app._dismissChannelNotifications(undefined));
});

test('an older Desktop app (a bridge without dismissNotification), no service worker, or one not yet active is skipped without error', () => {
  const { app, window } = loadChannelUnread();
  // Haven Desktop 1.8.2: has the bridge and notify(), but not dismissNotification().
  window.havenDesktop = { notify() {} };
  assert.doesNotThrow(() => app._dismissChannelNotifications('chan-e'));

  app._swRegistration = null;
  assert.doesNotThrow(() => app._dismissChannelNotifications('chan-e'));
  app._swRegistration = { active: null }; // installing or waiting
  assert.doesNotThrow(() => app._dismissChannelNotifications('chan-e'));

  // A service worker that throws on postMessage must not stop the Desktop call.
  const dismissed = [];
  app._swRegistration = { active: { postMessage: () => { throw new Error('worker gone'); } } };
  window.havenDesktop = { dismissNotification: (code) => dismissed.push(code) };
  assert.doesNotThrow(() => app._dismissChannelNotifications('chan-f'));
  assert.deepEqual(dismissed, ['chan-f']);
});

test("a listener on the socket is wired to dismiss notifications for the read channel", () => {
  const context = vm.createContext({
    module: { exports: {} }, console, t: (k) => k, URL, URLSearchParams, window: {},
  });
  vm.runInContext(
    read('public/js/modules/app-socket-events.js').replace(/^export default/m, 'module.exports ='),
    context
  );
  const events = context.module.exports;
  const dismissed = [];
  const applied = [];
  const handlers = {};
  const app = Object.assign(Object.create(events), {
    socket: { on: (name, fn) => { handlers[name] = fn; } },
    _dismissChannelNotifications: (code) => dismissed.push(code),
    _applyChannelRead: (code, id) => applied.push([code, id]),
  });
  app._listenFeatureEvents();
  assert.equal(typeof handlers['channel-read'], 'function');

  handlers['channel-read']({ channelCode: 'chan-e', messageId: 42 });
  assert.deepEqual(dismissed, ['chan-e']);
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0], 'chan-e');
  assert.equal(applied[0][1], 42);

  // No channelCode on the payload: nothing to dismiss, no throw.
  dismissed.length = 0;
  applied.length = 0;
  assert.doesNotThrow(() => handlers['channel-read']({}));
  assert.deepEqual(dismissed, []);
  assert.equal(applied.length, 0);
});

function readApp({ unread, latest }) {
  const { app } = loadChannelUnread();
  const calls = [];
  app.unreadCounts = { 'chan-u': unread, 'chan-other': 3 };
  app.channels = [{ code: 'chan-u', latestMessageId: latest }];
  for (const name of ['_updateBadge', '_updateDmSectionBadge', '_updateTabTitle', '_updateDesktopBadge']) {
    app[name] = (...args) => calls.push([name, ...args]);
  }
  return { app, calls };
}

test('a read on another device clears that channel\'s unread count and refreshes every badge', () => {
  const { app, calls } = readApp({ unread: 4, latest: 50 });
  app._applyChannelRead('chan-u', 50);
  assert.equal(app.unreadCounts['chan-u'], 0);
  assert.equal(app.unreadCounts['chan-other'], 3, 'other channels are left alone');
  assert.deepEqual(calls.map(c => c[0]), ['_updateBadge', '_updateDmSectionBadge', '_updateTabTitle', '_updateDesktopBadge']);
  assert.equal(calls[0][1], 'chan-u');
});

test('a message that arrived here after the one that was read keeps its unread count', () => {
  const { app, calls } = readApp({ unread: 1, latest: 51 });
  app._applyChannelRead('chan-u', 50);
  assert.equal(app.unreadCounts['chan-u'], 1);
  assert.deepEqual(calls, []);
});

test('a read with nothing unread here, or no channel, changes nothing', () => {
  const none = readApp({ unread: 0, latest: 50 });
  none.app._applyChannelRead('chan-u', 50);
  none.app._applyChannelRead(null, 50);
  none.app._applyChannelRead('not-a-channel', 50);
  assert.deepEqual(none.calls, []);
  assert.equal(none.app.unreadCounts['chan-other'], 3);
});

test('a read without a message id still clears (mark-all-read of a channel the client has not seen)', () => {
  const { app } = readApp({ unread: 2, latest: 0 });
  app._applyChannelRead('chan-u', null);
  assert.equal(app.unreadCounts['chan-u'], 0);
});

test('one badge helper failing does not stop the others', () => {
  const { app, calls } = readApp({ unread: 2, latest: 10 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    app._updateBadge = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => app._applyChannelRead('chan-u', 10));
  } finally { console.warn = warn; }
  assert.equal(app.unreadCounts['chan-u'], 0);
  assert.deepEqual(calls.map(c => c[0]), ['_updateDmSectionBadge', '_updateTabTitle', '_updateDesktopBadge']);
});

test('the service worker closes push notifications tagged for the read channel on request', async () => {
  const notifications = {
    'haven-chan-f': { closed: false, close() { this.closed = true; } },
  };
  const listeners = {};
  const waited = [];
  global.self = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    registration: {
      getNotifications: async ({ tag }) => (notifications[tag] ? [notifications[tag]] : []),
    },
  };
  try {
    vm.runInContext(
      read('public/sw.js'),
      vm.createContext({ self: global.self, console })
    );
    const event = {
      data: { type: 'close-channel-notifications', channelCode: 'chan-f' },
      waitUntil: (p) => waited.push(p),
    };
    listeners.message(event);
    await Promise.all(waited);
    assert.equal(notifications['haven-chan-f'].closed, true);
  } finally {
    delete global.self;
  }
});

test('the service worker ignores messages of another type or missing a channel code', async () => {
  const listeners = {};
  const getNotificationsCalls = [];
  global.self = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    registration: {
      getNotifications: async (opts) => { getNotificationsCalls.push(opts); return []; },
    },
  };
  try {
    vm.runInContext(
      read('public/sw.js'),
      vm.createContext({ self: global.self, console })
    );
    listeners.message({ data: { type: 'something-else', channelCode: 'chan-g' }, waitUntil: () => {} });
    listeners.message({ data: { type: 'close-channel-notifications' }, waitUntil: () => {} });
    assert.deepEqual(getNotificationsCalls, []);
  } finally {
    delete global.self;
  }
});
