'use strict';

// Update channels (src/releaseChannel.js): version order with pre-releases,
// and which release each channel picks from GitHub's list.

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, latestRelease } = require('../src/releaseChannel');

test('versions order the way semantic versioning says', () => {
  assert.equal(compareVersions('4.26.2', '4.27.0-beta.1'), -1);
  assert.equal(compareVersions('4.27.0-beta.1', '4.27.0-beta.2'), -1);
  assert.equal(compareVersions('4.27.0-beta.2', '4.27.0'), -1, 'a pre-release comes before its release');
  assert.equal(compareVersions('4.27.0-beta.10', '4.27.0-beta.9'), 1, 'numbers compare as numbers');
  assert.equal(compareVersions('v4.27.0', '4.27.0'), 0);
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1);
});

test('stable takes GitHub\'s latest; early access takes the newest of all', async (t) => {
  const list = [
    { tag_name: 'v4.27.0-beta.2', prerelease: true },
    { tag_name: 'v4.27.0-beta.10', prerelease: true },
    { tag_name: 'v4.26.2', prerelease: false },
    { tag_name: 'v4.28.0-beta.1', prerelease: true, draft: true },
  ];
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (url) => ({
    ok: true,
    json: async () => (url.endsWith('/latest') ? list[2] : list),
  });
  assert.equal((await latestRelease()).tag_name, 'v4.26.2');
  assert.equal((await latestRelease({ early: true })).tag_name, 'v4.27.0-beta.10', 'drafts are skipped');
});
