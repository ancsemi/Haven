// ═══════════════════════════════════════════════════════════
// Haven — Tunnel Manager (localtunnel / cloudflared)
// Exposes the Haven server over a public URL for remote access
// ═══════════════════════════════════════════════════════════

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let active = null;
let status = { active: false, url: null, provider: null, error: null };
let starting = false;

// ── Cloudflared auto-download ────────────────────────────
const BIN_DIR = path.join(__dirname, '..', 'bin');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const CF_BINARY = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
const CF_LOCAL_PATH = path.join(BIN_DIR, CF_BINARY);

function getCloudflaredDownloadUrl() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (IS_WIN) return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
  if (IS_MAC) return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
}

function cloudflaredPath() {
  // 1. System-wide install
  try {
    const result = spawnSync(IS_WIN ? 'where' : 'which', ['cloudflared'], { stdio: 'pipe', windowsHide: true });
    if (result && result.status === 0) {
      const systemPath = result.stdout.toString().trim().split(/\r?\n/)[0];
      if (systemPath) return systemPath;
    }
  } catch {}
  // 2. Local bin/ copy
  if (fs.existsSync(CF_LOCAL_PATH)) return CF_LOCAL_PATH;
  return null;
}

/** Download a URL following redirects, returning a Buffer */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'Haven-Server' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Auto-download cloudflared binary if not already present */
async function ensureCloudflared() {
  const existing = cloudflaredPath();
  if (existing) return existing;

  console.log('☁️  Cloudflared not found — downloading automatically...');
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const url = getCloudflaredDownloadUrl();
  const data = await downloadBuffer(url);

  if (IS_MAC && url.endsWith('.tgz')) {
    // Extract tgz on macOS
    const tgzPath = path.join(BIN_DIR, 'cloudflared.tgz');
    fs.writeFileSync(tgzPath, data);
    execFileSync('tar', ['-xzf', tgzPath, '-C', BIN_DIR], { windowsHide: true });
    try { fs.unlinkSync(tgzPath); } catch {}
  } else {
    fs.writeFileSync(CF_LOCAL_PATH, data);
  }

  // Make executable on Unix
  if (!IS_WIN) {
    try { fs.chmodSync(CF_LOCAL_PATH, 0o755); } catch {}
  }

  // Verify it runs
  try {
    const check = spawnSync(CF_LOCAL_PATH, ['--version'], { stdio: 'pipe', windowsHide: true, timeout: 10000 });
    if (check.status !== 0) throw new Error('Binary test failed');
  } catch (err) {
    try { fs.unlinkSync(CF_LOCAL_PATH); } catch {}
    throw new Error(`Downloaded cloudflared but it failed to run: ${err.message}`);
  }

  console.log('✅ Cloudflared installed to bin/cloudflared');
  return CF_LOCAL_PATH;
}

function providerAvailable(provider) {
  if (provider === 'localtunnel') {
    try { require.resolve('localtunnel'); return true; } catch { return false; }
  }
  if (provider === 'cloudflared') {
    return !!cloudflaredPath();
  }
  return false;
}

function getTunnelStatus() {
  return {
    ...status,
    starting,
    available: {
      localtunnel: providerAvailable('localtunnel'),
      cloudflared: providerAvailable('cloudflared')
    }
  };
}

async function stopTunnel() {
  if (!active) {
    status = { ...status, active: false, url: null };
    return true;
  }
  const current = active;
  active = null;
  try {
    if (current.type === 'localtunnel' && current.ref?.close) await current.ref.close();
    if (current.type === 'cloudflared' && current.ref && !current.ref.killed) current.ref.kill();
  } catch { /* cleanup errors are non-critical */ }
  status = { ...status, active: false, url: null };
  return true;
}

async function startTunnel(port, provider = 'localtunnel', ssl = false) {
  if (starting) return getTunnelStatus();
  starting = true;
  status = { ...status, error: null, provider };
  await stopTunnel();
  try {
    if (provider === 'localtunnel') {
      if (!providerAvailable('localtunnel')) throw new Error('localtunnel package not installed — run: npm install localtunnel');
      const localtunnel = require('localtunnel');
      const opts = { port };
      if (ssl) { opts.local_https = true; opts.allow_invalid_cert = true; }
      const tunnel = await localtunnel(opts);
      active = { type: 'localtunnel', ref: tunnel };
      status = { active: true, url: tunnel.url, provider, error: null };
      tunnel.on('close', () => {
        if (active?.ref === tunnel) {
          active = null;
          status = { ...status, active: false, url: null };
        }
      });
      tunnel.on('error', (err) => {
        status = { ...status, active: false, url: null, error: err?.message || 'Tunnel error' };
      });
      return getTunnelStatus();
    }

    // Auto-download cloudflared if not available
    const cfPath = await ensureCloudflared();
    // Cloudflared quick-tunnel — use HTTPS origin + skip cert verify for self-signed
    const origin = ssl ? `https://127.0.0.1:${port}` : `http://127.0.0.1:${port}`;
    const args = ['tunnel', '--url', origin, '--no-autoupdate'];
    if (ssl) args.push('--no-tls-verify');
    const proc = spawn(cfPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    active = { type: 'cloudflared', ref: proc };

    const url = await new Promise((resolve, reject) => {
      let done = false;
      let stderrLog = ''; // collect stderr for better error messages
      const finalize = (val, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      const parseLine = (data) => {
        const line = data.toString();
        // Match cloudflared tunnel URLs — both trycloudflare.com and cfargotunnel.com
        const match = line.match(/https?:\/\/[a-zA-Z0-9._-]+\.(?:trycloudflare|cfargotunnel)\.com\b/);
        if (match) return finalize(match[0]);
        // Broader fallback — but exclude known non-tunnel URLs (cloudflare.com, github.com, etc.)
        const broader = line.match(/https:\/\/[a-zA-Z0-9]+-[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (broader && !broader[0].includes('127.0.0.1') && !broader[0].includes('localhost')
            && !broader[0].includes('www.cloudflare.com') && !broader[0].includes('github.com')
            && !broader[0].includes('developers.cloudflare.com')) {
          finalize(broader[0]);
        }
      };
      // Increased timeout to 90s — cloudflared can be slow on first launch or slow connections
      const timer = setTimeout(() => {
        const hint = stderrLog.includes('failed to connect')
          ? ' (cloudflared could not reach your local server — is it running?)'
          : stderrLog.includes('ERR')
            ? ` (cloudflared error: ${stderrLog.split('ERR').pop().trim().slice(0, 100)})`
            : ' (cloudflared took too long — check your internet connection)';
        finalize(null, new Error('Timed out waiting for cloudflared URL' + hint));
      }, 90000);
      proc.stdout.on('data', parseLine);
      proc.stderr.on('data', (data) => {
        stderrLog += data.toString();
        parseLine(data);
      });
      proc.on('error', (err) => finalize(null, new Error(`cloudflared failed to start: ${err.message}`)));
      proc.on('close', (code) => {
        if (!done) {
          const reason = stderrLog.includes('ERR')
            ? stderrLog.split('ERR').pop().trim().slice(0, 150)
            : `exit code ${code}`;
          finalize(null, new Error(`cloudflared exited before URL was ready (${reason})`));
        }
        if (active?.ref === proc) {
          active = null;
          status = { ...status, active: false, url: null };
        }
      });
    });

    status = { active: true, url, provider, error: null };
    return getTunnelStatus();
  } catch (err) {
    status = { active: false, url: null, provider, error: err?.message || 'Failed to start tunnel' };
    await stopTunnel();
    return getTunnelStatus();
  } finally {
    starting = false;
  }
}

let hooked = false;
function registerProcessCleanup() {
  if (hooked) return;
  hooked = true;
  const cleanup = () => { try { stopTunnel(); } catch { /* exit cleanup */ } };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

module.exports = { startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup, ensureCloudflared, providerAvailable };
