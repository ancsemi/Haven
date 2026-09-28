export default {
_setupCallListeners() {
  this._callRings = new Map();
  this.socket.on('dm-call-ring', (c) => this._ringIncomingCall(c));
  this.socket.on('dm-call-ring-stop', (d) => this._endIncomingCall(d.code, d.reason, d.callerName));
  this.socket.on('dm-call-ended', (d) => this._endIncomingCall(d.code, 'ended'));
  this.socket.on('dm-call-declined', (d) => d.userId !== this.user?.id && this._showToast(t('calls.declined', { name: this._getNickname(d.userId, d.username) }), 'info'));
  this.socket.on('dm-call-unanswered', (d) => {
    if (!this.voice?.inVoice || this.voice.currentChannel !== d.code) return;
    this._showToast(t(d.reason === 'declined' ? 'calls.declined_all' : 'calls.no_answer'), 'info');
    this._leaveVoice();
  });
  this.socket.on('dm-call-state', (d) => (d.calls || []).filter(c => c.ringing && c.expiresAt > Date.now()).forEach(c => this._ringIncomingCall(c)));
},
_callTitle(c) {
  return c.isGroup ? (c.groupName || t('calls.group')) : this._getNickname(c.callerId, c.callerName);
},
_callNotify(title, body, code) {
  if (document.hasFocus()) return;
  try {
    window.havenDesktop?.notify ? window.havenDesktop.notify(title, body, { channelCode: code, silent: true })
      : (window.Notification?.permission === 'granted' && new Notification(title, { body, tag: `haven-call-${code}` }));
  } catch {}
},
_ringIncomingCall(c) {
  if (!c?.code || this._callRings.has(c.code) || (this.voice?.inVoice && this.voice.currentChannel === c.code)) return;
  let muted = localStorage.getItem('haven_server_muted') === '1';
  try { muted = muted || JSON.parse(localStorage.getItem('haven_muted_channels') || '[]').includes(c.code); } catch {}
  const caller = this._getNickname(c.callerId, c.callerName);
  const el = document.createElement('div');
  el.className = 'call-ring';
  el.setAttribute('role', 'alertdialog');
  el.innerHTML = '<div class="call-ring-pulse">📞</div><div class="call-ring-text"><div class="call-ring-title"></div><div class="call-ring-sub"></div></div><button type="button" class="call-ring-accept"></button><button type="button" class="call-ring-decline"></button>';
  el.querySelector('.call-ring-title').textContent = this._callTitle(c);
  el.querySelector('.call-ring-sub').textContent = c.isGroup ? t('calls.incoming_group', { name: caller }) : t('calls.incoming');
  const accept = el.querySelector('.call-ring-accept');
  const decline = el.querySelector('.call-ring-decline');
  accept.textContent = t('calls.accept');
  decline.textContent = t('calls.decline');
  accept.addEventListener('click', () => this._acceptCall(c.code));
  decline.addEventListener('click', () => this._declineCall(c.code));
  let stack = document.getElementById('call-ring-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'call-ring-stack';
    document.body.appendChild(stack);
  }
  stack.appendChild(el);
  const ring = () => this.notifications?._playTone?.([659, 784, 659, 784], [0.16, 0.16, 0.16, 0.32], 'sine');
  if (!muted) ring();
  const tone = muted ? null : setInterval(ring, 2600);
  const timer = setTimeout(() => this._endIncomingCall(c.code, 'missed', c.callerName), Math.max(1000, (c.expiresAt || Date.now() + 45000) - Date.now()));
  this._callRings.set(c.code, { el, tone, timer, call: c });
  this._callNotify(this._callTitle(c), c.isGroup ? t('calls.incoming_group', { name: caller }) : t('calls.notify_body', { name: caller }), c.code);
},
_endIncomingCall(code, reason, callerName) {
  const r = this._callRings?.get(code);
  if (!r) return;
  clearInterval(r.tone);
  clearTimeout(r.timer);
  r.el.remove();
  this._callRings.delete(code);
  if (reason !== 'missed') return;
  const name = this._getNickname(r.call.callerId, callerName || r.call.callerName);
  this._showToast(t('calls.missed', { name }), 'info', { label: t('calls.call_back'), onClick: () => this._acceptCall(code) }, 8000);
  this._callNotify(t('calls.missed_title'), t('calls.missed', { name }), code);
},
async _acceptCall(code) {
  this._endIncomingCall(code, 'answered');
  this._closeDMPiP?.();
  await this.switchChannel(code);
  await this._joinVoice();
},
_declineCall(code) {
  this.socket.emit('dm-call-decline', { code });
  this._endIncomingCall(code, 'declined');
},
_labelCallButton() {
  const label = document.querySelector('#voice-join-btn span');
  if (!label) return;
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  label.textContent = ch?.is_dm ? t((this.voiceCounts?.[ch.code] || 0) > 0 ? 'calls.join' : 'calls.start') : t('voice.join');
},
};
