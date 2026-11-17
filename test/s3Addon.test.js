'use strict';

// Amazon's S3 library is an add-on: a server that has not turned external
// storage on never downloads or loads it (owner's rule, src/storage/s3Addon.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-s3addon-'));
const ROOT = path.join(__dirname, '..');

test('Haven itself does not depend on the S3 library', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^﻿/, '')); // Haven's has a BOM
  const all = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  assert.deepEqual(Object.keys(all).filter(n => n.startsWith('@aws-sdk/') || n.startsWith('@smithy/')), []);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(k => /node_modules\/@(aws-sdk|smithy)\//.test(k)), []);
});

test('the add-on pins exact versions, with a lockfile', () => {
  const dir = path.join(ROOT, 'addons', 's3');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const [name, v] of Object.entries(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is pinned`);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const [k, v] of Object.entries(lock.packages)) if (k) assert.ok(v.integrity, `${k} has an integrity hash`);
});

test('a server without external storage never loads the add-on', () => {
  const { fromEnv } = require('../src/storage');
  const store = fromEnv({});
  assert.equal(store.kind, 'local');
  const loaded = Object.keys(require.cache);
  assert.ok(!loaded.some(f => /[\\/]storage[\\/](s3|s3Addon)\.js$/.test(f)), 'the S3 driver is not loaded');
  assert.ok(!loaded.some(f => /[\\/]@aws-sdk[\\/]/.test(f)), 'nothing from Amazon is loaded');
  assert.ok(!fs.existsSync(path.join(process.env.HAVEN_DATA_DIR, 'addons')), 'nothing is installed');
});

test.after(() => fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true }));
