'use strict';

// Fetches a member can point at a URL (link previews, the media proxy) must
// never reach the server's own network: not directly, not through a
// redirect, and not through an odd spelling of a loopback address.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const zlib = require('node:zlib');

const { safeGet, UnsafeUrlError } = require('../src/safeFetch');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('loopback in any spelling is refused before a connection is made', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.0.0.2/',
    'http://0x7f000002/',
    'http://127.1/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.100/',
    'http://localhost/',
    'http://foo.localhost/',
  ]) {
    await assert.rejects(safeGet(url, { timeoutMs: 2000 }), UnsafeUrlError, url);
  }
});

test('only http and https are fetched', async () => {
  await assert.rejects(safeGet('file:///etc/passwd'), /HTTP or HTTPS|Private addresses/);
  await assert.rejects(safeGet('ftp://example.com/x'), /HTTP or HTTPS|Private addresses/);
});

test('a redirect to a private address is refused at the hop', async () => {
  let secretHits = 0;
  const server = await serve((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: 'http://internal.test/secret' }); return res.end(); }
    if (req.url === '/secret') secretHits++;
    res.end('secret');
  });
  const port = server.address().port;
  // "public.test" stands in for a public host (it is really this test server);
  // "internal.test" resolves to a private address and must never be connected to.
  const resolve = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'public.test') return { url: u, address: '127.0.0.1', family: 4 };
    const err = new Error('blocked'); err.code = 'ERR_UNSAFE_CALLBACK_URL'; throw err;
  };
  try {
    await assert.rejects(safeGet(`http://public.test:${port}/start`, { resolve }), UnsafeUrlError);
    assert.equal(secretHits, 0);
  } finally { server.close(); }
});

test('the connection goes to the address that was checked, not a fresh lookup', async () => {
  const server = await serve((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`host=${req.headers.host}`); });
  const port = server.address().port;
  const resolve = async (url) => ({ url: new URL(url), address: '127.0.0.1', family: 4 });
  try {
    // "pinned.invalid" does not exist in DNS; the request only works because
    // the checked address is used for the connection.
    const r = await safeGet(`http://pinned.invalid:${port}/`, { resolve });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), `host=pinned.invalid:${port}`);
  } finally { server.close(); }
});

test('bodies stop at the byte ceiling, compressed or not', async () => {
  const big = Buffer.alloc(300 * 1024, 'a');
  const server = await serve((req, res) => {
    if (req.url === '/gz') { res.setHeader('content-encoding', 'gzip'); return res.end(zlib.gzipSync(big)); }
    res.end(big);
  });
  const port = server.address().port;
  const resolve = async (url) => ({ url: new URL(url), address: '127.0.0.1', family: 4 });
  try {
    const cut = await safeGet(`http://a.test:${port}/`, { resolve, maxBytes: 1000, truncate: true });
    assert.equal(cut.body.length, 1000);
    const cutGz = await safeGet(`http://a.test:${port}/gz`, { resolve, maxBytes: 1000, truncate: true });
    assert.equal(cutGz.body.length, 1000);
    await assert.rejects(safeGet(`http://a.test:${port}/`, { resolve, maxBytes: 1000 }), /too large/);
    await assert.rejects(safeGet(`http://a.test:${port}/gz`, { resolve, maxBytes: 1000 }), /too large/);
  } finally { server.close(); }
});

test('redirect chains are capped', async () => {
  const server = await serve((req, res) => { res.writeHead(302, { Location: '/again' }); res.end(); });
  const port = server.address().port;
  const resolve = async (url) => ({ url: new URL(url), address: '127.0.0.1', family: 4 });
  try {
    await assert.rejects(safeGet(`http://a.test:${port}/`, { resolve, maxRedirects: 3 }), /Too many redirects/);
  } finally { server.close(); }
});
