'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const HavenGlyphs = require('../plugins/HavenGlyphs.plugin.js');

const ROOT = path.join(__dirname, '..');
const pluginSource = fs.readFileSync(path.join(ROOT, 'plugins/HavenGlyphs.plugin.js'), 'utf8');
const fontNotice = fs.readFileSync(path.join(ROOT, 'public/fonts/NOTICE.txt'), 'utf8');

function cssClassPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.haven-glyph\\.${escaped}::before\\s*\\{`);
}

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test('every Haven Glyphs map entry has a local Font Awesome rule', () => {
  for (const [emoji, [name]] of Object.entries(HavenGlyphs.ICON_MAP)) {
    assert.ok(emoji.length > 0, 'icon map contains an empty key');
    assert.match(HavenGlyphs.CSS, cssClassPattern(name), `${emoji} is missing CSS for ${name}`);
  }
  assert.match(HavenGlyphs.CSS, /url\('\/fonts\/fa-solid-900\.woff2'\)/);
  assert.doesNotMatch(HavenGlyphs.CSS, /https?:\/\//i);
});

test('Haven Glyphs scopes hosts and protects user content', () => {
  const expectedHosts = [
    '.channel-hash', '.voice-status-icon', '.pinned-tag', '.forum-tag-pinned',
    '.file-icon', '.status-url-toggle', '.tb-icon-emoji', '.burn-complete-label'
  ];
  const protectedContent = [
    '.message-content', '.reaction', '.emoji-only-msg', '.soundboard-btn',
    '.channel-name', '.profile-bio', '.theme-icon', '[data-user-content]'
  ];

  for (const selector of expectedHosts) assert.match(HavenGlyphs.ICON_EXPLICIT_SELECTOR, literalPattern(selector));
  for (const selector of protectedContent) assert.match(HavenGlyphs.ICON_EXCLUSION_SELECTOR, literalPattern(selector));

  assert.doesNotMatch(HavenGlyphs.ICON_EXCLUSION_SELECTOR, /data-haven-region="message-list"/);
  const plugin = new HavenGlyphs();
  const protectedElement = {
    closest(selector) {
      return selector === HavenGlyphs.ICON_EXCLUSION_SELECTOR ? protectedElement : null;
    }
  };
  const explicitHost = {
    matches(selector) { return selector === HavenGlyphs.ICON_EXPLICIT_SELECTOR; }
  };
  const ordinaryHost = { matches() { return false; } };
  assert.equal(plugin._iconExcluded(protectedElement, explicitHost), false);
  assert.equal(plugin._iconExcluded(protectedElement, ordinaryHost), true);
  assert.match(pluginSource, /const isLeading = at !== -1 && \/\^\\s\*\$\/\.test\(data\.slice\(0, at\)\);/);
  assert.doesNotMatch(pluginSource, /\/tmp\/opencode|https?:\/\//i);
});

test('the bundled icon font is present and non-empty', () => {
  const fontPath = path.join(ROOT, 'public/fonts/fa-solid-900.woff2');
  const stats = fs.statSync(fontPath);
  assert.ok(stats.size > 100_000, `unexpected Font Awesome font size: ${stats.size}`);
  assert.match(fontNotice, /Font Awesome Free 6\.7\.2/);
  assert.match(fontNotice, /SIL Open Font License 1\.1/);
  assert.match(fontNotice, /CC BY 4\.0/);
});
