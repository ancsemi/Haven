// Voice in the app: joining and leaving, mute and deafen, keeping the voice
// buttons and status in step with the session, audio devices and the mic
// level meter. The WebRTC side lives in voice.js.

export default {

// ── Voice ─────────────────────────────────────────────

async _joinVoice() {
  if (!this.currentChannel) return;
  // Spam-click guard: while a join is already in-flight (waiting for mic
  // permissions, ICE config fetch, getUserMedia), repeated clicks used to
  // queue a fresh voice.join() per press. After a server restart, every
  // buffered click then fired against the freshly-reconnected socket and
  // produced a flood of "Joined voice chat" toasts plus duplicate
  // voice-join / voice-leave server events. The flag is cleared in a
  // finally block below regardless of outcome.
  if (this._joiningVoice) return;
  // If the socket is currently disconnected (e.g. user is mashing the
  // button during a server restart) refuse to start — emits would be
  // buffered by socket.io and replayed N times on reconnect, producing
  // the multi-toast / multi-join behaviour. The auto-rejoin code in the
  // 'connect' handler will re-join voice automatically once we're back.
  if (this.socket && this.socket.connected === false) {
    this._showToast(t('voice.disconnected'), 'error');
    return;
  }
  // Block voice join in text-only channels
  const _jvChk = this.channels.find(c => c.code === this.currentChannel);
  if (_jvChk && _jvChk.voice_enabled === 0) {
    this._showToast(t('voice.disabled'), 'error');
    return;
  }
  if (!this.user?.isAdmin && !this.user?.isGuest && !this._hasPerm('use_voice')) {
    this._showToast(t('voice.no_permission'), 'error');
    return;
  }
  if (this.user?.isGuest && this.serverSettings?.guests_allow_voice === 'false') {
    this._showToast(t('voice.guests_no_voice'), 'error');
    return;
  }
  this._joiningVoice = true;
  // Visually disable the join buttons while the async pipeline runs so a
  // human can't fire 15 of them. We restore disabled=false in finally.
  const _joinBtns = [
    document.getElementById('voice-join-btn'),
    document.getElementById('voice-join-mobile')
  ].filter(Boolean);
  _joinBtns.forEach(b => { b.disabled = true; });
  let success = false;
  try {
  // voice.join() auto-leaves old channel if connected
  success = await this.voice.join(this.currentChannel);
  if (success) {
    const joinedCode = this.currentChannel;
    const joinedUser = {
      id: this.user.id,
      username: this.user.displayName || this.user.username,
      roleColor: this.user.roleColor || null,
      isMuted: !!this.voice.isMuted,
      isDeafened: !!this.voice.isDeafened
    };

    this._renderVoiceUsers([joinedUser], joinedCode);
    this.voiceCounts[joinedCode] = Math.max(1, this.voiceCounts[joinedCode] || 0);
    this.voiceChannelUsers[joinedCode] = [
      joinedUser,
      ...(this.voiceChannelUsers[joinedCode] || []).filter(u => u.id !== joinedUser.id)
    ];
    this._updateChannelVoiceIndicators();

    this.notifications.playDirect('voice_join');
    this._updateVoiceButtons(true);
    this._syncMuteDeafenButtons();
    this._updateVoiceStatus(true);
    this._updateVoiceBar();
    // Server's broadcastVoiceUsers (fired on our voice-join) prunes stale
    // entries and emits both voice-users-update + voice-count-update, so
    // the right panel and sidebar reconcile authoritatively a tick later.
    // Don't emit get-voice-counts here — it can race the broadcast and
    // re-seed the sidebar with stale counts on older builds.
    this.socket.emit('request-voice-users', { code: joinedCode });
    // Disable stream/music buttons if the channel has them off
    const _jvCh = this.channels.find(c => c.code === this.currentChannel);
    const _ssBtn = document.getElementById('screen-share-btn');
    if (_ssBtn && _jvCh && _jvCh.streams_enabled === 0) {
      _ssBtn.disabled = true;
      _ssBtn.title = t('voice.streams_disabled');
    }
    const _camBtn = document.getElementById('voice-cam-btn');
    if (_camBtn && _jvCh && _jvCh.streams_enabled === 0) {
      _camBtn.disabled = true;
      _camBtn.title = t('voice.streams_disabled');
    }
    const _musicBtn = document.getElementById('voice-listen-together-btn');
    if (_musicBtn && _jvCh && _jvCh.music_enabled === 0) {
      _musicBtn.disabled = true;
      _musicBtn.title = t('voice.music_disabled');
    }
    this._showToast(t('voice.joined'), 'success');
  } else {
    this._showToast(t('voice.mic_error'), 'error');
  }
  } finally {
    this._joiningVoice = false;
    // _updateVoiceButtons(true) already hides the join buttons after a
    // successful join; restoring disabled=false here is for the failure
    // path where the button stays visible.
    _joinBtns.forEach(b => { b.disabled = false; });
  }
},

_leaveVoice() {
  // Capture the channel BEFORE voice.leave() nulls currentChannel so we
  // can immediately clear the right voice panel and sidebar count for it.
  // Don't wait for the server's voice-users-update broadcast — if we left
  // the voice room before the broadcast fires, it may not reach us, and
  // the panel would stay stuck showing us as a participant (#5347).
  const leftCode = this.voice && this.voice.currentChannel;
  this.voice.leave();
  this._mutedByDeafen = false;
  this.notifications.playDirect('voice_leave');
  this._updateVoiceButtons(false);
  this._updateVoiceStatus(false);
  this._updateVoiceBar();
  this._hideMusicPanel();
  // Optimistic local clear — mirrors the optimistic seed done in _joinVoice.
  if (leftCode) {
    delete this.voiceCounts[leftCode];
    delete this.voiceChannelUsers[leftCode];
    // Clear the right VOICE panel whenever it was bound to the channel we
    // just left — including the case where we're reading a different text
    // channel (DM etc.) while the panel was still showing the VC roster.
    if (this.currentChannel === leftCode || this._lastVoiceUsersChannel === leftCode) {
      this._renderVoiceUsers([], leftCode);
    }
    this._updateChannelVoiceIndicators();
  }
  this._showToast(t('voice.left'), 'info');
  // Close the soundboard panel/popup/modal — sounds can't route to VC
  // anymore, and the panel doubles as a 'you're in voice' affordance.
  this._closeSoundboardForVoiceLeave?.();
},

_toggleMute() {
  const wasMuted = this.voice.isMuted;
  if (wasMuted && this._mutedByDeafen) {
    // Mute was auto-applied by deafen — clear both together
    if (this.voice.isMuted) this.voice.toggleMute();
    if (this.voice.isDeafened) this.voice.toggleDeafen();
    this._mutedByDeafen = false;
    this.notifications.playDirect('mute_off');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: false });
      this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: false });
    }
  } else {
    const muted = this.voice.toggleMute();
    if (!muted) this._mutedByDeafen = false;
    this.notifications.playDirect(muted ? 'mute_on' : 'mute_off');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted });
    }
  }
  this._syncMuteDeafenButtons();
  this._updateVoiceBar();
},

_toggleDeafen() {
  const wasDeafened = this.voice.isDeafened;
  if (wasDeafened) {
    // Undeafening
    this.voice.toggleDeafen();
    if (this._mutedByDeafen) {
      if (this.voice.isMuted) this.voice.toggleMute();
      this._mutedByDeafen = false;
      if (this.voice.currentChannel) {
        this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: false });
      }
    }
    this.notifications.playDirect('deafen_off');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: false });
    }
  } else {
    // Deafening
    if (!this.voice.isMuted) {
      this.voice.toggleMute();
      this._mutedByDeafen = true;
      if (this.voice.currentChannel) {
        this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: true });
      }
    }
    this.voice.toggleDeafen();
    this.notifications.playDirect('deafen_on');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: true });
    }
  }
  this._syncMuteDeafenButtons();
  this._updateVoiceBar();
},

// ── Voice UI reconciler ──────────────────────────────────
//
// The voice UI is written imperatively by _updateVoiceButtons/_updateVoiceStatus/
// _updateVoiceBar from several unrelated call sites, and nothing ever recomputes
// it. If it is torn down while the session is actually alive — which is what
// produced "Haven shows Join Voice but I can still hear and talk to everyone" —
// the only way back is for the user to click Join Voice, which is a needless
// renegotiation of a session that never broke.
//
// Note that _updateVoiceButtons(false) also empties #screen-share-grid outright,
// which is why the stream vanished with no entry in the hidden-streams bar: the
// tiles were destroyed, not hidden. The audio elements live in #audio-container
// and are untouched, which is exactly why the stream's sound kept playing.
//
// This runs on a timer and on focus/resize and repairs whichever side is stale.
// IMPORTANT: this is UI-only. It must NEVER emit voice-rejoin / voice-leave.
// A previous revision did, and on window maximize that tore down live peers
// via voice-existing-users (no skipRenegotiate) — the "instant disconnect
// on first resize while streaming" bug.
_reconcileVoiceUi() {
  if (!this.voice) return;

  // Fix the bookkeeping first if the media session says we're still in voice.
  const repaired = this.voice.reassertSessionIfLive();

  const peersLive = (this.voice.liveVoicePeerCount?.() || 0) > 0;
  const micLive = !!(this.voice.localStream &&
    this.voice.localStream.getTracks().some(t => t.readyState === 'live'));
  const flagsInVoice = !!(this.voice.inVoice && this.voice.currentChannel);
  // Media truth wins. Never paint "Join Voice" while peers/mic are live.
  const sessionInVoice = flagsInVoice || peersLive || micLive;

  const joinBtn = document.getElementById('voice-join-btn');
  const joinVisible = !!joinBtn && joinBtn.style.display !== 'none';
  // Hidden on purpose (welcome screen, voice off, no permission) is not a
  // desync, so compare against what the channel allows (#5598).
  const joinExpected = this._voiceJoinAvailable();
  const bar = document.getElementById('voice-bar');
  const barShowsVoice = !!bar && bar.style.display !== 'none' && bar.style.display !== '';

  // Already consistent.
  if (!repaired && sessionInVoice && !joinVisible && barShowsVoice) return;
  if (!repaired && !sessionInVoice && joinVisible === joinExpected && !barShowsVoice) return;

  // Only repair UPWARD when media is live. Never tear UI down on a flaky
  // layout read during maximize — that wiped stream tiles.
  if (!sessionInVoice) {
    // Genuinely idle — leave UI alone unless it still shows connected chrome.
    if (!barShowsVoice && joinVisible === joinExpected) return;
    // Bar still says connected but media is dead: clear chrome.
    if (barShowsVoice || joinVisible !== joinExpected) {
      console.warn('[Voice] UI shows voice but media is dead — clearing chrome');
      this._updateVoiceButtons(false);
      this._updateVoiceStatus(false);
      this._updateVoiceBar();
    }
    return;
  }

  console.warn('[Voice] UI/session desync — repairing UI upward', {
    flagsInVoice, peersLive, micLive, joinVisible, barShowsVoice, repaired
  });

  this._updateVoiceButtons(true);
  this._updateVoiceStatus(true);
  this._updateVoiceBar();
  this._syncMuteDeafenButtons();

  // Restore stream tiles if a prior false-leave wiped them. No signalling.
  try {
    const restored = this.voice.reassertScreenStreams?.();
    if (restored) console.warn('[Voice] Restored', restored, 'stream tile(s) after UI desync');
  } catch (err) { console.warn('[Voice] reassertScreenStreams failed', err); }
},

_startVoiceUiReconciler() {
  if (this._voiceUiReconcilerBound) return;
  this._voiceUiReconcilerBound = true;
  // Debounce resize heavily: maximize fires a burst of events. We only
  // need to fix chrome after the layout settles — never mid-drag.
  let resizeTimer = null;
  const run = () => { try { this._reconcileVoiceUi(); } catch (e) { console.warn('[Voice] reconcile failed:', e); } };
  const runDebounced = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(run, 300);
  };
  window.addEventListener('focus', runDebounced);
  window.addEventListener('resize', runDebounced);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runDebounced(); });
  this._voiceUiReconcilerTimer = setInterval(run, 5000);
},

/** Update all mute/deafen button instances (sidebar + header) to reflect current state */
_syncMuteDeafenButtons() {
  const isMuted = this.voice.isMuted;
  const isDeafened = this.voice.isDeafened;
  ['voice-mute-btn', 'voice-mute-btn-header'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = '🎙️';
    btn.title = t(isMuted ? 'voice.unmute' : 'voice.mute');
    btn.classList.toggle('muted', isMuted);
  });
  ['voice-deafen-btn', 'voice-deafen-btn-header'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = isDeafened ? '🔇' : '🔊';
    btn.title = t(isDeafened ? 'voice.undeafen' : 'voice.deafen');
    btn.classList.toggle('muted', isDeafened);
  });
},

// Whether "Join Voice" makes sense right now: a channel is open, voice is
// on in it, and this user may use voice. The welcome screen, text-only
// channels and people without the permission get no button (#5598).
_voiceJoinAvailable() {
  if (!this.currentChannel) return false;
  const ch = this.channels && this.channels.find(c => c.code === this.currentChannel);
  if (ch && ch.voice_enabled === 0) return false;
  // Guests hold no roles, so voice for them is one server switch (#5687).
  if (this.user?.isGuest) return this.serverSettings?.guests_allow_voice !== 'false';
  return !!(this.user?.isAdmin || this._hasPerm('use_voice'));
},

_updateVoiceButtons(inVoice) {
  const showJoin = !inVoice && this._voiceJoinAvailable();
  document.getElementById('voice-join-btn').style.display = showJoin ? 'inline-flex' : 'none';
  // Show/hide the header voice-active indicator (not a button, just a label)
  const indicator = document.getElementById('voice-active-indicator');
  if (indicator) indicator.style.display = inVoice ? 'inline-flex' : 'none';

  // Show/hide the sidebar voice controls panel (pinned at bottom)
  const voicePanel = document.getElementById('voice-panel');
  if (voicePanel) voicePanel.style.display = inVoice ? 'flex' : 'none';

  const useSidebar = localStorage.getItem('haven_sidebar_voice_controls') === 'true';

  // Show/hide mute/deafen header buttons (voice panel — default location)
  const voiceHeaderMute = document.getElementById('voice-mute-btn-header');
  if (voiceHeaderMute) voiceHeaderMute.style.display = (inVoice && !useSidebar) ? '' : 'none';
  const voiceHeaderDeafen = document.getElementById('voice-deafen-btn-header');
  if (voiceHeaderDeafen) voiceHeaderDeafen.style.display = (inVoice && !useSidebar) ? '' : 'none';

  // Show/hide mute/deafen sidebar buttons (opt-in)
  const sidebarMute = document.getElementById('voice-mute-btn');
  if (sidebarMute) sidebarMute.style.display = (inVoice && useSidebar) ? '' : 'none';
  const sidebarDeafen = document.getElementById('voice-deafen-btn');
  if (sidebarDeafen) sidebarDeafen.style.display = (inVoice && useSidebar) ? '' : 'none';

  // Mobile voice join in right sidebar
  // NOTE: must use setProperty('display', ..., 'important') because the mobile CSS
  // rule .mobile-voice-join { display: flex !important; } would otherwise win and
  // keep the button visible while already in voice (#5387).
  const mobileJoin = document.getElementById('voice-join-mobile');
  if (mobileJoin) {
    if (showJoin) mobileJoin.style.removeProperty('display');
    else mobileJoin.style.setProperty('display', 'none', 'important');
  }

  if (!inVoice) {
    // Reset all mute/deafen buttons (sidebar + header)
    ['voice-mute-btn', 'voice-mute-btn-header'].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.textContent = '🎙️'; b.title = t('voice.mute'); b.classList.remove('muted'); }
    });
    ['voice-deafen-btn', 'voice-deafen-btn-header'].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.textContent = '🔊'; b.title = t('voice.deafen'); b.classList.remove('muted'); }
    });
    document.getElementById('screen-share-btn').textContent = '🖥️';
    document.getElementById('screen-share-btn').title = t('voice.screen_share');
    document.getElementById('screen-share-btn').classList.remove('sharing');
    document.getElementById('screen-share-btn').disabled = false;
    document.getElementById('voice-cam-btn').textContent = '📷';
    document.getElementById('voice-cam-btn').title = t('voice.panel.camera');
    document.getElementById('voice-cam-btn').classList.remove('sharing');
    document.getElementById('voice-cam-btn').disabled = false;
    const _ltnBtn = document.getElementById('voice-listen-together-btn');
    if (_ltnBtn) { _ltnBtn.disabled = false; _ltnBtn.title = t('voice.panel.listen_together'); }
    document.getElementById('voice-ns-slider').value = localStorage.getItem('haven_ns_value') || 10;
    // Hide voice settings sub-panel
    const vsPanel = document.getElementById('voice-settings-panel');
    if (vsPanel) vsPanel.style.display = 'none';
    const vsBtn = document.getElementById('voice-settings-toggle');
    if (vsBtn) vsBtn.classList.remove('active');

    // Only destroy stream/webcam tiles when media is actually dead.
    // A UI-only desync (maximize/resize flipping Join Voice on while
    // WebRTC is still carrying the stream) used to wipe the grid here —
    // audio kept playing with no tile and no way to restore without
    // leave/rejoin. If peers or screen receivers are still live, leave
    // the tiles alone; the reconciler will re-show the voice chrome.
    const mediaStillLive = !!(this.voice && (
      this.voice.inVoice ||
      (this.voice.liveVoicePeerCount?.() || 0) > 0 ||
      (this.voice.screenSharers && this.voice.screenSharers.size > 0) ||
      (this.voice.localStream && this.voice.localStream.getTracks().some(t => t.readyState === 'live'))
    ));
    if (!mediaStillLive) {
      const grid = document.getElementById('screen-share-grid');
      if (grid) {
        grid.querySelectorAll('video').forEach(v => { v.srcObject = null; });
        grid.innerHTML = '';
      }
      const ssContainer = document.getElementById('screen-share-container');
      if (ssContainer) ssContainer.style.display = 'none';
      const wcGrid = document.getElementById('webcam-grid');
      if (wcGrid) {
        wcGrid.querySelectorAll('video').forEach(v => { v.srcObject = null; });
        wcGrid.innerHTML = '';
      }
      const wcContainer = document.getElementById('webcam-container');
      if (wcContainer) wcContainer.style.display = 'none';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
      this._hideMusicPanel();
    } else {
      console.warn('[Voice] _updateVoiceButtons(false) skipped stream wipe — media still live');
    }
  }
},

_updateVoiceStatus(inVoice) {
  const led = document.getElementById('status-voice-led');
  const text = document.getElementById('status-voice-text');
  if (!led || !text) return;
  if (inVoice) {
    this._setLed('status-voice-led', 'on');
    text.textContent = t('voice.status_active');
  } else {
    this._setLed('status-voice-led', 'off');
    text.textContent = t('voice.status_off');
  }
},

_getVoiceChannelLabel() {
  if (!this.voice || !this.voice.currentChannel) return '';
  const ch = this.channels.find(c => c.code === this.voice.currentChannel);
  if (!ch) return this.voice.currentChannel;
  if (ch.is_dm && ch.dm_target) return `@ ${this._getNickname(ch.dm_target.id, ch.dm_target.username)}`;
  return `# ${ch.name}`;
},

_updateVoiceBar() {
  const bar = document.getElementById('voice-bar');
  if (!bar) return;
  if (this.voice && this.voice.inVoice && this.voice.currentChannel) {
    const badges = [];
    if (this.voice.isMuted) badges.push(`<span class="voice-bar-badge">${t('voice.status_muted')}</span>`);
    if (this.voice.isDeafened) badges.push(`<span class="voice-bar-badge">${t('voice.status_deafened')}</span>`);
    const channelName = this._getVoiceChannelLabel();
    bar.innerHTML = `
      <div class="voice-bar-top">
        <div class="voice-bar-status">
          <span class="voice-bar-icon" aria-hidden="true">🔊</span>
          <div class="voice-bar-status-copy">
            <span class="voice-bar-status-text">${t('voice.bar_connected')}</span>
            <span class="voice-bar-channel">${this._escapeHtml(channelName)}</span>
          </div>
        </div>
        <div class="voice-bar-actions">
          <button class="voice-bar-leave" id="voice-bar-leave-btn" title="${t('voice.disconnect')}">${t('voice.disconnect')}</button>
          ${badges.length ? `<div class="voice-bar-badges">${badges.join('')}</div>` : ''}
        </div>
      </div>
    `;
    bar.style.display = 'flex';
    document.getElementById('voice-bar-leave-btn').addEventListener('click', () => this._leaveVoice());
  } else {
    bar.innerHTML = '';
    bar.style.display = 'none';
  }
},

// ── Audio Device Enumeration ─────────────────────────────

async _populateAudioDevices() {
  const inputSelect  = document.getElementById('voice-input-device');
  const outputSelect = document.getElementById('voice-output-device');
  const camSelect    = document.getElementById('voice-cam-device');
  if (!inputSelect || !outputSelect) return;

  let devices = [];
  try {
    // Request a temp stream to ensure device labels are populated (browsers
    // hide labels until permission is granted at least once).
    let tempStream = null;
    const testDevices = await navigator.mediaDevices.enumerateDevices();
    const hasLabels = testDevices.some(d => d.label);
    if (!hasLabels) {
      try {
        tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch { /* microphone refused: devices are listed without names */ }
    }
    devices = await navigator.mediaDevices.enumerateDevices();
    if (tempStream) tempStream.getTracks().forEach(t => t.stop());
  } catch (err) {
    console.warn('[Haven] Could not enumerate audio devices:', err);
    return;
  }

  const inputs  = devices.filter(d => d.kind === 'audioinput');
  const outputs = devices.filter(d => d.kind === 'audiooutput');
  const cameras = devices.filter(d => d.kind === 'videoinput');

  const savedInput  = localStorage.getItem('haven_input_device') || '';
  const savedOutput = localStorage.getItem('haven_output_device') || '';
  const savedCam    = localStorage.getItem('haven_cam_device') || '';

  // Populate input
  inputSelect.innerHTML = `<option value="">${t('voice_settings.default_mic')}</option>`;
  for (const dev of inputs) {
    const label = dev.label || t('voice_settings.mic_fallback', { n: inputs.indexOf(dev) + 1 });
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = label;
    if (savedInput === dev.deviceId) opt.selected = true;
    inputSelect.appendChild(opt);
  }

  // Populate output
  outputSelect.innerHTML = `<option value="">${t('voice_settings.default_speaker')}</option>`;
  for (const dev of outputs) {
    const label = dev.label || t('voice_settings.speaker_fallback', { n: outputs.indexOf(dev) + 1 });
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = label;
    if (savedOutput === dev.deviceId) opt.selected = true;
    outputSelect.appendChild(opt);
  }

  // Browsers that don't implement HTMLMediaElement.setSinkId (notably
  // Firefox) can't switch audio output devices in JS. Disable the picker
  // and surface a hint so users aren't left confused. (#5295)
  const _supportsSinkId = typeof HTMLAudioElement !== 'undefined'
    && typeof HTMLAudioElement.prototype.setSinkId === 'function';
  if (!_supportsSinkId) {
    outputSelect.disabled = true;
    outputSelect.title = t('voice_settings.output_unsupported_title');
    const _hintId = 'voice-output-unsupported-hint';
    if (!document.getElementById(_hintId) && outputSelect.parentElement) {
      const hint = document.createElement('small');
      hint.id = _hintId;
      hint.className = 'settings-hint';
      hint.style.cssText = 'display:block;margin-top:4px;opacity:0.85';
      hint.textContent = t('voice_settings.output_unsupported_hint');
      outputSelect.parentElement.appendChild(hint);
    }
  }

  // Populate camera
  if (camSelect) {
    camSelect.innerHTML = `<option value="">${t('voice_settings.default_camera')}</option>`;
    for (const dev of cameras) {
      const label = dev.label || t('voice_settings.camera_fallback', { n: cameras.indexOf(dev) + 1 });
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = label;
      if (savedCam === dev.deviceId) opt.selected = true;
      camSelect.appendChild(opt);
    }
  }
},

// ── Mic Level Meter ──────────────────────────────────────

// (#5456) This used to start a requestAnimationFrame loop at app startup and
// never stop it, so every client ran a frame loop for its entire session even
// though the meter lives inside the settings modal and is off screen almost
// all of the time. A permanently scheduled rAF keeps the renderer asking the
// compositor for a new frame on every vsync, which is why an audio-only call
// could sit there burning CPU on Rendering/Painting and keeping the GPU busy
// with nothing on screen that moves. Now the loop only runs while the meter is
// actually visible, and it only touches the DOM when the value really changed.
_startMicMeter() {
  const fill = this._micMeterFill;
  if (!fill) return;

  if (typeof IntersectionObserver === 'function') {
    if (this._micMeterObserver) return;
    this._micMeterObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) this._runMicMeter();
      else this._stopMicMeter();
    });
    this._micMeterObserver.observe(fill);
    return;
  }
  this._runMicMeter();
},

_runMicMeter() {
  if (this._micMeterRAF) return;
  const fill = this._micMeterFill;
  if (!fill) return;

  let lastWidth = null;
  const tick = () => {
    const level = (this.voice && this.voice.inVoice) ? this.voice.currentMicLevel : 0;
    // Whole percents only — the bar is a few hundred pixels wide, so finer
    // steps cost a layout + paint per frame and change nothing visually.
    const width = Math.round(level) + '%';
    if (width !== lastWidth) {
      fill.style.width = width;
      lastWidth = width;
    }
    this._micMeterRAF = requestAnimationFrame(tick);
  };
  this._micMeterRAF = requestAnimationFrame(tick);
},

_stopMicMeter() {
  if (this._micMeterRAF) {
    cancelAnimationFrame(this._micMeterRAF);
    this._micMeterRAF = null;
  }
  if (this._micMeterFill) this._micMeterFill.style.width = '0%';
},

_updateMicMeterThreshold(sensitivity) {
  // Map sensitivity 0-100 to threshold position
  // Same mapping as voice.js: threshold = 2 + (sensitivity/100)*38 → range 2-40
  // Meter is 0-100 which maps to avg 0-50, so threshold of N → (N/50)*100 percent
  if (!this._micMeterThreshold) return;
  if (sensitivity === 0) {
    this._micMeterThreshold.style.display = 'none';
    return;
  }
  const threshold = 2 + (sensitivity / 100) * 38;
  const percent = (threshold / 50) * 100;
  this._micMeterThreshold.style.display = '';
  this._micMeterThreshold.style.left = percent + '%';
},

};
