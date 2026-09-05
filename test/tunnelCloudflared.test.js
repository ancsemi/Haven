'use strict';

// The Windows installer says "auto-downloads cloudflared". Until this change
// nothing did: the tunnel module only spawned `cloudflared` from PATH, so a
// fresh Windows install that picked the Cloudflare option always ended in
// "cloudflared binary not found in PATH" (reported by a self-hoster on 2026-09-05).
// These tests lock the lookup order and the download fallback.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-tunnel-'));
process.env.HAVEN_DATA_DIR = tmpData;
const tunnel = require('../src/tunnel');

const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

test('release asset name follows the platform', () => {
  assert.equal(tunnel.cloudflaredAssetName('win32', 'x64'), 'cloudflared-windows-amd64.exe');
  assert.equal(tunnel.cloudflaredAssetName('win32', 'ia32'), 'cloudflared-windows-386.exe');
  assert.equal(tunnel.cloudflaredAssetName('linux', 'x64'), 'cloudflared-linux-amd64');
  assert.equal(tunnel.cloudflaredAssetName('linux', 'arm64'), 'cloudflared-linux-arm64');
  assert.equal(tunnel.cloudflaredAssetName('darwin', 'arm64'), null, 'macOS ships a tgz; not auto-downloaded');
});

test('PATH wins, then the data bin folder, then nothing', () => {
  const binDir = path.join(tmpData, 'bin');
  assert.equal(tunnel.resolveCloudflared({ binDir, pathHas: () => true }), 'cloudflared');
  assert.equal(tunnel.resolveCloudflared({ binDir, pathHas: () => false }), null, 'nothing installed yet');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, exe), '');
  assert.equal(tunnel.resolveCloudflared({ binDir, pathHas: () => false }), path.join(binDir, exe));
  fs.rmSync(binDir, { recursive: true, force: true });
});

test('download lands in the data bin folder and is executable', async () => {
  const binDir = path.join(tmpData, 'bin2');
  const got = await tunnel.downloadCloudflared({
    binDir,
    fetch: async (url, dest) => {
      assert.match(url, /github\.com\/cloudflare\/cloudflared\/releases\/latest\/download\/cloudflared-/);
      fs.writeFileSync(dest, 'fake-binary');
    }
  });
  assert.equal(got, path.join(binDir, exe));
  assert.equal(fs.readFileSync(got, 'utf8'), 'fake-binary');
  assert.ok(!fs.existsSync(got + '.part'), 'temp file renamed away');
  if (process.platform !== 'win32') assert.ok(fs.statSync(got).mode & 0o100, 'chmod +x applied');
});

test('a failed download is explained and leaves no partial file', async () => {
  const binDir = path.join(tmpData, 'bin3');
  await assert.rejects(
    tunnel.downloadCloudflared({ binDir, fetch: async () => { throw new Error('HTTP 503'); } }),
    (err) => /could not download cloudflared \(HTTP 503\)/.test(err.message) && /releases/.test(err.message)
  );
  assert.ok(!fs.existsSync(path.join(binDir, exe + '.part')));
});

test('cloudflared counts as available when it can be downloaded', () => {
  const st = tunnel.getTunnelStatus();
  const expected = !!tunnel.cloudflaredAssetName() || !!tunnel.resolveCloudflared();
  assert.equal(st.available.cloudflared, expected);
});
