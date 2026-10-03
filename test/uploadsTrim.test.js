'use strict';

// Auto-Cleanup's uploads limit: the oldest messages with files go until the
// uploads folder is back under the limit, and nothing else is touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { uploadsSizeBytes, trimUploadsToLimit } = require('../src/uploadsTrim');

const KB = 1024;
const RE = /\/uploads\/([A-Za-z0-9_.-]+)/g;
const extractPaths = (content) => {
  const out = [];
  if (typeof content !== 'string') return out;
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(content)) !== null) out.push(m[1]);
  return out;
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-uploads-trim-'));
  const moved = [];
  const file = (name, kb) => fs.writeFileSync(path.join(root, name), Buffer.alloc(kb * KB));
  const move = (rel) => {
    const dst = path.join(root, 'deleted-attachments', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(path.join(root, rel), dst);
    moved.push(rel);
  };
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE channels (id INTEGER PRIMARY KEY, cleanup_exempt INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, content TEXT, e2e_files TEXT,
      is_archived INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE pinned_messages (message_id INTEGER);
    CREATE TABLE reactions (message_id INTEGER, emoji TEXT);
    INSERT INTO channels (id, cleanup_exempt) VALUES (1, 0), (2, 1);
  `);
  let n = 0;
  const msg = (content, opts = {}) => {
    n++;
    const at = `2026-01-${String(n).padStart(2, '0')} 12:00:00`;
    return db.prepare('INSERT INTO messages (channel_id, content, e2e_files, is_archived, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(opts.channel || 1, content, opts.e2e || null, opts.archived ? 1 : 0, at).lastInsertRowid;
  };
  const ids = () => db.prepare('SELECT id FROM messages ORDER BY id').all().map(r => r.id);
  return { root, db, file, msg, move, moved, ids };
}

test('the folder size leaves out deleted-attachments', async () => {
  const t = setup();
  t.file('a.png', 10);
  fs.mkdirSync(path.join(t.root, 'deleted-attachments'));
  fs.writeFileSync(path.join(t.root, 'deleted-attachments', 'old.png'), Buffer.alloc(50 * KB));
  assert.equal(await uploadsSizeBytes(t.root), 10 * KB);
});

test('the oldest messages with files go, just enough to get under the limit', async () => {
  const t = setup();
  t.file('avatar.png', 30);           // no message points at it
  for (const f of ['one', 'two', 'three', 'four']) t.file(`${f}.png`, 20);
  const text = t.msg('just text, no file');
  const one = t.msg('/uploads/one.png');
  const two = t.msg('look /uploads/two.png');
  const three = t.msg('/uploads/three.png');
  const four = t.msg('/uploads/four.png');
  t.db.prepare('INSERT INTO reactions (message_id, emoji) VALUES (?, ?)').run(one, 'x');

  // 110 KB in the folder, limit 75: two 20 KB files have to go.
  const r = await trimUploadsToLimit({ db: t.db, uploadsDir: t.root, maxBytes: 75 * KB, extractPaths: extractPaths, move: t.move });
  assert.equal(r.deleted, 2);
  assert.deepEqual(t.ids(), [text, three, four]);
  assert.deepEqual(t.moved.sort(), ['one.png', 'two.png']);
  assert.ok(fs.existsSync(path.join(t.root, 'avatar.png')), 'files no message points at stay');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM reactions').get().c, 0);
  assert.ok(await uploadsSizeBytes(t.root) <= 75 * KB);
  void two;
});

test('pinned, archived and exempt messages stay, and so do messages whose files are gone', async () => {
  const t = setup();
  for (const f of ['p', 'a', 'e', 'x']) t.file(`${f}.png`, 20);
  const pinned = t.msg('/uploads/p.png');
  t.db.prepare('INSERT INTO pinned_messages (message_id) VALUES (?)').run(pinned);
  const archived = t.msg('/uploads/a.png', { archived: true });
  const exempt = t.msg('/uploads/e.png', { channel: 2 });
  const missing = t.msg('/uploads/nothere.png');
  const plain = t.msg('/uploads/x.png');

  const r = await trimUploadsToLimit({ db: t.db, uploadsDir: t.root, maxBytes: 10 * KB, extractPaths, move: t.move });
  assert.equal(r.deleted, 1);
  assert.deepEqual(t.ids(), [pinned, archived, exempt, missing]);
  assert.deepEqual(t.moved, ['x.png']);
  void plain;
});

test('a file another message still links to is not moved', async () => {
  const t = setup();
  t.file('shared.png', 40);
  t.file('late.png', 5);
  t.msg('/uploads/shared.png');
  const later = t.msg('same file again /uploads/shared.png');
  t.msg('/uploads/late.png');
  await trimUploadsToLimit({ db: t.db, uploadsDir: t.root, maxBytes: 20 * KB, extractPaths, move: t.move });
  assert.ok(t.ids().includes(later));
  assert.deepEqual(t.moved, []);
  assert.ok(fs.existsSync(path.join(t.root, 'shared.png')));
});

test('encrypted DM files count, and their message goes (the release trigger moves the file)', async () => {
  const t = setup();
  t.file('dm.bin', 30);
  const dm = t.msg('ciphertext', { e2e: JSON.stringify(['dm.bin']) });
  const r = await trimUploadsToLimit({ db: t.db, uploadsDir: t.root, maxBytes: 10 * KB, extractPaths, move: t.move });
  assert.equal(r.deleted, 1);
  assert.ok(!t.ids().includes(dm));
  assert.deepEqual(t.moved, [], 'the move is left to the e2e release sweep');
});

test('under the limit, or with the limit off, nothing happens', async () => {
  const t = setup();
  t.file('a.png', 10);
  const id = t.msg('/uploads/a.png');
  assert.equal((await trimUploadsToLimit({ db: t.db, uploadsDir: t.root, maxBytes: 20 * KB, extractPaths, move: t.move })).deleted, 0);
  assert.equal((await trimUploadsToLimit({ db: t.db, uploadsDir: t.root, maxBytes: 0, extractPaths, move: t.move })).deleted, 0);
  assert.deepEqual(t.ids(), [id]);
});
