'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const load = (name, globals) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, ...globals });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8').replace(/^export default/m, 'module.exports ='), context, { filename: name });
  return context.module.exports;
};
const globals = {
  document: { createElement: () => ({ className: '', dataset: {}, style: { setProperty() {} }, set innerHTML(v) {}, querySelector: () => null }), body: { className: 'embed-size-medium' } },
  window: { location: { origin: 'https://haven.test' } },
  CSS: { escape: s => s },
  t: k => k,
  Promise,
};
const methods = load('app-link-previews.js', globals);
const view = (over = {}) => Object.assign(Object.create(methods), {
  _collapsedEmbeds: new Set(),
  _openedEmbeds: new Set(),
  _applyEmbedSize() {},
  _embedSize: () => 'medium',
  _extractYouTubeVideoId: () => null,
  _linkPreviewData: async url => ({ title: url, siteName: 'Site' }),
  _embedHeaderHtml: () => '',
  _wireEmbedControls() {},
  _applyEmbedSpoiler() {},
  _escapeHtml: s => s,
  _imgSrcAttr: () => '',
  _cnt: () => null,
}, over);
const message = urls => {
  const cards = [];
  const host = { querySelector: () => null, querySelectorAll: () => cards, appendChild: card => cards.push(card) };
  const links = urls.map(href => ({ href, dataset: {}, closest: () => host }));
  return { cards, container: { querySelectorAll: () => links } };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
test('the third link preview in a message starts folded, the first two stay open', async () => {
  const m = message(['https://a.test/1', 'https://b.test/2', 'https://c.test/3', 'https://d.test/4']);
  view()._fetchLinkPreviews(m.container);
  await settle();
  assert.deepEqual(m.cards.map(c => c.className.includes('lp-collapsed')), [false, false, true, true]);
});
test('a folded extra card stays open once it was opened by hand', async () => {
  const m = message(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);
  view({ _openedEmbeds: new Set(['https://c.test/3']) })._fetchLinkPreviews(m.container);
  await settle();
  assert.deepEqual(m.cards.map(c => c.className.includes('lp-collapsed')), [false, false, false]);
});
test('Start link previews folded folds every card until it is opened', async () => {
  const m = message(['https://a.test/1', 'https://b.test/2']);
  view({ _previewsStartFolded: () => true, _openedEmbeds: new Set(['https://b.test/2']) })._fetchLinkPreviews(m.container);
  await settle();
  assert.deepEqual(m.cards.map(c => c.className.includes('lp-collapsed')), [true, false]);
});
test('a card folded by hand stays folded whatever the settings say', () => {
  assert.equal(view({ _collapsedEmbeds: new Set(['u']), _openedEmbeds: new Set(['u']) })._embedFolded('u'), true);
  assert.equal(view()._embedFolded('u'), false);
});
