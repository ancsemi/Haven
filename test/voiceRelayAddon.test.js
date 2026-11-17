'use strict';

/**
 * Installing the voice relay on a Linux kernel newer than 6 (#5845). mediasoup
 * picks its prebuilt program by kernel version, and the kernel 7 one needs newer
 * system libraries than Haven's Docker image has, so a failed install tries
 * again asking for the kernel 6 one.
 *
 *   node --test test/voiceRelayAddon.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SHIM = path.join(__dirname, '..', 'src', 'voiceRelay', 'kernel6Shim.js');

test('the shim makes both require and import see kernel 6', () => {
  const out = execFileSync(process.execPath, ['--require', SHIM, '--input-type=module', '-e',
    "import * as os from 'node:os'; import { createRequire } from 'node:module'; console.log(os.release(), createRequire(import.meta.url)('os').release());"],
  { encoding: 'utf8' });
  assert.equal(out.trim(), '6.0.0 6.0.0');
});

// A stand-in for npm that fails, and notes the NODE_OPTIONS it was run with.
function installWith({ platform, release }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-relay-addon-'));
  const npm = path.join(dir, 'npm-cli.js');
  const log = path.join(dir, 'runs.log');
  fs.writeFileSync(npm, `require('fs').appendFileSync(${JSON.stringify(log)}, (process.env.NODE_OPTIONS || 'none') + '\\n'); console.error('npm error command failed'); process.exit(1);`);

  const code = `
    const os = require('os');
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    os.release = () => ${JSON.stringify(release)};
    const addon = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'voiceRelay', 'addon.js'))});
    if (addon.loadMediasoup()) { console.log('SKIP'); process.exit(0); }
    addon.install().then((r) => console.log(JSON.stringify(r)));
  `;
  const out = execFileSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, HAVEN_DATA_DIR: dir, npm_execpath: npm, NODE_OPTIONS: '' },
  }).trim();
  const runs = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, runs };
}

test('a failed install on kernel 7 tries again asking for the kernel 6 build', (t) => {
  const { out, runs } = installWith({ platform: 'linux', release: '7.0.1-200.fc44.x86_64' });
  if (out === 'SKIP') return t.skip('mediasoup is installed in this checkout');
  assert.equal(runs.length, 2);
  assert.equal(runs[0], 'none');
  assert.match(runs[1], /kernel6Shim\.js/);
  assert.match(JSON.parse(out).error, /command failed/, 'the admin still hears why when both fail');
});

test('kernel 6 and other systems get one try, as before', (t) => {
  for (const system of [{ platform: 'linux', release: '6.12.0' }, { platform: 'win32', release: '10.0.26200' }]) {
    const { out, runs } = installWith(system);
    if (out === 'SKIP') return t.skip('mediasoup is installed in this checkout');
    assert.equal(runs.length, 1, system.platform);
    assert.match(JSON.parse(out).error, /command failed/);
  }
});
