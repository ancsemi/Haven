'use strict';

/**
 * Links in encrypted DMs are checked by each reader's browser, which used to
 * mark an admin's links blocked even though the server lets them through.
 * The channel list now says who in a DM skips the link filter: admins, and
 * anyone at or above "Skip filtering at role level".
 *
 *   node --test test/dmLinkExempt.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3508, 'dm-link-exempt');

test.before(() => h.start());
test.after(() => h.stop());

test('a DM names who skips the link filter', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  A.emit('update-server-setting', { key: 'automod_enabled', value: 'true' });
  await wait(200);

  const opened = h.next(A, 'dm-opened');
  A.emit('start-dm', { targetUserId: bob.id });
  const dm = await opened;
  assert.ok(dm && dm.code);
  await wait(300);
  const list = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === dm.code));
  A.emit('get-channels');
  const ch = (await list).find((c) => c.code === dm.code);
  assert.deepStrictEqual(ch.link_exempt_ids, [admin.id], 'the admin, not bob');

  // Bob reaches the exempt level through a role.
  const roles = (await h.ask(A, 'get-roles', {})).roles;
  const mod = roles.find((r) => r.name === 'Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: bob.id, roleId: mod.id })).success);
  const again = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === dm.code));
  A.emit('get-channels');
  const ch2 = (await again).find((c) => c.code === dm.code);
  assert.deepStrictEqual([...ch2.link_exempt_ids].sort((x, y) => x - y), [admin.id, bob.id].sort((x, y) => x - y), 'a Mod (level 50) skips it too');
});
