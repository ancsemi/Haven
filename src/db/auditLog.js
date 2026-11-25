'use strict';

async function readAuditLog(db, opts, isAdmin) {
  const limit = Math.max(1, Math.min(200, parseInt(opts?.limit, 10) || 50));
  const beforeId = parseInt(opts?.beforeId, 10) || 0;
  const action = typeof opts?.action === 'string' && opts.action ? opts.action : null;
  const actorUsername = typeof opts?.actorUsername === 'string' && opts.actorUsername
    ? opts.actorUsername.trim().toLowerCase().slice(0, 40) : null;

  const where = [];
  const params = [];
  if (beforeId > 0) { where.push('id < ?'); params.push(beforeId); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (actorUsername) { where.push('LOWER(actor_username) LIKE ?'); params.push('%' + actorUsername + '%'); }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

  const [rows, actions] = await Promise.all([
    db.prepare(
      'SELECT id, created_at, actor_id, actor_username, action, target_type, target_id, target_name, details ' +
      'FROM audit_log ' + whereSql + ' ORDER BY id DESC LIMIT ?'
    ).all(...params, limit),
    db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action ASC').all(),
  ]);
  // Channel codes can be used to join a room. Only admins see them here.
  if (!isAdmin) {
    const hide = (v) => typeof v === 'string' ? v.replace(/\b[a-f0-9]{8}\b/gi, '(code hidden)') : v;
    for (const row of rows) {
      row.target_name = hide(row.target_name);
      row.details = hide(row.details);
    }
  }
  return { rows, actions: actions.map(row => row.action), hasMore: rows.length === limit };
}

module.exports = readAuditLog;
