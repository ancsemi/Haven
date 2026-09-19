'use strict';

/**
 * Sidebar condensation: + menu, DM dock, thread badge.
 *
 *   node --test test/sidebarChrome.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const channels = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-channels.js'), 'utf8');
const utilities = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-utilities.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-messages.js'), 'utf8');

test('channels header has a + menu with join, create, and temp', () => {
  assert.match(html, /id="channel-actions-btn"/);
  assert.match(html, /id="channel-actions-menu"/);
  assert.match(html, /data-action="join"/);
  assert.match(html, /data-action="create"/);
  assert.match(html, /data-action="temp"/);
  assert.match(html, /class="[^"]*channel-action-sheet/);
  assert.match(channels, /_openChannelAction\(/);
  assert.match(channels, /_setChannelActionPerm\(/);
  assert.match(channels, /no_create_perm/);
  assert.doesNotMatch(channels, /list\.appendChild\(tempBtn\)/);
});

test('DMs dock on a bottom button and hide the split handle', () => {
  assert.match(html, /id="dm-dock-btn"/);
  assert.match(html, /chrome-chip/);
  assert.match(html, /id="channel-actions-btn"/);
  assert.match(html, /id="search-toggle-btn"/);
  assert.match(css, /\.sidebar\.dms-open \.sidebar-split \.dm-section-pane/);
  assert.match(css, /\.sidebar-split-handle,\s*\n\.sidebar-split-handle:hover/);
  assert.match(channels, /_bindDmDock\(/);
  assert.match(channels, /querySelectorAll\('\.dm-unread-count'\)/);
});

test('theme and activities chips match the DM button size', () => {
  assert.match(html, /id="theme-popup-toggle"[^>]*chrome-chip/);
  assert.match(html, /id="activities-btn"[^>]*chrome-chip|chrome-chip"[^>]*id="activities-btn"/);
  assert.match(css, /#theme-popup-toggle\.chrome-chip/);
  assert.match(css, /#activities-btn\.chrome-chip/);
});

test('DM dock unread badge is a red counter', () => {
  assert.match(html, /id="dm-unread-badge"/);
  assert.match(css, /#dm-unread-badge\s*\{[^}]*--danger/);
  assert.match(channels, /badge\.id === 'dm-unread-badge'/);
});

test('thread mentions badge on the threads icon', () => {
  assert.match(html, /id="threads-toggle-badge"/);
  assert.match(utilities, /threads-toggle-badge/);
  assert.match(css, /\.header-icon-badge/);
});

test('Braid tucks header extras and matches composer chips to the footer', () => {
  const braid = fs.readFileSync(path.join(ROOT, 'plugins/BraidLayout.plugin.js'), 'utf8');
  assert.match(braid, /#header-actions-box\{display:none!important\}/);
  assert.match(braid, /\.input-actions-box button[\s\S]*width:2\.5rem!important/);
  assert.match(braid, /\.message-input-area,\s*\nhtml\[data-braid-layout="1"\] \.message-input-container\{[^}]*padding:\.5rem \.625rem!important/);
  assert.match(braid, /#theme-popup-toggle,\s*\nhtml\[data-braid-layout="1"\] #activities-btn\{[^}]*width:2\.5rem!important;height:2\.5rem!important/);
  assert.match(braid, /not\(#people-dock-btn\):not\(#dm-dock-btn\):not\(#theme-popup-toggle\):not\(#activities-btn\)/);
  assert.match(braid, /haven_braid_people/);
  assert.match(braid, /server-icon\.add-server/);
  assert.match(braid, /#braid-voice-dock \.voice-bar\{display:flex/);
});

test('home server icon opens a settings menu', () => {
  assert.match(html, /id="home-server-menu"/);
  assert.match(html, /data-home-action="app-settings"/);
  assert.match(html, /data-home-action="server-settings"/);
  const ui = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-ui.js'), 'utf8');
  assert.match(ui, /_bindHomeServerMenu\(/);
  assert.match(ui, /_openSettingsModal\s*=\s*openSettingsModal/);
  assert.match(css, /\.home-server-menu\s*\{/);
});

test('channel rows have a join-voice button', () => {
  assert.match(channels, /data-join-voice/);
  assert.match(channels, /channel-join-voice/);
  const voice = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-voice.js'), 'utf8');
  assert.match(voice, /_syncChannelVoiceButtons\(/);
  assert.match(css, /\.channel-join-voice\s*\{/);
});

test('footer has people and DM chips; header has no join-voice menu', () => {
  assert.match(html, /id="people-dock-btn"/);
  assert.match(html, /id="dm-dock-btn"/);
  assert.doesNotMatch(html, /id="people-hub-menu"/);
  assert.doesNotMatch(html, /data-action="join-voice"/);
  const ui = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-ui.js'), 'utf8');
  assert.match(ui, /_showConfirmModal\(t\('confirm.leave_channel'/);
  assert.match(ui, /_showConfirmModal\(t\('confirm.remove_server'/);
  assert.match(ui, /people-dock-btn/);
  assert.doesNotMatch(ui, /data-action="join-voice"/);
  assert.match(css, /#add-server-btn,/);
  assert.match(css, /#people-dock-btn\[aria-pressed="true"\]/);
  assert.match(css, /\.channel-join-voice\.is-leave/);
  const voice = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-voice.js'), 'utf8');
  assert.match(voice, /is-leave/);
  assert.match(channels, /_leaveVoice\(\)/);
});

test('Theme menu can restore the original Haven chrome', () => {
  assert.match(html, /id="original-layout-toggle"/);
  assert.match(html, /app\.theme\.original_layout/);
  const theme = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');
  const themeInit = fs.readFileSync(path.join(ROOT, 'public/js/theme-init.js'), 'utf8');
  const voice = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-voice.js'), 'utf8');
  assert.match(theme, /function _setOriginalLayout/);
  assert.match(theme, /haven_original_layout/);
  assert.match(theme, /window\.setHavenOriginalLayout/);
  assert.match(themeInit, /data-haven-original-layout/);
  assert.match(css, /html:not\(\[data-haven-original-layout\]\) #voice-join-btn/);
  assert.match(css, /html\[data-haven-original-layout\] \.channel-join-voice/);
  assert.match(css, /html\[data-haven-original-layout\] #people-dock-btn/);
  assert.match(voice, /isHavenOriginalLayout/);
  assert.match(voice, /haven:original-layout/);
});

test('Braid message runs key on username, not only user id', () => {
  const braid = fs.readFileSync(path.join(ROOT, 'plugins/BraidLayout.plugin.js'), 'utf8');
  assert.match(braid, /dataset\.username/);
  assert.match(braid, /dataset\.webhookUsername/);
  assert.match(braid, /dataset\.importedFrom/);
  assert.match(messages, /dataset\.webhookUsername = msg\.webhook_username/);
  assert.doesNotMatch(braid, /\$\{el\.dataset\.userId \|\| '\?'\}\|\$\{el\.dataset\.personaId \|\| ''\}`/);
});
