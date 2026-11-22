'use strict';

// Stock roles for a new server (and Reset to Default).
// Admin/host is users.is_admin, not a row in `roles`.

const MEMBER_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'send_self_destruct', 'upload_files',
  'use_voice', 'use_tts', 'view_history', 'view_channel_members',
];

const MOD_PERMS = [
  ...MEMBER_PERMS,
  'delete_message', 'delete_lower_messages', 'pin_message', 'archive_messages',
  'kick_user', 'mute_user', 'ban_user', 'ban_ip',
  'rename_channel', 'rename_sub_channel', 'set_channel_topic',
  'manage_sub_channels', 'manage_channel_settings',
  'create_channel', 'create_temp_channel',
  'invite_users', 'mention_everyone', 'view_all_members',
  'manage_webhooks', 'use_ferry', 'manage_emojis', 'manage_stickers',
  'manage_soundboard', 'manage_music_queue', 'manage_tags',
  'promote_user', 'read_only_override', 'view_audit_log', 'manage_display_names',
  'highlight_messages',
];

const CHANNEL_MOD_PERMS = [
  'kick_user', 'mute_user', 'delete_message', 'pin_message',
  'manage_sub_channels', 'rename_sub_channel', 'delete_lower_messages',
  'upload_files', 'use_voice', 'view_history', 'view_channel_members', 'manage_music_queue',
  'delete_own_messages', 'edit_own_messages', 'send_self_destruct',
];

function seedDefaultRoles(db) {
  const insertRole = db.prepare('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)');
  const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');

  const mod = insertRole.run('Mod', 50, 'server', '#3498db');
  MOD_PERMS.forEach(p => insertPerm.run(mod.lastInsertRowid, p));

  // Channel-scoped; the default channel creator role is the highest channel role.
  const channelMod = insertRole.run('Channel Mod', 25, 'channel', '#2ecc71');
  CHANNEL_MOD_PERMS.forEach(p => insertPerm.run(channelMod.lastInsertRowid, p));

  const member = insertRole.run('Member', 1, 'server', '#95a5a6');
  db.prepare('UPDATE roles SET auto_assign = 1 WHERE id = ?').run(member.lastInsertRowid);
  MEMBER_PERMS.forEach(p => insertPerm.run(member.lastInsertRowid, p));

  return { memberId: member.lastInsertRowid, modId: mod.lastInsertRowid, channelModId: channelMod.lastInsertRowid };
}

// The Admin role (#5707): a real role at the top that whoever holds admin
// wears, so they look the part. It adds no power (that comes from is_admin).
// Its id is kept in server_settings so renaming it changes nothing, and an
// admin who deletes it is never handed a new one.
function getAdminRoleId(db) {
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get();
  const id = row ? parseInt(row.value, 10) : NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare('SELECT id FROM roles WHERE id = ?').get(id) ? id : null;
}

function createAdminRole(db, { name = 'Admin', color = '#e74c3c', icon = null } = {}) {
  const { VALID_ROLE_PERMS, ADMIN_ONLY_PERMS } = require('./socketHandlers/helpers');
  const id = db.prepare("INSERT INTO roles (name, level, scope, color, icon) VALUES (?, 99, 'server', ?, ?)")
    .run(name, color, icon).lastInsertRowid;
  const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
  // Not the admin-only ones. The admin has those through is_admin, and on a
  // role they would pass to anyone, or any bot, the role was later given to.
  VALID_ROLE_PERMS.filter(p => !ADMIN_ONLY_PERMS.includes(p)).forEach(p => insertPerm.run(id, p));
  return id;
}

/**
 * One-time: Admin roles made before the rule above also hold the admin-only
 * permissions. Take them off. The admin loses nothing.
 */
function trimAdminRolePerms(db) {
  if (db.prepare("SELECT 1 FROM server_settings WHERE key = 'admin_role_perms_trimmed'").get()) return;
  const { ADMIN_ONLY_PERMS } = require('./socketHandlers/helpers');
  db.transaction(() => {
    const id = getAdminRoleId(db);
    if (id) {
      const marks = ADMIN_ONLY_PERMS.map(() => '?').join(',');
      const n = db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission IN (${marks})`).run(id, ...ADMIN_ONLY_PERMS).changes;
      if (n) console.log(`[roles] Took ${n} admin-only permission(s) off the Admin role; the admin keeps them without it`);
    }
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('admin_role_perms_trimmed', '1')").run();
  })();
}

/** Give the Admin role to someone who has just become admin. */
function grantAdminRole(db, userId) {
  const id = getAdminRoleId(db);
  if (!id || !userId) return;
  const has = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').get(userId, id);
  if (!has) {
    db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)').run(userId, id, userId);
  }
}

module.exports = { MEMBER_PERMS, MOD_PERMS, CHANNEL_MOD_PERMS, seedDefaultRoles, getAdminRoleId, createAdminRole, grantAdminRole, trimAdminRolePerms };
