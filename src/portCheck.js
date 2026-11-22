'use strict';
const https = require('https');
const PORTCHECKER_URL = 'https://portchecker.io/api/v1/query';
const externalPort = (publicUrl, internalPort) => { try { const u = new URL(publicUrl); return u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : parseInt(internalPort, 10); } catch { return parseInt(internalPort, 10); } };
const parsePortchecker = (result, port) => {
  const list = result && typeof result === 'object' && result.error !== true ? (Array.isArray(result.check) ? result.check : Array.isArray(result.ports) ? result.ports : null) : null;
  const status = list?.find(p => parseInt(p?.port, 10) === parseInt(port, 10))?.status;
  const word = typeof status === 'string' ? status.toLowerCase() : '';
  return typeof status === 'boolean' ? status : word === 'open' ? true : word === 'closed' ? false : null;
};
const queryPortchecker = (host, port, { agentFor, request = https.request, timeout = 10000 } = {}) => new Promise((resolve) => {
  const body = JSON.stringify({ host, ports: [parseInt(port, 10)] });
  let req;
  try {
    req = request(PORTCHECKER_URL, { method: 'POST', timeout, agent: agentFor ? agentFor(PORTCHECKER_URL) : undefined, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (resp) => {
      let data = '';
      resp.on('error', () => resolve(null));
      resp.on('aborted', () => resolve(null));
      resp.on('data', chunk => { data += chunk; data.length > 70000 && (req.destroy(), resolve(null)); });
      resp.on('end', () => { try { resolve(resp.statusCode >= 200 && resp.statusCode < 300 ? parsePortchecker(JSON.parse(data), port) : null); } catch { resolve(null); } });
    });
  } catch { return resolve(null); }
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.end(body);
});
module.exports = { PORTCHECKER_URL, externalPort, parsePortchecker, queryPortchecker };
