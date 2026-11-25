'use strict';
const http = require('node:http');
const jwt = require('jsonwebtoken');
const SECRET = 'birch-test-secret-birch-test-secret-0123456789';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
const send = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(body);
});
function fakeBird(secret = SECRET) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const reply = (status, type, body, extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra }); res.end(body); };
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const valid = (() => { try { return jwt.verify(bearer, secret); } catch { return null; } })();
      const path = req.url.split('?')[0];
      path === '/api/v1/events' ? (valid ? reply(200, 'application/json', '{"ok":true,"events":[]}') : reply(401, 'application/json', '{"ok":false,"error":"invalid signature"}'))
        : path === '/api/v1/state' ? (valid ? reply(200, 'application/json', JSON.stringify({ me: { id: valid.id } })) : reply(401, 'application/json', '{"ok":false,"error":"malformed token"}'))
        : path === '/api/v1/action' ? reply(200, 'application/json', JSON.stringify({ ok: true, got: Buffer.concat(chunks).toString('utf8') }))
        : path === '/games/index.html' ? reply(200, 'text/html; charset=utf-8', '<html>birch</html>', { 'Set-Cookie': 'a=b', 'Content-Security-Policy': 'default-src *', 'Permissions-Policy': 'camera=()', 'Access-Control-Allow-Origin': '*', 'X-Frame-Options': 'DENY', 'ETag': '"v1"' })
        : reply(404, 'application/json', '{"error":"not found"}');
    });
  });
  return { server, seen };
}
module.exports = { SECRET, listen, close, send, fakeBird };
