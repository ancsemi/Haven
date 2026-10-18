'use strict';

// The storage layer on the local disk driver: files move where they should
// and the media_objects index follows every move.
//
//   node --test test/storageLocal.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-storage-local-'));
process.env.HAVEN_DATA_DIR = DATA;

const { initDatabase } = require('../src/database');
const { UPLOADS_DIR, UNPROCESSED_DIR } = require('../src/paths');
const storage = require('../src/storage');

const db = initDatabase();
const row = (rel) => db.prepare('SELECT bytes, state, deleted_at FROM media_objects WHERE rel_path = ?').get(rel);
const staged = (name, body) => { const p = path.join(UNPROCESSED_DIR, name); fs.writeFileSync(p, body); return p; };
const live = (rel) => path.join(UPLOADS_DIR, rel);
const held = (rel) => path.join(UPLOADS_DIR, 'deleted-attachments', rel);

test.after(() => {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('admit moves the file into uploads and indexes it live', async () => {
  const src = staged('a.tmp', 'hello');
  const { size } = await storage.admit('stickers/a.png', src, { contentType: 'image/png' });
  assert.equal(size, 5);
  assert.equal(fs.existsSync(src), false, 'the staged copy is gone');
  assert.equal(fs.readFileSync(live('stickers/a.png'), 'utf8'), 'hello');
  assert.deepEqual({ ...row('stickers/a.png'), deleted_at: null }, { bytes: 5, state: 'live', deleted_at: null });

  const head = await storage.head('stickers/a.png');
  assert.equal(head.size, 5);
  assert.match(head.etag, /^W\/"5-[0-9a-f]+"$/, 'the same weak tag express.static sent');
  const got = await storage.getStream('stickers/a.png', { range: { start: 1, end: 3 } });
  const chunks = []; for await (const c of got.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'ell');
  assert.equal(await storage.getStream('nope.png'), null);
});

test('softDelete stamps the deletion time; restore and purge follow the index', async () => {
  await storage.admit('old.png', staged('old.tmp', 'x'));
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(live('old.png'), monthAgo, monthAgo);

  assert.equal(await storage.softDelete('old.png'), true);
  assert.equal(fs.existsSync(live('old.png')), false);
  assert.ok(Date.now() - fs.statSync(held('old.png')).mtimeMs < 60 * 1000, 'stamped now, not the upload time');
  assert.equal(row('old.png').state, 'deleted');
  assert.ok(row('old.png').deleted_at);
  assert.equal(await storage.softDelete('old.png'), false, 'a second delete is a no-op');

  assert.equal(await storage.restore('old.png'), true);
  assert.ok(fs.existsSync(live('old.png')));
  assert.equal(row('old.png').state, 'live');

  await storage.softDelete('old.png');
  await storage.purge('old.png');
  assert.equal(fs.existsSync(held('old.png')), false);
  assert.equal(row('old.png'), undefined);
});

test('remove deletes for good, and a missing file is not an error', async () => {
  await storage.admit('gone.mp3', staged('gone.tmp', 'abc'));
  await storage.remove('gone.mp3');
  assert.equal(fs.existsSync(live('gone.mp3')), false);
  assert.equal(row('gone.mp3'), undefined);
  await storage.remove('gone.mp3');
});

test('names with spaces and accents are accepted; paths leaving uploads are not', async () => {
  await storage.admit('1-ab.my fïle', staged('odd.tmp', 'o'));
  assert.ok(fs.existsSync(live('1-ab.my fïle')));
  for (const bad of ['../escape.png', '/abs.png', 'a/../../b', 'c:\\x', 'a\\b', '']) {
    await assert.rejects(storage.admit(bad, staged('bad.tmp', 'b')), /unsafe upload path/, bad);
    assert.equal(await storage.softDelete(bad), false, bad);
  }
});

test('list walks every file with its size', async () => {
  const all = [];
  for await (const f of storage.list('')) all.push(f.rel);
  assert.ok(all.includes('stickers/a.png'));
  assert.ok(all.includes('1-ab.my fïle'));
  const stickers = [];
  for await (const f of storage.list('stickers/')) stickers.push(f.rel);
  assert.deepEqual(stickers, ['stickers/a.png']);
});
