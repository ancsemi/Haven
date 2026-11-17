'use strict';

/**
 * Moderator and admin actions that used to leave no trace now go on the
 * audit log: deleting someone else's message, pins, channel settings, the
 * whitelist, removing someone from a channel, and settings with the value
 * they had before.
 *
 *   node --test test/auditCoverage.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3504, 'audit-coverage');

test.before(() => h.start());
test.after(() => h.stop());

const latest = async (sock, action) => (await h.ask(sock, 'get-audit-log', { action })).rows[0];

test('moderator actions are on the audit log', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lobby'));
  A.emit('create-channel', { name: 'lobby' });
  const lobby = (await made).find((c) => c.name === 'lobby');
  B.emit('join-channel', { code: lobby.code });
  await wait(300);
  A.emit('enter-channel', { code: lobby.code });
  B.emit('enter-channel', { code: lobby.code });
  await wait(200);

  const sent = h.next(A, 'new-message', (d) => d && d.message && d.message.content === 'hello');
  B.emit('send-message', { code: lobby.code, content: 'hello' });
  const msg = (await sent).message;

  A.emit('pin-message', { messageId: msg.id, code: lobby.code });
  await wait(200);
  let row = await latest(A, 'message_pin');
  assert.ok(row, 'pin logged');
  assert.strictEqual(row.target_name, 'bob');
  assert.strictEqual(JSON.parse(row.details).channel, 'lobby');

  A.emit('delete-message', { messageId: msg.id, channelCode: lobby.code });
  await wait(200);
  row = await latest(A, 'message_delete');
  assert.ok(row, 'delete of someone else\'s message logged');
  assert.strictEqual(row.target_name, 'bob');

  A.emit('set-slow-mode', { code: lobby.code, interval: 10 });
  await wait(200);
  row = await latest(A, 'channel_setting_update');
  assert.deepStrictEqual(JSON.parse(row.details), { setting: 'slow_mode_seconds', value: 10 });
  assert.strictEqual(row.target_name, 'lobby');

  A.emit('whitelist-add', { username: 'carol' });
  await wait(200);
  assert.strictEqual((await latest(A, 'whitelist_add')).target_name, 'carol');

  A.emit('update-server-setting', { key: 'server_name', value: 'First' });
  await wait(150);
  A.emit('update-server-setting', { key: 'server_name', value: 'Second' });
  await wait(150);
  A.emit('update-server-setting', { key: 'server_name', value: 'Second' });
  await wait(150);
  const names = (await h.ask(A, 'get-audit-log', { action: 'server_setting_update' })).rows.filter((r) => r.target_name === 'server_name');
  assert.strictEqual(names.length, 2, 'saving the same value again adds nothing');
  assert.deepStrictEqual(JSON.parse(names[0].details), { key: 'server_name', from: 'First', value: 'Second' });

  const removed = await h.ask(A, 'remove-from-channel', { userId: bob.id, channelId: lobby.id });
  assert.ok(removed.success);
  row = await latest(A, 'channel_member_remove');
  assert.strictEqual(row.target_name, 'bob');
  assert.strictEqual(JSON.parse(row.details).channel, 'lobby');
});
