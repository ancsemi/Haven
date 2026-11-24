'use strict';

/**
 * A bot account follows the audit log live: it subscribes, gets each new
 * row as audit-entry, catches up with get-audit-log { afterId }, and is
 * dropped when it loses the permission to read the log.
 *
 *   node --test test/auditStream.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3661, 'audit-stream');

test.before(() => h.start());
test.after(() => h.stop());

test('a bot account follows the audit log', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bobfive');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);

  const made = await h.ask(A, 'create-bot', { name: 'auditbot' });
  assert.ok(made.token, JSON.stringify(made));
  const botId = made.bot.id;
  const R = await h.connect(made.token);
  const got = [];
  R.on('audit-entry', (row) => got.push(row));

  // People read the log in Settings; a bot needs the permission first.
  assert.match((await h.ask(B, 'subscribe-audit-log', {})).error, /bot accounts/);
  assert.match((await h.ask(R, 'subscribe-audit-log', {})).error, /permission/);
  assert.ok((await h.ask(R, 'subscribe-audit-log', { actions: [] })).error);

  const mod = (await h.ask(A, 'get-roles', {})).roles.find((r) => r.name === 'Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: botId, roleId: mod.id })).success);
  const sub = await h.ask(R, 'subscribe-audit-log', { actions: ['user_warn', 'user_note'] });
  assert.ok(sub.ok, JSON.stringify(sub));
  assert.ok(Number.isInteger(sub.lastId));

  A.emit('whitelist-add', { username: 'nobody' });
  const warned = await h.ask(A, 'warn-user', { userId: bob.id, reason: 'spam' });
  assert.ok(await h.ask(A, 'add-mod-note', { userId: botId, text: 'about the bot' }));
  const noted = await h.ask(A, 'add-mod-note', { userId: bob.id, text: 'about bob' });
  await wait(200);

  // Only the actions asked for, never a note about the bot itself.
  assert.deepStrictEqual(got.map((r) => r.action), ['user_warn', 'user_note']);
  assert.strictEqual(got[0].target_id, bob.id);
  assert.strictEqual(JSON.parse(got[0].details).caseId, warned.id);
  assert.match(got[0].created_at, /Z$/);
  assert.ok(got[0].id > sub.lastId);
  assert.strictEqual(JSON.parse(got[1].details).caseId, noted.id);

  // Catching up gives the same rows, oldest first.
  const caught = await h.ask(R, 'get-audit-log', { afterId: sub.lastId, action: 'user_warn' });
  assert.deepStrictEqual(caught.rows.map((r) => r.id), [got[0].id]);
  assert.deepStrictEqual(caught.rows[0], got[0]);
  const all = (await h.ask(R, 'get-audit-log', { afterId: sub.lastId })).rows.map((r) => r.id);
  assert.deepStrictEqual(all, [...all].sort((a, b) => a - b));

  // Losing the role drops the bot at the next row.
  const dropped = h.next(R, 'audit-log-unsubscribed');
  assert.ok((await h.ask(A, 'revoke-role', { userId: botId, roleId: mod.id })).success);
  assert.match((await dropped).reason, /permission/);
  await h.ask(A, 'warn-user', { userId: bob.id, reason: 'again' });
  await wait(200);
  assert.strictEqual(got.length, 2);
});
