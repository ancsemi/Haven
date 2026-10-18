'use strict';

// Which storage HAVEN_EXTERNAL_STORAGE and the HAVEN_S3_* settings pick.
//
//   node --test test/storageEnv.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-storage-env-'));
const { fromEnv } = require('../src/storage');

const S3 = { HAVEN_EXTERNAL_STORAGE: 'true', HAVEN_S3_ENDPOINT: 'http://garage:3900', HAVEN_S3_BUCKET: 'media',
  HAVEN_S3_ACCESS_KEY: 'key', HAVEN_S3_SECRET_KEY: 'secret' };

test('off, unset or anything but true keeps media on local disk', () => {
  for (const v of [undefined, '', 'false', '1', 'yes']) assert.equal(fromEnv({ HAVEN_EXTERNAL_STORAGE: v }).kind, 'local', String(v));
});

test('on, every required setting has to be there, and the message names what is missing', () => {
  assert.throws(() => fromEnv({ HAVEN_EXTERNAL_STORAGE: 'true', HAVEN_S3_ENDPOINT: 'http://x' }),
    /HAVEN_S3_BUCKET, HAVEN_S3_ACCESS_KEY, HAVEN_S3_SECRET_KEY are not set/);
  assert.throws(() => fromEnv({ ...S3, HAVEN_S3_SECRET_KEY: '  ' }), /HAVEN_S3_SECRET_KEY is not set/);
});

test('on, the bucket settings are read with their defaults', () => {
  const s = fromEnv({ ...S3, HAVEN_EXTERNAL_STORAGE: ' TRUE ' });
  assert.equal(s.kind, 's3');
  assert.equal(s.describe(), 'S3 bucket "media" at http://garage:3900');
  assert.equal(s.prefix, '');
  assert.equal(s.local, null, 'no local fallback unless asked for');
  assert.equal(fromEnv({ ...S3, HAVEN_S3_PREFIX: '/haven' }).prefix, 'haven/');
  assert.ok(fromEnv({ ...S3, HAVEN_S3_LOCAL_FALLBACK: 'true' }).local, 'fallback on');
});

test('path style is on unless turned off', async () => {
  assert.equal(await fromEnv(S3).client.config.forcePathStyle, true);
  assert.equal(await fromEnv({ ...S3, HAVEN_S3_FORCE_PATH_STYLE: 'false' }).client.config.forcePathStyle, false);
  assert.equal(await fromEnv(S3).client.config.region(), 'us-east-1');
  assert.equal(await fromEnv({ ...S3, HAVEN_S3_REGION: 'garage' }).client.config.region(), 'garage');
});
