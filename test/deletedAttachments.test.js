'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_DELETED_RETENTION_DAYS,
  resolveDeletedRetentionDays,
  purgeDeletedAttachments,
} = require('../src/deletedAttachments');

const DAY = 24 * 60 * 60 * 1000;

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-deleted-'));
  const now = Date.now();
  const write = (rel, ageDays) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    const when = new Date(now - ageDays * DAY);
    fs.utimesSync(full, when, when);
    return full;
  };
  return { root, now, write };
}

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

test('purgeDeletedAttachments removes only files older than the window, in sub-folders too, and prunes empty folders', () => {
  const { root, now, write } = makeTree();
  try {
    const oldTop = write('old.png', 8);
    const freshTop = write('fresh.png', 2);
    const oldNested = write('2026-01/old-nested.png', 30);
    const freshNested = write('2026-09/fresh-nested.png', 1);
    const edge = write('edge.png', 7.01);

    const removed = purgeDeletedAttachments(root, 7, now);

    assert.equal(removed, 3);
    assert.equal(fs.existsSync(oldTop), false);
    assert.equal(fs.existsSync(oldNested), false);
    assert.equal(fs.existsSync(edge), false);
    assert.equal(fs.existsSync(freshTop), true);
    assert.equal(fs.existsSync(freshNested), true);
    // The emptied sub-folder goes, the one still holding a file stays, and
    // the root itself is always left in place.
    assert.equal(fs.existsSync(path.join(root, '2026-01')), false);
    assert.equal(fs.existsSync(path.join(root, '2026-09')), true);
    assert.equal(fs.existsSync(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('purgeDeletedAttachments uses the default window when the setting is unusable', () => {
  const { root, now, write } = makeTree();
  try {
    const sixDays = write('six.png', 6);
    const eightDays = write('eight.png', 8);
    assert.equal(purgeDeletedAttachments(root, '', now), 1);
    assert.equal(fs.existsSync(sixDays), true);
    assert.equal(fs.existsSync(eightDays), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('purgeDeletedAttachments is a no-op for a missing folder', () => {
  assert.equal(purgeDeletedAttachments(path.join(os.tmpdir(), 'haven-does-not-exist-' + Date.now()), 7), 0);
  assert.equal(purgeDeletedAttachments('', 7), 0);
});
