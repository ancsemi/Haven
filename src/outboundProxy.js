'use strict';

/**
 * Outgoing requests through the proxy the host set with the standard
 * http_proxy / https_proxy / no_proxy variables. Either case is read, lower
 * case first, the way curl reads them.
 *
 * Node's own fetch and http modules ignore these variables unless
 * NODE_USE_ENV_PROXY is set, and that switch is still experimental. Reading
 * them here means a Haven whose only way out is a proxy works without it:
 * Haven connects to the proxy itself and asks it for the site.
 *
 * With none of the variables set nothing here changes how a request is made.
 * proxyFor() returns null, agentFor() returns undefined, and install() leaves
 * the global fetch alone.
 *
 * Only http:// proxies are supported (the kind tinyproxy, squid and most
 * corporate proxies are). https:// and wss:// sites go through them with
 * CONNECT, http:// sites as a plain proxied request.
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { Readable, pipeline } = require('node:stream');

const originalFetch = globalThis.fetch;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 20;
const TUNNEL_TIMEOUT_MS = 30000;
// Node's own fetch gives up on a connection that sends nothing for five
// minutes, waiting for the headers or partway through the body.
const FETCH_IDLE_TIMEOUT_MS = 300000;

function readEnv(name) {
  for (const key of [name.toLowerCase(), name.toUpperCase()]) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function toUrl(target) {
  return target instanceof URL ? target : new URL(String(target));
}

function bareHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isSecure(url) {
  return url.protocol === 'https:' || url.protocol === 'wss:';
}

function isProxiable(url) {
  return isSecure(url) || url.protocol === 'http:';
}

// ── Proxy address ───────────────────────────────────────

const proxyCache = new Map();

// Hide proxy credentials, with or without a scheme in front
// (http://user:pass@host and user:pass@host). The credentials run to the last
// @ before the path, as URL parsing reads them, so a password may contain @.
function redact(raw) {
  return String(raw).replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/?#]*@/i, '$1***@');
}

function parseProxy(raw) {
  if (proxyCache.has(raw)) return proxyCache.get(raw);
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error(`proxy address ${redact(raw)} is not a valid URL`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`proxy address ${redact(raw)} uses ${url.protocol}//, only http:// proxies are supported`);
  }
  proxyCache.set(raw, url);
  return url;
}

function proxyHost(proxy) {
  return proxy.hostname.replace(/^\[|\]$/g, '');
}

function proxyPort(proxy) {
  return Number(proxy.port) || 80;
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const pair = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

// ── no_proxy ────────────────────────────────────────────
// Entries are separated by commas or spaces. Each one is `*` (everything), a
// CIDR range, an IP address, or a domain that also covers its subdomains. A
// leading `.` or `*.` on a domain is ignored, and an entry can end in :port.

let noProxyRaw = null;
let noProxyRules = null;

function ipList(address, prefix) {
  const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
  const list = new net.BlockList();
  if (prefix === undefined) list.addAddress(address, family);
  else list.addSubnet(address, prefix, family);
  return { list, family };
}

function parseNoProxy(raw) {
  if (raw === noProxyRaw) return noProxyRules;
  const rules = { all: false, entries: [] };
  for (const piece of raw.split(/[\s,]+/)) {
    const entry = piece.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') { rules.all = true; continue; }

    const cidr = entry.match(/^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/);
    if (cidr && net.isIP(cidr[1])) {
      const prefix = Number(cidr[2]);
      if (prefix <= (net.isIP(cidr[1]) === 6 ? 128 : 32)) rules.entries.push({ ...ipList(cidr[1], prefix), port: '' });
      continue;
    }

    let host = entry;
    let port = '';
    const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) {
      host = bracketed[1];
      port = bracketed[2] || '';
    } else if (!net.isIPv6(entry)) {
      const withPort = entry.match(/^(.*):(\d+)$/);
      if (withPort) { host = withPort[1]; port = withPort[2]; }
    }
    if (net.isIP(host)) { rules.entries.push({ ...ipList(host), port }); continue; }
    host = host.replace(/^\*?\./, '').replace(/\.$/, '');
    if (host) rules.entries.push({ host, port });
  }
  noProxyRaw = raw;
  noProxyRules = rules;
  return rules;
}

function bypassesProxy(hostname, port) {
  const rules = parseNoProxy(readEnv('no_proxy'));
  if (rules.all) return true;
  const family = net.isIP(hostname);
  for (const rule of rules.entries) {
    if (rule.port && rule.port !== port) continue;
    if (rule.list) {
      if (family && rule.list.check(hostname, family === 6 ? 'ipv6' : 'ipv4')) return true;
    } else if (hostname === rule.host || (!family && hostname.endsWith(`.${rule.host}`))) {
      return true;
    }
  }
  return false;
}

/**
 * The proxy a request to `target` should go through, or null to connect
 * directly. Throws when a proxy is configured but its address is unusable, so
 * a broken setting fails the request instead of quietly going direct.
 */
function proxyFor(target) {
  const url = toUrl(target);
  if (!isProxiable(url)) return null;
  const secure = isSecure(url);
  const raw = readEnv(secure ? 'https_proxy' : 'http_proxy');
  if (!raw) return null;
  const port = url.port || (secure ? '443' : '80');
  if (bypassesProxy(bareHostname(url), port)) return null;
  return parseProxy(raw);
}

// ── Connecting through the proxy ────────────────────────

function openTunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const headers = { Host: authority };
    const auth = proxyAuthorization(proxy);
    if (auth) headers['Proxy-Authorization'] = auth;
    const request = http.request({
      host: proxyHost(proxy),
      port: proxyPort(proxy),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      signal,
    });
    request.setTimeout(TUNNEL_TIMEOUT_MS, () => request.destroy(new Error(`proxy did not answer for ${authority}`)));
    request.once('connect', (response, socket, head) => {
      request.setTimeout(0);
      if (response.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy refused ${authority} (HTTP ${response.statusCode})`));
      }
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    request.once('error', reject);
    request.end();
  });
}

// An https.Agent whose connections are CONNECT tunnels through the proxy,
// with TLS to the site running inside the tunnel.
class TunnelAgent extends https.Agent {
  constructor(proxy, signal) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.signal = signal;
  }

  createConnection(options, callback) {
    const host = options.host || 'localhost';
    openTunnel(this.proxy, host, options.port || 443, this.signal).then((socket) => {
      callback(null, tls.connect({
        socket,
        host,
        servername: options.servername || (net.isIP(host) ? undefined : host),
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: options.rejectUnauthorized !== false,
        ca: options.ca,
      }));
    }, callback);
  }
}

// An http.Agent that hands each request to the proxy in absolute form
// (GET http://site/path), which is how plain http:// goes through a proxy.
class ForwardAgent extends http.Agent {
  constructor(proxy) {
    super({ keepAlive: false });
    this.proxy = proxy;
  }

  addRequest(req, options) {
    const port = Number(options.port) || 80;
    const host = net.isIPv6(options.host) ? `[${options.host}]` : options.host;
    const authority = req.getHeader('host') || (port === 80 ? host : `${host}:${port}`);
    req.path = `http://${authority}${req.path}`;
    const auth = proxyAuthorization(this.proxy);
    if (auth) req.setHeader('Proxy-Authorization', auth);
    super.addRequest(req, { ...options, host: proxyHost(this.proxy), port: proxyPort(this.proxy), servername: undefined });
  }
}

function agentThrough(url, proxy, signal) {
  return isSecure(url) ? new TunnelAgent(proxy, signal) : new ForwardAgent(proxy);
}

/**
 * An agent for http(s).request / http(s).get / ws / web-push that sends the
 * request through the proxy, or undefined when `target` goes direct, which
 * leaves those calls exactly as they were.
 */
function agentFor(target) {
  const url = toUrl(target);
  const proxy = proxyFor(url);
  return proxy ? agentThrough(url, proxy) : undefined;
}

/**
 * http.request / https.request through `proxy`. Same options and callback as
 * those, minus anything about picking an address (the proxy does that).
 */
function request(target, options, onResponse, proxy = proxyFor(target)) {
  const url = toUrl(target);
  const { lookup, agent, ...rest } = options;
  const transport = url.protocol === 'https:' ? https : http;
  return transport.request(url, { ...rest, agent: agentThrough(url, proxy, rest.signal) }, onResponse);
}

// ── fetch ───────────────────────────────────────────────

function decoderFor(encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') {
    return zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') {
    return zlib.createBrotliDecompress({
      flush: zlib.constants.BROTLI_OPERATION_FLUSH,
      finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
    });
  }
  return null;
}

function fetchFailed(cause) {
  return new TypeError('fetch failed', { cause });
}

function sendOnce(url, method, headers, body, signal, proxy) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const outgoing = Object.fromEntries(headers);
    if (!('accept' in outgoing)) outgoing.accept = '*/*';
    if (!('user-agent' in outgoing)) outgoing['user-agent'] = 'node';
    if (!('accept-encoding' in outgoing)) outgoing['accept-encoding'] = 'gzip, deflate, br';
    if (body) outgoing['content-length'] = String(body.length);

    let req;
    try {
      req = request(url, { method, headers: outgoing, signal }, resolve, proxy);
    } catch (err) {
      return reject(fetchFailed(err));
    }
    req.setTimeout(FETCH_IDLE_TIMEOUT_MS, () => req.destroy(new Error(`no data from ${url.host} for ${FETCH_IDLE_TIMEOUT_MS / 1000} s`)));
    req.on('error', (err) => reject(signal.aborted ? signal.reason : fetchFailed(err)));
    req.end(body || undefined);
  });
}

function toResponse(incoming, url, redirected, method, signal) {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    try { headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]); } catch { /* a header fetch would not accept either */ }
  }

  let body = null;
  if (method !== 'HEAD' && !NULL_BODY.has(incoming.statusCode)) {
    const decoder = decoderFor(incoming.headers['content-encoding']);
    body = Readable.toWeb(decoder ? pipeline(incoming, decoder, () => {}) : incoming);
  } else {
    incoming.resume();
  }

  const onAbort = () => incoming.destroy(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  incoming.once('close', () => signal.removeEventListener('abort', onAbort));

  let response;
  try {
    response = new Response(body, { status: incoming.statusCode, statusText: incoming.statusMessage || '', headers });
  } catch (err) {
    incoming.destroy();
    throw fetchFailed(err);
  }
  Object.defineProperty(response, 'url', { value: url.href });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

async function fetchThroughProxy(input, init, proxy) {
  const req = new Request(input, init);
  const signal = req.signal;
  const mode = req.redirect;
  const headers = new Headers(req.headers);
  let url = new URL(req.url);
  let method = req.method;
  let body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  let redirected = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hopProxy = hop === 0 ? proxy : proxyFor(url);
    if (!hopProxy) {
      // A redirect onto a no_proxy host: hand the rest to the direct fetch.
      return originalFetch(url, { method, headers, body, signal, redirect: mode });
    }
    const incoming = await sendOnce(url, method, headers, body, signal, hopProxy);
    const status = incoming.statusCode;
    if (!REDIRECTS.has(status) || !incoming.headers.location || mode === 'manual') {
      return toResponse(incoming, url, redirected, method, signal);
    }

    incoming.resume();
    if (mode === 'error') throw fetchFailed(new Error('unexpected redirect'));
    let next;
    try { next = new URL(incoming.headers.location, url); } catch (err) { throw fetchFailed(err); }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw fetchFailed(new Error('redirect to a non-HTTP URL'));
    if ((status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
      method = 'GET';
      body = null;
      for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
    }
    if (next.origin !== url.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    url = next;
    redirected = true;
  }
  throw fetchFailed(new Error('redirect count exceeded'));
}

/**
 * Drop-in for the global fetch. Requests that go through the proxy are sent
 * to it by Haven; everything else is handed to Node's own fetch untouched.
 */
async function proxiedFetch(input, init) {
  let url;
  try {
    url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input));
  } catch {
    return originalFetch(input, init);
  }
  let proxy;
  try { proxy = proxyFor(url); } catch (err) { throw fetchFailed(err); }
  if (!proxy) return originalFetch(input, init);
  return fetchThroughProxy(input, init, proxy);
}

let installed = false;

/**
 * Route the global fetch through the proxy. Does nothing, and returns false,
 * when neither https_proxy nor http_proxy is set.
 */
function install({ log = console.log, warn = console.warn } = {}) {
  if (installed) return true;
  const configured = [['https_proxy', readEnv('https_proxy')], ['http_proxy', readEnv('http_proxy')]].filter(([, raw]) => raw);
  if (!configured.length) return false;

  for (const [name, raw] of configured) {
    try {
      parseProxy(raw);
      log(`🔀 [proxy] ${name} → ${redact(raw)}`);
    } catch (err) {
      warn(`⚠️  [proxy] ${name}: ${err.message}. Requests that should use it will fail rather than connect directly.`);
    }
  }
  const noProxy = readEnv('no_proxy');
  if (noProxy) log(`🔀 [proxy] no_proxy → ${noProxy}`);
  const setVars = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']
    .filter((key) => typeof process.env[key] === 'string' && process.env[key].trim());
  const listed = setVars.length > 1 ? `${setVars.slice(0, -1).join(', ')} and ${setVars.at(-1)}` : setVars[0];
  warn([
    '⚠️  [proxy] SECURITY WARNING: outgoing proxy enabled.',
    `Your configuration enables proxy support, which limits some of the protections offered by Haven against malicious users on your server. If this is not intentional, immediately comment out or remove ${listed} and restart Haven.`,
    'Please refer to the "Outgoing Proxy" section of GUIDE.md for more information.',
  ].join('\n'));

  globalThis.fetch = proxiedFetch;
  installed = true;
  return true;
}

module.exports = {
  agentFor,
  fetch: proxiedFetch,
  install,
  proxyFor,
  redact,
  request,
};
