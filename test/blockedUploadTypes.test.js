'use strict';

/**
 * Blocked file types (#5833): an admin lists types such as exe or bat, and
 * uploads of those are refused. The list is cleaned up when it is saved.
 *
 *   node --test test/blockedUploadTypes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeBlockedExtensions, fileExtension, blockedUploadType } = require('../src/uploadBlocklist');
const { createHarness, wait } = require('./socketServerHarness');

test('the list is cleaned up when saved', () => {
  assert.equal(normalizeBlockedExtensions(' .EXE, bat;  *.dll\nexe '), 'exe,bat,dll');
  assert.equal(normalizeBlockedExtensions(''), '');
  assert.equal(normalizeBlockedExtensions('exe, ../etc'), null, 'anything but a plain type is refused');
  assert.equal(normalizeBlockedExtensions(Array.from({ length: 101 }, (_, i) => 'x' + i).join(',')), null);
});

test('a file name\'s type is read the way Windows reads it', () => {
  assert.equal(fileExtension('setup.exe'), 'exe');
  assert.equal(fileExtension('Setup.EXE. . '), 'exe');
  assert.equal(fileExtension('report.exe.pdf'), 'pdf');
  assert.equal(fileExtension('README'), '');
  assert.equal(blockedUploadType('run.BAT', 'exe,bat'), 'bat');
  assert.equal(blockedUploadType('notes.txt', 'exe,bat'), '');
  assert.equal(blockedUploadType('run.bat', ''), '');
});

const h = createHarness(3514, 'blocked-upload-types');
test.before(() => h.start());
test.after(() => h.stop());

async function uploadFile(token, name) {
  const fd = new FormData();
  fd.append('file', new Blob(['hello']), name);
  const res = await fetch('http://localhost:3514/api/upload-file', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, body: await res.json() };
}

test('the server refuses blocked types and takes the rest', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);

  A.emit('update-server-setting', { key: 'blocked_upload_extensions', value: '.EXE, bat' });
  await wait(500);

  const exe = await uploadFile(bob.token, 'free-game.exe');
  assert.equal(exe.status, 400);
  assert.match(exe.body.error, /\.exe files can't be uploaded/);
  assert.equal((await uploadFile(bob.token, 'run.BAT.')).status, 400, 'case and a trailing dot do not get around it');
  const ok = await uploadFile(bob.token, 'notes.txt');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.url, /^\/uploads\/.+\.txt$/);

  const bad = h.next(A, 'error-msg', (m) => /Blocked file types/.test(m), 5000);
  A.emit('update-server-setting', { key: 'blocked_upload_extensions', value: 'exe, <script>' });
  assert.ok(await bad, 'a list with junk in it is refused');
  assert.equal((await uploadFile(bob.token, 'still.exe')).status, 400, 'and the old list stays');

  A.disconnect();
});
