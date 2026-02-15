let activeTunnel = null;
let tunnelUrl = null;
let tunnelProvider = null;
async function startTunnel(port, provider = 'localtunnel') {
  await stopTunnel();
  tunnelProvider = provider;
  try {
    if (provider === 'cloudflared') {
      const { spawn } = require('child_process');
      return new Promise((resolve) => {
        const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        activeTunnel = proc;
        let resolved = false;
        const handler = (data) => {
          const line = data.toString();
          const match = line.match(/https?:\/\/[^\s]+\.trycloudflare\.com/);
          if (match && !resolved) {
            resolved = true;
            tunnelUrl = match[0];
            resolve(tunnelUrl);
          }
        };
        proc.stdout.on('data', handler);
        proc.stderr.on('data', handler);
        proc.on('error', () => { activeTunnel = null; resolve(null); });
        proc.on('close', () => { activeTunnel = null; tunnelUrl = null; });
        setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 30000);
      });
    }
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port });
    activeTunnel = tunnel;
    tunnelUrl = tunnel.url;
    tunnel.on('close', () => { activeTunnel = null; tunnelUrl = null; });
    tunnel.on('error', () => { activeTunnel = null; tunnelUrl = null; });
    return tunnelUrl;
  } catch (err) {
    console.error('Tunnel start failed:', err.message);
    return null;
  }
}
async function stopTunnel() {
  if (!activeTunnel) return;
  try {
    activeTunnel.close ? activeTunnel.close() : activeTunnel.kill ? activeTunnel.kill() : null;
  } catch {}
  activeTunnel = null;
  tunnelUrl = null;
}
function getTunnelStatus() {
  return { active: !!activeTunnel, url: tunnelUrl, provider: tunnelProvider };
}
module.exports = { startTunnel, stopTunnel, getTunnelStatus };
