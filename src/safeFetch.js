'use strict';

/**
 * GET a URL that a member chose (link previews, the media proxy) without
 * letting it steer the server into its own network.
 *
 * Every hop is resolved once, every address it resolves to (IPv4 and IPv6) is
 * checked against the blocked ranges the bot callbacks already use, and the
 * connection goes to exactly the address that was checked. That covers the
 * ways the old check could be walked around: a redirect to an internal host, a
 * second DNS answer that changes between the check and the connect, a name
 * with only an IPv6 record, and spellings of loopback such as 127.0.0.2 or
 * [::ffff:7f00:1].
 *
 * The body is read up to a byte ceiling rather than buffered whole, and
 * compressed bodies are inflated under the same ceiling.
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { resolveCallbackDestination, createPinnedLookup } = require('./webhookCallback');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function decoderFor(encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  return null;
}

function requestOnce(destination, headers, deadlineAt, maxBytes, truncate) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return reject(new Error('Request timed out'));
    const transport = destination.url.protocol === 'https:' ? https : http;
    let settled = false;
    let timer;
    let request;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { response?.destroy(); } catch {}
        try { request?.destroy(); } catch {}
        reject(error);
      } else {
        resolve(result);
      }
    };

    request = transport.request(destination.url, {
      method: 'GET',
      agent: false,
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      lookup: createPinnedLookup(destination.address, destination.family),
    }, (incoming) => {
      response = incoming;
      const status = incoming.statusCode || 0;
      if (REDIRECTS.has(status)) {
        incoming.resume();
        return finish(null, { status, headers: incoming.headers, body: Buffer.alloc(0) });
      }

      const declared = parseInt(incoming.headers['content-length'] || '0', 10);
      const encoded = decoderFor(incoming.headers['content-encoding']);
      if (!truncate && !encoded && Number.isFinite(declared) && declared > maxBytes) {
        return finish(new Error('too large'));
      }

      const source = encoded ? incoming.pipe(encoded) : incoming;
      const chunks = [];
      let size = 0;
      const done = () => finish(null, { status, headers: incoming.headers, body: Buffer.concat(chunks, Math.min(size, maxBytes)) });
      source.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          if (!truncate) return finish(new Error('too large'));
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          size = maxBytes;
          return done();
        }
        chunks.push(chunk);
      });
      source.on('end', done);
      source.on('error', (err) => finish(err));
      incoming.on('error', (err) => finish(err));
    });

    timer = setTimeout(() => finish(new Error('Request timed out')), remaining);
    request.on('error', (err) => finish(err));
    request.end();
  });
}

/**
 * @param {string} urlString
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate]  LAN and loopback allowed (link-local and metadata never are)
 * @param {number}  [options.maxRedirects]
 * @param {number}  [options.timeoutMs]     for the whole chain, DNS included
 * @param {number}  [options.maxBytes]
 * @param {boolean} [options.truncate]      keep the first maxBytes instead of failing
 * @param {object}  [options.headers]
 * @param {Function} [options.resolve]      for tests: (url, { allowPrivateCallbacks }) => destination
 * @returns {Promise<{ status: number, headers: object, body: Buffer, url: string }>}
 */
async function safeGet(urlString, options = {}) {
  const {
    allowPrivate = false,
    maxRedirects = 5,
    timeoutMs = 8000,
    maxBytes = 1024 * 1024,
    truncate = false,
    headers = {},
    resolve = resolveCallbackDestination,
  } = options;
  const deadlineAt = Date.now() + timeoutMs;
  let current = urlString;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let destination;
    try {
      destination = await Promise.race([
        resolve(current, { allowPrivateCallbacks: allowPrivate }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), Math.max(1, deadlineAt - Date.now()))),
      ]);
    } catch (err) {
      if (err && err.code === 'ERR_UNSAFE_CALLBACK_URL') throw new UnsafeUrlError('Private addresses not allowed');
      throw err;
    }
    const result = await requestOnce(destination, headers, deadlineAt, maxBytes, truncate);
    if (REDIRECTS.has(result.status) && result.headers.location) {
      current = new URL(result.headers.location, destination.url).href;
      continue;
    }
    return { ...result, url: current };
  }
  throw new Error('Too many redirects');
}

module.exports = { safeGet, UnsafeUrlError };
