/**
 * Haven: standard (Unicode) emoji list
 *
 * The picker's built-in list in public/js/app.js is hand-curated and misses
 * emoji. This builds the full, categorised list from Unicode's own
 * emoji-test.txt and serves it to the client, which renders the glyphs with
 * the OS font (no image set; they match whatever platform the user is on).
 *
 * Two copies of the file exist:
 *   • src/emoji-test.txt:         committed fallback (16.0), always present
 *   • <DATA_DIR>/emoji-test.txt:  runtime copy, refreshed from unicode.org
 * getEmojiData() prefers the runtime copy and falls back to the committed one.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

// The latest directory tracks Unicode's newest *published* release, so we only
// pick up glyphs that shipped OS fonts can already render. (draft/ carries the
// in-progress version, whose newest emoji render as empty boxes.)
const EMOJI_TEST_URL = 'https://unicode.org/Public/emoji/latest/emoji-test.txt';
const EMOJI_FILE = path.join(DATA_DIR, 'emoji-test.txt');       // runtime copy
const FALLBACK_FILE = path.join(__dirname, 'emoji-test.txt');   // committed fallback
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;                    // refetch after ~1 month

// Fitzpatrick skin-tone modifiers. A base that immediately precedes one of
// these accepts a tone, so the modifier-base set is derived from the file
// rather than shipping a second data source.
const SKIN_TONES = new Set(['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF']);

// Unicode group → Haven's existing picker category, so the tab icons and
// translations already defined in app.js/app-utilities.js keep working. Flags
// are intentionally absent: they stay on Haven's bundled :flag_xx: images,
// which render on every OS unlike Unicode's regional-indicator flags.
const GROUP_TO_CATEGORY = {
  'Smileys & Emotion': 'Smileys',
  'People & Body':     'People',
  'Animals & Nature':  'Animals',
  'Food & Drink':      'Food',
  'Travel & Places':   'Travel',
  'Activities':        'Activities',
  'Objects':           'Objects',
  'Symbols':           'Symbols',
};

let cache = null;

/** Read the "# Version: X" header from an emoji-test.txt body. */
function parseVersion(text) {
  return text.match(/^# Version:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
}

function parseEmojiTest(text) {
  const categories = {};
  const names = {};
  const modifierBase = new Set();
  const seen = new Set();
  let category = null;

  for (const line of text.split('\n')) {
    const group = line.match(/^# group: (.+)/);
    if (group) { category = GROUP_TO_CATEGORY[group[1].trim()] || null; continue; }
    if (!category || line.startsWith('#') || !line.trim()) continue;

    // Line format: <code points> ; <status> # <glyph> E<ver> <name>
    const m = line.match(/^([0-9A-F ]+);\s*(\S+)\s+#\s+(\S+)\s+E[\d.]+\s+(.+)$/);
    if (!m) continue;
    const [, codesRaw, status, glyph, name] = m;
    if (status === 'unqualified' || status === 'component') continue;

    const codes = codesRaw.trim().split(/\s+/);
    const toneIdx = codes.findIndex(c => SKIN_TONES.has(c));
    if (toneIdx !== -1) {
      // A skin-toned variant: record which base carries the tone, then drop the
      // row; the client re-synthesises tones from the base glyph at render time.
      if (toneIdx > 0) modifierBase.add(codes[toneIdx - 1]);
      continue;
    }

    // Collapse VS16 so a minimally-qualified row can't duplicate its own
    // fully-qualified glyph (fully-qualified is listed first, so it wins).
    const key = codes.filter(c => c !== 'FE0F').join(' ');
    if (seen.has(key)) continue;
    seen.add(key);

    (categories[category] ||= []).push(glyph);
    names[glyph] = name.toLowerCase();
  }

  return { categories, names, modifierBase: [...modifierBase] };
}

/** Parse whichever file is active: runtime copy if present, else fallback. */
function buildFromDisk() {
  const file = fs.existsSync(EMOJI_FILE) ? EMOJI_FILE : FALLBACK_FILE;
  try { return parseEmojiTest(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/** Parsed data for the API, built once and cached. */
function getEmojiData() {
  return cache || (cache = buildFromDisk());
}

/** Version string of the committed fallback file (for the fallback log line). */
function fallbackVersion() {
  try { return parseVersion(fs.readFileSync(FALLBACK_FILE, 'utf8')); }
  catch { return '16.0'; }
}

/**
 * Fetch the latest emoji-test.txt, validate it, and save it to the data dir.
 * Returns the Unicode version on success, or null on any failure (offline,
 * timeout, HTTP error, or a body that isn't emoji-test.txt). Emits no console
 * output and applies no fallback policy; the caller owns the messaging.
 */
async function downloadEmojiFile() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(EMOJI_TEST_URL, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text.includes('# group:')) return null; // reject error / captive-portal pages
    fs.writeFileSync(EMOJI_FILE, text);
    cache = null;                                 // force a reparse from the new file
    return parseVersion(text);
  } catch {
    return null;                                  // no internet / unreachable / timeout
  }
}

/**
 * Refreshes the runtime emoji-test.txt with the least possible work: a single
 * stat, at most one network request, at most one write. Runs at startup and
 * again whenever an admin enables the feature.
 *
 * `autoUpdate` is resolved by the caller (env override → admin setting → off).
 * When false, Haven never reaches out and serves whatever is already on disk:
 * the last downloaded copy, or the committed fallback if none was ever fetched.
 */
async function ensureEmojiData(autoUpdate) {
  if (!autoUpdate) return;    // opted out → serve whatever's on disk (runtime copy or committed fallback)

  const stat = fs.existsSync(EMOJI_FILE) ? fs.statSync(EMOJI_FILE) : null;

  // Runtime copy is under a month old → nothing to do (no network, no write).
  if (stat && Date.now() - stat.mtimeMs < MAX_AGE_MS) return;

  // Runtime copy exists but is stale → announce the refresh before downloading.
  if (stat) console.log('Refreshing emoji file......');

  const version = await downloadEmojiFile();
  if (version) {
    console.log(`Successfully downloaded latest ${version} emojis from unicode.org`);
  } else if (!stat) {
    // No runtime copy and the download failed → serve the committed fallback.
    console.log(`Unable to update emojis from unicode.org, fallback to ${fallbackVersion()} set`);
  } else {
    // Stale runtime copy but the refresh failed → keep it (still newer than the fallback).
    console.log('Unable to refresh emojis from unicode.org, keeping current set');
  }
}

/**
 * Resolve whether auto-update should run. The UNICODE_EMOJI_AUTO_UPDATE env var
 * wins when set to true/false (for locked-down deployments); otherwise the admin
 * setting decides, defaulting off. Shared by the boot path and the admin toggle
 * so both honour the same precedence.
 */
function autoUpdateEnabled(settingValue) {
  const env = (process.env.UNICODE_EMOJI_AUTO_UPDATE || '').trim().toLowerCase();
  if (env === 'true' || env === 'false') return env === 'true';
  return settingValue === 'true';
}

module.exports = { ensureEmojiData, getEmojiData, autoUpdateEnabled };
