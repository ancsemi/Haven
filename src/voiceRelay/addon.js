'use strict';
/**
 * The built-in relay's media engine (mediasoup) is not part of a normal Haven
 * install: it downloads a platform-specific program of about 10 MB, and most
 * servers never need it. The admin installs it from Large Server Setup, and
 * it goes into the data folder (addons/voice-relay) rather than the program
 * folder, so Haven updates leave it alone and a Docker volume keeps it.
 *
 * A developer who has mediasoup in Haven's own node_modules gets that one.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('../paths');

// The mediasoup version this code is written and tested against.
const MEDIASOUP_VERSION = '3.27.1';
const ADDON_DIR = path.join(DATA_DIR, 'addons', 'voice-relay');
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

let cached = null;
let installing = null;
let loadErrorLogged = false;

/** mediasoup if it is installed anywhere we look, else null. */
function loadMediasoup() {
  if (cached) return cached;
  for (const id of ['mediasoup', path.join(ADDON_DIR, 'node_modules', 'mediasoup')]) {
    try {
      cached = require(id);
      return cached;
    } catch (err) {
      // Not installed is the normal answer. Installed but unloadable (for
      // example built for another Node version) is worth saying, once.
      if (err.code !== 'MODULE_NOT_FOUND' && !loadErrorLogged) {
        loadErrorLogged = true;
        console.warn('[voice-relay] mediasoup is installed but failed to load:', err.message);
      }
    }
  }
  return null;
}

/** npm's own script next to this Node, so no shell or PATH lookup is needed. */
function findNpmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),            // Windows
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux, macOS
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ];
  return candidates.find(p => p && /npm-cli\.js$/.test(p) && fs.existsSync(p)) || null;
}

const clean = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '').trim();

// mediasoup's install log, turned into steps an admin can follow.
function friendlyStep(line) {
  if (/workerPrebuildTarUrl/i.test(line)) return 'Downloading the relay from GitHub...';
  if (/got mediasoup-worker prebuilt binary/i.test(line)) return 'Downloaded. Checking it runs on this server...';
  if (/valid for current host/i.test(line) && !/not valid/i.test(line)) return 'It runs here. Finishing up...';
  if (/building it locally|not valid for current host/i.test(line)) return 'No ready-made build for this system; trying to build it here, which can take a while...';
  if (/ERR!/.test(line)) return line.replace(/^npm (ERR!|error)\s*/i, '');
  return null;
}

/**
 * Installs mediasoup into the data folder. `onLine` gets progress lines worth
 * showing the admin. Resolves { ok } or { error }.
 */
function install(onLine = () => {}) {
  if (loadMediasoup()) return Promise.resolve({ ok: true, already: true });
  if (installing) return installing;
  installing = new Promise((resolve) => {
    const npmCli = findNpmCli();
    if (!npmCli) {
      resolve({ error: 'npm was not found next to Node.js on this server, so the relay cannot be installed from here.' });
      return;
    }
    try {
      fs.mkdirSync(ADDON_DIR, { recursive: true });
      fs.writeFileSync(path.join(ADDON_DIR, 'package.json'), JSON.stringify({
        name: 'haven-voice-relay',
        private: true,
        description: 'The media engine for Haven\'s built-in voice relay. Installed from Large Server Setup.',
        dependencies: { mediasoup: MEDIASOUP_VERSION },
        // Newer npm asks for install scripts to be approved; mediasoup's
        // fetches its prebuilt media worker.
        allowScripts: { [`mediasoup@${MEDIASOUP_VERSION}`]: true },
      }, null, 2) + '\n');
    } catch (err) {
      resolve({ error: `Could not write to the data folder: ${err.message}` });
      return;
    }

    onLine('Downloading the relay (about 10 MB)...');
    const child = spawn(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts'], {
      cwd: ADDON_DIR,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      windowsHide: true,
    });
    const tail = [];
    const take = (chunk) => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = clean(raw);
        if (!line) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        const step = friendlyStep(line);
        if (step) onLine(step);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* installer already exited */ } }, INSTALL_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && loadMediasoup()) return resolve({ ok: true });
      const why = tail.filter(l => /ERR!|error|failed|not supported|valid for current host/i.test(l)).slice(-3).join(' | ');
      resolve({ error: why || `The install stopped (exit code ${code}).` });
    });
  }).finally(() => { installing = null; });
  return installing;
}

module.exports = { loadMediasoup, install, isInstalling: () => !!installing, MEDIASOUP_VERSION, ADDON_DIR };
