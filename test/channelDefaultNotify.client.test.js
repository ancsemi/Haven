'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const load = async () => (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-server-mute.js')).href)).default;

const makeApp = async (channels, stored = {}) => {
  const mod = await load();
  const store = { ...stored };
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  global.fetch = () => Promise.resolve({ ok: true });
  const app = Object.assign(Object.create(null), mod, { channels, _userPrefs: {}, _syncChannelMutePref: () => {} });
  return { app, store };
};

const chans = [
  { code: 'a', is_dm: 0, default_notify: 'muted' },
  { code: 'b', is_dm: 0, default_notify: 'mentions' },
  { code: 'c', is_dm: 0, default_notify: 'all' },
  { code: 'd', is_dm: 1, default_notify: 'muted' },
];

test('a channel default of muted counts as muted until the member chooses', async () => {
  const { app } = await makeApp(chans);
  assert.deepEqual(app._mutedChannelList(), ['a']);
  assert.equal(app._channelNotifyLevel('a'), 'muted');
  assert.equal(app._channelNotifyLevel('b'), 'mentions');
  assert.equal(app._channelNotifyLevel('c'), 'all');
  assert.equal(app._channelNotifyLevel('d'), 'all', 'a DM ignores the default');
});

test('a personal choice beats the default both ways', async () => {
  const { app } = await makeApp(chans, { haven_unmuted_channels: '["a","b"]', haven_muted_channels: '["c"]' });
  assert.equal(app._channelNotifyLevel('a'), 'all');
  assert.equal(app._channelNotifyLevel('b'), 'all');
  assert.equal(app._channelNotifyLevel('c'), 'muted');
  assert.deepEqual(app._mutedChannelList(), ['c']);
});

test('toggling mute records the choice so the default stops applying', async () => {
  const { app, store } = await makeApp(chans);
  app._setChannelMuted('a', false);
  assert.equal(store.haven_unmuted_channels, '["a"]');
  assert.equal(app._channelNotifyLevel('a'), 'all');
  app._setChannelMuted('a', true);
  assert.equal(store.haven_unmuted_channels, '[]');
  assert.equal(app._channelNotifyLevel('a'), 'muted');
});

test('a mentions default only lets mentions, replies and DMs make noise', async () => {
  const { app } = await makeApp(chans);
  const quiet = (o) => app._notifyBlockedByMutes({ senderId: 9, isDm: false, isMention: false, isReply: false, channelCode: 'b', ...o });
  assert.equal(quiet({}), true);
  assert.equal(quiet({ isMention: true }), false);
  assert.equal(quiet({ isReply: true }), false);
  assert.equal(quiet({ isDm: true }), false);
  assert.equal(quiet({ channelCode: 'c' }), false);
  assert.equal(quiet({ channelCode: undefined }), false);
});

test('unreadable stored lists do not break the mute checks', async () => {
  const { app } = await makeApp(chans, { haven_muted_channels: '{oops', haven_unmuted_channels: '5' });
  assert.deepEqual(app._mutedChannelList(), ['a']);
});
