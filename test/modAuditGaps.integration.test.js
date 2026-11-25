'use strict';

/**
 * Moderation that left no audit row now leaves one: a note on a member and a
 * member deleting their own account. Rows that make a history record carry
 * its id, so a bot keeping its own copy can match a later revoke. A note is
 * never shown to the member it is about, even one who can read the log.
 *
 *   node --test test/modAuditGaps.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3660, 'mod-audit-gaps');

test.before(() => h.start());
test.after(() => h.stop());

const rows = async (sock, action) => (await h.ask(sock, 'get-audit-log', { action })).rows;

test('notes, self-deletes and history ids are on the audit log', async () => {
  const admin = await h.register('admin');
  const mod = await h.register('modfour');
  const bob = await h.register('bobfour');
  const carol = await h.register('carolfour');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: roles.find((r) => r.name === 'Mod').id })).success);

  // A moderator's note on a member: text and record id on the row.
  const noted = await h.ask(M, 'add-mod-note', { userId: bob.id, text: 'keeps posting links' });
  assert.ok(noted.ok);
  let row = (await rows(A, 'user_note'))[0];
  assert.strictEqual(row.target_id, bob.id);
  assert.strictEqual(row.actor_username, 'modfour');
  assert.deepStrictEqual(JSON.parse(row.details), { note: 'keeps posting links', caseId: noted.id });

  // The admin's note on the moderator, and taking it back: the moderator
  // reads the log but sees neither row about themselves.
  const onMod = await h.ask(A, 'add-mod-note', { userId: mod.id, text: 'slow to answer reports' });
  assert.ok(onMod.ok);
  assert.ok((await h.ask(A, 'revoke-mod-case', { id: onMod.id })).ok);
  assert.strictEqual((await rows(A, 'user_note')).length, 2);
  assert.strictEqual((await rows(A, 'mod_case_revoke')).length, 1);
  const modNotes = await rows(M, 'user_note');
  assert.deepStrictEqual(modNotes.map((r) => r.target_id), [bob.id]);
  assert.strictEqual((await rows(M, 'mod_case_revoke')).length, 0);

  // A ban made through the audit log names the record it put on the history.
  const banned = h.next(B, 'banned');
  A.emit('ban-user', { userId: bob.id, reason: 'spam' });
  await banned;
  const history = await h.ask(A, 'get-mod-history', { userId: bob.id });
  const banCase = history.cases.find((c) => c.type === 'ban');
  row = (await rows(A, 'user_ban'))[0];
  assert.strictEqual(JSON.parse(row.details).caseId, banCase.id);

  // A member deleting their own account.
  const gone = await h.ask(C, 'self-delete-account', { password: 'access12345' });
  assert.ok(gone.success);
  row = (await rows(A, 'user_self_delete'))[0];
  assert.ok(row, 'self-delete logged');
  assert.strictEqual(row.target_id, carol.id);
  assert.strictEqual(row.actor_id, null);
  assert.strictEqual(row.actor_username, 'carolfour');
  assert.strictEqual(row.target_name, null);
  assert.deepStrictEqual(JSON.parse(row.details), { userId: carol.id, username: 'carolfour', scrubMessages: false });

  // The admin deleting an account names it the same way.
  const dave = await h.register('davefour');
  const deleted = h.next(A, 'user-deleted');
  A.emit('delete-user', { userId: dave.id });
  await deleted;
  const daveDetails = JSON.parse((await rows(A, 'user_delete'))[0].details);
  assert.strictEqual(daveDetails.userId, dave.id);
  assert.strictEqual(daveDetails.username, 'davefour');

  // A bulk cleanup lists every account it removed.
  const erin = await h.register('erinfour');
  const frank = await h.register('frankfour');
  const bulk = await h.ask(A, 'bulk-remove-users', { userIds: [erin.id, frank.id], reason: 'cleanup' });
  assert.strictEqual(bulk.removed, 2);
  const bulkRows = await rows(A, 'user_bulk_remove');
  assert.strictEqual(bulkRows.length, 1);
  const bulkDetails = JSON.parse(bulkRows[0].details);
  assert.strictEqual(bulkDetails.removed, 2);
  assert.strictEqual(bulkDetails.reason, 'cleanup');
  assert.deepStrictEqual(bulkDetails.accounts.sort((a, b) => a.id - b.id),
    [{ id: erin.id, username: 'erinfour' }, { id: frank.id, username: 'frankfour' }]);
  assert.ok(!('part' in bulkDetails), 'a short list fits on one row');
});
