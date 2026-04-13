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

// All recognized role permissions. Any permission sent by a client that is not here is silently rejected.
const VALID_ROLE_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
  'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user',
  'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
  'create_channel', 'create_temp_channel', 'upload_files', 'use_voice', 'use_tts', 'manage_webhooks', 'mention_everyone', 'view_history',
  'view_all_members', 'view_channel_members', 'manage_emojis', 'manage_soundboard', 'manage_music_queue',
  'promote_user', 'transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'read_only_override'
];

module.exports = { utcStamp, isString, isInt, sanitizeText, isValidUploadPath, VALID_ROLE_PERMS };
