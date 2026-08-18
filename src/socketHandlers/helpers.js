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

module.exports = { utcStamp, isString, isInt, sanitizeText, isValidUploadPath, VALID_ROLE_PERMS, filterIdleOnline };
