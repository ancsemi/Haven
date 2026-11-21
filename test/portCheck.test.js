'use strict';
// Internet Access check (#5923): portchecker.io wants a JSON POST now.
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { externalPort, parsePortchecker, queryPortchecker, PORTCHECKER_URL } = require('../src/portCheck');

function fakeRequest(status, body, seen) {
  return (url, opts, onResp) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (payload) => {
      seen.push({ url, opts, payload });
      const resp = new EventEmitter();
      resp.statusCode = status;
      onResp(resp);
      setImmediate(() => { if (body !== undefined) resp.emit('data', body); resp.emit('end'); });
    };
    return req;
  };
}

test('reads the current reply shape and the old one', () => {
  assert.equal(parsePortchecker({ error: false, check: [{ port: 443, status: true }], host: 'x' }, 443), true);
  assert.equal(parsePortchecker({ error: false, check: [{ port: 3000, status: false }] }, '3000'), false);
  assert.equal(parsePortchecker({ host: 'x', ports: [{ port: 3000, status: 'open' }] }, 3000), true);
  assert.equal(parsePortchecker({ ports: [{ port: 3000, status: 'closed' }] }, 3000), false);
});

test('an error reply or a missing port is "no answer", not "unreachable"', () => {
  assert.equal(parsePortchecker({ error: true, msg: 'bad' }, 443), null);
  assert.equal(parsePortchecker({ check: [{ port: 80, status: true }] }, 443), null);
  assert.equal(parsePortchecker({ check: [{ port: 443, status: 'unknown' }] }, 443), null);
  assert.equal(parsePortchecker(null, 443), null);
  assert.equal(parsePortchecker('nope', 443), null);
});

test('behind a reverse proxy the PUBLIC_URL port is checked', () => {
  assert.equal(externalPort('https://chat.example.com', 3000), 443);
  assert.equal(externalPort('http://chat.example.com', 3000), 80);
  assert.equal(externalPort('https://chat.example.com:8443/', 3000), 8443);
  assert.equal(externalPort('', '3000'), 3000);
  assert.equal(externalPort('not a url', 3000), 3000);
});

test('sends a JSON POST with the host and port', async () => {
  const seen = [];
  const ok = await queryPortchecker('203.0.113.7', 443, { request: fakeRequest(200, JSON.stringify({ error: false, check: [{ port: 443, status: true }] }), seen) });
  assert.equal(ok, true);
  assert.equal(seen[0].url, PORTCHECKER_URL);
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(seen[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].payload), { host: '203.0.113.7', ports: [443] });
});

test('a non-2xx reply (the old 405) or bad body is "no answer"', async () => {
  assert.equal(await queryPortchecker('203.0.113.7', 443, { request: fakeRequest(405, 'Method Not Allowed', []) }), null);
  assert.equal(await queryPortchecker('203.0.113.7', 443, { request: fakeRequest(200, '<html>', []) }), null);
  assert.equal(await queryPortchecker('203.0.113.7', 443, { request: fakeRequest(200, JSON.stringify({ error: false, check: [{ port: 443, status: false }] }), []) }), false);
});

test('response errors and timeouts return no answer', async () => {
  for (const event of ['error', 'aborted']) {
    const request = (_url, _opts, onResp) => {
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => { const resp = new EventEmitter(); resp.statusCode = 200; onResp(resp); setImmediate(() => resp.emit(event)); };
      return req;
    };
    assert.equal(await queryPortchecker('203.0.113.7', 443, { request }), null);
  }
  let destroyed = false;
  const request = () => { const req = new EventEmitter(); req.destroy = () => { destroyed = true; }; req.end = () => setImmediate(() => req.emit('timeout')); return req; };
  assert.equal(await queryPortchecker('203.0.113.7', 443, { request }), null);
  assert.equal(destroyed, true);
});
