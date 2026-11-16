// Notify user of reply: the bell in every reply bar. On by default, a reply
// also sends its author a push notification, as an @mention would. Off, the
// reply reaches them like any other message; in the app nothing changes
// either way. Kept in this browser and told to the server on each connect
// (src/socketHandlers/index.js).

const KEY = 'haven_reply_ping';

export default {

_setupReplyPing() {
  for (const btn of document.querySelectorAll('.reply-ping-btn')) {
    btn.addEventListener('click', () => this._setReplyPing(!this._replyPingOn()));
  }
  this._setReplyPing(this._replyPingOn());
},

_replyPingOn() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
},

_setReplyPing(on) {
  try { on ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, 'off'); } catch { /* stays for this page only */ }
  const label = t(on ? 'header.reply_ping_on' : 'header.reply_ping_off');
  for (const btn of document.querySelectorAll('.reply-ping-btn')) {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  this.socket?.emit('reply-ping', { on });
},

};
