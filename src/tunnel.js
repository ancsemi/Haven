// ═══════════════════════════════════════════════════════════
// Haven — Tunnel Manager (localtunnel / cloudflared)
// Exposes the Haven server over a public URL for remote access
// ═══════════════════════════════════════════════════════════

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./paths');

// ── cloudflared location ─────────────────────────────────────
// The Windows installer advertises "auto-downloads cloudflared", and until
// now nothing did: this module only ever spawned `cloudflared` from PATH, so
// every Cloudflare setup on a fresh Windows box ended in "binary not found
// in PATH". The binary is now looked for on PATH first, then in the data
// directory's bin/ folder, and fetched from the official GitHub release into
// that folder when neither has it. Downloads are best-effort and explained;
// a user can always drop the file in bin/ (or on PATH) by hand.
const BIN_DIR = path.join(DATA_DIR, 'bin');
const CLOUDFLARED_RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

// Asset name in the cloudflared release for this platform, or null when the
// release only ships an archive we would have to unpack (macOS).
function cloudflaredAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'linux') {
    const map = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
    return map[arch] ? `cloudflared-linux-${map[arch]}` : null;
  }
  return null;
}

function localCloudflaredPath() {
  return path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

function onPath(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
    return !!(r && r.status === 0);
  } catch { return false; }
}

// Resolve order: PATH, then <data>/bin. Returns the command to spawn or null.
function resolveCloudflared({ binDir = BIN_DIR, pathHas = onPath } = {}) {
  if (pathHas('cloudflared')) return 'cloudflared';
  const local = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  return null;
}

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'Haven' }, timeout: 30000 }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        return fetchToFile(new URL(resp.headers.location, url).href, dest, redirects + 1).then(resolve, reject);
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error(`HTTP ${resp.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      resp.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('download timed out')); });
  });
}

// Download the release binary into <data>/bin. Resolves to the binary path.
async function downloadCloudflared({ binDir = BIN_DIR, fetch = fetchToFile } = {}) {
  const asset = cloudflaredAssetName();
  if (!asset) {
    throw new Error(`no automatic cloudflared download for ${process.platform}/${process.arch}; install it yourself (macOS: brew install cloudflared) or put the binary in ${binDir}`);
  }
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const tmp = dest + '.part';
  console.log(`[tunnel] cloudflared not found, downloading ${asset} into ${binDir} ...`);
  try {
    await fetch(CLOUDFLARED_RELEASE + asset, tmp);
    fs.renameSync(tmp, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw new Error(`could not download cloudflared (${err.message}). Download ${asset} from github.com/cloudflare/cloudflared/releases and save it as ${dest}`);
  }
  console.log(`[tunnel] cloudflared ready at ${dest}`);
  return dest;
}

let active = null;
let status = { active: false, url: null, provider: null, error: null };
let starting = false;

function providerAvailable(provider) {
  if (provider === 'localtunnel') {
    try { require.resolve('localtunnel'); return true; } catch { return false; }
  }
  if (provider === 'cloudflared') return !!resolveCloudflared() || !!cloudflaredAssetName();
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
    if (!providerAvailable(provider)) {
      throw new Error(provider === 'localtunnel'
        ? 'localtunnel package not installed (run: npm install localtunnel)'
        : `cloudflared is not installed and cannot be downloaded for this platform; put the binary in ${BIN_DIR} or on PATH`);
    }

    if (provider === 'localtunnel') {
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

    // Cloudflared quick-tunnel — use HTTPS origin + skip cert verify for self-signed
    const origin = ssl ? `https://127.0.0.1:${port}` : `http://127.0.0.1:${port}`;
    const args = ['tunnel', '--url', origin, '--no-autoupdate'];
    if (ssl) args.push('--no-tls-verify');
    const cloudflaredCmd = resolveCloudflared() || await downloadCloudflared();
    const proc = spawn(cloudflaredCmd, args, {
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

module.exports = {
  startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup,
  // exported for tests and the installer
  cloudflaredAssetName, resolveCloudflared, downloadCloudflared, localCloudflaredPath, BIN_DIR
};
