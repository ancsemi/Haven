'use strict';

// Calendar channels. Storage and checks live in src/calendarEvents.js.
//
//   calendar-events { code, from, to }   events that overlap a time range
//   calendar-event  { id }               one event and who answered
//   calendar-create { code, ...event }   anyone who may post in the channel
//   calendar-update { id, ...event }     its creator, or Delete Messages
//   calendar-delete { id }               the same
//   calendar-rsvp   { id, status }       'going' | 'maybe' | 'declined' | null
//
// An event is { title, description, location, startsAt, endsAt, allDay,
// color }. Every change reaches the channel room live: 'calendar-changed'
// carries the event (without anyone's own answer) and 'calendar-removed' its
// id. Replies come back through the callback as { ok, ... } or { error }.

const cal = require('../calendarEvents');
const { reachableChannel, reachableChannelByCode } = require('./channelAccess');
const { sanitizeText } = require('./helpers');
const { getActiveMute, muteNotice } = require('../db/messagePosting');
const { messageAuthor } = require('../db/messageManagement');
const createPostingWait = require('./postingWait');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, enforceAutomod, floodCheck, logAudit } = ctx;
  const uid = () => socket.user.id;
  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
  const idOf = (data) => (data && Number.isInteger(data.id) && data.id > 0 ? data.id : null);

  // The calendar channel behind a code, when this user can reach it.
  const calendarByCode = (code) => {
    const ch = reachableChannelByCode(ctx, socket.user, typeof code === 'string' ? code.trim() : '');
    return ch && ch.is_calendar && !ch.is_dm ? ch : null;
  };
  // An event and its channel, when this user can reach that channel.
  const eventById = (id) => {
    const row = id ? cal.getRow(db, id) : null;
    const ch = row ? reachableChannel(ctx, socket.user, row.channel_id) : null;
    return ch && ch.is_calendar && !ch.is_dm ? { row, ch } : null;
  };

  // The same timeout check and wording a message gets.
  const mutedNotice = () => muteNotice(getActiveMute(db, uid()));
  // New accounts wait before adding events, as they do before posting.
  const { youngAccountWait } = createPostingWait(socket, ctx);
  const moderates = (ch) => socket.user.isAdmin || userHasPermission(uid(), 'delete_message', ch.id);
  // Adding an event is posting: a read-only calendar takes the override, as
  // a read-only channel does for messages.
  const mayPost = (ch) => socket.user.isAdmin || !ch.read_only || userHasPermission(uid(), 'read_only_override', ch.id);
  const postRefusal = (ch) => (!mayPost(ch) ? 'Only some members can add events to this calendar'
    : (socket.user.isAdmin ? null : mutedNotice() || youngAccountWait(ch.id)?.message || null));
  // A moderator changing or removing someone else's event goes on the audit
  // log, as deleting someone else's message does.
  const auditOthers = (action, row, ch) => {
    if (row.created_by === uid()) return;
    logAudit?.({ actor: socket.user, action, target_type: 'calendar_event', target_id: row.id,
      target_name: messageAuthor(db, row.created_by)?.name || null, details: { channel: ch.name, title: row.title } });
  };

  // Clean the text, then let automod judge it as one message would be judged.
  // automod tells the sender itself when it refuses, so the reply only says
  // it was blocked.
  const screened = (ev, ch) => {
    const clean = (s) => sanitizeText(s).trim();
    const out = { ...ev, title: clean(ev.title), description: clean(ev.description), location: clean(ev.location) };
    if (!out.title) return null;
    const text = [out.title, out.location, out.description].filter(Boolean).join('\n');
    return enforceAutomod(text, { surface: 'message', channelId: ch.id }) ? null : out;
  };

  const announce = (ch, id) => {
    const event = cal.getEvent(db, id);
    if (event) io.to(`channel:${ch.code}`).emit('calendar-changed', { channelCode: ch.code, event });
  };

  socket.on('calendar-events', (data, callback) => {
    const cb = ack(callback);
    try {
      const ch = calendarByCode(data && data.code);
      if (!ch) return cb({ error: 'Calendar not found' });
      const range = cal.parseRange(data.from, data.to);
      if (range.error) return cb({ error: range.error });
      cb({
        ok: true,
        events: cal.listRange(db, ch.id, uid(), range.from, range.to),
        canPost: !postRefusal(ch),
        canModerate: moderates(ch),
      });
    } catch (err) {
      console.error('calendar-events error:', err);
      cb({ error: 'Failed to load the calendar' });
    }
  });

  socket.on('calendar-event', (data, callback) => {
    const cb = ack(callback);
    try {
      const found = eventById(idOf(data));
      if (!found) return cb({ error: 'Event not found' });
      cb({ ok: true, event: cal.getEvent(db, found.row.id, uid()), attendees: cal.attendees(db, found.row.id) });
    } catch (err) {
      console.error('calendar-event error:', err);
      cb({ error: 'Failed to load the event' });
    }
  });

  socket.on('calendar-create', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const ch = calendarByCode(data && data.code);
      if (!ch) return cb({ error: 'Calendar not found' });
      const why = postRefusal(ch);
      if (why) return cb({ error: why });
      const parsed = cal.parseEvent(data);
      if (parsed.error) return cb({ error: parsed.error });
      const ev = screened(parsed.event, ch);
      if (!ev) return cb({ blocked: true });
      const made = cal.createEvent(db, ch.id, uid(), ev);
      if (made.error) return cb({ error: made.error });
      announce(ch, made.id);
      cb({ ok: true, event: cal.getEvent(db, made.id, uid()) });
    } catch (err) {
      console.error('calendar-create error:', err);
      cb({ error: 'Failed to add the event' });
    }
  });

  socket.on('calendar-update', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const found = eventById(idOf(data));
      if (!found) return cb({ error: 'Event not found' });
      const { row, ch } = found;
      // The creator edits while they may still post there; a moderator any time.
      const own = row.created_by === uid() && !postRefusal(ch);
      if (!own && !moderates(ch)) return cb({ error: 'You can only edit your own events' });
      const parsed = cal.parseEvent(data, row);
      if (parsed.error) return cb({ error: parsed.error });
      const ev = screened(parsed.event, ch);
      if (!ev) return cb({ blocked: true });
      cal.updateEvent(db, row.id, ev);
      auditOthers('calendar_event_update', row, ch);
      announce(ch, row.id);
      cb({ ok: true, event: cal.getEvent(db, row.id, uid()) });
    } catch (err) {
      console.error('calendar-update error:', err);
      cb({ error: 'Failed to save the event' });
    }
  });

  socket.on('calendar-delete', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('event')) return cb({ error: 'Slow down a moment' });
      const found = eventById(idOf(data));
      if (!found) return cb({ error: 'Event not found' });
      const { row, ch } = found;
      if (row.created_by !== uid() && !moderates(ch)) return cb({ error: 'You can only delete your own events' });
      cal.deleteEvent(db, row.id);
      auditOthers('calendar_event_delete', row, ch);
      io.to(`channel:${ch.code}`).emit('calendar-removed', { channelCode: ch.code, id: row.id });
      cb({ ok: true });
    } catch (err) {
      console.error('calendar-delete error:', err);
      cb({ error: 'Failed to delete the event' });
    }
  });

  socket.on('calendar-rsvp', (data, callback) => {
    const cb = ack(callback);
    try {
      // Every answer is sent on to the whole channel, so it is rate limited.
      if (floodCheck('event')) return cb({ error: 'Slow down a moment' });
      const status = data ? data.status : undefined;
      if (status !== null && !cal.STATUSES.includes(status)) return cb({ error: 'Invalid answer' });
      const found = eventById(idOf(data));
      if (!found) return cb({ error: 'Event not found' });
      cal.setRsvp(db, found.row.id, uid(), status);
      announce(found.ch, found.row.id);
      cb({ ok: true, event: cal.getEvent(db, found.row.id, uid()) });
    } catch (err) {
      console.error('calendar-rsvp error:', err);
      cb({ error: 'Failed to save your answer' });
    }
  });
};
