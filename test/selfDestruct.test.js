'use strict';

// Self-destructing messages: once destruct_at passes, the message goes and the
// sender's own files go to deleted-attachments, as with any delete. One
// timer waits for the soonest deadline: it catches up at startup, sleeps when
// nothing is left, wakes for a new message and moves on when the message it
// waits for is deleted early. Runs on a fake clock.
//
//   node --test test/selfDestruct.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-self-destruct-'));
process.env.HAVEN_DATA_DIR = DATA;

const { initDatabase } = require('../src/database');
const { UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('../src/paths');
const selfDestruct = require('../src/selfDestruct');

// Same shapes server.js passes in.
const UPLOAD_PATH_RE = /\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
const moveUploadToDeleted = (rel) => {
  fs.mkdirSync(DELETED_ATTACHMENTS_DIR, { recursive: true });
  fs.renameSync(path.join(UPLOADS_DIR, rel), path.join(DELETED_ATTACHMENTS_DIR, rel));
};
const removeUpload = (rel) => fs.unlinkSync(path.join(UPLOADS_DIR, rel));

const MIN = 60 * 1000;
const db = initDatabase();
const author = db.prepare("INSERT INTO users (username, password_hash) VALUES ('sd-author', 'x')").run().lastInsertRowid;
const other = db.prepare("INSERT INTO users (username, password_hash) VALUES ('sd-other', 'x')").run().lastInsertRowid;
const channel = db.prepare("INSERT INTO channels (name, code, created_by) VALUES ('sd', 'abcd1234', ?)").run(author).lastInsertRowid;

const emitted = [];
const io = { to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }) };

const file = (name, owner) => {
  fs.writeFileSync(path.join(UPLOADS_DIR, name), 'x');
  db.prepare("INSERT INTO upload_ownership (rel_path, user_id, bytes, scope) VALUES (?, ?, 1, 'channel')").run(name, owner);
};
const onDisk = (name) => fs.existsSync(path.join(UPLOADS_DIR, name));
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const add = (content, destructAt, user = author) => db.prepare(
  'INSERT INTO messages (channel_id, user_id, content, destruct_at) VALUES (?, ?, ?, ?)'
).run(channel, user, content, destructAt).lastInsertRowid;
const exists = (id) => !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);

test.before(() => { test.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() }); });
test.after(() => {
  selfDestruct.stop();
  test.mock.timers.reset();
  // Windows will not delete the folder while the database is open.
  db.close();
  // Windows can hold the database's files a moment after closing; retry.
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('destructAtFromSeconds accepts 1 second to 24 hours only', () => {
  for (const bad of [undefined, null, '', 'abc', 0, 0.4, -5, 86401, Infinity, NaN]) {
    assert.equal(selfDestruct.destructAtFromSeconds(bad), null, `rejects ${bad}`);
  }
  assert.equal(Date.parse(selfDestruct.destructAtFromSeconds(90)), Date.now() + 90000);
  assert.ok(selfDestruct.destructAtFromSeconds(86400));
});

test('startup removes what came due while the server was down', () => {
  file('sd-mine.png', author);
  file('sd-solo.png', author);
  file('sd-theirs.png', other);
  file('sd-later.png', author);
  // Names someone else's file too, and one of its files has been quoted.
  const expired = add('/uploads/sd-mine.png /uploads/sd-solo.png /uploads/sd-theirs.png', at(-MIN));
  const quote = add('> /uploads/sd-mine.png', null, other);
  const pending = add('/uploads/sd-later.png', at(60 * MIN));
  db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(expired, other, '🔥');

  selfDestruct.start({ db, io, UPLOAD_PATH_RE, moveUploadToDeleted, removeUpload });

  assert.equal(exists(expired), false);
  assert.equal(exists(quote), true);
  assert.equal(exists(pending), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?').get(expired).c, 0);
  assert.deepEqual(emitted.pop(), { room: 'channel:abcd1234', event: 'message-deleted', data: { channelCode: 'abcd1234', messageId: expired } });
  assert.equal(onDisk('sd-mine.png'), false, 'a link in another message does not keep it');
  assert.equal(fs.existsSync(path.join(DELETED_ATTACHMENTS_DIR, 'sd-mine.png')), true);
  assert.equal(onDisk('sd-solo.png'), false, 'own file nothing else uses leaves uploads');
  assert.equal(fs.existsSync(path.join(DELETED_ATTACHMENTS_DIR, 'sd-solo.png')), true, 'and waits in deleted-attachments for the retention window');
  assert.equal(onDisk('sd-theirs.png'), true, "someone else's file untouched");
  assert.equal(onDisk('sd-later.png'), true, 'not due yet');

  // The timer is waiting for the pending one and fires on time.
  test.mock.timers.tick(60 * MIN - 1);
  assert.equal(exists(pending), true);
  test.mock.timers.tick(1);
  assert.equal(exists(pending), false);
  assert.equal(onDisk('sd-later.png'), false);
});

test("the sender's own link in another message does not keep the file either", () => {
  file('sd-reused.png', author);
  const msg = add('/uploads/sd-reused.png', at(MIN));
  const again = add('again /uploads/sd-reused.png', null);
  selfDestruct.schedule(at(MIN));
  test.mock.timers.tick(MIN);
  assert.equal(exists(msg), false);
  assert.equal(onDisk('sd-reused.png'), false);
  assert.equal(exists(again), true, 'the other message itself stays');
});

test('asleep with nothing left, and a new message wakes it', () => {
  // Written without telling the timer: it is asleep, so nothing happens.
  const unseen = add('unseen', at(MIN));
  test.mock.timers.tick(2 * MIN);
  assert.equal(exists(unseen), true, 'no polling while asleep');
  db.prepare('DELETE FROM messages WHERE id = ?').run(unseen);

  const sent = add('sent', at(MIN));
  selfDestruct.schedule(at(MIN));
  test.mock.timers.tick(MIN);
  assert.equal(exists(sent), false);
});

test('deleting the message it waits for moves it to the next one', () => {
  const firstAt = at(MIN);
  const first = add('first', firstAt);
  const second = add('second', at(2 * MIN));
  selfDestruct.schedule(firstAt);
  selfDestruct.schedule(at(2 * MIN));

  db.prepare('DELETE FROM messages WHERE id = ?').run(first);
  selfDestruct.forget(firstAt);

  test.mock.timers.tick(MIN);
  assert.equal(exists(second), true);
  test.mock.timers.tick(MIN);
  assert.equal(exists(second), false);
});

const setKeep = (value) => db.prepare(
  "INSERT OR REPLACE INTO server_settings (key, value) VALUES ('keep_self_destructed_attachments', ?)"
).run(value);
const held = (name) => fs.existsSync(path.join(DELETED_ATTACHMENTS_DIR, name));

test('with keep self destructed attachments off, files are removed for good', () => {
  setKeep('false');
  file('sd-gone.png', author);
  const msg = add('/uploads/sd-gone.png', at(MIN));
  selfDestruct.schedule(at(MIN));
  test.mock.timers.tick(MIN);
  assert.equal(exists(msg), false);
  assert.equal(onDisk('sd-gone.png'), false);
  assert.equal(held('sd-gone.png'), false, 'not held in deleted-attachments');

  setKeep('true');
  file('sd-kept.png', author);
  add('/uploads/sd-kept.png', at(MIN));
  selfDestruct.schedule(at(MIN));
  test.mock.timers.tick(MIN);
  assert.equal(held('sd-kept.png'), true, 'turned back on, files are held again');
});

test('an unreadable keep setting holds the files', () => {
  setKeep('false');
  selfDestruct.stop();
  const busy = new Proxy(db, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop);
      return (sql) => {
        const stmt = target.prepare(sql);
        if (!sql.includes('keep_self_destructed_attachments')) return stmt;
        return { get: () => { throw new Error('database is locked'); } };
      };
    },
  });
  file('sd-busy.png', author);
  const msg = add('/uploads/sd-busy.png', at(-MIN));
  selfDestruct.start({ db: busy, io, UPLOAD_PATH_RE, moveUploadToDeleted, removeUpload });
  assert.equal(exists(msg), false, 'the message still goes');
  assert.equal(held('sd-busy.png'), true, 'but its file is held, not removed for good');
  setKeep('true');
});
