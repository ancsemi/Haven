'use strict';

// Exercise the real updater against temporary files and a fake GitHub/blocklist
// transport. No public releases or installed user extensions are changed.
// Assertions cover both the returned result and the bytes left on disk.


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createExtensionUpdater,
  validateReleaseManifest,
  validateBlocklist,
  sha256,
  isPublicAddress,
} = require('../src/extensionUpdates');
const repo = 'example-owner/extensions';
const id = 'org.example.layout';
const pluginSource = (version, extra = '') =>
  Buffer.from(`/**\n * @id ${id}\n * @version ${version}\n * @update-repo ${repo}\n */\n${extra}`);

// Each test starts with version 1.0.0 installed and an immutable 1.1.0 release.
// Tests can change remote bytes, metadata or availability independently to
// reproduce failures at the boundary being checked.
function createUpdateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { plugin: path.join(root, 'plugins'), theme: path.join(root, 'themes') };
  Object.values(dirs).forEach(d => fs.mkdirSync(d));
  const file = path.join(dirs.plugin, 'Example.plugin.js');
  fs.writeFileSync(file, pluginSource('1.0.0'));
  const candidate = {
    id,
    type: 'plugin',
    version: '1.1.0',
    requires: { haven: '>=4.5.0 <5.0.0' },
    asset: 'Example.plugin.js',
    sha256: sha256(pluginSource('1.1.0')),
  };
  const release = {
    id: 1,
    immutable: true,
    draft: false,
    prerelease: false,
    tag_name: 'v1.1.0',
    body: 'Release notes',
    assets: [
      { id: 2, name: 'haven-release.json', state: 'uploaded' },
      { id: 3, name: candidate.asset, state: 'uploaded' },
    ],
  };
  const fixture = {
    dirs,
    file,
    candidate,
    release,
    list: { schemaVersion: 1, updatedAt: '2026-09-09T00:00:00Z', blocked: [] },
    bytes: pluginSource('1.1.0'),
    calls: [],
    time: 1,
  };
  fixture.fetchBytes = async url => {
    fixture.calls.push(url);
    if (fixture.beforeFetch) await fixture.beforeFetch(url);
    if (url.includes('blocklist.json')) {
      if (fixture.offline) throw Error('offline');
      return Buffer.from(JSON.stringify(fixture.list));
    }
    if (url.includes('releases?')) return Buffer.from(JSON.stringify([release]));
    if (url.endsWith('/assets/2'))
      return Buffer.from(JSON.stringify({ schemaVersion: 1, extensions: [candidate] }));
    if (url.endsWith('/assets/3')) return fixture.bytes;
    if (url.endsWith('/releases/1')) return Buffer.from(JSON.stringify(release));
    throw Error('Unexpected URL: ' + url);
  };
  fixture.options = {
    dirs,
    stateDir: path.join(root, 'state'),
    havenVersion: '4.5.0',
    fetchBytes: fixture.fetchBytes,
    now: () => fixture.time,
  };
  fixture.updater = createExtensionUpdater(fixture.options);
  fixture.offer = async () =>
    (await fixture.updater.check('admin')).extensions[0].offers.find(o => o.action === 'install');
  return fixture;
}

test('manual check, install and rollback preserve filename and original bytes', async t => {
  const fixture = createUpdateFixture(t);
  assert.equal(fixture.calls.length, 0);
  const offer = await fixture.offer();
  assert.equal(offer.version, '1.1.0');
  assert.equal(fs.readFileSync(fixture.file).toString(), pluginSource('1.0.0').toString());
  await fixture.updater.apply(offer.token, 'admin');
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.1.0'));
  fixture.updater = createExtensionUpdater(fixture.options);
  const rollback = (await fixture.updater.check('admin')).extensions[0].offers.find(
    o => o.action === 'rollback',
  );
  await fixture.updater.apply(rollback.token, 'admin');
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
  const afterRollback = (await fixture.updater.check('admin')).extensions[0].offers;
  assert.equal(afterRollback.some(offer => offer.action === 'rollback'), false);
  assert.equal(afterRollback.find(offer => offer.action === 'install').version, '1.1.0');
});

test('mutable, prerelease and incompatible releases are not offered', async t => {
  for (const change of [
    fixture => (fixture.release.immutable = false),
    fixture => (fixture.release.prerelease = true),
    fixture => (fixture.candidate.requires.haven = '>=5'),
  ]) {
    const fixture = createUpdateFixture(t);
    change(fixture);
    assert.equal(await fixture.offer(), undefined);
  }
});

test('fresh blocklist failure prevents check and apply without changing installed bytes', async t => {
  const fixture = createUpdateFixture(t);
  const offer = await fixture.offer();
  fixture.offline = true;
  await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /blocklist/);
  await assert.rejects(fixture.updater.check('admin'), /blocklist/);
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
});

test('checksum mismatch, demotion and release mutation fail before replacement', async t => {
  for (const change of [
    fixture => {
      fixture.bytes = pluginSource('1.1.0', 'tampered');
    },
    fixture => {
      fixture.release.immutable = false;
    },
    fixture => {
      fixture.denied = true;
    },
  ]) {
    const fixture = createUpdateFixture(t);
    const offer = await fixture.offer();
    change(fixture);
    await assert.rejects(fixture.updater.apply(offer.token, 'admin', () => !fixture.denied));
    assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
  }
});

test('a correct checksum cannot authorize a mismatched header', async t => {
  const fixture = createUpdateFixture(t);
  fixture.bytes = pluginSource('9.0.0');
  fixture.candidate.sha256 = sha256(fixture.bytes);
  const offer = await fixture.offer();
  await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /metadata/);
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
});

test('newly blocked candidates are rejected; installed versions produce warnings', async t => {
  const fixture = createUpdateFixture(t);
  const offer = await fixture.offer();
  fixture.list.blocked.push({ repo, id, versions: ['1.1.0', '1.0.0'], reason: 'Withdrawn' });
  await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /blocked/);
  const row = (await fixture.updater.check('admin')).extensions[0];
  assert.equal(row.warning, 'Withdrawn');
  assert.equal(row.offers.length, 0);
});

test('rollback is blocked if previous version is flagged or blocklist is unavailable', async t => {
  const fixture = createUpdateFixture(t);
  await fixture.updater.apply((await fixture.offer()).token, 'admin');
  const rollback = (await fixture.updater.check('admin')).extensions[0].offers[0];
  fixture.offline = true;
  await assert.rejects(fixture.updater.apply(rollback.token, 'admin'), /blocklist/);
  fixture.offline = false;
  fixture.list.blocked.push({ repo, id, versions: ['1.0.0'], reason: 'Withdrawn' });
  await assert.rejects(fixture.updater.apply(rollback.token, 'admin'), /blocked/);
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.1.0'));
});

test('offers are user-bound, expire, and detect local edits including during download', async t => {
  const fixture = createUpdateFixture(t);
  const offer = await fixture.offer();
  await assert.rejects(fixture.updater.apply(offer.token, 'other'), /expired/);
  fixture.time += 11 * 60000;
  await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /expired/);
  const next = await fixture.offer();
  fixture.beforeFetch = async url => {
    if (url.endsWith('/assets/3')) fs.writeFileSync(fixture.file, 'local edit');
  };
  await assert.rejects(fixture.updater.apply(next.token, 'admin'), /changed/);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), 'local edit');
});

test('concurrent operations do not race file replacement', async t => {
  const fixture = createUpdateFixture(t);
  const offer = await fixture.offer();
  let release;
  fixture.beforeFetch = url =>
    url.includes('blocklist')
      ? new Promise(resolve => {
          release = resolve;
        })
      : undefined;
  const pending = fixture.updater.apply(offer.token, 'admin');
  await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /already running/);
  release();
  await pending;
});

test('recovery completes metadata after interrupted file replacement', async t => {
  const fixture = createUpdateFixture(t);
  const item = { type: 'plugin', file: 'Example.plugin.js' };
  const stateFile = path.join(fixture.options.stateDir, 'state.json');
  const oldState = {},
    newState = { example: 'committed' };
  fs.writeFileSync(
    path.join(fixture.options.stateDir, 'transaction.json'),
    JSON.stringify({
      item,
      before: sha256(pluginSource('1.0.0')),
      after: sha256(pluginSource('1.1.0')),
      oldState,
      newState,
    }),
  );
  fs.writeFileSync(fixture.file, pluginSource('1.1.0'));
  createExtensionUpdater(fixture.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)), newState);
});

test('manifest validation rejects traversal, duplicate IDs, bad hashes and unsupported schemas', () => {
  const entry = {
    id,
    type: 'plugin',
    version: '1.0.0',
    requires: { haven: '^4.5.0' },
    asset: 'Example.plugin.js',
    sha256: '0'.repeat(64),
  };
  for (const change of [
    m => (m.schemaVersion = 2),
    m => m.extensions.push(entry),
    m => (m.extensions[0].asset = '../bad.plugin.js'),
    m => (m.extensions[0].sha256 = 'bad'),
  ]) {
    const value = { schemaVersion: 1, extensions: [{ ...entry }] };
    change(value);
    assert.throws(() => validateReleaseManifest(value));
  }
  assert.throws(() => validateBlocklist({ schemaVersion: 1, blocked: [] }));
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1'])
    assert.equal(isPublicAddress(ip), false);
});

test('GitHub outage does not hide a safe local rollback', async t => {
  const fixture = createUpdateFixture(t);
  await fixture.updater.apply((await fixture.offer()).token, 'admin');
  fixture.beforeFetch = async url => {
    if (url.includes('api.github.com')) throw Error('GitHub unavailable');
  };
  const row = (await fixture.updater.check('admin')).extensions[0];
  assert.match(row.error, /unavailable/);
  await fixture.updater.apply(row.offers.find(o => o.action === 'rollback').token, 'admin');
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
});

// Inject failures at the rename boundary, not by fabricating a successful API
// response. Restore the filesystem method before restarting the updater.
test('failed replacement recovers old state and preserves original file', async t => {
  const fixture = createUpdateFixture(t);
  const offer = await fixture.offer();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === fixture.file) throw Error('simulated disk failure');
    return rename(from, to);
  };
  try {
    await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /disk failure/);
  } finally {
    fs.renameSync = rename;
  }
  fixture.updater = createExtensionUpdater(fixture.options);
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
  assert.ok(await fixture.offer());
});

test('crash after replacement recovers committed metadata on restart', async t => {
  const fixture = createUpdateFixture(t);
  const offer = await fixture.offer();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(fixture.options.stateDir, 'state.json')) throw Error('simulated crash');
    return rename(from, to);
  };
  try {
    await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /crash/);
  } finally {
    fs.renameSync = rename;
  }
  fixture.updater = createExtensionUpdater(fixture.options);
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.1.0'));
  assert.ok((await fixture.updater.check('admin')).extensions[0].offers.find(o => o.action === 'rollback'));
});

test('symlinked extensions are rejected without touching their targets', async t => {
  const fixture = createUpdateFixture(t);
  const external = path.join(fixture.options.stateDir, 'external');
  fs.renameSync(fixture.file, external);
  fs.symlinkSync(external, fixture.file);
  await assert.rejects(fixture.updater.check('admin'), /regular file/);
  assert.deepEqual(fs.readFileSync(external), pluginSource('1.0.0'));
});

test('semantic version selection and manifest conflicts are handled explicitly', async t => {
  const fixture = createUpdateFixture(t);
  fixture.candidate.version = '1.10.0';
  fixture.bytes = pluginSource('1.10.0');
  fixture.candidate.sha256 = sha256(fixture.bytes);
  fs.writeFileSync(fixture.file, pluginSource('1.9.0'));
  assert.equal((await fixture.offer()).version, '1.10.0');
  fixture.release.assets.push({ id: 4, name: 'Example.plugin.js', state: 'uploaded' });
  const row = (await fixture.updater.check('admin')).extensions[0];
  assert.match(row.error, /ambiguous/);
  assert.equal(row.offers.length, 0);
});

test('pagination limit is an error rather than a false up-to-date result', async t => {
  const fixture = createUpdateFixture(t);
  const fetchBytes = fixture.options.fetchBytes;
  fixture.updater = createExtensionUpdater({
    ...fixture.options,
    fetchBytes: url =>
      url.includes('releases?')
        ? Buffer.from(JSON.stringify(Array(100).fill(fixture.release)))
        : fetchBytes(url),
  });
  const row = (await fixture.updater.check('admin')).extensions[0];
  assert.match(row.error, /Too many releases/);
  assert.equal(row.offers.length, 0);
});

test('theme API incompatibility is rejected even with a matching Haven range', async t => {
  const fixture = createUpdateFixture(t);
  fs.unlinkSync(fixture.file);
  fixture.file = path.join(fixture.dirs.theme, 'Example.theme.css');
  fs.writeFileSync(fixture.file, pluginSource('1.0.0'));
  fixture.candidate.type = 'theme';
  fixture.candidate.asset = 'Example.theme.css';
  fixture.release.assets[1].name = fixture.candidate.asset;
  fixture.bytes = Buffer.from(
    pluginSource('1.1.0').toString().replace(' * @id', ' * @haven-theme-api 999\n * @id'),
  );
  fixture.candidate.sha256 = sha256(fixture.bytes);
  const offer = await fixture.offer();
  await assert.rejects(fixture.updater.apply(offer.token, 'admin'), /Theme API/);
  assert.deepEqual(fs.readFileSync(fixture.file), pluginSource('1.0.0'));
});
