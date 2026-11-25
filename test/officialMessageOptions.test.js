'use strict';

// Official messages, the opt-in extras: keep official mode on (saved on the
// account, every device follows), how official messages look to the reader
// (Badge, Colored text, Off), runs of official messages grouping into one
// block, and the session-info features list.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');

const highlights = require('../src/messageHighlights');
const register = require('../src/socketHandlers/messageHighlights');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, color TEXT, color2 TEXT, color_shimmer INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, user_id INTEGER);
    INSERT INTO users (id, username) VALUES (1, 'alice'), (2, 'bob');
  `);
  highlights.ensureTable(db);
  return db;
}

// Two sockets for alice (two devices) and one for bob, all on one io.
function fakeServer() {
  const db = freshDb();
  const sockets = new Map();
  const io = { sockets: { sockets }, to: () => ({ emit: () => {} }) };
  const connect = (id, user) => {
    const handlers = new Map();
    const sent = [];
    const socket = { user, on: (ev, fn) => handlers.set(ev, fn), emit: (ev, data) => sent.push([ev, data]) };
    sockets.set(id, socket);
    register(socket, { io, db, userHasPermission: () => false, getUserHighestRole: () => null });
    return { handlers, sent };
  };
  return {
    db,
    phone: connect('a1', { id: 1, isAdmin: false }),
    desktop: connect('a2', { id: 1, isAdmin: false }),
    bob: connect('b1', { id: 2, isAdmin: false }),
  };
}

test('official mode is off until the person turns it on', () => {
  const db = freshDb();
  assert.equal(highlights.officialMode(db, 1), false);
  assert.equal(highlights.setOfficialMode(db, 1, true), true);
  assert.equal(highlights.officialMode(db, 1), true);
  assert.equal(highlights.officialMode(db, 2), false, 'only their own account');
  assert.equal(highlights.officialMode(db, 99), false, 'no such user');
  // Running the migration again keeps what was saved.
  highlights.ensureTable(db);
  assert.equal(highlights.officialMode(db, 1), true);
});

test('switching official mode reaches every device of theirs and nobody else', () => {
  const { db, phone, desktop, bob } = fakeServer();
  let reply = null;
  phone.handlers.get('set-official-mode')({ enabled: true }, (r) => { reply = r; });
  assert.deepEqual(reply, { ok: true, officialMode: true });
  assert.equal(highlights.officialMode(db, 1), true);
  assert.deepEqual(phone.sent, [['official-mode-changed', { officialMode: true }]]);
  assert.deepEqual(desktop.sent, [['official-mode-changed', { officialMode: true }]]);
  assert.deepEqual(bob.sent, []);
  assert.equal(highlights.officialMode(db, 2), false);

  desktop.handlers.get('set-official-mode')({ enabled: false });
  assert.equal(highlights.officialMode(db, 1), false, 'no callback is fine');
  assert.deepEqual(phone.sent.at(-1), ['official-mode-changed', { officialMode: false }]);
});

test('a malformed official mode request changes nothing', () => {
  const { db, phone } = fakeServer();
  for (const bad of [null, 'on', { enabled: 'true' }, { enabled: 1 }, {}]) {
    let reply = null;
    phone.handlers.get('set-official-mode')(bad, (r) => { reply = r; });
    assert.equal(reply.ok, false);
  }
  assert.equal(highlights.officialMode(db, 1), false);
  assert.deepEqual(phone.sent, []);
});

test('session-info tells clients what the server supports and the sender\'s mode', () => {
  assert.deepEqual(highlights.FEATURES, ['highlight_messages', 'official_mode']);
  const src = read('src/socketHandlers/index.js');
  assert.match(src, /officialMode: highlights\.officialMode\(db, socket\.user\.id\),/);
  assert.match(src, /features: \[\.\.\.highlights\.FEATURES, 'member_sessions', 'dm_storage', 'unicode_emoji_names'\]/);
});

let M;
test.before(async () => {
  const modulePath = path.join(__dirname, '..', 'public/js/modules/app-message-highlights.js');
  M = (await import(pathToFileURL(modulePath).href)).default;
});

function withStyle(style, fn) {
  const store = new Map(style ? [['haven_official_style', style]] : []);
  const prev = global.localStorage;
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try { return fn(); } finally { global.localStorage = prev; }
}

test('the badge stays the default look, and unknown values fall back to it', () => {
  assert.equal(withStyle(null, () => M._officialStyle()), 'badge');
  assert.equal(withStyle('text', () => M._officialStyle()), 'text');
  assert.equal(withStyle('off', () => M._officialStyle()), 'off');
  assert.equal(withStyle('sparkles', () => M._officialStyle()), 'badge');
});

test('official runs group only with Colored text; the badge keeps every header', () => {
  const official = { highlight: { role: 'Mod' } };
  const plain = {};
  // Badge (the default): an official message never groups, either way.
  withStyle(null, () => {
    assert.equal(M._highlightGroups(official, official), false);
    assert.equal(M._highlightGroups(plain, official), false);
    assert.equal(M._highlightGroups(official, plain), false);
    assert.equal(M._highlightGroups(plain, plain), true);
  });
  // Colored text: one block per run, and plain and official do not mix.
  withStyle('text', () => {
    assert.equal(M._highlightGroups(official, official), true);
    assert.equal(M._highlightGroups(plain, official), false);
    assert.equal(M._highlightGroups(official, plain), false);
    assert.equal(M._highlightGroups(plain, plain), true);
  });
  // Off: the mark makes no difference.
  withStyle('off', () => {
    assert.equal(M._highlightGroups(official, plain), true);
    assert.equal(M._highlightGroups(official, official), true);
  });
});

test('with official mode on the button rests armed, and only where it shows', () => {
  const app = Object.assign(Object.create(M), { user: { officialMode: true }, _highlightAvailable: true });
  assert.equal(app._highlightDefault(), true);
  app._highlightAvailable = false; // a DM, or no permission here
  assert.equal(app._highlightDefault(), false);
  app._highlightAvailable = true;
  app.user.officialMode = false;
  assert.equal(app._highlightDefault(), false, 'off: one message per press, as before');
});

test('the composer and the menus are wired to the settings', () => {
  const messages = read('public/js/modules/app-messages.js');
  assert.match(messages, /if \(this\._highlightArmed\) payload\.highlight = true;\n\s*this\._setHighlightArmed\(this\._highlightDefault\(\)\);/);
  assert.match(messages, /this\._highlightGroups\(msg, prevMsg\) &&/);
  const html = read('public/app.html');
  assert.match(html, /<select id="official-style-select"[^>]*>\s*<option value="badge"/);
  assert.match(html, /<div id="official-mode-setting" style="display:none">/);
  assert.match(html, /<input type="checkbox" id="official-mode-toggle">/);
  const css = read('public/css/style-messages.css');
  assert.match(css, /:root\[data-official-style\] \.msg-highlight-badge \{ display: none; \}/);
});
