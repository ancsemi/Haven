'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-sounds.js'), 'utf8');
const loadApp = (names, prefs = {}) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, document: {}, window: {}, localStorage: {}, t: (key) => key, console });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-sounds.js' });
  const app = Object.create(context.module.exports);
  app.customSounds = names.map(name => ({ name, url: `/sounds/${name}.mp3` }));
  app._soundPrefs = prefs;
  app.saves = 0;
  app._saveUserSoundPrefs = async () => { app.saves += 1; };
  return app;
};
const order = (app) => app._orderedSounds(app.customSounds).map(s => s.name);
test('with nothing moved the sounds keep the server order', () => {
  assert.deepEqual(order(loadApp(['a', 'b', 'c'])), ['a', 'b', 'c']);
});
test('moved sounds come first in their saved order, the rest keep their place after them', () => {
  const app = loadApp(['a', 'b', 'c', 'd'], { c: { hidden: false, customOrder: 0 }, a: { hidden: false, customOrder: 1 } });
  assert.deepEqual(order(app), ['c', 'a', 'b', 'd']);
});
test('an order that is missing, null or not a number is ignored', () => {
  const app = loadApp(['a', 'b', 'c'], { b: { customOrder: null }, c: { customOrder: 'x' }, a: { hidden: true } });
  assert.deepEqual(order(app), ['a', 'b', 'c']);
});
test('moving a sound down puts it after the one it is dropped on, and saves every position', async () => {
  const app = loadApp(['a', 'b', 'c', 'd']);
  assert.equal(await app._moveSound('a', 'c'), true);
  assert.deepEqual(order(app), ['b', 'c', 'a', 'd']);
  assert.deepEqual(Object.fromEntries(Object.entries(app._soundPrefs).map(([n, p]) => [n, p.customOrder])), { b: 0, c: 1, a: 2, d: 3 });
  assert.equal(app.saves, 1);
});
test('moving a sound up puts it before the one it is dropped on and keeps hidden flags', async () => {
  const app = loadApp(['a', 'b', 'c', 'd'], { d: { hidden: true } });
  assert.equal(await app._moveSound('d', 'b'), true);
  assert.deepEqual(order(app), ['a', 'd', 'b', 'c']);
  assert.equal(app._soundPrefs.d.hidden, true);
});
test('dropping a sound on itself or an unknown sound changes nothing and saves nothing', async () => {
  const app = loadApp(['a', 'b']);
  assert.equal(await app._moveSound('a', 'a'), false);
  assert.equal(await app._moveSound('a', 'zzz'), false);
  assert.equal(await app._moveSound('zzz', 'a'), false);
  assert.equal(app.saves, 0);
  assert.deepEqual(app._soundPrefs, {});
});
test('both soundboard views draw from the ordered list and bind the drag', () => {
  assert.equal((source.match(/this\._orderedSounds\(this\.customSounds \|\| \[\]\)\.filter/g) || []).length, 2);
  assert.equal((source.match(/this\._bindSoundReorder\(grid,/g) || []).length, 2);
});
