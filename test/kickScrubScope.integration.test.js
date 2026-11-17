'use strict';

/**
 * Kick with "scrub messages": only an admin can scrub server-wide; anyone
 * else's kick scrubs the channel it happened in. The audit log records the
 * scope that was used, not the one asked for (a moderator's kick read
 * "scrubScope: server" while only the channel had been scrubbed).
 *
 *   node --test test/kickScrubScope.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3477;
const h = createHarness(PORT, 'kick-scrub-scope');

test.before(() => h.start());
test.after(() => h.stop());

test('a moderator\'s kick scrubs the channel, and the log says so', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('modtwo');
  const spammer = await h.register('spammy');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: roles.find((r) => r.name === 'Mod').id })).success);

  const mk = async (name) => {
    A.emit('create-channel', { name });
    for (let i = 0; i < 30; i++) {
      await wait(100);
      const row = db.prepare('SELECT id, code FROM channels WHERE name = ?').get(name);
      if (row) return row;
    }
    throw new Error('no channel');
  };
  const here = await mk('here');
  const elsewhere = await mk('elsewhere');
  const M = await h.connect(mod.token);
  const S = await h.connect(spammer.token);
  for (const ch of [here, elsewhere]) for (const s of [M, S]) { s.emit('join-channel', { code: ch.code }); await wait(100); }
  const post = (channelId, content) => db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(channelId, spammer.id, content);
  post(here.id, 'spam here');
  post(elsewhere.id, 'spam elsewhere');

  M.emit('enter-channel', { code: here.code });
  await wait(200);
  M.emit('kick-user', { userId: spammer.id, reason: 'spam', scrubMessages: true, scrubScope: 'server' });
  let row = null;
  for (let i = 0; i < 30 && !row; i++) {
    await wait(100);
    row = db.prepare("SELECT details FROM audit_log WHERE action = 'user_kick' ORDER BY id DESC LIMIT 1").get();
  }
  assert.ok(row, 'the kick is in the audit log');
  assert.equal(JSON.parse(row.details).scrubScope, 'channel', 'the log names the scope that was used');
  const left = db.prepare('SELECT content FROM messages WHERE user_id = ? ORDER BY id').all(spammer.id).map((r) => r.content);
  assert.deepEqual(left, ['spam elsewhere'], 'only this channel was scrubbed');
});
