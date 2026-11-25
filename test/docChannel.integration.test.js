'use strict';

/**
 * Docs channels: a channel made as a docs channel holds written documents
 * instead of messages. The author edits a document, or everyone who may post
 * once the author shares it; a save that started from an older version is
 * refused as a conflict; changes reach everyone live; and a moderator can
 * change or delete any document.
 *
 *   node --test test/docChannel.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const { parseDoc, LIMITS } = require('../src/docs');

const h = createHarness(3582, 'doc-channel');
test.before(() => h.start());
test.after(() => h.stop());

test('parseDoc: limits, line endings and fields left out', () => {
  assert.match(parseDoc(null).error, /Invalid/);
  assert.match(parseDoc({ title: '  ' }).error, /title/);
  assert.match(parseDoc({ title: 'x'.repeat(LIMITS.title + 1) }).error, /120/);
  assert.match(parseDoc({ title: 'x', body: 'y'.repeat(LIMITS.body + 1) }).error, /50,000/);
  assert.match(parseDoc({ title: 'x', body: '€'.repeat(25000) }).error, /too large/, 'a body is measured in bytes too');
  assert.match(parseDoc({ title: 'x', body: 7 }).error, /Invalid/);
  assert.deepStrictEqual(parseDoc({ title: ' Notes ', body: 'a\r\nb\rc  \n\n' }).doc, { title: 'Notes', body: 'a\nb\nc', shared: false });
  assert.deepStrictEqual(parseDoc({ body: 'new' }, { title: 'Kept', body: 'old', shared: 1 }).doc, { title: 'Kept', body: 'new', shared: true });
});

test('docs channels: documents, versions, live updates and who may change what', async (t) => {
  const admin = await h.register('admin');
  const ana = await h.register('ana');
  const ben = await h.register('ben');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const make = async (name, extra) => {
    A.emit('create-channel', { name, addAllMembers: true, ...extra });
    let row;
    for (let i = 0; i < 30 && !row; i++) { await wait(100); row = db.prepare('SELECT * FROM channels WHERE name = ?').get(name); }
    assert.ok(row, `channel ${name} made`);
    return row;
  };
  // Asked for docs and a forum, the channel comes out a docs channel.
  const row = await make('writing', { isDocs: true, isForum: true });
  assert.deepStrictEqual([row.is_docs, row.is_forum], [1, 0]);
  const code = row.code;

  const N = await h.connect(ana.token);
  const B = await h.connect(ben.token);
  const listed = (await h.channels(N)).find(c => c.code === code);
  assert.ok(listed && listed.is_docs === 1, 'the channel list says it is a docs channel');
  await h.channels(B);

  const empty = await h.ask(N, 'doc-list', { code });
  assert.deepStrictEqual(empty.docs, []);
  assert.strictEqual(empty.canPost, true);
  assert.strictEqual(empty.canModerate, false);

  // Bad input is refused with a reason. (The admin sends these: members get
  // ten writes in ten seconds, and this test is quicker than any person.)
  assert.match((await h.ask(A, 'doc-create', { code, title: ' ' })).error, /title/);
  assert.match((await h.ask(A, 'doc-create', { code, title: 'x'.repeat(121) })).error, /120/);
  assert.match((await h.ask(A, 'doc-create', { code, title: 'x', body: 'y'.repeat(50001) })).error, /50,000/);
  assert.match((await h.ask(A, 'doc-create', { code: 'nope', title: 'x' })).error, /not found/);

  // Ben sees Ana's document arrive live, without its text.
  const seen = h.next(B, 'doc-changed', d => d.channelCode === code);
  const made = await h.ask(N, 'doc-create', { code, title: 'Chapter <b>1</b>', body: '# The start\r\nOnce upon a time  \n\n' });
  assert.ok(made.ok, JSON.stringify(made));
  const id = made.doc.id;
  assert.strictEqual(made.doc.title, 'Chapter <b>1</b>');
  assert.strictEqual(made.doc.body, '# The start\nOnce upon a time');
  assert.deepStrictEqual([made.doc.version, made.doc.words, made.doc.shared, made.doc.creatorName], [1, 6, false, 'ana']);
  const live = await seen;
  assert.ok(live && live.doc.id === id, 'creates reach the channel');
  assert.strictEqual(live.doc.body, undefined, 'the live summary leaves the text out');
  assert.strictEqual((await h.ask(B, 'doc-get', { id })).doc.body, '# The start\nOnce upon a time');

  // Only the author changes or deletes an unshared document.
  assert.match((await h.ask(B, 'doc-update', { id, version: 1, body: 'Mine now' })).error, /Only the person/);
  assert.match((await h.ask(B, 'doc-delete', { id })).error, /Only the person/);

  // Saves move the version on; one that started from an older version is a
  // conflict and comes back with what is stored.
  const two = await h.ask(N, 'doc-update', { id, version: 1, body: 'Second draft' });
  assert.ok(two.ok, JSON.stringify(two));
  assert.deepStrictEqual([two.doc.version, two.doc.title, two.doc.body], [2, 'Chapter <b>1</b>', 'Second draft'], 'fields left out keep their value');
  const stale = await h.ask(N, 'doc-update', { id, version: 1, body: 'Stale' });
  assert.strictEqual(stale.conflict, true);
  assert.deepStrictEqual([stale.doc.version, stale.doc.body], [2, 'Second draft']);
  assert.match((await h.ask(N, 'doc-update', { id, body: 'No version' })).error, /Invalid/);

  // Shared: everyone who may post edits it, but only its author or a
  // moderator decides that, and only they delete it.
  const shared = await h.ask(N, 'doc-update', { id, version: 2, shared: true });
  assert.deepStrictEqual([shared.doc.version, shared.doc.shared], [3, true]);
  const byBen = await h.ask(B, 'doc-update', { id, version: 3, body: 'Ben was here' });
  assert.ok(byBen.ok, JSON.stringify(byBen));
  assert.deepStrictEqual([byBen.doc.version, byBen.doc.editorName, byBen.doc.creatorName], [4, 'ben', 'ana']);
  const unshare = await h.ask(B, 'doc-update', { id, version: 4, shared: false, body: 'Ben again' });
  assert.deepStrictEqual([unshare.doc.version, unshare.doc.shared], [5, true], 'an editor cannot turn sharing off');
  assert.match((await h.ask(B, 'doc-delete', { id })).error, /Only the person/);
  assert.ok((await h.ask(A, 'doc-update', { id, version: 5, title: 'Chapter one' })).ok, 'a moderator edits');

  // A muted member writes nothing.
  db.prepare("INSERT INTO mutes (user_id, muted_by, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run(ben.id, admin.id);
  assert.strictEqual((await h.ask(B, 'doc-list', { code })).canPost, false);
  assert.match((await h.ask(B, 'doc-update', { id, version: 6, body: 'Shh' })).error, /Only the person/);
  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(ben.id);

  // Deleting: the author or a moderator, and the channel hears about it.
  const scratch = await h.ask(N, 'doc-create', { code, title: 'Scratch' });
  assert.ok(scratch.ok);
  assert.deepStrictEqual((await h.ask(B, 'doc-list', { code })).docs.map(d => d.title), ['Scratch', 'Chapter one'], 'most recently changed first');
  const gone = h.next(B, 'doc-removed', d => d.id === scratch.doc.id);
  assert.ok((await h.ask(N, 'doc-delete', { id: scratch.doc.id })).ok);
  assert.ok(await gone, 'deletes reach the channel');
  assert.match((await h.ask(B, 'doc-get', { id: scratch.doc.id })).error, /not found/);

  // Read-only: members read, but neither write nor edit shared documents.
  A.emit('toggle-channel-permission', { code, permission: 'read_only' });
  for (let i = 0; i < 30 && !db.prepare('SELECT read_only FROM channels WHERE code = ?').get(code).read_only; i++) await wait(100);
  const ro = await h.ask(B, 'doc-list', { code });
  assert.deepStrictEqual([ro.canPost, ro.docs.length], [false, 1]);
  assert.match((await h.ask(B, 'doc-create', { code, title: 'Nope' })).error, /Only some members/);
  assert.match((await h.ask(B, 'doc-update', { id, version: 6, body: 'Nope' })).error, /Only the person/);
  assert.ok((await h.ask(A, 'doc-create', { code, title: 'House rules' })).ok, 'the admin still writes');

  // Someone outside a private channel reaches nothing.
  const staff = await make('staff-docs', { isDocs: true, isPrivate: true, addAllMembers: false });
  const secret = await h.ask(A, 'doc-create', { code: staff.code, title: 'Secret' });
  assert.ok(secret.ok);
  assert.match((await h.ask(B, 'doc-list', { code: staff.code })).error, /not found/);
  assert.match((await h.ask(B, 'doc-get', { id: secret.doc.id })).error, /not found/);
  assert.match((await h.ask(B, 'doc-update', { id: secret.doc.id, version: 1, body: 'x' })).error, /not found/);
  assert.match((await h.ask(B, 'doc-delete', { id: secret.doc.id })).error, /not found/);

  // One view at a time; turning the calendar on keeps the documents for later.
  const flags = () => db.prepare('SELECT is_docs, is_calendar FROM channels WHERE id = ?').get(row.id);
  A.emit('toggle-channel-permission', { code, permission: 'calendar' });
  for (let i = 0; i < 30 && flags().is_docs; i++) await wait(100);
  assert.deepStrictEqual(flags(), { is_docs: 0, is_calendar: 1 });
  assert.match((await h.ask(N, 'doc-list', { code })).error, /not found/);
  A.emit('toggle-channel-permission', { code, permission: 'docs' });
  for (let i = 0; i < 30 && !flags().is_docs; i++) await wait(100);
  assert.deepStrictEqual(flags(), { is_docs: 1, is_calendar: 0 });
  assert.strictEqual((await h.ask(N, 'doc-list', { code })).docs.length, 2);

  // Deleting the channel takes its documents with it.
  A.emit('delete-channel', { code });
  for (let i = 0; i < 30 && db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code); i++) await wait(100);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM docs WHERE channel_id = ?').get(row.id).n, 0);

  A.disconnect(); N.disconnect(); B.disconnect();
});
