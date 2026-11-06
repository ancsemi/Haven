'use strict';

// Deleting a 1:1 DM from the pop-out DM window (#5848). The menu's Delete DM
// is the same button in both views, but a pop-out can miss the server's
// channel-deleted broadcast (a reconnect or a server switch around the click),
// so the menu now waits for the delete-dm reply and drops the conversation
// from this client when the server says it is gone. A refused delete leaves
// the conversation alone, and the next channel list cannot put a DM back.
//
//   node --test test/dmDeleteSync.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CODE = 'cccccccc';

function storage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

function load(name, globals) {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: name });
  return context.module.exports;
}

/** The DM context menu with only its Delete DM click wired up. */
function setupMenu({ currentChannel = null, activeDMPip = CODE } = {}) {
  const clicks = {};
  const menu = { style: { display: 'none' }, querySelector: () => null };
  const document = {
    getElementById: (id) => (id === 'dm-ctx-menu' ? menu : null),
    querySelector: (sel) => {
      const m = sel.match(/data-action="([^"]+)"/);
      if (!m) return null;
      return { style: {}, addEventListener: (ev, fn) => { clicks[m[1]] = fn; } };
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const globals = { document, localStorage: storage(), requestAnimationFrame: () => {}, t: (key) => key };
  const methods = { ...load('app-socket-channels.js', globals), ...load('app-channel-context.js', globals) };
  const emitted = [];
  const toasts = [];
  let welcomeShown = 0;
  let closedPiP = 0;
  let rendered = 0;
  const app = {
    ...methods,
    channels: [{ code: CODE, name: 'DM', is_dm: 1, dm_target: { id: 9, username: 'zed' } }],
    unreadCounts: { [CODE]: 3 },
    currentChannel,
    _activeDMPip: activeDMPip,
    _dmCtxMenuCode: CODE,
    _dmCtxMenuEl: menu,
    _closeChannelCtxMenu: () => {},
    _showConfirmModal: async () => true,
    _collectDmAttachments: async () => ['/uploads/a.bin'],
    _showToast: (message, type) => toasts.push({ message, type }),
    _showWelcome: () => { welcomeShown++; },
    _renderChannels: () => { rendered++; },
    _updateDmSectionBadge: () => {},
    _closeDMPiP() { closedPiP++; this._activeDMPip = null; },
    socket: {
      emit(ev, data, cb) { emitted.push({ ev, data, cb }); },
    },
  };
  app._initDmContextMenu();
  // As _openDmCtxMenu does for the DM the user picked.
  app._dmCtxMenuCode = CODE;
  return {
    app, clicks, emitted, toasts,
    welcomeShown: () => welcomeShown,
    closedPiP: () => closedPiP,
    rendered: () => rendered,
  };
}

/** An app with just the socket listeners, everything else a no-op. */
function setupSocket(fields) {
  const handlers = {};
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const globals = {
    document, t: (key) => key, URLSearchParams, localStorage: storage(), sessionStorage: storage(),
    window: { location: { search: '', pathname: '/app' }, history: { replaceState() {} } },
  };
  const methods = load('app-socket-channels.js', globals);
  let closedPiP = 0;
  const base = {
    ...methods,
    socket: { on: (ev, h) => { handlers[ev] = h; }, emit() {}, off() {} },
    unreadCounts: {},
    channels: [],
    _collectChannelCodeRotations: () => [],
    _closeDMPiP() { closedPiP++; this._activeDMPip = null; },
    ...fields,
  };
  const app = new Proxy(base, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k.startsWith('_') ? () => {} : undefined)) });
  base._listenChannelsAndMessages.call(app);
  return { app, handlers, closedPiP: () => closedPiP };
}

const lounge = { id: 1, code: 'aaaaaaaa', name: 'lounge', is_dm: 0 };
const dm = { id: 2, code: CODE, name: 'DM', is_dm: 1, dm_target: { id: 9, username: 'zed' } };

test('a delete from the pop-out waits for the server and drops the DM here', async () => {
  const { app, clicks, emitted, closedPiP, rendered } = setupMenu();

  await clicks['dm-delete']();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ev, 'delete-dm');
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0].data)), {
    code: CODE, attachments: ['/uploads/a.bin'], confirmed: true,
  });
  assert.equal(typeof emitted[0].cb, 'function', 'the menu waits for the delete-dm reply');
  assert.equal(app.channels.length, 1, 'nothing is dropped before the server confirms');

  emitted[0].cb({ success: true });

  assert.deepEqual(app.channels, [], 'the conversation goes even if channel-deleted is missed');
  assert.equal(CODE in app.unreadCounts, false);
  assert.equal(app._activeDMPip, null);
  assert.equal(closedPiP(), 1, 'the pop-out showing it closes');
  assert.ok(rendered() > 0, 'the sidebar is redrawn');
});

test('deleting from the full-screen DM leaves the view as well', async () => {
  const { app, clicks, emitted, welcomeShown } = setupMenu({ currentChannel: CODE, activeDMPip: null });

  await clicks['dm-delete']();
  emitted[0].cb({ success: true });

  assert.equal(app.currentChannel, null);
  assert.equal(welcomeShown(), 1);
});

test('a refused delete keeps the conversation and says why', async () => {
  const { app, clicks, emitted, toasts, closedPiP } = setupMenu();

  await clicks['dm-delete']();
  emitted[0].cb({ error: 'DM not found' });

  assert.equal(app.channels.length, 1);
  assert.equal(app._activeDMPip, CODE);
  assert.equal(closedPiP(), 0);
  assert.deepEqual(toasts, [{ message: 'DM not found', type: 'error' }]);
});

test('a DM deleted in a missed broadcast stays gone on the next channel list', () => {
  // The pop-out's delete broadcast was missed (a reconnect or server switch
  // around it), so this window still holds the row when the fresh list
  // arrives without the conversation.
  const { app, handlers, closedPiP } = setupSocket({ channels: [lounge, dm], _activeDMPip: CODE });

  handlers['channels-list']([lounge]);

  assert.deepEqual(app.channels.map((c) => c.code), [lounge.code]);
  assert.equal(app._activeDMPip, null, 'the pop-out showing the deleted DM closes');
  assert.equal(closedPiP(), 1);
});

test('a DM still in the server list stays', () => {
  const { app, handlers } = setupSocket({ channels: [lounge, dm] });
  handlers['channels-list']([lounge, dm]);
  assert.deepEqual(app.channels.map((c) => c.code), [lounge.code, dm.code]);
});
