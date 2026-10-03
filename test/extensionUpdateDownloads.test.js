'use strict';

// Exercise the downloader's redirect and DNS boundaries without contacting
// GitHub or changing the process-wide HTTPS/DNS modules used by other tests.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/extensionUpdates.js'), 'utf8');
const BLOCKLIST_URL = 'https://ancsemi.github.io/Haven/blocklist.json';
const CANONICAL_URL = 'https://haven-app.com/blocklist.json';

function createDownloadFixture(responses, addresses = {}) {
  const requests = [];
  const lookups = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  const https = {
    get(url, options, onResponse) {
      const req = new EventEmitter();
      req.destroy = error => queueMicrotask(() => req.emit('error', error));
      requests.push({ url: url.href, options });
      // Real HTTPS reports responses and errors after returning its request.
      queueMicrotask(() => {
        options.lookup(url.hostname, {}, (error, address, family) => {
          if (error) return req.destroy(error);
          const response = responses[url.href];
          assert.ok(response, 'Unexpected request: ' + url.href);
          assert.equal(address, addresses[url.hostname] || '93.184.216.34');
          assert.equal(family, 4);
          clock += response.elapsed || 0;
          if (response.hang) return;
          const res = new EventEmitter();
          res.statusCode = response.status || 200;
          res.headers = response.headers || {};
          let destroyed = false;
          res.destroy = error => {
            destroyed = true;
            queueMicrotask(() => {
              if (error) res.emit('error', error);
              res.emit('close');
            });
          };
          onResponse(res);
          queueMicrotask(() => {
            for (const chunk of response.chunks || []) {
              if (destroyed) return;
              res.emit('data', Buffer.from(chunk));
            }
            if (!destroyed) {
              res.emit('end');
              res.emit('close');
            }
          });
        });
      });
      return req;
    },
  };
  const dns = {
    lookup(hostname, options, callback) {
      lookups.push({ hostname, options });
      callback(null, addresses[hostname] || '93.184.216.34', 4);
    },
  };
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, Buffer, URL,
    require: name => name === 'node:https' ? https : name === 'node:dns' ? dns : require(name),
    Date: { now: () => clock },
    setTimeout(handler, duration) {
      const id = ++nextTimer;
      timers.set(id, { handler, duration });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(SOURCE, context, { filename: 'extensionUpdates.js' });
  return { download: context.module.exports.downloadExtensionAsset, requests, lookups, timers };
}

test('the blocklist follows the GitHub Pages redirect to its exact public canonical URL', async () => {
  const json = JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-03T00:00:00Z', blocked: [] });
  const fixture = createDownloadFixture({
    [BLOCKLIST_URL]: { status: 301, headers: { location: CANONICAL_URL } },
    [CANONICAL_URL]: { chunks: [json.slice(0, 20), json.slice(20)] },
  });
  const bytes = await fixture.download(BLOCKLIST_URL, 1024);

  assert.deepEqual(JSON.parse(bytes.toString()), JSON.parse(json));
  assert.deepEqual(fixture.requests.map(request => request.url), [BLOCKLIST_URL, CANONICAL_URL]);
  assert.deepEqual(fixture.lookups.map(lookup => lookup.hostname), ['ancsemi.github.io', 'haven-app.com']);
  assert.ok(fixture.lookups.every(lookup => lookup.options.family === 4));
  assert.ok(fixture.requests.every(request => request.options.headers['Cache-Control'] === 'no-cache'));
  assert.equal(fixture.timers.size, 0);
});

test('a blocklist redirect cannot authorize another host, path or URL component', async () => {
  for (const destination of [
    'https://unapproved.example/blocklist.json',
    'https://haven-app.com/another.json',
    CANONICAL_URL + '?source=redirect',
    CANONICAL_URL + '#fragment',
    'https://user:password@haven-app.com/blocklist.json',
    'http://haven-app.com/blocklist.json',
    'https://haven-app.com:444/blocklist.json',
  ]) {
    const fixture = createDownloadFixture({
      [BLOCKLIST_URL]: { status: 301, headers: { location: destination } },
    });
    await assert.rejects(fixture.download(BLOCKLIST_URL, 1024), /Unsafe download URL|Unapproved download host/);
    assert.equal(fixture.requests.length, 1, 'unsafe redirect is rejected before a connection');
    assert.equal(fixture.timers.size, 0);
  }
});

test('an approved redirect still rejects a private DNS result', async () => {
  const fixture = createDownloadFixture({
    [BLOCKLIST_URL]: { status: 301, headers: { location: CANONICAL_URL } },
    [CANONICAL_URL]: { chunks: ['should not be read'] },
  }, { 'haven-app.com': '127.0.0.1' });

  await assert.rejects(fixture.download(BLOCKLIST_URL, 1024), /non-public address/);
  assert.deepEqual(fixture.lookups.map(lookup => lookup.hostname), ['ancsemi.github.io', 'haven-app.com']);
  assert.equal(fixture.timers.size, 0);
});

test('the redirected blocklist retains declared and streamed size limits', async () => {
  for (const response of [
    { headers: { 'content-length': '6' }, chunks: ['123456'] },
    { chunks: ['1234', '56'] },
  ]) {
    const fixture = createDownloadFixture({
      [BLOCKLIST_URL]: { status: 301, headers: { location: CANONICAL_URL } },
      [CANONICAL_URL]: response,
    });
    await assert.rejects(fixture.download(BLOCKLIST_URL, 5), /size limit/);
    assert.equal(fixture.timers.size, 0);
  }
});

test('redirects share the original deadline instead of restarting the timeout', async () => {
  const fixture = createDownloadFixture({
    [BLOCKLIST_URL]: { status: 301, headers: { location: CANONICAL_URL }, elapsed: 15 },
    [CANONICAL_URL]: { hang: true },
  });
  const pending = fixture.download(BLOCKLIST_URL, 1024, 0, 20);
  const rejected = assert.rejects(pending, /timed out/);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.timers.size, 1);
  const timer = [...fixture.timers.values()][0];
  assert.equal(timer.duration, 5, 'only the time remaining before the original deadline is available');
  timer.handler();
  await rejected;
  assert.equal(fixture.timers.size, 0);
});
