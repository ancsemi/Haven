'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const express = require('express');

const {
  THEME_API_VERSION,
  classifyThemeApi,
  compatibleThemeFiles,
  createThemeFileMiddleware,
  readThemeMetadataFile,
  readThemeMetadataSnapshot,
  parseThemeMetadata,
  themeFileFromRequestPath,
  validatedThemeDefault,
} = require('../src/themeMetadata');
const registerAdmin = require('../src/socketHandlers/admin');
const ThemeCompat = require('../public/js/theme-compat');

const ROOT = path.join(__dirname, '..');
const THEME_INIT_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/theme-init.js'), 'utf8');
const PLUGIN_LOADER_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/plugin-loader.js'), 'utf8');

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function createDocument() {
  const attributes = new Map();
  const links = [];
  const listeners = new Map();
  const documentElement = {
    attributes,
    style: {
      setProperty() {},
      removeProperty() {},
    },
    classList: { add() {} },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
  const document = {
    readyState: 'complete',
    body: null,
    documentElement,
    head: {
      appendChild(node) {
        links.push(node);
        if (typeof node.onload === 'function') Promise.resolve().then(() => node.onload());
      },
    },
    createElement(tag) { return { tagName: tag.toUpperCase(), remove() {} }; },
    getElementById() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  };
  return { document, documentElement, links };
}

function browserCompat(localStorage, sessionStorage) {
  return {
    ...ThemeCompat,
    cacheThemes: themes => ThemeCompat.cacheThemes(themes, localStorage),
    getCachedTheme: file => ThemeCompat.getCachedTheme(file, localStorage),
    fetchThemes: fetcher => ThemeCompat.fetchThemes(fetcher, true),
    isSafeMode: location => ThemeCompat.isSafeMode(location, sessionStorage),
    clearSafeMode: () => ThemeCompat.clearSafeMode(sessionStorage),
    markResetPending: () => ThemeCompat.markResetPending(sessionStorage),
    isResetPending: () => ThemeCompat.isResetPending(sessionStorage),
    clearResetPending: () => ThemeCompat.clearResetPending(sessionStorage),
    resetLocalCustomizations: () => ThemeCompat.resetLocalCustomizations(localStorage, sessionStorage),
  };
}

function runThemeInit({ theme = 'file:test.theme.css', search = '', cache = [], themes } = {}) {
  const localStorage = new MemoryStorage({ haven_theme: theme });
  const sessionStorage = new MemoryStorage();
  ThemeCompat.cacheThemes(cache, localStorage);
  const { document, documentElement, links } = createDocument();
  const location = { search, href: `https://haven.test/${search}` };
  const window = {
    HavenThemeCompat: browserCompat(localStorage, sessionStorage),
    location,
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
    addEventListener() {},
    visualViewport: null,
  };
  const fetches = [];
  if (themes !== undefined) {
    window.fetch = async url => {
      fetches.push(url);
      return { ok: true, json: async () => themes };
    };
  }

  vm.runInNewContext(THEME_INIT_SOURCE, {
    URLSearchParams,
    document,
    history: {},
    localStorage,
    setTimeout() { return 1; },
    window,
  });
  return { documentElement, fetches, links, localStorage, sessionStorage };
}

function createAdminThemeHarness() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT)');
  const handlers = new Map();
  const outgoing = [];
  const socket = {
    user: { id: 1, isAdmin: true },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { outgoing.push({ event, payload }); },
  };
  const io = {
    sockets: { sockets: new Map() },
    of() { return { sockets: new Map() }; },
    except() { return { emit() {} }; },
  };
  registerAdmin(socket, {
    io,
    db,
    state: { channelUsers: new Map() },
    userHasPermission: () => true,
    getUserEffectiveLevel: () => 100,
    getUserPermissions: () => [],
    getUserRoles: () => [],
    getUserHighestRole: () => null,
    emitOnlineUsers() {},
    broadcastChannelLists() {},
    generateUniqueSharedCode: () => '12345678',
    logAudit() {},
    fireWebhookEvent() {},
    onReferrerPolicyChange() {},
    automod: { invalidate() {}, settings: () => ({}) },
    getIdleOnlineUsers: () => [],
    getUploadUsage: () => ({ byUser: new Map() }),
    revokeBotVoiceAccess() {},
  });
  return { db, handlers, outgoing };
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runPluginLoader({
  safe = false,
  theme = 'haven',
  enabledPlugins = [],
  plugins = [],
  themes = [],
  themeResponses = null,
  themeFetchError = false,
  withCompat = true,
  search = '',
  socket = null,
  recoveryPending = false,
} = {}) {
  const localStorage = new MemoryStorage({
    haven_theme: theme,
    haven_enabled_plugins: JSON.stringify(enabledPlugins),
    haven_enabled_themes: '[]',
  });
  const sessionStorage = new MemoryStorage({
    ...(safe ? { haven_safe_mode: '1' } : {}),
    ...(recoveryPending ? { haven_customizations_reset_pending: '1' } : {}),
  });
  const { document, documentElement, links } = createDocument();
  const fetches = [];
  const location = { search, href: `https://haven.test/app.html${search}`, assign() {} };
  const window = {
    location,
    confirm() { return false; },
    addEventListener() {},
    havenSocket: socket,
  };
  if (withCompat) window.HavenThemeCompat = browserCompat(localStorage, sessionStorage);
  let themeFetchCount = 0;
  const fetch = async url => {
    fetches.push(url);
    if (url === '/api/plugins') {
      return { ok: true, json: async () => plugins };
    }
    if (url === '/api/themes') {
      if (themeFetchError) throw new Error('temporary network failure');
      const responseThemes = themeResponses
        ? themeResponses[Math.min(themeFetchCount++, themeResponses.length - 1)]
        : themes;
      return { ok: true, json: async () => responseThemes };
    }
    throw new Error(`unexpected extension fetch: ${url}`);
  };

  vm.runInNewContext(PLUGIN_LOADER_SOURCE, {
    applyPublishedThemeBase(file, persist = true) {
      const link = document.createElement('link');
      link.id = `haven-theme-${file}`;
      link.href = `/themes/${encodeURIComponent(file)}`;
      document.head.appendChild(link);
      if (persist) localStorage.setItem('haven_theme', `file:${file}`);
      return link;
    },
    console,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    document,
    fetch,
    globalThis: window,
    localStorage,
    location,
    sessionStorage,
    setTimeout(fn) { fn(); return 1; },
    t(key) { return key; },
    URLSearchParams,
    window,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return {
    api: window.HavenApi,
    documentElement,
    fetches,
    links,
    localStorage,
    loader: window.HavenPluginLoader,
  };
}

test('structural layout ownership is exclusive and releases cleanly', async () => {
  const result = await runPluginLoader();

  assert.equal(result.api.Layout.acquire('FirstLayout'), true);
  assert.equal(result.api.Layout.owner, 'FirstLayout');
  assert.equal(result.documentElement.attributes.get('data-haven-layout-owner'), 'FirstLayout');
  assert.equal(result.api.Layout.acquire('SecondLayout'), false);
  assert.equal(result.api.Layout.release('SecondLayout'), false);
  assert.equal(result.api.Layout.release('FirstLayout'), true);
  assert.equal(result.api.Layout.owner, null);
  assert.equal(result.documentElement.attributes.has('data-haven-layout-owner'), false);
});

test('theme metadata classifies current, legacy, future, and invalid API declarations', () => {
  assert.equal(THEME_API_VERSION, 1);
  assert.deepEqual(classifyThemeApi(null), {
    themeApi: null,
    themeApiDeclared: null,
    compatibility: 'legacy',
    compatible: true,
  });
  assert.equal(classifyThemeApi('1').compatibility, 'compatible');
  assert.equal(classifyThemeApi('2').compatibility, 'unsupported');
  assert.equal(classifyThemeApi('').compatibility, 'invalid');
  assert.equal(classifyThemeApi('1.0').compatibility, 'invalid');
  assert.equal(classifyThemeApi('0').compatibility, 'invalid');
  assert.equal(classifyThemeApi('999999999999999999999').compatibility, 'invalid');
});

test('an empty Theme API metadata tag is invalid rather than legacy', () => {
  const meta = parseThemeMetadata('/**\n * @name Empty API\n * @haven-theme-api\n */');
  assert.equal(meta.compatibility, 'invalid');
  assert.equal(meta.compatible, false);
  assert.equal(meta.themeApiDeclared, '');
});

test('Theme API text inside a description is not treated as a declaration', () => {
  const meta = parseThemeMetadata(`/**
   * @description Uses @haven-theme-api 1 when available
   * @haven-theme-api 2
   */`);

  assert.equal(meta.description, 'Uses @haven-theme-api 1 when available');
  assert.equal(meta.themeApi, 2);
  assert.equal(meta.compatibility, 'unsupported');
});

test('an unknown metadata tag does not contaminate the Theme API value', () => {
  const meta = parseThemeMetadata(`/**
   * @haven-theme-api 1
   * @website https://example.test
   */`);

  assert.equal(meta.themeApi, 1);
  assert.equal(meta.compatibility, 'compatible');
});

test('duplicate Theme API declarations are invalid', () => {
  const meta = parseThemeMetadata(`/**
   * @haven-theme-api 1
   * @haven-theme-api 2
   */`);

  assert.equal(meta.themeApi, null);
  assert.equal(meta.themeApiDeclared, '1, 2');
  assert.equal(meta.compatibility, 'invalid');
  assert.equal(meta.compatible, false);
});

test('theme metadata parser preserves existing fields and exposes compatibility', () => {
  const meta = parseThemeMetadata(`/**
   * @name Test Theme
   * @description A test theme
   * @author Tester
   * @version 2.3
   * @icon T
   * @haven-theme-api 1
   */
   :root { --accent: red; }`);

  assert.deepEqual(meta, {
    name: 'Test Theme',
    description: 'A test theme',
    author: 'Tester',
    version: '2.3',
    icon: 'T',
    themeApi: 1,
    themeApiDeclared: '1',
    compatibility: 'compatible',
    compatible: true,
  });
});

test('theme metadata parser supports compact one-line comment blocks', () => {
  const meta = parseThemeMetadata('/** @name Compact @description One line @version 1.0 @haven-theme-api 2 */');

  assert.equal(meta.name, 'Compact');
  assert.equal(meta.description, 'One line');
  assert.equal(meta.version, '1.0');
  assert.equal(meta.themeApi, 2);
  assert.equal(meta.compatibility, 'unsupported');
  assert.equal(meta.compatible, false);
});

test('compatibility cache keeps only the server verdict needed before paint', () => {
  const storage = new MemoryStorage();
  ThemeCompat.cacheThemes([
    { file: 'current.theme.css', themeApi: 1, themeApiDeclared: '1', compatibility: 'compatible', compatible: true },
    { file: 'future.theme.css', themeApi: 2, themeApiDeclared: '2', compatibility: 'unsupported', compatible: false },
  ], storage);

  assert.equal(ThemeCompat.getCachedTheme('current.theme.css', storage).compatible, true);
  assert.equal(ThemeCompat.getCachedTheme('future.theme.css', storage).compatible, false);
  assert.equal(ThemeCompat.getCachedTheme('missing.theme.css', storage), null);
});

test('theme metadata files are read only from valid installed theme names', () => {
  const themesDir = path.join(ROOT, 'themes');
  assert.equal(readThemeMetadataFile(themesDir, '../package.json'), null);
  assert.equal(readThemeMetadataFile(themesDir, 'missing.theme.css'), null);
  assert.equal(readThemeMetadataFile(themesDir, 'braid.theme.css').compatible, true);
});

test('a theme metadata snapshot fails rather than returning a partial list', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-themes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'valid.theme.css'), '/** @haven-theme-api 1 */');
  fs.symlinkSync(path.join(directory, 'missing.css'), path.join(directory, 'broken.theme.css'));

  assert.throws(() => readThemeMetadataSnapshot(directory));
});

test('theme request paths reject alternate and hidden stylesheet paths', () => {
  assert.equal(themeFileFromRequestPath('/braid.theme.css'), 'braid.theme.css');
  assert.equal(themeFileFromRequestPath('/my%20theme.theme.css'), 'my theme.theme.css');
  assert.equal(themeFileFromRequestPath('//braid.theme.css'), null);
  assert.equal(themeFileFromRequestPath('/nested/braid.theme.css'), null);
  assert.equal(themeFileFromRequestPath('/%2Fbraid.theme.css'), null);
  assert.equal(themeFileFromRequestPath('/.hidden.theme.css'), null);
  assert.equal(themeFileFromRequestPath('/preview.png'), undefined);
});

test('theme stylesheet middleware blocks incompatible and alternate paths', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-theme-http-'));
  fs.writeFileSync(path.join(directory, 'good.theme.css'), '/** @haven-theme-api 1 */\n:root {}');
  fs.writeFileSync(path.join(directory, 'future.theme.css'), '/** @haven-theme-api 2 */\n:root {}');
  fs.writeFileSync(path.join(directory, '.hidden.theme.css'), '/** @haven-theme-api 1 */\n:root {}');
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(path.join(directory, 'nested', 'good.theme.css'), '/** @haven-theme-api 1 */\n:root {}');

  const app = express();
  app.use('/themes', createThemeFileMiddleware(directory));
  app.use('/themes', express.static(directory, { dotfiles: 'deny' }));
  const server = await listen(app);
  t.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/themes/good.theme.css`)).status, 200);
  assert.equal((await fetch(`${base}/themes/future.theme.css`)).status, 409);
  assert.equal((await fetch(`${base}/themes//good.theme.css`)).status, 404);
  assert.equal((await fetch(`${base}/themes/%2Fgood.theme.css`)).status, 404);
  assert.equal((await fetch(`${base}/themes/nested/good.theme.css`)).status, 404);
  assert.equal((await fetch(`${base}/themes/.hidden.theme.css`)).status, 404);
  assert.equal((await fetch(`${base}/themes/future.theme.css`, { method: 'HEAD' })).status, 409);
});

test('stored theme settings expose only compatible installed file themes', () => {
  const themesDir = path.join(ROOT, 'themes');
  const published = compatibleThemeFiles(themesDir, ['braid.theme.css', 'missing.theme.css']);
  assert.deepEqual(published, ['braid.theme.css']);
  assert.equal(validatedThemeDefault(themesDir, 'file:braid.theme.css', published), 'file:braid.theme.css');
  assert.equal(validatedThemeDefault(themesDir, 'file:missing.theme.css', published), '');
});

test('safe mode persists for the tab and can be explicitly cleared', () => {
  const session = new MemoryStorage();
  assert.equal(ThemeCompat.isSafeMode({ search: '?haven-safe-mode=1' }, session), true);
  assert.equal(ThemeCompat.isSafeMode({ search: '' }, session), true);
  assert.equal(ThemeCompat.isSafeMode({ search: '?haven-safe-mode=0' }, session), false);
  assert.equal(ThemeCompat.isSafeMode({ search: '' }, session), false);
});

test('both pages load compatibility helpers before the pre-paint theme script', () => {
  for (const file of ['public/app.html', 'public/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const compatIndex = html.indexOf('/js/theme-compat.js');
    const initIndex = html.indexOf('/js/theme-init.js');
    assert.ok(compatIndex >= 0, `${file} does not load theme-compat.js`);
    assert.ok(initIndex > compatIndex, `${file} loads theme-init.js before theme-compat.js`);
  }
});

test('the app exposes recovery controls only inside the hidden safe-mode notice', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  assert.match(html, /id="extension-safe-mode-notice"[^>]*style="[^"]*display:none/);
  assert.match(html, /id="extension-reset-btn"/);
  assert.match(html, /id="extension-safe-mode-exit-btn"/);
});

test('local recovery resets only extension choices and marks server sync pending', () => {
  const local = new MemoryStorage({
    haven_theme: 'file:test.theme.css',
    haven_enabled_themes: '["test.theme.css"]',
    haven_enabled_plugins: '["test.plugin.js"]',
    haven_custom_hsv: '{"h":20}',
  });
  const session = new MemoryStorage();

  ThemeCompat.resetLocalCustomizations(local, session);

  assert.equal(local.getItem('haven_theme'), 'haven');
  assert.equal(local.getItem('haven_enabled_themes'), '[]');
  assert.equal(local.getItem('haven_enabled_plugins'), '[]');
  assert.equal(local.getItem('haven_custom_hsv'), '{"h":20}');
  assert.equal(ThemeCompat.isResetPending(session), true);
});

test('pre-paint loader injects only a theme with a cached compatible verdict', () => {
  const compatible = runThemeInit({
    cache: [{ file: 'test.theme.css', compatibility: 'compatible', compatible: true, themeApi: 1 }],
  });
  assert.equal(compatible.links.length, 1);
  assert.equal(compatible.links[0].href, '/themes/test.theme.css');

  const unknown = runThemeInit();
  assert.equal(unknown.links.length, 0);
  assert.equal(unknown.documentElement.attributes.get('data-haven-theme-pending'), 'test.theme.css');
});

test('pre-paint loader validates and injects an uncached compatible theme', async () => {
  const result = runThemeInit({
    themes: [{ file: 'test.theme.css', compatibility: 'compatible', compatible: true, themeApi: 1 }],
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result.fetches, ['/api/themes']);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].href, '/themes/test.theme.css');
  assert.equal(result.documentElement.attributes.has('data-haven-theme-pending'), false);
});

test('safe mode suppresses compatible theme CSS before paint', () => {
  const result = runThemeInit({
    search: '?haven-safe-mode=1',
    cache: [{ file: 'test.theme.css', compatibility: 'compatible', compatible: true, themeApi: 1 }],
  });

  assert.equal(result.links.length, 0);
  assert.equal(result.documentElement.attributes.get('data-theme'), 'haven');
  assert.equal(result.documentElement.attributes.get('data-haven-safe-mode'), '1');
});

test('safe mode never fetches or evaluates plugin files', async () => {
  const result = await runPluginLoader({
    safe: true,
    enabledPlugins: ['example.plugin.js'],
    plugins: [{ file: 'example.plugin.js', name: 'Example' }],
  });

  assert.deepEqual(result.fetches.sort(), ['/api/plugins', '/api/themes']);
  const plugin = result.loader.loadedPlugins.get('example.plugin.js');
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.instance, null);
  assert.equal(plugin.suppressed, true);
});

test('safe mode fails closed when the compatibility helper is unavailable', async () => {
  const result = await runPluginLoader({
    withCompat: false,
    search: '?haven-safe-mode=1',
    enabledPlugins: ['example.plugin.js'],
    plugins: [{ file: 'example.plugin.js', name: 'Example' }],
  });

  assert.deepEqual(result.fetches.sort(), ['/api/plugins', '/api/themes']);
  assert.equal(result.loader.loadedPlugins.get('example.plugin.js').instance, null);
  assert.equal(result.loader.loadedPlugins.get('example.plugin.js').suppressed, true);
});

test('pending recovery fails closed when the compatibility helper is unavailable', async () => {
  const result = await runPluginLoader({
    withCompat: false,
    recoveryPending: true,
    enabledPlugins: ['example.plugin.js'],
    plugins: [{ file: 'example.plugin.js', name: 'Example' }],
  });

  assert.deepEqual(result.fetches.sort(), ['/api/plugins', '/api/themes']);
  assert.equal(result.loader.loadedPlugins.get('example.plugin.js').instance, null);
  assert.equal(result.loader.loadedPlugins.get('example.plugin.js').suppressed, true);
});

test('an incompatible selected theme falls back to Haven without injecting CSS', async () => {
  const result = await runPluginLoader({
    theme: 'file:future.theme.css',
    themes: [{
      file: 'future.theme.css',
      published: true,
      compatibility: 'unsupported',
      compatible: false,
      themeApi: 2,
      themeApiDeclared: '2',
    }],
  });

  assert.equal(result.links.length, 0);
  assert.equal(result.localStorage.getItem('haven_theme'), 'haven');
  assert.equal(result.documentElement.attributes.get('data-theme'), 'haven');
});

test('a transient theme API failure preserves the selected theme preference', async () => {
  const result = await runPluginLoader({
    theme: 'file:saved.theme.css',
    themeFetchError: true,
  });

  assert.equal(result.links.length, 0);
  assert.equal(result.localStorage.getItem('haven_theme'), 'file:saved.theme.css');
  assert.equal(result.documentElement.attributes.get('data-theme'), undefined);
});

test('a stale local theme fallback does not schedule a server preference write', async () => {
  const socketEvents = [];
  const socket = {
    connected: false,
    once(event) { socketEvents.push(`once:${event}`); },
    off() {},
    emit(event) { socketEvents.push(`emit:${event}`); },
  };
  const result = await runPluginLoader({ theme: 'file:removed.theme.css', socket, themes: [] });

  assert.equal(result.localStorage.getItem('haven_theme'), 'haven');
  assert.deepEqual(socketEvents, []);
});

test('refresh reconciles a removed theme before applying fallback', async () => {
  const installed = [{
    file: 'temporary.theme.css',
    compatibility: 'compatible',
    compatible: true,
    themeApi: 1,
  }];
  const result = await runPluginLoader({
    theme: 'file:temporary.theme.css',
    themeResponses: [installed, []],
  });
  await result.loader.refresh();

  assert.equal(result.loader.loadedThemes.has('temporary.theme.css'), false);
  assert.equal(result.localStorage.getItem('haven_theme'), 'haven');
});

test('admin theme settings accept only installed themes and clear an unpublished default', t => {
  const { db, handlers, outgoing } = createAdminThemeHarness();
  t.after(() => db.close());
  const update = handlers.get('update-server-setting');

  update({ key: 'published_themes', value: '["missing.theme.css"]' });
  assert.match(outgoing.at(-1).payload, /installed, compatible/);
  assert.equal(db.prepare("SELECT value FROM server_settings WHERE key = 'published_themes'").get(), undefined);

  update({ key: 'published_themes', value: '["braid.theme.css"]' });
  update({ key: 'default_theme', value: 'file:braid.theme.css' });
  assert.equal(
    db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get().value,
    'file:braid.theme.css'
  );

  update({ key: 'published_themes', value: '[]' });
  assert.equal(
    db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get().value,
    ''
  );
});

test('existing invalid theme settings are hidden without rewriting stored data', t => {
  const { db, handlers, outgoing } = createAdminThemeHarness();
  t.after(() => db.close());
  db.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?)')
    .run('published_themes', '["braid.theme.css","missing.theme.css"]');
  db.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?)')
    .run('default_theme', 'file:missing.theme.css');

  handlers.get('get-server-settings')();
  const response = outgoing.find(item => item.event === 'server-settings').payload;
  assert.equal(response.published_themes, '["braid.theme.css"]');
  assert.equal(response.default_theme, '');
  assert.equal(
    db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get().value,
    'file:missing.theme.css'
  );
});
