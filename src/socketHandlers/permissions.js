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

    // Check per-user permission overrides first (explicit deny takes priority).
    // (#5433) Overrides written by a channel-scoped role assignment carry that
    // assignment's channel_id and must only apply within that channel (and its
    // sub-channels, via the role chain). Rows with channel_id NULL come from
    // server-wide assignments and apply everywhere. Previously this query had
    // no channel filter, so ticking e.g. "create channel" on a channel
    // assignment leaked the permission server-wide.
    try {
      const chain = channelId ? getChannelRoleChain(channelId) : [];
      const scopeClause = chain.length > 0
        ? `(channel_id IS NULL OR channel_id IN (${chain.map(() => '?').join(',')}))`
        : 'channel_id IS NULL';
      const override = db.prepare(`
        SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = ? AND ${scopeClause}
        ORDER BY allowed ASC LIMIT 1
      `).get(userId, permission, ...chain);
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

  // (#5433 follow-up) Global-only variant of getUserPermissions, for gating
  // UI that performs a server-wide action regardless of which channel is
  // active (e.g. the sidebar "Create Channel" section, which always creates
  // a top-level channel). getUserPermissions() flattens server-wide AND
  // channel-scoped grants together for per-channel UI (context menus opened
  // for a specific channel), which is correct there — but that same flat
  // list also made the always-visible sidebar button appear for users who
  // only held create_channel in one sub-channel, a dead control since every
  // click would be denied server-side. This variant excludes any
  // channel-scoped role assignment or override (channel_id IS NULL only).
  function getUserGlobalPermissions(userId) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return ['*'];
    const rows = db.prepare(`
      SELECT DISTINCT rp.permission FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.allowed = 1 AND ur.channel_id IS NULL
    `).all(userId);
    const perms = rows.map(r => r.permission);

    try {
      const overrides = db.prepare(`
        SELECT permission, allowed FROM user_role_perms WHERE user_id = ? AND channel_id IS NULL
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

    // getUserEffectiveLevel(userId) with no channelId arg already only
    // considers server-scoped roles, so threshold-derived perms are
    // inherently global here — no extra filtering needed.
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

  // Cosmetic display for the synthetic admin role, backed by the
  // 'admin_role_display' server setting (falls back to sensible defaults).
  // This is purely cosmetic: is_admin, the effective level (100) and the
  // permission set (['*']) are computed independently and never look at this.
  function getAdminRoleDisplay() {
    const defaults = { name: 'Admin', color: '#e74c3c', icon: null, visible: true };
    try {
      const row = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_display'").get();
      if (!row) return defaults;
      const p = JSON.parse(row.value);
      return {
        name: (typeof p.name === 'string' && p.name.trim()) ? p.name : defaults.name,
        color: (typeof p.color === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(p.color)) ? p.color : defaults.color,
        icon: (typeof p.icon === 'string' && p.icon) ? p.icon : null,
        visible: p.visible !== false
      };
    } catch { return defaults; }
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
      const d = getAdminRoleDisplay();
      // Visibility off hides the admin badge/colour everywhere, for everyone.
      if (!d.visible) return [];
      return [{ id: 0, name: d.name, level: 100, color: d.color, icon: d.icon, scope: 'server', channel_id: null }];
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
    userHasPermission, getUserPermissions, getUserGlobalPermissions, getUserRoles,
    getUserHighestRole, getUserAllRoles, getAdminRoleDisplay
  };
};
