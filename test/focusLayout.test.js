'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const FocusClassicLayout = require('../plugins/FocusClassicLayout.plugin.js');
const ROOT = path.join(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');
const pluginFiles = () => fs.readdirSync(PLUGINS).filter(f => f.endsWith('.plugin.js'));
const setup = (over = {}) => {
  const data = {}, store = { haven_muted_channels: JSON.stringify(over.muted || []) };
  global.HavenApi = { Data: { save: (p, k, v) => { (data[p] ||= {})[k] = v; }, load: (p, k, f) => data[p]?.[k] ?? f }, Layout: { release: () => true } };
  global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  global.location = { host: 'haven.test' };
  global.document = { hasFocus: () => true, hidden: false };
  global.window = { app: { user: { id: 1, username: 'tester' }, currentChannel: 'aaaa0001', unreadCounts: { aaaa0002: 3, aaaa0003: 1, dddd0001: 2 }, channels: [{ code: 'aaaa0001', name: 'general' }, { code: 'aaaa0002', name: 'ops' }, { code: 'aaaa0003', name: 'random' }, { code: 'dddd0001', name: 'dm', is_dm: true, dm_target: { username: 'bob' } }], ...over.app } };
  const f = new FocusClassicLayout();
  f._soon = () => {};
  return Object.assign(f, { data });
};
const msg = (id, content, extra = {}) => ({ id, content, user_id: 2, username: 'bob', created_at: '2026-10-22T15:00:00Z', ...extra });
test('mentions, @everyone and replies to me are classified; my own, DM and muted messages are not', () => {
  const f = setup({ muted: ['aaaa0003'] });
  assert.equal(f._classify('aaaa0002', msg(1, 'hey @tester look')), 'mention');
  assert.equal(f._classify('aaaa0002', msg(2, '@everyone standup')), 'mention');
  assert.equal(f._classify('aaaa0002', msg(3, '@testerbot ping')), null);
  assert.equal(f._classify('aaaa0002', msg(4, 'ok', { replyContext: { user_id: 1 } })), 'reply');
  assert.equal(f._classify('aaaa0002', msg(5, '@tester', { user_id: 1 })), null);
  assert.equal(f._classify('dddd0001', msg(6, '@tester')), null);
  assert.equal(f._classify('aaaa0003', msg(7, '@tester')), null);
});
test('live messages land once in the inbox, read when the open channel is on screen', () => {
  const f = setup();
  f._incoming({ channelCode: 'aaaa0002', message: msg(10, '@tester deploy?') });
  f._incoming({ channelCode: 'aaaa0002', message: msg(10, '@tester deploy?') });
  f._incoming({ channelCode: 'aaaa0001', message: msg(11, '@tester here') });
  const items = f._store();
  assert.equal(items.length, 2);
  assert.equal(items.find(x => x.id === 10).read, false);
  assert.equal(items.find(x => x.id === 11).read, true);
  assert.equal(f._counts().activity, 1);
  assert.ok(items.every(x => !('done' in x)));
});
test('search backfill keeps only mentions for its own token, already read', () => {
  const f = setup();
  f._sock = { emit: (ev, d) => { f._sent = [ev, d]; } };
  f._backfill();
  assert.equal(f._sent[0], 'search-messages');
  assert.equal(f._sent[1].query, 'tester');
  f._backfilled({ token: 7, results: [{ id: 20, content: '@tester old', user_id: 2, username: 'bob', channel_code: 'aaaa0002' }] });
  assert.equal(f._store().length, 0);
  f._backfilled({ token: f._sent[1].token, results: [{ id: 20, content: '@tester old', user_id: 2, username: 'bob', channel_code: 'aaaa0002' }, { id: 21, content: 'tester without at', user_id: 2, channel_code: 'aaaa0002' }] });
  assert.deepEqual(f._store().map(x => [x.id, x.read]), [[20, true]]);
});
test('opening a channel marks its items read; unread rows and badges follow Haven counts', () => {
  const f = setup({ muted: ['aaaa0003'] });
  f._incoming({ channelCode: 'aaaa0002', message: msg(30, '@tester one') });
  f._seen('aaaa0002');
  assert.equal(f._store()[0].read, true);
  assert.deepEqual(f._unreadRows().map(r => [r.kind, r.who, r.count]), [['unread', '#ops', 3], ['dm', 'bob', 2]]);
  assert.deepEqual(f._counts(), { server: -1, dms: 2, activity: 0 });
});
test('inbox keeps the newest 150 items', () => {
  const f = setup();
  f._keep(Array.from({ length: 170 }, (_, i) => ({ k: 'mention:aaaa0002:' + i, kind: 'mention', code: 'aaaa0002', id: i, at: i, read: true })));
  const items = f._store();
  assert.equal(items.length, 150);
  assert.equal(items[0].id, 169);
});
test('the rail keeps a saved order, drops unknown or repeated icons and always keeps Server', () => {
  const f = setup();
  assert.deepEqual(f._order(), ['server', 'dms', 'activity', 'you']);
  f.data.FocusLayout = { rail: 'games,dms,nope,games,settings' };
  assert.deepEqual(f._order(), ['server', 'games', 'dms', 'settings']);
  f.data.FocusLayout.rail = 'nope';
  assert.deepEqual(f._order(), ['server', 'dms', 'activity', 'you']);
});
test('adding, moving and removing rail icons saves the new order', () => {
  const f = setup();
  f._setRail([...f._order(), 'games']);
  assert.equal(f.data.FocusLayout.rail, 'server,dms,activity,you,games');
  f._moveTo('games', 'dms');
  assert.equal(f.data.FocusLayout.rail, 'server,games,dms,activity,you');
  f._moveTo('server', 'you');
  assert.equal(f.data.FocusLayout.rail, 'games,dms,activity,you,server');
  f._moveTo('dms', undefined);
  f._moveTo('dms', 'dms');
  assert.equal(f.data.FocusLayout.rail, 'games,dms,activity,you,server');
  f._setRail(f._order().filter(x => x !== 'activity'));
  assert.deepEqual(f._order(), ['games', 'dms', 'you', 'server']);
});
test('Alt+number opens the rail icons in order and skips shortcuts this member cannot use', () => {
  const f = setup(), clicked = [], btn = (tab, go, hidden = false) => ({ dataset: go ? { tab, go } : { tab }, hidden });
  global.document = { ...global.document, querySelector: (sel) => ({ '#a': { style: { display: '' } }, '#b': { style: { display: 'none' } } })[sel] || (sel.startsWith('#activities') ? { click: () => clicked.push(sel) } : null) };
  assert.deepEqual(['#a', '#b', '#c'].map(s => f._avail(s)), [true, false, false]);
  f._tabs = { querySelectorAll: () => [btn('server'), btn('members', '#sidebar-members-btn', true), btn('games', '#activities-btn'), btn('dms')] };
  f._select = (id, fromClick) => clicked.push([id, fromClick]);
  const key = (n, mods = {}) => { let used = false; f._key({ code: 'Digit' + n, altKey: true, preventDefault: () => { used = true; }, ...mods }); return used; };
  assert.ok(key(2));
  assert.ok(key(3));
  assert.ok(!key(4));
  assert.ok(!key(1, { ctrlKey: true }));
  assert.deepEqual(clicked, ['#activities-btn', ['dms', false]]);
});
test('the inbox and the chosen tab stay where Focus Classic saved them before the carousel was removed', () => {
  const f = setup();
  f._keep([{ k: 'mention:aaaa0002:1', kind: 'mention', code: 'aaaa0002', id: 1, at: 1, read: false }]);
  global.document = { ...global.document, documentElement: { hasAttribute: () => false, removeAttribute() {} } };
  f._render = () => {};
  f._select('dms', false);
  assert.deepEqual(Object.keys(f.data.FocusLayout).sort(), ['inbox:haven.test', 'tab']);
  assert.equal(f.data.FocusLayout.tab, 'dms');
});
test('the call strip shows only while in a call', () => {
  const f = setup(), attrs = new Set();
  global.document = { ...global.document, documentElement: { toggleAttribute: (a, on) => on ? attrs.add(a) : attrs.delete(a) } };
  window.app.voice = { inVoice: true };
  f._callSync();
  assert.ok(attrs.has('data-fc-voice'));
  window.app.voice.inVoice = false;
  f._callSync();
  assert.ok(!attrs.has('data-fc-voice'));
});
test('the Focus carousel is gone: no plugin file, nothing in the layout picker, no carousel code in Focus Classic', () => {
  assert.ok(!pluginFiles().includes('FocusLayout.plugin.js'));
  const picker = pluginFiles().filter(f => /Layout\.plugin\.js$/.test(f)).map(f => fs.readFileSync(path.join(PLUGINS, f), 'utf8').match(/@name\s+(.+)/)[1].trim().replace(/\s*layout$/i, ''));
  assert.ok(picker.includes('Focus Classic'));
  assert.ok(!picker.includes('Focus'));
  const src = fs.readFileSync(path.join(PLUGINS, 'FocusClassicLayout.plugin.js'), 'utf8');
  assert.doesNotMatch(src, /data-focus-desktop="1"|FocusLayout\.plugin|enablePlugin|fc-dock|fc-side/);
  ['DOCK', 'CALL', 'KEYS'].forEach(k => assert.equal(FocusClassicLayout[k], undefined));
  ['_queue', '_dockAct', '_aimAt', '_next', '_back', '_like', '_flash', '_done'].forEach(m => assert.equal(FocusClassicLayout.prototype[m], undefined));
});
test('engaging Focus Classic saves only its own choice and never turns the carousel on', () => {
  const f = setup(), attrs = new Map();
  global.document = { ...global.document, documentElement: { setAttribute: (a, v) => attrs.set(a, v), removeAttribute: (a) => attrs.delete(a), hasAttribute: (a) => attrs.has(a), toggleAttribute: () => {} } };
  Object.assign(f, { _placed: [], _built: [], _media: { matches: false } });
  f._engage();
  assert.deepEqual(f.data, { FocusClassicLayout: { layoutOn: '1' } });
  assert.equal(attrs.get('data-focus-layout'), 'classic');
  assert.ok(!attrs.has('data-focus-desktop'));
  f._disengage();
  assert.deepEqual(f.data, { FocusClassicLayout: { layoutOn: '0' } });
  assert.ok(!attrs.has('data-focus-layout'));
});
const loaderRun = async ({ data = {}, enabled = [], plugins = pluginFiles().map(file => ({ file })), ok = true }) => {
  const store = { haven_plugin_data: JSON.stringify(data), haven_enabled_plugins: JSON.stringify(enabled) };
  const localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const listeners = {}, win = { location: { search: '', href: 'https://haven.test/app.html' }, addEventListener() {} };
  const documentElement = { setAttribute() {}, removeAttribute() {}, hasAttribute: () => false, style: { setProperty() {}, removeProperty() {} }, classList: { add() {} } };
  const document = { readyState: 'complete', body: null, documentElement, head: { appendChild() {} }, createElement: () => ({ remove() {} }), getElementById: () => null, querySelectorAll: () => [], addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); }, dispatchEvent: (e) => (listeners[e.type] || []).forEach(fn => fn(e)) };
  const done = new Promise(resolve => document.addEventListener('haven:plugins-loaded', resolve));
  const fetch = async (url) => url === '/api/plugins' ? { ok, json: async () => plugins } : url === '/api/themes' ? { ok: true, json: async () => [] } : { ok: true, text: async () => `class P { start() {} stop() {} }\n_win[${JSON.stringify(url.split('/').pop().split('?')[0].replace('.plugin.js', ''))}] = P;` };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/plugin-loader.js'), 'utf8'), { console, CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }, document, fetch, globalThis: win, localStorage, location: win.location, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout: (fn) => { fn(); return 1; }, t: k => k, URLSearchParams, window: win });
  await done;
  return { data: JSON.parse(store.haven_plugin_data), enabled: JSON.parse(store.haven_enabled_plugins), loaded: win.HavenPluginLoader.loadedPlugins };
};
test('a saved carousel choice is cleared, so the member lands on Haven\'s default instead of a layout that no longer exists', async () => {
  const r = await loaderRun({
    data: { FocusLayout: { layoutOn: '1', tab: 'dms', 'inbox:haven.test': '[]' }, BraidLayout: { layoutOn: '0' }, CompactLayout: { layoutOn: '0' }, FocusClassicLayout: { layoutOn: '0' }, HavenGlyphs: { size: '2' } },
    enabled: ['FocusLayout.plugin.js', 'BraidLayout.plugin.js', 'FocusClassicLayout.plugin.js', 'HavenGlyphs.plugin.js']
  });
  ['FocusLayout', 'BraidLayout', 'CompactLayout', 'FocusClassicLayout'].forEach(k => assert.equal(r.data[k].layoutOn, undefined, k));
  assert.deepEqual(r.data.FocusLayout, { tab: 'dms', 'inbox:haven.test': '[]' });
  assert.deepEqual(r.data.HavenGlyphs, { size: '2' });
  assert.deepEqual(r.enabled, ['HavenGlyphs.plugin.js']);
  assert.equal(r.loaded.get('BraidLayout.plugin.js').enabled, false);
  assert.equal(r.loaded.get('FocusClassicLayout.plugin.js').enabled, false);
});
test('a saved Focus Classic or other existing layout choice is left alone', async () => {
  const data = { FocusClassicLayout: { layoutOn: '1', tab: 'activity' }, BraidLayout: { layoutOn: '0' }, FocusLayout: { layoutOn: '0' } }, enabled = ['FocusClassicLayout.plugin.js', 'BraidLayout.plugin.js'];
  const r = await loaderRun({ data, enabled });
  assert.deepEqual(r.data, data);
  assert.deepEqual(r.enabled, enabled);
  assert.equal(r.loaded.get('FocusClassicLayout.plugin.js').enabled, true);
});
test('an empty or failed plugin list never clears anyone\'s layout choice', async () => {
  const data = { FocusLayout: { layoutOn: '1' }, BraidLayout: { layoutOn: '0' } }, enabled = ['FocusLayout.plugin.js'];
  for (const run of [{ plugins: [] }, { ok: false }]) {
    const r = await loaderRun({ data, enabled, ...run });
    assert.deepEqual(r.data, data);
    assert.deepEqual(r.enabled, enabled);
  }
});
