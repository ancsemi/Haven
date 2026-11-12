'use strict';

// The image emoji that ship with Haven (public/emoji/), by the name they are
// typed with, :name:. The client's list (builtinEmojis in public/js/app.js)
// must hold the same names; test/builtinEmojis.test.js checks that.

const FLAGS = ['us', 'gb', 'ca', 'au', 'nz', 'ie', 'fr', 'de', 'it', 'es', 'pt', 'nl', 'be', 'lu', 'ch', 'at', 'dk',
  'no', 'se', 'fi', 'is', 'pl', 'ee', 'lv', 'lt', 'cz', 'sk', 'hu', 'ro', 'bg', 'si', 'hr', 'gr', 'al', 'me', 'mk',
  'ua', 'tr', 'jp', 'kr', 'tw', 'ph', 'th', 'sg', 'in', 'id', 'my', 'vn', 'mn', 'bd', 'lk', 'np', 'il', 'sa', 'ae',
  'qa', 'bh', 'kw', 'om', 'jo', 'eg', 'ma', 'tn', 'mx', 'br', 'ar', 'cl', 'co', 'pe', 'uy', 'ec', 'cr', 'pa', 'gt',
  'do', 'jm', 'bs', 'tt', 'za', 'ke', 'ng', 'gh', 'sn', 'rw', 'bw', 'ci', 'tz'];

const BUILTIN_EMOJI_NAMES = new Set([
  ...FLAGS.map(c => `flag_${c}`),
  'us_betsy_ross', 'gadsden',
  'os_windows', 'os_mac', 'os_ios', 'os_android', 'os_linux',
]);

const NAMED_EMOJI_RE = /^:([a-zA-Z0-9_-]{1,30}):$/;
const UNICODE_EMOJI_RE = /^[\p{Emoji}\p{Emoji_Component}️‍]+$/u;

// True for :name: when it is one of Haven's own or the server's custom emoji.
// The lookup returns a row on SQLite and a promise on the async adapters.
function isKnownNamedEmoji(db, text) {
  const m = NAMED_EMOJI_RE.exec(String(text || ''));
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (BUILTIN_EMOJI_NAMES.has(name)) return true;
  const row = db.prepare('SELECT 1 FROM custom_emojis WHERE name = ?').get(name);
  return row && typeof row.then === 'function' ? row.then(Boolean) : !!row;
}

// An emoji someone may react with or put on a role menu: a Unicode emoji, or
// a named one this server knows.
function isUsableEmoji(db, text) {
  if (typeof text !== 'string' || !text || text.length > 32) return false;
  return UNICODE_EMOJI_RE.test(text) || isKnownNamedEmoji(db, text);
}

// One that means the same on every server, for server templates: a Unicode
// emoji, or one of Haven's own. A custom emoji may not exist where a template
// is imported.
function isPortableEmoji(text) {
  if (typeof text !== 'string' || !text || text.length > 32) return false;
  if (UNICODE_EMOJI_RE.test(text)) return text.length <= 8;
  const m = NAMED_EMOJI_RE.exec(text);
  return !!m && BUILTIN_EMOJI_NAMES.has(m[1].toLowerCase());
}

const EMOJI_FAVORITES_MAX = 40;
function cleanEmojiFavorites(raw) {
  let list;
  try { list = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const kept = list.filter(e => typeof e === 'string' && e.length <= 32 && (UNICODE_EMOJI_RE.test(e) || NAMED_EMOJI_RE.test(e)));
  return JSON.stringify([...new Set(kept)].slice(0, EMOJI_FAVORITES_MAX));
}
module.exports = { BUILTIN_EMOJI_NAMES, NAMED_EMOJI_RE, EMOJI_FAVORITES_MAX, isKnownNamedEmoji, isUsableEmoji, isPortableEmoji, cleanEmojiFavorites };
