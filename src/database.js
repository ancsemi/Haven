const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('./paths');

let db;

function initDatabase() {
  db = new Database(DB_PATH);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
      'set_channel_topic', 'manage_sub_channels'
    ];
    serverModPerms.forEach(p => insertPerm.run(serverMod.lastInsertRowid, p));

    // Channel Mod — level 25 (channel-scoped)
    const channelMod = insertRole.run('Channel Mod', 25, 'channel', '#2ecc71');
    const channelModPerms = [
      'kick_user', 'mute_user', 'delete_message', 'pin_message',
      'manage_sub_channels'
    ];
    channelModPerms.forEach(p => insertPerm.run(channelMod.lastInsertRowid, p));
  }

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

  return db;
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb };
