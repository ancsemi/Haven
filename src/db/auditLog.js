'use strict';

const { utcStamp } = require('../socketHandlers/helpers');
const { hideChannelCodes } = require('../auditStream');

async function readAuditLog(db, opts, user) {
  const limit = Math.max(1, Math.min(200, parseInt(opts?.limit, 10) || 50));
  const beforeId = parseInt(opts?.beforeId, 10) || 0;
  // afterId pages forward instead, oldest first: a bot following the log
  // live catches up from the last row it saw (src/auditStream.js).
  const afterId = parseInt(opts?.afterId, 10) || 0;
  const action = typeof opts?.action === 'string' && opts.action ? opts.action : null;
  const actorUsername = typeof opts?.actorUsername === 'string' && opts.actorUsername
    ? opts.actorUsername.trim().toLowerCase().slice(0, 40) : null;

  const where = [];
  const params = [];
  if (beforeId > 0) { where.push('id < ?'); params.push(beforeId); }
  if (afterId > 0) { where.push('id > ?'); params.push(afterId); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (actorUsername) { where.push('LOWER(actor_username) LIKE ?'); params.push('%' + actorUsername + '%'); }
  // Notes are for staff, never for the member they are about, even one
  // who can read this log: their own history leaves notes out too. That
  // covers the note and the row for taking one back, whose details are
  // { caseId, type }. Filtered here, not after, so a page still holds
  // `limit` rows. The live stream does the same with isNoteAbout.
  where.push(`NOT (COALESCE(target_id, 0) = ? AND (action = 'user_note' OR (action = 'mod_case_revoke'
    AND COALESCE(details, '') LIKE '%"type":"note"%')))`);
  params.push(user.id);
  const whereSql = 'WHERE ' + where.join(' AND ');

  const [found, actions] = await Promise.all([
    db.prepare(
      'SELECT id, created_at, actor_id, actor_username, action, target_type, target_id, target_name, details ' +
      'FROM audit_log ' + whereSql + ` ORDER BY id ${afterId > 0 ? 'ASC' : 'DESC'} LIMIT ?`
    ).all(...params, limit),
    db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action ASC').all(),
  ]);
  // Times go out as UTC with a Z, as audit-entry sends them. Channel codes
  // can be used to join a room, so only admins see them here.
  for (const row of found) row.created_at = utcStamp(row.created_at);
  const rows = user.isAdmin ? found : found.map(hideChannelCodes);
  return { rows, actions: actions.map(row => row.action), hasMore: rows.length === limit };
}

module.exports = readAuditLog;
