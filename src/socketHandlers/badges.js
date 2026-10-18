'use strict';

// Profile badges (#5632): the admin's badge list, giving and taking back
// hand-given badges, and a member hiding a badge on their own card.
// Data and counting live in src/badges.js; icon uploads in src/routes/badges.js.
//
// Rules, the same ones role assignment follows:
//   - Definitions and hand-giving need the admin or Manage Badges.
//   - Someone who is not the admin only gives or takes back badges for people
//     ranked below them, never for themselves.
//   - A badge tied to a role is made, changed or deleted by someone who is not
//     the admin only when that role sits below them.
//   - Every check that fails, or throws, refuses.

const path = require('path');
const badges = require('../badges');
const storage = require('../storage');

module.exports = function register(socket, ctx) {
  const { db, userHasPermission, getUserEffectiveLevel, logAudit } = ctx;
  const audit = typeof logAudit === 'function' ? logAudit : () => {};
  const answer = (cb) => (typeof cb === 'function' ? cb : () => {});

  const canManage = () => {
    if (!socket.user || socket.user.isBot) return false;
    try {
      return !!(socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_badges'));
    } catch (err) {
      console.warn('[badges] permission check failed:', err.message);
      return false;
    }
  };

  // Ranked below the caller (the admin may act on anyone, themselves too).
  const canActOn = (userId) => {
    if (socket.user.isAdmin) return true;
    if (userId === socket.user.id) return false;
    try {
      return getUserEffectiveLevel(userId) < getUserEffectiveLevel(socket.user.id);
    } catch (err) {
      console.warn('[badges] rank check failed:', err.message);
      return false;
    }
  };

  // null when the caller may tie a badge to this role, else the reason.
  const roleRefusal = (roleId) => {
    if (socket.user.isAdmin || roleId == null) return null;
    try {
      const role = db.prepare('SELECT level FROM roles WHERE id = ?').get(roleId);
      if (!role) return null;
      return role.level < getUserEffectiveLevel(socket.user.id) ? null : 'You can only tie badges to roles below your own';
    } catch (err) {
      console.warn('[badges] role check failed:', err.message);
      return 'Could not check that role';
    }
  };

  const nameOf = (userId) => {
    const row = db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(userId);
    return row ? row.name : null;
  };

  // An uploaded icon no badge uses any more goes from storage.
  const dropIconFile = async (icon) => {
    if (!icon || !badges.ICON_PATH_RE.test(icon)) return;
    if (db.prepare("SELECT 1 FROM badges WHERE icon_type = 'image' AND icon = ?").get(icon)) return;
    await storage.remove(`badges/${path.basename(icon)}`);
  };

  // The icon key for a checked badge, or the reason it cannot be used: the
  // uploaded file is gone, or another badge already shows this icon.
  const keyFor = async (b, current = null) => {
    const same = current && current.icon_type === b.icon_type && current.icon === b.icon && current.icon_key;
    const key = same ? current.icon_key
      : b.icon_type === 'image' ? await badges.imageIconKey(b.icon, storage) : badges.iconKey(b.icon_type, b.icon);
    if (!key) return { error: 'That uploaded icon is missing, upload it again' };
    await badges.fillImageKeys(db, storage);
    const other = badges.iconTakenBy(db, key, current ? current.id : null);
    if (other) return { error: `Another badge already uses this icon (${other.name})` };
    return { key };
  };

  const fullList = () => ({
    ok: true,
    badges: badges.listBadges(db),
    roles: db.prepare("SELECT id, name, level, color FROM roles WHERE scope = 'server' ORDER BY level DESC, name").all(),
    builtinIcons: badges.BUILTIN_ICONS,
    canEditAll: !!socket.user.isAdmin,
    myLevel: socket.user.isAdmin ? 100 : getUserEffectiveLevel(socket.user.id),
  });

  socket.on('get-badges', (data, callback) => {
    const cb = answer(callback);
    if (!canManage()) return cb({ error: 'You do not have permission to manage badges' });
    try {
      cb(fullList());
    } catch (err) {
      console.error('[badges] list failed:', err.message);
      cb({ error: 'Could not load badges' });
    }
  });

  socket.on('create-badge', async (data, callback) => {
    const cb = answer(callback);
    if (!canManage()) return cb({ error: 'You do not have permission to manage badges' });
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM badges').get().n;
      if (count >= badges.MAX_BADGES) return cb({ error: `A server can have up to ${badges.MAX_BADGES} badges` });
      const read = badges.readBadgeInput(db, data);
      if (read.error) return cb({ error: read.error });
      const b = read.badge;
      const refusal = roleRefusal(b.role_id);
      if (refusal) return cb({ error: refusal });
      const icon = await keyFor(b);
      if (icon.error) return cb({ error: icon.error });
      const position = (db.prepare('SELECT MAX(position) AS p FROM badges').get().p ?? -1) + 1;
      const id = db.prepare(`INSERT INTO badges (name, description, icon_type, icon, icon_key, kind, threshold, role_id, enabled, position, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(b.name, b.description, b.icon_type, b.icon, icon.key, b.kind, b.threshold, b.role_id, b.enabled, position, socket.user.id).lastInsertRowid;
      audit({ actor: socket.user, action: 'badge_create', target_type: 'badge', target_id: Number(id), target_name: b.name,
        details: { kind: b.kind, threshold: b.threshold, roleId: b.role_id, enabled: !!b.enabled } });
      cb({ ...fullList(), badgeId: Number(id) });
    } catch (err) {
      console.error('[badges] create failed:', err.message);
      cb({ error: 'Could not create the badge' });
    }
  });

  socket.on('update-badge', async (data, callback) => {
    const cb = answer(callback);
    if (!canManage()) return cb({ error: 'You do not have permission to manage badges' });
    try {
      const current = badges.getBadge(db, data && data.badgeId);
      if (!current) return cb({ error: 'Badge not found' });
      const read = badges.readBadgeInput(db, data, current);
      if (read.error) return cb({ error: read.error });
      const b = read.badge;
      const refusal = roleRefusal(current.role_id) || roleRefusal(b.role_id);
      if (refusal) return cb({ error: refusal });
      const icon = await keyFor(b, current);
      if (icon.error) return cb({ error: icon.error });
      // Hand-given copies only make sense on a hand-given badge.
      const dropHolders = current.kind === 'manual' && b.kind !== 'manual';
      db.transaction(() => {
        db.prepare(`UPDATE badges SET name = ?, description = ?, icon_type = ?, icon = ?, icon_key = ?, kind = ?, threshold = ?, role_id = ?, enabled = ?
          WHERE id = ?`).run(b.name, b.description, b.icon_type, b.icon, icon.key, b.kind, b.threshold, b.role_id, b.enabled, current.id);
        if (dropHolders) db.prepare('DELETE FROM user_badges WHERE badge_id = ?').run(current.id);
      })();
      if (current.icon !== b.icon) await dropIconFile(current.icon);
      audit({ actor: socket.user, action: 'badge_update', target_type: 'badge', target_id: current.id, target_name: b.name,
        details: { kind: b.kind, threshold: b.threshold, roleId: b.role_id, enabled: !!b.enabled, renamedFrom: current.name !== b.name ? current.name : null } });
      cb(fullList());
    } catch (err) {
      console.error('[badges] update failed:', err.message);
      cb({ error: 'Could not save the badge' });
    }
  });

  socket.on('delete-badge', async (data, callback) => {
    const cb = answer(callback);
    if (!canManage()) return cb({ error: 'You do not have permission to manage badges' });
    try {
      const current = badges.getBadge(db, data && data.badgeId);
      if (!current) return cb({ error: 'Badge not found' });
      const refusal = roleRefusal(current.role_id);
      if (refusal) return cb({ error: refusal });
      db.prepare('DELETE FROM badges WHERE id = ?').run(current.id);
      await dropIconFile(current.icon);
      audit({ actor: socket.user, action: 'badge_delete', target_type: 'badge', target_id: current.id, target_name: current.name,
        details: { kind: current.kind } });
      cb(fullList());
    } catch (err) {
      console.error('[badges] delete failed:', err.message);
      cb({ error: 'Could not delete the badge' });
    }
  });

  // Who holds a hand-given badge, and whether the caller may take it back.
  socket.on('get-badge-holders', (data, callback) => {
    const cb = answer(callback);
    if (!canManage()) return cb({ error: 'You do not have permission to manage badges' });
    try {
      const badge = badges.getBadge(db, data && data.badgeId);
      if (!badge || badge.kind !== 'manual') return cb({ error: 'Badge not found' });
      const holders = db.prepare(`
        SELECT ub.user_id, COALESCE(u.display_name, u.username) AS name, ub.granted_at,
               COALESCE(g.display_name, g.username) AS granted_by
        FROM user_badges ub JOIN users u ON u.id = ub.user_id LEFT JOIN users g ON g.id = ub.granted_by
        WHERE ub.badge_id = ? ORDER BY ub.granted_at DESC LIMIT 500
      `).all(badge.id).map(h => ({ userId: h.user_id, name: h.name, grantedBy: h.granted_by || null, grantedAt: h.granted_at, canRevoke: canActOn(h.user_id) }));
      cb({ ok: true, holders });
    } catch (err) {
      console.error('[badges] holders failed:', err.message);
      cb({ error: 'Could not load who has this badge' });
    }
  });

  // The hand-given badges, ticked where this member has them.
  socket.on('get-member-badges', (data, callback) => {
    const cb = answer(callback);
    if (!canManage()) return cb({ error: 'You do not have permission to manage badges' });
    const userId = data && Number.isInteger(data.userId) ? data.userId : null;
    if (!userId || !nameOf(userId)) return cb({ error: 'Member not found' });
    if (!canActOn(userId)) return cb({ error: 'You can only give badges to people ranked below you' });
    try {
      const held = new Set(db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(userId).map(r => r.badge_id));
      const list = db.prepare("SELECT id, name, description, icon_type, icon, enabled FROM badges WHERE kind = 'manual' ORDER BY position, id").all()
        .map(b => ({ id: b.id, name: b.name, description: b.description, iconType: b.icon_type, icon: b.icon, enabled: !!b.enabled, held: held.has(b.id) }));
      cb({ ok: true, badges: list });
    } catch (err) {
      console.error('[badges] member badges failed:', err.message);
      cb({ error: 'Could not load badges' });
    }
  });

  const handGiven = (data, cb) => {
    if (!canManage()) { cb({ error: 'You do not have permission to manage badges' }); return null; }
    const userId = data && Number.isInteger(data.userId) ? data.userId : null;
    const badge = badges.getBadge(db, data && data.badgeId);
    if (!userId || !badge || badge.kind !== 'manual') { cb({ error: 'Badge not found' }); return null; }
    const name = nameOf(userId);
    if (!name) { cb({ error: 'Member not found' }); return null; }
    if (!canActOn(userId)) { cb({ error: 'You can only give or take back badges for people ranked below you' }); return null; }
    return { userId, badge, name };
  };

  socket.on('grant-badge', (data, callback) => {
    const cb = answer(callback);
    const t = handGiven(data, cb);
    if (!t) return;
    try {
      const added = db.prepare('INSERT OR IGNORE INTO user_badges (badge_id, user_id, granted_by) VALUES (?, ?, ?)')
        .run(t.badge.id, t.userId, socket.user.id).changes;
      if (added) {
        audit({ actor: socket.user, action: 'badge_grant', target_type: 'user', target_id: t.userId, target_name: t.name,
          details: { badgeId: t.badge.id, badgeName: t.badge.name } });
      }
      cb({ ok: true, held: true });
    } catch (err) {
      console.error('[badges] grant failed:', err.message);
      cb({ error: 'Could not give the badge' });
    }
  });

  socket.on('revoke-badge', (data, callback) => {
    const cb = answer(callback);
    const t = handGiven(data, cb);
    if (!t) return;
    try {
      const removed = db.prepare('DELETE FROM user_badges WHERE badge_id = ? AND user_id = ?').run(t.badge.id, t.userId).changes;
      if (removed) {
        audit({ actor: socket.user, action: 'badge_revoke', target_type: 'user', target_id: t.userId, target_name: t.name,
          details: { badgeId: t.badge.id, badgeName: t.badge.name } });
      }
      cb({ ok: true, held: false });
    } catch (err) {
      console.error('[badges] revoke failed:', err.message);
      cb({ error: 'Could not take the badge back' });
    }
  });

  // A member hides one of their own badges, or shows it again.
  socket.on('set-badge-hidden', (data, callback) => {
    const cb = answer(callback);
    if (!socket.user || socket.user.isBot) return cb({ error: 'Invalid request' });
    if (!data || typeof data.hidden !== 'boolean') return cb({ error: 'Invalid request' });
    try {
      const badge = badges.getBadge(db, data.badgeId);
      if (!badge) return cb({ error: 'Badge not found' });
      if (data.hidden) db.prepare('INSERT OR IGNORE INTO badge_hidden (user_id, badge_id) VALUES (?, ?)').run(socket.user.id, badge.id);
      else db.prepare('DELETE FROM badge_hidden WHERE user_id = ? AND badge_id = ?').run(socket.user.id, badge.id);
      cb({ ok: true, hidden: data.hidden });
    } catch (err) {
      console.error('[badges] hide failed:', err.message);
      cb({ error: 'Could not save that' });
    }
  });
};
