'use strict';

// Reconcile rebuilds media_objects from what storage holds: a no-op on an
// index that is right, and a repair of one that drifted.
//
//   node --test test/storageReconcile.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-reconcile-'));
process.env.HAVEN_DATA_DIR = DATA;

const { initDatabase } = require('../src/database');
const { UPLOADS_DIR } = require('../src/paths');
const storage = require('../src/storage');
const { reconcile } = require('../src/storage/reconcile');

const db = initDatabase();
const put = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(UPLOADS_DIR, rel)), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, rel), body);
};
const rows = () => db.prepare('SELECT rel_path, bytes, state FROM media_objects ORDER BY rel_path').all();

test.after(() => {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a fresh install of the index picks up every file, deleted ones as deleted', async () => {
  put('a.png', 'aaa');
  put('stickers/s.png', 'ss');
  put('deleted-attachments/old.png', 'o');
  put('bot-audio/tmp.mp3', 'skip me');
  const s = await reconcile(db, storage.getStorage());
  assert.deepEqual(s, { added: 3, fixed: 0, dropped: 0, objects: 3 });
  assert.deepEqual(rows(), [
    { rel_path: 'a.png', bytes: 3, state: 'live' },
    { rel_path: 'old.png', bytes: 1, state: 'deleted' },
    { rel_path: 'stickers/s.png', bytes: 2, state: 'live' },
  ]);
  assert.ok(db.prepare("SELECT deleted_at FROM media_objects WHERE rel_path = 'old.png'").get().deleted_at);
});

test('on an index that is right it changes nothing', async () => {
  assert.deepEqual(await reconcile(db, storage.getStorage()), { added: 0, fixed: 0, dropped: 0, objects: 3 });
});

test('it repairs an index that drifted', async () => {
  db.prepare("UPDATE media_objects SET bytes = 99 WHERE rel_path = 'a.png'").run();
  db.prepare("INSERT INTO media_objects (rel_path, bytes, state) VALUES ('ghost.png', 5, 'live')").run();
  fs.renameSync(path.join(UPLOADS_DIR, 'stickers/s.png'), path.join(UPLOADS_DIR, 'deleted-attachments/s-moved.png'));
  put('new.webm', 'nnnn');
  const s = await reconcile(db, storage.getStorage());
  assert.deepEqual(s, { added: 2, fixed: 1, dropped: 2, objects: 4 });
  assert.deepEqual(rows(), [
    { rel_path: 'a.png', bytes: 3, state: 'live' },
    { rel_path: 'new.webm', bytes: 4, state: 'live' },
    { rel_path: 'old.png', bytes: 1, state: 'deleted' },
    { rel_path: 's-moved.png', bytes: 2, state: 'deleted' },
  ]);
});

test('the first start indexes what is already there, once', async () => {
  db.prepare('DELETE FROM media_objects').run();
  db.prepare("DELETE FROM server_settings WHERE key = 'media_index_built'").run();
  await storage.prepare(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_objects').get().n, 4);
  db.prepare('DELETE FROM media_objects').run();
  await storage.prepare(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_objects').get().n, 0, 'later starts leave the index to its writers');
  await reconcile(db, storage.getStorage());
});

test('a live file and a deleted copy under the same name count once, as live', async () => {
  put('deleted-attachments/a.png', 'older');
  await reconcile(db, storage.getStorage());
  assert.deepEqual(db.prepare("SELECT bytes, state FROM media_objects WHERE rel_path = 'a.png'").get(), { bytes: 3, state: 'live' });
});
