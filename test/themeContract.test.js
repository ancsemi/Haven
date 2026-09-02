'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseThemeMetadata } = require('../src/themeMetadata');

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

function cssRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  const rules = [];
  let tokenStart = 0;

  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') {
      const prelude = source.slice(tokenStart, i).trim();
      const entry = prelude.startsWith('@')
        ? { type: 'at-rule', prelude }
        : {
            type: 'rule',
            selector: prelude,
            bodyStart: i + 1,
            atRules: stack.filter(item => item.type === 'at-rule').map(item => item.prelude),
          };
      stack.push(entry);
      tokenStart = i + 1;
      continue;
    }
    if (source[i] === '}') {
      const entry = stack.pop();
      if (entry?.type === 'rule') {
        entry.declarations = source.slice(entry.bodyStart, i);
        rules.push(entry);
      }
      tokenStart = i + 1;
      continue;
    }
    if (source[i] === ';') tokenStart = i + 1;
  }
  return rules;
}

function declarationNames(block) {
  return [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/gi)].map(match => match[1]);
}

function declarationMap(block) {
  return Object.fromEntries(
    [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/gi)]
      .map(match => [match[1], match[2].trim()])
  );
}

function contrastRatio(first, second) {
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
    const linear = channels.map(value => value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const APP_REGIONS = [
  'app-shell',
  'workspace',
  'server-rail',
  'server-list',
  'navigation-sidebar',
  'account',
  'sidebar-content',
  'join-channel',
  'create-channel',
  'channels',
  'direct-messages',
  'sidebar-footer',
  'sidebar-actions',
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
  '--success-text',
  '--danger',
  '--danger-text',
  '--warning',
  '--warning-text',
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
  'server-list': 'server-list',
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

test('the Compact theme stays inside the Theme API v1 contract', () => {
  const theme = read('themes/compact.theme.css');
  const metadata = parseThemeMetadata(theme);
  const properties = declaredProperties(theme);
  const rules = cssRules(theme);
  const regions = new Set();
  const pages = new Set();
  const publicRegions = new Set([...APP_REGIONS, ...AUTH_REGIONS]);
  const geometryProperties = new Set([
    'align-content', 'align-items', 'align-self', 'bottom', 'column-gap',
    'display', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow',
    'flex-shrink', 'flex-wrap', 'gap', 'grid', 'grid-area', 'grid-auto-columns',
    'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end',
    'grid-column-gap', 'grid-column-start', 'grid-gap', 'grid-row',
    'grid-row-end', 'grid-row-gap', 'grid-row-start', 'grid-template',
    'grid-template-areas', 'grid-template-columns', 'grid-template-rows',
    'height', 'inset', 'inset-block', 'inset-block-end', 'inset-block-start',
    'inset-inline', 'inset-inline-end', 'inset-inline-start', 'justify-content',
    'justify-items', 'justify-self', 'left', 'margin', 'margin-block',
    'margin-block-end', 'margin-block-start', 'margin-inline',
    'margin-inline-end', 'margin-inline-start', 'max-height', 'max-width',
    'min-height', 'min-width', 'order', 'overflow', 'overflow-x', 'overflow-y',
    'padding', 'padding-block', 'padding-block-end', 'padding-block-start',
    'padding-inline', 'padding-inline-end', 'padding-inline-start',
    'place-content', 'place-items', 'place-self', 'position', 'right',
    'row-gap', 'top', 'transform', 'translate', 'width', 'z-index'
  ]);
  const geometryTokens = new Set(['--right-width', '--sidebar-width']);

  assert.equal(metadata.name, 'Compact');
  assert.equal(metadata.themeApi, 1);
  assert.equal(metadata.compatibility, 'compatible');
  assert.match(theme, /@media\s*\(min-width:\s*901px\)/);
  assert.doesNotMatch(theme, /--msg-(?:pad|avatar|gap|gutter)/);
  assert.doesNotMatch(theme, /!important/);

  for (const property of properties) {
    assert.ok(PUBLIC_TOKENS.includes(property), `Compact uses non-public token ${property}`);
  }
  for (const token of theme.matchAll(/var\((--[a-z0-9-]+)/gi)) {
    assert.ok(PUBLIC_TOKENS.includes(token[1]), `Compact reads non-public token ${token[1]}`);
  }

  for (const rule of rules) {
    const names = declarationNames(rule.declarations);
    if (names.some(name => geometryTokens.has(name))) {
      assert.ok(
        rule.atRules.some(atRule => /^@media\s*\(min-width:\s*901px\)$/.test(atRule)),
        'Compact geometry tokens must only change at the desktop breakpoint'
      );
    }
    for (const selector of rule.selector.split(',').map(value => value.trim())) {
      if (selector === ':root') continue;
      if (selector === 'html[data-haven-theme-api="1"]') continue;
      const match = selector.match(/^html\[data-haven-theme-api="1"\] body\[data-haven-page="(app|auth)"\] \[data-haven-region="([a-z-]+)"\]$/);
      assert.ok(match, `Compact uses selector outside Theme API v1: ${selector}`);
      pages.add(match[1]);
      regions.add(match[2]);
      assert.ok(publicRegions.has(match[2]), `Compact uses non-public region ${match[2]}`);

      if (match[1] === 'app' && names.some(name => geometryProperties.has(name))) {
        assert.ok(
          rule.atRules.some(atRule => /^@media\s*\(min-width:\s*901px\)$/.test(atRule)),
          `Compact changes app geometry outside the desktop breakpoint: ${selector}`
        );
      }
      if (match[2] === 'message-list') {
        assert.ok(
          !names.some(name => ['column-gap', 'gap', 'row-gap'].includes(name)),
          'Compact must preserve message-list density'
        );
      }
    }
  }
  assert.deepEqual([...pages].sort(), ['app', 'auth']);
  assert.ok(regions.size > 0);
});

test('core semantic fills use their paired foreground tokens', () => {
  const tokenPairs = new Map([
    ['--accent', '--accent-text'],
    ['--accent-hover', '--accent-text'],
    ['--success', '--success-text'],
    ['--danger', '--danger-text'],
    ['--warning', '--warning-text']
  ]);
  const fixedMediaForegrounds = new Set([
    'music.css:.music-search-picker-more',
    'music.css:.music-search-picker-play'
  ]);
  const statePairs = [
    ['style.css', '.update-banner:hover', '--accent-text'],
    ['style.css', '.image-queue-remove:hover', '--danger-text'],
    ['style.css', '.ferry-step-done .ferry-step-num', '--success-text']
  ];
  const cssDirectory = path.join(ROOT, 'public/css');
  const stylesheets = fs.readdirSync(cssDirectory).filter(file => file.endsWith('.css'));
  const rulesByStylesheet = new Map();

  for (const stylesheet of stylesheets) {
    const rules = cssRules(fs.readFileSync(path.join(cssDirectory, stylesheet), 'utf8'));
    rulesByStylesheet.set(stylesheet, rules);
    for (const rule of rules) {
      const declarations = declarationMap(rule.declarations);
      const background = declarations.background || declarations['background-color'];
      if (!background || !declarations.color) continue;

      for (const [fill, foreground] of tokenPairs) {
        const fillPattern = new RegExp(`var\\(${fill}(?=[,)])`);
        const isDirectFill = new RegExp(`^var\\(${fill}(?=[,)])`).test(background);
        const isGradientFill = /^(?:linear|radial)-gradient\(/.test(background) && fillPattern.test(background);
        if (!isDirectFill && !isGradientFill) continue;
        const ruleKey = `${stylesheet}:${rule.selector}`;
        if (fixedMediaForegrounds.has(ruleKey)) {
          assert.equal(declarations.color, '#000', `${ruleKey} must preserve its compatible media foreground`);
          continue;
        }
        assert.match(
          declarations.color,
          new RegExp(`var\\(${foreground}(?=[,)])`),
          `${stylesheet}: ${rule.selector} must pair ${fill} with ${foreground}`
        );
      }
    }
  }

  for (const [stylesheet, selector, foreground] of statePairs) {
    const rule = rulesByStylesheet.get(stylesheet).find(candidate => candidate.selector === selector);
    assert.ok(rule, `${stylesheet}: missing semantic state ${selector}`);
    assert.match(
      declarationMap(rule.declarations).color || '',
      new RegExp(`var\\(${foreground}(?=[,)])`),
      `${stylesheet}: ${selector} must use ${foreground}`
    );
  }
});

test('the Compact palette keeps status text and filled controls readable', () => {
  const theme = read('themes/compact.theme.css');
  const rootRule = cssRules(theme).find(rule => rule.selector === ':root' && rule.atRules.length === 0);
  assert.ok(rootRule, 'Compact is missing its root token rule');
  const colors = Object.fromEntries(
    [...rootRule.declarations.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)]
      .map(match => [match[1], match[2]])
  );

  const tokenPairs = [
    ['--accent', '--accent-text'],
    ['--accent-hover', '--accent-text'],
    ['--success', '--success-text'],
    ['--danger', '--danger-text'],
    ['--warning', '--warning-text']
  ];
  for (const [fill, foreground] of tokenPairs) {
    assert.ok(contrastRatio(colors[fill], colors[foreground]) >= 4.5, `${fill} fails filled-control contrast`);
  }
  for (const token of ['--accent', '--success', '--danger', '--warning']) {
    assert.ok(contrastRatio(colors[token], colors['--bg-secondary']) >= 4.5, `${token} fails secondary-surface contrast`);
    assert.ok(contrastRatio(colors[token], colors['--bg-card']) >= 4.5, `${token} fails card-surface contrast`);
  }
  assert.ok(contrastRatio(colors['--text-muted'], colors['--bg-secondary']) >= 4.5);
  assert.ok(contrastRatio(colors['--text-muted'], colors['--bg-card']) >= 4.5);
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
