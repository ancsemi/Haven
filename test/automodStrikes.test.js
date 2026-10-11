'use strict';

// A blocked link is a strike only for a new account (under a week old).
// Established members who try a site the server has not allowed are told
// no, not muted. Word filters always count.
//
//   node --test test/automodStrikes.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { countsAsStrike } = require('../src/automod');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const age = (ms) => new Date(NOW - ms).toISOString().replace('T', ' ').slice(0, 19);

test('blocked links count only for accounts under a week old', () => {
  for (const rule of ['link_blocked', 'link_new_account', 'link_obfuscated', 'link_masked']) {
    assert.equal(countsAsStrike({ rule }, age(2 * DAY), NOW), true, `${rule}, new account`);
    assert.equal(countsAsStrike({ rule }, age(8 * DAY), NOW), false, `${rule}, established account`);
  }
});

test('word filters count for everyone', () => {
  assert.equal(countsAsStrike({ rule: 'word' }, age(400 * DAY), NOW), true);
});

test('an unknown account age counts as established for links', () => {
  assert.equal(countsAsStrike({ rule: 'link_blocked' }, null, NOW), false);
  assert.equal(countsAsStrike({ rule: 'link_blocked' }, 'not a date', NOW), false);
});
