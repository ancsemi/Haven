'use strict';

// Moderation history (#5759): one record per thing a moderator did to a
// member, kept after the mute or ban itself is lifted. Kicks, mutes, bans
// and their reversals are recorded from the audit log as they happen (see
// fromAudit); warnings and notes are written here directly. A record is
// never deleted, only marked revoked, so a warning given unfairly can be
// undone and still be seen.
//
// The member sees their own warnings, mutes, kicks and bans, but not the
// notes and not who acted. Moderators see everything.

const TYPES = ['warn', 'note', 'kick', 'mute', 'unmute', 'ban', 'unban'];
// Points add up over this many days, then drop off.
const POINTS_DAYS = 90;

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mod_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT,
      type TEXT NOT NULL,
      reason TEXT,
      severity INTEGER NOT NULL DEFAULT 0,
      duration_minutes INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      seen_at DATETIME,
      revoked_at DATETIME,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mod_cases_user ON mod_cases(user_id, created_at DESC);
  `);
}

function add(db, { userId, actor, type, reason = null, severity = 0, durationMinutes = null }) {
  if (!Number.isInteger(userId) || !TYPES.includes(type)) return null;
  const actorId = actor && Number.isInteger(actor.id) ? actor.id : null;
  const actorName = actor ? String(actor.name || actor.displayName || actor.username || '').slice(0, 64) || null : null;
  const r = db.prepare(`INSERT INTO mod_cases (user_id, actor_id, actor_name, type, reason, severity, duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, actorId, actorName, type,
    reason ? String(reason).slice(0, 500) : null, Math.max(0, Math.min(10, severity | 0)),
    Number.isInteger(durationMinutes) ? durationMinutes : null);
  return r.lastInsertRowid;
}

// The audit log already hears about every kick, mute and ban, from people
// and from auto-mod alike; this turns those into history records. Gives the
// new record's id, or null when the action makes none.
const FROM_AUDIT = {
  user_kick: 'kick', user_mute: 'mute', user_unmute: 'unmute', user_ban: 'ban', user_unban: 'unban',
  automod_mute: 'mute', automod_ban: 'ban',
};

function fromAudit(db, { action, actorId, actorName, targetId, details }) {
  const type = FROM_AUDIT[action];
  if (!type || !Number.isInteger(targetId)) return null;
  const auto = action.startsWith('automod_');
  const d = details && typeof details === 'object' ? details : {};
  return add(db, {
    userId: targetId,
    // Auto-mod logs the member as the actor; the record says auto-mod.
    actor: auto ? { name: 'Auto-mod' } : { id: actorId, name: actorName },
    type,
    reason: d.reason || (auto ? `Auto-mod (${d.strikes || 0} strikes)` : null),
    durationMinutes: Number.isInteger(d.durationMinutes) ? d.durationMinutes : (Number.isInteger(d.minutes) ? d.minutes : null),
  });
}

// Records for one member, newest first. forSelf leaves out notes and who
// acted.
function list(db, userId, { forSelf = false } = {}) {
  const rows = db.prepare(`SELECT id, actor_name, type, reason, severity, duration_minutes, created_at, revoked_at, revoked_by
    FROM mod_cases WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 500`).all(userId);
  return rows
    .filter(r => !(forSelf && r.type === 'note'))
    .map(r => ({
      id: r.id,
      type: r.type,
      reason: r.reason,
      severity: r.severity,
      durationMinutes: r.duration_minutes,
      createdAt: r.created_at,
      revoked: !!r.revoked_at,
      ...(forSelf ? {} : { actor: r.actor_name, revokedBy: r.revoked_by }),
    }));
}

function points(db, userId) {
  const row = db.prepare(`SELECT COALESCE(SUM(severity), 0) AS n FROM mod_cases
    WHERE user_id = ? AND revoked_at IS NULL AND created_at > datetime('now', ?)`).get(userId, `-${POINTS_DAYS} days`);
  return row ? row.n : 0;
}

function get(db, id) {
  return db.prepare('SELECT * FROM mod_cases WHERE id = ?').get(id) || null;
}

function revoke(db, id, byName) {
  return db.prepare("UPDATE mod_cases SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ? AND revoked_at IS NULL")
    .run(String(byName || '').slice(0, 64) || null, id).changes > 0;
}

// Warnings the member has not acknowledged yet, oldest first.
function unseenWarnings(db, userId) {
  return db.prepare(`SELECT id, reason, created_at FROM mod_cases
    WHERE user_id = ? AND type = 'warn' AND seen_at IS NULL AND revoked_at IS NULL ORDER BY id`).all(userId)
    .map(r => ({ id: r.id, reason: r.reason, createdAt: r.created_at }));
}

function markSeen(db, userId, id) {
  db.prepare("UPDATE mod_cases SET seen_at = datetime('now') WHERE id = ? AND user_id = ? AND seen_at IS NULL").run(id, userId);
}

module.exports = { ensureTable, add, fromAudit, list, points, get, revoke, unseenWarnings, markSeen, POINTS_DAYS };
