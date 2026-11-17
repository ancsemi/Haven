'use strict';

// Deleting a group DM when you are the last one in it (#5740). The menu
// offers it only to the last member, by the server's current member list
// (the app's own copy can be out of date), and deleting is leaving last:
// the encrypted attachments are gathered first so they go with the group.
// Leaving also uses the current list to decide whether it is the last leave.
//
//   node --test test/groupDmDelete.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
const t = (key, vars = {}) => String(key.split('.').reduce((o, k) => (o ? o[k] : undefined), en) || key)
  .replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);

function load(name, globals) {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, t, console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: name });
  return context.module.exports;
}

const ME = 1;
const CODE = 'bbbbbbbb';

/** Menu buttons and an app whose server answers the roster with `members`. */
function setup({ members, cached, confirmed = true, admin = false }) {
  const buttons = Object.fromEntries(['dm-mute', 'dm-mark-read', 'dm-group-add', 'dm-group-leave', 'dm-group-delete', 'dm-group-delete-all', 'dm-delete']
    .map((a) => [a, { style: { display: 'none' }, textContent: '' }]));
  const menu = {
    style: {},
    querySelector: (sel) => buttons[(sel.match(/data-action="([^"]+)"/) || [])[1]] || null,
    querySelectorAll: (sel) => [...sel.matchAll(/data-action="([^"]+)"/g)].map((m) => buttons[m[1]]),
    getBoundingClientRect: () => ({ right: 0, bottom: 0, width: 0, height: 0, top: 0 }),
  };
  const globals = {
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => {},
    window: { innerWidth: 1000, innerHeight: 800 },
    confirm: () => confirmed,
  };
  const emitted = [];
  const toasts = [];
  const app = {
    ...load('app-groups.js', globals),
    ...load('app-channel-context.js', globals),
    user: { id: ME, isAdmin: admin },
    channels: [{ code: CODE, name: 'Crew', is_dm: 1, is_group: 1, group_members: cached }],
    unreadCounts: {},
    _dmCtxMenuEl: menu,
    // Opening a DM menu closes the channel menu (#5744); there is no page here.
    _closeChannelCtxMenu: () => {},
    _groupName: (ch) => ch.name,
    _groupRoster: async () => (members ? { members } : null),
    _collectDmAttachments: async () => ['/uploads/a.bin'],
    _showConfirmModal: async () => confirmed,
    _confirm: async () => confirmed,
    _showToast: (message, type) => toasts.push({ message, type }),
    socket: { emit: (ev, data) => emitted.push([ev, data]) },
  };
  return { app, buttons, emitted, toasts };
}

const flush = () => new Promise((r) => setImmediate(r));

test('the menu offers Delete group only to the last member, by the current list', async () => {
  // The app still thinks bob is in the group; the server knows he left.
  const alone = setup({ members: [{ id: ME }], cached: [{ id: ME }, { id: 2 }] });
  alone.app._openDmCtxMenu(CODE, { getBoundingClientRect: () => ({ bottom: 0, left: 0 }) });
  await flush();
  assert.equal(alone.buttons['dm-group-delete'].style.display, '');
  assert.equal(alone.buttons['dm-delete'].style.display, 'none', 'the 1:1 Delete DM stays hidden for groups');

  const notAlone = setup({ members: [{ id: ME }, { id: 2 }], cached: [{ id: ME }] });
  notAlone.app._openDmCtxMenu(CODE, { getBoundingClientRect: () => ({ bottom: 0, left: 0 }) });
  await flush();
  assert.equal(notAlone.buttons['dm-group-delete'].style.display, 'none');
});

test('deleting the group leaves it last with its attachments', async () => {
  const { app, emitted } = setup({ members: [{ id: ME }], cached: [{ id: ME }, { id: 2 }] });
  await app._deleteGroup(CODE);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [['leave-group-dm', { code: CODE, attachments: ['/uploads/a.bin'] }]]);
  assert.equal(app._deletingGroup, CODE);
});

test('deleting is refused if someone else is in the group by now', async () => {
  const { app, emitted, toasts } = setup({ members: [{ id: ME }, { id: 3 }], cached: [{ id: ME }] });
  await app._deleteGroup(CODE);
  assert.deepEqual(emitted, []);
  assert.equal(toasts[0].message, en.groups.delete_not_alone);
});

test('leaving uses the current list to decide whether attachments go with the group', async () => {
  const last = setup({ members: [{ id: ME }], cached: [{ id: ME }, { id: 2 }] });
  await last.app._leaveGroup(CODE);
  assert.deepEqual(JSON.parse(JSON.stringify(last.emitted)), [['leave-group-dm', { code: CODE, attachments: ['/uploads/a.bin'] }]]);

  const notLast = setup({ members: [{ id: ME }, { id: 2 }], cached: [{ id: ME }] });
  await notLast.app._leaveGroup(CODE);
  assert.deepEqual(JSON.parse(JSON.stringify(notLast.emitted)), [['leave-group-dm', { code: CODE, attachments: [] }]]);
});

test('Delete group for everyone shows only to the server admin', async () => {
  const anchor = { getBoundingClientRect: () => ({ bottom: 0, left: 0 }) };
  const admin = setup({ members: [{ id: ME }, { id: 2 }], cached: [{ id: ME }, { id: 2 }], admin: true });
  admin.app._openDmCtxMenu(CODE, anchor);
  assert.equal(admin.buttons['dm-group-delete-all'].style.display, '');
  const member = setup({ members: [{ id: ME }, { id: 2 }], cached: [{ id: ME }, { id: 2 }] });
  member.app._openDmCtxMenu(CODE, anchor);
  assert.equal(member.buttons['dm-group-delete-all'].style.display, 'none');
});

test('the admin deletes for everyone with the attachments this app can read, after confirming', async () => {
  const admin = setup({ members: [{ id: ME }, { id: 2 }], cached: [{ id: ME }, { id: 2 }], admin: true });
  await admin.app._deleteGroupForEveryone(CODE);
  assert.deepEqual(JSON.parse(JSON.stringify(admin.emitted)), [['delete-group-dm-for-everyone', { code: CODE, attachments: ['/uploads/a.bin'] }]]);
  const cancelled = setup({ members: [{ id: ME }], cached: [{ id: ME }], admin: true, confirmed: false });
  await cancelled.app._deleteGroupForEveryone(CODE);
  assert.deepEqual(cancelled.emitted, []);
  const member = setup({ members: [{ id: ME }], cached: [{ id: ME }] });
  await member.app._deleteGroupForEveryone(CODE);
  assert.deepEqual(member.emitted, [], 'not offered to anyone else');
});

test('the menu item and its strings exist', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  assert.match(html, /data-action="dm-group-delete"[^>]*>[^<]*<span data-i18n="groups\.delete">/);
  assert.match(html, /data-action="dm-group-delete-all"[^>]*>[^<]*<span data-i18n="groups\.delete_all">/);
  for (const key of ['delete', 'delete_confirm', 'delete_not_alone', 'deleted', 'delete_all', 'delete_all_confirm', 'deleted_by_admin']) assert.ok(en.groups[key], key);
});
