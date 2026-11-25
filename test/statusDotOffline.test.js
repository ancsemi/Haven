'use strict';

// The presence dot. A status someone chose (Away, Do Not Disturb) is kept
// while they are gone, so offline has to be checked first: the pop-out DM
// and the profile card showed offline people as idle.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let users;

test.before(async () => {
  globalThis.t = (key) => key;
  users = (await import(pathToFileURL(path.join(root, 'public/js/modules/app-users.js')).href)).default;
});

test('offline wins over a status kept from before', () => {
  for (const status of ['away', 'dnd', 'online', 'offline', undefined]) {
    assert.equal(users._statusDotClass({ online: false, status }), 'offline', String(status));
    assert.equal(users._statusLabel({ online: false, status }), 'app.profile.offline', String(status));
  }
});

test('someone who is here shows the status they chose', () => {
  assert.equal(users._statusDotClass({ online: true, status: 'away' }), 'away');
  assert.equal(users._statusDotClass({ online: true, status: 'dnd' }), 'dnd');
  assert.equal(users._statusDotClass({ online: true, status: 'invisible' }), 'invisible', 'your own entry');
  assert.equal(users._statusDotClass({ online: true, status: 'online' }), '');
  assert.equal(users._statusDotClass({ status: 'away' }), 'away', 'a list that leaves out the online flag');
  assert.equal(users._statusLabel({ online: true, status: 'dnd' }), 'app.profile.dnd');
  assert.equal(users._statusLabel({ online: true }), 'app.profile.online');
});

test('the sidebar and the pop-out DM use the shared rule, and every dot has an offline look', () => {
  const sidebar = read('public/js/modules/app-users.js');
  assert.match(sidebar, /const statusClass = this\._statusDotClass\(u\);/);
  const pip = read('public/js/modules/app-pip-panels.js');
  assert.match(pip, /const shown = ch\.is_self_dm \? \{ online: true \} : \(onlinePartner \|\| \{ online: false \}\);/);
  assert.match(pip, /const statusClass = this\._statusDotClass\(shown\);/);
  assert.doesNotMatch(pip, /offline_away/);
  assert.match(read('public/css/style-messages.css'), /\.user-status-dot\.offline,\s*\.user-status-dot\.invisible \{/);
  assert.match(read('public/css/style-messages.css'), /\.profile-popup-status-dot\.offline \{ background: var\(--bg-primary\); box-shadow: inset/);
  assert.match(read('public/css/style-roles-layout-polls.css'), /\.online-overlay-status-dot\.offline \{ background: transparent; box-shadow: inset/);
  assert.match(read('public/css/style-sidebar.css'), /\.dm-pip-status-dot\.offline\s*\{/);
});
