'use strict';

// Activity reported by Haven Desktop from apps on the member's own computer
// (#5894): cleaned, capped, kept out of slots another source holds, cleared
// when the reporting device goes, and hidden by the usual sharing switches.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createActivity } = require('../src/activity');
const registerAppActivity = require('../src/socketHandlers/appActivity');

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT);
           CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT);
           INSERT INTO users (id, status) VALUES (1, 'online'), (2, 'invisible');`);
  const changed = [];
  const activity = createActivity({ db, getOnlineUserIds: () => [1, 2], onChange: (id) => changed.push(id) });
  return { db, activity, changed };
}

function fakeSocket(user, sockets) {
  const handlers = {};
  const socket = { user, on: (name, fn) => { handlers[name] = fn; }, fire: (name, data) => handlers[name](data) };
  sockets.set(socket, socket);
  return socket;
}

test('app activity is cleaned, capped and carries no image', () => {
  const { activity } = setup();
  activity.setAppActivity(1, {
    playing: { name: 'Elden‮ Ring' + 'x'.repeat(300), details: 'Limgrave\u0000', image: 'https://evil.example/x.png', startedAt: Date.now() + 9e9 },
    listening: { name: 'Song', details: 'Artist', app: 'Feishin', startedAt: Date.now() - 5000, duration: 200000 },
  });
  const pub = activity.getPublicActivity(1);
  assert.equal(pub.playing.name.length, 120);
  assert.ok(!/[‮\u0000]/.test(pub.playing.name + pub.playing.details));
  assert.equal(pub.playing.image, null);
  assert.equal(pub.playing.source, 'app');
  assert.ok(pub.playing.startedAt <= Date.now());
  assert.equal(pub.listening.name, 'Song');
  assert.equal(pub.listening.details, 'Artist');
  assert.equal(pub.listening.duration, 200000);
  assert.equal(pub.listening.image, null);
});

test('a nameless or malformed report shows nothing, and null clears', () => {
  const { activity } = setup();
  activity.setAppActivity(1, { playing: { name: '   ' }, listening: 'nope' });
  assert.equal(activity.getPublicActivity(1), null);
  activity.setAppActivity(1, { playing: { name: 'Game' } });
  assert.equal(activity.getPublicActivity(1).playing.name, 'Game');
  activity.setAppActivity(1, null);
  assert.equal(activity.getPublicActivity(1), null);
});

test('a slot another source holds is left alone', () => {
  const { activity } = setup();
  activity.setHavenGame(1, 'flappy');
  activity.setAppActivity(1, { playing: { name: 'Other Game' } });
  assert.equal(activity.getPublicActivity(1).playing.source, 'haven-game');
  activity.setAppActivity(1, null);
  assert.equal(activity.getPublicActivity(1).playing.source, 'haven-game');
});

test('the sharing switches and Invisible hide app activity', () => {
  const { db, activity } = setup();
  activity.setAppActivity(2, { playing: { name: 'Game' } });
  assert.equal(activity.getPublicActivity(2), null);
  activity.setAppActivity(1, { playing: { name: 'Game' } });
  db.prepare("INSERT INTO user_preferences VALUES (1, 'share_game_activity', 'false')").run();
  assert.equal(activity.getPublicActivity(1), null);
});

test('the handler spaces updates, refuses when sharing is off, and clears on disconnect', () => {
  const { db, activity } = setup();
  const sockets = new Map();
  const ctx = { state: { activity }, io: { of: () => ({ sockets }) } };
  const a = fakeSocket({ id: 1 }, sockets);
  const b = fakeSocket({ id: 1 }, sockets);
  registerAppActivity(a, ctx);
  registerAppActivity(b, ctx);

  a.fire('set-app-activity', { playing: { name: 'One' } });
  a.fire('set-app-activity', { playing: { name: 'Two' } }); // too soon: dropped
  assert.equal(activity.getPublicActivity(1).playing.name, 'One');

  // Another device of the same member is still reporting when one leaves.
  b.fire('set-app-activity', { playing: { name: 'One' } });
  a.fire('disconnect');
  assert.equal(activity.getPublicActivity(1).playing.name, 'One');
  sockets.delete(a);
  b.fire('disconnect');
  assert.equal(activity.getPublicActivity(1), null);

  const c = fakeSocket({ id: 1 }, sockets);
  registerAppActivity(c, ctx);
  db.prepare("INSERT INTO user_preferences VALUES (1, 'share_activity', 'false')").run();
  c.fire('set-app-activity', { playing: { name: 'Hidden' } });
  db.prepare('DELETE FROM user_preferences').run();
  assert.equal(activity.getPublicActivity(1), null);

  const guest = fakeSocket({ id: 1, isGuest: true }, sockets);
  registerAppActivity(guest, ctx);
  guest.fire('set-app-activity', { playing: { name: 'Guest game' } });
  assert.equal(activity.getPublicActivity(1), null);
});
