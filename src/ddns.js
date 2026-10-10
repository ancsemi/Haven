// ═══════════════════════════════════════════════════════════
// Haven: Dynamic DNS auto-updater
//
// Keeps a DNS record pointed at this server's current public IP
// so the host's domain (e.g. anchaven.duckdns.org) never goes
// stale when the ISP rotates your IP.
//
// Supported providers:
//   - duckdns     (DDNS_PROVIDER=duckdns)
//   - cloudflare  (DDNS_PROVIDER=cloudflare)
//   - generic     (DDNS_PROVIDER=generic: GET DDNS_URL)
//
// DuckDNS env:
//   DDNS_PROVIDER=duckdns
//   DDNS_DOMAINS=anchaven                 (one or comma-separated, no .duckdns.org)
//   DDNS_TOKEN=xxxxxxxx-xxxx-...          (from https://www.duckdns.org/)
//   DDNS_INTERVAL_MINUTES=5               (optional, default 5)
//
// Cloudflare env (one A record per run):
//   DDNS_PROVIDER=cloudflare
//   DDNS_CF_API_TOKEN=...                 (token with Zone:DNS:Edit on the zone)
//   DDNS_CF_ZONE_ID=...
//   DDNS_CF_RECORD_ID=...
//   DDNS_CF_RECORD_NAME=haven.example.com
//   DDNS_INTERVAL_MINUTES=5
//
// Generic env (anything that takes the IP in the URL):
//   DDNS_PROVIDER=generic
//   DDNS_URL=https://example.com/nic/update?hostname=h&myip={ip}
//      ({ip} is replaced; if omitted, the URL is hit as-is and the provider
//       infers the IP from the request source)
// ═══════════════════════════════════════════════════════════

const https = require('https');
const http = require('http');
const { agentFor } = require('./outboundProxy');

let timer = null;
let lastResult = {
  enabled: false,
  provider: null,
  ok: null,
  ip: null,
  message: null,
  updatedAt: null
};

function _log(msg) {
  console.log(`[ddns] ${msg}`);
}

function _err(msg) {
  console.warn(`[ddns] ${msg}`);
}

// Fetch this machine's current public IP from a few independent sources.
// Returns null if all probes fail (e.g. fully offline).
function _detectPublicIp() {
  const sources = [
    'https://api.ipify.org',
    'https://ipv4.icanhazip.com',
    'https://checkip.amazonaws.com'
  ];
  return new Promise((resolve) => {
    let remaining = sources.length;
    let resolved = false;
    const tryOne = (url) => {
      const proto = url.startsWith('https') ? https : http;
      const req = proto.get(url, { timeout: 5000, agent: agentFor(url) }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (resolved) return;
          const ip = (data || '').trim();
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
            resolved = true;
            resolve(ip);
          } else if (--remaining === 0) {
            resolve(null);
          }
        });
      });
      req.on('error', () => { if (--remaining === 0 && !resolved) resolve(null); });
      req.on('timeout', () => { try { req.destroy(); } catch { /* already closed; the error handler resolves */ } });
    };
    sources.forEach(tryOne);
  });
}

function _httpGetText(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: 10000, agent: agentFor(url) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* already closed; the error handler rejects */ } });
  });
}

function _httpRequestJson(url, opts, payload) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request(url, { timeout: 10000, agent: agentFor(url), ...opts }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(data || 'null') }); }
        catch { resolve({ status: res.statusCode || 0, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* already closed; the error handler rejects */ } });
    if (payload) req.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.end();
  });
}

async function _updateDuckDns(ip) {
  const domains = (process.env.DDNS_DOMAINS || '').trim();
  const token = (process.env.DDNS_TOKEN || '').trim();
  if (!domains || !token) {
    throw new Error('DDNS_DOMAINS and DDNS_TOKEN are required for duckdns');
  }
  // DuckDNS auto-detects the source IP when the ip param is empty, but we
  // pass our own detected IP so the result is deterministic and logs match.
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domains)}&token=${encodeURIComponent(token)}&ip=${encodeURIComponent(ip || '')}`;
  const { status, body } = await _httpGetText(url);
  const text = (body || '').trim();
  if (status === 200 && text === 'OK') return { ok: true, message: `DuckDNS updated for ${domains}` };
  return { ok: false, message: `DuckDNS rejected update (HTTP ${status}, body: ${text || '<empty>'}). Check DDNS_TOKEN and DDNS_DOMAINS` };
}

async function _updateCloudflare(ip) {
  const apiToken = (process.env.DDNS_CF_API_TOKEN || '').trim();
  const zoneId = (process.env.DDNS_CF_ZONE_ID || '').trim();
  const recordId = (process.env.DDNS_CF_RECORD_ID || '').trim();
  const recordName = (process.env.DDNS_CF_RECORD_NAME || '').trim();
  if (!apiToken || !zoneId || !recordId || !recordName) {
    throw new Error('Cloudflare requires DDNS_CF_API_TOKEN, DDNS_CF_ZONE_ID, DDNS_CF_RECORD_ID, DDNS_CF_RECORD_NAME');
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`;
  const { status, body } = await _httpRequestJson(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    }
  }, { type: 'A', name: recordName, content: ip, ttl: 60, proxied: false });
  if (status === 200 && body && body.success) return { ok: true, message: `Cloudflare ${recordName} → ${ip}` };
  const msg = body && body.errors ? JSON.stringify(body.errors).slice(0, 200) : `HTTP ${status}`;
  return { ok: false, message: `Cloudflare update failed: ${msg}` };
}

async function _updateGeneric(ip) {
  let url = (process.env.DDNS_URL || '').trim();
  if (!url) throw new Error('DDNS_URL is required for provider=generic');
  url = url.replace('{ip}', encodeURIComponent(ip || ''));
  const { status, body } = await _httpGetText(url);
  if (status >= 200 && status < 300) return { ok: true, message: `Generic provider replied HTTP ${status}` };
  return { ok: false, message: `Generic provider failed (HTTP ${status}, body: ${(body || '').slice(0, 120)})` };
}

async function _runOnce() {
  const provider = (process.env.DDNS_PROVIDER || '').trim().toLowerCase();
  if (!provider) return; // disabled
  try {
    const ip = await _detectPublicIp();
    if (!ip) {
      lastResult = { enabled: true, provider, ok: false, ip: null,
        message: 'Could not determine public IP (all probes failed, offline?)',
        updatedAt: new Date().toISOString() };
      _err(lastResult.message);
      return;
    }
    let result;
    if (provider === 'duckdns') result = await _updateDuckDns(ip);
    else if (provider === 'cloudflare') result = await _updateCloudflare(ip);
    else if (provider === 'generic') result = await _updateGeneric(ip);
    else result = { ok: false, message: `Unknown DDNS_PROVIDER: ${provider}` };
    lastResult = { enabled: true, provider, ok: result.ok, ip,
      message: result.message, updatedAt: new Date().toISOString() };
    (result.ok ? _log : _err)(`${result.message} (ip=${ip})`);
  } catch (err) {
    lastResult = { enabled: true, provider, ok: false, ip: null,
      message: err && err.message ? err.message : String(err),
      updatedAt: new Date().toISOString() };
    _err(lastResult.message);
  }
}

function startDdns() {
  const provider = (process.env.DDNS_PROVIDER || '').trim().toLowerCase();
  if (!provider) {
    lastResult = { enabled: false, provider: null, ok: null, ip: null,
      message: 'DDNS_PROVIDER not set, dynamic DNS disabled', updatedAt: null };
    return;
  }
  const minutes = Math.max(1, parseInt(process.env.DDNS_INTERVAL_MINUTES || '5', 10) || 5);
  _log(`Dynamic DNS enabled (provider=${provider}, every ${minutes} min)`);
  // Run once on boot, then on interval. Don't await; server boot continues.
  _runOnce();
  if (timer) clearInterval(timer);
  timer = setInterval(_runOnce, minutes * 60 * 1000);
  if (timer.unref) timer.unref();
}

function stopDdns() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getDdnsStatus() {
  return { ...lastResult };
}

// Force an immediate run (e.g. exposed via admin REST endpoint).
async function triggerDdnsNow() {
  await _runOnce();
  return getDdnsStatus();
}

module.exports = { startDdns, stopDdns, getDdnsStatus, triggerDdnsNow };
