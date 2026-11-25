'use strict';

// The thread header and the Threads list name a picture or file the way
// reply lines do, instead of showing the address it is stored under.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const mod = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', f)).href;
let app;
test.before(async () => {
  const [threads, content, utils] = await Promise.all(['app-threads.js', 'app-message-content.js', 'app-utilities.js'].map(async (f) => (await import(mod(f))).default));
  app = Object.assign(Object.create(null), utils, content, threads);
  global.t = (k, v) => (v && v.count ? `${k}:${v.count}` : k);
});
test.after(() => { delete global.t; });

test('a picture-only root reads as a picture, not its upload path', () => {
  assert.equal(app._threadRootPreview('/uploads/1792162568307-e189d24dcc15b045.png'), '🖼️ messages.preview_picture');
});

test('several pictures read as a count, a file by its name, and text stays text', () => {
  assert.equal(app._threadRootPreview('/uploads/a.png\n/uploads/b.jpg'), '🖼️ messages.preview_pictures:2');
  assert.equal(app._threadRootPreview('[file:notes.pdf](/uploads/x.pdf|2 KB)'), '📎 notes.pdf');
  assert.equal(app._threadRootPreview('look at this\n/uploads/a.png'), 'look at this 🖼️ messages.preview_picture');
  assert.equal(app._threadRootPreview('plain words'), 'plain words');
});

test('long roots are cut to the length asked for', () => {
  const out = app._threadRootPreview('x'.repeat(300));
  assert.equal(out.length, 121);
  assert.ok(out.endsWith('…'));
  assert.equal(app._threadRootPreview('y'.repeat(400), 300).length, 301);
});

test('the header, the reloaded header and the Threads list all use it', () => {
  assert.match(read('public/js/modules/app-threads.js'), /getElementById\('thread-parent-preview'\)\.textContent = this\._threadRootPreview\(/);
  assert.match(read('public/js/modules/app-socket-events.js'), /preview\.textContent = this\._threadRootPreview\(data\.parentContent\);/);
  assert.match(read('public/js/modules/app-media-gallery.js'), /const preview = this\._threadRootPreview\(th\.content, 300\);/);
});

test('the threads list titles a row with the topic and puts the starter under it', () => {
  const row = read('public/js/modules/app-media-gallery.js').split('class="thread-list-row"')[1].split('</div>')[0];
  assert.ok(row.indexOf('thread-list-preview') < row.indexOf('thread-list-author'));
  assert.match(read('public/css/style-gallery-ferry-forums.css'), /\.thread-list-preview \{\s*color: var\(--text-primary\);\s*font-size: 0\.9rem;\s*font-weight: 600;/);
});
