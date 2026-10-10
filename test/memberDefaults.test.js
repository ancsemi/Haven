'use strict';

// Defaults for new members (#5739): an admin shares a snapshot of their own
// look-and-feel settings; each member receives it once, only over settings
// they have not changed themselves.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const md = require('../src/memberDefaults');
const { checkSetting } = require('../src/serverTemplate');
const register = require('../src/socketHandlers/memberDefaults');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
  `);
  return db;
}
const pref = (db, uid, key) => db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(uid, key)?.value;
const setPref = (db, uid, key, value) => db.prepare('INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)').run(uid, key, value);

test('only allowlisted cosmetic settings with valid values are kept', () => {
  const s = md.cleanSettings({
    theme: 'matrix', density: 'compact', zoom: 120, blur_nsfw: false, layout: 'BraidLayout',
    effects: '["crt","matrix"]', interface_icons: 'emoji',
    // Not cosmetic, or not valid: all dropped.
    e2e: 'off', push_to_talk: 'Space', input_device: 'x', notifications: 'all',
    reaction_size: 'huge', zoom2: 1, toggle_style: 'switch ',
  });
  assert.deepEqual(Object.keys(s).sort(), ['blur_nsfw', 'density', 'effects', 'interface_icons', 'layout', 'theme', 'zoom']);
  assert.deepEqual(md.cleanSettings({ theme: 'custom', zoom: 300, layout: '../evil', effects: '["<x>"]', hide_send: 'true' }), {});
  assert.deepEqual(md.cleanSettings({ theme: 'file:Neon.theme.css' }), { theme: 'file:Neon.theme.css' });
  assert.deepEqual(md.cleanSettings({ theme: 'file:../x.css' }), {});
  assert.deepEqual(md.cleanSettings('not an object'), {});
});

test('saving keeps the version, clearing keeps it, applying to everyone raises it', () => {
  const db = freshDb();
  assert.equal(md.saveDefaults(db, { bogus: 1 }), null, 'nothing valid to save');
  md.saveDefaults(db, { density: 'compact' });
  assert.deepEqual(md.readSnapshot(db), { v: 1, s: { density: 'compact' } });
  md.saveDefaults(db, { density: 'spacious', theme: 'nord' });
  assert.equal(md.readSnapshot(db).v, 1, 'a new snapshot alone does not re-send to members who got one');
  md.bumpDefaults(db, 5000);
  assert.equal(md.readSnapshot(db).v, 5000);
  md.bumpDefaults(db, 10);
  assert.equal(md.readSnapshot(db).v, 5001, 'always goes up');
  md.clearDefaults(db);
  assert.deepEqual(md.readSnapshot(db), { v: 5001, s: {} });
  assert.equal(md.bumpDefaults(db), null, 'nothing to apply once cleared');
});

test('a member gets account defaults once, only where they never chose', () => {
  const db = freshDb();
  md.saveDefaults(db, { theme: 'matrix', effects: 'none', density: 'compact' });
  setPref(db, 7, 'effects', '["crt"]'); // their own pick

  assert.deepEqual(md.applyAccountDefaults(db, 7), { theme: 'matrix' });
  assert.equal(pref(db, 7, 'theme'), 'matrix');
  assert.equal(pref(db, 7, 'effects'), '["crt"]', 'their own effects stay');
  assert.deepEqual(JSON.parse(pref(db, 7, md.RECORD_PREF)), { v: 1, a: { theme: 'matrix' } });

  // Second load: already received.
  assert.deepEqual(md.applyAccountDefaults(db, 7), {});
  // They change the theme; nothing puts it back.
  setPref(db, 7, 'theme', 'dracula');
  md.saveDefaults(db, { theme: 'nord' });
  assert.deepEqual(md.applyAccountDefaults(db, 7), {});
  assert.equal(pref(db, 7, 'theme'), 'dracula');
});

test('applying to everyone updates untouched settings and leaves changed ones', () => {
  const db = freshDb();
  md.saveDefaults(db, { theme: 'matrix', effects: 'none' });
  md.applyAccountDefaults(db, 1);
  md.applyAccountDefaults(db, 2);
  setPref(db, 2, 'theme', 'halo'); // member 2 picked their own theme

  md.saveDefaults(db, { theme: 'nord', effects: 'auto' });
  md.bumpDefaults(db, 100);
  assert.deepEqual(md.applyAccountDefaults(db, 1), { theme: 'nord', effects: 'auto' });
  assert.deepEqual(md.applyAccountDefaults(db, 2), { effects: 'auto' });
  assert.equal(pref(db, 2, 'theme'), 'halo');
  // A member who joins later gets the current set.
  assert.deepEqual(md.applyAccountDefaults(db, 3), { theme: 'nord', effects: 'auto' });
});

test('a setting left out of a later set stays on record while untouched', () => {
  const db = freshDb();
  md.saveDefaults(db, { theme: 'matrix' });
  md.applyAccountDefaults(db, 1);
  md.saveDefaults(db, { effects: 'none' });
  md.bumpDefaults(db, 100);
  md.applyAccountDefaults(db, 1);
  assert.deepEqual(JSON.parse(pref(db, 1, md.RECORD_PREF)).a, { theme: 'matrix', effects: 'none' });
  md.saveDefaults(db, { theme: 'nord' });
  md.bumpDefaults(db, 200);
  assert.deepEqual(md.applyAccountDefaults(db, 1), { theme: 'nord' });
});

test('server templates carry the settings without the version', () => {
  const stored = JSON.stringify({ v: 98765, s: { density: 'compact', theme: 'matrix', junk: 1 } });
  assert.deepEqual(JSON.parse(checkSetting('member_defaults', stored)), { v: 0, s: { theme: 'matrix', density: 'compact' } });
  assert.equal(checkSetting('member_defaults', JSON.stringify({ v: 3, s: {} })), '');
  assert.equal(checkSetting('member_defaults', '{oops'), '');
});

function fakeSocket(user, perms = () => false) {
  const handlers = new Map();
  const sent = [];
  const settingChanges = [];
  const socket = {
    user,
    on: (ev, fn) => handlers.set(ev, fn),
    emit: (ev, data) => sent.push([ev, data]),
  };
  const db = freshDb();
  register(socket, {
    db, io: null, userHasPermission: perms,
    settingEffects: {
      emitSettingChanged: (k, v) => settingChanges.push([k, v]),
      auditSettingChange: () => {},
    },
  });
  return { handlers, sent, settingChanges, db };
}

test('only admins or manage_server holders can change the defaults, and errors deny', () => {
  const member = fakeSocket({ id: 2, isAdmin: false });
  member.handlers.get('set-member-defaults')({ settings: { density: 'compact' } });
  member.handlers.get('push-member-defaults')();
  member.handlers.get('clear-member-defaults')();
  assert.deepEqual(md.readSnapshot(member.db), { v: 0, s: {} });
  assert.equal(member.settingChanges.length, 0);

  const broken = fakeSocket({ id: 3, isAdmin: false }, () => { throw new Error('db gone'); });
  broken.handlers.get('set-member-defaults')({ settings: { density: 'compact' } });
  assert.deepEqual(md.readSnapshot(broken.db), { v: 0, s: {} }, 'a failed permission check denies');

  const manager = fakeSocket({ id: 4, isAdmin: false }, (uid, perm) => perm === 'manage_server');
  manager.handlers.get('set-member-defaults')({ settings: { density: 'compact' } });
  assert.deepEqual(md.readSnapshot(manager.db).s, { density: 'compact' });
  assert.equal(manager.settingChanges[0][0], 'member_defaults');

  // Any member may ask for their own defaults.
  manager.handlers.get('apply-member-defaults')();
  assert.deepEqual(manager.sent.at(-1), ['member-defaults-applied', {}]);
});

// One theme choice in two places (#5747): Default Theme in Appearance &
// Welcome and a shared theme for new members stay the same.
const defaultTheme = (db) => db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get()?.value;

test('a shared theme follows the Default Theme, and None takes it out', () => {
  const db = freshDb();
  assert.equal(md.followDefaultTheme(db, 'nord'), null, 'no shared theme: nothing is added');
  assert.deepEqual(md.readSnapshot(db).s, {});

  md.saveDefaults(db, { theme: 'matrix', density: 'compact' });
  md.bumpDefaults(db, 4000);
  assert.equal(md.followDefaultTheme(db, 'matrix'), null, 'already the same');
  md.followDefaultTheme(db, 'nord');
  assert.deepEqual(md.readSnapshot(db), { v: 4000, s: { theme: 'nord', density: 'compact' } }, 'the version stays');
  md.followDefaultTheme(db, '');
  assert.deepEqual(md.readSnapshot(db), { v: 4000, s: { density: 'compact' } });
});

test('sharing a theme makes it the Default Theme when it can be one', () => {
  const admin = fakeSocket({ id: 1, isAdmin: true });
  admin.handlers.get('set-member-defaults')({ settings: { theme: 'dracula', density: 'compact' } });
  assert.equal(defaultTheme(admin.db), 'dracula');
  assert.deepEqual(admin.settingChanges.map(([k]) => k), ['member_defaults', 'default_theme']);

  // Sharing again without a change leaves the Default Theme alone.
  admin.handlers.get('set-member-defaults')({ settings: { theme: 'dracula' } });
  assert.deepEqual(admin.settingChanges.map(([k]) => k), ['member_defaults', 'default_theme', 'member_defaults']);

  // Without a theme in the set, the Default Theme stays.
  admin.handlers.get('set-member-defaults')({ settings: { density: 'cozy' } });
  assert.equal(defaultTheme(admin.db), 'dracula');

  // A custom theme that is not published cannot be the Default Theme.
  admin.handlers.get('set-member-defaults')({ settings: { theme: 'file:braid.theme.css' } });
  assert.equal(defaultTheme(admin.db), 'dracula');
  admin.db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run('published_themes', '["braid.theme.css"]');
  admin.handlers.get('set-member-defaults')({ settings: { theme: 'file:braid.theme.css' } });
  assert.equal(defaultTheme(admin.db), 'file:braid.theme.css');
});

test('changing the Default Theme changes the shared theme too', () => {
  const registerAdmin = require('../src/socketHandlers/admin');
  const db = freshDb();
  const handlers = new Map();
  const changes = [];
  registerAdmin({ user: { id: 1, isAdmin: true }, on: (ev, fn) => handlers.set(ev, fn), emit() {} }, {
    db, io: { except: () => ({ emit() {} }) }, state: { channelUsers: new Map() },
    userHasPermission: () => true, logAudit() {}, automod: { invalidate() {}, settings: () => ({}) },
    settingEffects: {
      emitSettingChanged: (k, v) => changes.push([k, v]),
      auditSettingChange() {}, afterSettingSaved() {}, broadcastLinkPolicy() {},
    },
  });
  const update = handlers.get('update-server-setting');

  update({ key: 'default_theme', value: 'nord' });
  assert.deepEqual(md.readSnapshot(db).s, {}, 'nothing shared, nothing added');

  md.saveDefaults(db, { theme: 'matrix', zoom: 110 });
  update({ key: 'default_theme', value: 'tron' });
  assert.deepEqual(md.readSnapshot(db).s, { theme: 'tron', zoom: 110 });
  assert.deepEqual(changes.slice(-2).map(([k]) => k), ['default_theme', 'member_defaults']);

  update({ key: 'default_theme', value: '' });
  assert.deepEqual(md.readSnapshot(db).s, { zoom: 110 }, 'None (user\'s choice) is no shared theme either');

  // Unpublishing the custom theme that was the default drops it from both.
  update({ key: 'published_themes', value: '["braid.theme.css"]' });
  md.saveDefaults(db, { theme: 'file:braid.theme.css', zoom: 110 });
  update({ key: 'default_theme', value: 'file:braid.theme.css' });
  update({ key: 'published_themes', value: '[]' });
  assert.equal(defaultTheme(db), '');
  assert.deepEqual(md.readSnapshot(db).s, { zoom: 110 });
});

test('the client applies through the pickers and keeps a per-account device record', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-member-defaults.js'), 'utf8');
  assert.match(src, /const RECORD_PREFIX = 'haven_member_defaults_';/);
  assert.match(src, /cur === def\.dflt \|\| \(rec && rec\.a\[def\.key\] === cur\)/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  assert.ok(app.indexOf('this._setupMemberDefaults()') > app.indexOf('this._setupToolbarIconPicker()'),
    'set up after the pickers it presses');
  // Client keys match the server allowlist.
  const clientKeys = [...src.matchAll(/^\s{4}key: '([a-z_]+)'/gm)].map(m => m[1]).sort();
  assert.deepEqual(clientKeys, Object.keys(md.SETTINGS).sort());
});
