// ── Permission system helpers (factory — closes over db) ──

module.exports = function createPermissions(db) {

  // ── Role inheritance: get the channel hierarchy chain for role cascading ──
  // Server roles → apply everywhere (channel_id IS NULL)
  // Channel role  → applies to that channel + all its sub-channels
  // Sub-channel role → only that sub-channel
  // This returns an array of channel IDs to check (the target + its parent if it's a sub)
  function getChannelRoleChain(channelId) {
    if (!channelId) return [];
    const ch = db.prepare('SELECT id, parent_channel_id FROM channels WHERE id = ?').get(channelId);
    if (!ch) return [channelId];
    if (ch.parent_channel_id) return [channelId, ch.parent_channel_id];
    return [channelId];
  }

  function getUserEffectiveLevel(userId, channelId = null) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return 100;

    const serverRole = db.prepare(`
      SELECT MAX(COALESCE(ur.custom_level, r.level)) as maxLevel FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.scope = 'server' AND ur.channel_id IS NULL
    `).get(userId);
    let level = (serverRole && serverRole.maxLevel) || 0;

    if (channelId) {
      const chain = getChannelRoleChain(channelId);
      if (chain.length > 0) {
        const placeholders = chain.map(() => '?').join(',');
        const channelRole = db.prepare(`
          SELECT MAX(COALESCE(ur.custom_level, r.level)) as maxLevel FROM roles r
          JOIN user_roles ur ON r.id = ur.role_id
          WHERE ur.user_id = ? AND ur.channel_id IN (${placeholders})
        `).get(userId, ...chain);
        if (channelRole && channelRole.maxLevel && channelRole.maxLevel > level) {
          level = channelRole.maxLevel;
        }
      }
    }
    return level;
  }

  function getPermissionThresholds() {
    try {
      const row = db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get();
      return row ? JSON.parse(row.value) : {};
    } catch { return {}; }
  }

  function userHasPermission(userId, permission, channelId = null) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return true;

    // Check per-user permission overrides first (explicit deny takes priority)
    try {
      const override = db.prepare(`
        SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = ?
        ORDER BY allowed ASC LIMIT 1
      `).get(userId, permission);
      if (override) {
        if (override.allowed === 0) return false;
        if (override.allowed === 1) return true;
      }
    } catch { /* table may not exist yet */ }

    // Check level-based permission thresholds
    const thresholds = getPermissionThresholds();
    if (thresholds[permission]) {
      const level = getUserEffectiveLevel(userId);
      if (level >= thresholds[permission]) return true;
    }

    // Check server-scoped roles
    const serverPerm = db.prepare(`
      SELECT rp.allowed FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = ? AND r.scope = 'server' AND ur.channel_id IS NULL AND rp.allowed = 1
      LIMIT 1
    `).get(userId, permission);
    if (serverPerm) return true;

    // Check channel-scoped roles (with inheritance: parent channel roles cascade to subs)
    if (channelId) {
      const chain = getChannelRoleChain(channelId);
      if (chain.length > 0) {
        const placeholders = chain.map(() => '?').join(',');
        const channelPerm = db.prepare(`
          SELECT rp.allowed FROM role_permissions rp
          JOIN roles r ON rp.role_id = r.id
          JOIN user_roles ur ON r.id = ur.role_id
          WHERE ur.user_id = ? AND rp.permission = ? AND ur.channel_id IN (${placeholders}) AND rp.allowed = 1
          LIMIT 1
        `).get(userId, permission, ...chain);
        if (channelPerm) return true;
      }
    }
    return false;
  }

  function getUserPermissions(userId) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return ['*'];
    const rows = db.prepare(`
      SELECT DISTINCT rp.permission FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.allowed = 1
    `).all(userId);
    const perms = rows.map(r => r.permission);

    try {
      const overrides = db.prepare(`
        SELECT permission, allowed FROM user_role_perms WHERE user_id = ?
      `).all(userId);
      for (const ov of overrides) {
        if (ov.allowed === 1 && !perms.includes(ov.permission)) {
          perms.push(ov.permission);
        } else if (ov.allowed === 0) {
          const idx = perms.indexOf(ov.permission);
          if (idx !== -1) perms.splice(idx, 1);
        }
      }
    } catch { /* user_role_perms table may not exist yet */ }

    const thresholds = getPermissionThresholds();
    const level = getUserEffectiveLevel(userId);
    for (const [perm, minLevel] of Object.entries(thresholds)) {
      if (level >= minLevel && !perms.includes(perm)) perms.push(perm);
    }
    return perms;
  }

  function getUserRoles(userId) {
    return db.prepare(`
      SELECT r.id, r.name, r.level, r.scope, r.color, ur.channel_id
      FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ?
      GROUP BY r.id, COALESCE(ur.channel_id, -1)
      ORDER BY r.level DESC
    `).all(userId);
  }

  function getUserHighestRole(userId, channelId = null) {
    const all = getUserAllRoles(userId, channelId);
    return all.length > 0 ? all[0] : null;
  }

  // Returns every role that applies to `userId` in `channelId`'s context:
  // server-scoped roles + channel-scoped roles for the channel and any parent
  // it inherits from. Sorted highest level first. Each entry includes
  // { id, name, level, color, icon, scope, channel_id }. Used for multi-role
  // display so the member tooltip / chat hover can list all roles a user holds.
  function getUserAllRoles(userId, channelId = null) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) {
      return [{ id: 0, name: 'Admin', level: 100, color: '#e74c3c', icon: null, scope: 'server', channel_id: null }];
    }

    // Dedupe by role.id for display purposes — if a user holds the same
    // role in multiple channels (or both server-wide and a channel), we
    // surface it once with the highest effective level. Channel scope is
    // not meaningful in chat/tooltip/profile-card surfaces; permission
    // checks use getUserEffectiveLevel/getUserPermissions, which correctly
    // walk every assignment row independently. (Without this dedupe,
    // hover cards rendered "Channel Mod Channel Mod" for users who held
    // the same role in two channels — issue raised on experimental/multi-role.)
    const byId = new Map();
    const consider = (r) => {
      const existing = byId.get(r.id);
      if (!existing || (r.level || 0) > (existing.level || 0)) byId.set(r.id, r);
    };

    const serverRows = db.prepare(`
      SELECT r.id, r.name, COALESCE(ur.custom_level, r.level) as level,
             r.color, r.icon, r.scope, ur.channel_id
      FROM roles r JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.channel_id IS NULL
    `).all(userId);
    serverRows.forEach(consider);

    if (channelId) {
      const chain = getChannelRoleChain(channelId);
      if (chain.length > 0) {
        const placeholders = chain.map(() => '?').join(',');
        const chRows = db.prepare(`
          SELECT r.id, r.name, COALESCE(ur.custom_level, r.level) as level,
                 r.color, r.icon, r.scope, ur.channel_id
          FROM roles r JOIN user_roles ur ON r.id = ur.role_id
          WHERE ur.user_id = ? AND ur.channel_id IN (${placeholders})
        `).all(userId, ...chain);
        chRows.forEach(consider);
      }
    }

    const out = Array.from(byId.values());
    out.sort((a, b) => (b.level || 0) - (a.level || 0));
    return out;
  }

  return {
    getChannelRoleChain, getUserEffectiveLevel, getPermissionThresholds,
    userHasPermission, getUserPermissions, getUserRoles,
    getUserHighestRole, getUserAllRoles
  };
};
