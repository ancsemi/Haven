'use strict';
/**
 * Works out this server's public IPv4 address with one STUN request (the same
 * kind of request browsers make for voice), so the voice relay can tell
 * people where to connect without the admin having to look it up.
 */

const dgram = require('dgram');
const crypto = require('crypto');

const DEFAULT_SERVERS = ['stun.l.google.com:19302', 'stun.cloudflare.com:3478'];
const MAGIC = 0x2112a442;

/** "stun:host:port" / "host:port" / "host" -> { host, port } */
function parseStun(url) {
  const m = /^(?:stuns?:)?\/*\[?([^\]\s/?]+?)\]?(?::(\d+))?(?:[/?].*)?$/i.exec(String(url || '').trim());
  if (!m) return null;
  return { host: m[1], port: parseInt(m[2], 10) || 3478 };
}

/** Reads the address out of a STUN binding response, or null. */
function parseResponse(buf, txId) {
  if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101) return null;
  if (buf.readUInt32BE(4) !== MAGIC || !buf.subarray(8, 20).equals(txId)) return null;
  let off = 20;
  const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
  let mapped = null;
  while (off + 4 <= end) {
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    const val = buf.subarray(off + 4, off + 4 + len);
    if (val.length >= 8 && val[1] === 0x01) {
      if (type === 0x0020) {
        const ip = (val.readUInt32BE(4) ^ MAGIC) >>> 0;
        return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
      }
      if (type === 0x0001) mapped = [...val.subarray(4, 8)].join('.');
    }
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return mapped;
}

function ask({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const txId = crypto.randomBytes(12);
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(MAGIC, 4);
    txId.copy(req, 8);
    const done = (ip) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve(ip); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('error', () => done(null));
    sock.on('message', (msg) => { const ip = parseResponse(msg, txId); if (ip) done(ip); });
    sock.send(req, port, host, (err) => { if (err) done(null); });
  });
}

/** The public IPv4 address, trying each STUN server in turn. */
async function detectPublicIp(servers = [], timeoutMs = 2500) {
  const list = [...servers, ...DEFAULT_SERVERS].map(parseStun).filter(Boolean);
  for (const s of list) {
    const ip = await ask(s, timeoutMs);
    if (ip) return ip;
  }
  return null;
}

module.exports = { detectPublicIp, parseStun, parseResponse };
