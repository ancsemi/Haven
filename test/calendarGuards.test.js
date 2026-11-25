'use strict';

// Calendar channels follow the rules a message follows: a timeout and the
// new-account wait stop someone adding events, answers are rate limited
// because each one is sent to the whole channel, and a calendar cannot be
// merged away (the merge deletes the channel, and its events with it).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { preview } = require('../src/mergeChannels');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/socketHandlers/calendar.js'), 'utf8');

test('a calendar is refused as either side of a merge', () => {
  const plain = { id: 2, is_forum: 0, is_dm: 0 };
  const calendar = { id: 1, is_forum: 0, is_dm: 0, is_calendar: 1 };
  assert.equal(preview(null, calendar, plain).error, 'A calendar cannot be merged');
  assert.equal(preview(null, plain, calendar).error, 'A calendar cannot be merged');
});

test('adding an event checks the timeout and the new-account wait like a message', () => {
  assert.match(src, /const mutedNotice = \(\) => muteNotice\(getActiveMute\(db, uid\(\)\)\);/);
  assert.match(src, /const \{ youngAccountWait \} = createPostingWait\(socket, ctx\);/);
  assert.match(src, /socket\.user\.isAdmin \? null : mutedNotice\(\) \|\| youngAccountWait\(ch\.id\)\?\.message \|\| null/);
  assert.doesNotMatch(src, /datetime\('now'\)/, 'no hand-written mute query');
});

test('every calendar change is rate limited', () => {
  // Adding and editing count as posting; answers and deletes get the wider
  // limit every other quick action has.
  for (const [event, bucket] of [['calendar-create', 'message'], ['calendar-update', 'message'], ['calendar-delete', 'event'], ['calendar-rsvp', 'event']]) {
    const at = src.indexOf(`socket.on('${event}'`);
    assert.ok(at > 0, event);
    assert.ok(src.slice(at, at + 400).includes(`if (floodCheck('${bucket}')) return cb({ error: 'Slow down a moment' });`), event);
  }
});
