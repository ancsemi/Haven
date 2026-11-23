'use strict';

// The account's synced server list (the encrypted copy each Haven server
// keeps): a server the user removed on one device stays removed on the
// others, and on a new device or a new address for the same server. These
// tests load servers.js once per device, each with its own storage, against
// one stored list.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/servers.js'), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

const HOME = 'https://community.example.com';
const X = 'https://x.example.com';
const Y = 'https://y.example.com';
const Z = 'https://z.example.com';

function createStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function storageWith(urls) {
  return createStorage({ haven_servers: JSON.stringify(urls.map(u => ({ name: u, url: u, addedAt: 1 }))) });
}

// The stored list on the server: { blob } read and written like the route.
function account(entries = null) {
  return { blob: entries ? JSON.stringify(entries) : null, puts: 0 };
}

/** A device: servers.js with its own storage, talking to one account. The
 *  list is stored as plain JSON here; the encryption is not what is tested. */
function device(acct, { storage = createStorage(), origin = HOME, desktop = null } = {}) {
  const warnings = [];
  const context = vm.createContext({
    window: desktop ? { havenDesktop: desktop } : {},
    localStorage: storage,
    location: { origin },
    fetch: async (url, opts = {}) => {
      if (url === '/api/health') return { ok: true, json: async () => ({ name: 'Home', fingerprint: 'home' }) };
      if (url === '/api/auth/user-servers') {
        if (opts.method === 'PUT') { acct.blob = JSON.parse(opts.body).blob; acct.puts++; return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: true, json: async () => ({ blob: acct.blob }) };
      }
      throw new Error('offline');
    },
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {}, info() {}, error: (...a) => warnings.push(a.join(' ')) },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise,
  });
  vm.runInContext(`${SOURCE}\nglobalThis.ServerManager = ServerManager;`, context, { filename: 'servers.js' });
  const manager = new context.ServerManager();
  manager._encryptBlob = async text => text;
  manager._decryptBlob = async text => text;
  const sync = () => manager.syncWithServer('token', 'key');
  const has = url => manager.servers.some(s => s.url === url);
  return { manager, storage, warnings, sync, has };
}

const stored = acct => JSON.parse(acct.blob);
const storedServers = acct => stored(acct).filter(e => e.url).map(e => e.url);
const storedRemovals = acct => stored(acct).filter(e => !e.url).map(e => e.removed);

test('a server removed on one device does not come back on a new device or a new address', async () => {
  const acct = account();
  const laptop = device(acct, { storage: storageWith([X, Y, Z]) });
  await laptop.sync();
  assert.deepEqual(storedServers(acct), [X, Y, Z]);

  laptop.manager.remove(Y);
  await laptop.sync();
  assert.deepEqual(storedServers(acct), [X, Z]);
  assert.deepEqual(storedRemovals(acct), [Y]);

  // A device that never saw the list, and the same server under a new name
  // (new address, so new and empty browser storage).
  for (const origin of [HOME, 'https://new-name.example.com']) {
    const fresh = device(acct, { origin });
    const result = await fresh.sync();
    assert.equal(result.added, 2);
    assert.deepEqual(plain(fresh.manager.servers.map(s => s.url)), [X, Z]);
    assert.deepEqual(fresh.warnings, []);
  }
  assert.deepEqual(laptop.warnings, []);
});

test('a removal reaches a device that still lists the server', async () => {
  const acct = account();
  const laptop = device(acct, { storage: storageWith([X, Y]) });
  const phone = device(acct, { storage: storageWith([X, Y]) });
  await laptop.sync();
  await phone.sync();

  laptop.manager.remove(Y);
  await laptop.sync();
  const result = await phone.sync();
  assert.equal(result.removed, 1);
  assert.ok(!phone.has(Y));
  assert.deepEqual(storedServers(acct), [X], 'the phone does not hand it back');
  assert.ok(!phone.manager.add('Y', Y), 'and a later sync cannot add it');
});

test('adding a removed server again by hand brings it back on every device', async () => {
  const acct = account();
  const laptop = device(acct, { storage: storageWith([X, Y]) });
  const phone = device(acct, { storage: storageWith([X, Y]) });
  await laptop.sync();
  laptop.manager.remove(Y);
  await laptop.sync();
  await phone.sync();
  assert.ok(!phone.has(Y));

  await new Promise(r => setTimeout(r, 5));
  assert.ok(phone.manager.add('Y', Y, null, { userInitiated: true }));
  await phone.sync();
  assert.deepEqual(storedServers(acct), [X, Y]);
  assert.deepEqual(storedRemovals(acct), []);

  await laptop.sync();
  assert.ok(laptop.has(Y), 'back on the device that removed it');
  assert.deepEqual(storedRemovals(acct), [], 'and that device does not remove it again');
});

test('a removal from before removals were synced stays on its own device', async () => {
  const acct = account();
  const storage = storageWith([X]);
  storage.setItem('haven_servers_removed', JSON.stringify([Y]));
  const old = device(acct, { storage });
  const phone = device(acct, { storage: storageWith([X, Y]) });
  await phone.sync();
  await old.sync();
  assert.ok(!old.has(Y), 'still removed here');
  assert.deepEqual(storedRemovals(acct), [], 'but not taken away from the phone');
  await phone.sync();
  assert.ok(phone.has(Y));
});

test('a list written by an older version is read as before, and its entries are not removals', async () => {
  const acct = account([{ url: X, name: 'X', addedAt: 1 }, { url: Y + '/app', name: 'Y', addedAt: 1 }, null, { name: 'no address' }]);
  const fresh = device(acct);
  const result = await fresh.sync();
  assert.equal(result.added, 2);
  assert.deepEqual(plain(fresh.manager.servers.map(s => s.url)), [X, Y]);
  assert.deepEqual(fresh.warnings, []);
});

test('an unchanged list is not written again', async () => {
  const acct = account();
  const laptop = device(acct, { storage: storageWith([X, Y]) });
  await laptop.sync();
  laptop.manager.remove(Y);
  await laptop.sync();
  const puts = acct.puts;
  await laptop.sync();
  await device(acct).sync();
  assert.equal(acct.puts, puts);
});

test('in the Desktop app a server in its list stays, and the removal is kept for other devices', async () => {
  const acct = account([{ url: X, name: 'X', addedAt: 1 }, { removed: Y, at: 50 }]);
  const list = { servers: [{ url: X, name: 'X' }, { url: Y, name: 'Y' }], removed: [], order: [], hasOrder: false };
  const desktop = { serverListGated: true, initialServerList: list, getServerList: async () => list };
  const app = device(acct, { desktop });
  assert.ok(app.has(Y), 'listed by the Desktop app');
  await app.sync();
  assert.ok(app.has(Y), 'the app decides what its own list shows');
  assert.deepEqual(storedRemovals(acct), [Y], 'the removal is not dropped');

  const phone = device(acct);
  await phone.sync();
  assert.ok(!phone.has(Y), 'another device still leaves it out');
});

test('this server itself is never removed by a synced removal', async () => {
  const acct = account([{ url: HOME, name: 'Home', addedAt: 1 }, { removed: HOME, at: 50 }]);
  const page = device(acct, { storage: storageWith([HOME, X]) });
  await page.sync();
  assert.ok(page.has(HOME));
});
