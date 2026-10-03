'use strict';

// Outgoing requests follow http_proxy / https_proxy / no_proxy on their own,
// without NODE_USE_ENV_PROXY, and nothing changes when none of them is set.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const outboundProxy = require('../src/outboundProxy');
const { resolveCallbackDestination } = require('../src/webhookCallback');
const { safeGet } = require('../src/safeFetch');

const PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of PROXY_VARS) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of PROXY_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  const closed = new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  for (const socket of server.tunnels || []) socket.destroy();
  return closed;
}

// A forwarding proxy like tinyproxy: absolute-form requests for http:// and
// CONNECT tunnels for https://. It records what it was asked for, and serves
// names ending in .test from 127.0.0.1 (names Haven itself cannot resolve,
// like public sites inside a locked-down container).
async function startProxy({ refuse = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, target: req.url, auth: req.headers['proxy-authorization'] });
    const target = new URL(req.url);
    if (target.hostname.endsWith('.test')) target.hostname = '127.0.0.1';
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request(target, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  const tunnels = new Set();
  server.tunnels = tunnels;
  server.on('connect', (req, socket, head) => {
    tunnels.add(socket);
    seen.push({ method: 'CONNECT', target: req.url, auth: req.headers['proxy-authorization'] });
    if (refuse) {
      socket.end('HTTP/1.1 403 Filtered\r\n\r\n');
      return;
    }
    const [name, port] = req.url.split(':');
    const host = name.endsWith('.test') ? '127.0.0.1' : name;
    const upstream = net.connect(Number(port), host, () => {
      tunnels.add(upstream);
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await listen(server);
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

function selfSignedCert() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-proxy-test-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch {
    return null;
  }
}

test('with no proxy variables nothing is routed or replaced', async () => {
  await withEnv({}, async () => {
    const before = globalThis.fetch;
    assert.equal(outboundProxy.proxyFor('https://example.com/'), null);
    assert.equal(outboundProxy.agentFor('https://example.com/'), undefined);
    assert.equal(outboundProxy.agentFor('http://example.com/'), undefined);
    assert.equal(outboundProxy.install({ log() {}, warn() {} }), false);
    assert.equal(globalThis.fetch, before);
  });
});

test('the proxy for each scheme comes from its own variable, lower case first', async () => {
  await withEnv({ HTTPS_PROXY: 'http://upper:1', https_proxy: 'http://lower:2', HTTP_PROXY: 'plain:3' }, () => {
    assert.equal(outboundProxy.proxyFor('https://example.com/').host, 'lower:2');
    assert.equal(outboundProxy.proxyFor('wss://gateway.example.com/').host, 'lower:2');
    assert.equal(outboundProxy.proxyFor('http://example.com/').host, 'plain:3');
    assert.equal(outboundProxy.proxyFor('ftp://example.com/'), null);
  });
  await withEnv({ HTTPS_PROXY: 'http://only-https:1' }, () => {
    assert.equal(outboundProxy.proxyFor('http://example.com/'), null);
  });
});

test('an unusable proxy address fails instead of going direct', async () => {
  await withEnv({ HTTPS_PROXY: 'socks5://proxy:1080' }, async () => {
    assert.throws(() => outboundProxy.proxyFor('https://example.com/'), /only http:\/\/ proxies/);
    await assert.rejects(outboundProxy.fetch('https://example.com/'), /fetch failed/);
  });
});

test('proxy credentials are hidden when the proxy address is logged', () => {
  assert.equal(outboundProxy.redact('http://user:secret@proxy:8080'), 'http://***@proxy:8080');
  assert.equal(outboundProxy.redact('user:secret@proxy:8080'), '***@proxy:8080');
  assert.equal(outboundProxy.redact('http://proxy:8080'), 'http://proxy:8080');
  assert.equal(outboundProxy.redact('proxy:8080'), 'proxy:8080');
  assert.equal(outboundProxy.redact('http://user:p@ss@proxy:8080'), 'http://***@proxy:8080');
});

test('no_proxy matches names, subdomains, ports, addresses and CIDR ranges', async () => {
  const noProxy = 'localhost,127.0.0.1,::1,172.16.0.0/12,10.0.0.0/8,.mcpc.cloud,haven,*.wild.test,ported.test:8443,[fd00::1]';
  await withEnv({ HTTPS_PROXY: 'http://tinyproxy:8888', HTTP_PROXY: 'http://tinyproxy:8888', NO_PROXY: noProxy }, () => {
    const direct = (u) => outboundProxy.proxyFor(u) === null;
    assert.ok(direct('http://localhost:3000/'));
    assert.ok(direct('http://127.0.0.1/'));
    assert.ok(direct('http://[::1]/'));
    assert.ok(direct('http://172.18.0.4/'));
    assert.ok(direct('http://10.1.2.3/'));
    assert.ok(direct('https://haven.mcpc.cloud/'));
    assert.ok(direct('https://mcpc.cloud/'));
    assert.ok(direct('http://haven:3000/'));
    assert.ok(direct('https://a.wild.test/'));
    assert.ok(direct('https://ported.test:8443/'));
    assert.ok(direct('http://[fd00::1]/'));

    assert.ok(!direct('https://api.fxtwitter.com/'));
    assert.ok(!direct('https://notmcpc.cloud/'));
    assert.ok(!direct('http://172.32.0.1/'));
    assert.ok(!direct('https://ported.test/'));
    assert.ok(!direct('https://havenx/'));
  });
  await withEnv({ HTTPS_PROXY: 'http://tinyproxy:8888', no_proxy: '*' }, () => {
    assert.equal(outboundProxy.proxyFor('https://example.com/'), null);
  });
});

test('fetch goes through the proxy: redirects, compression, bodies, credentials', async () => {
  const site = await listen(http.createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/gz' }); return res.end(); }
    if (req.url === '/gz') {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain', 'Set-Cookie': ['a=1', 'b=2'] });
      return res.end(zlib.gzipSync('hello through the proxy'));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body, type: req.headers['content-type'] }));
    });
  }));
  const proxy = await startProxy();
  const proxyWithAuth = proxy.url.replace('http://', 'http://user:p%40ss@');
  const base = `http://127.0.0.1:${site.address().port}`;
  try {
    await withEnv({ HTTP_PROXY: proxyWithAuth }, async () => {
      const got = await outboundProxy.fetch(`${base}/start`);
      assert.equal(got.status, 200);
      assert.equal(got.redirected, true);
      assert.equal(got.url, `${base}/gz`);
      assert.equal(await got.text(), 'hello through the proxy');
      assert.deepEqual(got.headers.getSetCookie(), ['a=1', 'b=2']);

      const posted = await outboundProxy.fetch(`${base}/echo`, { method: 'POST', body: new URLSearchParams({ q: 'x y' }) });
      assert.equal(posted.status, 201);
      assert.deepEqual(await posted.json(), { method: 'POST', body: 'q=x+y', type: 'application/x-www-form-urlencoded;charset=UTF-8' });
    });
    assert.deepEqual(proxy.seen.map((s) => s.target), [`${base}/start`, `${base}/gz`, `${base}/echo`]);
    assert.equal(proxy.seen[0].auth, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  } finally {
    await close(proxy.server);
    await close(site);
  }
});

test('fetch to a no_proxy host is left to the normal fetch', async () => {
  const site = await listen(http.createServer((req, res) => res.end('direct')));
  const proxy = await startProxy();
  try {
    await withEnv({ HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' }, async () => {
      const got = await outboundProxy.fetch(`http://127.0.0.1:${site.address().port}/`);
      assert.equal(await got.text(), 'direct');
    });
    assert.equal(proxy.seen.length, 0);
  } finally {
    await close(proxy.server);
    await close(site);
  }
});

test('an abort reaches a request that is going through the proxy', async () => {
  const site = await listen(http.createServer(() => { /* never answers */ }));
  const proxy = await startProxy();
  try {
    await withEnv({ HTTP_PROXY: proxy.url }, async () => {
      await assert.rejects(
        outboundProxy.fetch(`http://127.0.0.1:${site.address().port}/`, { signal: AbortSignal.timeout(200) }),
        (err) => err.name === 'TimeoutError'
      );
    });
  } finally {
    await close(proxy.server);
    await close(site);
  }
});

test('https goes through a CONNECT tunnel with TLS to the site inside it', async (t) => {
  const pair = selfSignedCert();
  if (!pair) return t.skip('openssl not available');
  const site = await listen(https.createServer(pair, (req, res) => res.end(`tls ok ${req.url}`)));
  const proxy = await startProxy();
  const target = `https://127.0.0.1:${site.address().port}/path?q=1`;
  try {
    await withEnv({ HTTPS_PROXY: proxy.url }, async () => {
      const body = await new Promise((resolve, reject) => {
        const req = https.get(target, { agent: outboundProxy.agentFor(target), rejectUnauthorized: false }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
      });
      assert.equal(body, 'tls ok /path?q=1');
    });
    assert.deepEqual(proxy.seen.map((s) => `${s.method} ${s.target}`), [`CONNECT 127.0.0.1:${site.address().port}`]);
  } finally {
    await close(proxy.server);
    await close(site);
  }
});

test('https to an IP address checks the certificate against that address', async (t) => {
  const pair = selfSignedCert();
  if (!pair) return t.skip('openssl not available');
  const site = await listen(https.createServer(pair, (req, res) => res.end('should not be reached')));
  const proxy = await startProxy();
  const target = `https://127.0.0.1:${site.address().port}/`;
  try {
    await withEnv({ HTTPS_PROXY: proxy.url }, async () => {
      // The certificate is for localhost, so it must not be accepted for 127.0.0.1.
      await assert.rejects(new Promise((resolve, reject) => {
        https.get(target, { agent: outboundProxy.agentFor(target), ca: pair.cert }, resolve).on('error', reject);
      }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });
  } finally {
    await close(proxy.server);
    await close(site);
  }
});

test('an abort also cancels a CONNECT the proxy has not answered yet', async () => {
  const proxy = await listen(http.createServer());
  const tunnelClosed = new Promise((resolve) => {
    proxy.on('connect', (req, socket) => socket.on('end', () => { socket.destroy(); resolve(); }));
  });
  try {
    await withEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` }, async () => {
      await assert.rejects(outboundProxy.fetch('https://slow.example/', { signal: AbortSignal.timeout(200) }), (err) => err.name === 'TimeoutError');
      await tunnelClosed;
    });
  } finally {
    await close(proxy);
  }
});

test('a tunnel the proxy refuses fails with the reason', async () => {
  const proxy = await startProxy({ refuse: true });
  try {
    await withEnv({ HTTPS_PROXY: proxy.url }, async () => {
      await assert.rejects(outboundProxy.fetch('https://blocked.example/'), (err) => /HTTP 403/.test(err.cause?.message));
    });
  } finally {
    await close(proxy.server);
  }
});

test('member URLs through the proxy: refused when they point inward, allowed when only the proxy can resolve them', async () => {
  await withEnv({ HTTPS_PROXY: 'http://tinyproxy:8888', HTTP_PROXY: 'http://tinyproxy:8888' }, async () => {
    const unresolvable = async () => { throw Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' }); };
    const dest = await resolveCallbackDestination('https://x.com/user/status/1', { lookup: unresolvable });
    assert.equal(dest.proxy.host, 'tinyproxy:8888');
    assert.equal(dest.address, undefined);

    const inward = async () => [{ address: '172.18.0.4', family: 4 }];
    await assert.rejects(resolveCallbackDestination('http://socket-proxy:2375/', { lookup: inward }), { code: 'ERR_UNSAFE_CALLBACK_URL' });
    await assert.rejects(resolveCallbackDestination('http://192.168.1.1/', { lookup: unresolvable }), { code: 'ERR_UNSAFE_CALLBACK_URL' });
    await assert.rejects(resolveCallbackDestination('http://localhost/', { lookup: unresolvable }), { code: 'ERR_UNSAFE_CALLBACK_URL' });
  });

  await withEnv({ HTTPS_PROXY: 'http://tinyproxy:8888', HTTP_PROXY: 'http://tinyproxy:8888' }, async () => {
    // A bot on the server's own network, with private callbacks allowed, is
    // still reached directly at the checked address, as before.
    const local = async () => [{ address: '172.18.0.9', family: 4 }];
    const dest = await resolveCallbackDestination('http://mybot:5000/hook', { lookup: local, allowPrivateCallbacks: true });
    assert.equal(dest.proxy, undefined);
    assert.equal(dest.address, '172.18.0.9');
  });

  await withEnv({ HTTPS_PROXY: 'http://tinyproxy:8888', NO_PROXY: '.mcpc.cloud' }, async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const dest = await resolveCallbackDestination('https://haven.mcpc.cloud/', { lookup });
    assert.equal(dest.proxy, undefined);
    assert.equal(dest.address, '93.184.216.34');
  });
});

test('link previews (safeGet) go through the proxy when one is set', async () => {
  const site = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<meta property="og:title" content="Proxied">');
  }));
  const proxy = await startProxy();
  const target = `http://preview.test:${site.address().port}/page`;
  try {
    await withEnv({ HTTP_PROXY: proxy.url }, async () => {
      const got = await safeGet(target, { timeoutMs: 5000 });
      assert.equal(got.status, 200);
      assert.match(got.body.toString(), /Proxied/);
    });
    assert.deepEqual(proxy.seen.map((s) => s.target), [target]);
  } finally {
    await close(proxy.server);
    await close(site);
  }
});
