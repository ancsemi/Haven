'use strict';

// Async readers for the converted channel list. Legacy write handlers keep
// permissions.js synchronous so their checks and writes do not gain a yield.
const { parseRoleGate } = require('../roleGate');

// A failed read of the per-user overrides (user_role_perms) means an explicit
// deny cannot be ruled out, so callers fail closed. The read runs on every
// permission check, so the log line is limited to once a minute.
let _overrideReadWarnedAt = 0;
function warnOverrideRead(where, err) {
  const now = Date.now();
  if (now - _overrideReadWarnedAt < 60 * 1000) return;
  _overrideReadWarnedAt = now;
  console.error(`[permissions] ${where}: override read failed, denying:`, err && err.message);
}

module.exports = function createAsyncPermissions(db) {
  // ── Role inheritance: get the channel hierarchy chain for role cascading ──
  // Server roles → apply everywhere (channel_id IS NULL)
  // Channel role  → applies to that channel + all its sub-channels
  // Sub-channel role → only that sub-channel
  // This returns an array of channel IDs to check (the target + its parent if it's a sub)
  async function getChannelRoleChain(channelId) {
    if (!channelId) return [];
    const ch = await db.prepare('SELECT id, parent_channel_id FROM channels WHERE id = ?').get(channelId);
    if (!ch) return [channelId];
    if (ch.parent_channel_id) return [channelId, ch.parent_channel_id];
    return [channelId];
  }

  async function getUserEffectiveLevel(userId, channelId = null) {
    const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return 100;

    const serverRole = await db.prepare(`
      SELECT MAX(COALESCE(ur.custom_level, r.level)) as "maxLevel" FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.scope = 'server' AND ur.channel_id IS NULL
    `).get(userId);
    let level = (serverRole && serverRole.maxLevel) || 0;

    if (channelId) {
      const chain = await getChannelRoleChain(channelId);
      if (chain.length > 0) {
        const placeholders = chain.map(() => '?').join(',');
        const channelRole = await db.prepare(`
          SELECT MAX(COALESCE(ur.custom_level, r.level)) as "maxLevel" FROM roles r
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

  async function userHasPermission(userId, permission, channelId = null) {
    const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return true;

    // Check per-user permission overrides first (explicit deny takes priority).
    // (#5433) Overrides written by a channel-scoped role assignment carry that
    // assignment's channel_id and must only apply within that channel (and its
    // sub-channels, via the role chain). Rows with channel_id NULL come from
    // server-wide assignments and apply everywhere. Previously this query had
    // no channel filter, so ticking e.g. "create channel" on a channel
    // assignment leaked the permission server-wide.
    try {
      const chain = channelId ? await getChannelRoleChain(channelId) : [];
      const scopeClause = chain.length > 0
        ? `(channel_id IS NULL OR channel_id IN (${chain.map(() => '?').join(',')}))`
        : 'channel_id IS NULL';
      const override = await db.prepare(`
        SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = ? AND ${scopeClause}
        ORDER BY allowed ASC LIMIT 1
      `).get(userId, permission, ...chain);
      if (override) {
        if (override.allowed === 0) return false;
        if (override.allowed === 1) return true;
      }
    } catch (err) {
      // Fail closed: carrying on to the role checks would ignore a deny.
      warnOverrideRead('userHasPermission', err);
      return false;
    }

    // Check server-scoped roles
    const serverPerm = await db.prepare(`
      SELECT rp.allowed FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = ? AND r.scope = 'server' AND ur.channel_id IS NULL AND rp.allowed = 1
      LIMIT 1
    `).get(userId, permission);
    if (serverPerm) return true;

    // Check channel-scoped roles (with inheritance: parent channel roles cascade to subs)
    if (channelId) {
      const chain = await getChannelRoleChain(channelId);
      if (chain.length > 0) {
        const placeholders = chain.map(() => '?').join(',');
        const channelPerm = await db.prepare(`
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

  async function getUserPermissions(userId) {
    const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return ['*'];
    const rows = await db.prepare(`
      SELECT DISTINCT rp.permission FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.allowed = 1
    `).all(userId);
    const perms = rows.map(r => r.permission);

    try {
      const overrides = await db.prepare(`
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
    } catch (err) {
      // Fail closed: role perms without their deny overrides could over-grant,
      // and callers use this list to decide what someone may hand out.
      warnOverrideRead('permission list', err);
      return [];
    }

    return perms;
  }

  // (#5433 follow-up) Global-only variant of getUserPermissions, for gating
  // UI that performs a server-wide action regardless of which channel is
  // active (e.g. the sidebar "Create Channel" section, which always creates
  // a top-level channel). getUserPermissions() flattens server-wide AND
  // channel-scoped grants together for per-channel UI (context menus opened
  // for a specific channel), which is correct there, but that same flat
  // list also made the always-visible sidebar button appear for users who
  // only held create_channel in one sub-channel, a dead control since every
  // click would be denied server-side. This variant excludes any
  // channel-scoped role assignment or override (channel_id IS NULL only).
  async function getUserGlobalPermissions(userId) {
    const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return ['*'];
    const rows = await db.prepare(`
      SELECT DISTINCT rp.permission FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.allowed = 1 AND ur.channel_id IS NULL
    `).all(userId);
    const perms = rows.map(r => r.permission);

    try {
      const overrides = await db.prepare(`
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
    } catch (err) {
      // Fail closed: role perms without their deny overrides could over-grant,
      // and callers use this list to decide what someone may hand out.
      warnOverrideRead('permission list', err);
      return [];
    }

    return perms;
  }

  async function getUserRoles(userId) {
    return await db.prepare(`
      SELECT DISTINCT r.id, r.name, r.level, r.scope, r.color, r.color2, r.color_shimmer, ur.channel_id
      FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.level DESC
    `).all(userId);
  }

  async function getUserUploadMb(userId) {
    const base = parseInt((await db.prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get())?.value, 10) || 25;
    const row = await db.prepare(`
      SELECT MAX(r.max_upload_mb) AS cap FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ? AND ur.channel_id IS NULL AND r.max_upload_mb IS NOT NULL
    `).get(userId);
    const cap = row && row.cap ? parseInt(row.cap, 10) : 0;
    return Math.max(base, cap || 0);
  }

  async function roleGateAllows(userId, channel) {
    const gate = parseRoleGate(channel && channel.role_gate);
    if (!gate) return true;
    const rows = await db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? AND (channel_id IS NULL OR channel_id = ?)')
      .all(userId, channel.id || 0);
    const held = new Set(rows.map(r => r.role_id));
    return gate.mode === 'all' ? gate.roles.every(r => held.has(r)) : gate.roles.some(r => held.has(r));
  }

  return { userHasPermission, roleGateAllows, getChannelRoleChain, getUserEffectiveLevel, getUserPermissions,
    getUserGlobalPermissions, getUserRoles, getUserUploadMb };
};
