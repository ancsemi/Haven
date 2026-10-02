'use strict';

/**
 * Timestamps that follow the reader: <t:1780853820> / <t:1780853820:R>.
 *
 * Pinned to UTC and en-US so the expected strings are stable; the point of the
 * feature is that they are NOT stable across readers, which is exactly why the
 * test has to fix both.
 *
 *   node --test test/messageTimestamps.test.js
 */

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// _formatContent lives in app-message-content, the time helpers in app-utilities
// and the escaping helpers in app-context. The real app mixes them into one
// object, so the test does too.
const MODULES = ['app-utilities.js', 'app-message-content.js', 'app-context.js'].map(name => ({
  name,
  source: fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8'),
}));

// A fixed instant: Sunday 7 June 2026, 17:37:00 UTC.
const TS = 1780853820;

/** Enough of a DOM element for _escapeHtml (textContent in, innerHTML out). */
function fakeElement() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}

function loadApp() {
  const timers = [];
  const sandbox = {
    // These are only touched when a method runs.
    document: {
      documentElement: { lang: 'en-US' },
      querySelectorAll: () => [],
      createElement: () => fakeElement(),
    },
    navigator: { languages: ['en-US'] },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error,
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
  app.user = { id: 1, username: 'tester' };
  app.channels = [];
  app.channelMembers = [];
  app._nicknames = {};
  return { app, timers };
}

// ── rendering one token ───────────────────────────────────────────────────
test('every Discord style renders the same instant', () => {
  const { app } = loadApp();
  const text = (style) => {
    const html = app._formatTimestampToken(TS, style);
    return html.replace(/^.*?>([^<]*)<\/time>$/s, '$1');
  };
  assert.equal(text('t'), '5:37 PM');
  assert.equal(text('T'), '5:37:00 PM');
  assert.equal(text('d'), '6/7/26');
  assert.equal(text('D'), 'June 7, 2026');
  assert.equal(text('f'), 'June 7, 2026 at 5:37 PM');
  assert.equal(text('F'), 'Sunday, June 7, 2026 at 5:37 PM');
});

test('the element carries the machine-readable instant and a full title', () => {
  const { app } = loadApp();
  const html = app._formatTimestampToken(TS, 'f');
  assert.match(html, /^<time class="chat-timestamp"/);
  assert.match(html, /datetime="2026-06-07T17:37:00\.000Z"/);
  assert.match(html, new RegExp(`data-ts="${TS}"`));
  assert.match(html, /data-tstyle="f"/);
  // Hovering a bare time still tells you which day it is.
  assert.match(html, /title="Sunday, June 7, 2026 at 5:37:00 PM UTC"/);
});

test('relative style counts from now in both directions', () => {
  const { app } = loadApp();
  const now = Date.now();
  const soon = app._formatTimestampToken(Math.round(now / 1000) + 7200, 'R');
  const past = app._formatTimestampToken(Math.round(now / 1000) - 7200, 'R');
  assert.match(soon, />in 2 hours</);
  assert.match(past, />2 hours ago</);
});

test('relative style starts the ticker once, and only when used', () => {
  const { app, timers } = loadApp();
  app._formatTimestampToken(TS, 'f');
  assert.equal(timers.length, 0, 'an absolute timestamp needs no timer');
  app._formatTimestampToken(TS, 'R');
  app._formatTimestampToken(TS, 'R');
  assert.equal(timers.length, 1, 'one ticker, however many relative timestamps');
});

test('nonsense timestamps render nothing', () => {
  const { app } = loadApp();
  assert.equal(app._formatTimestampToken(Number.NaN, 'f'), null);
  assert.equal(app._formatTimestampToken(Number.POSITIVE_INFINITY, 'f'), null);
  assert.equal(app._formatTimestampToken(99999999999999, 'f'), null, 'beyond the range of a Date');
});

// ── the renderer ──────────────────────────────────────────────────────────
test('a token inside a message becomes a time element', () => {
  const { app } = loadApp();
  const html = app._formatContent(`meeting at <t:${TS}:t> everyone`);
  assert.match(html, /meeting at <time class="chat-timestamp"[^>]*>5:37 PM<\/time> everyone/);
});

test('a bare token defaults to the long date and time', () => {
  const { app } = loadApp();
  assert.match(app._formatContent(`<t:${TS}>`), />June 7, 2026 at 5:37 PM</);
});

test('a token inside a code fence stays literal', () => {
  const { app } = loadApp();
  const html = app._formatContent('```\n<t:' + TS + ':f>\n```');
  assert.ok(!html.includes('chat-timestamp'), 'no timestamp rendered inside the fence');
  assert.match(html, /&lt;t:1780853820:f&gt;/);
});

test('text that only looks like a token is left alone', () => {
  const { app } = loadApp();
  for (const bad of ['<t:>', '<t:abc:f>', '<t:123:Z>', '<time>']) {
    const html = app._formatContent(bad);
    assert.ok(!html.includes('chat-timestamp'), `${bad} must not render`);
  }
});

test('several tokens in one message all render', () => {
  const { app } = loadApp();
  const html = app._formatContent(`from <t:${TS}:t> to <t:${TS + 3600}:t>`);
  assert.equal((html.match(/chat-timestamp/g) || []).length, 2);
  assert.match(html, />5:37 PM</);
  assert.match(html, />6:37 PM</);
});

// ── /time ─────────────────────────────────────────────────────────────────
test('/time reads a clock time in the sender own timezone', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 12, 0, 0); // local noon
  const parsed = app._parseTimeExpression('8pm', now);
  const when = new Date(parsed.seconds * 1000);
  assert.equal(when.getHours(), 20);
  assert.equal(when.getMinutes(), 0);
  assert.equal(when.getDate(), 7, 'still today, 8pm has not happened yet');
  assert.equal(parsed.style, 'f');
});

test('/time rolls a time that already went by to tomorrow', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 21, 0, 0); // 9pm
  const when = new Date(app._parseTimeExpression('8pm', now).seconds * 1000);
  assert.equal(when.getDate(), 8, 'the next 8pm, not this morning');
  assert.equal(when.getHours(), 20);
});

test('/time understands the shapes people actually type', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 12, 0, 0);
  const at = (input) => new Date(app._parseTimeExpression(input, now).seconds * 1000);

  assert.equal(at('20:30').getHours(), 20);
  assert.equal(at('20:30').getMinutes(), 30);
  assert.equal(at('8:15 am').getHours(), 8);
  assert.equal(at('12am').getHours(), 0, 'midnight, not noon');
  assert.equal(at('12pm').getHours(), 12, 'noon, not midnight');
  assert.equal(at('tomorrow 9am').getDate(), 8);
  assert.equal(at('today 3pm').getDate(), 7);
  assert.equal(at('2026-09-06 20:30').getMonth(), 8);
  assert.equal(at('2026-09-06 20:30').getDate(), 6);
  assert.equal(at('+2h').getHours(), 14);
  assert.equal(at('90m').getHours(), 13);
  assert.equal(at('90m').getMinutes(), 30);
  assert.equal(at('1w').getDate(), 14);
  assert.equal(app._parseTimeExpression('1780853820', now).seconds, TS, 'a raw unix value passes through');
});

test('/time shows a date with no clock time as a date', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 12, 0, 0);
  assert.equal(app._parseTimeExpression('2026-09-06', now).style, 'D');
  assert.equal(app._parseTimeExpression('tomorrow', now).style, 'D');
  // Unless the sender asked for something else.
  assert.equal(app._parseTimeExpression('2026-09-06 R', now).style, 'R');
});

test('/time takes a trailing style letter', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 12, 0, 0);
  assert.equal(app._parseTimeExpression('8pm R', now).style, 'R');
  assert.equal(app._parseTimeExpression('8pm T', now).style, 'T');
  assert.equal(app._parseTimeExpression('8pm', now).style, 'f');
});

test('/time refuses what it cannot read', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 12, 0, 0);
  for (const bad of ['', '   ', 'next thursday', '25:00', '13pm', '2026-02-31 10:00', 'lunchtime']) {
    assert.equal(app._parseTimeExpression(bad, now), null, `${JSON.stringify(bad)} is not a time`);
  }
});

test('/time builds a token the renderer accepts', () => {
  const { app } = loadApp();
  const now = new Date(2026, 5, 7, 12, 0, 0);
  const token = app._buildTimeToken('8pm', now);
  assert.match(token, /^<t:\d{10}:f>$/);
  assert.match(app._formatContent(`see you at ${token}`), /chat-timestamp/);
  assert.equal(app._buildTimeToken('lunchtime', now), null);
});
