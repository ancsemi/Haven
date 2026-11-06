// ── Mentions and replies (the @ button in the account bar) ──────────────────
// Clicking @ opens the search panel on "mentions:me": every message in a
// channel you can open that @mentions you or replies to you, newest first,
// each one a click away (src/mentionFilter.js does the matching). The button
// also counts mentions and replies you have not seen yet. Seeing them means
// opening the list, opening that channel, or reading it on another device.
// DMs are left out: they are end-to-end encrypted and notify on their own.

const UNSEEN_KEY = 'haven_unseen_mentions';
const UNSEEN_CAP = 99;

export default {

_mentionsInit() {
  try { this._unseenMentions = JSON.parse(localStorage.getItem(UNSEEN_KEY) || '[]'); }
  catch { this._unseenMentions = []; } // private mode or a damaged value: start from none
  if (!Array.isArray(this._unseenMentions)) this._unseenMentions = [];
  document.getElementById('mentions-btn')?.addEventListener('click', () => this._mentionsOpen());
  this._mentionsRenderBadge();
},

_mentionsPersist() {
  try { localStorage.setItem(UNSEEN_KEY, JSON.stringify(this._unseenMentions)); }
  catch { /* private mode: the count still works until the page closes */ }
  this._mentionsRenderBadge();
},

_mentionsRenderBadge() {
  const badge = document.getElementById('mentions-btn-count');
  if (!badge) return;
  const n = (this._unseenMentions || []).length;
  badge.textContent = n >= UNSEEN_CAP ? `${UNSEEN_CAP}+` : String(n);
  badge.style.display = n ? '' : 'none';
},

// Same test the list uses: @yourname as a whole word, or a reply to you.
_mentionsIsForMe(message) {
  if (!message || !this.user) return false;
  if (message.replyContext && message.replyContext.user_id === this.user.id) return true;
  const me = (this.user.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !!me && new RegExp(`(?<![\\w@])@${me}(?!\\w)`, 'i').test(message.content || '');
},

// Called for a new message from someone else that you are not looking at.
_mentionsCount(message, channelCode) {
  const ch = (this.channels || []).find(c => c.code === channelCode);
  if (!ch || ch.is_dm || !this._mentionsIsForMe(message)) return;
  const list = this._unseenMentions || (this._unseenMentions = []);
  if (list.some(m => m.id === message.id)) return;
  list.push({ c: channelCode, id: message.id });
  if (list.length > UNSEEN_CAP) list.splice(0, list.length - UNSEEN_CAP);
  this._mentionsPersist();
},

// Opening a channel, or reading it elsewhere, counts its mentions as seen.
_mentionsSeenInChannel(channelCode, upToId) {
  const ch = (this.channels || []).find(c => c.code === channelCode);
  if (ch && !ch.is_dm) this._mentionsHome = channelCode;
  const list = this._unseenMentions || [];
  const kept = list.filter(m => m.c !== channelCode || (upToId && m.id > upToId));
  if (kept.length === list.length) return;
  this._unseenMentions = kept;
  this._mentionsPersist();
},

async _mentionsOpen() {
  this._unseenMentions = [];
  this._mentionsPersist();
  // The list lives in the server-wide search panel, which DMs do not use, so
  // from a DM step back into the last server channel first.
  const here = (this.channels || []).find(c => c.code === this.currentChannel);
  if (!here || here.is_dm) {
    const home = (this.channels || []).find(c => c.code === this._mentionsHome && !c.is_dm)
      || (this.channels || []).find(c => !c.is_dm);
    if (!home) return;
    await this.switchChannel(home.code);
  }
  const token = 'mentions:me';
  const sc = document.getElementById('search-container');
  if (sc) sc.style.display = 'flex';
  const input = document.getElementById('search-input');
  if (input) input.value = token;
  this._searchRun(token);
  this._sfpSync?.();
},

};
