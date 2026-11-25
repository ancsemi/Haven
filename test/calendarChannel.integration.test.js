'use strict';

/**
 * Calendar channels: a channel made as a calendar lists events instead of
 * messages. Members add events and answer them, changes reach everyone in the
 * channel live, only the creator or a moderator edits or deletes an event,
 * and a read-only or unreachable calendar refuses what it should.
 *
 *   node --test test/calendarChannel.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3577, 'calendar-channel');
test.before(() => h.start());
test.after(() => h.stop());

const DAY = 86400000;
const at = (days, hours = 0) => new Date(Date.UTC(2031, 2, 10) + days * DAY + hours * 3600000).toISOString();
const range = { from: at(-10), to: at(30) };

test('calendar channels: events, answers, live updates and who may change what', async (t) => {
  const admin = await h.register('admin');
  const ana = await h.register('ana');
  const ben = await h.register('ben');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  // Asked for both, the channel comes out a calendar only.
  A.emit('create-channel', { name: 'events', isCalendar: true, isForum: true, addAllMembers: true });
  let row;
  for (let i = 0; i < 30 && !row; i++) { await wait(100); row = db.prepare('SELECT id, code, is_calendar, is_forum FROM channels WHERE name = ?').get('events'); }
  assert.ok(row, 'channel made');
  assert.strictEqual(row.is_calendar, 1);
  assert.strictEqual(row.is_forum, 0);
  const code = row.code;

  const N = await h.connect(ana.token);
  const B = await h.connect(ben.token);
  const listed = (await h.channels(N)).find(c => c.code === code);
  assert.ok(listed && listed.is_calendar === 1, 'the channel list says it is a calendar');
  await h.channels(B);

  const empty = await h.ask(N, 'calendar-events', { code, ...range });
  assert.deepStrictEqual(empty.events, []);
  assert.strictEqual(empty.canPost, true);
  assert.strictEqual(empty.canModerate, false);

  // Bad input is refused with a reason.
  assert.match((await h.ask(N, 'calendar-create', { code, title: '  ', startsAt: at(1) })).error, /title/);
  assert.match((await h.ask(N, 'calendar-create', { code, title: 'x', startsAt: at(2), endsAt: at(1) })).error, /end after/);
  assert.match((await h.ask(N, 'calendar-create', { code, title: 'x', startsAt: 'soon' })).error, /start/);
  assert.match((await h.ask(N, 'calendar-create', { code, title: 'x', startsAt: at(0), endsAt: at(40) })).error, /31 days/);
  assert.match((await h.ask(N, 'calendar-create', { code, title: 'x', startsAt: at(0), color: 'red' })).error, /color/);
  assert.match((await h.ask(N, 'calendar-events', { code, from: at(0), to: at(200) })).error, /too long/);

  // Ben sees Ana's event arrive live, without Ana's own answer on it.
  const seen = h.next(B, 'calendar-changed', d => d.channelCode === code);
  const made = await h.ask(N, 'calendar-create', { code, title: 'Title match <script>x</script>', description: 'Main event', location: 'Arena', startsAt: at(1, 19), endsAt: at(1, 22), color: '#FF8800' });
  assert.ok(made.ok, JSON.stringify(made));
  const ev = made.event;
  assert.strictEqual(ev.title, 'Title match');
  assert.strictEqual(ev.color, '#ff8800');
  assert.strictEqual(ev.startsAt, at(1, 19));
  assert.strictEqual(ev.creatorName, 'ana');
  const live = await seen;
  assert.ok(live && live.event.id === ev.id && !('mine' in live.event), JSON.stringify(live));

  // No end means an hour; an all-day event covers whole UTC dates.
  const hour = await h.ask(N, 'calendar-create', { code, title: 'Quick sync', startsAt: at(3, 9) });
  assert.strictEqual(hour.event.endsAt, at(3, 10));
  const fest = await h.ask(N, 'calendar-create', { code, title: 'Festival', allDay: true, startsAt: '2031-03-14', endsAt: '2031-03-15' });
  assert.ok(fest.ok, JSON.stringify(fest));
  assert.strictEqual(fest.event.startsAt, '2031-03-14T00:00:00.000Z');
  assert.strictEqual(fest.event.endsAt, '2031-03-15T23:59:59.999Z');
  assert.strictEqual(fest.event.allDay, true);
  assert.match((await h.ask(N, 'calendar-create', { code, title: 'x', allDay: true, startsAt: '2031-02-30' })).error, /start/);

  // Answers: counts for everyone, your own answer only for you.
  const counted = h.next(N, 'calendar-changed', d => d.event.id === ev.id && d.event.going === 1);
  const going = await h.ask(B, 'calendar-rsvp', { id: ev.id, status: 'going' });
  assert.strictEqual(going.event.mine, 'going');
  assert.strictEqual(going.event.going, 1);
  assert.ok(await counted, 'the count reaches the channel');
  assert.match((await h.ask(B, 'calendar-rsvp', { id: ev.id, status: 'yes' })).error, /Invalid/);
  await h.ask(N, 'calendar-rsvp', { id: ev.id, status: 'maybe' });
  const detail = await h.ask(N, 'calendar-event', { id: ev.id });
  assert.strictEqual(detail.event.mine, 'maybe');
  assert.deepStrictEqual(detail.attendees.map(a => [a.name, a.status]), [['ben', 'going'], ['ana', 'maybe']]);
  const benView = (await h.ask(B, 'calendar-events', { code, ...range })).events;
  assert.deepStrictEqual(benView.map(e => e.title), ['Title match', 'Quick sync', 'Festival']);
  assert.deepStrictEqual(benView.map(e => e.mine), ['going', null, null]);
  const takenBack = await h.ask(B, 'calendar-rsvp', { id: ev.id, status: null });
  assert.strictEqual(takenBack.event.mine, null);
  assert.strictEqual(takenBack.event.going, 0);

  // Only the creator or a moderator changes an event.
  assert.match((await h.ask(B, 'calendar-update', { id: ev.id, title: 'Mine now' })).error, /own events/);
  assert.match((await h.ask(B, 'calendar-delete', { id: ev.id })).error, /own events/);
  const renamed = await h.ask(N, 'calendar-update', { id: ev.id, title: 'Title match: final' });
  assert.strictEqual(renamed.event.title, 'Title match: final');
  assert.strictEqual(renamed.event.startsAt, at(1, 19), 'fields left out keep their value');
  assert.strictEqual(renamed.event.location, 'Arena');
  const moved = await h.ask(A, 'calendar-update', { id: ev.id, startsAt: at(2, 19) });
  assert.strictEqual(moved.event.endsAt, at(2, 20), 'a new start without an end gets the default length');
  const gone = h.next(B, 'calendar-removed', d => d.id === hour.event.id);
  assert.ok((await h.ask(N, 'calendar-delete', { id: hour.event.id })).ok);
  assert.ok(await gone, 'deletes reach the channel');

  // Read-only: members can still read and answer, not add.
  A.emit('toggle-channel-permission', { code, permission: 'read_only' });
  for (let i = 0; i < 30 && !db.prepare('SELECT read_only FROM channels WHERE code = ?').get(code).read_only; i++) await wait(100);
  const ro = await h.ask(B, 'calendar-events', { code, ...range });
  assert.strictEqual(ro.canPost, false);
  assert.match((await h.ask(B, 'calendar-create', { code, title: 'Nope', startsAt: at(4) })).error, /Only some members/);
  assert.ok((await h.ask(B, 'calendar-rsvp', { id: fest.event.id, status: 'maybe' })).ok);
  assert.ok((await h.ask(A, 'calendar-create', { code, title: 'Admin post', startsAt: at(4) })).ok);

  // Someone outside the channel reaches nothing.
  A.emit('create-channel', { name: 'staff-cal', isCalendar: true, isPrivate: true });
  let staff;
  for (let i = 0; i < 30 && !staff; i++) { await wait(100); staff = db.prepare('SELECT code FROM channels WHERE name = ?').get('staff-cal'); }
  const secret = await h.ask(A, 'calendar-create', { code: staff.code, title: 'Secret', startsAt: at(5) });
  assert.ok(secret.ok);
  assert.match((await h.ask(B, 'calendar-events', { code: staff.code, ...range })).error, /not found/);
  assert.match((await h.ask(B, 'calendar-event', { id: secret.event.id })).error, /not found/);
  assert.match((await h.ask(B, 'calendar-rsvp', { id: secret.event.id, status: 'going' })).error, /not found/);

  // Turning the forum on turns the calendar off; the events stay for later.
  A.emit('toggle-channel-permission', { code, permission: 'forum' });
  for (let i = 0; i < 30 && db.prepare('SELECT is_calendar FROM channels WHERE code = ?').get(code).is_calendar; i++) await wait(100);
  assert.deepStrictEqual(db.prepare('SELECT is_calendar, is_forum FROM channels WHERE code = ?').get(code), { is_calendar: 0, is_forum: 1 });
  assert.match((await h.ask(N, 'calendar-events', { code, ...range })).error, /not found/);
  A.emit('toggle-channel-permission', { code, permission: 'calendar' });
  for (let i = 0; i < 30 && !db.prepare('SELECT is_calendar FROM channels WHERE code = ?').get(code).is_calendar; i++) await wait(100);
  assert.deepStrictEqual(db.prepare('SELECT is_calendar, is_forum FROM channels WHERE code = ?').get(code), { is_calendar: 1, is_forum: 0 });
  assert.strictEqual((await h.ask(N, 'calendar-events', { code, ...range })).events.length, 3);

  // Deleting the channel takes its events and answers with it.
  A.emit('delete-channel', { code });
  for (let i = 0; i < 30 && db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code); i++) await wait(100);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE channel_id = ?').get(row.id).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM calendar_rsvps WHERE event_id = ?').get(fest.event.id).n, 0);

  A.disconnect(); N.disconnect(); B.disconnect();
});
