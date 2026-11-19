'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'notifications.js'), 'utf8');

function manager(status) {
  const window = { app: { userStatus: status } };
  const NotificationManager = vm.runInNewContext(`${source}\nNotificationManager`, { window, localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null }, console });
  const m = new NotificationManager();
  m.enabled = true;
  const heard = [];
  for (const s of ['ping', 'bell', 'chime', 'drop', 'swoosh', 'announcement']) m[s] = () => heard.push(s);
  return { m, heard };
}

test('Do Not Disturb silences incoming message, mention, reply, join and leave sounds', () => {
  const { m, heard } = manager('dnd');
  m.play('message');
  m.play('message', { isDm: true });
  m.play('mention', { isMention: true });
  m.play('reply', { isReply: true });
  m.play('join');
  m.play('leave');
  m.play('announcement');
  assert.deepEqual(heard, []);
});

test('Do Not Disturb still plays your own send sound and a sound picked in Settings', () => {
  const { m, heard } = manager('dnd');
  m.play('sent');
  m.play('mention', { preview: true });
  assert.deepEqual(heard, ['swoosh', 'bell']);
});

test('every other status keeps sounding', () => {
  for (const status of ['online', 'away', 'invisible']) {
    const { m, heard } = manager(status);
    m.play('message');
    m.play('mention', { isMention: true });
    assert.deepEqual(heard, ['ping', 'bell'], status);
  }
});
