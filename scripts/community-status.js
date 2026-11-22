#!/usr/bin/env node
'use strict';

// Checks the community server and writes what the homepage's status line
// shows (docs/index.html, "Community server" under the join button).
//
// Run every ten minutes by .github/workflows/community-status.yml, which
// keeps the result on the site-status branch. A visitor's browser cannot
// read a certificate, so it could only tell "reachable" from "not"; this
// says why: the certificate expired, it is not valid, the server does not
// answer, or it cannot be reached at all.
//
// It also sends a phone alert through ntfy (https://ntfy.sh) when the status
// changes: once when the server goes down, with the reason, and once when it
// is back. A down alert waits for two checks in a row, so one dropped
// connection does not page anyone; coming back is sent at once. The topic is
// the NTFY_TOPIC secret (whoever knows it can read the alerts, so it is never
// in the repo); without it no alert is sent. ALERT_TEST=true sends a test.
//
//   node scripts/community-status.js [out.json] [previous.json]
//
// HOST overrides the server (default community.haven-app.com).

const fs = require('fs');
const https = require('https');
const tls = require('tls');

const HOST = process.env.HOST || 'community.haven-app.com';
const OUT = process.argv[2] || 'status.json';
const PREV = process.argv[3] || null;
const TIMEOUT_MS = 15000;
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const ALERT_TEST = process.env.ALERT_TEST === 'true';
// Checks in a row a bad status needs before it alerts.
const DOWN_AFTER = 2;
// A certificate this close to its end gets a warning while still working.
const SOON_MS = 3 * 24 * 60 * 60 * 1000;

// The certificate as the server presents it, valid or not. `ca` adds to the
// usual trusted roots (for the chain check below).
function readCertificate(ca = null) {
  return new Promise((resolve) => {
    const opts = { host: HOST, port: 443, servername: HOST, rejectUnauthorized: false, timeout: TIMEOUT_MS };
    if (ca) opts.ca = [...tls.rootCertificates, ...ca];
    const sock = tls.connect(opts, () => {
      const cert = sock.getPeerCertificate();
      const issuersAt = cert && cert.infoAccess ? cert.infoAccess['CA Issuers - URI'] || [] : [];
      resolve({
        reached: true,
        authorized: sock.authorized,
        error: sock.authorizationError ? String(sock.authorizationError) : null,
        validTo: cert && cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: cert && cert.issuer ? (cert.issuer.O || cert.issuer.CN || null) : null,
        issuerUrl: issuersAt.find(u => /^https?:\/\//.test(u)) || null,
      });
      sock.end();
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ reached: false, error: 'timeout' }); });
    sock.on('error', (err) => resolve({ reached: false, error: err.code || err.message }));
  });
}

// A server that sends its own certificate without the issuer's (the chain's
// middle link) fails in strict apps, while most browsers fetch the missing
// link themselves and carry on. Fetch it the same way: if the certificate
// then checks out, the only fault is the incomplete chain.
async function chainOnlyMissing(cert) {
  if (cert.authorized || cert.error !== 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || !cert.issuerUrl) return false;
  // Up to three links: a new root (Let's Encrypt's Root YE, say) may need its
  // cross-signed copy from an older root before a trusted root is reached.
  try {
    const { X509Certificate } = require('crypto');
    const links = [];
    let url = cert.issuerUrl;
    for (let i = 0; i < 3 && url; i++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) break;
      const x = new X509Certificate(Buffer.from(await res.arrayBuffer()));
      links.push(x.toString());
      const next = (x.infoAccess || '').match(/CA Issuers - URI:(https?:\/\/\S+)/);
      url = next && next[1] !== url ? next[1] : null;
    }
    if (!links.length) return false;
    const again = await readCertificate(links);
    return again.reached && again.authorized;
  } catch (err) {
    console.warn('[chain] could not fetch the issuer certificate:', err.message);
    return false;
  }
}

// Haven's own health check, read even through a bad certificate, so an
// expired one can still say whether the server behind it is running.
function readHealth() {
  return new Promise((resolve) => {
    const req = https.get({ host: HOST, path: '/api/health', servername: HOST, rejectUnauthorized: false, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON: judged by the status code alone */ }
        resolve({ status: res.statusCode, online: !!(json && json.status === 'online'), name: json && typeof json.name === 'string' ? json.name.slice(0, 80) : null });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, online: false }); });
    req.on('error', () => resolve({ status: 0, online: false }));
  });
}

const day = (iso) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');

function judge(cert, health, now) {
  if (!cert.reached) {
    return { state: 'down', code: 'unreachable', message: "The community server can't be reached right now." };
  }
  // Only the chain's middle links missing: browsers fetch them and the Haven
  // apps carry them, so for the people who use the server it is online. The
  // code still says so, for anyone reading status.json.
  if (cert.chainOnlyMissing) {
    if (!health.online) return { state: 'down', code: 'not-answering', message: "The community server isn't answering right now." };
    return { state: 'ok', code: 'online-chain-incomplete', message: 'The community server is online.' };
  }
  if (!cert.authorized) {
    if (cert.error === 'CERT_HAS_EXPIRED') {
      return { state: 'down', code: 'cert-expired', message: `The community server's security certificate expired ${day(cert.validTo)}, so browsers won't connect until it's renewed.` };
    }
    return { state: 'down', code: 'cert-invalid', message: `The community server's security certificate isn't valid (${cert.error}), so browsers won't connect.` };
  }
  if (!health.online) {
    return { state: 'down', code: 'not-answering', message: "The community server isn't answering right now." };
  }
  if (cert.validTo && new Date(cert.validTo).getTime() - now < SOON_MS) {
    return { state: 'warn', code: 'cert-expiring', message: `The community server is online. Its security certificate runs out ${day(cert.validTo)}.` };
  }
  return { state: 'ok', code: 'online', message: 'The community server is online.' };
}

// One phone alert through ntfy. Errors are reported, never fatal: the status
// still gets published, and the next change tries again.
async function sendAlert({ title, message, priority, tags }) {
  if (!NTFY_TOPIC) { console.log('[alert] no NTFY_TOPIC set, not sent:', title); return false; }
  try {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: NTFY_TOPIC, title, message, priority, tags, click: 'https://haven-app.com/' }),
    });
    if (!res.ok) { console.warn('[alert] ntfy answered', res.status); return false; }
    console.log('[alert] sent:', title);
    return true;
  } catch (err) {
    console.warn('[alert] could not reach ntfy:', err.message);
    return false;
  }
}

function readPrevious() {
  if (!PREV) return null;
  try { return JSON.parse(fs.readFileSync(PREV, 'utf8')); } catch { return null; /* no earlier result yet */ }
}

async function main() {
  const now = Date.now();
  const cert = await readCertificate();
  cert.chainOnlyMissing = await chainOnlyMissing(cert);
  const health = cert.reached ? await readHealth() : { status: 0, online: false };
  const verdict = judge(cert, health, now);
  const prev = readPrevious();
  const same = !!(prev && prev.code === verdict.code);

  // "Since" carries over while the verdict stays the same. An expired
  // certificate has been down since the moment it ran out.
  let since = new Date(now).toISOString();
  if (verdict.code === 'cert-expired' && cert.validTo) since = cert.validTo;
  else if (same && typeof prev.since === 'string') since = prev.since;

  const out = {
    host: HOST,
    ...verdict,
    since,
    checkedAt: new Date(now).toISOString(),
    certificateExpires: cert.validTo || null,
    certificateIssuer: cert.issuer || null,
    // How many checks in a row have said this, and the status the last
    // alert was about (alerts go out when the two differ).
    streak: same && Number.isInteger(prev.streak) ? prev.streak + 1 : (same ? 2 : 1),
    alerted: prev && typeof prev.alerted === 'string' ? prev.alerted : 'online',
  };

  const settled = out.state === 'ok' || out.streak >= DOWN_AFTER;
  // Both kinds of online count as the same thing for alerts.
  const alertKey = (code) => (code === 'online-chain-incomplete' ? 'online' : code);
  if (alertKey(out.code) !== alertKey(out.alerted) && settled) {
    const back = out.state === 'ok';
    const sent = await sendAlert(back
      ? { title: 'Haven community server is back', message: out.message, priority: 3, tags: ['white_check_mark'] }
      : out.state === 'warn'
        ? { title: out.code === 'cert-expiring' ? 'Haven community server: certificate running out' : 'Haven community server is up, with a certificate problem', message: out.message, priority: 3, tags: ['hourglass'] }
        : { title: 'Haven community server is down', message: out.message, priority: 4, tags: ['warning'] });
    if (sent) out.alerted = out.code;
  }
  if (ALERT_TEST) {
    await sendAlert({ title: 'Haven status alerts are set up', message: `This is a test. Right now: ${out.message}`, priority: 3, tags: ['bell'] });
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`${out.state}: ${out.message}`);
}

main().catch((err) => {
  console.error('[community-status]', err);
  process.exit(1);
});
