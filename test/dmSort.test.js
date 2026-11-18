'use strict';

// DM sort (preference dm_sort): the DM list shows the newest message first,
// goes by name, or keeps the order the member dragged it into. The pick is
// saved on the account, and pinned DMs stay above whatever it is.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { DM_SORT_MODES: SERVER_MODES, cleanDmOrder, MAX_DM_ORDER } = require('../src/pinnedDms');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let DM_SORT_MODES, pickDmSortMode, orderDms, parseDmOrder;
test.before(async () => {
  ({ DM_SORT_MODES, pickDmSortMode, orderDms, parseDmOrder } =
    await import(pathToFileURL(path.join(__dirname, '..', 'public/js/modules/app-dm-sort.js')).href));
});

const dm = (code, name, latestMessageId) => ({ code, name, latestMessageId });
const nameOf = (ch) => ch.name;
const codes = (list) => list.map(ch => ch.code);
// As the server sends them: by position, then by a name nobody sees.
const DMS = [dm('c1', 'mallory', 40), dm('c2', 'Bob', 0), dm('c3', 'alice', 90), dm('c4', 'Zed', 71), dm('c5', 'carol', undefined)];

test('the client and the server know the same sorts', () => {
  assert.deepEqual(DM_SORT_MODES, ['recent', 'alpha', 'manual']);
  assert.deepEqual(SERVER_MODES, DM_SORT_MODES);
});

test('latest puts the newest message first and DMs with no messages last, by name', () => {
  assert.deepEqual(codes(orderDms(DMS, 'recent', null, nameOf)), ['c3', 'c4', 'c1', 'c2', 'c5']);
});

test('a DM moves to the top when a message arrives in it', () => {
  const list = DMS.map(ch => ({ ...ch }));
  list[1].latestMessageId = 91;
  assert.deepEqual(codes(orderDms(list, 'recent', null, nameOf)), ['c2', 'c3', 'c4', 'c1', 'c5']);
});

test('alphabetical goes by the shown name whatever its capitals', () => {
  assert.deepEqual(codes(orderDms(DMS, 'alpha', null, nameOf)), ['c3', 'c2', 'c5', 'c1', 'c4']);
});

test('two DMs with the same name always come out in the same order', () => {
  const twins = [dm('zz', 'sam', 5), dm('aa', 'sam', 5)];
  assert.deepEqual(codes(orderDms(twins, 'alpha', null, nameOf)), ['aa', 'zz']);
  assert.deepEqual(codes(orderDms(twins, 'recent', null, nameOf)), ['aa', 'zz']);
});

test('manual keeps the dragged order and adds new DMs after it', () => {
  assert.deepEqual(codes(orderDms(DMS, 'manual', ['c4', 'gone', 'c2'], nameOf)), ['c4', 'c2', 'c1', 'c3', 'c5']);
  assert.deepEqual(codes(orderDms(DMS, 'manual', [], nameOf)), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(codes(orderDms(DMS, 'manual', null, nameOf)), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('sorting leaves the list it was given alone', () => {
  const before = codes(DMS);
  DM_SORT_MODES.forEach(mode => orderDms(DMS, mode, ['c5'], nameOf));
  assert.deepEqual(codes(DMS), before);
});

test('the account pick wins, then this browser\'s old pick', () => {
  assert.equal(pickDmSortMode('alpha', 'manual', true), 'alpha');
  assert.equal(pickDmSortMode(undefined, 'alpha', false), 'alpha');
  assert.equal(pickDmSortMode('newest', 'manual', false), 'manual', 'an unknown account value is ignored');
});

test('with nothing picked, a hand-arranged list stays manual and any other shows the latest first', () => {
  assert.equal(pickDmSortMode(undefined, null, true), 'manual');
  assert.equal(pickDmSortMode(undefined, null, false), 'recent');
  assert.equal(pickDmSortMode('', 'bogus', false), 'recent');
});

test('set-preference takes only the three sorts for dm_sort and it can be deleted', () => {
  const src = read('src/socketHandlers/users.js');
  assert.match(src, /'dm_sort',\n/);
  assert.match(src, /if \(key === 'dm_sort' && !DM_SORT_MODES\.includes\(value\)\) return;/);
  assert.match(src, /const deletableKeys = \[[^\]]*'dm_sort'[^\]]*\]/);
});

test('set-preference keeps dm_order through the cleaner and it can be deleted', () => {
  const src = read('src/socketHandlers/users.js');
  assert.match(src, /'dm_order',\n/);
  assert.match(src, /stored = cleanDmOrder\(db, socket\.user\.id, value\);\n\s*if \(!stored\) return;/);
  assert.match(src, /const deletableKeys = \[[^\]]*'dm_order'[^\]]*\]/);
});

// A database that answers the one query the cleaner makes: the DM codes this
// account is a member of.
const dbWith = (codes) => ({ prepare: () => ({ all: () => codes.map(code => ({ code })) }) });

test('a saved manual order keeps only your own DMs, each once, in the order given', () => {
  const db = dbWith(['aaaa1111', 'bbbb2222', 'cccc3333']);
  assert.equal(cleanDmOrder(db, 1, JSON.stringify(['cccc3333', 'zzzz9999', 'aaaa1111', 'cccc3333', 7, '<b>'])), '["cccc3333","aaaa1111"]');
  assert.equal(cleanDmOrder(db, 1, JSON.stringify(['zzzz9999'])), null);
  assert.equal(cleanDmOrder(db, 1, 'not json'), null);
  assert.equal(cleanDmOrder(db, 1, '"aaaa1111"'), null);
});

test('a saved manual order holds as many DMs as anyone has', () => {
  const codes = Array.from({ length: MAX_DM_ORDER + 20 }, (_, i) => 'c' + String(i).padStart(7, '0'));
  const kept = JSON.parse(cleanDmOrder(dbWith(codes), 1, JSON.stringify(codes)));
  assert.equal(kept.length, MAX_DM_ORDER);
  assert.deepEqual(kept.slice(0, 3), codes.slice(0, 3));
  assert.ok(JSON.stringify(codes.slice(0, MAX_DM_ORDER)).length < 20000, 'fits under the size the handler lets through');
});

test('a saved manual order reads back as a list, and anything else as none', () => {
  assert.deepEqual(parseDmOrder('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseDmOrder('["a",3,null,""]'), ['a']);
  assert.deepEqual(parseDmOrder('{"a":1}'), []);
  assert.deepEqual(parseDmOrder('nope'), []);
  assert.deepEqual(parseDmOrder(null), []);
  assert.deepEqual(parseDmOrder(undefined), []);
});

test('the sidebar sorts DMs with the pick in force and pins stay above it', () => {
  const src = read('public/js/modules/app-channels.js');
  const sorted = src.indexOf('let sortedDms = this._orderDms(dmChannels, getDmName);');
  const split = src.indexOf('this._splitPinnedDms(sortedDms)');
  assert.ok(sorted > 0 && split > sorted);
  assert.doesNotMatch(src, /last_activity/, 'DMs carry latestMessageId, never last_activity');
});

test('Recent Activity in Organize DMs sorts by the newest message too', () => {
  const src = read('public/js/modules/app-channel-organize.js');
  assert.match(src, /const sortGroup = \(arr, mode\) => this\._orderDms\(arr, getDmName, mode, \[\]\);/);
  assert.doesNotMatch(src, /last_activity/);
});

test('a new DM message redraws the list when the latest is shown first', () => {
  const src = read('public/js/modules/app-socket-channels.js');
  assert.match(src, /msgChannel\.is_dm && this\._dmSortMode\(\) === 'recent'/);
});

test('dragging a DM and the Organize DMs picker save the sort on the account', () => {
  assert.match(read('public/js/modules/app-channel-unread.js'), /this\._setDmSortMode\('manual'\);/);
  assert.match(read('public/js/modules/app-channel-menu.js'), /this\._pickDmSortMode\(mode\);/);
  assert.match(read('public/js/modules/app-dm-sort.js'), /this\.socket\.emit\('set-preference', \{ key: 'dm_sort', value: mode \}\);/);
});

test('the arranged order is saved on the account from the drag and from Organize DMs', () => {
  assert.match(read('public/js/modules/app-channel-unread.js'), /this\._saveDmManualOrder\(newOrder\);/);
  assert.match(read('public/js/modules/app-channel-organize.js'), /this\._saveDmManualOrder\(this\._dmOrganizeList\.map\(c => c\.code\)\);/);
  assert.match(read('public/js/modules/app-dm-sort.js'), /this\.socket\.emit\('set-preference', \{ key: 'dm_order', value \}\);/);
});

test('picking Manual order with nothing arranged keeps the list as it is shown', () => {
  const src = read('public/js/modules/app-dm-sort.js');
  assert.match(src, /_pickDmSortMode\(mode\) \{\n  if \(mode === 'manual' && !this\._dmManualOrder\(\)\.length\) \{/);
  assert.match(src, /document\.querySelectorAll\('#dm-list \.dm-item'\)/);
  assert.match(src, /if \(shown\.length\) this\._saveDmManualOrder\(shown\);\n  \}\n  this\._setDmSortMode\(mode\);/);
  assert.match(src, /this\._pickDmSortMode\(item\.dataset\.dmSort\);/);
  assert.match(read('public/js/modules/app-channel-menu.js'), /if \(mode === 'manual'\) this\._dmOrganizeList = this\._orderDms\(this\._dmOrganizeList \|\| \[\], null, 'manual'\);/);
});

test('the Direct Messages header has the sort button and its three choices', () => {
  const html = read('public/app.html');
  assert.match(html, /id="dm-sort-btn"/);
  ['recent', 'alpha', 'manual'].forEach(mode => assert.match(html, new RegExp(`data-dm-sort="${mode}"`)));
  const en = JSON.parse(read('public/locales/en.json')).channels;
  ['dm_sort', 'dm_sort_recent', 'dm_sort_alpha', 'dm_sort_manual'].forEach(key => assert.ok(en[key], key));
});
