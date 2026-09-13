'use strict';

/**
 * Forum list / gallery / feed chrome and gallery tile sliders.
 *
 *   node --test test/forumViews.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const forum = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-forum.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');

function parseView(v) { return v === 'gallery' || v === 'feed' ? v : 'list'; }
function parseTile(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 13;
  return Math.min(28, Math.max(7, Math.round(n * 2) / 2));
}
function mediaTilePx(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 150;
  return Math.min(360, Math.max(72, n));
}

test('forum prefs keep list, gallery, and feed, and clamp tile size', () => {
  assert.equal(parseView('feed'), 'feed');
  assert.equal(parseView('gallery'), 'gallery');
  assert.equal(parseView('list'), 'list');
  assert.equal(parseView('cards'), 'list');
  assert.equal(parseTile(undefined), 13);
  assert.equal(parseTile(3), 7);
  assert.equal(parseTile(40), 28);
  assert.equal(parseTile(13.2), 13);
  assert.equal(parseTile(13.8), 14);
  assert.match(forum, /_forumParseView\(v\) \{ return v === 'gallery' \|\| v === 'feed' \? v : 'list'; \}/);
  assert.match(forum, /Math\.min\(28, Math\.max\(7,/);
  assert.match(forum, /data-view="feed"/);
  assert.match(forum, /id="forum-tile-size"/);
  assert.match(forum, /_forumAvatarHtml/);
  assert.doesNotMatch(forum, /forum-hdr-count/);
  assert.doesNotMatch(forum, /forum-tags-row/);
});

test('forum channels hide the leftover topic strip', () => {
  const channels = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-channels.js'), 'utf8');
  assert.match(channels, /isDm \|\| channel\?\.is_forum/);
  assert.match(css, /html\.forum-channel \.channel-topic-bar/);
});

test('forum gallery tiles follow --forum-tile and feed is a single column', () => {
  assert.match(css, /minmax\(var\(--forum-tile, 13rem\), 1fr\)/);
  assert.match(css, /\.messages\.forum-feed \.forum-topics/);
  assert.match(css, /\.messages\.forum-feed \.forum-topic-avatar/);
  assert.match(css, /\.messages\.forum-feed \.forum-topic-thumb-empty \{ display: none; \}/);
  assert.match(forum, /classList\.toggle\('forum-feed', p\.view === 'feed'\)/);
});

test('files and media photos have a tile size slider', () => {
  assert.equal(mediaTilePx('72'), 72);
  assert.equal(mediaTilePx('360'), 360);
  assert.equal(mediaTilePx('10'), 72);
  assert.equal(mediaTilePx('999'), 360);
  assert.equal(mediaTilePx('nope'), 150);
  assert.match(html, /id="media-gallery-tile"/);
  assert.match(ui, /_mediaTilePx/);
  assert.match(ui, /_applyMediaTileSize/);
  assert.match(css, /minmax\(var\(--media-tile, 150px\), 1fr\)/);
});
