'use strict';

// Defaults for new members (#5739). An admin shares a snapshot of their own
// look-and-feel settings, and each member starts from it once. Only cosmetic
// settings are allowed here: nothing about security, privacy, notifications,
// audio devices, keys or the account itself.
//
// Stored as the server setting `member_defaults`: {"v": <number>, "s": {...}}.
// `v` only goes up when the admin asks to apply the defaults to everyone
// again; each member keeps a record of the last version they received.

const { BUILTIN_THEMES, isThemeFilename } = require('./themeMetadata');

const SETTING_KEY = 'member_defaults';
// Per member, in user_preferences: {"v": <version received>, "a": {key: value}}
// where `a` holds what the defaults wrote, so a later version can tell a
// value the member picked from one the defaults left there.
const RECORD_PREF = 'member_defaults_applied';

const oneOf = (...values) => (v) => values.includes(v);
const bool = (v) => typeof v === 'boolean';

// Account settings live in user_preferences and follow the member to every
// device; the server writes them. Device settings live in the browser and
// the client writes them.
const SETTINGS = {
  theme: {
    scope: 'account',
    check: (v) => typeof v === 'string' && v !== '' && v !== 'custom'
      && (BUILTIN_THEMES.includes(v) || (v.startsWith('file:') && isThemeFilename(v.slice(5)))),
  },
  effects: {
    scope: 'account',
    check: (v) => {
      if (v === 'auto' || v === 'none') return true;
      if (typeof v !== 'string' || v.length > 400) return false;
      try {
        const list = JSON.parse(v);
        return Array.isArray(list) && list.length <= 24 && list.every((x) => typeof x === 'string' && /^[a-z0-9_-]{1,32}$/.test(x));
      } catch { return false; } // not JSON: not a valid effects value
    },
  },
  layout: { scope: 'device', check: (v) => typeof v === 'string' && /^(?:[A-Za-z][A-Za-z0-9_-]{0,40}Layout)?$/.test(v) },
  density: { scope: 'device', check: oneOf('compact', 'cozy', 'spacious') },
  zoom: { scope: 'device', check: (v) => Number.isInteger(v) && v >= 70 && v <= 150 },
  reaction_size: { scope: 'device', check: oneOf('small', 'normal', 'large', 'x-large') },
  interface_icons: { scope: 'device', check: oneOf('mono', 'emoji', 'glyphs') },
  role_display: { scope: 'device', check: oneOf('colored-name', 'dot') },
  image_mode: { scope: 'device', check: oneOf('thumbnail', 'full') },
  embed_size: { scope: 'device', check: oneOf('off', 'small', 'medium', 'full') },
  animate_pfp: { scope: 'device', check: oneOf('always', 'hover', 'never') },
  animate_chat: { scope: 'device', check: oneOf('always', 'hover', 'never') },
  toggle_style: { scope: 'device', check: oneOf('switch', 'box') },
  channel_scroll: { scope: 'device', check: oneOf('separate', 'combined') },
  compact_composer: { scope: 'device', check: bool },
  hide_send: { scope: 'device', check: bool },
  blur_nsfw: { scope: 'device', check: bool },
  hover_profile_card: { scope: 'device', check: bool },
};
const ACCOUNT_KEYS = Object.keys(SETTINGS).filter((k) => SETTINGS[k].scope === 'account');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Keeps the allowed keys with valid values and drops everything else.
function cleanSettings(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && def.check(raw[key])) out[key] = raw[key];
  }
  return out;
}

const cleanVersion = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

// Parses the stored setting. Anything malformed reads as "no defaults".
function parseStored(text) {
  if (typeof text !== 'string' || !text || text.length > 8000) return { v: 0, s: {} };
  try {
    const o = JSON.parse(text);
    return isObj(o) ? { v: cleanVersion(o.v), s: cleanSettings(o.s) } : { v: 0, s: {} };
  } catch { return { v: 0, s: {} }; } // corrupt row: treated as no defaults
}

// Server templates carry the settings only. The version belongs to the
// server they were made on, so an import starts at 0: members who never
// received defaults get them, everyone else waits for "apply to everyone".
// No defaults travel as '', like an unset default theme does.
function templateValue(text) {
  const { s } = parseStored(text);
  return Object.keys(s).length ? JSON.stringify({ v: 0, s }) : '';
}

function readSnapshot(db) {
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(SETTING_KEY);
  return parseStored(row?.value);
}

function writeSnapshot(db, snapshot) {
  const value = JSON.stringify({ v: cleanVersion(snapshot.v), s: cleanSettings(snapshot.s) });
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(SETTING_KEY, value);
  return value;
}

// The admin's "use my current settings": keeps the version, so members who
// already received an earlier set are left alone until the admin applies
// to everyone.
function saveDefaults(db, settings) {
  const cur = readSnapshot(db);
  const s = cleanSettings(settings);
  if (!Object.keys(s).length) return null;
  return writeSnapshot(db, { v: cur.v || 1, s });
}

function clearDefaults(db) {
  const cur = readSnapshot(db);
  return writeSnapshot(db, { v: cur.v, s: {} });
}

// "Apply once to everyone now": a version above every record any member holds.
function bumpDefaults(db, now = Date.now()) {
  const cur = readSnapshot(db);
  if (!Object.keys(cur.s).length) return null;
  return writeSnapshot(db, { v: Math.max(now, cur.v + 1), s: cur.s });
}

// The server's Default Theme and a shared theme are one choice (#5747).
// When the admin changes the Default Theme, a shared theme follows it, and
// "None" takes the theme out of the shared set. Returns the new stored
// value, or null when nothing had to change.
function followDefaultTheme(db, theme) {
  const cur = readSnapshot(db);
  if (!('theme' in cur.s) || cur.s.theme === theme) return null;
  const s = { ...cur.s };
  if (SETTINGS.theme.check(theme)) s.theme = theme;
  else delete s.theme;
  return writeSnapshot(db, { v: cur.v, s });
}

function parseRecord(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const o = JSON.parse(text);
    if (!isObj(o)) return null;
    const a = {};
    if (isObj(o.a)) for (const k of ACCOUNT_KEYS) if (typeof o.a[k] === 'string') a[k] = o.a[k];
    return { v: cleanVersion(o.v), a };
  } catch { return null; } // corrupt record: treated as never received
}

// Gives one member the account-level defaults they have not received yet.
// A setting is written only when the member has never saved it, or when it
// still holds exactly what an earlier set of defaults put there. Returns the
// settings written ({} when there was nothing to do).
function applyAccountDefaults(db, userId) {
  const snap = readSnapshot(db);
  const prefs = new Map(db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?').all(userId).map((r) => [r.key, r.value]));
  const rec = parseRecord(prefs.get(RECORD_PREF));
  if (!Object.keys(snap.s).length || (rec && rec.v >= snap.v)) return {};

  const applied = {};
  const keep = {};
  const write = db.prepare('INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const key of ACCOUNT_KEYS) {
      const mine = prefs.get(key);
      const fromDefaults = rec && rec.a[key] !== undefined && rec.a[key] === mine;
      if (key in snap.s && (mine === undefined || fromDefaults)) {
        write.run(userId, key, snap.s[key]);
        applied[key] = snap.s[key];
      } else if (fromDefaults) {
        // Not part of this set, still untouched: remember it for the next one.
        keep[key] = mine;
      }
    }
    write.run(userId, RECORD_PREF, JSON.stringify({ v: snap.v, a: { ...keep, ...applied } }));
  })();
  return applied;
}

module.exports = {
  SETTING_KEY, RECORD_PREF, SETTINGS, ACCOUNT_KEYS,
  cleanSettings, parseStored, templateValue, readSnapshot,
  saveDefaults, clearDefaults, bumpDefaults, followDefaultTheme, applyAccountDefaults,
};
