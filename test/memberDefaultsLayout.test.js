'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const KNOWN = ['BraidLayout', 'ChromeLayout', 'CompactLayout', 'FocusClassicLayout'];
const defaults = (layout, v = 1) => ({ v, s: layout == null ? {} : { layout } });
const load = async () => (await import(pathToFileURL(path.join(__dirname, '..', 'public/js/modules/app-member-defaults.js')).href)).default;
const member = async ({ plugin = {}, current = '', snap = defaults('FocusClassicLayout'), rec = null, raw = null }) => {
  const MD = await load(), store = { haven_plugin_data: raw ?? JSON.stringify(plugin), ...(rec ? { haven_member_defaults_7: JSON.stringify(rec) } : {}) }, applied = [];
  global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  global.window = { _activeLayoutKey: () => current, _layoutPluginFiles: () => KNOWN.map(key => ({ key, file: `${key}.plugin.js` })), _setLayout: (v) => { applied.push(v); current = v; } };
  Object.assign(Object.create(MD), { user: { id: 7 }, serverSettings: { member_defaults: JSON.stringify(snap) }, _memberDefaultsSettingsIn: true, _prefsReceived: true, _memberDefaultsWhenPlugins: (fn) => fn(), _userPrefs: {}, socket: { emit() {} } })._maybeApplyMemberDefaults();
  return { applied, record: JSON.parse(store.haven_member_defaults_7 || 'null') };
};
test('an admin default layout reaches a member who never picked one, even when a layout started by itself', async () => {
  const r = await member({ current: 'CompactLayout' });
  assert.deepEqual(r.applied, ['FocusClassicLayout']);
  assert.deepEqual(r.record, { v: 1, a: { layout: 'FocusClassicLayout' } });
});
test('an admin default layout reaches a member on Haven\'s own layout who never picked one', async () => {
  assert.deepEqual((await member({ current: '' })).applied, ['FocusClassicLayout']);
});
test('a layout the member picked is never overwritten, Original included', async () => {
  assert.deepEqual((await member({ plugin: { CompactLayout: { layoutOn: '1' } }, current: 'CompactLayout' })).applied, []);
  assert.deepEqual((await member({ plugin: { BraidLayout: { layoutOn: '0' }, CompactLayout: { layoutOn: '0' } }, current: '' })).applied, []);
  assert.deepEqual((await member({ plugin: { ChromeLayout: { layoutOn: '1' } }, current: 'ChromeLayout', snap: defaults('') })).applied, []);
});
test('with no admin default saved nothing is applied or recorded', async () => {
  const r = await member({ current: 'CompactLayout', snap: defaults(null) });
  assert.deepEqual(r.applied, []);
  assert.equal(r.record, null);
});
test('a newer admin default replaces the one it set earlier, but not a layout picked since', async () => {
  const rec = { v: 1, a: { layout: 'FocusClassicLayout' } }, plugin = { FocusClassicLayout: { layoutOn: '1' }, BraidLayout: { layoutOn: '0' } };
  assert.deepEqual((await member({ plugin, rec, current: 'FocusClassicLayout', snap: defaults('ChromeLayout', 2) })).applied, ['ChromeLayout']);
  assert.deepEqual((await member({ plugin: { ...plugin, BraidLayout: { layoutOn: '1' }, FocusClassicLayout: { layoutOn: '0' } }, rec, current: 'BraidLayout', snap: defaults('ChromeLayout', 2) })).applied, []);
});
test('an admin default naming a layout this server does not have is skipped, and unreadable layout data is preserved', async () => {
  const r = await member({ current: 'CompactLayout', snap: defaults('FocusLayout') });
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.record, { v: 1, a: {} });
  assert.deepEqual((await member({ raw: '{not json', current: 'CompactLayout' })).applied, []);
});
