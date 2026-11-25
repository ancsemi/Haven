'use strict';

// Warnings, notes and the moderation history (src/modCases.js, #5759).

const modCases = require('../modCases');
const { isInt } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, getUserEffectiveLevel, logAudit } = ctx;
  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

  // Anyone who can kick, mute or ban members can warn them and keep notes.
  // Any error denies.
  const can = (perms) => {
    try {
      if (socket.user.isAdmin) return true;
      return perms.some(p => userHasPermission(socket.user.id, p));
    } catch (err) {
      console.warn('[mod-cases] permission check failed:', err.message);
      return false;
    }
  };
  const canModerate = () => can(['kick_user', 'mute_user', 'ban_user']);
  const canView = () => can(['kick_user', 'mute_user', 'ban_user', 'view_audit_log']);
  const canRevoke = () => can(['ban_user']);

  // Nobody acts on someone at or above their own level; admins can act on
  // anyone but another admin. Any error denies.
  const outranks = (targetId) => {
    try {
      const target = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(targetId);
      if (!target) return false;
      if (target.is_admin) return false;
      if (socket.user.isAdmin) return true;
      return getUserEffectiveLevel(socket.user.id) > getUserEffectiveLevel(targetId);
    } catch (err) {
      console.warn('[mod-cases] rank check failed:', err.message);
      return false;
    }
  };

  const targetOf = (data) => {
    const userId = data && isInt(data.userId) ? data.userId : null;
    if (!userId || userId === socket.user.id) return null;
    return db.prepare('SELECT id, username, COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(userId) || null;
  };

  socket.on('warn-user', (data, cb) => {
    const done = reply(cb);
    if (!socket.user) return;
    if (!canModerate()) return done({ ok: false, error: 'You don\'t have permission to warn members' });
    const target = targetOf(data);
    if (!target) return done({ ok: false, error: 'Member not found' });
    if (!outranks(target.id)) return done({ ok: false, error: 'You can\'t warn someone at or above your own rank' });
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : '';
    if (!reason) return done({ ok: false, error: 'A warning needs a reason' });
    const severity = isInt(data.severity) ? Math.max(0, Math.min(10, data.severity)) : 1;
    try {
      const id = modCases.add(db, { userId: target.id, actor: socket.user, type: 'warn', reason, severity });
      logAudit?.({ actor: socket.user, action: 'user_warn', target_type: 'user', target_id: target.id,
        target_name: target.username, details: { reason, severity, caseId: id } });
      const created = modCases.get(db, id);
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === target.id) s.emit('mod-warning', { id, reason, createdAt: created && created.created_at });
      }
      done({ ok: true, id, points: modCases.points(db, target.id) });
    } catch (err) {
      console.warn('[mod-cases] warn failed:', err.message);
      done({ ok: false, error: 'Could not save the warning' });
    }
  });

  socket.on('add-mod-note', (data, cb) => {
    const done = reply(cb);
    if (!socket.user) return;
    if (!canModerate()) return done({ ok: false, error: 'You don\'t have permission to add notes' });
    const target = targetOf(data);
    if (!target) return done({ ok: false, error: 'Member not found' });
    if (!outranks(target.id)) return done({ ok: false, error: 'You can\'t add notes on someone at or above your own rank' });
    const text = typeof data.text === 'string' ? data.text.trim().slice(0, 500) : '';
    if (!text) return done({ ok: false, error: 'The note is empty' });
    try {
      const id = modCases.add(db, { userId: target.id, actor: socket.user, type: 'note', reason: text });
      // The log hides this row from the member it is about (get-audit-log).
      logAudit?.({ actor: socket.user, action: 'user_note', target_type: 'user', target_id: target.id,
        target_name: target.username, details: { note: text, caseId: id } });
      done({ ok: true, id });
    } catch (err) {
      console.warn('[mod-cases] note failed:', err.message);
      done({ ok: false, error: 'Could not save the note' });
    }
  });

  // A member may ask for their own history (no notes, no names); otherwise
  // it takes a moderator.
  socket.on('get-mod-history', (data, cb) => {
    const done = reply(cb);
    if (!socket.user) return;
    const userId = data && isInt(data.userId) ? data.userId : null;
    if (!userId) return done({ ok: false, error: 'Member not found' });
    const self = userId === socket.user.id;
    if (!self && !canView()) return done({ ok: false, error: 'You don\'t have permission to see this' });
    try {
      done({
        ok: true,
        cases: modCases.list(db, userId, { forSelf: self }),
        points: modCases.points(db, userId),
        pointsDays: modCases.POINTS_DAYS,
        canAdd: !self && canModerate(),
        canRevoke: !self && canRevoke(),
      });
    } catch (err) {
      console.warn('[mod-cases] history failed:', err.message);
      done({ ok: false, error: 'Could not load the history' });
    }
  });

  socket.on('revoke-mod-case', (data, cb) => {
    const done = reply(cb);
    if (!socket.user) return;
    if (!canRevoke()) return done({ ok: false, error: 'You don\'t have permission to revoke records' });
    const id = data && isInt(data.id) ? data.id : null;
    const row = id ? modCases.get(db, id) : null;
    if (!row) return done({ ok: false, error: 'Record not found' });
    if (row.user_id === socket.user.id) return done({ ok: false, error: 'You can\'t revoke your own record' });
    // The same lines as giving one: not on someone at or above your rank, and
    // not a record placed by the admin or by someone at or above your rank.
    if (!outranks(row.user_id)) return done({ ok: false, error: 'You can\'t revoke records of someone at or above your own rank' });
    if (!socket.user.isAdmin && row.actor_id && row.actor_id !== socket.user.id) {
      const placer = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(row.actor_id);
      if (placer && (placer.is_admin || getUserEffectiveLevel(row.actor_id) >= getUserEffectiveLevel(socket.user.id))) {
        return done({ ok: false, error: 'You can\'t revoke a record placed by someone of equal or higher rank' });
      }
    }
    try {
      modCases.revoke(db, id, socket.user.displayName || socket.user.username);
      logAudit?.({ actor: socket.user, action: 'mod_case_revoke', target_type: 'user', target_id: row.user_id,
        details: { caseId: id, type: row.type } });
      done({ ok: true });
    } catch (err) {
      console.warn('[mod-cases] revoke failed:', err.message);
      done({ ok: false, error: 'Could not revoke the record' });
    }
  });

  // Warnings given while the member was away are shown when they come back.
  socket.on('get-pending-warnings', (_data, cb) => {
    const done = reply(cb);
    if (!socket.user) return;
    try {
      done({ ok: true, warnings: modCases.unseenWarnings(db, socket.user.id) });
    } catch (err) {
      console.warn('[mod-cases] pending warnings failed:', err.message);
      done({ ok: false, warnings: [] });
    }
  });

  socket.on('ack-mod-warning', (data) => {
    if (!socket.user || !data || !isInt(data.id)) return;
    try {
      modCases.markSeen(db, socket.user.id, data.id);
    } catch (err) {
      console.warn('[mod-cases] acknowledging a warning failed:', err.message);
    }
  });
};
