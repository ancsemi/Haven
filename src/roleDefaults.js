'use strict';

// Stock roles for a new server (and Reset to Default).
// Admin/host is users.is_admin, not a row in `roles`.

const MEMBER_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'upload_files',
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
  'manage_soundboard', 'manage_music_queue',
  'promote_user', 'read_only_override', 'view_audit_log', 'manage_display_names',
];

function seedDefaultRoles(db) {
  const insertRole = db.prepare('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)');
  const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');

  const mod = insertRole.run('Mod', 50, 'server', '#3498db');
  MOD_PERMS.forEach(p => insertPerm.run(mod.lastInsertRowid, p));

  const member = insertRole.run('Member', 1, 'server', '#95a5a6');
  db.prepare('UPDATE roles SET auto_assign = 1 WHERE id = ?').run(member.lastInsertRowid);
  MEMBER_PERMS.forEach(p => insertPerm.run(member.lastInsertRowid, p));

  return { memberId: member.lastInsertRowid, modId: mod.lastInsertRowid };
}

module.exports = { MEMBER_PERMS, MOD_PERMS, seedDefaultRoles };
