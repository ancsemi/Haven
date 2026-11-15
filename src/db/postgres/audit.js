'use strict';

async function writeAudit(db, { actor, action, target_type, target_id, target_name, details }) {
  try {
    await db.prepare(`
      INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, target_name, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actor?.id ?? null, actor?.displayName || actor?.username || null, action,
      target_type || null, target_id ?? null, target_name?.slice(0, 200) || null,
      details == null ? null : JSON.stringify(details).slice(0, 4000));
  } catch (err) {
    console.warn('[audit] log failed:', err.message);
  }
}

module.exports = writeAudit;
