'use strict';

// A bulk cleanup's audit rows list every removed account by id and username,
// split over as many rows as the list needs, since a row keeps 4000
// characters of details and a cleanup can remove 10,000 accounts.

const assert = require('node:assert/strict');
const test = require('node:test');

// moderation.js loads src/auth.js, which needs a secret and keeps cleanup
// timers running, so end the process once done.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const { bulkRemoveDetails } = require('../src/socketHandlers/moderation');

test.after(() => setImmediate(() => process.exit(0)));

const summary = { removed: 0, requested: 0, ipBanned: 0, scrubMessages: false, reason: 'Bulk cleanup' };

test('a short list stays on one row with the summary', () => {
  const rows = bulkRemoveDetails({ ...summary, removed: 2 }, [{ id: 5, username: 'eve' }, { id: 6, username: 'mallory' }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { ...summary, removed: 2, accounts: [{ id: 5, username: 'eve' }, { id: 6, username: 'mallory' }] });
});

test('the largest cleanup splits into numbered rows that each fit', () => {
  // The longest usernames, and ids as long as a big server's.
  const accounts = Array.from({ length: 10000 }, (_, i) => ({ id: 1000000 + i, username: `spam_${String(i).padStart(15, '0')}` }));
  const rows = bulkRemoveDetails({ ...summary, removed: 10000, requested: 10000, reason: 'x'.repeat(200) }, accounts);
  assert.ok(rows.length > 1);
  for (const [i, r] of rows.entries()) {
    assert.ok(JSON.stringify(r).length <= 4000, `row ${i + 1} fits`);
    assert.equal(r.part, i + 1);
    assert.equal(r.parts, rows.length);
    assert.ok(r.accounts.length > 0);
  }
  assert.equal(rows[0].removed, 10000);
  assert.ok(!('removed' in rows[1]), 'only the first row carries the summary');
  assert.deepEqual(rows.flatMap(r => r.accounts), accounts);
});
