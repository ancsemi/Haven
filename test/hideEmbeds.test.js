'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const load = (name, globals) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, console, ...globals });
  vm.runInContext(read(`public/js/modules/${name}`).replace(/^export default/m, 'module.exports ='), context, { filename: name });
  return context.module.exports;
};
const classes = () => { const set = new Set(); return { set, toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: c => set.add(c), remove: (...c) => c.forEach(x => set.delete(x)) }; };
const storage = (data = {}) => ({ data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } });
const previews = load('app-link-previews.js', {
  document: { createElement: () => ({ className: '', dataset: {}, style: { setProperty() {} }, set innerHTML(v) {}, querySelector: () => null }), body: { className: 'embed-size-medium' } },
  window: { location: { origin: 'https://haven.test' } }, CSS: { escape: s => s }, t: k => k, Promise,
});
const view = (over = {}) => Object.assign(Object.create(previews), {
  _collapsedEmbeds: new Set(), _openedEmbeds: new Set(), _applyEmbedSize() {}, _embedSize: () => 'medium',
  _extractYouTubeVideoId: () => null, _embedHeaderHtml: () => '', _wireEmbedControls() {}, _applyEmbedSpoiler() {},
  _escapeHtml: s => s, _imgSrcAttr: () => '', _proxyMediaUrl: s => s, _cnt: () => null, _liteOn: () => false,
}, over);
const message = urls => {
  const cards = [], host = { querySelector: () => null, querySelectorAll: () => cards, appendChild: card => cards.push(card) };
  return { cards, container: { querySelectorAll: () => urls.map(href => ({ href, dataset: {}, closest: () => host })) } };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const appearance = (data = {}) => {
  const body = { classList: classes() }, ls = storage(data);
  const app = Object.create(load('app-appearance.js', { localStorage: ls, document: { body, getElementById: () => null, querySelectorAll: () => [] }, t: k => k }));
  return { app, body, ls };
};
test('Hide link previews draws no card and fetches nothing', async () => {
  const asked = [], m = message(['https://a.test/1', 'https://b.test/2']);
  view({ _hideEmbedsOn: () => true, _linkPreviewData: async url => (asked.push(url), { title: url }) })._fetchLinkPreviews(m.container);
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(m.cards.length, 0);
});
test('with link previews shown, cards are fetched and drawn as before', async () => {
  const asked = [], m = message(['https://a.test/1']);
  view({ _hideEmbedsOn: () => false, _linkPreviewData: async url => (asked.push(url), { title: url }) })._fetchLinkPreviews(m.container);
  await settle();
  assert.deepEqual(asked, ['https://a.test/1']);
  assert.equal(m.cards.length, 1);
});
test('Hide pictures and videos folds only the cards that carry a picture or video', async () => {
  const data = { 'https://a.test/text': { title: 'words only' }, 'https://b.test/pic': { title: 'pic', image: 'https://b.test/p.png' }, 'https://c.test/vid': { title: 'vid', video: 'https://c.test/v.mp4' } };
  const m = message(Object.keys(data));
  view({ _hideMediaOn: () => true, _linkPreviewData: async url => data[url], _mediaIcon: () => '', _keepPlayingHtml: () => '', _loopHtml: () => '', _mediaViewHtml: () => '' })._fetchLinkPreviews(m.container);
  await settle();
  assert.deepEqual(m.cards.map(c => c.className.includes('lp-collapsed')), [false, true, true]);
});
test('a picture card stays open while pictures are shown', () => {
  assert.equal(view({ _hideMediaOn: () => false })._embedFolded('u', 0, true), false);
  assert.equal(view({ _hideMediaOn: () => true })._embedFolded('u', 0, false), false);
  assert.equal(view({ _hideMediaOn: () => true, _openedEmbeds: new Set(['u']) })._embedFolded('u', 0, true), false);
});
test('the switch is saved per device and marks the page', () => {
  const { app, body, ls } = appearance();
  assert.equal(app._hideEmbedsOn(), false);
  app._setHideEmbeds(true);
  assert.equal(app._hideEmbedsOn(), true);
  assert.equal(ls.data['haven-hide-embeds'], 'true');
  assert.ok(body.classList.set.has('hide-embeds'));
  app._setHideEmbeds(false);
  assert.equal(ls.data['haven-hide-embeds'], 'false');
  assert.ok(!body.classList.set.has('hide-embeds'));
});
test('the old Off embed size becomes Hide link previews once', () => {
  const { app, ls } = appearance({ 'haven-embed-size': 'off' });
  assert.equal(app._embedSize(), 'medium');
  assert.equal(ls.data['haven-hide-embeds'], 'true');
  assert.equal(app._hideEmbedsOn(), true);
  const kept = appearance({ 'haven-embed-size': 'off', 'haven-hide-embeds': 'false' });
  assert.equal(kept.app._embedSize(), 'medium');
  assert.equal(kept.app._hideEmbedsOn(), false);
  assert.equal(appearance().app._normalizeEmbedSize('off'), 'medium');
});
test('forum cards ask for no link preview while previews are hidden', () => {
  const forum = load('app-forum.js', { document: {}, t: k => k, localStorage: storage() });
  const asked = [], app = Object.assign(Object.create(forum), { _hideEmbedsOn: () => true, _hideMediaOn: () => false, _isImageUrl: () => false, _linkPreviewData: async url => (asked.push(url), {}) });
  const msg = { id: 1, content: 'https://example.com/video' };
  app._forumLoadLinkPreview(msg);
  assert.deepEqual(asked, []);
  app._forumLinkMeta = new Map([['https://example.com/video', { title: 'T', image: 'https://example.com/t.png' }]]);
  assert.equal(app._forumThumbOf(msg), null);
});
test('Settings has both switches, and the size picker no longer has Off', () => {
  const html = read('public/app.html');
  assert.match(html, /id="hide-media-toggle"/);
  assert.match(html, /id="hide-embeds-toggle"/);
  assert.doesNotMatch(html, /data-embed-size="off"/);
  const en = JSON.parse(read('public/locales/en.json'));
  assert.equal(en.settings.embed_display.hide, 'Hide link previews');
  assert.match(read('public/js/modules/app-search.js'), /_searchDeferEmbeds\(item\) \{\s*const content = item\.querySelector\('\.search-result-content'\);\s*if \(!content \|\| this\._hideEmbedsOn\?\.\(\)\) return;/);
  assert.match(read('public/css/style-profile-servers-modals.css'), /\.hide-embeds \.link-preview \{ display: none !important; \}/);
});
