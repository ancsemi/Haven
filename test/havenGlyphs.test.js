'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const HavenGlyphs = require('../plugins/HavenGlyphs.plugin.js');

const ROOT = path.join(__dirname, '..');
const pluginSource = fs.readFileSync(path.join(ROOT, 'plugins/HavenGlyphs.plugin.js'), 'utf8');
const roleToolsSource = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-role-tools.js'), 'utf8');
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
  assert.match(HavenGlyphs.CSS, /\.haven-glyph\s*\{[^}]*text-indent:\s*0;/s);
  assert.match(HavenGlyphs.CSS, /\.user-action-btn\s*>\s*\.haven-glyph\s*\{[^}]*color:\s*var\(--text-secondary\);/s);
  assert.doesNotMatch(HavenGlyphs.CSS, /https?:\/\//i);
});

test('soundboard and Listen Together use distinct interface glyphs', () => {
  assert.equal(HavenGlyphs.ICON_MAP['🎵'][0], 'fa-music');
  assert.equal(HavenGlyphs.ICON_MAP['🎶'][0], 'fa-headphones');
  assert.notEqual(HavenGlyphs.ICON_MAP['🎵'][0], HavenGlyphs.ICON_MAP['🎶'][0]);
});

test('speaker mute and deafen controls use speaker glyphs without duplicate slashes', () => {
  const plugin = new HavenGlyphs();
  const deafenButton = {
    matches(selector) { return selector === '#voice-deafen-btn, #voice-deafen-btn-header'; }
  };
  assert.equal(HavenGlyphs.ICON_MAP['🔇'][0], 'fa-volume-xmark');
  assert.equal(HavenGlyphs.ICON_MAP['🔊'][0], 'fa-volume-high');
  assert.deepEqual(plugin._iconSpec('🔇', deafenButton), ['fa-volume-high']);
  assert.deepEqual(plugin._iconSpec('🔇', { matches() { return false; } }), ['fa-volume-xmark']);
});

test('known settings, voice, admin, and file UI glyphs are mapped', () => {
  const expected = {
    '🎉': 'fa-champagne-glasses', '🌎': 'fa-globe', '📲': 'fa-mobile-screen',
    '📏': 'fa-ruler', '▪️': 'fa-square', '◾': 'fa-square', '⬛': 'fa-square',
    '✉️': 'fa-envelope', '✨': 'fa-wand-magic-sparkles', '☑️': 'fa-circle-check',
    '🗝️': 'fa-key', '🎟️': 'fa-ticket', '⏰': 'fa-clock', '📅': 'fa-calendar-days',
    '🕐': 'fa-clock', 'ℹ️': 'fa-circle-info', '🩸': 'fa-droplet', '🐍': 'fa-code',
    '🤝': 'fa-handshake', '📸': 'fa-camera'
  };
  for (const [emoji, name] of Object.entries(expected)) {
    assert.equal(HavenGlyphs.ICON_MAP[emoji][0], name, `${emoji} mapping changed`);
  }
});

test('Haven Glyphs scopes hosts and protects user content', () => {
  const expectedHosts = [
    '.channel-hash', '.voice-status-icon', '.pinned-tag', '.forum-tag-pinned',
    '.file-icon', '.status-url-toggle', '.tb-icon-emoji', '.burn-complete-label',
    '.settings-nav-item', '.settings-group-label', '.voice-bar-icon',
    '.music-pip-label-icon', '.music-pip-vol-icon', '.viewer-eye',
    '.organize-tag-icon', '.thread-mention-badge', '.import-channel-type-icon',
    '.connectivity-test-icon', '.wizard-check', '.file-type-icon',
    '#section-score-badges > .settings-hint', '.role-tpl-emoji',
    '.connection-icon', '.stream-size-label',
    '[data-i18n-title="modals.game_overlay.volume_label"]'
  ];
  const protectedContent = [
    '.message-content', '.reaction', '.emoji-only-msg', '.soundboard-btn',
    '.channel-name', '.profile-bio', '.theme-icon', '.reply-preview', '[data-user-content]'
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

  const translatedChild = {
    hasAttribute(name) { return name === 'data-i18n'; }
  };
  const translatedSpan = {
    tagName: 'SPAN', children: [translatedChild],
    closest() { return null; }
  };
  const broadSection = {
    tagName: 'DIV', children: [translatedChild],
    closest() { return null; }
  };
  assert.equal(plugin._iconHost(translatedSpan), translatedSpan);
  assert.equal(plugin._iconHost(broadSection), null);
  assert.match(pluginSource, /const isLeading = at !== -1 && \/\^\\s\*\$\/\.test\(data\.slice\(0, at\)\);/);
  assert.doesNotMatch(pluginSource, /\/tmp\/opencode|https?:\/\//i);
});

test('native channel template options use text-only labels', () => {
  assert.doesNotMatch(roleToolsSource, /label: `\$\{tp\.emoji\}/);
  assert.doesNotMatch(roleToolsSource, /label: `💾/);
  assert.doesNotMatch(roleToolsSource, /replace\(\/\^💾/);
});

test('the bundled icon font is present and non-empty', () => {
  const fontPath = path.join(ROOT, 'public/fonts/fa-solid-900.woff2');
  const stats = fs.statSync(fontPath);
  assert.ok(stats.size > 100_000, `unexpected Font Awesome font size: ${stats.size}`);
  assert.match(fontNotice, /Font Awesome Free 6\.7\.2/);
  assert.match(fontNotice, /SIL Open Font License 1\.1/);
  assert.match(fontNotice, /CC BY 4\.0/);
});
