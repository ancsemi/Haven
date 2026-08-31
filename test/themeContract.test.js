'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function attributeValues(html, attribute) {
  const pattern = new RegExp(`${attribute}="([^"]+)"`, 'g');
  return [...html.matchAll(pattern)].map(match => match[1]);
}

function declaredProperties(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...withoutComments.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(match => match[1]));
}

const APP_REGIONS = [
  'app-shell',
  'workspace',
  'server-rail',
  'navigation-sidebar',
  'account',
  'sidebar-content',
  'join-channel',
  'create-channel',
  'channels',
  'direct-messages',
  'sidebar-footer',
  'theme-picker',
  'main',
  'channel-header',
  'welcome',
  'message-area',
  'webcams',
  'screen-shares',
  'music-player',
  'pinned-messages',
  'message-list',
  'composer',
  'soundboard',
  'context-sidebar',
  'search-results',
  'voice-roster',
  'member-list',
  'voice-settings',
  'voice-controls',
  'status-bar',
  'thread-panel',
  'settings'
];

const AUTH_REGIONS = [
  'auth-shell',
  'auth-card',
  'auth-header',
  'theme-picker'
];

const PUBLIC_TOKENS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-hover',
  '--bg-active',
  '--bg-input',
  '--bg-card',
  '--accent',
  '--accent-hover',
  '--accent-glow',
  '--accent-text',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-link',
  '--border',
  '--border-light',
  '--success',
  '--danger',
  '--warning',
  '--led-on',
  '--led-off',
  '--led-glow',
  '--font-main',
  '--font-mono',
  '--font-heading',
  '--radius',
  '--radius-sm',
  '--transition',
  '--sidebar-width',
  '--right-width',
  '--msg-glow',
  '--scanline'
];

const APP_REGION_IDS = {
  'app-shell': 'app',
  workspace: 'app-body',
  'server-rail': 'server-bar',
  'sidebar-content': 'sidebar-mod-container',
  'create-channel': 'admin-controls',
  channels: 'channels-pane',
  'direct-messages': 'dm-pane',
  'theme-picker': 'theme-selector',
  welcome: 'no-channel-msg',
  'message-area': 'message-area',
  webcams: 'webcam-container',
  'screen-shares': 'screen-share-container',
  'music-player': 'music-panel',
  'pinned-messages': 'pinned-panel',
  'message-list': 'messages',
  composer: 'message-input-area',
  soundboard: 'sb-sidebar-panel',
  'context-sidebar': 'right-sidebar',
  'search-results': 'search-panel',
  'voice-roster': 'right-sidebar-voice',
  'member-list': 'right-sidebar-users',
  'voice-settings': 'voice-settings-panel',
  'voice-controls': 'voice-panel',
  'status-bar': 'status-bar',
  'thread-panel': 'thread-panel'
};

function openingTagById(html, id) {
  return html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0] || '';
}

function markdownSection(markdown, start, end) {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing documentation section: ${start}`);
  assert.notEqual(endIndex, -1, `missing documentation section: ${end}`);
  return markdown.slice(startIndex, endIndex);
}

test('app and authentication pages expose Theme API v1 page markers', () => {
  const appHtml = read('public/app.html');
  const authHtml = read('public/index.html');

  assert.match(appHtml, /<html\b[^>]*\bdata-haven-theme-api="1"/);
  assert.match(authHtml, /<html\b[^>]*\bdata-haven-theme-api="1"/);
  assert.match(appHtml, /<body\b[^>]*\bdata-haven-page="app"/);
  assert.match(authHtml, /<body\b[^>]*\bdata-haven-page="auth"/);
});

test('application regions are present exactly once', () => {
  const appHtml = read('public/app.html');
  const regions = attributeValues(appHtml, 'data-haven-region');

  assert.deepEqual([...regions].sort(), [...APP_REGIONS].sort());
  assert.equal(new Set(regions).size, regions.length);
  for (const [region, id] of Object.entries(APP_REGION_IDS)) {
    assert.match(openingTagById(appHtml, id), new RegExp(`data-haven-region="${region}"`));
  }
  assert.match(appHtml, /<aside\b[^>]*class="sidebar"[^>]*data-haven-region="navigation-sidebar"/);
  assert.match(appHtml, /<div\b[^>]*class="user-bar"[^>]*data-haven-region="account"/);
  assert.match(appHtml, /<div\b[^>]*data-mod-id="join"[^>]*data-haven-region="join-channel"/);
  assert.match(appHtml, /<div\b[^>]*class="sidebar-bottom"[^>]*data-haven-region="sidebar-footer"/);
  assert.match(appHtml, /<main\b[^>]*class="main"[^>]*data-haven-region="main"/);
  assert.match(appHtml, /<header\b[^>]*class="channel-header"[^>]*data-haven-region="channel-header"/);
  assert.match(appHtml, /<div\b[^>]*class="modal modal-settings"[^>]*data-haven-region="settings"/);
});

test('authentication regions are present exactly once', () => {
  const regions = attributeValues(read('public/index.html'), 'data-haven-region');

  assert.deepEqual([...regions].sort(), [...AUTH_REGIONS].sort());
  assert.equal(new Set(regions).size, regions.length);
});

test('every public token has a core default and is covered by the theme template', () => {
  const coreCss = read('public/css/style.css');
  const defaultThemeBlock = coreCss.match(/:root,\s*\[data-theme="haven"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  const coreProperties = declaredProperties(defaultThemeBlock);
  const template = read('themes/custom.css.example');
  const templateProperties = declaredProperties(template);

  for (const token of PUBLIC_TOKENS) {
    assert.ok(coreProperties.has(token), `${token} is missing a core declaration`);
    assert.ok(template.includes(token), `${token} is missing from custom.css.example`);
    assert.ok(templateProperties.has(token), `${token} is not configurable in custom.css.example`);
  }
});

test('the theme template targets Theme API v1 and stable layout regions', () => {
  const template = read('themes/custom.css.example');

  assert.match(template, /@haven-theme-api\s+1\b/);
  assert.match(template, /\[data-haven-region="main"\]/);
  assert.match(template, /\[data-haven-region="navigation-sidebar"\]/);
  assert.match(template, /\[data-haven-region="context-sidebar"\]/);
  assert.doesNotMatch(template, /(?:^|\n)\s*\.main\s*\{/);
});

test('the authoring reference covers every public region and token', () => {
  const docs = read('docs/theme-authoring.md');
  const guide = read('GUIDE.md');
  const tokenSection = markdownSection(docs, '## Public design tokens', '## Public layout regions');
  const regionSection = markdownSection(docs, '## Public layout regions', '## Stability policy');
  const documentedTokens = [...tokenSection.matchAll(/^\| `(--[^`]+)` \|/gm)].map(match => match[1]);
  const documentedRegions = [...regionSection.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);

  assert.deepEqual([...new Set(documentedRegions)].sort(), [...new Set([...APP_REGIONS, ...AUTH_REGIONS])].sort());
  assert.deepEqual(documentedTokens.sort(), [...PUBLIC_TOKENS].sort());
  assert.match(guide, /\[Theme API v1 authoring reference\]\(docs\/theme-authoring\.md\)/);
});
