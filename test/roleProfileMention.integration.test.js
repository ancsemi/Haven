'use strict';

/**
 * Two per-role switches (#5822). A role switched off for profile cards is
 * left off everyone's view of a profile except role managers, who see it
 * marked. A role switched off for mentions says so in the role list, which
 * is what keeps it out of the @ list.
 *
 *   node --test test/roleProfileMention.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3507, 'role-profile-mention');

test.before(() => h.start());
test.after(() => h.stop());

const profileOf = (sock, userId) => {
  const got = h.next(sock, 'user-profile', (p) => p && p.id === userId);
  sock.emit('get-user-profile', { userId });
  return got;
};

test('cosmetic roles can stay off profile cards and out of @mentions', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const C = await h.connect(carol.token);

  const made = await h.ask(A, 'create-role', { name: 'Gamer', level: 2, permissions: [] });
  assert.ok(made.roleId);
  assert.ok((await h.ask(A, 'assign-role', { userId: bob.id, roleId: made.roleId })).success);
  assert.ok((await h.ask(A, 'update-role', { roleId: made.roleId, mentionable: false, showOnProfile: false })).success);

  const asCarol = await profileOf(C, bob.id);
  assert.ok(!asCarol.roles.some((r) => r.name === 'Gamer'), 'members do not see it on the card');
  const asAdmin = await profileOf(A, bob.id);
  const seen = asAdmin.roles.find((r) => r.name === 'Gamer');
  assert.ok(seen && seen.hiddenOnProfile, 'role managers see it, marked');

  const roles = (await h.ask(C, 'get-roles', {})).roles;
  assert.strictEqual(roles.find((r) => r.name === 'Gamer').mentionable, 0);

  const log = (await h.ask(A, 'get-audit-log', { action: 'role_update' })).rows[0];
  assert.deepStrictEqual(JSON.parse(log.details), { mentionable: false, showOnProfile: false });
});
