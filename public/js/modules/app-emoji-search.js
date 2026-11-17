// Emoji search: the words an emoji is found by, and how well a search
// matches it. Used by the emoji picker, the reaction picker, the :emoji
// autocomplete and the emoji chooser.
//
// Words come from three places: the emoji's name (Unicode's, or Haven's own
// richer list in app.js), Unicode's keywords (public/emoji-keywords.json,
// built by scripts/build-emoji-keywords.js), and the chat words in
// emoji-slang.js ("this" for 👆).
import EMOJI_SLANG from './emoji-slang.js?v=4.29.12';

const KEYWORDS_URL = '/emoji-keywords.json?v=4.29.12';
const noVs = (s) => String(s).replace(/️/g, '');

export default {

// Load Unicode's keywords once and add Haven's chat words to them. Search
// works on names alone until this arrives, and if it never does.
_loadEmojiKeywords() {
  if (this._emojiKeywordsLoading) return this._emojiKeywordsLoading;
  const merge = (base) => {
    const out = { ...base };
    for (const [glyph, words] of Object.entries(EMOJI_SLANG)) {
      const key = noVs(glyph);
      out[key] = out[key] ? `${out[key]} ${words}` : words;
    }
    this.emojiKeywords = out;
  };
  this._emojiKeywordsLoading = fetch(KEYWORDS_URL)
    .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(merge)
    .catch(err => {
      console.warn('[Emoji] keyword list unavailable, searching by name only', err);
      merge({});
    });
  return this._emojiKeywordsLoading;
},

// How well `rawQuery` matches `emoji`: 0 is best, -1 is no match. Names count
// more than keywords, and a word has to start with what was typed, so "ok"
// finds 👌 but not 📖 "book".
_emojiSearchScore(emoji, rawQuery) {
  const raw = (rawQuery || '').trim();
  const q = raw.toLowerCase();
  if (!q) return 0;
  const name = String(this.emojiNames?.[emoji] || '').toLowerCase();
  const extra = typeof emoji === 'string' ? (this.emojiKeywords?.[noVs(emoji)] || '') : '';
  // A whole word beats the start of one: "lol" finds 😂 before 🍭 "lollipop".
  const wholeWord = (text) => ` ${text} `.replace(/[:,]/g, ' ').includes(` ${q} `);
  const startsWord = (text) => ` ${text}`.includes(` ${q}`);
  if (name === q) return 0;
  if (wholeWord(name)) return 1;
  if (wholeWord(extra) || (typeof emoji === 'string' && emoji.includes(raw))) return 2;
  if (startsWord(name)) return 3;
  if (startsWord(extra)) return 4;
  const alias = this._getEmojiPunctAliases?.()[q];
  if (alias && alias.split(/\s+/).some(w => name.includes(w))) return 4;
  // Inside a word only counts once the search is long enough to mean
  // something ("ook" can find "book", "ok" can't).
  if (q.length >= 3 && name.includes(q)) return 5;
  return -1;
},

// Every standard emoji that matches, best first, then in picker order.
_emojiSearch(rawQuery) {
  const order = new Map((this.emojis || []).map((e, i) => [e, i]));
  const hits = [];
  for (const emoji of Object.keys(this.emojiNames || {})) {
    const score = this._emojiSearchScore(emoji, rawQuery);
    if (score >= 0) hits.push({ emoji, score, at: order.has(emoji) ? order.get(emoji) : Infinity });
  }
  hits.sort((a, b) => a.score - b.score || a.at - b.at);
  return hits.map(h => h.emoji);
},

};
