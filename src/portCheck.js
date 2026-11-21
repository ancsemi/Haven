'use strict';

// Internet Access check (#5923). portchecker.io answers 405 to the old
// GET /api/v1/query?host=&ports=, so the query is a JSON POST now:
//   POST /api/v1/query {"host": "...", "ports": [443]}
//   -> {"error": false, "check": [{"port": 443, "status": true}], "host": "..."}
// Older responses used {"ports": [{"port", "status": "open"}]}; both are read.

const https = require('https');

const PORTCHECKER_URL = 'https://portchecker.io/api/v1/query';

// The port people reach from outside. Behind a reverse proxy that is the
// PUBLIC_URL's port (443 for https, 80 for http), not the internal PORT.
function externalPort(publicUrl, internalPort) {
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.port) return parseInt(u.port, 10);
      if (u.protocol === 'https:') return 443;
      if (u.protocol === 'http:') return 80;
    } catch { /* not a URL: fall through to the internal port */ }
  }
  return parseInt(internalPort, 10);
}

// true / false when the service gave a verdict for this port, null when it
// did not (error reply, unknown shape): a failed check is not "unreachable".
function parsePortchecker(result, port) {
  if (!result || typeof result !== 'object' || result.error === true) return null;
  const want = parseInt(port, 10);
  const list = Array.isArray(result.check) ? result.check : Array.isArray(result.ports) ? result.ports : null;
  const entry = list?.find(p => parseInt(p?.port, 10) === want);
  if (!entry) return null;
  if (typeof entry.status === 'boolean') return entry.status;
  if (typeof entry.status === 'string') return entry.status.toLowerCase() === 'open';
  return null;
}

// Resolves true / false, or null when the check itself failed (non-2xx,
// network error, timeout, unreadable body).
function queryPortchecker(host, port, { agentFor, request = https.request, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ host, ports: [parseInt(port, 10)] });
    let req;
    try {
      req = request(PORTCHECKER_URL, {
        method: 'POST',
        timeout,
        agent: agentFor ? agentFor(PORTCHECKER_URL) : undefined,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => {
        let data = '';
        resp.on('data', chunk => { data += chunk; });
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) return resolve(null);
          try { resolve(parsePortchecker(JSON.parse(data), port)); } catch { resolve(null); }
        });
      });
    } catch { return resolve(null); }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

module.exports = { PORTCHECKER_URL, externalPort, parsePortchecker, queryPortchecker };
