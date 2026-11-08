'use strict';

// Blocked names: words no username or display name may contain. The admin
// keeps the list in server_settings.blocked_name_words, one word per line.
//
// A name matches when the word appears anywhere in it once both are reduced
// to plain letters and digits: case, accents, spaces and symbols are ignored,
// look-alike numbers count as letters (0 as o, 1 as i or l, 3 as e and so
// on), and so do the Cyrillic letters that look like Latin ones. So a blocked
// "badword" also catches "B4d_W0rd" and "bád word".

const KEY = 'blocked_name_words';
const MAX_WORDS = 300;
const MAX_WORD_LEN = 40;

const LOOKALIKE = {
  '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i',
  // Cyrillic letters drawn the same as Latin ones.
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
  'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l',
};

// "1" and "|" read as either i or l, so a name is checked both ways.
function reduce(text, one) {
  return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[\s\S]/gu, (c) => (c === '1' || c === '|') ? one : (LOOKALIKE[c] || c))
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** The admin's list, cleaned: one entry per word, at most MAX_WORDS. */
function parseBlockedNames(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(/[\n,]+/)) {
    const word = part.trim().replace(/\s+/g, ' ').slice(0, MAX_WORD_LEN);
    const key = reduce(word, 'i');
    if (!word || key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** The first blocked word `name` contains, or null. */
function blockedWordIn(name, words) {
  if (!words || !words.length) return null;
  const forms = [reduce(name, 'i'), reduce(name, 'l')];
  for (const word of words) {
    const key = reduce(word, 'i');
    if (key && forms.some(f => f.includes(key))) return word;
  }
  return null;
}

/** The saved list, read from the SQLite settings table. */
function readBlockedNames(db) {
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(KEY);
  return parseBlockedNames(row && row.value);
}

const REFUSAL = 'That name is not allowed on this server';

/**
 * The refusal for a name, or null when it may be used. A failed read refuses,
 * so a broken settings table never lets a blocked name through.
 */
function nameRefusal(db, name) {
  let words;
  try {
    words = readBlockedNames(db);
  } catch (err) {
    console.warn('[blocked-names] could not read the list, refusing the name:', err.message);
    return 'Could not check that name right now. Try again in a moment.';
  }
  return blockedWordIn(name, words) ? REFUSAL : null;
}

module.exports = { KEY, MAX_WORDS, REFUSAL, parseBlockedNames, blockedWordIn, readBlockedNames, nameRefusal };
