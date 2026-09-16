'use strict';

/**
 * Role mentions (#5579) and forum topic cues (#144).
 *
 *   node --test test/roleMentions.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { stripRoleMentions } = require('../src/socketHandlers/helpers');

// ── server side: the permission gate ──────────────────────────────────────
test('a role ping from someone without the permission keeps its text but loses its trigger', () => {
  const out = stripRoleMentions('hey @Moderators please look', ['Moderators', 'Minecraft']);
  assert.equal(out, 'hey @​Moderators please look');
  assert.ok(!/(?<![\w@])@Moderators/.test(out), 'the client-side mention regex no longer matches');
});

test('role names are matched whole, case-insensitively, and with spaces', () => {
  const roles = ['Game Night', 'Mods'];
  assert.equal(stripRoleMentions('@mods and @game night', roles), '@​mods and @​game night');
  assert.equal(stripRoleMentions('@Modsquad is not a role', roles), '@Modsquad is not a role');
  assert.equal(stripRoleMentions('mail me at a@mods.example', roles), 'mail me at a@mods.example');
});

test('nothing to strip leaves the message untouched', () => {
  assert.equal(stripRoleMentions('no pings here', ['Mods']), 'no pings here');
  assert.equal(stripRoleMentions('@Mods', []), '@Mods');
  assert.equal(stripRoleMentions(42, ['Mods']), 42);
});

// ── client side ───────────────────────────────────────────────────────────
const MODULES = ['app-utilities.js', 'app-context.js'].map(name => ({
  name,
  source: fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8'),
}));

function fakeElement() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}

function loadApp() {
  const sandbox = {
    document: { documentElement: { lang: 'en-US' }, querySelectorAll: () => [], createElement: () => fakeElement() },
    navigator: { languages: ['en-US'] },
    setInterval: () => 0,
    clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error, Map, Set,
    t: (key) => key,
    console,
  };
  const methods = {};
  for (const mod of MODULES) {
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(mod.source.replace(/^export default/m, 'module.exports ='), context, { filename: mod.name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app.user = { id: 1, username: 'tester', roles: [{ id: 7, name: 'Moderators', level: 50, color: '#3399ff' }] };
  app.channels = [];
  app.channelMembers = [{ id: 2, username: 'Alice', loginName: 'alice' }];
  app._nicknames = {};
  app._mentionableRoles = [
    { id: 7, name: 'Moderators', color: '#3399ff', level: 50 },
    { id: 8, name: 'Game Night', color: null, level: 0 },
  ];
  app.notifications = { roleMentionsEnabled: true };
  return app;
}

test('a message pinging one of my roles counts as a mention', () => {
  const app = loadApp();
  assert.equal(app._mentionsMyRole('paging @Moderators now'), true);
  assert.equal(app._mentionsMyRole('paging @moderators now'), true, 'case does not matter');
  assert.equal(app._mentionsMyRole('paging @Game Night'), false, 'not a role I hold');
  assert.equal(app._mentionsMyRole('@Moderatorsss'), false, 'whole word only');
  assert.equal(app._mentionsMyRole(''), false);
});

test('the per-user switch turns role pings into ordinary messages', () => {
  const app = loadApp();
  app.notifications.roleMentionsEnabled = false;
  assert.equal(app._mentionsMyRole('paging @Moderators now'), false);
});

test('@Role renders as a role mention, lit up for a holder', () => {
  const app = loadApp();
  const html = app._formatContent('paging @Moderators and @Game Night');
  assert.match(html, /<span class="mention mention-role mention-self" style="--role-color:#3399ff">@Moderators<\/span>/);
  assert.match(html, /<span class="mention mention-role">@Game Night<\/span>/, 'a role I do not hold is styled but not self');
});

test('a member who shares a role name wins over the role', () => {
  const app = loadApp();
  app.channelMembers.push({ id: 3, username: 'Moderators', loginName: 'moderators' });
  const html = app._formatContent('hi @Moderators');
  assert.match(html, /<span class="mention">@Moderators<\/span>/);
  assert.ok(!html.includes('mention-role'));
});

test('an unknown @name is left as plain text', () => {
  const app = loadApp();
  assert.equal(app._formatContent('hi @Nobody'), 'hi @Nobody');
});

// ── forum topic cues ──────────────────────────────────────────────────────
test('a forum topic with no replies still gets its reply button', () => {
  const app = loadApp();
  const html = app._renderThreadPreview(42, { count: 0 }, { forum: true });
  assert.match(html, /thread-preview thread-preview-empty/);
  assert.match(html, /data-thread-parent="42"/);
  assert.match(html, /thread_runtime\.reply_to_topic/);
});

test('outside a forum an empty thread renders nothing', () => {
  const app = loadApp();
  assert.equal(app._renderThreadPreview(42, { count: 0 }), '');
  assert.equal(app._renderThreadPreview(42, null, { forum: true }), '');
});
