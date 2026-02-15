const { spawn, spawnSync } = require('child_process');

let active = null;
let status = { active: false, url: null, provider: null, error: null };
let starting = false;

function providerAvailable(provider) {
  if (provider === 'localtunnel') {
    try { require.resolve('localtunnel'); return true; } catch { return false; }
  }
  if (provider === 'cloudflared') {
    try {
      const result = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', windowsHide: true });
      return result && result.status === 0;
    } catch {
      return false;
    }
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
  } catch {}
  status = { ...status, active: false, url: null };
  return true;
}

async function startTunnel(port, provider = 'localtunnel') {
  if (starting) return getTunnelStatus();
  starting = true;
  status = { ...status, error: null, provider };
  await stopTunnel();
  try {
    if (!providerAvailable(provider)) throw new Error(provider === 'localtunnel' ? 'localtunnel package not installed' : 'cloudflared binary not available');
    if (provider === 'localtunnel') {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port });
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
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    active = { type: 'cloudflared', ref: proc };
    const url = await new Promise((resolve, reject) => {
      let done = false;
      const finalize = (val, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      const parseLine = (data) => {
        const line = data.toString();
        const match = line.match(/https?:\/\/[^\s]+\.trycloudflare\.com/);
        if (match) finalize(match[0]);
      };
      const timer = setTimeout(() => finalize(null, new Error('Timed out waiting for cloudflared URL')), 30000);
      proc.stdout.on('data', parseLine);
      proc.stderr.on('data', parseLine);
      proc.on('error', (err) => finalize(null, err));
      proc.on('close', () => {
        if (!done) finalize(null, new Error('cloudflared exited before URL was ready'));
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
  const cleanup = () => { try { stopTunnel(); } catch {} };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

module.exports = { startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup };