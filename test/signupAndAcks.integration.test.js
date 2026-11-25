'use strict';

/**
 * A sign-up goes on the audit log, named by id and username. ban-user,
 * get-user-profile and get-user-roles answer a callback when given one, so a
 * bot does not have to match toasts or listen for a separate event; the app's
 * events and toasts are sent as before.
 *
 *   node --test test/signupAndAcks.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3662, 'signup-acks');

test.before(() => h.start());
test.after(() => h.stop());

test('sign-ups are logged, and profile, roles and ban answer a callback', async () => {
  const admin = await h.register('admin');
  const hank = await h.register('hanksix');
  const ivy = await h.register('ivysix');
  const A = await h.connect(admin.token);
  const I = await h.connect(ivy.token);

  const signups = (await h.ask(A, 'get-audit-log', { action: 'user_register' })).rows;
  assert.deepStrictEqual(signups.map((r) => r.target_id), [ivy.id, hank.id, admin.id]);
  assert.strictEqual(signups[0].actor_id, ivy.id);
  assert.strictEqual(signups[0].actor_username, 'ivysix');
  assert.deepStrictEqual(JSON.parse(signups[0].details), { userId: ivy.id, username: 'ivysix' });

  const profile = await h.ask(A, 'get-user-profile', { userId: hank.id });
  assert.strictEqual(profile.id, hank.id);
  assert.strictEqual(profile.username, 'hanksix');
  assert.ok(profile.createdAt);
  assert.ok(Array.isArray(profile.roles));
  assert.match((await h.ask(A, 'get-user-profile', { userId: 999999 })).error, /not found/);

  const roles = await h.ask(A, 'get-user-roles', { userId: hank.id });
  assert.strictEqual(roles.userId, hank.id);
  assert.ok(roles.roles.some((r) => r.name === 'Member'));
  assert.ok((await h.ask(A, 'get-user-roles', {})).error);

  // A member without ban permission is refused, with the toast as before.
  const toast = h.next(I, 'error-msg');
  assert.match((await h.ask(I, 'ban-user', { userId: hank.id })).error, /permission/);
  assert.match(await toast, /permission/);
  assert.ok((await h.ask(A, 'ban-user', { userId: 'x' })).error);

  const banned = await h.ask(A, 'ban-user', { userId: hank.id, reason: 'spam', banIp: true });
  assert.strictEqual(banned.success, true);
  assert.strictEqual(typeof banned.ipBanned, 'number');
  const ban = (await h.ask(A, 'get-audit-log', { action: 'user_ban' })).rows[0];
  assert.strictEqual(ban.target_id, hank.id);
});
