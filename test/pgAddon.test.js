'use strict';

// pg follows the on-demand S3 packaging policy: SQLite never downloads it,
// and PostgreSQL installs only the pinned copy in the data directory.
//
//   node --test test/pgAddon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const modules = require('node:module');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-pg-addon-'));
process.env.HAVEN_DATA_DIR = DATA;
delete process.env.HAVEN_DATABASE_URL;
const ROOT = path.join(__dirname, '..');
const PINNED = path.join(ROOT, 'addons', 'postgres');
const INSTALLED = path.join(DATA, 'addons', 'postgres');
const FILES = ['package.json', 'package-lock.json'];

test.after(() => fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

test('normal Haven installs and Docker dependency layers do not include pg', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  const all = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  assert.equal(all.pg, undefined);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/pg'], undefined);
});

test('the add-on pins exact versions and has an integrity-checked lockfile', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PINNED, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, name);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(PINNED, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const [name, entry] of Object.entries(lock.packages)) if (name) assert.ok(entry.integrity, name);
});

test('SQLite never loads the PostgreSQL driver, installer or client', () => {
  const { fromEnv } = require('../src/db');
  for (const value of [undefined, '', '   ']) {
    const db = fromEnv({ HAVEN_DATABASE_URL: value });
    assert.equal(db.kind, 'sqlite');
    db.close();
  }
  const loaded = Object.keys(require.cache);
  assert.ok(!loaded.some(file => /[\\/]db[\\/](postgres|pgAddon)\.js$/.test(file)));
  assert.ok(!loaded.some(file => /[\\/]node_modules[\\/]pg[\\/]/.test(file)));
  assert.equal(fs.existsSync(path.join(DATA, 'addons')), false);
});

function writeClientMarker() {
  const dir = path.join(INSTALLED, 'node_modules', 'pg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
}

function seedInstalled() {
  fs.rmSync(INSTALLED, { recursive: true, force: true });
  fs.mkdirSync(INSTALLED, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(PINNED, file), path.join(INSTALLED, file));
  writeClientMarker();
}

function freshAddon(t, install) {
  const file = require.resolve('../src/db/pgAddon');
  delete require.cache[file];
  const sdk = {};
  t.mock.method(childProcess, 'spawnSync', install);
  t.mock.method(modules, 'createRequire', () => name => {
    assert.equal(name, 'pg');
    return sdk;
  });
  t.mock.method(console, 'log', () => {});
  const addon = require(file);
  t.after(() => { delete require.cache[file]; });
  return { addon, sdk };
}

test('first use installs the locked client into DATA_DIR with scripts disabled and caches it', (t) => {
  fs.rmSync(INSTALLED, { recursive: true, force: true });
  const calls = [];
  const { addon, sdk } = freshAddon(t, (cmd, args, options) => {
    calls.push({ cmd, args, options });
    writeClientMarker();
    return { status: 0 };
  });
  assert.equal(addon.loadPg(), sdk);
  assert.equal(addon.loadPg(), sdk);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, INSTALLED);
  assert.equal(calls[0].options.windowsHide, true);
  for (const flag of ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']) {
    assert.ok(calls[0].args.includes(flag), flag);
  }
  for (const file of FILES) {
    assert.equal(fs.readFileSync(path.join(INSTALLED, file), 'utf8'), fs.readFileSync(path.join(PINNED, file), 'utf8'));
  }
});

test('a later start reuses the installed client when its pins match', (t) => {
  seedInstalled();
  const { addon, sdk } = freshAddon(t, () => { throw new Error('must not run npm'); });
  assert.equal(addon.loadPg(), sdk);
});

test('a changed lockfile replaces the old client with the current pins', (t) => {
  seedInstalled();
  fs.writeFileSync(path.join(INSTALLED, 'package-lock.json'), '{}');
  const stale = path.join(INSTALLED, 'node_modules', 'old-client.txt');
  fs.writeFileSync(stale, 'stale');
  let calls = 0;
  const { addon, sdk } = freshAddon(t, () => {
    calls++;
    writeClientMarker();
    return { status: 0 };
  });
  assert.equal(addon.loadPg(), sdk);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(path.join(INSTALLED, 'package-lock.json'), 'utf8'),
    fs.readFileSync(path.join(PINNED, 'package-lock.json'), 'utf8'));
});

test('an install failure gives manual steps and leaves the next attempt able to retry', (t) => {
  fs.rmSync(INSTALLED, { recursive: true, force: true });
  let calls = 0;
  const { addon, sdk } = freshAddon(t, () => {
    calls++;
    if (calls === 1) return { status: 1, stderr: 'network unavailable' };
    writeClientMarker();
    return { status: 0 };
  });
  assert.throws(() => addon.loadPg(), err => {
    assert.match(err.message, /Could not install the PostgreSQL add-on/);
    assert.match(err.message, /network unavailable/);
    assert.match(err.message, /npm ci --omit=dev --ignore-scripts/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(INSTALLED, 'package-lock.json')), false);
  assert.equal(addon.loadPg(), sdk);
  assert.equal(calls, 2);
});
