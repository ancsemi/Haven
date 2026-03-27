const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('./paths');

let db;

// ── Prepared-statement cache ──────────────────────────────
// Every `db.prepare(sql)` allocates a native sqlite3_stmt.  In
// socketHandlers.js the same queries are prepared on every socket event,
// creating hundreds of native objects that only get freed when V8 GC
// collects the JS wrapper.  Under load, GC can't keep up and Oilpan
// hits a fatal "large allocation" error.
//
// This cache wraps db.prepare() so duplicate SQL strings reuse the same
// Statement object.  Node.js is single-threaded, so concurrent access is
// not a concern.  Dynamic SQL (e.g. `IN (?,?,?)`) still works — each
// unique SQL string just gets its own cache entry.
const _stmtCache = new Map();
const MAX_STMT_CACHE = 500;   // safety cap — shouldn't be hit in practice

function initDatabase() {
  db = new Database(DB_PATH);

  // ── Performance settings (memory-conscious) ────────────
  // These were originally set much higher (64 MB cache, 256 MB mmap) which
  // combined to reserve ~320 MB of native memory for SQLite alone.  On the
  // Haven Desktop machine that also runs Electron + a renderer, that left
  // too little headroom and caused the Oilpan OOM crash.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');       // safe with WAL, 2-3x faster writes
  db.pragma('cache_size = -8000');          // 8 MB page cache (was 64 MB — overkill for a chat app)
  db.pragma('busy_timeout = 5000');         // wait up to 5 s on lock contention
  db.pragma('temp_store = MEMORY');         // keep temp tables in RAM
  db.pragma('mmap_size = 33554432');        // 32 MB memory-mapped I/O (was 256 MB)

  // Hard-cap SQLite's own heap usage so it can never run away
  db.pragma('soft_heap_limit = 33554432');  // 32 MB soft limit — SQLite tries to stay under
  db.pragma('hard_heap_limit = 67108864');  // 64 MB hard ceiling

  // ── Statement cache — intercept db.prepare() ──────────
  const _origPrepare = db.prepare.bind(db);
  db.prepare = function cachedPrepare(sql) {
    let stmt = _stmtCache.get(sql);
    if (stmt) return stmt;
    // Safety cap: if cache grows too large (dynamic SQL), clear older entries
    if (_stmtCache.size >= MAX_STMT_CACHE) {
      // Remove oldest ~half of entries
      const keys = [..._stmtCache.keys()];
      for (let i = 0; i < keys.length / 2; i++) _stmtCache.delete(keys[i]);
    }
    stmt = _origPrepare(sql);
    _stmtCache.set(sql, stmt);
    return stmt;
  };

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
    CREATE INDEX IF NOT EXISTS idx_messages_channel_id
      ON messages(channel_id, id DESC);
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
  insertSetting.run('max_poll_options', '10');            // max poll answer options (2–25)
  insertSetting.run('max_sound_kb', '1024');              // max soundboard file size in KB (256–10240)
  insertSetting.run('max_emoji_kb', '256');               // max emoji file size in KB (64–1024)
  insertSetting.run('max_proxy_avatar_kb', '256');
  insertSetting.run('setup_wizard_complete', 'false');   // first-time admin setup wizard
  insertSetting.run('update_banner_admin_only', 'false'); // hide update banner from non-admins
  insertSetting.run('storage_provider', 'local');
  insertSetting.run('storage_s3_endpoint', '');
  insertSetting.run('storage_s3_region', 'auto');
  insertSetting.run('storage_s3_bucket', '');
  insertSetting.run('storage_s3_access_key', '');
  insertSetting.run('storage_s3_secret_key', '');
  insertSetting.run('storage_s3_prefix', 'haven');
  insertSetting.run('storage_s3_force_path_style', 'true');

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

  // ── Migration: temporary channel expiry ─────────────────
  try {
    db.prepare("SELECT expires_at FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN expires_at DATETIME DEFAULT NULL");
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
      auto_assign INTEGER NOT NULL DEFAULT 0,
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
      'rename_sub_channel', 'create_forum_posts', 'delete_lower_messages', 'manage_webhooks',
      'upload_files', 'use_voice', 'view_history', 'view_all_members',
      'delete_own_messages', 'edit_own_messages'
    ];
    serverModPerms.forEach(p => insertPerm.run(serverMod.lastInsertRowid, p));

    // Channel Mod — level 25 (channel-scoped)
    const channelMod = insertRole.run('Channel Mod', 25, 'channel', '#2ecc71');
    const channelModPerms = [
      'kick_user', 'mute_user', 'delete_message', 'pin_message',
      'manage_sub_channels', 'rename_sub_channel', 'create_forum_posts', 'delete_lower_messages',
      'upload_files', 'use_voice', 'view_history',
      'delete_own_messages', 'edit_own_messages'
    ];
    channelModPerms.forEach(p => insertPerm.run(channelMod.lastInsertRowid, p));

    // User — level 1 (default role for all new users, auto-assigned)
    const userRole = insertRole.run('User', 1, 'server', '#95a5a6');
    db.prepare('UPDATE roles SET auto_assign = 1 WHERE id = ?').run(userRole.lastInsertRowid);
    const userPerms = [
      'delete_own_messages', 'edit_own_messages', 'upload_files',
      'use_voice', 'view_history', 'create_forum_posts'
    ];
    userPerms.forEach(p => insertPerm.run(userRole.lastInsertRowid, p));
  }

  // ── Migration: add auto_assign column to roles if missing ──
  try {
    db.prepare('SELECT auto_assign FROM roles LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE roles ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0');
    // Mark the existing "User" role as auto-assign for backwards compat
    db.prepare("UPDATE roles SET auto_assign = 1 WHERE name = 'User' AND level = 1 AND scope = 'server'").run();
  }

  // ── Migration: auto-assign flagged roles to all existing users who lack any server role ──
  const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1 AND scope = ?').all('server');
  for (const ar of autoRoles) {
    db.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by)
      SELECT u.id, ?, NULL, NULL FROM users u
      WHERE u.id NOT IN (SELECT DISTINCT user_id FROM user_roles WHERE channel_id IS NULL)
    `).run(ar.id);
  }

  // ── Cleanup: remove duplicate user_roles (NULL channel_id duplicates) ──
  // SQLite UNIQUE constraints don't prevent duplicate NULLs, so clean up on startup
  db.exec(`
    DELETE FROM user_roles WHERE id NOT IN (
      SELECT MIN(id) FROM user_roles
      GROUP BY user_id, role_id, COALESCE(channel_id, -1)
    )
  `);

  // ── Migration: custom_level column on user_roles for per-assignment level overrides ──
  try {
    db.prepare('SELECT custom_level FROM user_roles LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE user_roles ADD COLUMN custom_level INTEGER DEFAULT NULL');
  }

  // ── Migration: per-user permission overrides table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_role_perms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      channel_id INTEGER DEFAULT NULL REFERENCES channels(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1
    )
  `);
  try {
    db.prepare('SELECT 1 FROM user_role_perms LIMIT 0').get();
  } catch { /* table just created */ }

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
    { name: 'cleanup_exempt',     sql: "ALTER TABLE channels ADD COLUMN cleanup_exempt INTEGER DEFAULT 0" },
    { name: 'channel_type',       sql: "ALTER TABLE channels ADD COLUMN channel_type TEXT DEFAULT 'standard'" },
    { name: 'voice_user_limit',   sql: "ALTER TABLE channels ADD COLUMN voice_user_limit INTEGER DEFAULT 0" },
    { name: 'media_enabled',      sql: "ALTER TABLE channels ADD COLUMN media_enabled INTEGER DEFAULT 1" },
    { name: 'notification_type',  sql: "ALTER TABLE channels ADD COLUMN notification_type TEXT DEFAULT 'default'" },
    { name: 'voice_enabled',     sql: "ALTER TABLE channels ADD COLUMN voice_enabled INTEGER DEFAULT 1" },
    { name: 'text_enabled',      sql: "ALTER TABLE channels ADD COLUMN text_enabled INTEGER DEFAULT 1" },
  ];
  for (const col of channelQolCols) {
    try { db.prepare(`SELECT ${col.name} FROM channels LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: convert legacy channel_type to individual toggles ──
  try {
    const textOnlyChannels = db.prepare("SELECT id FROM channels WHERE channel_type = 'text'").all();
    if (textOnlyChannels.length > 0) {
      const update = db.prepare("UPDATE channels SET voice_enabled = 0, channel_type = 'standard' WHERE id = ?");
      for (const ch of textOnlyChannels) update.run(ch.id);
    }
    const voiceOnlyChannels = db.prepare("SELECT id FROM channels WHERE channel_type = 'voice'").all();
    if (voiceOnlyChannels.length > 0) {
      const update = db.prepare("UPDATE channels SET text_enabled = 0, channel_type = 'standard' WHERE id = ?");
      for (const ch of voiceOnlyChannels) update.run(ch.id);
    }
  } catch { /* channel_type column may not exist yet on first run */ }

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

  // ── Migration: ensure default User role can create forum posts ──
  try {
    const userRole = db.prepare("SELECT id FROM roles WHERE name = 'User' AND level = 1 AND scope = 'server'").get();
    if (userRole) {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, 'create_forum_posts', 1)").run(userRole.id);
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

  // ── Migration: archived / protected messages ────────────
  try {
    db.prepare("SELECT is_archived FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN is_archived INTEGER DEFAULT 0");
  }

  // ── Migration: password_version for session invalidation ──
  try {
    db.prepare("SELECT password_version FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN password_version INTEGER DEFAULT 1");
  }

  // ── Migration: role-based channel access ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_channel_access (
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      grant_on_promote  INTEGER NOT NULL DEFAULT 0,
      revoke_on_demote  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (role_id, channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rca_role ON role_channel_access(role_id);
    CREATE INDEX IF NOT EXISTS idx_rca_channel ON role_channel_access(channel_id);
  `);

  // ── Migration: link_channel_access flag on roles ────────
  try {
    db.prepare("SELECT link_channel_access FROM roles LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE roles ADD COLUMN link_channel_access INTEGER NOT NULL DEFAULT 0");
  }

  // ── Migration: TOTP 2FA columns on users ────────────────
  try {
    db.prepare("SELECT totp_secret FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT totp_enabled FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0");
  }

  // ── Migration: TOTP backup codes table ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS totp_backup_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes(user_id);
  `);

  // ── Migration: account recovery codes ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON account_recovery_codes(user_id);
  `);

  // ── Migration: polls support ─────────────────────────
  try {
    db.exec("ALTER TABLE messages ADD COLUMN poll_data TEXT DEFAULT NULL");
  } catch (e) { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id, option_index)
    );
    CREATE INDEX IF NOT EXISTS idx_poll_votes_msg ON poll_votes(message_id);
  `);

  // ── Migration: deleted_users log (audit trail for admin deletions) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      display_name TEXT DEFAULT NULL,
      reason TEXT DEFAULT '',
      deleted_by INTEGER REFERENCES users(id),
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: per-channel voice bitrate cap ────────────
  try {
    db.prepare("SELECT voice_bitrate FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN voice_bitrate INTEGER DEFAULT 0");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT NULL,
      trigger_prefix TEXT NOT NULL,
      trigger_suffix TEXT DEFAULT '',
      group_name TEXT DEFAULT '',
      is_public INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_proxies_user ON proxies(user_id);
    CREATE INDEX IF NOT EXISTS idx_proxies_user_trigger ON proxies(user_id, trigger_prefix);
  `);

  try {
    db.prepare("SELECT proxy_id FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN proxy_id INTEGER DEFAULT NULL REFERENCES proxies(id) ON DELETE SET NULL");
  }
  try {
    db.prepare("SELECT proxy_name FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN proxy_name TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT proxy_avatar FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN proxy_avatar TEXT DEFAULT NULL");
  }

  return db;
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb };
