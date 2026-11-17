'use strict';

/**
 * Editing a role leaves an audit entry that says what changed: the
 * permissions added and removed, not the whole list, and which role lost
 * being the one new members get.
 *
 *   node --test test/roleUpdateAudit.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3503, 'role-update-audit');

test.before(() => h.start());
test.after(() => h.stop());

test('a role edit logs only what changed', async () => {
  const admin = await h.register('admin');
  const A = await h.connect(admin.token);
  const made = await h.ask(A, 'create-role', { name: 'Helper', level: 10, permissions: ['use_voice', 'upload_files'] });
  assert.ok(made.roleId);

  assert.ok((await h.ask(A, 'update-role', { roleId: made.roleId, permissions: ['use_voice', 'ban_user'] })).success);
  let log = await h.ask(A, 'get-audit-log', { action: 'role_update' });
  let details = JSON.parse(log.rows[0].details);
  assert.deepStrictEqual(details, { added: ['ban_user'], removed: ['upload_files'] });

  assert.ok((await h.ask(A, 'update-role', { roleId: made.roleId, autoAssign: true, name: 'Greeter' })).success);
  log = await h.ask(A, 'get-audit-log', { action: 'role_update' });
  details = JSON.parse(log.rows[0].details);
  assert.deepStrictEqual(details, { name: { from: 'Helper', to: 'Greeter' }, autoAssign: true, autoAssignTakenFrom: 'Member' });

  // Saving without changing anything adds no entry.
  assert.ok((await h.ask(A, 'update-role', { roleId: made.roleId, permissions: ['use_voice', 'ban_user'] })).success);
  assert.strictEqual((await h.ask(A, 'get-audit-log', { action: 'role_update' })).rows.length, 2);
});
