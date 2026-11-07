'use strict';

// What the app does when a DM goes away for this user (#5740, #5848): the
// server's channel list is authoritative, so a DM missing from it is dropped
// (keeping the old local row put a conversation deleted from the pop-out DM
// window back on the next list refresh), a kick from a group says so, and the
// group closes in the pop-out DM window as well.
//
//   node --test test/groupDmClient.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['app-socket.js', 'app-socket-channels.js', 'app-socket-events.js'];
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), en);
const t = (key, vars = {}) => String(lookup(key) || key).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);

function storage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

function loadMethods() {
  const methods = {};
  for (const name of FILES) {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
    const context = vm.createContext({
      module: { exports: {} }, t, URLSearchParams, console, setTimeout, clearTimeout,
      localStorage: storage(), sessionStorage: storage(),
      window: { location: { search: '', pathname: '/app' }, history: { replaceState() {} } },
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    });
    vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  }
  return methods;
}

/** An app with just the socket listeners, everything else a no-op. */
function makeApp(fields) {
  const handlers = {};
  const toasts = [];
  const base = {
    ...loadMethods(),
    socket: { on: (ev, h) => { handlers[ev] = h; }, emit() {}, off() {} },
    unreadCounts: {},
    toasts,
    _showToast: (message, type) => toasts.push({ message, type }),
    _groupName: (ch) => ch.name,
    ...fields,
  };
  const app = new Proxy(base, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k.startsWith('_') ? () => {} : undefined)) });
  base._listenChannelsAndMessages.call(app);
  base._listenPresenceAndVoice.call(app);
  base._listenAdminAndPrefs.call(app);
  return { app, handlers, toasts };
}

const lounge = { id: 1, code: 'aaaaaaaa', name: 'lounge', is_dm: 0 };
const group = { id: 2, code: 'bbbbbbbb', name: 'Crew', is_dm: 1, is_group: 1 };
const oneToOne = { id: 3, code: 'cccccccc', name: 'DM', is_dm: 1, dm_target: { id: 9, username: 'zed' } };

test('a DM missing from a fresh channel list is dropped, so a delete cannot come back', () => {
  const { app, handlers } = makeApp({ channels: [lounge, group, oneToOne] });
  handlers['channels-list']([lounge]);
  assert.deepEqual(app.channels.map((c) => c.code), [lounge.code]);
});

test('a group still in the list stays', () => {
  const { app, handlers } = makeApp({ channels: [lounge, group] });
  handlers['channels-list']([lounge, group]);
  assert.deepEqual(app.channels.map((c) => c.code), [lounge.code, group.code]);
});

test('a kick from a group says you were removed from the group, not kicked', () => {
  const { app, handlers, toasts } = makeApp({ channels: [lounge, group], currentChannel: group.code });
  handlers.kicked({ channelCode: group.code, group: true, reason: '' });
  assert.equal(toasts[0].message, 'You were removed from Crew');
  assert.equal(app.currentChannel, null);
  handlers.kicked({ channelCode: group.code, group: true, reason: 'spam' });
  assert.equal(toasts[1].message, 'You were removed from Crew: spam');
});

test('a kick from a channel names the channel instead of sounding like the server', () => {
  const { toasts, handlers } = makeApp({ channels: [lounge] });
  handlers.kicked({ channelCode: lounge.code, reason: '' });
  handlers.kicked({ channelCode: lounge.code, reason: 'spam' });
  handlers.kicked({ channelCode: 'ffffffff', reason: '' });
  assert.deepEqual(toasts.map((x) => x.message), ['You were kicked from #lounge', 'You were kicked from #lounge: spam', 'You were kicked']);
});

test('a group that goes away closes in the pop-out DM window too', () => {
  let closed = 0;
  const { app, handlers } = makeApp({ channels: [lounge, group], _activeDMPip: group.code, _closeDMPiP() { closed++; this._activeDMPip = null; } });
  handlers['channel-deleted']({ code: lounge.code });
  assert.equal(closed, 0);
  handlers['channel-deleted']({ code: group.code });
  assert.equal(closed, 1);
  assert.equal(app.channels.length, 0);
});
