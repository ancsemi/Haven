'use strict';

// /uploads is served by Haven itself (src/storage/serve.js) so the same
// safety headers hold whether a file is on disk or in an S3 bucket. This
// checks it answers exactly as express.static did before, request for
// request, and pins the headers that keep uploads from running as script.
//
//   node --test test/uploadsServe.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-uploads-serve-'));
process.env.HAVEN_DATA_DIR = DATA;

const express = require('express');
const { UPLOADS_DIR } = require('../src/paths');
const { LocalStorage } = require('../src/storage/local');
const { blockInternalUploads, serveUploads, setSafetyHeaders } = require('../src/storage/serve');

const files = {
  'pic.png': Buffer.from('89504e470d0a1a0a', 'hex'),
  'pic.JPG': Buffer.from('ffd8ffe0', 'hex'),
  'draw.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'evil.js': 'alert(1)',
  'page.html': '<script>alert(1)</script>',
  'clip.mp4': Buffer.alloc(1000, 7),
  'song.mp3': Buffer.alloc(300, 3),
  'notes.txt': 'plain words',
  '1-ab.my file': 'odd extension',
  'stickers/s.webp': 'RIFF0000WEBP',
  'deleted-attachments/gone.png': 'deleted',
  'bot-audio/a.mp3': 'bot',
  '.hidden': 'dot',
};
for (const [rel, body] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(UPLOADS_DIR, rel)), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, rel), body);
}

function appWith(handler) {
  const app = express();
  app.use('/uploads', blockInternalUploads);
  app.use('/uploads', handler);
  // The same catch-alls server.js has.
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}
// The serving setup this replaced, kept here as the reference.
const before = express.static(UPLOADS_DIR, {
  dotfiles: 'deny', maxAge: '7d', immutable: true, etag: true, lastModified: true,
  setHeaders: (res, filePath) => setSafetyHeaders(res, path.extname(filePath).toLowerCase()),
});
const after = serveUploads(new LocalStorage(UPLOADS_DIR));

let oldSrv, newSrv;
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
test.before(async () => { oldSrv = await listen(appWith(before)); newSrv = await listen(appWith(after)); });
test.after(() => {
  oldSrv.close(); newSrv.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function request(srv, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const COMPARED = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified', 'cache-control',
  'accept-ranges', 'content-disposition', 'content-security-policy', 'access-control-allow-origin',
  'cross-origin-resource-policy', 'vary'];
const shape = (r) => ({ status: r.status, body: r.body.toString('base64'),
  ...Object.fromEntries(COMPARED.map((h) => [h, r.headers[h]])) });

async function same(rawPath, opts) {
  const [a, b] = [await request(oldSrv, rawPath, opts), await request(newSrv, rawPath, opts)];
  assert.deepEqual(shape(b), shape(a), `${opts?.method || 'GET'} ${rawPath} ${JSON.stringify(opts?.headers || {})}`);
  return b;
}

test('every file type gets the same answer as express.static gave', async () => {
  for (const rel of ['pic.png', 'pic.JPG', 'draw.svg', 'evil.js', 'page.html', 'clip.mp4', 'song.mp3',
    'notes.txt', '1-ab.my%20file', 'stickers/s.webp']) {
    await same(`/uploads/${rel}`);
    await same(`/uploads/${rel}`, { method: 'HEAD' });
  }
});

test('conditional requests and byte ranges match', async () => {
  const first = await request(newSrv, '/uploads/clip.mp4');
  const { etag } = first.headers;
  const lastModified = first.headers['last-modified'];
  const cases = [
    { 'if-none-match': etag },
    { 'if-none-match': '"something-else"' },
    { 'if-modified-since': lastModified },
    { 'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
    { 'if-match': '"nope"' },
    { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
    { range: 'bytes=0-99' },
    { range: 'bytes=900-' },
    { range: 'bytes=-50' },
    { range: 'bytes=0-9,20-29' },
    { range: 'bytes=5000-6000' },
    { range: 'items=0-5' },
    { range: 'bytes=0-9', 'if-range': etag },
    { range: 'bytes=0-9', 'if-range': '"stale"' },
    { range: 'bytes=0-9', 'if-range': lastModified },
  ];
  for (const headers of cases) {
    await same('/uploads/clip.mp4', { headers });
    await same('/uploads/draw.svg', { headers });
  }
});

test('missing, hidden, internal and odd paths fall through the same way', async () => {
  for (const p of ['/uploads/nope.png', '/uploads/.hidden', '/uploads/stickers/', '/uploads/',
    '/uploads/deleted-attachments/gone.png', '/uploads/deleted%2Dattachments/gone.png',
    '/uploads//deleted-attachments/gone.png', '/uploads/deleted-attachments%2Fgone.png',
    '/uploads/DELETED-ATTACHMENTS/gone.png', '/uploads/DELETE~1/gone.png', '/uploads/bot-audio/a.mp3',
    '/uploads/pic.png.', '/uploads/pic.png%20', '/uploads/pic.png::$DATA', '/uploads/%E0%A4%A']) {
    await same(p);
  }
  await same('/uploads/pic.png', { method: 'POST' });
});

test('the safety headers are the ones that keep uploads from running', async () => {
  const js = await request(newSrv, '/uploads/evil.js');
  assert.equal(js.headers['content-type'], 'application/octet-stream');
  assert.equal(js.headers['content-disposition'], 'attachment');
  const svg = await request(newSrv, '/uploads/draw.svg');
  assert.equal(svg.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  assert.equal(svg.headers['content-disposition'], 'attachment');
  const png = await request(newSrv, '/uploads/pic.png');
  assert.equal(png.headers['access-control-allow-origin'], '*');
  assert.equal(png.headers['cache-control'], 'public, max-age=604800, immutable');
  const again = await request(newSrv, '/uploads/pic.png', { headers: { 'if-none-match': png.headers.etag } });
  assert.equal(again.status, 304, 'a cached copy is confirmed, not sent again');
  assert.equal(again.body.length, 0);
  const mp4 = await request(newSrv, '/uploads/clip.mp4', { headers: { range: 'bytes=100-199' } });
  assert.equal(mp4.status, 206);
  assert.equal(mp4.headers['content-range'], 'bytes 100-199/1000');
  assert.equal(mp4.body.length, 100);
  assert.equal(mp4.headers['content-type'], 'video/mp4');
  for (const p of ['/uploads/deleted-attachments/gone.png', '/uploads/deleted%2Dattachments/gone.png',
    '/uploads//deleted-attachments/gone.png', '/uploads/deleted-attachments%2Fgone.png']) {
    assert.equal((await request(newSrv, p)).status, 404, p);
  }
});
