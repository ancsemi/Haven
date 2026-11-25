'use strict';

/**
 * Bracket channels: a channel made as a bracket channel holds single-
 * elimination tournaments instead of messages. Seeds pair the usual way, byes
 * move the top seeds on, results move winners along and cannot be pulled out
 * from under a later result, changes reach everyone live, and only the
 * creator or a moderator runs a bracket.
 *
 *   node --test test/bracketChannel.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const { seedOrder, layout, BYE } = require('../src/brackets');

const h = createHarness(3580, 'bracket-channel');
test.before(() => h.start());
test.after(() => h.stop());

test('seeding: top seeds meet late and byes go to them', () => {
  assert.deepStrictEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepStrictEqual(seedOrder(16), [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
  const five = layout(5, {});
  assert.deepStrictEqual(five.rounds.map(r => r.length), [4, 2, 1]);
  assert.deepStrictEqual(five.rounds[0].map(m => m.sides), [[0, BYE], [3, 4], [1, BYE], [2, BYE]]);
  assert.deepStrictEqual(five.rounds[1].map(m => m.sides), [[0, null], [1, 2]], 'bye winners are already through');
  const full = layout(64, {});
  assert.strictEqual(full.rounds.flat().length, 63);
  assert.ok(full.rounds[0].every(m => !m.bye));
  assert.deepStrictEqual(layout(2, { '0:0': { winner: 1 } }).champion, 1);
});

test('bracket channels: brackets, results, live updates and who may change what', async (t) => {
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
  // Asked for a bracket and a forum, the channel comes out a bracket channel.
  const row = await make('tournaments', { isBracket: true, isForum: true });
  assert.deepStrictEqual([row.is_bracket, row.is_forum], [1, 0]);
  const code = row.code;

  const N = await h.connect(ana.token);
  const B = await h.connect(ben.token);
  const listed = (await h.channels(N)).find(c => c.code === code);
  assert.ok(listed && listed.is_bracket === 1, 'the channel list says it is a bracket channel');
  await h.channels(B);

  const empty = await h.ask(N, 'bracket-list', { code });
  assert.deepStrictEqual(empty.brackets, []);
  assert.strictEqual(empty.canPost, true);
  assert.strictEqual(empty.canModerate, false);

  // Bad input is refused with a reason. (The admin sends these: members get
  // ten writes in ten seconds, and this test is quicker than any person.)
  const names = ['Ana', 'Rex', 'Kai', 'Mo', 'Jet'];
  assert.match((await h.ask(A, 'bracket-create', { code, title: ' ', entrants: names })).error, /name/);
  assert.match((await h.ask(A, 'bracket-create', { code, title: 'x', entrants: ['Solo'] })).error, /at least 2/);
  assert.match((await h.ask(A, 'bracket-create', { code, title: 'x', entrants: Array.from({ length: 65 }, (_, i) => `P${i}`) })).error, /up to 64/);
  assert.match((await h.ask(A, 'bracket-create', { code, title: 'x', entrants: ['A', '  '] })).error, /needs a name/);
  assert.match((await h.ask(A, 'bracket-create', { code, title: 'x', entrants: ['A', 'B'.repeat(61)] })).error, /60/);
  assert.match((await h.ask(A, 'bracket-create', { code, title: 'x', entrants: ['A', '<script>x</script>'] })).error, /needs a name/);

  // Ben sees Ana's bracket arrive live, matches worked out.
  const seen = h.next(B, 'bracket-changed', d => d.channelCode === code);
  const made = await h.ask(N, 'bracket-create', { code, title: 'King of the Ring <b>2031</b>', description: 'One night only', entrants: names.map(n => ` ${n} `) });
  assert.ok(made.ok, JSON.stringify(made));
  const id = made.bracket.id;
  assert.strictEqual(made.bracket.title, 'King of the Ring <b>2031</b>');
  assert.deepStrictEqual(made.bracket.entrants, names);
  assert.strictEqual(made.bracket.creatorName, 'ana');
  assert.strictEqual(made.bracket.champion, null);
  assert.deepStrictEqual(made.bracket.rounds[0].map(m => m.winner), [0, null, 0, 0], 'byes are decided');
  const live = await seen;
  assert.ok(live && live.bracket.id === id, 'creates reach the channel');

  const report = (sock, round, slot, winner, note) => h.ask(sock, 'bracket-result', { id, round, slot, winner, note });
  // Only real, ready matches take a result.
  assert.match((await report(A, 0, 0, 0)).error, /bye/);
  assert.match((await report(A, 1, 0, 0)).error, /waiting/);
  assert.match((await report(A, 5, 0, 0)).error, /not found/);
  assert.match((await report(A, 0, 1, 2)).error, /winner/);
  // Only the creator or a moderator reports.
  assert.match((await report(B, 0, 1, 1)).error, /Only the person/);

  // Jet (5) upsets Mo (4) and meets Ana (1); Rex (2) beats Kai (3).
  const upset = await report(N, 0, 1, 1, 'Pinfall');
  assert.ok(upset.ok, JSON.stringify(upset));
  assert.deepStrictEqual(upset.bracket.rounds[0][1].note, 'Pinfall');
  assert.deepStrictEqual(upset.bracket.rounds[1][0].sides, [0, 4]);
  assert.ok((await report(N, 1, 1, 0)).ok);
  assert.ok((await report(A, 1, 0, 0)).ok, 'a moderator reports too');
  const final = await h.ask(N, 'bracket-list', { code });
  assert.deepStrictEqual(final.brackets[0].rounds[2][0].sides, [0, 1]);

  // An earlier result stays put while the next match has one; its note can change.
  assert.match((await report(A, 0, 1, 0)).error, /Clear that one first/);
  assert.match((await report(A, 0, 1, null)).error, /Clear that one first/);
  assert.strictEqual((await report(N, 0, 1, 1, 'Roll-up')).bracket.rounds[0][1].note, 'Roll-up');

  const crowned = await report(N, 2, 0, 1, 'Submission');
  assert.strictEqual(crowned.bracket.champion, 1);
  const cleared = await report(A, 2, 0, null);
  assert.strictEqual(cleared.bracket.champion, null);
  assert.strictEqual(cleared.bracket.rounds[2][0].note, '');
  assert.strictEqual((await report(N, 2, 0, 0)).bracket.champion, 0);

  // Renaming keeps the results; a different field size waits for them to go.
  assert.match((await h.ask(B, 'bracket-update', { id, title: 'Mine now' })).error, /Only the person/);
  const renamed = await h.ask(N, 'bracket-update', { id, entrants: ['Ana', 'Rex', 'Kai', 'Mo', 'Jet Storm'] });
  assert.ok(renamed.ok, JSON.stringify(renamed));
  assert.strictEqual(renamed.bracket.entrants[4], 'Jet Storm');
  assert.strictEqual(renamed.bracket.title, 'King of the Ring <b>2031</b>', 'fields left out keep their value');
  assert.strictEqual(renamed.bracket.champion, 0);
  assert.match((await h.ask(A, 'bracket-update', { id, entrants: names.slice(0, 4) })).error, /Clear the results/);
  assert.ok((await h.ask(A, 'bracket-update', { id, description: 'Moved to Saturday' })).ok, 'a moderator edits');

  // Read-only: members read but do not start brackets.
  A.emit('toggle-channel-permission', { code, permission: 'read_only' });
  for (let i = 0; i < 30 && !db.prepare('SELECT read_only FROM channels WHERE code = ?').get(code).read_only; i++) await wait(100);
  const ro = await h.ask(B, 'bracket-list', { code });
  assert.strictEqual(ro.canPost, false);
  assert.strictEqual(ro.brackets.length, 1);
  assert.match((await h.ask(B, 'bracket-create', { code, title: 'Nope', entrants: ['A', 'B'] })).error, /Only some members/);
  const second = await h.ask(A, 'bracket-create', { code, title: 'Tag team cup', entrants: ['A', 'B', 'C', 'D'] });
  assert.ok(second.ok);
  assert.deepStrictEqual((await h.ask(B, 'bracket-list', { code })).brackets.map(b => b.title), ['Tag team cup', 'King of the Ring <b>2031</b>'], 'newest first');

  // Someone outside a private channel reaches nothing.
  const staff = await make('staff-brackets', { isBracket: true, isPrivate: true, addAllMembers: false });
  const secret = await h.ask(A, 'bracket-create', { code: staff.code, title: 'Secret', entrants: ['A', 'B'] });
  assert.ok(secret.ok);
  assert.match((await h.ask(B, 'bracket-list', { code: staff.code })).error, /not found/);
  assert.match((await h.ask(B, 'bracket-result', { id: secret.bracket.id, round: 0, slot: 0, winner: 0 })).error, /not found/);
  assert.match((await h.ask(B, 'bracket-delete', { id: secret.bracket.id })).error, /not found/);

  // Deleting: the creator or a moderator, and the channel hears about it.
  assert.match((await h.ask(B, 'bracket-delete', { id: second.bracket.id })).error, /Only the person/);
  const gone = h.next(B, 'bracket-removed', d => d.id === second.bracket.id);
  assert.ok((await h.ask(A, 'bracket-delete', { id: second.bracket.id })).ok);
  assert.ok(await gone, 'deletes reach the channel');

  // One view at a time; turning the calendar on keeps the brackets for later.
  const flags = () => db.prepare('SELECT is_bracket, is_calendar FROM channels WHERE id = ?').get(row.id);
  A.emit('toggle-channel-permission', { code, permission: 'calendar' });
  for (let i = 0; i < 30 && flags().is_bracket; i++) await wait(100);
  assert.deepStrictEqual(flags(), { is_bracket: 0, is_calendar: 1 });
  assert.match((await h.ask(N, 'bracket-list', { code })).error, /not found/);
  A.emit('toggle-channel-permission', { code, permission: 'bracket' });
  for (let i = 0; i < 30 && !flags().is_bracket; i++) await wait(100);
  assert.deepStrictEqual(flags(), { is_bracket: 1, is_calendar: 0 });
  assert.strictEqual((await h.ask(N, 'bracket-list', { code })).brackets[0].champion, 0);

  // Deleting the channel takes its brackets with it.
  A.emit('delete-channel', { code });
  for (let i = 0; i < 30 && db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code); i++) await wait(100);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM brackets WHERE channel_id = ?').get(row.id).n, 0);

  A.disconnect(); N.disconnect(); B.disconnect();
});
