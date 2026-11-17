'use strict';

// The S3 add-on: Amazon's S3 library (@aws-sdk), which Haven needs only when
// external storage is switched on (HAVEN_EXTERNAL_STORAGE=true).
//
// It is not one of Haven's own dependencies, so installing or updating Haven,
// and the Docker image, never download it. A server whose admin has not
// turned S3 on fetches nothing from Amazon or for Amazon.
//
// The first start with S3 on installs it into the data folder
// (data/addons/s3), at the exact versions pinned in the repo
// (addons/s3/package-lock.json), with package install scripts switched off.
// Later starts use that copy. A Haven update that pins other versions brings
// a new lockfile, and the next start installs those.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const { DATA_DIR } = require('../paths');

const PINNED_DIR = path.join(__dirname, '..', '..', 'addons', 's3');
const ADDON_DIR = path.join(DATA_DIR, 'addons', 's3');
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
  return fs.existsSync(path.join(ADDON_DIR, 'node_modules', '@aws-sdk', 'client-s3', 'package.json'));
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
  console.log(`📦 External storage is on: installing the S3 add-on into ${ADDON_DIR} (one time).`);
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
    throw new Error(`Could not install the S3 add-on (${why || 'npm failed'}). Check this server can reach registry.npmjs.org, or ${manualSteps()}.`);
  }
  console.log('📦 S3 add-on installed.');
}

let sdk = null;

/** The S3 library, installed first if needed. Throws when it cannot be. */
function loadS3Sdk() {
  if (sdk) return sdk;
  if (!installed()) install();
  const req = createRequire(path.join(ADDON_DIR, 'package.json'));
  sdk = { s3: req('@aws-sdk/client-s3'), storage: req('@aws-sdk/lib-storage') };
  return sdk;
}

module.exports = { loadS3Sdk, ADDON_DIR, PINNED_DIR };
