'use strict';
// Blocked names: words no username or display name may contain.
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseBlockedNames, blockedWordIn, nameRefusal, REFUSAL } = require('../src/blockedNames');

test('the list is one word per line, cleaned and without repeats', () => {
  assert.deepEqual(parseBlockedNames('badword\n  BadWord \n\nscam, spam\nx\n'), ['badword', 'scam', 'spam']);
  assert.deepEqual(parseBlockedNames(''), []);
  assert.equal(parseBlockedNames(Array.from({ length: 500 }, (_, i) => `word${i}`).join('\n')).length, 300);
});

test('a blocked word is found anywhere in a name, however it is written', () => {
  const words = ['badword', 'scam'];
  for (const name of ['badword', 'xXbadwordXx', 'BAD_WORD', 'b4dw0rd', 'Bád Wörd', 'b.a.d.w.o.r.d', 'Scammer99', 'ѕсаm', '5cam']) {
    assert.equal(!!blockedWordIn(name, words), true, `${name} should be caught`);
  }
  assert.equal(blockedWordIn('ki11er', ['killer']), 'killer', '1 reads as l too');
  assert.equal(blockedWordIn('n1ce', ['nice']), 'nice', '1 reads as i too');
});

test('names without a blocked word pass', () => {
  for (const name of ['goodname', 'bad', 'word', 'scab', 'Sam']) {
    assert.equal(blockedWordIn(name, ['badword', 'scam']), null, `${name} should pass`);
  }
  assert.equal(blockedWordIn('anything', []), null);
});

function fakeDb(value, fail = false) {
  return { prepare: () => ({ get: () => { if (fail) throw new Error('disk'); return value === null ? undefined : { value }; } }) };
}

test('the refusal reads the saved list, and refuses when it cannot', () => {
  assert.equal(nameRefusal(fakeDb('badword'), 'mybadword'), REFUSAL);
  assert.equal(nameRefusal(fakeDb('badword'), 'friendly'), null);
  assert.equal(nameRefusal(fakeDb(null), 'anything'), null);
  const warn = console.warn; console.warn = () => {};
  try { assert.ok(nameRefusal(fakeDb('', true), 'friendly')); } finally { console.warn = warn; }
});
