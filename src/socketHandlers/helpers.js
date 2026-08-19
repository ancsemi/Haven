// ── Pure utilities and constants (no io/db dependency) ──

// Normalize SQLite timestamps to UTC ISO 8601
// SQLite CURRENT_TIMESTAMP produces UTC without 'Z' suffix;
// browsers mis-interpret bare datetime strings as local time.
function utcStamp(s) {
  if (!s || s.endsWith('Z')) return s;
  return s.replace(' ', 'T') + 'Z';
}

// ── Input validation helpers ────────────────────────────
function isString(v, min = 0, max = Infinity) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function isInt(v) {
  return Number.isInteger(v);
}

// ── Server-side HTML sanitization (strip dangerous tags/attrs) ──
// Belt-and-suspenders: client escapes HTML, but server strips anything that
// could be rendered as executable HTML in case of client-side bugs.
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  // Strip dangerous HTML tags/attributes as defense-in-depth.
  // Do NOT entity-encode here — the client handles its own escaping when
  // rendering via _escapeHtml(). Entity-encoding on the server would cause
  // double-encoding (e.g. ' → &#39; stored → &amp;#39; after client escape).
  return str
    .replace(/<script[\s>][\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s>][\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s>][\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s>][\s\S]*?(?:\/>|>)/gi, '')
    .replace(/<style[\s>][\s\S]*?<\/style>/gi, '')
    .replace(/<meta[\s>][\s\S]*?(?:\/>|>)/gi, '')
    .replace(/<form[\s>][\s\S]*?<\/form>/gi, '')
    .replace(/<link[\s>][\s\S]*?(?:\/>|>)/gi, '')
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript\s*:/gi, '');
}

// ── Validate /uploads/ path (prevent path traversal) ──
function isValidUploadPath(value) {
  if (!value || typeof value !== 'string') return false;
  // Must start with /uploads/ and contain only safe filename characters (no ../ or special chars)
  return /^\/uploads\/[\w\-.]+$/.test(value);
}

// ── Display names (#5509) ───────────────────────────────
// Letters, numbers and combining marks from any script, plus underscore and
// space. Widened from ASCII so people can write their own name in their own
// language, without giving up what the old charset was really buying:
//   - no dots, slashes or colons, so a display name still cannot carry a
//     working URL (the reason the ASCII rule existed).
//   - no format characters. Zero-width joiners and bidi overrides are Cf, not
//     letters, so they cannot pass. Two display names can never differ by
//     something nobody can see, and nobody can flip the sidebar to RTL.
// Homoglyphs remain possible (Cyrillic "а" reads as Latin "a"). No charset
// fixes that; the automod deny-list is what reserves names like "Admin".
const DISPLAY_NAME_ALLOWED = /^[\p{L}\p{N}\p{M}_ ]+$/u;

// Vietnamese and several Indic scripts legitimately stack marks on one base.
// Past three in a row it is Zalgo, which climbs out of the message row and
// over the rest of the UI.
const DISPLAY_NAME_MARK_RUN = /\p{M}{4,}/u;

const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 20;

/**
 * Validate a display name and return its canonical form.
 * Returns { value } on success, or { error } carrying a user-facing message.
 */
function normalizeDisplayName(raw) {
  const tooLong = `Display name must be ${DISPLAY_NAME_MIN}-${DISPLAY_NAME_MAX} characters`;
  if (typeof raw !== 'string') return { error: tooLong };

  // NFC first. The same name typed two ways (composed vs decomposed) becomes
  // one string, so the length below counts what the user actually sees and the
  // duplicate-name check compares like with like.
  const value = raw.normalize('NFC').trim().replace(/\s+/g, ' ');

  // Code points, not UTF-16 units, or scripts outside the BMP would be charged
  // double for characters that occupy one column.
  const length = [...value].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) return { error: tooLong };

  if (!DISPLAY_NAME_ALLOWED.test(value)) {
    return { error: 'Letters, numbers, underscores, and spaces only' };
  }
  if (DISPLAY_NAME_MARK_RUN.test(value)) {
    return { error: 'Too many stacked accent marks' };
  }
  return { value };
}

// All recognized role permissions. Any permission sent by a client that is not here is silently rejected.
const VALID_ROLE_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
  'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user', 'ban_ip',
  'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
  'manage_channel_settings',
  'create_channel', 'create_temp_channel', 'invite_users',
  'upload_files', 'use_voice', 'use_tts', 'manage_webhooks', 'mention_everyone', 'view_history',
  'view_all_members', 'view_all_channels', 'view_channel_members', 'manage_emojis', 'manage_stickers', 'manage_soundboard', 'manage_music_queue',
  'promote_user', 'transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'read_only_override',
  'view_audit_log', 'manage_display_names'
];

// ── Idle-online decision (pure, so it can be unit-tested) ──
// Given each online user's timing and live status, return those that have been
// connected and showing green for at least thresholdMs with no deliberate
// activity for at least that long. Away/dnd/invisible are excluded on purpose:
// a real client trips auto-away, so an account that is still 'online' and
// silent after hours is the bot-shaped case we want to surface. Longest-idle
// first. `entries`: [{ id, username, isAdmin, createdAt, onlineSince(ms),
// lastActiveAt(ms), status }].
function filterIdleOnline(entries, thresholdMs, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const out = [];
  for (const e of entries || []) {
    if (!e || e.status !== 'online') continue;
    const onlineForMs = now - e.onlineSince;
    const idleForMs = now - e.lastActiveAt;
    if (onlineForMs < thresholdMs || idleForMs < thresholdMs) continue;
    out.push({
      id: e.id, username: e.username, isAdmin: !!e.isAdmin, createdAt: e.createdAt || null,
      onlineForMs, idleForMs, onlineSince: new Date(e.onlineSince).toISOString()
    });
  }
  out.sort((a, b) => b.idleForMs - a.idleForMs);
  return out;
}

module.exports = { utcStamp, isString, isInt, sanitizeText, isValidUploadPath, normalizeDisplayName, VALID_ROLE_PERMS, filterIdleOnline };
