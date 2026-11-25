'use strict';

// A muted channel's unread count may show on its own row, but it must not
// light an aggregate: the @ button count, a category's dot or collapsed
// count, a parent channel's dot, or a tag row's dot and count.
//
//   node --test test/mutedUnreadAggregates.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

class El {
  constructor(tag, dataset = {}) { this.tag = tag; this.dataset = dataset; this.children = []; this.className = ''; this.style = {}; this.textContent = ''; this.title = ''; this.parent = null; }
  hit(sel) { const m = /^(?::scope > )?\.([\w-]+)$/.exec(sel); return m && this.className.split(' ').includes(m[1]); }
  querySelector(sel) { return this.children.find(c => c.hit(sel)) || null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { this.parent && (this.parent.children = this.parent.children.filter(c => c !== this)); }
}

function load(muted, counts, channels) {
  const store = { haven_muted_channels: JSON.stringify(muted) };
  const lists = { cats: [], items: [], tags: [] };
  const context = vm.createContext({
    module: { exports: {} }, console, t: (k) => k, JSON, Set, Object, Array, Number, Math, String,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    document: {
      visibilityState: 'visible',
      createElement: (tag) => new El(tag),
      getElementById: () => null,
      querySelector: (sel) => { const m = /data-code="([^"]+)"/.exec(sel); return m ? lists.items.find(e => e.dataset.code === m[1]) || null : null; },
      querySelectorAll: (sel) => (sel.includes('category-label') ? lists.cats : sel.includes('sub-tag-label') ? lists.tags : []),
    },
    window: {},
  });
  const app = { unreadCounts: counts, channels, user: { id: 1 }, currentChannel: 'gen' };
  for (const file of ['app-channel-unread.js', 'app-mentions.js']) {
    vm.runInContext(read(`public/js/modules/${file}`).replace(/^export default/m, 'module.exports ='), context);
    Object.assign(app, context.module.exports);
  }
  app._mentionsSeenUpTo = () => 0;
  app._mentionsPersist = () => {};
  return { app, lists, store };
}

const chan = (id, code, extra = {}) => ({ id, code, name: code, category: 'Community', ...extra });

test('mentions from a muted channel do not count on the @ button when the channel list arrives', () => {
  const { app } = load(['bots'], {}, []);
  app._mentionsMerge([chan(1, 'bots', { unreadMentionIds: [5, 6] }), chan(2, 'help', { unreadMentionIds: [7] })]);
  assert.deepEqual(Array.from(app._unseenMentions, m => m.c), ['help']);
});

test('mentions from a channel that is not muted still count when the channel list arrives', () => {
  const { app } = load([], {}, []);
  app._mentionsMerge([chan(1, 'bots', { unreadMentionIds: [5] }), chan(2, 'help', { unreadMentionIds: [7] })]);
  assert.deepEqual(Array.from(app._unseenMentions, m => m.c), ['bots', 'help']);
});

test('an expanded category gets no dot for a muted channel with unread messages', () => {
  const channels = [chan(1, 'bots')];
  const { app, lists } = load(['bots'], { bots: 99 }, channels);
  lists.cats.push(new El('div', { category: 'Community' }));
  app._updateNestedIndicators();
  assert.equal(lists.cats[0].querySelector('.channel-badge-nested-dot'), null);
});

test('an expanded category still gets a dot when a channel that is not muted has unread messages', () => {
  const channels = [chan(1, 'bots'), chan(2, 'help')];
  const { app, lists } = load(['bots'], { bots: 99, help: 1 }, channels);
  lists.cats.push(new El('div', { category: 'Community' }));
  app._updateNestedIndicators();
  assert.ok(lists.cats[0].querySelector('.channel-badge-nested-dot'));
});

test('a collapsed category counts only the channels that are not muted', () => {
  const channels = [chan(1, 'bots'), chan(2, 'help')];
  const { app, lists, store } = load(['bots'], { bots: 99, help: 2 }, channels);
  store.haven_cat_collapsed_Community = 'true';
  lists.cats.push(new El('div', { category: 'Community' }));
  app._updateNestedIndicators();
  assert.equal(lists.cats[0].querySelector('.channel-badge-bubble').textContent, 2);
});

test('a collapsed category shows no count when only muted channels have unread messages', () => {
  const { app, lists, store } = load(['bots'], { bots: 99 }, [chan(1, 'bots')]);
  store.haven_cat_collapsed_Community = 'true';
  lists.cats.push(new El('div', { category: 'Community' }));
  app._updateNestedIndicators();
  assert.equal(lists.cats[0].querySelector('.channel-badge-bubble'), null);
});

test('an expanded parent channel gets no dot for a muted sub-channel', () => {
  const channels = [chan(1, 'hub'), chan(2, 'bots', { parent_channel_id: 1 })];
  const { app, lists } = load(['bots'], { bots: 5 }, channels);
  const parent = new El('div', { code: 'hub' });
  lists.items.push(parent);
  app._updateNestedIndicators();
  assert.equal(parent.querySelector('.channel-badge-nested-dot'), null);
});

test('a tag row counts only the sub-channels that are not muted', () => {
  const channels = [chan(1, 'hub'), chan(2, 'bots', { parent_channel_id: 1, category: 'Tools' }), chan(3, 'help', { parent_channel_id: 1, category: 'Tools' })];
  const { app, lists, store } = load(['bots'], { bots: 50, help: 3 }, channels);
  store.haven_subtag_collapsed_hub_Tools = 'true';
  const tag = new El('div', { parentCode: 'hub', tagName: 'Tools' });
  lists.tags.push(tag);
  app._updateNestedIndicators();
  assert.equal(tag.querySelector('.channel-badge-bubble').textContent, 3);
});
