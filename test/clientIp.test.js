'use strict';

// Who counts as the client when a request carries X-Forwarded-For. Sockets
// work it out in src/clientIp.js and HTTP through Express; the two must agree,
// and by default a directly exposed server must ignore a forged header.

const assert = require('node:assert/strict');
const test = require('node:test');
const proxyaddr = require('proxy-addr');

const { socketClientIp, trustProxySetting, DEFAULT_TRUST_PROXY } = require('../src/clientIp');

const sock = (peer, xff) => ({ handshake: { address: peer, headers: xff ? { 'x-forwarded-for': xff } : {} } });
const expressIp = (peer, xff, trust) => proxyaddr(
  { connection: { remoteAddress: peer }, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} },
  // Express turns a number of hops into this function before proxy-addr sees it.
  typeof trust === 'number' ? (a, i) => i < trust : proxyaddr.compile(String(trust).split(',').map(s => s.trim()))
);

test('by default a forged header from the internet is ignored', () => {
  assert.equal(socketClientIp(sock('203.0.113.9', '1.2.3.4'), DEFAULT_TRUST_PROXY), '203.0.113.9');
  assert.equal(socketClientIp(sock('::ffff:203.0.113.9', '1.2.3.4'), DEFAULT_TRUST_PROXY), '203.0.113.9');
});

test('by default a proxy on this machine or the local network is believed', () => {
  assert.equal(socketClientIp(sock('127.0.0.1', '198.51.100.7'), DEFAULT_TRUST_PROXY), '198.51.100.7');
  assert.equal(socketClientIp(sock('::1', '198.51.100.7'), DEFAULT_TRUST_PROXY), '198.51.100.7');
  assert.equal(socketClientIp(sock('172.18.0.2', '198.51.100.7'), DEFAULT_TRUST_PROXY), '198.51.100.7');
  // A client-supplied value in front of what the proxy appended is not believed.
  assert.equal(socketClientIp(sock('127.0.0.1', '6.6.6.6, 198.51.100.7'), DEFAULT_TRUST_PROXY), '198.51.100.7');
});

test('sockets and Express agree on the client address', () => {
  const cases = [
    ['203.0.113.9', '1.2.3.4'],
    ['127.0.0.1', '198.51.100.7'],
    ['127.0.0.1', '6.6.6.6, 198.51.100.7'],
    ['10.0.0.5', '192.168.1.20, 198.51.100.7'],
    ['192.168.1.1', null],
    ['::1', '2001:db8::5'],
    ['fe80::1', '198.51.100.7'],
  ];
  for (const trust of [DEFAULT_TRUST_PROXY, 1, 2, 0]) {
    for (const [peer, xff] of cases) {
      const ours = socketClientIp(sock(peer, xff), trust);
      const theirs = expressIp(peer, xff, trust).replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
      assert.equal(ours, theirs, `trust=${trust} peer=${peer} xff=${xff}`);
    }
  }
});

test('TRUST_PROXY is read the way Express reads it', () => {
  const saved = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(trustProxySetting(), DEFAULT_TRUST_PROXY);
    process.env.TRUST_PROXY = '1'; assert.equal(trustProxySetting(), 1);
    process.env.TRUST_PROXY = '0'; assert.equal(trustProxySetting(), 0);
    process.env.TRUST_PROXY = 'true'; assert.equal(trustProxySetting(), true);
    process.env.TRUST_PROXY = 'loopback'; assert.equal(trustProxySetting(), 'loopback');
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved;
  }
});
