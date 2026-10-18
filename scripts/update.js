'use strict';
// Updates this Haven install in place. Started by Update Now in Settings, Admin
// (src/routes/maintenance.js), which then exits so the files are free to replace.
//
//   node scripts/update.js git|release [--wait-pid N] [--port N] [--no-restart] [--early]
//
// git      git pull, for installs cloned from GitHub
// release  download the latest release from GitHub and copy it over this folder,
//          for installs made by Install Haven.bat, install.sh or a zip
//
// Then npm install, then Haven is started again (in its own window on Windows),
// unless --no-restart says a service manager (systemd, pm2) will do that.
// The data folder (database, uploads, .env) lives elsewhere and is never touched.
// Output goes to update.log in the data folder.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const releaseChannel = require('../src/releaseChannel');

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const waitPid = parseInt(opt('--wait-pid'), 10) || 0;
const port = parseInt(opt('--port'), 10) || 0;
const restart = !args.includes('--no-restart');
// Early access (Settings > Admin) also takes pre-releases (src/releaseChannel.js).
const early = args.includes('--early');

const log = (msg) => console.log(`[update ${new Date().toISOString()}] ${msg}`);

// Release archives hold the repo under one top folder. These paths in this
// install belong to it and not to the release, so they are never overwritten.
const KEEP = ['node_modules/', '.git/'];

async function downloadRelease() {
  const headers = { 'User-Agent': 'haven-updater', Accept: 'application/vnd.github+json' };
  const { tag_name: tag, zipball_url: url } = await releaseChannel.latestRelease({ early, headers });
  if (!url) throw new Error('the latest release has no source archive');
  log(`Downloading ${tag}`);
  const zip = await fetch(url, { headers: { 'User-Agent': 'haven-updater' } });
  if (!zip.ok) throw new Error(`download failed with ${zip.status}`);
  return { tag, data: Buffer.from(await zip.arrayBuffer()) };
}

// Copies every file of the archive over ROOT. Files the release no longer has
// are left in place; nothing loads a file that the new code stopped importing.
function unpackRelease(data) {
  // Loaded from this install's node_modules before npm install can change it.
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  let written = 0;
  for (const entry of new AdmZip(data).getEntries()) {
    if (entry.isDirectory) continue;
    const rel = entry.entryName.replace(/\\/g, '/').split('/').slice(1).join('/');
    if (!rel || KEEP.some(k => rel.startsWith(k))) continue;
    const dest = path.resolve(ROOT, rel);
    if (!dest.startsWith(ROOT + path.sep)) throw new Error(`archive path escapes the install folder: ${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    written++;
  }
  log(`Copied ${written} files into ${ROOT}`);
}

// Only ever called with the fixed commands below, never with outside input.
function run(command) {
  log(`> ${command}`);
  // shell: npm is a .cmd file on Windows, which Node only starts through a shell.
  const r = spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${command} exited with ${r.status}`);
}

async function waitForExit(pid) {
  for (let i = 0; i < 120; i++) {
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Haven (pid ${pid}) did not exit within a minute`);
}

function portInUse(p) {
  return new Promise(resolve => {
    const sock = net.connect({ port: p, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function startHaven() {
  if (port && await portInUse(port)) {
    log(`Port ${port} is already in use, so something else restarted Haven. Not starting a second copy.`);
    return;
  }
  if (IS_WIN) {
    // A new console window, like Start Haven.bat gives. /s plus verbatim
    // arguments keeps a folder name with spaces or "&" in one piece.
    const cmd = `"start "Haven" /D "${ROOT}" "${process.execPath}" server.js"`;
    spawn('cmd.exe', ['/d', '/s', '/c', cmd], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    // No terminal to open here, so the server writes to the same log.
    spawn(process.execPath, ['server.js'], { cwd: ROOT, detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
  }
  log('Started Haven');
}

async function main() {
  if (mode !== 'git' && mode !== 'release') throw new Error(`unknown update mode "${mode}"`);
  log(`Updating ${ROOT} (${mode})`);

  // Download while Haven is still up, so a failed download costs no downtime.
  let release = null;
  let ok = true;
  if (mode === 'release') {
    try { release = await downloadRelease(); } catch (err) { log(`Update failed: ${err.message}`); ok = false; }
  }
  if (waitPid) await waitForExit(waitPid);

  if (ok) {
    try {
      if (mode === 'git') run('git pull --ff-only');
      else unpackRelease(release.data);
      run('npm install --no-audit --no-fund');
      log(release ? `Updated to ${release.tag}` : 'Updated');
    } catch (err) {
      log(`Update failed: ${err.message}`);
      ok = false;
    }
  }
  // Haven comes back either way: updated, or as it was if the update failed.
  if (restart) await startHaven();
  if (!ok) process.exitCode = 1;
}

main().catch(err => {
  log(`Update failed: ${err.message}`);
  process.exitCode = 1;
});
