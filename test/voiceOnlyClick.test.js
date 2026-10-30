'use strict';

/**
 * One click on a voice-only channel (voice on, text and media off) joins its
 * voice, as on Discord. Other channels still need the double-click.
 *
 *   node --test test/voiceOnlyClick.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-channels.js'), 'utf8');

function app(channels, user = { isAdmin: false }, perms = ['use_voice']) {
  const context = vm.createContext({ module: { exports: {} }, console, t: (k) => k, document: {}, localStorage: {}, window: {} });
  vm.runInContext(SRC.replace(/^export default/m, 'module.exports ='), context);
  const a = Object.create(context.module.exports);
  a.channels = channels;
  a.user = user;
  a.serverSettings = {};
  a._hasPerm = (p) => perms.includes(p);
  return a;
}

test('only voice on, text and media off, counts as voice-only', () => {
  const a = app([
    { code: 'voiceonl', voice_enabled: 1, text_enabled: 0, media_enabled: 0 },
    { code: 'standard', voice_enabled: 1, text_enabled: 1, media_enabled: 1 },
    { code: 'mediavoi', voice_enabled: 1, text_enabled: 0, media_enabled: 1 },
    { code: 'nothing0', voice_enabled: 0, text_enabled: 0, media_enabled: 0 },
    { code: 'dmdmdmdm', is_dm: 1, voice_enabled: 1, text_enabled: 0, media_enabled: 0 },
  ]);
  assert.equal(a._isVoiceOnlyChannel('voiceonl'), true);
  for (const code of ['standard', 'mediavoi', 'nothing0', 'dmdmdmdm', 'missing0']) {
    assert.equal(a._isVoiceOnlyChannel(code), false, code);
  }
});

test('the click joins only for someone allowed to use voice', () => {
  assert.equal(app([], { isAdmin: false }, ['use_voice'])._canUseVoice(), true);
  assert.equal(app([], { isAdmin: false }, [])._canUseVoice(), false);
  assert.equal(app([], { isAdmin: true }, [])._canUseVoice(), true);
  const guest = app([], { isGuest: true }, []);
  assert.equal(guest._canUseVoice(), true);
  guest.serverSettings = { guests_allow_voice: 'false' };
  assert.equal(guest._canUseVoice(), false);
});

test('the channel click joins a voice-only channel unless already in its voice', () => {
  const click = SRC.slice(SRC.indexOf("el.addEventListener('click', () => {\n      // Clicking the forum"), SRC.indexOf("// Right-click to open context menu"));
  assert.match(click, /this\._isVoiceOnlyChannel\(ch\.code\) && this\._canUseVoice\(\)/);
  assert.match(click, /!\(this\.voice\?\.inVoice && this\.voice\.currentChannel === ch\.code\)/);
  assert.match(click, /if \(this\._isVoiceOnlyChannel\(ch\.code\)\) return;/, 'the double-click does not join a second time');
});
