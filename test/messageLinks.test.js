'use strict';

// Links to a channel or message on this server (public/js/message-links.js):
// the forms the web client and the apps copy, and what opening one does once
// the server has said where the message lives. jumpPlan matches the apps'
// HavenShared HavenLinks.jump, so a link opens the same way on every platform.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parse, fromHash, fromSearch, jumpPlan } = require('../public/js/message-links.js');

const ORIGIN = 'https://chat.example.org';

test('the web Copy link forms', () => {
  for (const href of [
    '/app.html?channel=153f7fdf&message=99',
    '/app?channel=153f7fdf&message=99',
    '/?channel=153f7fdf&message=99',
    `${ORIGIN}/app.html?channel=153f7fdf&message=99`,
  ]) assert.deepEqual(parse(href, ORIGIN), { channel: '153f7fdf', message: 99 }, href);
});

test('the apps\' Copy link form (#CODE/ID and #CODE)', () => {
  assert.deepEqual(parse(`${ORIGIN}/#153f7fdf/20423`, ORIGIN), { channel: '153f7fdf', message: 20423 });
  assert.deepEqual(parse(`${ORIGIN}/#153F7FDF`, ORIGIN), { channel: '153f7fdf', message: 0 });
  assert.deepEqual(parse(`${ORIGIN}/app#153f7fdf/7/`, ORIGIN), { channel: '153f7fdf', message: 7 });
  assert.deepEqual(fromHash('#/153f7fdf/7'), { channel: '153f7fdf', message: 7 });
});

test('links that are not channel links are left alone', () => {
  assert.equal(parse('https://elsewhere.example/app.html?channel=153f7fdf&message=1', ORIGIN), null, 'another server');
  assert.equal(parse(`${ORIGIN}/uploads/a.png`, ORIGIN), null);
  assert.equal(parse(`${ORIGIN}/docs/?channel=153f7fdf`, ORIGIN), null, 'not the app page');
  assert.equal(fromHash('#connect=github:ok'), null, 'other app hashes');
  assert.equal(fromHash('#153f7fdf/abc'), null);
  assert.equal(fromHash('#153f7fdf/1/2'), null);
  assert.equal(fromSearch('?channel=bad code'), null);
  assert.deepEqual(fromSearch('?channel=153f7fdf&message=-4'), { channel: '153f7fdf', message: 0 });
});

test('jump plans', () => {
  assert.deepEqual(jumpPlan({ forum: false, around: 42 }), { scroll: 42, thread: 0, reply: 0 }, 'a channel message');
  assert.deepEqual(jumpPlan({ forum: false, around: 10, threadParent: 10, threadReply: 42 }), { scroll: 10, thread: 10, reply: 42 }, 'a thread reply');
  assert.deepEqual(jumpPlan({ forum: true, around: 7 }), { scroll: 0, thread: 7, reply: 0 }, 'a forum topic');
  assert.deepEqual(jumpPlan({ forum: true, around: 7, threadParent: 7, threadReply: 9 }), { scroll: 0, thread: 7, reply: 9 }, 'a forum reply');
  assert.deepEqual(jumpPlan({ forum: true, around: 0 }), { scroll: 0, thread: 0, reply: 0 });
  assert.deepEqual(jumpPlan({ forum: false, around: 5, threadParent: 5, threadReply: 5 }), { scroll: 5, thread: 5, reply: 0 });
});

// The app wiring: both pages load the helper, and the app hands a jump's
// history to the thread opener only for a jump it asked for.
test('the pages load the helpers before the code that uses them', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(app.indexOf('/js/message-links.js') > -1 && app.indexOf('/js/message-links.js') < app.indexOf('/js/app.js'));
  assert.ok(app.indexOf('/js/notify-preview.js') > -1 && app.indexOf('/js/notify-preview.js') < app.indexOf('/js/app.js'));
  assert.ok(index.indexOf('/js/message-links.js') > -1 && index.indexOf('/js/message-links.js') < index.indexOf('/js/auth.js'));
  const channels = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-socket-channels.js'), 'utf8');
  assert.match(channels, /if \(ours\) this\._afterJumpHistory\(data\);/);
  assert.match(channels, /this\._runPendingLinkJump\(data\.channelCode\);/);
});
