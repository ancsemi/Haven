'use strict';

// PostgreSQL's client is an on-demand add-on, like the S3 library. Selecting
// PostgreSQL with HAVEN_DATABASE_URL installs the exact versions pinned in
// addons/postgres into DATA_DIR/addons/postgres, with install scripts off.
// Later starts reuse that copy; a changed lockfile installs the new pins.
// Normal Haven installs and Docker images never download the pg client.
//
// This packaging stays after the migration. Only the query-only startup
// guard and synchronous SQLite compatibility bridge are temporary.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const { DATA_DIR } = require('../paths');

const PINNED_DIR = path.join(__dirname, '..', '..', 'addons', 'postgres');
const ADDON_DIR = path.join(DATA_DIR, 'addons', 'postgres');
const FILES = ['package.json', 'package-lock.json'];

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // not there yet: counts as not installed
  }
}

// Installed, and at the versions this Haven pins.
function installed() {
  if (read(path.join(PINNED_DIR, 'package-lock.json')) !== read(path.join(ADDON_DIR, 'package-lock.json'))) return false;
  return fs.existsSync(path.join(ADDON_DIR, 'node_modules', 'pg', 'package.json'));
}

// npm comes with Node. Next to the node binary first, so a server started
// from a shortcut without npm on its PATH still finds it.
function npmCommand() {
  const bundled = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(p => fs.existsSync(p));
  if (bundled) return { cmd: process.execPath, pre: [bundled], shell: false };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', pre: [], shell: process.platform === 'win32' };
}

function manualSteps() {
  return `copy ${path.join(PINNED_DIR, 'package*.json')} into ${ADDON_DIR}, then run "npm ci --omit=dev --ignore-scripts" there`;
}

function install() {
  console.log(`PostgreSQL is selected: installing the pg add-on into ${ADDON_DIR} (one time).`);
  fs.mkdirSync(ADDON_DIR, { recursive: true });
  fs.rmSync(path.join(ADDON_DIR, 'node_modules'), { recursive: true, force: true });
  for (const f of FILES) fs.copyFileSync(path.join(PINNED_DIR, f), path.join(ADDON_DIR, f));
  const { cmd, pre, shell } = npmCommand();
  const r = spawnSync(cmd, [...pre, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: ADDON_DIR, encoding: 'utf8', shell, windowsHide: true, timeout: 10 * 60 * 1000,
  });
  if (r.error || r.status !== 0) {
    // Leave no lockfile behind, so the next start tries again.
    fs.rmSync(path.join(ADDON_DIR, 'package-lock.json'), { force: true });
    const why = (r.error && r.error.message) || String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(`Could not install the PostgreSQL add-on (${why || 'npm failed'}). Check this server can reach registry.npmjs.org, or ${manualSteps()}.`);
  }
  console.log('PostgreSQL add-on installed.');
}

let pg = null;

/** The PostgreSQL client, installed first if needed. Throws when it cannot be. */
function loadPg() {
  if (pg) return pg;
  if (!installed()) install();
  const req = createRequire(path.join(ADDON_DIR, 'package.json'));
  pg = req('pg');
  return pg;
}

module.exports = { loadPg, ADDON_DIR, PINNED_DIR };
