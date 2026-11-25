'use strict';
/**
 * Direct message attachments, encrypted .enc files included, count toward a
 * member's storage and show as their own figure next to the total, for
 * moderators only.
 *
 *   node --test test/dmStorage.integration.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');
const PORT = 3733;
const h = createHarness(PORT, 'dm-storage');
test.before(() => h.start());
test.after(() => h.stop());
const upload = async (token, name, size, scope) => {
  const fd = new FormData();
  scope && fd.append('scope', scope);
  fd.append('file', new Blob([Buffer.alloc(size, 7)], { type: 'application/octet-stream' }), name);
  return (await fetch(`http://localhost:${PORT}/api/upload-file`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
};
test('DM uploads count, with or without a scope, and show on their own', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  for (const r of [await upload(bob.token, 'e2e-file.enc', 1000, 'dm'), await upload(bob.token, 'e2e-image.enc', 3000), await upload(bob.token, 'notes.txt', 500, 'channel'), await upload(carol.token, 'plain.txt', 200)]) assert.ok(r.url, JSON.stringify(r));
  await wait(300);
  const got = await h.ask(A, 'get-all-members', {});
  const by = (name) => got.members.find((m) => m.username === name);
  assert.strictEqual(by('bob').storage.dm, 4000, 'both encrypted uploads are direct message storage');
  assert.strictEqual(by('bob').storage.channel, 500);
  assert.strictEqual(by('bob').storage.total, 4500);
  assert.strictEqual(by('carol').storage.dm || 0, 0);
  assert.strictEqual(got.storageSummary.dmBytes, 4000);
  assert.ok(got.storageSummary.liveBytes >= 4700);
  const seen = await h.ask(B, 'get-all-members', {});
  assert.ok(seen.error || (!seen.storageSummary && seen.members.every((m) => !m.storage)), 'a member sees no storage');
});
