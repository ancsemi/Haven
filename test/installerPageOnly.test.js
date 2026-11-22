'use strict';

// The setup installer can create the admin account, so only its own page
// may drive it: every request past the page needs the key made for this
// run, and must be addressed to the installer itself.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

// Starts the installer with the "open a browser" step switched off, and
// gives back its port.
function start() {
  const code = "require('child_process').spawn = () => ({ unref() {} }); require('./installer/server.js');";
  const child = spawn(process.execPath, ['-e', code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('installer did not start: ' + out)); }, 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('error', reject);
  });
}

function ask(port, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('only the installer page, with this run\'s key, can use the installer', async () => {
  const { child, port } = await start();
  try {
    const own = `127.0.0.1:${port}`;
    const page = await ask(port, { headers: { Host: own } });
    assert.equal(page.status, 200);
    const key = /var key = '([0-9a-f]{48})'/.exec(page.body)?.[1];
    assert.ok(key, 'the page carries the key');

    // Read-only and harmless, so it is the one used to probe the checks.
    const check = (headers) => ask(port, { url: '/api/check', headers });
    assert.equal((await check({ Host: own, 'X-Haven-Installer': key })).status, 200);
    assert.equal((await check({ Host: own })).status, 403, 'no key');
    assert.equal((await check({ Host: own, 'X-Haven-Installer': 'a'.repeat(48) })).status, 403, 'wrong key');
    assert.equal((await check({ Host: 'evil.example:' + port, 'X-Haven-Installer': key })).status, 403, 'another name pointed at this computer');
    assert.equal((await check({ Host: own, Origin: 'https://evil.example', 'X-Haven-Installer': key })).status, 403, 'another site');
    assert.equal((await ask(port, { headers: { Host: 'evil.example:' + port } })).status, 403, 'the page itself is not served under another name');

    // The requests that change things are refused the same way, before they do anything.
    for (const url of ['/api/install', '/api/launch', '/api/backup-upload']) {
      assert.equal((await ask(port, { method: 'POST', url, headers: { Host: own, 'Content-Type': 'text/plain' } })).status, 403, url);
    }
  } finally {
    child.kill();
  }
});
