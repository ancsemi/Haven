'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-deleted-'));
process.env.HAVEN_DATA_DIR = DATA;

const { initDatabase } = require('../src/database');
const { DELETED_ATTACHMENTS_DIR } = require('../src/paths');
const storage = require('../src/storage');
const {
  DEFAULT_DELETED_RETENTION_DAYS,
  resolveDeletedRetentionDays,
  purgeDeletedAttachments,
} = require('../src/deletedAttachments');

const DAY = 24 * 60 * 60 * 1000;
const db = initDatabase();
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

// A file waiting in deleted-attachments, deleted `ageDays` ago as the index has it.
function deleted(rel, ageDays, now) {
  const full = path.join(DELETED_ATTACHMENTS_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
  db.prepare("INSERT INTO media_objects (rel_path, bytes, state, deleted_at) VALUES (?, 1, 'deleted', ?)")
    .run(rel, sqlTime(now - ageDays * DAY));
  return full;
}
const indexed = (rel) => !!db.prepare('SELECT 1 FROM media_objects WHERE rel_path = ?').get(rel);

test.after(() => {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('resolveDeletedRetentionDays falls back to the default for anything that is not a valid day count', () => {
  assert.equal(DEFAULT_DELETED_RETENTION_DAYS, 7);
  assert.equal(resolveDeletedRetentionDays(undefined), 7);
  assert.equal(resolveDeletedRetentionDays(null), 7);
  assert.equal(resolveDeletedRetentionDays(''), 7);
  assert.equal(resolveDeletedRetentionDays('0'), 7);
  assert.equal(resolveDeletedRetentionDays('-3'), 7);
  assert.equal(resolveDeletedRetentionDays('abc'), 7);
  assert.equal(resolveDeletedRetentionDays('99999'), 7);
  assert.equal(resolveDeletedRetentionDays('1'), 1);
  assert.equal(resolveDeletedRetentionDays(' 30 '), 30);
  assert.equal(resolveDeletedRetentionDays(3650), 3650);
});

test('purgeDeletedAttachments removes only files deleted longer ago than the window, in sub-folders too, and prunes empty folders', async () => {
  const now = Date.now();
  const oldTop = deleted('old.png', 8, now);
  const freshTop = deleted('fresh.png', 2, now);
  const oldNested = deleted('2026-01/old-nested.png', 30, now);
  const freshNested = deleted('2026-09/fresh-nested.png', 1, now);
  const edge = deleted('edge.png', 7.01, now);

  const removed = await purgeDeletedAttachments(db, storage, 7, now);

  assert.equal(removed, 3);
  assert.equal(fs.existsSync(oldTop), false);
  assert.equal(fs.existsSync(oldNested), false);
  assert.equal(fs.existsSync(edge), false);
  assert.equal(fs.existsSync(freshTop), true);
  assert.equal(fs.existsSync(freshNested), true);
  assert.equal(indexed('old.png'), false, 'purged files leave the index');
  assert.equal(indexed('fresh.png'), true);
  // The emptied sub-folder goes, the one still holding a file stays, and
  // the root itself is always left in place.
  assert.equal(fs.existsSync(path.join(DELETED_ATTACHMENTS_DIR, '2026-01')), false);
  assert.equal(fs.existsSync(path.join(DELETED_ATTACHMENTS_DIR, '2026-09')), true);
  assert.equal(fs.existsSync(DELETED_ATTACHMENTS_DIR), true);
});

test('purgeDeletedAttachments uses the default window when the setting is unusable', async () => {
  const now = Date.now();
  const sixDays = deleted('six.png', 6, now);
  const eightDays = deleted('eight.png', 8, now);
  assert.equal(await purgeDeletedAttachments(db, storage, '', now), 1);
  assert.equal(fs.existsSync(sixDays), true);
  assert.equal(fs.existsSync(eightDays), false);
});

test('purgeDeletedAttachments leaves live files alone and is a no-op with nothing due', async () => {
  db.prepare("INSERT INTO media_objects (rel_path, bytes, state, created_at) VALUES ('live.png', 1, 'live', '2000-01-01 00:00:00')").run();
  assert.equal(await purgeDeletedAttachments(db, storage, 7), 0);
  assert.equal(indexed('live.png'), true);
});
