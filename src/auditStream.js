'use strict';

// The live audit log for bot accounts. A bot that can read the log
// (view_audit_log, or the admin) subscribes and gets each new row as it is
// written, the same row get-audit-log would give it: channel codes hidden
// from all but the admin, and no note about the bot itself. People read the
// log in Settings and never subscribe.
//
// Rows go out after the write that made them has finished, so a row from a
// transaction that rolled back is never sent, and in id order with no repeats.
// The permission is checked again at every row: a bot that loses it is
// dropped then and told why. A bot catches up on what it missed while
// offline with get-audit-log { afterId }.

const { utcStamp } = require('./socketHandlers/helpers');

const ROW_SELECT = 'SELECT id, created_at, actor_id, actor_username, action, target_type, target_id, target_name, details FROM audit_log';

// Channel codes are invites (a code is enough to join), so only the admin
// sees them in the log. Gives a copy; the row itself is left as it is.
function hideChannelCodes(row) {
  const hide = (v) => (typeof v === 'string' ? v.replace(/\b[a-f0-9]{8}\b/gi, '(code hidden)') : v);
  return { ...row, target_name: hide(row.target_name), details: hide(row.details) };
}

// A note, or taking one back, about this member: never shown to them, even
// when they can read the log. get-audit-log filters the same rows in SQL.
function isNoteAbout(row, userId) {
  if (row.target_id !== userId) return false;
  if (row.action === 'user_note') return true;
  if (row.action !== 'mod_case_revoke') return false;
  try { return JSON.parse(row.details).type === 'note'; } catch { return false; }
}

function createAuditStream({ db, userHasPermission }) {
  const subscribers = new Map(); // socket → { actions: Set | null }
  let lastSent = 0;

  const canRead = (socket) => {
    try {
      return !!socket.user && !!socket.user.botAccount
        && (socket.user.isAdmin || userHasPermission(socket.user.id, 'view_audit_log'));
    } catch (err) {
      console.warn('[audit-stream] permission check failed:', err.message);
      return false;
    }
  };

  function drop(socket, reason) {
    subscribers.delete(socket);
    socket.emit('audit-log-unsubscribed', { reason });
  }

  // Only a row that is there moves lastSent on: SQLite can give the id of a
  // rolled-back row to the next insert, and that row must still go out.
  function send(id) {
    if (id <= lastSent || !subscribers.size) return;
    const row = db.prepare(`${ROW_SELECT} WHERE id = ?`).get(id);
    if (!row) return;
    lastSent = id;
    row.created_at = utcStamp(row.created_at);
    let hidden = null;
    for (const [socket, sub] of subscribers) {
      if (!socket.connected) { subscribers.delete(socket); continue; }
      if (!canRead(socket)) { drop(socket, 'You no longer have permission to read the audit log'); continue; }
      if (sub.actions && !sub.actions.has(row.action)) continue;
      if (isNoteAbout(row, socket.user.id)) continue;
      if (socket.user.isAdmin) socket.emit('audit-entry', row);
      else socket.emit('audit-entry', hidden || (hidden = hideChannelCodes(row)));
    }
  }

  return {
    canRead,

    // The row was just inserted. Sent on the next turn, once the transaction
    // around the write (if any) has committed or rolled back.
    publish(id) {
      if (!subscribers.size || !Number.isInteger(id)) return;
      setImmediate(() => {
        try { send(id); } catch (err) { console.warn('[audit-stream] send failed:', err.message); }
      });
    },

    // actions: a Set of action names, or null for all of them. Subscribing
    // again replaces the list. Gives the newest row id at this moment.
    subscribe(socket, actions) {
      subscribers.set(socket, { actions });
      const top = db.prepare('SELECT MAX(id) AS id FROM audit_log').get();
      return top && top.id ? top.id : 0;
    },

    unsubscribe(socket) {
      return subscribers.delete(socket);
    },

    has(socket) {
      return subscribers.has(socket);
    },
  };
}

module.exports = { createAuditStream, hideChannelCodes, isNoteAbout };
