'use strict';

// The "What's new" popup's release notes: which changelog sections someone
// who last saw one version gets on another, and how big a step it is.

const assert = require('node:assert/strict');
const test = require('node:test');
const { sectionsSince, updateLevel, parseSections } = require('../src/changelog');

const MD = `# Changelog

---

## [4.27.0] - Unreleased

### Added
- New thing

## [4.26.1] - 2026-10-20

### Fixed
- A fix

---

## [4.26.0] - 2026-10-18

### Added
- Older thing
`;

test('sections are read with their version, date and text', () => {
  const s = parseSections(MD);
  assert.deepEqual(s.map(x => [x.version, x.date]), [['4.27.0', 'Unreleased'], ['4.26.1', '2026-10-20'], ['4.26.0', '2026-10-18']]);
  assert.equal(s[1].body, '### Fixed\n- A fix');
});

test('notes since a version run up to the current one', () => {
  const v = (since, cur) => sectionsSince(MD, since, cur).map(x => x.version);
  assert.deepEqual(v('4.26.0', '4.26.1'), ['4.26.1']);
  assert.deepEqual(v('4.26.0', '4.27.0-beta.2'), ['4.27.0', '4.26.1']);
  assert.deepEqual(v('4.27.0-beta.1', '4.27.0-beta.2'), ['4.27.0'], 'a beta shows its release so far');
  assert.deepEqual(v('4.26.1', '4.26.1'), []);
  assert.deepEqual(v('', '4.26.1'), ['4.26.1'], 'without a version, the current release');
  assert.deepEqual(v('4.25.0', 'nonsense'), []);
});

test('the size of an update', () => {
  assert.equal(updateLevel('4.26.4', '5.0.0'), 'major');
  assert.equal(updateLevel('4.26.4', '4.27.0-beta.1'), 'minor');
  assert.equal(updateLevel('4.26.3', '4.26.4'), 'patch');
  assert.equal(updateLevel('4.27.0-beta.1', '4.27.0'), 'patch');
  assert.equal(updateLevel('4.27.0', '4.26.4'), null, 'going back is not an update');
  assert.equal(updateLevel('4.27.0', '4.27.0'), null);
});
