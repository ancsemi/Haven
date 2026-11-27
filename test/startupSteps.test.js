'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function serverManager(stored) {
  const data = new Map([['haven_servers', JSON.stringify(stored)]]);
  const context = {
    URL, Date, Map, Set, console, setInterval, clearInterval,
    window: { location: { origin: 'https://home.example.com' } },
    localStorage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) },
    fetch: async () => ({ ok: true, json: async () => ({ blob: 'x' }) }),
  };
  vm.runInNewContext(`${read('public/js/servers.js')}\nglobalThis.Manager = ServerManager;`, context);
  return new context.Manager();
}

test('a saved server without a name is given its address', () => {
  const manager = serverManager([{ url: 'https://phone.example.com', addedAt: 7 }, { url: 'https://named.example.com', name: 'Named' }]);
  assert.deepEqual(Array.from(manager.servers, s => s.name), ['https://phone.example.com', 'Named']);
});

test('a synced server without a name is given its address', async () => {
  const manager = serverManager([]);
  manager._decryptBlob = async () => JSON.stringify([{ url: 'https://phone.example.com', addedAt: 7 }]);
  manager._encryptBlob = async text => text;
  manager.checkServer = async () => ({});
  assert.equal((await manager.syncWithServer('token', 'key')).added, 1);
  assert.deepEqual(Array.from(manager.servers, s => s.name), ['https://phone.example.com']);
});

test('a startup step that throws does not stop the steps after it', () => {
  const guard = read('public/js/app.js').match(/^for \(const name of Object\.keys\(HavenApp\.prototype\)[\s\S]*?^}$/m);
  assert.ok(guard, 'the guard is in app.js');
  const errors = [];
  function HavenApp() {}
  Object.assign(HavenApp.prototype, {
    _setupBroken() { throw new Error('broken'); },
    _initLater() { this.later = true; return 7; },
    _renderThing() { throw new Error('not guarded'); },
  });
  vm.runInNewContext(guard[0], { HavenApp, console: { error: (...a) => errors.push(a.join(' ')) } });
  const app = new HavenApp();
  app._setupBroken();
  assert.equal(app._initLater(), 7);
  assert.equal(app.later, true);
  assert.throws(() => app._renderThing());
  assert.match(errors[0], /_setupBroken failed/);
});

test('drawing the typing line works when typing was never set up', async () => {
  const source = read('public/js/modules/app-typing.js').replace('export default {', 'globalThis.methods = {');
  const context = { document: { getElementById: () => ({ textContent: 'x' }) }, clearTimeout() {}, setTimeout() {}, t: k => k };
  vm.runInNewContext(source, context);
  assert.doesNotThrow(() => Object.assign({ currentChannel: 'abc' }, context.methods)._typingRender());
});
