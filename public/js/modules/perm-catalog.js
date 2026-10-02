// Every role permission, the ones only the server owner may grant, and their
// labels. Shared by the role editor, channel roles and the Role Assignment
// center.

//Shared permission list instead of declaring the same multiple times
export const ALL_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
  // ban_ip was accepted by the server but missing from this list, so the role
  // editor never rendered a checkbox for it. That made it ungrantable: the
  // "also ban IP" option on the ban dialog could only ever appear for admins,
  // no matter what a moderator's role said. (v3.43.0)
  'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user', 'ban_ip',
  'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
  // (#5467) Editing an existing channel's settings is its own grant, separate
  // from creating channels. Assign it channel-scoped to keep a moderator's
  // reach inside the channels they actually run.
  'manage_channel_settings',
  // (#5470) Hand out invite links without handing over the server. Holders
  // see and manage only the links they made.
  'create_channel', 'create_temp_channel', 'invite_users',
  'upload_files', 'use_voice', 'use_tts', 'manage_webhooks', 'use_ferry', 'mention_everyone', 'view_history',
  'view_all_members', 'view_all_channels', 'view_channel_members', 'manage_emojis', 'manage_stickers', 'manage_soundboard', 'manage_music_queue', 'manage_tags', 'promote_user',
  'manage_roles', 'manage_server', 'delete_channel', 'read_only_override', 'view_audit_log', 'manage_display_names'
];
// Permissions only the server owner (admin) may grant. Highlighted in the
// role editors and locked for non-admins; mirrors adminOnlyPerms in
// socketHandlers/roles.js.
export const ADMIN_ONLY_PERMS = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];
//Similarly flavored solution to perm labels
export const PERM_LABELS = {
  get edit_own_messages() { return t('permissions.edit_own_messages'); },
  get delete_own_messages() { return t('permissions.delete_own_messages'); },
  get delete_message() { return t('permissions.delete_message'); },
  get delete_lower_messages() { return t('permissions.delete_lower_messages'); },
  get pin_message() { return t('permissions.pin_message'); },
  get archive_messages() { return t('permissions.archive_messages'); },
  get kick_user() { return t('permissions.kick_user'); },
  get mute_user() { return t('permissions.mute_user'); },
  get ban_user() { return t('permissions.ban_user'); },
  get ban_ip() { return t('permissions.ban_ip'); },
  get rename_channel() { return t('permissions.rename_channel'); },
  get rename_sub_channel() { return t('permissions.rename_sub_channel'); },
  get set_channel_topic() { return t('permissions.set_channel_topic'); },
  get manage_sub_channels() { return t('permissions.manage_sub_channels'); },
  get manage_channel_settings() { return t('permissions.manage_channel_settings'); },
  get create_channel() { return t('permissions.create_channel'); },
  get create_temp_channel() { return t('permissions.create_temp_channel'); },
  get invite_users() { return t('permissions.invite_users'); },
  get upload_files() { return t('permissions.upload_files'); },
  get use_voice() { return t('permissions.use_voice'); },
  get use_tts() { return t('permissions.use_tts'); },
  get manage_webhooks() { return t('permissions.manage_webhooks'); },
  get use_ferry() { return t('permissions.use_ferry'); },
  get mention_everyone() { return t('permissions.mention_everyone'); },
  get view_history() { return t('permissions.view_history'); },
  get view_all_members() { return t('permissions.view_all_members'); },
  get view_all_channels() { return t('permissions.view_all_channels'); },
  get view_channel_members() { return t('permissions.view_channel_members'); },
  get manage_emojis() { return t('permissions.manage_emojis'); },
  get manage_stickers() { return t('permissions.manage_stickers'); },
  get manage_soundboard() { return t('permissions.manage_soundboard'); },
  get manage_music_queue() { return t('permissions.manage_music_queue'); },
  get manage_tags() { return t('permissions.manage_tags'); },
  get promote_user() { return t('permissions.promote_user'); },
  get manage_roles() { return t('permissions.manage_roles'); },
  get manage_server() { return t('permissions.manage_server'); },
  get delete_channel() { return t('permissions.delete_channel'); },
  get read_only_override() { return t('permissions.read_only_override'); },
  get view_audit_log() { return t('permissions.view_audit_log'); },
  get manage_display_names() { return t('permissions.manage_display_names'); }
};
