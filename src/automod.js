'use strict';

// ══════════════════════════════════════════════════════════════════════
// Auto-moderation engine (v3.42.0, shared rules extracted in v3.44.0)
// ══════════════════════════════════════════════════════════════════════
//
// Two jobs:
//
//   1. Decide whether a piece of user-supplied text is allowed to exist,
//      based on the links it contains and an admin-configured domain policy.
//   2. Track repeat offences and escalate warn -> mute -> ban.
//
// The URL parsing and host matching live in public/js/automod-rules.js, which
// this file requires and the browser loads with a <script> tag. They are
// shared rather than reimplemented because the client now has to make the same
// judgement the server does: end-to-end encrypted DMs are ciphertext here, so
// only the recipient's client can inspect a decrypted DM's links (#5483). Two
// implementations that drifted apart would turn the client-side check into a
// false reassurance, which is worse than not having one.
//
// See that file for why the URL parsing is as paranoid as it is.

const { getDb } = require('./database');
const rules = require('../public/js/automod-rules.js');

// ── Settings cache ──────────────────────────────────────────────────
// Hit on every message, so we cache like the IP-ban gate does and let the
// admin handlers invalidate on write.
let _cache = { settings: null, allow: null, deny: null, expires: 0 };
const CACHE_MS = 15000;

function invalidate() { _cache.expires = 0; }

const DEFAULTS = {
  automod_enabled: 'false',
  automod_link_mode: 'off',                 // 'off' | 'allowlist' | 'blocklist'
  automod_link_exempt_level: '50',          // effective level at/above which links are never filtered
  automod_link_min_account_hours: '0',      // accounts younger than this can post no links at all
  automod_scan_edits: 'true',
  automod_scan_profile: 'true',
  automod_scan_dms: 'true',
  automod_block_ip_urls: 'true',            // http://192.0.2.1/... is never a friendly link
  automod_block_punycode: 'true',           // non-allowlisted xn-- hosts (homoglyph domains)
  automod_block_obfuscated: 'true',         // hxxp:// and evil[.]com defanging
  automod_preview_allowlist_only: 'true',   // only unfurl/inline-render allowlisted hosts
  automod_escalation: JSON.stringify({
    windowHours: 24, warnAt: 1, muteAt: 3, muteMinutes: 60, banAt: 5
  }),
  automod_ban_ip: 'false',                  // escalated bans also ban the offender's recent IPs
  automod_log_channel: '',                  // channel code to mirror automod actions into
  // Word groups (#5614): [{ name, words: [...], strikes }]. A message carrying
  // any word of a group is blocked and counts `strikes` towards escalation.
  automod_words: '[]'
};

// Parse the stored word groups into one regex per group, harshest first.
// Whole words (or phrases) only, case-insensitive, so "class" never trips a
// group that lists "ass".
function compileWordGroups(raw) {
  let groups = [];
  try { groups = JSON.parse(raw || '[]'); } catch { groups = []; }
  if (!Array.isArray(groups)) return [];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return groups.map(g => {
    const words = Array.isArray(g && g.words) ? g.words.map(w => String(w || '').trim()).filter(Boolean) : [];
    if (!words.length) return null;
    try {
      return {
        name: String((g && g.name) || '').slice(0, 40) || 'words',
        strikes: Math.min(100, Math.max(1, parseInt(g && g.strikes, 10) || 1)),
        re: new RegExp('(?<![\\p{L}\\p{N}_])(?:' + words.map(esc).join('|') + ')(?![\\p{L}\\p{N}_])', 'iu')
      };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.strikes - a.strikes);
}

function settings() {
  const now = Date.now();
  if (_cache.settings && now < _cache.expires) return _cache.settings;

  const s = Object.assign({}, DEFAULTS);
  try {
    const rows = getDb().prepare(
      "SELECT key, value FROM server_settings WHERE key LIKE 'automod_%'"
    ).all();
    for (const r of rows) s[r.key] = r.value;
  } catch { /* pre-migration DB: fall back to defaults (all off) */ }

  let allow = new Map(), deny = new Map();
  try {
    for (const r of getDb().prepare('SELECT domain, mode, include_subdomains FROM automod_domains').all()) {
      (r.mode === 'deny' ? deny : allow).set(r.domain, r.include_subdomains !== 0);
    }
  } catch { /* table not created yet */ }

  _cache = { settings: s, allow, deny, words: compileWordGroups(s.automod_words), expires: now + CACHE_MS };
  return s;
}

function enabled() { return settings().automod_enabled === 'true'; }

// ══════════════════════════════════════════════════════════════════════
// Policy assembly
// ══════════════════════════════════════════════════════════════════════

// Build the plain-object policy the shared rules module consumes. This is the
// same shape sent to clients over the socket, so both sides evaluate against
// byte-identical input.
function policy() {
  const s = settings();
  return {
    mode: s.automod_link_mode,
    allow: [..._cache.allow].map(([domain, includeSubdomains]) => ({ domain, includeSubdomains })),
    deny:  [..._cache.deny].map(([domain, includeSubdomains]) => ({ domain, includeSubdomains })),
    blockIpUrls: s.automod_block_ip_urls === 'true',
    blockPunycode: s.automod_block_punycode === 'true',
    blockObfuscated: s.automod_block_obfuscated === 'true'
  };
}

// Public: is this host allowed to be linked / previewed / inline-rendered?
function checkHost(host) {
  settings();                      // refresh the domain cache if stale
  return rules.checkHost(host, policy());
}

const normalizeHost = rules.normalizeHost;
const hostMatches = rules.hostMatches;
const extractUrls = rules.extractUrls;


// ══════════════════════════════════════════════════════════════════════
// Content check
// ══════════════════════════════════════════════════════════════════════

// ctx: { userId, isAdmin, effectiveLevel, createdAt, surface }
// surface is one of 'message' | 'edit' | 'dm' | 'profile' | 'channel'.
//
// Returns { ok: true } or { ok: false, rule, message, host, excerpt }.
function checkText(text, ctx = {}) {
  if (!enabled()) return { ok: true };
  if (typeof text !== 'string' || !text.trim()) return { ok: true };

  const s = settings();

  if (ctx.surface === 'edit' && s.automod_scan_edits !== 'true') return { ok: true };
  if (ctx.surface === 'dm' && s.automod_scan_dms !== 'true') return { ok: true };
  if (ctx.surface === 'profile' && s.automod_scan_profile !== 'true') return { ok: true };

  // Admins and sufficiently-ranked staff are never filtered. Checked before
  // anything else so a mod pasting a link into a locked-down channel works.
  if (ctx.isAdmin) return { ok: true };
  const exemptLevel = parseInt(s.automod_link_exempt_level, 10);
  if (Number.isFinite(exemptLevel) && exemptLevel >= 0 &&
      Number.isFinite(ctx.effectiveLevel) && ctx.effectiveLevel >= exemptLevel) {
    return { ok: true };
  }

  // ── Word groups (#5614) ──
  // Before the link rules, and independent of the link policy being on. DMs
  // are ciphertext here, so they cannot be checked.
  if (ctx.surface !== 'dm') {
    for (const g of _cache.words || []) {
      const m = g.re.exec(text);
      if (m) {
        return {
          ok: false,
          rule: 'word',
          host: null,
          excerpt: String(m[0]).slice(0, 60),
          weight: g.strikes,
          group: g.name,
          message: `That message has a word this server does not allow (${g.name}).`
        };
      }
    }
  }

  const links = extractUrls(text);
  if (!links.length) return { ok: true };

  // ── New-account link gate ──
  // Independent of the allowlist and deliberately blunt. The register ->
  // post-link -> get-banned -> re-register loop is the pattern this exists
  // to break, and it does not care which domain was used.
  const minHours = parseInt(s.automod_link_min_account_hours, 10);
  if (Number.isFinite(minHours) && minHours > 0 && ctx.createdAt) {
    const ageMs = Date.now() - new Date(String(ctx.createdAt).replace(' ', 'T') + 'Z').getTime();
    if (Number.isFinite(ageMs) && ageMs < minHours * 3600 * 1000) {
      const hoursLeft = Math.max(1, Math.ceil((minHours * 3600 * 1000 - ageMs) / 3600000));
      return {
        ok: false,
        rule: 'link_new_account',
        host: links[0].host,
        excerpt: links[0].url.slice(0, 200),
        message: `New accounts can't post links yet. Try again in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}.`
      };
    }
  }

  if (s.automod_link_mode === 'off') return { ok: true };

  // Domain policy itself is evaluated by the shared rules module, so the
  // server and the browser reach identical verdicts on identical input.
  const hit = rules.checkText(text, policy());
  if (hit) {
    return {
      ok: false,
      rule: hit.rule,
      host: hit.host,
      excerpt: String(hit.url || '').slice(0, 200),
      message: hit.message
    };
  }

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
// Infractions and escalation
// ══════════════════════════════════════════════════════════════════════

function escalationConfig() {
  try {
    const cfg = JSON.parse(settings().automod_escalation);
    return {
      windowHours: Number(cfg.windowHours) > 0 ? Number(cfg.windowHours) : 24,
      warnAt: Number(cfg.warnAt) > 0 ? Number(cfg.warnAt) : 0,
      muteAt: Number(cfg.muteAt) > 0 ? Number(cfg.muteAt) : 0,
      muteMinutes: Number(cfg.muteMinutes) > 0 ? Number(cfg.muteMinutes) : 60,
      banAt: Number(cfg.banAt) > 0 ? Number(cfg.banAt) : 0
    };
  } catch {
    return { windowHours: 24, warnAt: 1, muteAt: 3, muteMinutes: 60, banAt: 5 };
  }
}

// Record the offence and work out what to do about it. Returns
// { count, action, muteMinutes }, where action is 'none' | 'warn' | 'mute' | 'ban'.
//
// The caller performs the mute/ban so that socket disconnection, presence
// updates and audit logging stay in the socket layer where they belong.
function recordInfraction(userId, verdict, channelId) {
  const db = getDb();
  const cfg = escalationConfig();

  // A word group can be worth several strikes; everything else is one (#5614).
  const weight = Math.min(100, Math.max(1, parseInt(verdict.weight, 10) || 1));
  try {
    db.prepare(
      'INSERT INTO automod_infractions (user_id, rule, channel_id, host, excerpt, weight) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, verdict.rule, channelId || null, verdict.host || null, (verdict.excerpt || '').slice(0, 300), weight);
  } catch (err) {
    console.error('automod: failed to record infraction', err);
    return { count: 0, action: 'none', muteMinutes: 0 };
  }

  let count = 0;
  try {
    count = db.prepare(
      `SELECT COALESCE(SUM(weight), 0) AS c FROM automod_infractions
       WHERE user_id = ? AND created_at >= datetime('now', ?)`
    ).get(userId, `-${cfg.windowHours} hours`).c;
  } catch { count = weight; }

  // Highest threshold that has been reached wins.
  let action = 'none';
  if (cfg.warnAt && count >= cfg.warnAt) action = 'warn';
  if (cfg.muteAt && count >= cfg.muteAt) action = 'mute';
  if (cfg.banAt && count >= cfg.banAt) action = 'ban';

  return { count, action, muteMinutes: cfg.muteMinutes, windowHours: cfg.windowHours };
}

// ── Preview / inline-render gate ────────────────────────────────────
// Used by /api/link-preview. Separate from checkText because it answers a
// narrower question: may the SERVER fetch this, and may every client in the
// channel be told to load an image from it?
//
// This is the control that closes the passive leak. Haven renders og:image
// and bare image URLs directly from the third-party host in every viewer's
// browser, so a hostile link exposes the IP and User-Agent of everyone who
// merely scrolls past it, with no click involved.
function previewAllowed(url) {
  const s = settings();
  if (!enabled()) return true;
  if (s.automod_preview_allowlist_only !== 'true') return true;
  if (s.automod_link_mode === 'off') return true;

  let host;
  try { host = normalizeHost(new URL(url).hostname); } catch { return false; }
  if (!host) return false;

  const p = policy();
  if (rules.lookup(host, p.deny)) return false;
  if (rules.lookup(host, p.allow)) return true;
  // In allowlist mode an unknown host never gets unfurled. In blocklist mode
  // only explicitly denied hosts are held back.
  return s.automod_link_mode !== 'allowlist';
}

module.exports = {
  settings,
  invalidate,
  enabled,
  checkText,
  checkHost,
  previewAllowed,
  extractUrls,
  normalizeHost,
  hostMatches,
  recordInfraction,
  escalationConfig,
  policy,
  DEFAULTS
};
