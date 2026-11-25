'use strict';

// Calendar channels: a channel with is_calendar set shows a month of events
// instead of a message log. Anyone who may post there adds events; anyone who
// can read it answers going, maybe or can't go.
//
// Times are stored as ISO 8601 UTC strings, so they sort and compare as text.
// An all-day event is a date rather than a moment: it is stored from 00:00 to
// 23:59:59.999 UTC of its days and shown on those same dates in every time
// zone, so a Saturday event stays on Saturday for a member on the other side
// of the world. Range reads widen by a day on each side to catch those.

const LIMITS = { title: 100, description: 2000, location: 200 };
const STATUSES = ['going', 'maybe', 'declined'];
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MAX_SPAN_MS = 31 * DAY_MS;
const MAX_RANGE_MS = 100 * DAY_MS;
const LIST_LIMIT = 500;
const MAX_PER_CHANNEL = 5000;
const MIN_TIME = Date.UTC(1970, 0, 1);
const MAX_TIME = Date.UTC(2200, 0, 1);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_events_channel_start ON calendar_events(channel_id, starts_at);
    CREATE TABLE IF NOT EXISTS calendar_rsvps (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_rsvps_user ON calendar_rsvps(user_id);
  `);
}

// A moment from an ISO string or epoch milliseconds; NaN when it is neither.
function toTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || !v || v.length > 40) return NaN;
  return Date.parse(v);
}

// The UTC midnight that starts a calendar date. 'YYYY-MM-DD' is taken as
// written (and must be a real date); a full timestamp is cut to its UTC day.
function dayStart(v) {
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : NaN;
  }
  const t = toTime(v);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) * DAY_MS : NaN;
}

const blank = (v) => v === undefined || v === null || v === '';
const iso = (t) => new Date(t).toISOString();

// Checks an event sent by a client. For an edit, `base` is the stored row and
// any field the client left out keeps its value. Returns { event } in column
// form, or { error } with a message to show.
function parseEvent(input, base = null) {
  if (!input || typeof input !== 'object') return { error: 'Invalid event' };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const pick = (k, fallback) => (has(k) ? input[k] : fallback);
  const title = pick('title', base ? base.title : undefined);
  if (typeof title !== 'string' || !title.trim()) return { error: 'Give the event a title' };
  if (title.trim().length > LIMITS.title) return { error: `Titles can be up to ${LIMITS.title} characters` };
  const description = pick('description', base ? base.description : '');
  if (!blank(description) && (typeof description !== 'string' || description.length > LIMITS.description)) {
    return { error: `Descriptions can be up to ${LIMITS.description} characters` };
  }
  const location = pick('location', base ? base.location : '');
  if (!blank(location) && (typeof location !== 'string' || location.trim().length > LIMITS.location)) {
    return { error: `Locations can be up to ${LIMITS.location} characters` };
  }
  const allDay = !!pick('allDay', base ? base.all_day : false);
  const rawStart = pick('startsAt', base ? base.starts_at : undefined);
  // A new start or a switch to or from all-day without an end gets the
  // default length again instead of keeping an end that may no longer fit.
  const rawEnd = has('endsAt') ? input.endsAt : (has('startsAt') || has('allDay') ? undefined : (base ? base.ends_at : undefined));
  let start;
  let end;
  if (allDay) {
    start = dayStart(rawStart);
    end = blank(rawEnd) ? start : dayStart(rawEnd);
    end += DAY_MS - 1;
  } else {
    start = toTime(rawStart);
    end = blank(rawEnd) ? start + HOUR_MS : toTime(rawEnd);
  }
  if (!Number.isFinite(start) || start < MIN_TIME || start >= MAX_TIME) return { error: 'Pick a valid start time' };
  if (!Number.isFinite(end) || end >= MAX_TIME + DAY_MS) return { error: 'Pick a valid end time' };
  if (end < start) return { error: 'The event has to end after it starts' };
  if (end - start > MAX_SPAN_MS) return { error: 'An event can last up to 31 days' };
  let color = pick('color', base ? base.color : null);
  if (blank(color)) color = null;
  if (color !== null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) return { error: 'Invalid color' };
  return {
    event: {
      title: title.trim(),
      description: blank(description) ? '' : description.trim(),
      location: blank(location) ? '' : location.trim(),
      starts_at: iso(start),
      ends_at: iso(end),
      all_day: allDay ? 1 : 0,
      color: color ? color.toLowerCase() : null,
    },
  };
}

// A time range a client asks to read. Returns { from, to } in milliseconds,
// or { error }.
function parseRange(from, to) {
  const f = toTime(from);
  const t = toTime(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return { error: 'Invalid range' };
  if (t - f > MAX_RANGE_MS) return { error: 'That range is too long' };
  return { from: f, to: t };
}

const EVENT_COLS = `e.id, e.channel_id, e.created_by, e.title, e.description, e.location,
  e.starts_at, e.ends_at, e.all_day, e.color, e.created_at, e.updated_at,
  u.username AS creator_username, u.display_name AS creator_display_name,
  (SELECT COUNT(*) FROM calendar_rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going,
  (SELECT COUNT(*) FROM calendar_rsvps r WHERE r.event_id = e.id AND r.status = 'maybe') AS maybe`;

// What a client sees. `mine` (the viewer's own answer) is left out of what is
// broadcast, so one person's answer is never shown as everyone's.
function shape(row, withMine) {
  const ev = {
    id: row.id,
    title: row.title,
    description: row.description || '',
    location: row.location || '',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: !!row.all_day,
    color: row.color || null,
    createdBy: row.created_by,
    creatorName: row.creator_display_name || row.creator_username || null,
    going: row.going || 0,
    maybe: row.maybe || 0,
    updatedAt: row.updated_at,
  };
  if (withMine) ev.mine = row.mine || null;
  return ev;
}

function listRange(db, channelId, userId, fromMs, toMs) {
  return db.prepare(`SELECT ${EVENT_COLS},
      (SELECT status FROM calendar_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS mine
    FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.channel_id = ? AND e.starts_at < ? AND e.ends_at >= ?
    ORDER BY e.starts_at, e.id LIMIT ${LIST_LIMIT}`)
    .all(userId, channelId, iso(toMs + DAY_MS), iso(fromMs - DAY_MS))
    .map(r => shape(r, true));
}

// The next events across several calendars, soonest first, each with the
// viewer's own answer and its channel id. An all-day event stays listed for a
// day past its UTC end, so it is still there for a member whose clock has
// not reached the next date; the client drops it once its date has passed.
function upcoming(db, channelIds, userId, nowMs, limit) {
  if (!channelIds.length) return [];
  return db.prepare(`SELECT ${EVENT_COLS},
      (SELECT status FROM calendar_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS mine
    FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.channel_id IN (SELECT value FROM json_each(?))
      AND e.starts_at >= ? AND e.starts_at < ?
      AND e.ends_at >= CASE WHEN e.all_day = 1 THEN ? ELSE ? END
    ORDER BY e.starts_at, e.id LIMIT ?`)
    .all(userId, JSON.stringify(channelIds), iso(nowMs - MAX_SPAN_MS - DAY_MS), iso(nowMs + 366 * DAY_MS),
      iso(nowMs - DAY_MS), iso(nowMs), limit)
    .map(r => ({ ...shape(r, true), channelId: r.channel_id }));
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) || null;
}

// One event; with a userId it carries that user's own answer.
function getEvent(db, id, userId = null) {
  const row = db.prepare(`SELECT ${EVENT_COLS},
      (SELECT status FROM calendar_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS mine
    FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`).get(userId, id);
  return row ? shape(row, userId !== null) : null;
}

function attendees(db, id) {
  return db.prepare(`SELECT r.user_id, r.status, u.username, u.display_name
    FROM calendar_rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ?
    ORDER BY CASE r.status WHEN 'going' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END,
      LOWER(COALESCE(u.display_name, u.username)), r.user_id
    LIMIT ${LIST_LIMIT}`).all(id)
    .map(r => ({ userId: r.user_id, name: r.display_name || r.username, status: r.status }));
}

function createEvent(db, channelId, userId, ev) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE channel_id = ?').get(channelId).n;
  if (n >= MAX_PER_CHANNEL) return { error: 'This calendar is full. Delete some old events first' };
  const r = db.prepare(`INSERT INTO calendar_events
      (channel_id, created_by, title, description, location, starts_at, ends_at, all_day, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(channelId, userId, ev.title, ev.description, ev.location, ev.starts_at, ev.ends_at, ev.all_day, ev.color);
  return { id: Number(r.lastInsertRowid) };
}

function updateEvent(db, id, ev) {
  db.prepare(`UPDATE calendar_events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
      all_day = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(ev.title, ev.description, ev.location, ev.starts_at, ev.ends_at, ev.all_day, ev.color, id);
}

function deleteEvent(db, id) {
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
}

// null takes the answer back.
function setRsvp(db, id, userId, status) {
  if (status === null) {
    db.prepare('DELETE FROM calendar_rsvps WHERE event_id = ? AND user_id = ?').run(id, userId);
    return;
  }
  db.prepare(`INSERT INTO calendar_rsvps (event_id, user_id, status) VALUES (?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`)
    .run(id, userId, status);
}

module.exports = {
  LIMITS, STATUSES, ensureTables, parseEvent, parseRange, listRange, upcoming,
  getRow, getEvent, attendees, createEvent, updateEvent, deleteEvent, setRsvp,
};
