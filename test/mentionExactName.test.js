'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
let M;
test.before(async () => { M = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-autocomplete.js')).href)).default; });
const pick = (members, typed) => {
  const dropdown = { innerHTML: '', style: {}, parentElement: null, querySelectorAll: () => [], appendChild() {} };
  global.document = { getElementById: (id) => id === 'mention-dropdown' ? dropdown : null };
  global.t = (k) => k;
  try {
    M._showMentionDropdown.call({ ...M, mentionQuery: typed.toLowerCase(), channelMembers: members, _nicknames: {}, user: {}, _mentionableRoles: [], _escapeHtml: (s) => String(s) });
    return (dropdown.innerHTML.match(/mention-item active" data-username="([^"]*)"/) || [])[1];
  } finally { delete global.document; delete global.t; }
};
const member = (id, username, loginName = username) => ({ id, username, loginName });
test('a fully typed name picks that member even when a longer name comes first', () => {
  assert.equal(pick([member(1, 'MutantRabbit7670'), member(2, 'MutantRabbit767')], 'MutantRabbit767'), 'MutantRabbit767');
});
test('a fully typed login picks that member over a name that merely starts with it', () => {
  assert.equal(pick([member(1, 'Dispencer23'), member(2, 'Dispencer2')], 'dispencer2'), 'Dispencer2');
});
test('a fully typed display name still picks that member and inserts the login', () => {
  assert.equal(pick([member(1, 'Dan'), member(2, 'MutantRabbit767', 'admin')], 'MutantRabbit767'), 'admin');
});
test('a partial name keeps the order of the member list', () => {
  assert.equal(pick([member(1, 'Dannie'), member(2, 'Danny')], 'dan'), 'Dannie');
});
