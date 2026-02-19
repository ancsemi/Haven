const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('./paths');

let db;

function initDatabase() {
  db = new Database(DB_PATH);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');       // safe with WAL, 2-3x faster writes
  db.pragma('cache_size = -64000');         // 64 MB page cache (default ~2 MB)
  db.pragma('busy_timeout = 5000');         // wait up to 5 s on lock contention
  db.pragma('temp_store = MEMORY');         // keep temp tables in RAM

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      muted_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT DEFAULT '',
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS eula_acceptances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      ip_address TEXT,
      accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_code
      ON channels(code);
    CREATE INDEX IF NOT EXISTS idx_reactions_message
      ON reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_bans_user
      ON bans(user_id);
    CREATE INDEX IF NOT EXISTS idx_mutes_user
      ON mutes(user_id, expires_at);
  `);

  // ── Safe schema migration for existing databases ──────
  try {
    db.prepare("SELECT reply_to FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL");
  }

  // Create reactions table if it doesn't exist (already handled by CREATE IF NOT EXISTS above)
  // but index may be missing on older DBs
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)");
  } catch { /* already exists */ }

  // ── Migration: edited_at column on messages ───────────
  try {
    db.prepare("SELECT edited_at FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN edited_at DATETIME DEFAULT NULL");
  }

  // ── Migration: high_scores table ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS high_scores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, game)
    );
  `);

  // ── Migration: whitelist table ─────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      added_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: seed default server settings ───────────
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO server_settings (key, value) VALUES (?, ?)'
  );
  insertSetting.run('member_visibility', 'online');  // 'all', 'online', 'none'
  insertSetting.run('cleanup_enabled', 'false');       // auto-cleanup toggle
  insertSetting.run('cleanup_max_age_days', '0');      // delete messages older than N days (0 = disabled)
  insertSetting.run('cleanup_max_size_mb', '0');       // delete oldest messages when DB exceeds N MB (0 = disabled)
  insertSetting.run('whitelist_enabled', 'false');     // whitelist toggle
  insertSetting.run('server_name', 'HAVEN');           // displayed in sidebar header + server bar
  insertSetting.run('server_icon', '');                // path to uploaded server icon image
  insertSetting.run('permission_thresholds', '{"create_channel":50}');    // JSON: { permission: minLevel } — auto-grant perms at level
  insertSetting.run('server_code', '');                // server-wide invite code (joins all channels)
  insertSetting.run('max_upload_mb', '25');             // max file upload size in MB
  insertSetting.run('setup_wizard_complete', 'false');   // first-time admin setup wizard

  // ── Migration: pinned_messages table ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      pinned_by INTEGER NOT NULL REFERENCES users(id),
      pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_channel ON pinned_messages(channel_id);
  `);

  // ── Migration: user status columns ──────────────────────
  try {
    db.prepare("SELECT status FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'online'");
  }
  try {
    db.prepare("SELECT status_text FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT ''");
  }

  // ── Migration: display_name column ────────────────────────
  try {
    db.prepare("SELECT display_name FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT NULL");
  }

  // ── Migration: avatar column ──────────────────────────────
  try {
    db.prepare("SELECT avatar FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL");
  }

  // ── Migration: avatar_shape column ────────────────────────
  try {
    db.prepare("SELECT avatar_shape FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN avatar_shape TEXT DEFAULT 'circle'");
  }

  // ── Migration: bio column ─────────────────────────────────
  try {
    db.prepare("SELECT bio FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
  }

  // ── Migration: custom_sounds table (admin-uploaded notification sounds) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: custom_emojis table (admin-uploaded server emojis) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_emojis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: channel topic column ─────────────────────
  try {
    db.prepare("SELECT topic FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN topic TEXT DEFAULT ''");
  }

  // ── Migration: DM flag on channels ──────────────────────
  try {
    db.prepare("SELECT is_dm FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN is_dm INTEGER DEFAULT 0");
  }

  // ── Migration: age_verified on eula_acceptances ─────────
  try {
    db.prepare("SELECT age_verified FROM eula_acceptances LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE eula_acceptances ADD COLUMN age_verified INTEGER DEFAULT 0");
  }

  // ── Migration: read positions table ─────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS read_positions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, channel_id)
    );
  `);

  // ── Migration: original_name on messages for file uploads ──
  try {
    db.prepare("SELECT original_name FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN original_name TEXT DEFAULT NULL");
  }

  // ── Migration: channel code settings columns ─────────────
  const codeSettingsCols = [
    { name: 'code_visibility',        sql: "ALTER TABLE channels ADD COLUMN code_visibility TEXT DEFAULT 'public'" },
    { name: 'code_mode',              sql: "ALTER TABLE channels ADD COLUMN code_mode TEXT DEFAULT 'static'" },
    { name: 'code_rotation_type',     sql: "ALTER TABLE channels ADD COLUMN code_rotation_type TEXT DEFAULT 'time'" },
    { name: 'code_rotation_interval', sql: "ALTER TABLE channels ADD COLUMN code_rotation_interval INTEGER DEFAULT 60" },
    { name: 'code_rotation_counter',  sql: "ALTER TABLE channels ADD COLUMN code_rotation_counter INTEGER DEFAULT 0" },
    { name: 'code_last_rotated',      sql: "ALTER TABLE channels ADD COLUMN code_last_rotated DATETIME DEFAULT NULL" },
  ];
  for (const col of codeSettingsCols) {
    try { db.prepare(`SELECT ${col.name} FROM channels LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: sub-channels (parent_channel_id, position) ──
  try {
    db.prepare("SELECT parent_channel_id FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN parent_channel_id INTEGER DEFAULT NULL REFERENCES channels(id) ON DELETE SET NULL");
  }
  try {
    db.prepare("SELECT position FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN position INTEGER DEFAULT 0");
  }

  // ── Migration: private sub-channels ──────────────────────
  try {
    db.prepare("SELECT is_private FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN is_private INTEGER DEFAULT 0");
  }

  // ── Migration: webhook message tracking ─────────────────
  try {
    db.prepare("SELECT is_webhook FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN is_webhook INTEGER DEFAULT 0");
  }
  try {
    db.prepare("SELECT webhook_username FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN webhook_username TEXT DEFAULT NULL");
  }

  // ── Migration: roles system ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'server',
      color TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      channel_id INTEGER DEFAULT NULL REFERENCES channels(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id),
      granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, role_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (role_id, permission)
    );

    CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_roles_channel ON user_roles(channel_id);
  `);

  // Seed default roles if none exist
  const roleCount = db.prepare('SELECT COUNT(*) as cnt FROM roles').get();
  if (roleCount.cnt === 0) {
    const insertRole = db.prepare('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)');
    const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');

    // Server Mod — level 50 (below admin which is implied level 100)
    const serverMod = insertRole.run('Server Mod', 50, 'server', '#3498db');
    const serverModPerms = [
      'kick_user', 'mute_user', 'delete_message', 'pin_message',
      'set_channel_topic', 'manage_sub_channels', 'rename_channel',
      'rename_sub_channel', 'delete_lower_messages', 'manage_webhooks',
      'upload_files', 'use_voice', 'view_history',
      'delete_own_messages', 'edit_own_messages'
    ];
    serverModPerms.forEach(p => insertPerm.run(serverMod.lastInsertRowid, p));

    // Channel Mod — level 25 (channel-scoped)
    const channelMod = insertRole.run('Channel Mod', 25, 'channel', '#2ecc71');
    const channelModPerms = [
      'kick_user', 'mute_user', 'delete_message', 'pin_message',
      'manage_sub_channels', 'rename_sub_channel', 'delete_lower_messages',
      'upload_files', 'use_voice', 'view_history',
      'delete_own_messages', 'edit_own_messages'
    ];
    channelModPerms.forEach(p => insertPerm.run(channelMod.lastInsertRowid, p));

    // User — level 1 (default role for all new users)
    const userRole = insertRole.run('User', 1, 'server', '#95a5a6');
    const userPerms = [
      'delete_own_messages', 'edit_own_messages', 'upload_files',
      'use_voice', 'view_history'
    ];
    userPerms.forEach(p => insertPerm.run(userRole.lastInsertRowid, p));
  }

  // ── Migration: auto-assign "User" role to all existing users who lack any role ──
  const userRole = db.prepare("SELECT id FROM roles WHERE name = 'User' AND level = 1 AND scope = 'server'").get();
  if (userRole) {
    db.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by)
      SELECT u.id, ?, NULL, NULL FROM users u
      WHERE u.id NOT IN (SELECT DISTINCT user_id FROM user_roles WHERE channel_id IS NULL)
    `).run(userRole.id);
  }

  // ── Cleanup: remove duplicate user_roles (NULL channel_id duplicates) ──
  // SQLite UNIQUE constraints don't prevent duplicate NULLs, so clean up on startup
  db.exec(`
    DELETE FROM user_roles WHERE id NOT IN (
      SELECT MIN(id) FROM user_roles
      GROUP BY user_id, role_id, COALESCE(channel_id, -1)
    )
  `);

  // ── Migration: push notification subscriptions ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
  `);

  // ── Migration: webhooks / bot integrations ───────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Bot',
      token TEXT UNIQUE NOT NULL,
      avatar_url TEXT DEFAULT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks(token);
    CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
  `);

  // ── Migration: mobile FCM push tokens ───────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, token)
    );
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id);
  `);

  // ── Migration: channel feature toggles & QoL ────────────
  const channelQolCols = [
    { name: 'streams_enabled',    sql: "ALTER TABLE channels ADD COLUMN streams_enabled INTEGER DEFAULT 1" },
    { name: 'music_enabled',      sql: "ALTER TABLE channels ADD COLUMN music_enabled INTEGER DEFAULT 1" },
    { name: 'slow_mode_interval', sql: "ALTER TABLE channels ADD COLUMN slow_mode_interval INTEGER DEFAULT 0" },
    { name: 'category',           sql: "ALTER TABLE channels ADD COLUMN category TEXT DEFAULT NULL" },
    { name: 'sort_alphabetical',  sql: "ALTER TABLE channels ADD COLUMN sort_alphabetical INTEGER DEFAULT 0" },
  ];
  for (const col of channelQolCols) {
    try { db.prepare(`SELECT ${col.name} FROM channels LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: E2E public key on users ──────────────────
  try {
    db.prepare("SELECT public_key FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT NULL");
  }

  // ── Migration: E2E encrypted private key (per-account sync) ──
  try {
    db.prepare("SELECT encrypted_private_key FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN encrypted_private_key TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT e2e_key_salt FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN e2e_key_salt TEXT DEFAULT NULL");
  }

  // ── Migration: E2E account secret (device-independent key wrapping) ──
  try {
    db.prepare("SELECT e2e_secret FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN e2e_secret TEXT DEFAULT NULL");
  }

  // ── Migration: ensure create_channel default threshold ──
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get();
    if (row) {
      const thresholds = JSON.parse(row.value);
      if (!thresholds.create_channel) {
        thresholds.create_channel = 50;
        db.prepare("UPDATE server_settings SET value = ? WHERE key = 'permission_thresholds'").run(JSON.stringify(thresholds));
      }
    }
  } catch { /* ignore */ }

  // ── Migration: imported_from column on messages (Discord import) ──
  try {
    db.prepare("SELECT imported_from FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN imported_from TEXT DEFAULT NULL");
  }

  // ── Migration: webhook_avatar column on messages (Discord import avatars) ──
  try {
    db.prepare("SELECT webhook_avatar FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN webhook_avatar TEXT DEFAULT NULL");
  }

  return db;
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb };
