'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const alwaysBlocked = new net.BlockList();
const privateBlocked = new net.BlockList();
const globalIpv6 = new net.BlockList();

// Link-local, reserved, transition, and documentation ranges are never valid
// callback destinations, even when private callbacks are explicitly enabled.
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) alwaysBlocked.addSubnet(address, prefix, 'ipv4');

// These ranges are available only to self-hosters who explicitly opt in.
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16]
]) privateBlocked.addSubnet(address, prefix, 'ipv4');

for (const [address, prefix] of [
  ['::', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
]) alwaysBlocked.addSubnet(address, prefix, 'ipv6');

privateBlocked.addSubnet('::1', 128, 'ipv6');
privateBlocked.addSubnet('fc00::', 7, 'ipv6');
globalIpv6.addSubnet('2000::', 3, 'ipv6');

class UnsafeCallbackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeCallbackError';
    this.code = 'ERR_UNSAFE_CALLBACK_URL';
  }
}

function parseCallbackUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new UnsafeCallbackError('Callback URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeCallbackError('Callback URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new UnsafeCallbackError('Callback URL must not contain credentials');
  }
  return url;
}

function normalizedHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function mappedIpv4(address) {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice(7);
  if (net.isIP(tail) === 4) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2 || groups.some(group => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  const high = parseInt(groups[0], 16);
  const low = parseInt(groups[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isBlockedAddress(address, family, allowPrivateCallbacks = false) {
  const numericFamily = family === 6 || family === 'IPv6' ? 6 : 4;
  if (numericFamily === 6) {
    const embedded = mappedIpv4(address);
    if (embedded) return isBlockedAddress(embedded, 4, allowPrivateCallbacks);
  }
  const type = numericFamily === 6 ? 'ipv6' : 'ipv4';
  if (alwaysBlocked.check(address, type)) return true;
  if (numericFamily === 6) {
    if (globalIpv6.check(address, 'ipv6')) return false;
    return !(allowPrivateCallbacks && privateBlocked.check(address, 'ipv6'));
  }
  return !allowPrivateCallbacks && privateBlocked.check(address, type);
}

function validateCallbackUrl(urlString, allowPrivateCallbacks = false) {
  try {
    const url = parseCallbackUrl(urlString);
    const hostname = normalizedHostname(url);
    if (!allowPrivateCallbacks && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal'))) {
      return false;
    }
    const family = net.isIP(hostname);
    return !family || !isBlockedAddress(hostname, family, allowPrivateCallbacks);
  } catch {
    return false;
  }
}

async function resolveCallbackDestination(urlString, options = {}) {
  const allowPrivateCallbacks = options.allowPrivateCallbacks === true;
  const lookup = options.lookup || dns.lookup;
  const url = parseCallbackUrl(urlString);
  const hostname = normalizedHostname(url);
  if (!allowPrivateCallbacks && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal'))) {
    throw new UnsafeCallbackError('Callback URL points to a local hostname');
  }

  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new UnsafeCallbackError('Callback hostname did not resolve');
  }
  for (const entry of addresses) {
    const family = entry.address ? net.isIP(entry.address) : 0;
    if (!family || isBlockedAddress(entry.address, family, allowPrivateCallbacks)) {
      throw new UnsafeCallbackError('Callback URL resolves to a blocked network');
    }
  }
  const selected = addresses[0];
  return {
    url,
    address: selected.address,
    family: net.isIP(selected.address)
  };
}

function createPinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function withDeadline(promise, deadlineAt, message) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), remaining); })
  ]).finally(() => clearTimeout(timer));
}

function postResolvedCallback(destination, payload, headers, deadlineAt) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return reject(new Error('Webhook callback exceeded its deadline'));
    const transport = destination.url.protocol === 'https:' ? https : http;
    let response;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const request = transport.request(destination.url, {
      method: 'POST',
      agent: false,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      lookup: createPinnedLookup(destination.address, destination.family)
    }, incoming => {
      response = incoming;
      incoming.on('error', finish);
      incoming.on('end', () => finish(null, {
        ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        status: incoming.statusCode
      }));
      incoming.resume();
    });
    timer = setTimeout(() => {
      const error = new Error('Webhook callback exceeded its deadline');
      response?.destroy(error);
      request.destroy(error);
    }, remaining);
    request.on('error', finish);
    request.end(payload);
  });
}

async function postWebhookCallback(urlString, payload, headers, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
  const deadlineAt = Date.now() + timeoutMs;
  const destination = await withDeadline(
    resolveCallbackDestination(urlString, options),
    deadlineAt,
    'Webhook callback DNS resolution timed out'
  );
  return postResolvedCallback(destination, payload, headers, deadlineAt);
}

module.exports = {
  UnsafeCallbackError,
  createPinnedLookup,
  isBlockedAddress,
  postWebhookCallback,
  resolveCallbackDestination,
  validateCallbackUrl
};
