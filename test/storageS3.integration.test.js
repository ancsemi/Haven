'use strict';

// The S3 driver against a real bucket. Skipped unless one is given:
//
//   HAVEN_TEST_S3_ENDPOINT=http://127.0.0.1:3900 HAVEN_TEST_S3_BUCKET=haven-test \
//   HAVEN_TEST_S3_ACCESS_KEY=... HAVEN_TEST_S3_SECRET_KEY=... HAVEN_TEST_S3_REGION=garage \
//   node --test test/storageS3.integration.test.js
//
// Everything goes under a prefix of its own and is removed afterwards.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const E = process.env;
const skip = !E.HAVEN_TEST_S3_ENDPOINT && 'set HAVEN_TEST_S3_ENDPOINT (and _BUCKET, _ACCESS_KEY, _SECRET_KEY) to run';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-s3-'));
process.env.HAVEN_DATA_DIR = DATA;

const { UPLOADS_DIR, UNPROCESSED_DIR } = require('../src/paths');
const { S3Storage } = require('../src/storage/s3');
const { LocalStorage } = require('../src/storage/local');

const PREFIX = `haven-test-${Date.now()}-${process.pid}/`;
const conf = (over = {}) => ({
  endpoint: E.HAVEN_TEST_S3_ENDPOINT, bucket: E.HAVEN_TEST_S3_BUCKET, region: E.HAVEN_TEST_S3_REGION || 'us-east-1',
  accessKeyId: E.HAVEN_TEST_S3_ACCESS_KEY, secretAccessKey: E.HAVEN_TEST_S3_SECRET_KEY, prefix: PREFIX, ...over,
});
const s3 = skip ? null : new S3Storage(conf());
const staged = (name, body) => { const p = path.join(UNPROCESSED_DIR, name); fs.writeFileSync(p, body); return p; };
const drain = async (stream) => { const c = []; for await (const x of stream) c.push(x); return Buffer.concat(c); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  if (s3) {
    const all = [];
    for await (const o of new S3Storage(conf({ prefix: '' })).list(PREFIX)) all.push(o.rel);
    const root = new S3Storage(conf({ prefix: '' }));
    for (let i = 0; i < all.length; i += 50) await Promise.all(all.slice(i, i + 50).map((k) => root.remove(k)));
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('ping answers, and wrong credentials say why', { skip }, async () => {
  await s3.ping();
  const bad = new S3Storage(conf({ secretAccessKey: 'wrong' }));
  await assert.rejects(bad.ping(), (err) => /HTTP 40[13]/.test(err.message));
  const nowhere = new S3Storage(conf({ endpoint: 'http://127.0.0.1:1' }));
  await assert.rejects(nowhere.ping(), (err) => err.message.length > 0);
});

test('put, head, read, ranges and odd names', { skip }, async () => {
  const body = Buffer.from('0123456789abcdef');
  assert.deepEqual(await s3.put('a b/naïve file.png', staged('p1', body), { contentType: 'image/png' }), { size: 16 });
  assert.equal(fs.existsSync(path.join(UNPROCESSED_DIR, 'p1')), false, 'the local copy is gone once stored');
  const head = await s3.head('a b/naïve file.png');
  assert.equal(head.size, 16);
  assert.ok(head.etag && head.lastModified instanceof Date);
  assert.deepEqual(await s3.readBuffer('a b/naïve file.png'), body);
  const part = await s3.getStream('a b/naïve file.png', { range: { start: 4, end: 7 } });
  assert.equal(part.size, 16, 'the whole size, not the range length');
  assert.equal((await drain(part.stream)).toString(), '4567');
  assert.equal(await s3.head('missing.png'), null);
  assert.equal(await s3.getStream('missing.png'), null);
  assert.equal(await s3.readBuffer('missing.png'), null);
});

test('a file over 5 MB goes up in parts', { skip }, async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 9);
  await s3.put('big.mp4', staged('p2', big));
  assert.equal((await s3.head('big.mp4')).size, big.length);
  assert.deepEqual(await s3.readBuffer('big.mp4'), big);
});

test('soft delete, restore and remove', { skip }, async () => {
  await s3.put('gone.png', staged('p3', 'x'));
  const before = (await s3.head('gone.png')).lastModified;
  await wait(1100);   // LastModified has one second steps
  assert.equal(await s3.softDelete('gone.png'), true);
  assert.equal(await s3.head('gone.png'), null);
  const moved = await s3.head('deleted-attachments/gone.png');
  assert.ok(moved.lastModified > before, 'the deleted copy is stamped with the deletion time');
  assert.equal(await s3.softDelete('gone.png'), false, 'nothing left to delete');
  assert.equal(await s3.restore('gone.png'), true);
  assert.ok(await s3.head('gone.png'));
  await s3.remove('gone.png');
  assert.equal(await s3.head('gone.png'), null);
  await s3.remove('gone.png');
});

test('list pages past a thousand keys', { skip }, async () => {
  const n = 1005;
  const names = Array.from({ length: n }, (_, i) => `many/${String(i).padStart(4, '0')}.txt`);
  for (let i = 0; i < n; i += 40) {
    await Promise.all(names.slice(i, i + 40).map((k, j) => s3.put(k, staged(`m${i + j}`, 'm'))));
  }
  const seen = [];
  for await (const o of s3.list('many/')) seen.push(o.rel);
  assert.equal(seen.length, n);
  assert.deepEqual(seen.sort(), names);
});

test('local fallback serves files not moved yet, and a delete removes the local copy too', { skip }, async () => {
  const local = new LocalStorage(UPLOADS_DIR);
  const withFallback = new S3Storage(conf({ local }));
  fs.writeFileSync(path.join(UPLOADS_DIR, 'old-local.png'), 'old');
  assert.equal((await withFallback.readBuffer('old-local.png')).toString(), 'old');
  assert.equal(await s3.readBuffer('old-local.png'), null, 'without the fallback it is not found');

  await withFallback.put('both.png', staged('p4', 'new'));
  fs.writeFileSync(path.join(UPLOADS_DIR, 'both.png'), 'old copy');
  assert.equal((await withFallback.readBuffer('both.png')).toString(), 'new', 'the bucket wins');
  assert.equal(await withFallback.softDelete('both.png'), true);
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, 'both.png')), false, 'the local copy cannot bring it back');
  assert.equal(await withFallback.head('both.png'), null);
});

test('served through Haven with the same headers and ranges', { skip }, async () => {
  const express = require('express');
  const { blockInternalUploads, serveUploads } = require('../src/storage/serve');
  await s3.put('clip.mp4', staged('p5', Buffer.alloc(1000, 1)));
  await s3.put('evil.js', staged('p6', 'alert(1)'));
  const app = express();
  app.use('/uploads', blockInternalUploads, serveUploads(s3));
  app.use((req, res) => res.status(404).end());
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = (p, headers = {}) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers }, (r) => {
    const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) }));
  }).on('error', rej));
  try {
    const ranged = await get('/uploads/clip.mp4', { range: 'bytes=10-19' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-range'], 'bytes 10-19/1000');
    assert.equal(ranged.body.length, 10);
    assert.equal(ranged.headers['content-type'], 'video/mp4');
    const full = await get('/uploads/clip.mp4');
    assert.equal(full.status, 200);
    assert.equal(full.body.length, 1000);
    assert.equal((await get('/uploads/clip.mp4', { 'if-none-match': full.headers.etag })).status, 304);
    const js = await get('/uploads/evil.js');
    assert.equal(js.headers['content-type'], 'application/octet-stream');
    assert.equal(js.headers['content-disposition'], 'attachment');
    assert.equal((await get('/uploads/deleted-attachments/clip.mp4')).status, 404);
  } finally { srv.close(); }
});

test('the privacy sweep cleans photos already in the bucket', { skip }, async () => {
  const storage = require('../src/storage');
  const { initDatabase } = require('../src/database');
  const pp = require('../src/privacyPass');
  const exif = Buffer.concat([Buffer.from('Exif\0\0MM\0*', 'latin1'), Buffer.from([0, 0, 0, 8, 0, 0])]);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, exif.length + 2]), exif]);
  const scan = Buffer.from([0xFF, 0xDA, 0, 4, 1, 2, 9, 9, 0xFF, 0xD9]);
  const photo = Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, scan]);
  storage.setStorage(s3);
  const db = initDatabase();
  try {
    await s3.put('old-photo.jpg', staged('p7', photo));
    await s3.put('notes.txt', staged('p8', 'Exif in plain text, not a photo'));
    db.prepare("INSERT INTO media_objects (rel_path, bytes, state) VALUES ('old-photo.jpg', ?, 'live'), ('notes.txt', 31, 'live')").run(photo.length);
    pp.start(db);
    const done = () => JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key = 'privacy_sweep_s3'").get()?.value || '{}').done;
    for (let i = 0; i < 100 && !done(); i++) await wait(100);
    assert.ok(done(), 'the bucket sweep finished');
    const after = await s3.readBuffer('old-photo.jpg');
    assert.ok(!after.includes(Buffer.from('Exif')), 'the EXIF block is gone from the stored photo');
    assert.ok(after.subarray(-10).equals(scan), 'the picture itself is untouched');
    assert.equal(db.prepare("SELECT bytes FROM media_objects WHERE rel_path = 'old-photo.jpg'").get().bytes, after.length);
    assert.equal((await s3.readBuffer('notes.txt')).toString(), 'Exif in plain text, not a photo');
    assert.equal(db.prepare("SELECT value FROM server_settings WHERE key = 'privacy_sweep'").get(), undefined, 'the disk sweep state is its own');
  } finally {
    require('../src/mediaTools').stopExiftool();
    db.close();
  }
});

function startServer(port, data, env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HAVEN_DATA_DIR: data, FORCE_HTTP: 'true', ADMIN_USERNAME: 'admin', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, output: () => out };
}
const s3Env = (over = {}) => ({
  HAVEN_EXTERNAL_STORAGE: 'true', HAVEN_S3_ENDPOINT: E.HAVEN_TEST_S3_ENDPOINT, HAVEN_S3_BUCKET: E.HAVEN_TEST_S3_BUCKET,
  HAVEN_S3_REGION: E.HAVEN_TEST_S3_REGION || 'us-east-1', HAVEN_S3_ACCESS_KEY: E.HAVEN_TEST_S3_ACCESS_KEY,
  HAVEN_S3_SECRET_KEY: E.HAVEN_TEST_S3_SECRET_KEY, HAVEN_S3_PREFIX: PREFIX + 'server', ...over,
});

test('the server refuses to start when the bucket cannot be used', { skip }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-s3-bad-'));
  const { child, output } = startServer(3611, data, s3Env({ HAVEN_S3_SECRET_KEY: 'wrong' }));
  const code = await new Promise((r) => { child.on('exit', r); setTimeout(() => { child.kill(); r('timeout'); }, 30000); });
  assert.equal(code, 1, output());
  assert.match(output(), /Haven could not start: \[storage\] Cannot use S3 bucket "[^"]+" at /);
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a local install moves to the bucket while it stays up, and nothing goes missing', { skip }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-s3-migrate-'));
  const port = 3613, base = `http://localhost:${port}`;
  const env = s3Env({ HAVEN_S3_PREFIX: PREFIX + 'migrate' });
  const run = async (extra, fn) => {
    const { child, output } = startServer(port, data, extra);
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { await wait(500); } }
      assert.ok(up, output());
      await fn();
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
  };
  const status = async (url) => (await fetch(base + url)).status;
  const migrate = (...flags) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['scripts/migrate-uploads-to-s3.js', ...flags], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, HAVEN_DATA_DIR: data, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out }));
  });
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex');
  let urls = [];
  try {
    // 1. A plain local install with uploads, one of them deleted.
    await run({}, async () => {
      const reg = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 's3testpass123', eulaVersion: '2.0', ageVerified: true }) })).json();
      for (let n = 0; n < 2; n++) {
        const fd = new FormData();
        fd.append('image', new Blob([png], { type: 'image/png' }), 'p.png');
        urls.push((await (await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${reg.token}` }, body: fd })).json()).url);
      }
      for (const u of urls) assert.equal(await status(u), 200);
    });
    fs.mkdirSync(path.join(data, 'uploads', 'deleted-attachments'), { recursive: true });
    fs.writeFileSync(path.join(data, 'uploads', 'deleted-attachments', 'gone.png'), png);

    // 2. On the bucket with the fallback: still served, from disk.
    await run({ ...env, HAVEN_S3_LOCAL_FALLBACK: 'true' }, async () => {
      for (const u of urls) assert.equal(await status(u), 200, `${u} served through the fallback`);
      const m = await migrate();
      assert.equal(m.code, 0, m.out);
      assert.match(m.out, /everything from the folder is there/);
      for (const u of urls) assert.equal(await status(u), 200, `${u} still served during the move`);
    });

    // 3. Fallback off: served from the bucket alone.
    await run(env, async () => {
      for (const u of urls) assert.equal(await status(u), 200, `${u} served from the bucket`);
    });
    const bucket = new S3Storage(conf({ prefix: PREFIX + 'migrate/' }));
    assert.ok(await bucket.headObject('deleted-attachments/gone.png'), 'deleted files moved too');

    // 4. --delete-local empties uploads/ except bot audio. (A starting server
    // clears bot audio, so it is put there only now.)
    fs.mkdirSync(path.join(data, 'uploads', 'bot-audio'), { recursive: true });
    fs.writeFileSync(path.join(data, 'uploads', 'bot-audio', 'clip.mp3'), 'audio');
    const d = await migrate('--delete-local');
    assert.equal(d.code, 0, d.out);
    assert.equal(await bucket.headObject('bot-audio/clip.mp3'), null, 'bot audio never goes to the bucket');
    const left = [];
    for await (const f of new LocalStorage(path.join(data, 'uploads')).list('')) left.push(f.rel);
    assert.deepEqual(left, ['bot-audio/clip.mp3']);
    await run(env, async () => {
      for (const u of urls) assert.equal(await status(u), 200, `${u} served after the local copies went`);
    });
  } finally {
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a backup carries the bucket\'s files, and restoring it puts them back in the bucket', { skip }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-s3-restore-'));
  const port = 3614, base = `http://localhost:${port}`;
  const env = s3Env({ HAVEN_S3_PREFIX: PREFIX + 'restore' });
  const bucket = new S3Storage(conf({ prefix: PREFIX + 'restore/' }));
  const PW = 's3testpass123';
  const boot = async () => {
    const s = startServer(port, data, env);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { await wait(500); } }
    assert.ok(up, s.output());
    return s;
  };
  const stop = async ({ child }) => { child.kill(); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); };
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex');
  try {
    let s = await boot();
    const reg = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PW, eulaVersion: '2.0', ageVerified: true }) })).json();
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'p.png');
    const { url } = await (await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${reg.token}` }, body: fd })).json();
    const rel = url.replace('/uploads/', '');

    const { ticket } = await (await fetch(`${base}/api/admin/download-ticket`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ purpose: 'backup', include: 'channels,users,settings,messages,files', password: PW }) })).json();
    const zip = Buffer.from(await (await fetch(`${base}/api/admin/backup?ticket=${ticket}`)).arrayBuffer());
    const entries = new (require('adm-zip'))(zip).getEntries().map((e) => e.entryName);
    assert.ok(entries.includes(`uploads/${rel}`), `the bucket's file is in the backup (${entries.join(', ')})`);
    assert.ok(entries.includes('uploads/stickers/starter-heart.svg'));

    await bucket.remove(rel);   // lost from the bucket
    const restore = new FormData();
    restore.append('backup', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
    const r = await fetch(`${base}/api/admin/restore`, { method: 'POST',
      headers: { Authorization: `Bearer ${reg.token}`, 'x-haven-password': encodeURIComponent(PW) }, body: restore });
    assert.equal(r.status, 200, await r.text());
    await new Promise((res) => (s.child.exitCode !== null ? res() : s.child.once('exit', res)));   // it exits to apply the restore

    s = await boot();
    try {
      assert.deepEqual(await bucket.readBuffer(rel), png, 'the restored file is back in the bucket');
      assert.equal((await fetch(base + url)).status, 200);
      assert.equal(fs.existsSync(path.join(data, 'uploads', rel)), false, 'and not left on disk');
    } finally { await stop(s); }
  } finally {
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a server on the bucket stores and serves an upload', { skip }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-s3-good-'));
  const port = 3612, base = `http://localhost:${port}`;
  const { child, output } = startServer(port, data, s3Env());
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { await wait(500); } }
    assert.ok(up, output());
    const reg = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 's3testpass123', eulaVersion: '2.0', ageVerified: true }) })).json();
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
      + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'p.png');
    const { url } = await (await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${reg.token}` }, body: fd })).json();
    assert.ok(url, output());
    const rel = url.replace('/uploads/', '');
    assert.equal(fs.existsSync(path.join(data, 'uploads', rel)), false, 'not on local disk');
    const inBucket = new S3Storage(conf({ prefix: PREFIX + 'server/' }));
    assert.deepEqual(await inBucket.readBuffer(rel), png, 'in the bucket');
    const served = await fetch(base + url);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    assert.equal(served.headers.get('access-control-allow-origin'), '*');
    assert.ok((await inBucket.head('stickers/starter-heart.svg')), 'starter stickers were seeded into the bucket');
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
