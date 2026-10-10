'use strict';

/**
 * Tests for the Channel Tabs layout plugin.
 *
 *   node --test test/channelTabsLayout.test.js
 *
 * The full engage (tabs, modal, Layout picker) builds its markup with
 * innerHTML, so it is checked in a real browser; these cover the parts that
 * decide what Haven looks like afterwards.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ChannelTabsLayout = require('../plugins/ChannelTabsLayout.plugin.js');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'plugins/ChannelTabsLayout.plugin.js'), 'utf8');

class FakeElement {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: n => classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : Boolean(force);
        if (on) classes.add(n); else classes.delete(n);
        return on;
      }
    };
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  insertBefore(node, reference) {
    if (reference && reference.parentNode !== this) throw new Error('Invalid insertion reference');
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
}

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}

function installGlobals(t, { storage = createStorage(), elements = {}, guest = false } = {}) {
  const saved = {};
  for (const key of ['document', 'localStorage', 'HavenApi', 'window']) saved[key] = global[key];
  const pluginData = {};
  global.localStorage = storage;
  // A fresh window each test; restoring the saved globals afterwards also
  // drops anything a test put on it (window.app, window.t).
  global.window = {};
  global.HavenApi = {
    Data: {
      save: (plugin, key, value) => { (pluginData[plugin] ||= {})[key] = value; },
      load: (plugin, key, fallback) => pluginData[plugin]?.[key] ?? fallback
    }
  };
  const body = new FakeElement('body');
  if (guest) body.classList.add('is-guest');
  global.document = {
    body,
    getElementById: id => elements[id] || null
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  return { pluginData, storage };
}

function dot() {
  const el = new FakeElement('span');
  el.style.display = 'none';
  return el;
}

test('ChannelTabsLayout meets the Layout picker requirements', () => {
  assert.equal(ChannelTabsLayout.ID, 'ChannelTabsLayout');
  assert.equal(typeof ChannelTabsLayout.prototype._engage, 'function');
  assert.equal(typeof ChannelTabsLayout.prototype._disengage, 'function');
  assert.match(SOURCE, /HavenApi\.Layout\.acquire\(ChannelTabsLayout\.ID\)/);
  assert.match(SOURCE, /HavenApi\.Data\.save\(ChannelTabsLayout\.ID, 'layoutOn', '0'\)/);
  assert.match(SOURCE, /@name Channel Tabs Layout/);
});

test('ChannelTabsLayout has no empty catch blocks', () => {
  assert.doesNotMatch(SOURCE, /catch\s*(\([^)]*\))?\s*\{\s*\}/);
  assert.doesNotMatch(SOURCE, /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
});

test('ChannelTabsLayout keeps the open tab in its own plugin data', (t) => {
  const storage = createStorage({ activeChannelTab: 'DMs' });
  const { pluginData } = installGlobals(t, { storage });
  const plugin = new ChannelTabsLayout();

  assert.equal(plugin._loadActiveTab(), 'DMs');
  assert.equal(storage.getItem('activeChannelTab'), null, 'the old loose key is dropped');
  assert.equal(pluginData.ChannelTabsLayout.activeTab, 'DMs');

  plugin._saveActiveTab('channels');
  assert.equal(plugin._loadActiveTab(), 'channels');
  assert.equal(storage.getItem('activeChannelTab'), null);
  assert.doesNotMatch(SOURCE, /setItem\(\s*'activeChannelTab'/);
});

test('ChannelTabsLayout dots split DMs from channels and skip muted ones', (t) => {
  const elements = {
    'channels-channel-tab-notify-dot': dot(),
    'DMs-channel-tab-notify-dot': dot()
  };
  const storage = createStorage({ haven_muted_channels: JSON.stringify(['muted01']) });
  installGlobals(t, { storage, elements });
  const plugin = new ChannelTabsLayout();
  const channelDot = elements['channels-channel-tab-notify-dot'];
  const dmDot = elements['DMs-channel-tab-notify-dot'];

  const channels = [
    { code: 'chan0001', is_dm: 0 },
    { code: 'dm000001', is_dm: 1 },
    { code: 'muted01', is_dm: 0 }
  ];

  plugin._updateChannelTabNotificationDots(channels, { dm000001: 3 });
  assert.equal(channelDot.style.display, 'none');
  assert.equal(dmDot.style.display, '');

  plugin._updateChannelTabNotificationDots(channels, { chan0001: 1, dm000001: 0 });
  assert.equal(channelDot.style.display, '');
  assert.equal(dmDot.style.display, 'none');

  plugin._updateChannelTabNotificationDots(channels, { muted01: 9 });
  assert.equal(channelDot.style.display, 'none', 'a muted channel does not light the dot');

  // Haven's server snapshot count is used until the client has its own.
  plugin._updateChannelTabNotificationDots([{ code: 'chan0002', is_dm: 0, unreadCount: 2 }], {});
  assert.equal(channelDot.style.display, '');
});

test('ChannelTabsLayout hooks Haven unread updates and removes the hooks cleanly', (t) => {
  const elements = {
    'channels-channel-tab-notify-dot': dot(),
    'DMs-channel-tab-notify-dot': dot()
  };
  installGlobals(t, { elements });
  const calls = [];
  class FakeApp {
    _renderChannels() { calls.push('render'); }
    _updateTabTitle() { calls.push('title'); return 'done'; }
  }
  const app = new FakeApp();
  app.channels = [{ code: 'dm000001', is_dm: 1 }];
  app.unreadCounts = { dm000001: 0 };
  global.window.app = app;

  const plugin = new ChannelTabsLayout();
  assert.equal(plugin._installNotificationHook(), true);
  assert.ok(Object.prototype.hasOwnProperty.call(app, '_updateTabTitle'));

  app.unreadCounts.dm000001 = 4;
  assert.equal(app._updateTabTitle(), 'done', 'the original still runs and returns');
  assert.deepEqual(calls, ['title']);
  assert.equal(elements['DMs-channel-tab-notify-dot'].style.display, '');

  plugin._removeNotificationHook();
  assert.equal(Object.prototype.hasOwnProperty.call(app, '_updateTabTitle'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(app, '_renderChannels'), false);
  assert.equal(app._updateTabTitle, FakeApp.prototype._updateTabTitle);
});

test('ChannelTabsLayout leaves another wrapper in place when it removes its hooks', (t) => {
  installGlobals(t);
  const app = { _renderChannels() {}, _updateTabTitle() {}, channels: [], unreadCounts: {} };
  const ownTitle = app._updateTabTitle;
  global.window.app = app;

  const plugin = new ChannelTabsLayout();
  plugin._installNotificationHook();
  const later = function () {};
  app._renderChannels = later;
  plugin._removeNotificationHook();

  assert.equal(app._renderChannels, later);
  assert.equal(app._updateTabTitle, ownTitle, 'an own method is put back as it was');
});

test('ChannelTabsLayout puts sections back where they were without undoing Haven changes', (t) => {
  installGlobals(t);
  const sidebar = new FakeElement('div');
  const join = new FakeElement('div');
  const create = new FakeElement('div');
  const split = new FakeElement('div');
  sidebar.appendChild(join);
  sidebar.appendChild(create);
  sidebar.appendChild(split);
  create.style.display = 'none';
  create.setAttribute('class', 'sidebar-section');

  const modalContent = new FakeElement('div');
  const plugin = new ChannelTabsLayout();
  plugin._moveElement(join, modalContent);
  plugin._moveElement(create, modalContent);
  assert.deepEqual(modalContent.children, [join, create]);

  // Permissions arrive while the layout is on: Haven shows Create.
  create.style.display = 'block';
  create.setAttribute('class', 'sidebar-section can-create');

  const button = new FakeElement('button');
  button.textContent = '+';
  plugin._createButtonText = { element: button, original: '+', label: 'Create' };
  button.textContent = 'Create';

  plugin._restoreMovedElements();
  assert.deepEqual(sidebar.children, [join, create, split]);
  assert.equal(create.style.display, 'block', 'Haven\'s visibility is kept');
  assert.equal(create.getAttribute('class'), 'sidebar-section can-create');
  assert.equal(button.textContent, '+');
  assert.deepEqual(plugin._moved, []);
});

test('ChannelTabsLayout does not put back the create label over a newer one', (t) => {
  installGlobals(t);
  const plugin = new ChannelTabsLayout();
  const button = new FakeElement('button');
  plugin._createButtonText = { element: button, original: '+', label: 'Create' };
  button.textContent = 'Saving';
  plugin._restoreMovedElements();
  assert.equal(button.textContent, 'Saving');
});

test('ChannelTabsLayout keeps guests on the Channels tab', (t) => {
  const channelsPane = new FakeElement('div');
  const dmPane = new FakeElement('div');
  const { pluginData } = installGlobals(t, { guest: true, elements: { 'channels-pane': channelsPane, 'dm-pane': dmPane } });
  const plugin = new ChannelTabsLayout();
  plugin._split = new FakeElement('div');
  plugin._tabs = { querySelectorAll: () => [] };

  plugin._setChannelTab('DMs');
  assert.equal(channelsPane.classList.contains('pane-hidden'), false);
  assert.equal(dmPane.classList.contains('pane-hidden'), true);
  assert.equal(pluginData.ChannelTabsLayout.activeTab, 'channels');
});

test('ChannelTabsLayout keeps Haven\'s Create Temp Channel row', () => {
  assert.doesNotMatch(SOURCE, /\.temp-channel-create-btn\s*\{\s*display:\s*none/);
  assert.doesNotMatch(SOURCE, /create-temp-channel-btn/);
  assert.match(SOURCE, /closest\('#channel-list \.temp-channel-create-btn'\)/);
});

test('ChannelTabsLayout labels use Haven translations and fall back to English', (t) => {
  installGlobals(t);
  const plugin = new ChannelTabsLayout();
  global.window.t = key => (key === 'app.sidebar.channels' ? 'Kanäle' : key);
  assert.equal(plugin._t('app.sidebar.channels', 'Channels'), 'Kanäle');
  assert.equal(plugin._t('missing.key', 'Close'), 'Close');
  assert.match(SOURCE, /_t\('modals\.common\.close', 'Close'\)/);
});
