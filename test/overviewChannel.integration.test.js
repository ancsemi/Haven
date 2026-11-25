'use strict';

/**
 * Overview channels: a front page that gathers upcoming events, the newest
 * announcements and the most active forum topics from the channels the
 * viewer can read, and nothing from the ones they cannot.
 *
 *   node --test test/overviewChannel.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3578, 'overview-channel');
test.before(() => h.start());
test.after(() => h.stop());

const DAY = 86400000;
const soon = (days, hours = 0) => new Date(Date.now() + days * DAY + hours * 3600000).toISOString();
const sqlTime = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19);

test('overview channels: what they gather, for whom, and the one-view rule', async (t) => {
  const admin = await h.register('admin');
  const ana = await h.register('ana');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const make = async (name, extra = {}) => {
    A.emit('create-channel', { name, addAllMembers: true, ...extra });
    let row;
    for (let i = 0; i < 30 && !row; i++) { await wait(100); row = db.prepare('SELECT * FROM channels WHERE name = ?').get(name); }
    assert.ok(row, `channel ${name} made`);
    return row;
  };
  // Asked for every view, the channel comes out an overview only.
  const home = await make('home', { isOverview: true, isCalendar: true, isForum: true });
  assert.deepStrictEqual([home.is_overview, home.is_calendar, home.is_forum], [1, 0, 0]);
  const events = await make('events', { isCalendar: true });
  const staff = await make('staff', { isCalendar: true, isPrivate: true, addAllMembers: false });
  const news = await make('news');
  const vip = await make('vip-news');
  const chat = await make('chat');
  const talk = await make('talk', { isForum: true });
  const late = await make('after-dark', { isForum: true });
  db.prepare("UPDATE channels SET notification_type = 'announcement' WHERE id IN (?, ?)").run(news.id, vip.id);
  const role = db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('VIP', 5, 'server', '#aa7711')").run().lastInsertRowid;
  db.prepare('UPDATE channels SET role_gate = ? WHERE id = ?').run(JSON.stringify({ mode: 'any', roles: [Number(role)] }), vip.id);
  db.prepare('UPDATE channels SET is_nsfw = 1 WHERE id = ?').run(late.id);

  const N = await h.connect(ana.token);
  const listed = (await h.channels(N)).find(c => c.code === home.code);
  assert.ok(listed && listed.is_overview === 1, 'the channel list says it is an overview');

  // Events: a past one, two coming up (out of order), one far ahead, and one
  // in a calendar ana is not in.
  const ev = async (code, title, startsAt, extra = {}) => {
    const r = await h.ask(A, 'calendar-create', { code, title, startsAt, ...extra });
    assert.ok(r.ok, `${title} added: ${r.error || ''}`);
    return r.event.id;
  };
  await ev(events.code, 'Last week', soon(-7));
  const card = await ev(events.code, 'Fight night', soon(3));
  await ev(events.code, 'Weigh-in', soon(1));
  await ev(events.code, 'Two days gone', soon(-2).slice(0, 10), { allDay: true });
  await ev(events.code, 'Next year', soon(400));
  await ev(staff.code, 'Staff meeting', soon(2));
  assert.ok((await h.ask(N, 'calendar-rsvp', { id: card, status: 'going' })).ok);

  // Posts: kept ones, plus some that must stay off the page.
  const post = db.prepare(`INSERT INTO messages (channel_id, user_id, content, created_at, thread_id, title, burn_seconds, destruct_at, nsfw, type)
    VALUES (@ch, @u, @text, @at, @thread, @title, @burn, @destruct, @nsfw, @type)`);
  const put = (ch, text, minutesAgo, more = {}) => Number(post.run({
    ch, u: admin.id, text, at: sqlTime(minutesAgo), thread: null, title: null, burn: 0, destruct: null, nsfw: 0, type: 'user', ...more,
  }).lastInsertRowid);
  put(news.id, 'Old news', 50);
  const fresh = put(news.id, 'Season two starts Friday ||spoiler||', 5);
  put(news.id, 'Gone after reading', 1, { burn: 30 });
  put(news.id, 'Goes away tonight', 2, { destruct: soon(1) });
  put(news.id, 'Welcome, ana!', 3, { type: 'welcome' });
  put(news.id, 'Spicy news', 4, { nsfw: 1 });
  put(vip.id, 'VIP only', 1);
  put(chat.id, 'Just chatting', 1);
  const quiet = put(talk.id, 'Rules talk', 40, { title: 'House rules' });
  const busy = put(talk.id, 'Who wins Friday?', 30, { title: 'Predictions' });
  put(talk.id, 'Me!', 10, { thread: busy });
  put(talk.id, 'No, me', 8, { thread: busy });
  put(talk.id, 'Hidden topic', 1, { title: 'Spoilers', nsfw: 1 });
  put(late.id, 'Late night', 1, { title: 'After hours' });

  const page = await h.ask(N, 'overview-data', { code: home.code });
  assert.ok(page.ok, page.error);
  // All-day events stay a day past their UTC end, so the client can show
  // them on the viewer's own date. Two days gone is past even that.
  assert.deepStrictEqual(page.events.map(e => e.title), ['Weigh-in', 'Fight night']);
  assert.strictEqual(page.events[1].mine, 'going');
  assert.strictEqual(page.events[1].going, 1);
  assert.strictEqual(page.events[1].channelCode, events.code);
  assert.strictEqual(page.events[1].channelName, 'events');
  assert.deepStrictEqual(page.announcements.map(a => a.excerpt), ['Season two starts Friday ||spoiler||', 'Old news']);
  assert.strictEqual(page.announcements[0].id, fresh);
  assert.strictEqual(page.announcements[0].author, 'admin');
  assert.strictEqual(page.announcements[0].channelCode, news.code);
  assert.match(page.announcements[0].createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'times go out as ISO UTC');
  assert.ok(Math.abs(Date.parse(page.announcements[0].createdAt) - (Date.now() - 5 * 60000)) < 120000);
  // The newest reply bumps a topic, as in the forum's Active order.
  assert.deepStrictEqual(page.topics.map(p => [p.id, p.title, p.replies]), [[busy, 'Predictions', 2], [quiet, 'House rules', 0]]);
  assert.ok(!page.watch.includes(staff.code) && !page.watch.includes(vip.code) && !page.watch.includes(late.code), 'unreadable and NSFW channels are not watched');
  assert.ok(page.watch.includes(events.code) && page.watch.includes(news.code) && page.watch.includes(talk.code));
  assert.ok(!page.watch.includes(chat.code), 'plain chat is not a source');

  // The admin passes the role gate, but still only sees channels they are in.
  const adminPage = await h.ask(A, 'overview-data', { code: home.code });
  assert.strictEqual(adminPage.announcements[0].excerpt, 'VIP only');
  assert.ok(adminPage.events.some(e => e.title === 'Staff meeting'));

  // Texts are cut to an excerpt.
  put(news.id, 'x'.repeat(1000), 0);
  assert.strictEqual((await h.ask(N, 'overview-data', { code: home.code })).announcements[0].excerpt.length, 300);

  // An NSFW overview takes in NSFW channels and posts.
  db.prepare('UPDATE channels SET is_nsfw = 1 WHERE id = ?').run(home.id);
  const after = await h.ask(N, 'overview-data', { code: home.code });
  assert.ok(after.topics.some(p => p.title === 'After hours') && after.topics.some(p => p.title === 'Spoilers'));
  assert.ok(after.announcements.some(a => a.excerpt === 'Spicy news'));
  db.prepare('UPDATE channels SET is_nsfw = 0 WHERE id = ?').run(home.id);

  // Only overview channels answer, and only to people who can reach them.
  assert.match((await h.ask(N, 'overview-data', { code: news.code })).error, /not found/);
  assert.match((await h.ask(N, 'overview-data', { code: 'nope' })).error, /not found/);
  const secret = await make('secret-home', { isOverview: true, isPrivate: true, addAllMembers: false });
  assert.match((await h.ask(N, 'overview-data', { code: secret.code })).error, /not found/);

  // One view at a time: turning on a calendar turns the overview off, and
  // turning the overview back on turns the calendar off.
  const flags = () => db.prepare('SELECT is_overview, is_calendar, is_forum FROM channels WHERE id = ?').get(home.id);
  const toggle = async (permission, want) => {
    A.emit('toggle-channel-permission', { code: home.code, permission });
    for (let i = 0; i < 30 && JSON.stringify(flags()) !== JSON.stringify(want); i++) await wait(100);
    assert.deepStrictEqual(flags(), want);
  };
  await toggle('calendar', { is_overview: 0, is_calendar: 1, is_forum: 0 });
  await toggle('forum', { is_overview: 0, is_calendar: 0, is_forum: 1 });
  await toggle('overview', { is_overview: 1, is_calendar: 0, is_forum: 0 });
  assert.ok((await h.ask(N, 'overview-data', { code: home.code })).ok);
});
