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

test('Do Not Disturb also holds back the desktop pop-up, and the other statuses still show it', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-channel-unread.js')).href)).default;
  const shown = [];
  global.window = { havenDesktop: { notify: (title) => shown.push(title) } };
  global.localStorage = { getItem: () => null };
  global.t = (key) => key;
  const ctx = (userStatus) => ({ userStatus, channels: [], user: { id: 1 }, _mutedUserIds: () => new Set(), _notifyBlockedByMutes: () => false, _getNickname: (id, name) => name, _maskSpoilers: (t) => t, notifications: { mentionsEnabled: true, repliesEnabled: true, dmEnabled: true, enabled: true, popupAllowed: () => true } });
  for (const status of ['dnd', 'online']) mod._fireNativeNotification.call(ctx(status), { user_id: 2, username: 'bob', content: 'hi' }, 'abc', {});
  assert.equal(shown.length, 1);
  delete global.window;
  delete global.localStorage;
  delete global.t;
});
