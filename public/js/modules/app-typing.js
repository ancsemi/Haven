// "Someone is typing" for the channel on screen and the DM pop-out.
//
// The server passes typing on to everyone in the channel's room. It used to
// be shown only under the main chat, and the pop-out neither sent nor showed
// it, so a DM or group chat open there never said anyone was typing. Each
// channel now keeps who is typing in it; the main chat shows its channel and
// the pop-out shows its own. A group chat can have several typers at once.

// A typer is shown this long after their last signal. Clients send one at
// most every 2 seconds while typing (app-composer.js).
const TYPING_SHOWN_MS = 3500;
const TYPING_SEND_EVERY_MS = 2000;

export default {

_setupTyping() {
  this._typers = new Map();
  this.socket.on('user-typing', (data) => {
    if (!data || !data.channelCode) return;
    // Your own other devices are not "someone".
    if (this.user && data.userId != null && data.userId === this.user.id) return;
    this._typingAdd(data.channelCode, data.userId, data.username);
  });
  // Their message arrived: they are done typing it.
  this.socket.on('new-message', (data) => {
    const msg = data && data.message;
    if (!msg || !data.channelCode) return;
    const typers = this._typers.get(data.channelCode);
    if (typers && typers.delete(this._typingKey(msg.user_id, msg.username))) this._typingRender();
  });
  // The pop-out says when you are typing, the way the main box does.
  const pipInput = document.getElementById('dm-pip-input');
  if (pipInput) {
    let lastSent = 0;
    pipInput.addEventListener('input', () => {
      const code = this._activeDMPip;
      const now = Date.now();
      if (!code || !pipInput.value.trim() || now - lastSent < TYPING_SEND_EVERY_MS) return;
      lastSent = now;
      this.socket.emit('typing', { code });
    });
  }
},

// Older servers send only the name, so it stands in for the id.
_typingKey(userId, username) {
  return userId != null ? `id:${userId}` : `name:${username || ''}`;
},

_typingAdd(code, userId, username) {
  let typers = this._typers.get(code);
  if (!typers) this._typers.set(code, (typers = new Map()));
  typers.set(this._typingKey(userId, username), { userId, username, until: Date.now() + TYPING_SHOWN_MS });
  this._typingRender();
},

_typingNames(code) {
  const typers = code && this._typers?.get(code);
  if (!typers) return [];
  const now = Date.now();
  const names = [];
  for (const [key, ty] of typers) {
    if (ty.until <= now) { typers.delete(key); continue; }
    let id = ty.userId;
    if (id == null) id = this._lastOnlineUsers?.find(u => u.username === ty.username)?.id;
    names.push(id != null ? this._getNickname(id, ty.username) : ty.username);
  }
  if (!typers.size) this._typers.delete(code);
  return names;
},

_typingText(names) {
  if (!names.length) return '';
  if (names.length === 1) return t('users.typing', { name: names[0] });
  if (names.length === 2) return t('users.typing_two', { first: names[0], second: names[1] });
  return t('users.typing_many');
},

// Draws both lines and wakes up again when the next typer runs out.
_typingRender() {
  clearTimeout(this._typingTimer);
  const main = document.getElementById('typing-indicator');
  if (main) main.textContent = this._typingText(this._typingNames(this.currentChannel));
  const pip = document.getElementById('dm-pip-typing');
  if (pip) pip.textContent = this._typingText(this._typingNames(this._activeDMPip));
  let next = Infinity;
  for (const typers of this._typers?.values() ?? []) for (const ty of typers.values()) next = Math.min(next, ty.until);
  if (next !== Infinity) this._typingTimer = setTimeout(() => this._typingRender(), Math.max(50, next - Date.now()));
},

};
