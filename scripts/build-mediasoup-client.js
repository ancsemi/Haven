#!/usr/bin/env node
'use strict';
/**
 * Builds public/js/vendor/mediasoup-client.js, the browser half of the voice
 * relay, from the mediasoup-client package (a dev dependency), and writes
 * public/js/vendor/mediasoup-client.NOTICE.txt with the license of every
 * package that ends up inside it.
 *
 * The browser loads it only when joining a relayed call. The output is not
 * minified, so it can be read and checked like the rest of the client, and
 * it is committed so servers never need a build step.
 *
 *   node scripts/build-mediasoup-client.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'public', 'js', 'vendor', 'mediasoup-client.js');
const NOTICE = path.join(ROOT, 'public', 'js', 'vendor', 'mediasoup-client.NOTICE.txt');
const version = require(path.join(MODULES, 'mediasoup-client', 'package.json')).version;

// Resolved from a scratch folder with node_modules pointed at explicitly, so
// esbuild never reads package.json files that sit above the repo.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-msc-'));
let result;
try {
  result = esbuild.buildSync({
    stdin: {
      contents: "import * as mediasoupClient from 'mediasoup-client';\nwindow.mediasoupClient = mediasoupClient;\n",
      resolveDir: scratch,
      loader: 'js',
    },
    nodePaths: [MODULES],
    absWorkingDir: scratch,
    bundle: true,
    minify: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'eof',
    metafile: true,
    banner: { js: `/* mediasoup-client ${version} (ISC) and its dependencies, bundled by scripts/build-mediasoup-client.js. Licenses: mediasoup-client.NOTICE.txt. Do not edit by hand. */` },
    outfile: OUT,
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// Every package with a file in the bundle, with its license text.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(path.resolve(scratch, input));
  if (!m) continue;
  const dir = path.join(MODULES, m[1]);
  if (packages.has(m[1]) || !fs.existsSync(path.join(dir, 'package.json'))) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(dir).find(f => /^licen[sc]e(\.|$)/i.test(f));
  packages.set(m[1], {
    name: pkg.name, version: pkg.version, license: pkg.license || 'see text',
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : '(no license file shipped with the package)',
  });
}
const notice = ['Third-party code bundled into mediasoup-client.js', '', ...[...packages.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(p => ['='.repeat(72), `${p.name} ${p.version} (${p.license})`, '='.repeat(72), p.text, ''])].join('\n');
fs.writeFileSync(NOTICE, notice + '\n');

console.log(`Wrote ${path.relative(ROOT, OUT)} (mediasoup-client ${version}, ${Math.round(fs.statSync(OUT).size / 1024)} KB) and its NOTICE (${packages.size} packages)`);
