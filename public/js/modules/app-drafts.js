// Unsent text, kept per channel and DM. The message box used to hold one
// text for every channel, so a half-typed message followed you into the next
// one. Each channel now keeps its own until it is sent or deleted, and the
// drafts survive a reload (saved on this device, per account).

const MAX_DRAFTS = 50;
const MAX_LEN = 8000;

export default {

_draftKey() {
  return `haven_drafts_${this.user?.id || 'anon'}`;
},

_draftStore() {
  if (this._drafts) return this._drafts;
  this._drafts = {};
  try {
    const saved = JSON.parse(localStorage.getItem(this._draftKey()) || '{}');
    if (saved && typeof saved === 'object') {
      for (const [code, text] of Object.entries(saved)) {
        if (typeof text === 'string' && text) this._drafts[code] = text.slice(0, MAX_LEN);
      }
    }
  } catch (err) {
    console.warn('[Drafts] saved drafts unreadable, starting empty:', err.message);
  }
  return this._drafts;
},

_draftPersist() {
  try { localStorage.setItem(this._draftKey(), JSON.stringify(this._draftStore())); } catch { /* private mode or full storage: drafts last for this visit */ }
},

// Remember a channel's text (empty text forgets it). The newest go last, so
// the oldest drop off past the cap.
_draftKeep(code, text) {
  if (!code) return;
  const store = this._draftStore();
  delete store[code];
  if (text && text.trim()) store[code] = text.slice(0, MAX_LEN);
  const codes = Object.keys(store);
  for (let i = 0; i < codes.length - MAX_DRAFTS; i++) delete store[codes[i]];
},

// Sending empties the box without an input event, so the text that went out
// would otherwise stay saved and come back as a draft on the next visit.
_draftSent() {
  const code = this.currentChannel;
  if (!code || !(code in this._draftStore())) return;
  this._draftKeep(code, '');
  this._draftPersist();
},

// Leaving a channel: keep what is in the box for it.
_draftStash(code) {
  const input = document.getElementById('message-input');
  if (!code || !input) return;
  this._draftKeep(code, input.value);
  this._draftPersist();
},

// Entering a channel: put its own text back (or an empty box).
_draftRestore(code) {
  const input = document.getElementById('message-input');
  if (!input) return;
  input.value = this._draftStore()[code] || '';
  const maxH = window.innerWidth <= 480 ? 90 : 120;
  input.style.height = 'auto';
  if (input.value) input.style.height = Math.min(input.scrollHeight, maxH) + 'px';
},

_initDrafts() {
  const input = document.getElementById('message-input');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    const code = this.currentChannel;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // A switch since then has already kept this channel's text.
      if (this.currentChannel !== code) return;
      this._draftKeep(code, input.value);
      this._draftPersist();
    }, 600);
  });
  // Closing or hiding the page saves the box as it is, so a message sent
  // since the last save is not brought back on the next visit.
  const save = () => this._draftStash(this.currentChannel);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
},

};
