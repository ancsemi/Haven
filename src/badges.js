'use strict';

/**
 * Profile badges (#5632): small icons on a member's profile card that show
 * real history on the server. Nothing here is ever bought; a badge is earned,
 * comes with a role, or is given by hand.
 *
 * Tables:
 *   badges        one row per badge the admin made. kind is one of
 *                 account_age (threshold in days), messages and forum_likes
 *                 (threshold is a count), role (role_id), manual. icon_key
 *                 says which icon it shows (see iconKey); no two badges
 *                 share one.
 *   user_badges   hand-given badges: who has them, who gave them and when.
 *   badge_hidden  badges a member chose to hide on their own card.
 *   badge_stats   running totals per member (messages posted in server
 *                 channels, forum likes received from others), kept by
 *                 triggers so a profile reads one row instead of counting
 *                 the messages table.
 *
 * Counting rules, all in the triggers below:
 *   - A message counts when it is a member's own post in a server channel:
 *     not a DM, not a webhook or bot post, not a system notice.
 *   - Deleting a message takes it off the count. Deleting a whole channel
 *     does not: by the time the trigger runs the channel row is gone, so it
 *     cannot tell a server channel from a DM, and it leaves the count alone.
 *   - A forum like counts for the topic's author, never their own like.
 *     Taking the like back takes it off.
 */

const path = require('path');
const crypto = require('crypto');

const KINDS = ['account_age', 'messages', 'forum_likes', 'role', 'manual'];
const EARNED_KINDS = new Set(['account_age', 'messages', 'forum_likes']);
const BUILTIN_ICONS = ['sprout', 'clock', 'calendar', 'chat', 'heart', 'star', 'shield', 'trophy'];
const NAME_MAX = 32;
const DESCRIPTION_MAX = 120;
const MAX_BADGES = 100;
const THRESHOLD_MAX = { account_age: 36500, messages: 10000000, forum_likes: 1000000 };
// Uploaded icons live in uploads/badges/ under a name the upload route picks.
const ICON_PATH_RE = /^\/uploads\/badges\/\d{10,16}-[a-f0-9]{16}\.(?:png|gif|webp|jpg)$/;
// One emoji (a flag, a keycap, a ZWJ sequence), nothing else.
const EMOJI_RE = /^(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}⃣])[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{Emoji_Component}️‍⃣]{1,16}$/u;

// Shown off until the admin turns them on, so a server that does not want
// badges never sees one. Seeded once, when the tables are first made, so
// deleting them keeps them gone.
const DEFAULT_BADGES = [
  { name: 'One month', description: 'Has been a member for a month', icon: 'sprout', kind: 'account_age', threshold: 30 },
  { name: 'Six months', description: 'Has been a member for six months', icon: 'clock', kind: 'account_age', threshold: 180 },
  { name: 'One year', description: 'Has been a member for a year', icon: 'calendar', kind: 'account_age', threshold: 365 },
  { name: 'Chatty', description: 'Posted 100 messages', icon: 'chat', kind: 'messages', threshold: 100 },
  { name: 'Regular', description: 'Posted 1,000 messages', icon: 'star', kind: 'messages', threshold: 1000 },
];

const COUNTED = (row) => `${row}.user_id IS NOT NULL AND COALESCE(${row}.is_webhook, 0) = 0 AND COALESCE(${row}.type, 'user') = 'user'`;

function migrateBadges(db) {
  const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'badges'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS badges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      icon_type   TEXT    NOT NULL CHECK (icon_type IN ('emoji', 'image', 'builtin')),
      icon        TEXT    NOT NULL,
      icon_key    TEXT    DEFAULT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('account_age', 'messages', 'forum_likes', 'role', 'manual')),
      threshold   INTEGER DEFAULT NULL,
      role_id     INTEGER DEFAULT NULL REFERENCES roles(id) ON DELETE SET NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      position    INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_badges (
      badge_id   INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
      granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (badge_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
    CREATE TABLE IF NOT EXISTS badge_hidden (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, badge_id)
    );
    CREATE TABLE IF NOT EXISTS badge_stats (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      messages    INTEGER NOT NULL DEFAULT 0,
      forum_likes INTEGER NOT NULL DEFAULT 0
    );

    CREATE TRIGGER IF NOT EXISTS badge_stats_msg_ai AFTER INSERT ON messages
    WHEN ${COUNTED('NEW')}
    BEGIN
      INSERT INTO badge_stats (user_id, messages)
        SELECT NEW.user_id, 1 WHERE EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND is_dm = 0)
        ON CONFLICT(user_id) DO UPDATE SET messages = messages + 1;
    END;

    CREATE TRIGGER IF NOT EXISTS badge_stats_msg_ad AFTER DELETE ON messages
    WHEN ${COUNTED('OLD')}
    BEGIN
      UPDATE badge_stats SET messages = MAX(messages - 1, 0)
        WHERE user_id = OLD.user_id AND EXISTS (SELECT 1 FROM channels WHERE id = OLD.channel_id AND is_dm = 0);
    END;

    CREATE TRIGGER IF NOT EXISTS badge_stats_like_ai AFTER INSERT ON forum_votes
    WHEN NEW.value = 1
    BEGIN
      INSERT INTO badge_stats (user_id, forum_likes)
        SELECT m.user_id, 1 FROM messages m WHERE m.id = NEW.message_id AND m.user_id IS NOT NULL AND m.user_id <> NEW.user_id
        ON CONFLICT(user_id) DO UPDATE SET forum_likes = forum_likes + 1;
    END;

    CREATE TRIGGER IF NOT EXISTS badge_stats_like_ad AFTER DELETE ON forum_votes
    WHEN OLD.value = 1
    BEGIN
      UPDATE badge_stats SET forum_likes = MAX(forum_likes - 1, 0)
        WHERE user_id = (SELECT m.user_id FROM messages m WHERE m.id = OLD.message_id AND m.user_id <> OLD.user_id);
    END;

    CREATE TRIGGER IF NOT EXISTS badge_stats_like_au AFTER UPDATE OF value ON forum_votes
    WHEN (OLD.value = 1) <> (NEW.value = 1)
    BEGIN
      INSERT INTO badge_stats (user_id, forum_likes)
        SELECT m.user_id, CASE WHEN NEW.value = 1 THEN 1 ELSE 0 END FROM messages m
        WHERE m.id = NEW.message_id AND m.user_id IS NOT NULL AND m.user_id <> NEW.user_id
        ON CONFLICT(user_id) DO UPDATE SET forum_likes = MAX(forum_likes + CASE WHEN NEW.value = 1 THEN 1 ELSE -1 END, 0);
    END;
  `);
  if (!fresh) {
    // Made before icon_key existed: add it. Built-in and emoji keys are
    // worked out here; uploaded ones need the file (fillImageKeys).
    if (!db.prepare('PRAGMA table_info(badges)').all().some(c => c.name === 'icon_key')) {
      db.exec('ALTER TABLE badges ADD COLUMN icon_key TEXT DEFAULT NULL');
    }
    const set = db.prepare('UPDATE badges SET icon_key = ? WHERE id = ?');
    for (const b of db.prepare("SELECT id, icon_type, icon FROM badges WHERE icon_key IS NULL AND icon_type <> 'image'").all()) {
      set.run(iconKey(b.icon_type, b.icon), b.id);
    }
    return;
  }

  // First run: count what is already there once, then the triggers keep it.
  db.transaction(() => {
    db.prepare(`INSERT INTO badge_stats (user_id, messages)
      SELECT m.user_id, COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE c.is_dm = 0 AND ${COUNTED('m')} AND m.user_id IN (SELECT id FROM users)
      GROUP BY m.user_id`).run();
    db.prepare(`INSERT INTO badge_stats (user_id, forum_likes)
      SELECT m.user_id, COUNT(*) FROM forum_votes v JOIN messages m ON m.id = v.message_id
      WHERE v.value = 1 AND m.user_id IS NOT NULL AND m.user_id <> v.user_id AND m.user_id IN (SELECT id FROM users)
      GROUP BY m.user_id
      ON CONFLICT(user_id) DO UPDATE SET forum_likes = excluded.forum_likes`).run();
    const insert = db.prepare(`INSERT INTO badges (name, description, icon_type, icon, icon_key, kind, threshold, enabled, position)
      VALUES (?, ?, 'builtin', ?, ?, ?, ?, 0, ?)`);
    DEFAULT_BADGES.forEach((b, i) => insert.run(b.name, b.description, b.icon, iconKey('builtin', b.icon), b.kind, b.threshold, i));
  })();
}

// ── Checking what an editor sends ─────────────────────────

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // Control characters and markup brackets have no place in a short label.
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanIcon(type, value) {
  if (typeof value !== 'string') return null;
  if (type === 'builtin') return BUILTIN_ICONS.includes(value) ? value : null;
  if (type === 'image') return ICON_PATH_RE.test(value) ? value : null;
  if (type === 'emoji') {
    const v = value.trim();
    return EMOJI_RE.test(v) ? v : null;
  }
  return null;
}

// ── Telling icons apart ───────────────────────────────────
// Two badges never share an icon. What counts as the same icon: the same
// built-in, the same emoji (with or without its text/emoji style marker), or
// an uploaded picture with the same bytes, whatever its file is called.

function imageKey(bytes) {
  return 'image:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The key for a built-in or emoji icon; uploaded pictures use imageIconKey. */
function iconKey(type, icon) {
  if (type === 'builtin') return `builtin:${icon}`;
  if (type === 'emoji') return `emoji:${icon.replace(/[\uFE0E\uFE0F]/g, '')}`;
  return null;
}

/**
 * The key for an uploaded picture, read from `storage` (src/storage), or
 * null when its file is gone. Other read errors throw, and the caller refuses
 * the save.
 */
async function imageIconKey(icon, storage) {
  const bytes = await storage.readBuffer(`badges/${path.basename(icon)}`);
  return bytes ? imageKey(bytes) : null;
}

// Uploaded icons from before icon_key, keyed now that storage is known.
async function fillImageKeys(db, storage) {
  const rows = db.prepare("SELECT id, icon FROM badges WHERE icon_key IS NULL AND icon_type = 'image'").all();
  const set = db.prepare('UPDATE badges SET icon_key = ? WHERE id = ?');
  for (const b of rows) {
    const key = await imageIconKey(b.icon, storage);
    if (key) set.run(key, b.id);
  }
}

/** The other badge already showing this icon, or null. */
function iconTakenBy(db, key, exceptId = null) {
  return db.prepare('SELECT id, name FROM badges WHERE icon_key = ? AND id IS NOT ?').get(key, exceptId) || null;
}

/**
 * Check a create or update payload. With `current`, missing fields keep
 * their stored value. Returns { error } or { badge } with every column.
 */
function readBadgeInput(db, data, current = null) {
  if (!data || typeof data !== 'object') return { error: 'Invalid request' };
  const pick = (key, fallback) => (data[key] !== undefined ? data[key] : fallback);

  const name = cleanText(pick('name', current?.name), NAME_MAX);
  if (!name) return { error: `A badge needs a name (up to ${NAME_MAX} characters)` };
  const description = cleanText(pick('description', current?.description || ''), DESCRIPTION_MAX);

  const iconType = pick('iconType', current?.icon_type);
  const icon = cleanIcon(iconType, pick('icon', current?.icon));
  if (!icon) return { error: 'Pick an icon: an emoji, a built-in icon, or an uploaded image' };

  const kind = pick('kind', current?.kind);
  if (!KINDS.includes(kind)) return { error: 'Unknown badge type' };

  let threshold = null;
  let roleId = null;
  if (EARNED_KINDS.has(kind)) {
    const raw = pick('threshold', current?.kind === kind ? current.threshold : undefined);
    const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > THRESHOLD_MAX[kind]) {
      return { error: `The amount must be a whole number from 1 to ${THRESHOLD_MAX[kind]}` };
    }
    threshold = n;
  } else if (kind === 'role') {
    const raw = pick('roleId', current?.kind === 'role' ? current.role_id : undefined);
    const role = Number.isInteger(raw) ? db.prepare("SELECT id FROM roles WHERE id = ? AND scope = 'server'").get(raw) : null;
    if (!role) return { error: 'Pick a server role for this badge' };
    roleId = role.id;
  }

  const enabledRaw = pick('enabled', current ? !!current.enabled : true);
  if (typeof enabledRaw !== 'boolean') return { error: 'Invalid request' };

  return { badge: { name, description, icon_type: iconType, icon, kind, threshold, role_id: roleId, enabled: enabledRaw ? 1 : 0 } };
}

// ── Reading ───────────────────────────────────────────────

function getBadge(db, id) {
  return Number.isInteger(id) ? db.prepare('SELECT * FROM badges WHERE id = ?').get(id) : null;
}

/** Every badge for the admin list, with how many hold a hand-given one. */
function listBadges(db) {
  return db.prepare(`
    SELECT b.*, r.name AS role_name, r.color AS role_color,
           (SELECT COUNT(*) FROM user_badges ub WHERE ub.badge_id = b.id) AS holders
    FROM badges b LEFT JOIN roles r ON r.id = b.role_id
    ORDER BY b.position, b.id
  `).all().map(publicDefinition);
}

function publicDefinition(b) {
  return {
    id: b.id, name: b.name, description: b.description,
    iconType: b.icon_type, icon: b.icon, kind: b.kind,
    threshold: b.threshold, roleId: b.role_id, roleName: b.role_name || null, roleColor: b.role_color || null,
    enabled: !!b.enabled, holders: b.holders || 0, iconKey: b.icon_key || null,
  };
}

function daysSince(sqliteDate, now = Date.now()) {
  if (!sqliteDate) return 0;
  const s = String(sqliteDate);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : 0;
}

/** True when a member's totals reach an earned badge's threshold. */
function earns(badge, stats) {
  if (!Number.isInteger(badge.threshold)) return false;
  if (badge.kind === 'account_age') return stats.ageDays >= badge.threshold;
  if (badge.kind === 'messages') return stats.messages >= badge.threshold;
  if (badge.kind === 'forum_likes') return stats.forumLikes >= badge.threshold;
  return false;
}

/** A member's totals: one row each from users and badge_stats. */
function statsFor(db, userId, now = Date.now()) {
  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  const row = db.prepare('SELECT messages, forum_likes FROM badge_stats WHERE user_id = ?').get(userId);
  return { ageDays: daysSince(user && user.created_at, now), messages: row ? row.messages : 0, forumLikes: row ? row.forum_likes : 0 };
}

/**
 * The badges a member shows on their card, in the admin's order. Their own
 * card (viewerId === userId) also lists the ones they hid, marked hidden, so
 * they can show them again.
 *
 * Earned badges of one kind are tiers (#5800): five years on the server says
 * one year too, so only the highest of each kind shows. Badges given by a
 * role or by hand always show.
 */
function badgesForProfile(db, userId, viewerId, now = Date.now()) {
  const defs = db.prepare(`SELECT b.*, r.name AS role_name FROM badges b LEFT JOIN roles r ON r.id = b.role_id
    WHERE b.enabled = 1 ORDER BY b.position, b.id`).all();
  if (!defs.length) return [];
  const stats = defs.some(b => EARNED_KINDS.has(b.kind)) ? statsFor(db, userId, now) : null;
  const roleIds = new Set(db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? AND channel_id IS NULL').all(userId).map(r => r.role_id));
  const given = new Set(db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(userId).map(r => r.badge_id));
  const hidden = new Set(db.prepare('SELECT badge_id FROM badge_hidden WHERE user_id = ?').all(userId).map(r => r.badge_id));
  const self = viewerId === userId;
  // The highest tier earned of each kind, worked out before anything hidden
  // is left out: hiding the top one does not bring a lower one back.
  const top = new Map();
  for (const b of defs) {
    if (EARNED_KINDS.has(b.kind) && earns(b, stats) && !(top.get(b.kind) >= b.threshold)) top.set(b.kind, b.threshold);
  }
  const out = [];
  for (const b of defs) {
    const has = EARNED_KINDS.has(b.kind) ? earns(b, stats) && b.threshold === top.get(b.kind)
      : b.kind === 'role' ? (b.role_id != null && roleIds.has(b.role_id))
      : given.has(b.id);
    if (!has) continue;
    const isHidden = hidden.has(b.id);
    if (isHidden && !self) continue;
    const entry = { id: b.id, name: b.name, description: b.description, iconType: b.icon_type, icon: b.icon, kind: b.kind };
    if (EARNED_KINDS.has(b.kind)) entry.threshold = b.threshold;
    if (b.kind === 'role') entry.roleName = b.role_name || null;
    if (self) entry.hidden = isHidden;
    out.push(entry);
  }
  return out;
}

module.exports = {
  KINDS, EARNED_KINDS, BUILTIN_ICONS, MAX_BADGES, ICON_PATH_RE, DEFAULT_BADGES,
  migrateBadges, readBadgeInput, getBadge, listBadges, badgesForProfile, statsFor, earns, daysSince, cleanIcon,
  iconKey, imageKey, imageIconKey, fillImageKeys, iconTakenBy,
};
