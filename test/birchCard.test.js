'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = (p) => import(pathToFileURL(path.join(__dirname, '..', p)).href);
let birchGame, birchAvailable, withBirch, Context;
test.before(async () => {
  const birch = await load('public/js/modules/app-birch.js');
  ({ birchGame, birchAvailable, withBirch } = birch);
  Context = { ...(await load('public/js/modules/app-context.js')).default, ...birch.default };
});
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const GAMES = [{ id: 'flappy', name: 'Shippy Container' }, { id: 'io-games', name: '.io Games' }];
test('the card points at the same-origin Birch client and uses the shared game id', () => {
  const g = birchGame('A town');
  assert.deepEqual([g.id, g.name, g.path, g.description], ['willowmere', 'Birch', '/birch/index.html', 'A town']);
});
test('Birch is asked about with the member\'s session and counts only on an explicit yes', async () => {
  const calls = [];
  const spy = (r) => async (url, opts) => { calls.push([url, opts.headers.Authorization]); return r(); };
  assert.equal(await birchAvailable(spy(reply(200, { enabled: true })), 'tok'), true);
  assert.deepEqual(calls[0], ['/api/birch/status', 'Bearer tok']);
  assert.equal(await birchAvailable(reply(200, { enabled: false }), 't'), false);
  assert.equal(await birchAvailable(reply(200, { enabled: 'yes' }), 't'), false);
  assert.equal(await birchAvailable(reply(200, {}), 't'), false);
  assert.equal(await birchAvailable(reply(401, { error: 'Unauthorized' }), 't'), false);
  assert.equal(await birchAvailable(reply(500, null), 't'), false);
  assert.equal(await birchAvailable(async () => { throw new Error('offline'); }, 't'), false);
  assert.equal(await birchAvailable(async () => ({ ok: true, json: async () => { throw new Error('html'); } }), 't'), false);
});
test('withBirch adds the card once when Birch is up and drops it when it is gone', () => {
  const card = birchGame('x');
  const up = withBirch(GAMES, true, card);
  assert.deepEqual(up.map((g) => g.id), ['flappy', 'io-games', 'willowmere']);
  assert.deepEqual(withBirch(up, true, card).map((g) => g.id), ['flappy', 'io-games', 'willowmere']);
  assert.deepEqual(withBirch(up, false, card).map((g) => g.id), ['flappy', 'io-games']);
  assert.deepEqual(withBirch(GAMES, false, card), GAMES);
  assert.equal(GAMES.length, 2);
});
function fakeDom() {
  const el = () => ({ dataset: {}, style: {}, children: [], innerHTML: '', className: '', appendChild(c) { this.children.push(c); }, addEventListener() {}, querySelector: () => null });
  const modal = el();
  const grid = el();
  globalThis.document = { getElementById: (id) => (id === 'activities-modal' ? modal : id === 'activities-grid' ? grid : null), createElement: el };
  globalThis.t = (key) => key;
  return { modal, grid };
}
async function openActivities(fetchImpl) {
  const { modal, grid } = fakeDom();
  globalThis.fetch = fetchImpl;
  const app = Object.create(Context);
  Object.assign(app, { token: 'tok', user: { isAdmin: false }, _gamesRegistry: GAMES.map((g) => ({ ...g, icon: 'i', path: '/p' })), _escapeHtml: (s) => String(s) });
  await app._openActivitiesModal();
  return { shown: modal.style.display, ids: grid.children.map((c) => c.dataset.gameId), app };
}
const routes = (birch) => async (url) => (url === '/api/flash-rom-status' ? { ok: true, json: async () => ({ roms: [], allInstalled: true }) } : url === '/api/birch/status' ? birch() : { ok: false, status: 404, json: async () => ({}) });
test('the Activities window lists Birch only when this server runs it', async () => {
  const up = await openActivities(routes(() => ({ ok: true, json: async () => ({ enabled: true }) })));
  assert.equal(up.shown, 'flex');
  assert.deepEqual(up.ids, ['flappy', 'io-games', 'willowmere']);
  const off = await openActivities(routes(() => ({ ok: true, json: async () => ({ enabled: false }) })));
  assert.deepEqual(off.ids, ['flappy', 'io-games']);
  const dead = await openActivities(routes(() => { throw new Error('network'); }));
  assert.deepEqual(dead.ids, ['flappy', 'io-games']);
  assert.equal(dead.shown, 'flex');
});
test('the card goes away again when Birch stops between two openings', async () => {
  const first = await openActivities(routes(() => ({ ok: true, json: async () => ({ enabled: true }) })));
  assert.ok(first.app._gamesRegistry.some((g) => g.id === 'willowmere'));
  globalThis.fetch = routes(() => ({ ok: true, json: async () => ({ enabled: false }) }));
  await first.app._openActivitiesModal();
  assert.ok(!first.app._gamesRegistry.some((g) => g.id === 'willowmere'));
});
test('the built-in games list does not carry a Birch card of its own', () => {
  const fs = require('node:fs');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-ui.js'), 'utf8');
  assert.ok(!/id: 'willowmere'/.test(ui));
  assert.ok(!/haven_custom_activities/.test(ui));
});
