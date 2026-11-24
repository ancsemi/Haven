'use strict';
const http = require('node:http');
const https = require('node:https');
const jwt = require('jsonwebtoken');
const UP_MS = 30000;
const DOWN_MS = 10000;
const PROBE_MS = 3000;
const PROXY_MS = 30000;
const MAX_PROBE_BYTES = 70000;
const PROBE_USER_ID = 2147483647;
const PROBE_PATH = `/api/v1/events?after=${PROBE_USER_ID}`;
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const DROP_IN = new Set([...HOP, 'host', 'cookie']);
const DROP_OUT = new Set([...HOP, 'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'permissions-policy', 'strict-transport-security', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-credentials', 'access-control-expose-headers']);
const API_PATH = /^\/api\/v1\/(?:state|action|events)$/;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const MESSAGES = {
  ok: 'Birch is running and shares this server\'s session key',
  unreachable: 'BIRCH_PROXY_URL is set but nothing answers there',
  secret: 'Birch answered but refused this server\'s session key: HAVEN_JWT_SECRET in the Birch .env must equal JWT_SECRET in Haven\'s data folder .env',
  'not-birch': 'BIRCH_PROXY_URL is set but what answers there is not Birch'
};
function parseTarget(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  try {
    const u = text ? new URL(text) : null;
    const secure = !!u && u.protocol === 'https:';
    return u && (secure || u.protocol === 'http:') && !u.username && !u.password
      ? { client: secure ? https : http, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (secure ? 443 : 80), base: u.pathname.replace(/\/+$/, ''), label: u.host }
      : null;
  } catch { return null; }
}
function upstreamPath(url) {
  const cut = String(url || '/').indexOf('?');
  const path = cut < 0 ? String(url || '/') : String(url).slice(0, cut);
  const query = cut < 0 ? '' : String(url).slice(cut);
  let plain = '';
  try { plain = decodeURIComponent(path); } catch { return null; }
  return /\.\.|\\|\0/.test(plain) || !path.startsWith('/') ? null
    : path.startsWith('/api/') ? (API_PATH.test(path) ? path + query : null)
    : '/games' + (path === '/' ? '/index.html' : path) + query;
}
function classify(res) {
  let body = null;
  try { body = res ? JSON.parse(res.body) : null; } catch { body = null; }
  return !res ? 'unreachable'
    : res.status === 200 && body && body.ok === true && Array.isArray(body.events) ? 'ok'
    : (res.status === 401 || res.status === 403) && body && body.ok === false && typeof body.error === 'string' ? 'secret'
    : 'not-birch';
}
function getJson(target, path, headers) {
  return new Promise((resolve) => {
    const req = target.client.request({ hostname: target.hostname, port: target.port, path: target.base + path, method: 'GET', headers, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; size > MAX_PROBE_BYTES ? (resolve({ status: res.statusCode, body: '' }), res.destroy()) : chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
      res.on('close', () => resolve(null));
    });
    req.setTimeout(PROBE_MS, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
function createBirch({ url, secret, now = Date.now, log = console } = {}) {
  const target = parseTarget(url);
  let cached = null;
  let pending = null;
  let lastLogged = null;
  const view = (c) => ({ available: c.reason === 'ok', reason: c.reason });
  const record = (reason) => {
    cached = { reason, until: now() + (reason === 'ok' ? UP_MS : DOWN_MS) };
    reason !== lastLogged && (reason === 'ok' ? log.log : log.warn)(`[Birch] ${MESSAGES[reason]} (${target.label})`);
    lastLogged = reason;
    return cached;
  };
  const probe = async () => {
    const token = jwt.sign({ id: PROBE_USER_ID, username: 'haven-birch-check' }, secret, { expiresIn: '10s' });
    return classify(await getJson(target, PROBE_PATH, { authorization: `Bearer ${token}`, accept: 'application/json' }));
  };
  const status = () => !target ? Promise.resolve({ available: false, reason: 'off' })
    : cached && cached.until > now() ? Promise.resolve(view(cached))
    : (pending ||= probe().catch(() => 'unreachable').then(record).then(view).finally(() => { pending = null; }));
  const proxy = (req, res) => {
    const [bare, ...rest] = String(req.originalUrl || '').split('?');
    if (!target) return res.status(404).json({ error: 'Birch is not set up on this server' });
    if (bare === '/birch') return res.redirect(302, '/birch/' + (rest.length ? '?' + rest.join('?') : ''));
    if (!METHODS.has(req.method)) return res.status(405).set('Allow', 'GET, HEAD, POST').json({ error: 'Method not allowed' });
    const path = upstreamPath(req.url);
    if (!path) return res.status(404).json({ error: 'Not found' });
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP_IN.has(k)));
    const out = target.client.request({ hostname: target.hostname, port: target.port, path: target.base + path, method: req.method, headers, agent: false }, (up) => {
      const kept = {};
      for (const [k, v] of Object.entries(up.headers)) DROP_OUT.has(k) || (kept[k] = v);
      res.writeHead(up.statusCode || 502, kept);
      up.pipe(res);
    });
    out.setTimeout(PROXY_MS, () => out.destroy());
    out.on('error', () => {
      record('unreachable');
      res.headersSent ? res.destroy() : res.status(502).json({ error: 'Birch is not running' });
    });
    res.on('close', () => res.writableFinished || out.destroy());
    req.pipe(out);
  };
  return { enabled: !!target, status, proxy };
}
module.exports = { createBirch, parseTarget, upstreamPath, classify, UP_MS, DOWN_MS, MESSAGES };
