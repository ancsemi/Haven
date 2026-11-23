'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const load = (name, globals) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, console, ...globals });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8').replace(/^export default/m, 'module.exports ='), context, { filename: name });
  return context.module.exports;
};
const setup = (extra = {}) => {
  const data = new Map();
  const localStorage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  const app = { ...load('app-drafts.js', { localStorage, document: {}, window: {} }), user: { id: 7 }, currentChannel: 'aaaaaaaa', ...extra };
  return { app, localStorage, data };
};
test('a forum post being written is kept per forum and comes back after a reload', () => {
  const { app, localStorage } = setup();
  app._forumDraftKeep('ffffffff', { title: 'Idea', body: 'Long text https://x.test', tags: ['art'], nsfw: true });
  app._draftKeep('aaaaaaaa', 'a channel draft');
  app._draftPersist();
  const reloaded = { ...load('app-drafts.js', { localStorage, document: {}, window: {} }), user: { id: 7 } };
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded._forumDraftGet('ffffffff'))), { title: 'Idea', body: 'Long text https://x.test', tags: ['art'], nsfw: true });
  assert.equal(reloaded._forumDraftGet('gggggggg'), null);
  assert.equal(reloaded._draftStore().aaaaaaaa, 'a channel draft');
});
test('an emptied or posted forum draft is forgotten and never touches channel drafts', () => {
  const { app, data } = setup();
  app._draftKeep('aaaaaaaa', 'a channel draft');
  app._forumDraftKeep('ffffffff', { title: 'Idea', body: '' });
  app._forumDraftKeep('ffffffff', null);
  assert.equal(app._forumDraftGet('ffffffff'), null);
  app._forumDraftKeep('ffffffff', { title: '  ', body: '' });
  assert.equal(app._forumDraftGet('ffffffff'), null);
  assert.deepEqual(JSON.parse(data.get('haven_drafts_7')), { aaaaaaaa: 'a channel draft' });
  assert.equal(app._draftStore().aaaaaaaa, 'a channel draft');
});
test('a long forum post is saved whole', () => {
  const { app } = setup();
  const body = 'word '.repeat(5000);
  app._forumDraftKeep('ffffffff', { title: 'Long', body, tags: [], nsfw: false });
  assert.equal(app._forumDraftGet('ffffffff').body, body);
});
test('a refused post that arrives after the forum was left is kept as that forum draft, not lost', () => {
  const kept = [];
  const opened = [];
  const forum = load('app-forum.js', { t: k => k, document: { getElementById: () => null } });
  const post = { code: 'ffffffff', title: 'Idea', body: 'text', tags: [], nsfw: false, at: Date.now() };
  forum._forumRestoreDraft.call({ _forumPostDraft: post, currentChannel: 'aaaaaaaa', _forumDraftKeep: (c, d) => kept.push([c, d.title]), _openForumComposer: () => opened.push(1) });
  assert.deepEqual(kept, [['ffffffff', 'Idea']]);
  assert.equal(opened.length, 0);
  forum._forumRestoreDraft.call({ _forumPostDraft: { ...post }, currentChannel: 'ffffffff', _forumDraftKeep: () => kept.push('no'), _openForumComposer: () => opened.push(1) });
  assert.equal(opened.length, 1);
  assert.equal(kept.length, 1);
});
test('the New Post window saves as you type, clears on post or Cancel, and keeps on close', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-forum.js'), 'utf8');
  assert.match(src, /draft = existing \? null : \(draft \|\| this\._forumDraftGet\(code\)\)/);
  assert.match(src, /overlay\.addEventListener\('input', keep\)/);
  assert.match(src, /#forum-post-cancel'\)\.addEventListener\('click', \(\) => \{ !existing && this\._forumDraftKeep\(code, null\)/);
  assert.match(src, /this\._forumPostDraft = [^\n]*\n\s*this\._forumDraftKeep\(code, null\)/);
});
