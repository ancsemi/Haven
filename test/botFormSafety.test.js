'use strict';

// A bot's form looks like any Haven dialog, so it names its bot and says
// where the answers go, and what it says cannot carry invisible or
// text-direction characters. The source holds those characters as visible
// escapes only, so a reviewer can read every filter.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const botComponents = require('../src/botComponents');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const box = (over = {}) => ({ type: 1, components: [{ type: 4, custom_id: 'a', label: 'Name', style: 1, ...over }] });
const form = (over = {}, input = {}) => botComponents.cleanModal({ custom_id: 'f', title: 'Sign up', components: [box(input)], ...over }, 2000);

test('a form\'s title, labels and placeholders refuse invisible and text-direction characters', () => {
  assert.equal(form().error, undefined);
  for (const bad of ['Pass‮word', 'a​b', 'x⁦y', 'tag\u{E0041}']) {
    assert.match(String(form({ title: bad }).error), /invisible or unsupported/, 'title');
    assert.match(String(form({}, { label: bad }).error), /invisible or unsupported/, 'label');
    assert.match(String(form({}, { placeholder: bad }).error), /invisible or unsupported/, 'placeholder');
  }
});

test('the form sent to a member names the bot, and the dialog shows it with a warning', () => {
  const server = read('src/socketHandlers/botInteractions.js');
  assert.match(server, /target\.emit\('bot-modal', \{ formId, from: click\.from \|\| '', title: modal\.title, components: modal\.components \}\);/);
  assert.match(server, /from: botName\(msg\) \};/);
  const client = read('public/js/modules/app-bot-components.js');
  assert.match(client, /class="bot-modal-from">\$\{esc\(t\('bot_parts\.modal_from'/);
  assert.match(client, /class="bot-modal-note">\$\{esc\(t\('bot_parts\.modal_warning'/);
  const en = JSON.parse(read('public/locales/en.json').replace(/^﻿/, ''));
  assert.match(en.bot_parts.modal_from, /\{\{name\}\}/);
  assert.match(en.bot_parts.modal_warning, /Never enter a password/);
  assert.ok(en.bot_parts.modal_a_bot);
});

test('the filters hold no raw invisible characters', () => {
  const HIDDEN = /[­؜​-‏‪-‮⁠-⁩︀-️﻿]/;
  for (const rel of ['src/botComponents.js', 'test/botComponents.test.js']) {
    assert.equal(HIDDEN.test(read(rel).replace(/^﻿/, '')), false, rel);
  }
  const line = read('public/js/modules/app-message-content.js').split('\n').find(l => l.includes('str.replace(/[\\u0000-\\u0008'));
  assert.ok(line, 'the display filter is there');
  assert.equal(HIDDEN.test(line), false);
  assert.ok(line.includes('\\u202A-\\u202E\\u2066-\\u2069'));
});
