'use strict';

// Pictures sent together show as one grid (#5799). The layout by count, the
// line reading and the grid markup are pure, so they are driven here; the
// look was checked in a browser.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let M, MAX, LAYOUTS;
test.before(async () => {
  global.t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  const mod = await import(pathToFileURL(path.join(ROOT, 'public/js/modules/app-media-grid.js')).href);
  M = mod.default;
  MAX = mod.MEDIA_GROUP_MAX;
  LAYOUTS = mod.MEDIA_GROUP_LAYOUTS;
});

const area = (layout) => layout.spans.reduce((sum, [c, r]) => sum + c * r, 0);

test('one picture is not a grid', () => {
  assert.equal(M._mediaGridLayout(0), null);
  assert.equal(M._mediaGridLayout(1), null);
});

test('every count fills its grid with no gaps', () => {
  for (let n = 2; n <= 30; n++) {
    const l = M._mediaGridLayout(n);
    assert.equal(l.spans.length, l.shown, `count ${n}`);
    assert.equal(area(l), 6 * l.rows, `count ${n} covers six columns by ${l.rows} rows`);
    assert.match(l.ratio, /^\d+ \/ \d+$/);
  }
});

test('the layouts follow the count', () => {
  assert.deepEqual(M._mediaGridLayout(2).spans, [[3, 1], [3, 1]], 'two side by side');
  assert.deepEqual(M._mediaGridLayout(3).spans, [[3, 2], [3, 1], [3, 1]], 'one large and two stacked');
  assert.deepEqual(M._mediaGridLayout(4).spans, [[3, 1], [3, 1], [3, 1], [3, 1]], 'two by two');
  for (const n of [5, 6]) assert.ok(M._mediaGridLayout(n).spans.some(([c]) => c === 2), `${n}: three columns`);
  assert.equal(M._mediaGridLayout(6).rows, 2);
  for (const n of [7, 8, 9]) assert.equal(M._mediaGridLayout(n).rows, 3, `${n}: three rows`);
  assert.deepEqual(M._mediaGridLayout(9).spans, Array(9).fill([2, 1]), 'nine is three by three');
});

test('past nine, eight show and the ninth says how many more', () => {
  assert.deepEqual([M._mediaGridLayout(9).shown, M._mediaGridLayout(9).more], [9, 0]);
  assert.deepEqual([M._mediaGridLayout(10).shown, M._mediaGridLayout(10).more], [9, 2]);
  assert.deepEqual([M._mediaGridLayout(12).shown, M._mediaGridLayout(12).more], [9, 4]);
});

test('grid lines are pictures, encrypted pictures and videos', () => {
  assert.equal(M._mediaGridKind('/uploads/1760-abc.png'), 'image');
  assert.equal(M._mediaGridKind('spoiler-img:/uploads/1760-abc.webp'), 'image');
  assert.equal(M._mediaGridKind('e2e-img:image/jpeg:/uploads/1760-abc.enc'), 'image');
  assert.equal(M._mediaGridKind('spoiler-img:e2e-img:image/png:/uploads/1760-abc.enc'), 'image');
  assert.equal(M._mediaGridKind('[file:clip.mp4](/uploads/1760-abc.mp4|3.1 MB)'), 'video');
  assert.equal(M._mediaGridKind('[file:notes.pdf](/uploads/1760-abc.pdf|3.1 MB)'), null);
  assert.equal(M._mediaGridKind('/uploads/1760-abc.zip'), null);
  assert.equal(M._mediaGridKind('hello'), null);
  assert.equal(M._mediaGridKind('https://example.com/a.png'), null);
  assert.deepEqual(M._mediaGridRun(['a', '/uploads/1.png', '/uploads/2.png', 'b'], 1), ['/uploads/1.png', '/uploads/2.png']);
});

test('a batch is ordered pictures and videos first, then split by ten', () => {
  const f = (name, type) => ({ name, type });
  const files = [f('a.pdf', 'application/pdf'), f('b.png', 'image/png'), f('c.mp4', 'video/mp4'), f('d.mov', ''), f('e.zip', 'application/zip')];
  assert.deepEqual(M._mediaGroupOrder(files).map(x => x.name), ['b.png', 'c.mp4', 'd.mov', 'a.pdf', 'e.zip']);
  assert.equal(MAX, 10);
  const twelve = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(M._mediaChunks(twelve, 10).map(c => c.length), [10, 2]);
  assert.deepEqual(M._mediaChunks(twelve, 3).map(c => c.length), [3, 3, 3, 3]);
  assert.equal(M._mediaGroupMax.call({ _maxAttachments: () => 50 }), 10);
  assert.equal(M._mediaGroupMax.call({ _maxAttachments: () => 3 }), 3);
});

test('editing a batch edits its text and keeps its pictures', () => {
  const split = (c) => M._mediaGroupSplit.call(M, c);
  assert.deepEqual(split('hi there\n/uploads/1.png\n/uploads/2.png'), { text: 'hi there', media: ['/uploads/1.png', '/uploads/2.png'] });
  assert.deepEqual(split('/uploads/1.png\n[file:a.pdf](/uploads/a.pdf|1 KB)'), { text: '', media: ['/uploads/1.png', '[file:a.pdf](/uploads/a.pdf|1 KB)'] });
  assert.equal(split('/uploads/1.png'), null, 'one picture edits as before');
  assert.equal(split('a\n/uploads/1.png\nb\n/uploads/2.png'), null, 'text between pictures edits as before');
  assert.equal(split('just text'), null);
});

test('the grid markup: spans, +N, hidden extras and video tiles', () => {
  const ctx = Object.assign(Object.create(M), {
    _liteOn: () => false,
    _escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    _formatContent: (l) => `<img class="chat-image" data-line="${l}">`,
  });
  const lines = Array.from({ length: 12 }, (_, i) => `/uploads/${i}.png`);
  lines[1] = '[file:clip.mp4](/uploads/clip.mp4|1 MB)';
  const html = ctx._mediaGridHtml(lines);
  assert.match(html, /^<div class="media-grid" data-count="12"/);
  assert.match(html, /aspect-ratio:1 \/ 1;grid-template-rows:repeat\(3,minmax\(0,1fr\)\)/);
  assert.equal((html.match(/class="media-grid-tile[^"]*mg-hidden/g) || []).length, 3, 'three wait behind the +N');
  assert.equal((html.match(/media-grid-more/g) || []).length, 1);
  assert.match(html, />\+4<\/span>/);
  assert.match(html, /class="media-grid-tile is-video" style="grid-column:span 2;grid-row:span 1" data-video-src="\/uploads\/clip\.mp4"/);
  assert.equal((html.match(/class="chat-image"/g) || []).length, 11, 'every picture is in the grid for the lightbox');
});

test('the grid is loaded with the app and its styles sit in their own file', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import MediaGridMethods from '\.\/modules\/app-media-grid\.js\?v=[0-9.]+';/);
  assert.match(app, /^\s*MediaGridMethods,$/m);
  assert.match(app, /this\._setupMediaGrid\(\);/);
  assert.match(read('public/css/style.css'), /@import url\('\/css\/style-media-grid\.css\?v=[0-9.]+'\);/);
  const content = read('public/js/modules/app-message-content.js');
  assert.match(content, /this\._mediaGridHtml\(run\)/);
  assert.match(read('public/js/modules/app-media.js'), /this\._lightboxScope = \(imgEl && imgEl\.closest && imgEl\.closest\('\.media-grid'\)\) \|\| null;/);
  assert.match(read('public/js/modules/app-forum.js'), /this\._mediaGridOff = !!this\._forumBlogOn\?\.\(\);/);
});

test('text goes with the attachments unless it is a command, a burn message or text is off', () => {
  const app = Object.assign(Object.create(M), { channels: [{ code: 'aaaaaaaa' }, { code: 'bbbbbbbb', text_enabled: 0 }] });
  assert.equal(app._mediaGroupTakesText('look at these', { code: 'aaaaaaaa' }), true);
  assert.equal(app._mediaGroupTakesText('', { code: 'aaaaaaaa' }), false);
  assert.equal(app._mediaGroupTakesText('/shrug', { code: 'aaaaaaaa' }), false);
  assert.equal(app._mediaGroupTakesText('gone soon', { code: 'aaaaaaaa', burnSeconds: 30 }), false);
  assert.equal(app._mediaGroupTakesText('caption', { code: 'bbbbbbbb' }), false);
  assert.equal(Object.assign(Object.create(M), { _forumBlogOn: () => true })._mediaGroupOn('x'), false, 'a blog keeps one piece per file');
  assert.equal(M._mediaGroupOn('x'), true);
});

// The grid is a choice (#5799): the server's default and each member's own.

test('the layout in effect is your own pick, else the server default, else the grid', () => {
  assert.deepEqual(LAYOUTS, ['grid', 'stacked']);
  assert.deepEqual(LAYOUTS, require('../src/mediaGroup').MEDIA_GROUP_LAYOUTS, 'client and server agree');
  const pick = (mine, server) => M._mediaGroupLayoutFor(mine, server);
  assert.equal(pick(undefined, undefined), 'grid');
  assert.equal(pick(undefined, 'stacked'), 'stacked');
  assert.equal(pick('grid', 'stacked'), 'grid', 'a member can keep the grid on a stacked server');
  assert.equal(pick('stacked', 'grid'), 'stacked');
  assert.equal(pick('mosaic', 'stacked'), 'stacked', 'an unknown pick follows the server');
  assert.equal(pick('', 'bogus'), 'grid');
  const app = (prefs, settings) => Object.assign(Object.create(M), { _userPrefs: prefs, serverSettings: settings });
  assert.equal(app(null, { media_group_layout: 'stacked' })._mediaGroupLayoutPref(), 'stacked');
  assert.equal(app({ media_group_layout: 'grid' }, { media_group_layout: 'stacked' })._mediaGroupLayoutPref(), 'grid');
  assert.equal(app({}, {})._mediaGroupLayoutPref(), 'grid');
});

test('the stacked frame has no sizes, hides nothing and has no +N', () => {
  assert.equal(M._mediaGridFrame(1, 'stacked'), null);
  const s = M._mediaGridFrame(12, 'stacked');
  assert.equal(s.stacked, true);
  assert.equal(s.style, '');
  assert.equal(s.more, null);
  assert.equal(s.tiles.length, 12);
  assert.ok(s.tiles.every(x => x.style === '' && !x.hidden));
  const g = M._mediaGridFrame(12, 'grid');
  assert.equal(g.stacked, false);
  assert.deepEqual(g.more, { index: 8, count: 4 });
  assert.equal(g.tiles.filter(x => x.hidden).length, 3);
});

const htmlCtx = (extra = {}) => Object.assign(Object.create(M), {
  _liteOn: () => false,
  _escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
  _formatContent: (l) => (l.startsWith('spoiler-img:')
    ? `<span class="spoiler-media"><img class="chat-image" data-line="${l}"></span>`
    : `<img class="chat-image" data-line="${l}">`),
}, extra);

test('stacked markup: every picture whole and in order, in one group for the lightbox', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `/uploads/${i}.png`);
  lines[1] = '[file:clip.mp4](/uploads/clip.mp4|1 MB)';
  lines[2] = 'spoiler-img:/uploads/2.png';
  const html = htmlCtx()._mediaGridHtml(lines, 'stacked');
  assert.match(html, /^<div class="media-grid is-stacked" data-count="12" data-layout="stacked" role="group" aria-label="[^"]*">/);
  assert.doesNotMatch(html, /style=/, 'no inline sizes: pictures keep their own shape');
  assert.doesNotMatch(html, /mg-hidden|media-grid-more/, 'all twelve show, no +N');
  assert.equal((html.match(/class="media-grid-tile[ "]/g) || []).length, 12);
  const order = [...html.matchAll(/data-line="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, lines.filter((_, i) => i !== 1), 'pictures in the order they were sent');
  assert.match(html, /<div class="media-grid-tile"><span class="spoiler-media">/, 'a spoiler stays on its own picture');
  assert.match(html, /class="media-grid-tile is-video" data-video-src="\/uploads\/clip\.mp4"/);
  // Four go the same way.
  const four = htmlCtx()._mediaGridHtml(lines.slice(3, 7), 'stacked');
  assert.equal((four.match(/class="media-grid-tile"/g) || []).length, 4);
  // A single picture is never a group.
  assert.equal(htmlCtx()._mediaGridHtml(['/uploads/a.png'], 'stacked'), '<div class="content-media-part"><img class="chat-image" data-line="/uploads/a.png"></div>');
});

test('the markup follows the layout in effect when none is given', () => {
  const lines = ['/uploads/a.png', '/uploads/b.png', '/uploads/c.png', '/uploads/d.png'];
  const server = htmlCtx({ serverSettings: { media_group_layout: 'stacked' }, _userPrefs: {} });
  assert.match(server._mediaGridHtml(lines), /class="media-grid is-stacked"/);
  const mine = htmlCtx({ serverSettings: { media_group_layout: 'stacked' }, _userPrefs: { media_group_layout: 'grid' } });
  assert.match(mine._mediaGridHtml(lines), /^<div class="media-grid" data-count="4" data-layout="grid"[^>]* style="aspect-ratio:4 \/ 3;/);
});

test('a change of layout redraws the groups already on the page, and the grid styles leave stacked alone', () => {
  const src = read('public/js/modules/app-media-grid.js');
  for (const ev of ['server-settings', 'preferences', 'server-setting-changed']) {
    const at = src.indexOf(`this.socket?.on('${ev}'`);
    assert.ok(at > 0, `listens for ${ev}`);
    assert.match(src.slice(at, at + 260), /this\._relayoutMediaGrids\(\);\n\s+this\._syncMediaLayoutPicker\(\);/, `${ev} redraws and updates the picker`);
  }
  assert.match(src, /if \(data\?\.key !== 'media_group_layout'\) return;/);
  const css = read('public/css/style-media-grid.css');
  assert.match(css, /\.media-grid:not\(\.is-stacked\) \.media-grid-tile img\.chat-image,/);
  assert.doesNotMatch(css, /^\.media-grid \.media-grid-tile img\.chat-image/m, 'cropping applies to the grid only');
  assert.match(css, /\.media-grid\.is-stacked \{\n\s+display: block;/);
});

test('the admin panel fills and saves the server default with its other settings', () => {
  const sel = { value: '' };
  const emitted = [];
  const prevDoc = global.document;
  global.document = { getElementById: (id) => (id === 'media-group-layout' ? sel : null) };
  try {
    const app = Object.assign(Object.create(M), { socket: { emit: (ev, data) => emitted.push([ev, data]) } });
    app._fillMediaLayoutAdmin(undefined);
    assert.equal(sel.value, 'grid', 'an unset server shows the grid');
    app._fillMediaLayoutAdmin('stacked');
    assert.equal(sel.value, 'stacked');
    assert.equal(app._saveMediaLayoutAdmin({ media_group_layout: 'stacked' }), false, 'unchanged: nothing sent');
    sel.value = 'grid';
    assert.equal(app._saveMediaLayoutAdmin({ media_group_layout: 'stacked' }), true);
    assert.deepEqual(emitted, [['update-server-setting', { key: 'media_group_layout', value: 'grid' }]]);
  } finally {
    global.document = prevDoc;
  }
  const admin = read('public/js/modules/app-admin.js');
  assert.match(admin, /media_group_layout: this\.serverSettings\.media_group_layout \|\| 'grid',/);
  assert.match(admin, /if \(this\._saveMediaLayoutAdmin\?\.\(snap\)\) changed = true;/);
  assert.equal((admin.match(/this\._fillMediaLayoutAdmin\?\.\(/g) || []).length, 2, 'filled on open and on cancel');
  assert.match(read('public/app.html'), /<select id="media-group-layout" class="settings-select">/);
});

test('your own pick is saved on your account, and Server default clears it', () => {
  const emitted = [];
  const prevDoc = global.document;
  global.document = { getElementById: () => null, querySelectorAll: () => [] };
  try {
    const app = Object.assign(Object.create(M), {
      socket: { emit: (ev, data) => emitted.push([ev, data]) },
      serverSettings: { media_group_layout: 'stacked' },
    });
    app._setMediaLayoutPref('grid');
    assert.equal(app._userPrefs.media_group_layout, 'grid');
    assert.equal(app._mediaGroupLayoutPref(), 'grid');
    app._setMediaLayoutPref('');
    assert.equal(app._userPrefs.media_group_layout, undefined);
    assert.equal(app._mediaGroupLayoutPref(), 'stacked', 'back to the server default');
    assert.deepEqual(emitted, [
      ['set-preference', { key: 'media_group_layout', value: 'grid' }],
      ['delete-preference', { key: 'media_group_layout' }],
    ]);
  } finally {
    global.document = prevDoc;
  }
  const html = read('public/app.html');
  const picker = html.slice(html.indexOf('id="media-layout-picker"'), html.indexOf('id="animate-pfp-subsection"'));
  assert.deepEqual([...picker.matchAll(/data-media-layout="([^"]*)"/g)].map(m => m[1]), ['', 'grid', 'stacked']);
  assert.ok(html.indexOf('id="media-layout-picker"') > html.indexOf('id="section-image-display"'), 'it sits in Image Display');
});

test('Lite mode keeps video tiles from preloading', () => {
  const lines = ['/uploads/a.png', '[file:clip.mp4](/uploads/clip.mp4|1 MB)'];
  assert.match(htmlCtx({ _liteOn: () => true })._mediaGridHtml(lines, 'stacked').concat(htmlCtx({ _liteOn: () => true })._mediaGridHtml(lines)), /preload="none"/);
  assert.doesNotMatch(htmlCtx()._mediaGridHtml(lines), /preload="none"/);
});
