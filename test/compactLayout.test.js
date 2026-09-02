'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const BraidLayout = require('../plugins/BraidLayout.plugin.js');
const CompactLayout = require('../plugins/CompactLayout.plugin.js');
const ModMode = require('../public/js/modmode.js');

const ROOT = path.join(__dirname, '..');

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener.call(this, event);
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(property, value, priority = '') {
    this.values.set(property, { value, priority });
  }

  removeProperty(property) {
    this.values.delete(property);
  }

  getPropertyValue(property) {
    return this.values.get(property)?.value || '';
  }

  getPropertyPriority(property) {
    return this.values.get(property)?.priority || '';
  }
}

class FakeElement extends FakeTarget {
  constructor(name) {
    super();
    this.name = name;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = new FakeStyle();
    const classes = new Set();
    this.classList = {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      }
    };
    this.textContent = '';
    this.title = '';
    this.type = '';
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }

  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  prepend(node) {
    this.insertBefore(node, this.firstChild);
  }

  insertBefore(node, reference) {
    if (reference && reference.parentNode !== this) throw new Error('Invalid insertion reference');
    if (node.parentNode) {
      const previousIndex = node.parentNode.children.indexOf(node);
      node.parentNode.children.splice(previousIndex, 1);
    }
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeMediaQuery extends FakeTarget {
  constructor(matches) {
    super();
    this.matches = matches;
  }

  setMatches(matches) {
    this.matches = matches;
    this.dispatchEvent({ type: 'change', matches });
  }
}

function createEnvironment(desktop = true) {
  const document = new FakeTarget();
  document.documentElement = new FakeElement('html');
  document.body = new FakeElement('body');
  document.createElement = name => new FakeElement(name);
  document.getElementById = () => null;
  document.querySelector = () => null;
  document.querySelectorAll = () => [];

  const regions = new Map();
  const region = name => {
    const element = new FakeElement(name);
    regions.set(name, element);
    return element;
  };
  const workspace = region('workspace');
  const serverRail = region('server-rail');
  const serverList = region('server-list');
  const navigation = region('navigation-sidebar');
  const navigationHeader = new FakeElement('navigation-header');
  const sidebarContent = region('sidebar-content');
  const footer = region('sidebar-footer');
  const sidebarActions = region('sidebar-actions');
  const account = region('account');
  const main = region('main');
  const context = region('context-sidebar');
  const voiceRoster = region('voice-roster');
  const memberList = region('member-list');
  const voiceSettings = region('voice-settings');
  const voiceControls = region('voice-controls');
  const footerDecoration = new FakeElement('footer-decoration');
  const contextDecoration = new FakeElement('context-decoration');

  serverRail.append(serverList);
  navigationHeader.append(account);
  footer.append(footerDecoration, sidebarActions);
  navigation.append(navigationHeader, sidebarContent, footer);
  context.append(voiceRoster, memberList, voiceSettings, voiceControls, contextDecoration);
  workspace.append(serverRail, navigation, main, context);

  const media = new FakeMediaQuery(desktop);
  const styles = new Map();
  const data = new Map();
  let layoutOwner = null;
  let reservedLayoutOwner = null;
  const HavenApi = {
    DOM: {
      addStyle(id, css) { styles.set(id, css); },
      removeStyle(id) { styles.delete(id); },
      query(selector) {
        const name = selector.match(/^\[data-haven-region="([a-z-]+)"\]$/)?.[1];
        return regions.get(name) || null;
      }
    },
    Layout: {
      acquire(owner) {
        if ((reservedLayoutOwner && reservedLayoutOwner !== owner)
            || (layoutOwner && layoutOwner !== owner)) return false;
        if (layoutOwner === owner) return true;
        layoutOwner = owner;
        document.documentElement.setAttribute('data-haven-layout-owner', owner);
        document.dispatchEvent({ type: 'haven:layout-owner-change', detail: { owner } });
        return true;
      },
      release(owner) {
        if (layoutOwner !== owner) return false;
        layoutOwner = null;
        document.documentElement.removeAttribute('data-haven-layout-owner');
        document.dispatchEvent({ type: 'haven:layout-owner-change', detail: { owner: null } });
        return true;
      },
      _reserve(owner) {
        reservedLayoutOwner = owner || null;
      },
      _clearReservation(owner) {
        if (reservedLayoutOwner !== (owner || null)) return false;
        reservedLayoutOwner = null;
        return true;
      },
      get owner() { return layoutOwner; }
    },
    Data: {
      save(plugin, key, value) { data.set(`${plugin}:${key}`, value); },
      load(plugin, key, fallback) { return data.get(`${plugin}:${key}`) ?? fallback; }
    },
    UI: { showToast() {} }
  };

  return {
    document,
    HavenApi,
    media,
    styles,
    data,
    nodes: {
      workspace,
      serverRail,
      navigation,
      navigationHeader,
      sidebarContent,
      footer,
      sidebarActions,
      account,
      main,
      context,
      voiceRoster,
      memberList,
      voiceSettings,
      voiceControls,
      footerDecoration,
      contextDecoration
    }
  };
}

function withEnvironment(desktop, callback) {
  const previous = {
    document: global.document,
    window: global.window,
    HavenApi: global.HavenApi
  };
  const environment = createEnvironment(desktop);
  global.document = environment.document;
  global.window = { HavenApi: environment.HavenApi, matchMedia: () => environment.media };
  global.HavenApi = environment.HavenApi;
  try {
    callback(environment);
  } finally {
    global.document = previous.document;
    global.window = previous.window;
    global.HavenApi = previous.HavenApi;
  }
}

function withBraidEnvironment(callback) {
  const previous = {
    localStorage: global.localStorage,
    MutationObserver: global.MutationObserver,
    requestAnimationFrame: global.requestAnimationFrame
  };
  const storage = new Map();
  global.localStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  global.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = () => 1;
  try {
    withEnvironment(true, environment => callback(environment));
  } finally {
    global.localStorage = previous.localStorage;
    global.MutationObserver = previous.MutationObserver;
    global.requestAnimationFrame = previous.requestAnimationFrame;
  }
}

function stubBraidVisuals(plugin) {
  for (const method of [
    '_buildReturnPill', '_paintOwn', '_themeBottomIcons', '_applyTextScales',
    '_collapseJoinCreate', '_setPeopleOpen', '_buildMoreMenu', '_applyLayout',
    '_showModDone', '_unfoldVoiceDock', '_restoreBottomIcons'
  ]) plugin[method] = () => {};
}

test('Compact Layout uses only public regions and scoped CSS', () => {
  const source = fs.readFileSync(path.join(ROOT, 'plugins/CompactLayout.plugin.js'), 'utf8');
  const publicRegions = new Set([
    'server-rail', 'navigation-sidebar', 'account', 'sidebar-footer',
    'sidebar-actions', 'voice-settings', 'voice-controls'
  ]);

  assert.match(source, /@name Compact Layout/);
  assert.match(source, /class CompactLayout/);
  assert.doesNotMatch(source, /getElementById|querySelector(?:All)?/);
  assert.equal((CompactLayout.CSS.match(/!important/g) || []).length, 2);
  assert.doesNotMatch(CompactLayout.CSS, /--msg-/);
  assert.doesNotMatch(CompactLayout.CSS, /(?:^|[\s,{>+~])[.#][a-z_-]/im);
  assert.match(CompactLayout.CSS, /data-compact-layout-desktop/);
  for (const region of Object.values(CompactLayout.REGIONS)) {
    assert.ok(publicRegions.has(region), `Compact Layout uses non-public region ${region}`);
  }
});

test('Compact Layout moves desktop regions and restores their exact positions on stop', () => {
  withEnvironment(true, ({ document, styles, nodes }) => {
    const originalWorkspace = [...nodes.workspace.children];
    const originalHeader = [...nodes.navigationHeader.children];
    const originalFooter = [...nodes.footer.children];
    const originalContext = [...nodes.context.children];
    const plugin = new CompactLayout();

    plugin.start();

    assert.equal(document.documentElement.getAttribute('data-compact-layout'), '1');
    assert.equal(document.documentElement.getAttribute('data-compact-layout-desktop'), '1');
    assert.equal(nodes.navigation.firstChild, nodes.serverRail);
    assert.deepEqual(nodes.footer.children.slice(-4), [
      nodes.voiceSettings,
      nodes.voiceControls,
      nodes.account,
      nodes.sidebarActions
    ]);
    assert.ok(styles.has('CompactLayout'));
    assert.equal(plugin._control.parentNode, nodes.sidebarActions);
    assert.equal(plugin._control.getAttribute('aria-pressed'), 'true');
    assert.equal(document.documentElement.getAttribute('data-haven-layout-owner'), 'CompactLayout');

    plugin.stop();

    assert.deepEqual(nodes.workspace.children, originalWorkspace);
    assert.deepEqual(nodes.navigationHeader.children, originalHeader);
    assert.deepEqual(nodes.footer.children, originalFooter);
    assert.deepEqual(nodes.context.children, originalContext);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout'), false);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout-desktop'), false);
    assert.equal(document.documentElement.hasAttribute('data-haven-layout-owner'), false);
    assert.equal(styles.has('CompactLayout'), false);
  });
});

test('Compact Layout restores native layout for responsive and Mod Mode states', () => {
  withEnvironment(true, ({ document, media, data, nodes }) => {
    const originalWorkspace = [...nodes.workspace.children];
    const originalContext = [...nodes.context.children];
    nodes.voiceControls.style.setProperty('position', 'fixed', 'important');
    nodes.voiceControls.style.setProperty('bottom', '80px');
    nodes.voiceControls.style.setProperty('border', '1px solid red');
    nodes.voiceControls.style.setProperty('overflow', 'scroll');
    nodes.voiceControls.style.setProperty('resize', 'both');
    const plugin = new CompactLayout();
    plugin.start();

    assert.equal(nodes.voiceControls.style.getPropertyValue('position'), 'static');
    assert.equal(nodes.voiceControls.style.getPropertyPriority('position'), 'important');
    assert.equal(nodes.voiceControls.style.getPropertyValue('border'), '0');
    assert.equal(nodes.voiceControls.style.getPropertyPriority('border'), 'important');
    assert.equal(nodes.voiceControls.style.getPropertyValue('overflow'), 'auto hidden');
    assert.equal(nodes.voiceControls.style.getPropertyValue('resize'), 'none');

    media.setMatches(false);
    assert.deepEqual(nodes.workspace.children, originalWorkspace);
    assert.deepEqual(nodes.context.children, originalContext);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout-desktop'), false);
    assert.equal(document.documentElement.getAttribute('data-compact-layout'), '1');
    assert.equal(nodes.voiceControls.style.getPropertyValue('position'), 'fixed');
    assert.equal(nodes.voiceControls.style.getPropertyPriority('position'), 'important');
    assert.equal(nodes.voiceControls.style.getPropertyValue('bottom'), '80px');
    assert.equal(nodes.voiceControls.style.getPropertyValue('border'), '1px solid red');
    assert.equal(nodes.voiceControls.style.getPropertyValue('overflow'), 'scroll');
    assert.equal(nodes.voiceControls.style.getPropertyValue('resize'), 'both');

    media.setMatches(true);
    assert.equal(document.documentElement.getAttribute('data-compact-layout-desktop'), '1');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: true } });
    assert.deepEqual(nodes.workspace.children, originalWorkspace);
    assert.deepEqual(nodes.context.children, originalContext);

    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: false } });
    assert.equal(document.documentElement.getAttribute('data-compact-layout-desktop'), '1');
    plugin._control.dispatchEvent({ type: 'click' });
    assert.equal(document.documentElement.hasAttribute('data-compact-layout'), false);
    assert.equal(data.get('CompactLayout:layoutOn'), '0');

    let prevented = false;
    document.dispatchEvent({
      type: 'keydown',
      ctrlKey: true,
      altKey: true,
      key: 'c',
      preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.equal(data.get('CompactLayout:layoutOn'), '1');
    assert.equal(document.documentElement.getAttribute('data-compact-layout-desktop'), '1');
    plugin.stop();
  });
});

test('Compact Layout waits for another structural layout owner and retries after release', () => {
  withEnvironment(true, ({ document, HavenApi, nodes }) => {
    const originalWorkspace = [...nodes.workspace.children];
    assert.equal(HavenApi.Layout.acquire('BraidLayout'), true);
    const plugin = new CompactLayout();
    plugin.start();

    assert.deepEqual(nodes.workspace.children, originalWorkspace);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout-desktop'), false);
    assert.equal(plugin._control.getAttribute('aria-label'), 'Compact layout waiting for another layout plugin');

    HavenApi.Layout.release('BraidLayout');
    assert.equal(document.documentElement.getAttribute('data-haven-layout-owner'), 'CompactLayout');
    assert.equal(document.documentElement.getAttribute('data-compact-layout-desktop'), '1');
    assert.equal(nodes.navigation.firstChild, nodes.serverRail);
    plugin.stop();
  });
});

test('Mod Mode restores the previous layout owner regardless of listener order', () => {
  withBraidEnvironment(({ document, HavenApi }) => {
    const compact = new CompactLayout();
    compact.start();
    const braid = new BraidLayout();
    stubBraidVisuals(braid);
    braid.start();

    compact._control.dispatchEvent({ type: 'click' });
    assert.equal(HavenApi.Layout.owner, 'BraidLayout');
    compact._control.dispatchEvent({ type: 'click' });
    assert.equal(compact._blocked, true);

    document.documentElement.setAttribute('data-haven-layout-editing', '1');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: true, owner: 'BraidLayout' } });
    assert.equal(HavenApi.Layout.owner, null);

    document.documentElement.removeAttribute('data-haven-layout-editing');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: false, owner: 'BraidLayout' } });
    assert.equal(HavenApi.Layout.owner, 'BraidLayout');
    assert.equal(braid._suspended, false);
    assert.equal(compact._blocked, true);

    compact.stop();
    braid.stop();
  });
});

test('Mod Mode reserves the previous owner against legacy layout listeners', () => {
  const previousCustomEvent = global.CustomEvent;
  global.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  try {
    withBraidEnvironment(({ document, HavenApi }) => {
      let legacyAcquired = null;
      document.addEventListener('haven:layout-editing', event => {
        if (event.detail?.active === false) {
          legacyAcquired = HavenApi.Layout.acquire('LegacyLayout');
        }
      });
      const braid = new BraidLayout();
      stubBraidVisuals(braid);
      braid.start();
      const modMode = new ModMode();

      modMode._beginLayoutEditing();
      assert.equal(HavenApi.Layout.owner, null);
      modMode._endLayoutEditing();

      assert.equal(legacyAcquired, false);
      assert.equal(HavenApi.Layout.owner, 'BraidLayout');
      assert.equal(braid._suspended, false);
      braid.stop();
    });
  } finally {
    global.CustomEvent = previousCustomEvent;
  }
});

test('Mod Mode reset suspends and restores an active structural layout', () => {
  const previous = {
    CustomEvent: global.CustomEvent,
    localStorage: global.localStorage,
    t: global.t
  };
  global.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  global.localStorage = { removeItem() {} };
  global.t = key => key;
  try {
    withEnvironment(true, ({ document, HavenApi, nodes }) => {
      const originalWorkspace = [...nodes.workspace.children];
      const compact = new CompactLayout();
      compact.start();
      const modMode = new ModMode();
      modMode.container = new FakeElement('mod-container');
      modMode.container.querySelectorAll = () => [];
      modMode._showToast = () => {};
      const editingEvents = [];
      document.addEventListener('haven:layout-editing', event => editingEvents.push(event.detail));

      modMode.resetLayout();

      assert.deepEqual(editingEvents, [
        { active: true, owner: 'CompactLayout' },
        { active: false, owner: 'CompactLayout' }
      ]);
      assert.equal(HavenApi.Layout.owner, 'CompactLayout');
      assert.equal(document.documentElement.getAttribute('data-compact-layout-desktop'), '1');
      assert.notDeepEqual(nodes.workspace.children, originalWorkspace);
      compact.stop();
    });
  } finally {
    global.CustomEvent = previous.CustomEvent;
    global.localStorage = previous.localStorage;
    global.t = previous.t;
  }
});

test('Compact Layout rolls back ownership and DOM when persistence fails', () => {
  withEnvironment(true, ({ document, HavenApi, data, nodes }) => {
    const originalWorkspace = [...nodes.workspace.children];
    const originalHeader = [...nodes.navigationHeader.children];
    const originalFooter = [...nodes.footer.children];
    const originalContext = [...nodes.context.children];
    data.set('CompactLayout:layoutOn', '0');
    const plugin = new CompactLayout();
    plugin.start();
    HavenApi.Data.save = () => { throw new Error('storage full'); };

    assert.throws(() => plugin._control.dispatchEvent({ type: 'click' }), /storage full/);
    assert.equal(plugin._engaged, false);
    assert.equal(HavenApi.Layout.owner, null);
    assert.deepEqual(nodes.workspace.children, originalWorkspace);
    assert.deepEqual(nodes.navigationHeader.children, originalHeader);
    assert.deepEqual(nodes.footer.children, originalFooter);
    assert.deepEqual(nodes.context.children, originalContext);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout'), false);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout-desktop'), false);
    plugin.stop();
  });
});

test('Compact Layout cleans partial startup when persisted data cannot load', () => {
  withEnvironment(true, ({ document, HavenApi, styles, nodes }) => {
    const originalActions = [...nodes.sidebarActions.children];
    HavenApi.Data.load = () => { throw new Error('corrupt storage'); };
    const plugin = new CompactLayout();

    assert.throws(() => plugin.start(), /corrupt storage/);
    assert.equal(plugin._started, false);
    assert.equal(plugin._control, null);
    assert.deepEqual(plugin._listeners, []);
    assert.deepEqual(nodes.sidebarActions.children, originalActions);
    assert.equal(styles.has('CompactLayout'), false);
    assert.equal(HavenApi.Layout.owner, null);
    assert.equal(document.documentElement.hasAttribute('data-compact-layout'), false);
  });
});

test('Braid releases ownership for Mod Mode and resumes after editing finishes', () => {
  withBraidEnvironment(({ document, HavenApi }) => {
    const plugin = new BraidLayout();
    stubBraidVisuals(plugin);
    plugin.start();
    const compact = new CompactLayout();
    compact.start();

    assert.equal(HavenApi.Layout.owner, 'BraidLayout');
    assert.equal(document.documentElement.getAttribute('data-braid-layout'), '1');
    assert.equal(document.documentElement.hasAttribute('data-compact-layout-desktop'), false);

    document.documentElement.setAttribute('data-haven-layout-editing', '1');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: true } });
    assert.equal(plugin._suspended, true);
    assert.equal(HavenApi.Layout.owner, null);
    assert.equal(document.documentElement.hasAttribute('data-braid-layout'), false);

    compact.stop();

    document.documentElement.removeAttribute('data-haven-layout-editing');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: false } });
    assert.equal(plugin._suspended, false);
    assert.equal(HavenApi.Layout.owner, 'BraidLayout');
    assert.equal(document.documentElement.getAttribute('data-braid-layout'), '1');

    plugin.stop();
    assert.equal(HavenApi.Layout.owner, null);
  });
});

test('Braid rolls back ownership when engagement persistence fails', () => {
  withBraidEnvironment(({ document, HavenApi }) => {
    const plugin = new BraidLayout();
    stubBraidVisuals(plugin);
    const save = HavenApi.Data.save;
    HavenApi.Data.save = () => { throw new Error('storage full'); };

    assert.throws(() => plugin.start(), /storage full/);
    assert.equal(plugin._engaged, false);
    assert.equal(HavenApi.Layout.owner, null);
    assert.equal(document.documentElement.hasAttribute('data-haven-layout-owner'), false);

    HavenApi.Data.save = save;
    plugin.stop();
  });
});

test('public density and layout-editing hooks are wired into core state changes', () => {
  const themeInit = fs.readFileSync(path.join(ROOT, 'public/js/theme-init.js'), 'utf8');
  const media = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-media.js'), 'utf8');
  const modMode = fs.readFileSync(path.join(ROOT, 'public/js/modmode.js'), 'utf8');
  const pluginLoader = fs.readFileSync(path.join(ROOT, 'public/js/plugin-loader.js'), 'utf8');
  const braid = fs.readFileSync(path.join(ROOT, 'plugins/BraidLayout.plugin.js'), 'utf8');

  assert.match(themeInit, /data-haven-density/);
  assert.match(media, /dataset\.havenDensity/);
  assert.match(media, /haven:density-change/);
  assert.match(modMode, /data-haven-layout-editing/);
  assert.match(modMode, /haven:layout-editing/);
  assert.match(modMode, /finally\s*\{\s*this\._endLayoutEditing\(\)/);
  assert.match(modMode, /_endLayoutEditing\(\)[\s\S]*?removeAttribute\('data-haven-layout-editing'\)[\s\S]*?active:\s*false/);
  assert.match(pluginLoader, /data-haven-layout-owner/);
  assert.match(pluginLoader, /haven:layout-owner-change/);
  assert.match(braid, /Layout\.acquire\('BraidLayout'\)/);
  assert.match(braid, /Layout\?\.release\('BraidLayout'\)/);
});
