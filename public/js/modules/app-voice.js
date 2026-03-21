export default {

// ── Voice ─────────────────────────────────────────────

async _joinVoice() {
  if (!this.currentChannel) return;
  // Block voice join in text-only channels
  const _jvChk = this.channels.find(c => c.code === this.currentChannel);
  if (_jvChk && _jvChk.voice_enabled === 0) {
    this._showToast('Voice is disabled in this channel', 'error');
    return;
  }
  // voice.join() auto-leaves old channel if connected
  const success = await this.voice.join(this.currentChannel);
  if (success) {
    this.notifications.playDirect('voice_join');
    this._updateVoiceButtons(true);
    this._updateVoiceStatus(true);
    this._updateVoiceBar();
    // Disable stream/music buttons if the channel has them off
    const _jvCh = this.channels.find(c => c.code === this.currentChannel);
    const _ssBtn = document.getElementById('screen-share-btn');
    if (_ssBtn && _jvCh && _jvCh.streams_enabled === 0) {
      _ssBtn.disabled = true;
      _ssBtn.title = 'Streams are disabled in this channel';
    }
    const _camBtn = document.getElementById('voice-cam-btn');
    if (_camBtn && _jvCh && _jvCh.streams_enabled === 0) {
      _camBtn.disabled = true;
      _camBtn.title = 'Streams are disabled in this channel';
    }
    const _musicBtn = document.getElementById('voice-listen-together-btn');
    if (_musicBtn && _jvCh && _jvCh.music_enabled === 0) {
      _musicBtn.disabled = true;
      _musicBtn.title = 'Music is disabled in this channel';
    }
    this._showToast('Joined voice chat', 'success');
  } else {
    this._showToast('Could not access microphone. Check permissions or use HTTPS.', 'error');
  }
},

_leaveVoice() {
  this.voice.leave();
  this._mutedByDeafen = false;
  this.notifications.playDirect('voice_leave');
  this._updateVoiceButtons(false);
  this._updateVoiceStatus(false);
  this._updateVoiceBar();
  this._hideMusicPanel();
  this._showToast('Left voice chat', 'info');
},

_toggleMute() {
  const wasMuted = this.voice.isMuted;
  if (wasMuted && this._mutedByDeafen) {
    // Mute was auto-applied by deafen — clear both together
    if (this.voice.isMuted) this.voice.toggleMute();
    if (this.voice.isDeafened) this.voice.toggleDeafen();
    this._mutedByDeafen = false;
    const muteBtn = document.getElementById('voice-mute-btn');
    muteBtn.textContent = '🎙️';
    muteBtn.title = 'Mute';
    muteBtn.classList.remove('muted');
    const deafBtn = document.getElementById('voice-deafen-btn');
    deafBtn.textContent = '🔊';
    deafBtn.title = 'Deafen';
    deafBtn.classList.remove('muted');
    this.notifications.playDirect('mute_off');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: false });
      this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: false });
    }
  } else {
    const muted = this.voice.toggleMute();
    if (!muted) this._mutedByDeafen = false;
    const btn = document.getElementById('voice-mute-btn');
    btn.textContent = '🎙️';
    btn.title = muted ? 'Unmute' : 'Mute';
    btn.classList.toggle('muted', muted);
    this.notifications.playDirect(muted ? 'mute_on' : 'mute_off');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted });
    }
  }
  this._updateVoiceBar();
},

_toggleDeafen() {
  const wasDeafened = this.voice.isDeafened;
  if (wasDeafened) {
    // Undeafening
    this.voice.toggleDeafen();
    if (this._mutedByDeafen) {
      // Auto-mute was applied when deafening — remove it too
      if (this.voice.isMuted) this.voice.toggleMute();
      this._mutedByDeafen = false;
      const muteBtn = document.getElementById('voice-mute-btn');
      muteBtn.textContent = '🎙️';
      muteBtn.title = 'Mute';
      muteBtn.classList.remove('muted');
      if (this.voice.currentChannel) {
        this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: false });
      }
    }
    const btn = document.getElementById('voice-deafen-btn');
    btn.textContent = '🔊';
    btn.title = 'Deafen';
    btn.classList.remove('muted');
    this.notifications.playDirect('deafen_off');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: false });
    }
  } else {
    // Deafening
    if (!this.voice.isMuted) {
      // Auto-mute and remember it was caused by deafen
      this.voice.toggleMute();
      this._mutedByDeafen = true;
      const muteBtn = document.getElementById('voice-mute-btn');
      muteBtn.textContent = '🎙️';
      muteBtn.title = 'Unmute';
      muteBtn.classList.add('muted');
      if (this.voice.currentChannel) {
        this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: true });
      }
    }
    this.voice.toggleDeafen();
    const btn = document.getElementById('voice-deafen-btn');
    btn.textContent = '�';
    btn.title = 'Undeafen';
    btn.classList.add('muted');
    this.notifications.playDirect('deafen_on');
    if (this.voice.currentChannel) {
      this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: true });
    }
  }
  this._updateVoiceBar();
},

_updateVoiceButtons(inVoice) {
  document.getElementById('voice-join-btn').style.display = inVoice ? 'none' : 'inline-flex';
  // Show/hide the header voice-active indicator (not a button, just a label)
  const indicator = document.getElementById('voice-active-indicator');
  if (indicator) indicator.style.display = inVoice ? 'inline-flex' : 'none';

  // Show/hide the sidebar voice controls panel (pinned at bottom)
  const voicePanel = document.getElementById('voice-panel');
  if (voicePanel) voicePanel.style.display = inVoice ? 'flex' : 'none';

  // Show/hide mute/deafen header buttons
  const voiceHeaderMute = document.getElementById('voice-mute-btn');
  if (voiceHeaderMute) voiceHeaderMute.style.display = inVoice ? '' : 'none';
  const voiceHeaderDeafen = document.getElementById('voice-deafen-btn');
  if (voiceHeaderDeafen) voiceHeaderDeafen.style.display = inVoice ? '' : 'none';

  // Mobile voice join in right sidebar
  const mobileJoin = document.getElementById('voice-join-mobile');
  if (mobileJoin) mobileJoin.style.display = inVoice ? 'none' : '';

  if (!inVoice) {
    document.getElementById('voice-mute-btn').textContent = '🎙️';
    document.getElementById('voice-mute-btn').title = 'Mute';
    document.getElementById('voice-mute-btn').classList.remove('muted');
    document.getElementById('voice-deafen-btn').textContent = '🔊';
    document.getElementById('voice-deafen-btn').title = 'Deafen';
    document.getElementById('voice-deafen-btn').classList.remove('muted');
    document.getElementById('screen-share-btn').textContent = '🖥️';
    document.getElementById('screen-share-btn').title = 'Share Screen';
    document.getElementById('screen-share-btn').classList.remove('sharing');
    document.getElementById('screen-share-btn').disabled = false;
    document.getElementById('voice-cam-btn').textContent = '📷';
    document.getElementById('voice-cam-btn').title = 'Camera';
    document.getElementById('voice-cam-btn').classList.remove('sharing');
    document.getElementById('voice-cam-btn').disabled = false;
    const _ltnBtn = document.getElementById('voice-listen-together-btn');
    if (_ltnBtn) { _ltnBtn.disabled = false; _ltnBtn.title = 'Listen Together'; }
    document.getElementById('voice-ns-slider').value = 10;
    // Hide voice settings sub-panel
    const vsPanel = document.getElementById('voice-settings-panel');
    if (vsPanel) vsPanel.style.display = 'none';
    const vsBtn = document.getElementById('voice-settings-toggle');
    if (vsBtn) vsBtn.classList.remove('active');
    // Clear all stream tiles so no ghost tiles persist after leaving voice
    const grid = document.getElementById('screen-share-grid');
    grid.querySelectorAll('video').forEach(v => { v.srcObject = null; });
    grid.innerHTML = '';
    document.getElementById('screen-share-container').style.display = 'none';
    // Clear all webcam tiles
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
  }
},

_updateVoiceStatus(inVoice) {
  const led = document.getElementById('status-voice-led');
  const text = document.getElementById('status-voice-text');
  if (!led || !text) return;
  if (inVoice) {
    this._setLed('status-voice-led', 'on');
    text.textContent = 'Active';
  } else {
    this._setLed('status-voice-led', 'off');
    text.textContent = 'Off';
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
    if (this.voice.isMuted) badges.push('<span class="voice-bar-badge">Muted</span>');
    if (this.voice.isDeafened) badges.push('<span class="voice-bar-badge">Deafened</span>');
    const channelName = this._getVoiceChannelLabel();
    bar.innerHTML = `
      <div class="voice-bar-top">
        <div class="voice-bar-status">
          <span class="voice-bar-icon" aria-hidden="true">🔊</span>
          <div class="voice-bar-status-copy">
            <span class="voice-bar-status-text">Voice Connected</span>
            <span class="voice-bar-channel">${this._escapeHtml(channelName)}</span>
          </div>
        </div>
        <div class="voice-bar-actions">
          <button class="voice-bar-leave" id="voice-bar-leave-btn" title="Disconnect">Disconnect</button>
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

// NS slider is handled directly via the input event listener in _setupUI

// ── Screen Share ──────────────────────────────────────

async _toggleScreenShare() {
  if (!this.voice.inVoice) return;

  // Block screen share if streams are disabled in this channel
  const _ssCh = this.channels.find(c => c.code === this.voice.currentChannel);
  if (_ssCh && _ssCh.streams_enabled === 0) {
    this._showToast('Streams are disabled in this channel', 'error');
    return;
  }

  if (this.voice.isScreenSharing) {
    await this.voice.stopScreenShare();
    document.getElementById('screen-share-btn').textContent = '🖥️';
    document.getElementById('screen-share-btn').title = 'Share Screen';
    document.getElementById('screen-share-btn').classList.remove('sharing');
    this._showToast('Stopped screen sharing', 'info');
  } else {
    const ok = await this.voice.shareScreen();
    if (ok) {
      document.getElementById('screen-share-btn').textContent = '🛑';
      document.getElementById('screen-share-btn').title = 'Stop Sharing';
      document.getElementById('screen-share-btn').classList.add('sharing');
      // Show our own screen in the viewer
      this._handleScreenStream(this.user.id, this.voice.screenStream);
      // Show audio/no-audio badge
      if (this.voice.screenHasAudio) {
        this._handleScreenAudio(this.user.id);
        this._showToast('Screen sharing started with audio', 'success');
      } else {
        this._handleScreenNoAudio(this.user.id);
        this._showToast('Screen sharing started (no audio — enable it in the browser picker)', 'info');
      }
    } else {
      this._showToast('Screen share cancelled or not supported', 'error');
    }
  }
},

async _toggleWebcam() {
  if (!this.voice.inVoice) return;

  const btn = document.getElementById('voice-cam-btn');
  if (this.voice.isWebcamActive) {
    await this.voice.stopWebcam();
    btn.textContent = '📷';
    btn.title = 'Camera';
    btn.classList.remove('sharing');
    this._handleWebcamStream(this.user.id, null);
    this._showToast('Camera stopped', 'info');
  } else {
    const ok = await this.voice.startWebcam();
    if (ok) {
      btn.textContent = '🛑';
      btn.title = 'Stop Camera';
      btn.classList.add('sharing');
      this._handleWebcamStream(this.user.id, this.voice.webcamStream);
      this._showToast('Camera started', 'success');
    } else {
      this._showToast('Camera unavailable or permission denied', 'error');
    }
  }
},

_handleWebcamStream(userId, stream) {
  const container = document.getElementById('webcam-container');
  const grid = document.getElementById('webcam-grid');
  const label = document.getElementById('webcam-label');

  if (stream) {
    const tileId = `webcam-tile-${userId || 'self'}`;
    let tile = document.getElementById(tileId);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = tileId;
      tile.className = 'webcam-tile';

      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = (userId === this.user.id); // mute own cam to avoid echo
      // Mirror own camera (like a mirror), but show others normally
      if (userId === this.user.id) {
        vid.style.transform = 'scaleX(-1)';
      }
      tile.appendChild(vid);

      const lbl = document.createElement('div');
      lbl.className = 'webcam-tile-label';
      const peer = this.voice.peers.get(userId);
      const who = (userId === null || userId === this.user.id) ? 'You' : (peer ? peer.username : 'Someone');
      lbl.textContent = who;
      tile.appendChild(lbl);

      // Double-click to toggle focus mode (expand tile full-size)
      tile.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this._toggleWebcamFocus(tile);
      });

      // Pop-out button (PiP)
      const popoutBtn = document.createElement('button');
      popoutBtn.className = 'stream-popout-btn';
      popoutBtn.title = 'Pop out camera';
      popoutBtn.textContent = '⧉';
      popoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._popOutWebcam(tile, userId);
      });
      tile.appendChild(popoutBtn);

      // Fullscreen button
      const fsBtnWC = document.createElement('button');
      fsBtnWC.className = 'stream-fullscreen-btn';
      fsBtnWC.title = 'Fullscreen';
      fsBtnWC.textContent = '⛶';
      fsBtnWC.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = tile.querySelector('video');
        const target = vid || tile;
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => {});
        }
      });
      tile.appendChild(fsBtnWC);

      // Minimize button — collapses tile but keeps in grid
      const minBtn = document.createElement('button');
      minBtn.className = 'stream-minimize-btn';
      minBtn.title = 'Minimize';
      minBtn.textContent = '─';
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tile.classList.toggle('webcam-minimized');
        const vidEl = tile.querySelector('video');
        if (tile.classList.contains('webcam-minimized')) {
          vidEl.style.display = 'none';
          tile.style.height = '28px';
          tile.style.minHeight = '0';
        } else {
          vidEl.style.display = '';
          tile.style.height = '';
          tile.style.minHeight = '';
        }
      });
      tile.appendChild(minBtn);

      // Close button — removes tile entirely
      const closeBtn = document.createElement('button');
      closeBtn.className = 'stream-close-btn';
      closeBtn.title = 'Close camera';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vidEl = tile.querySelector('video');
        if (vidEl) vidEl.srcObject = null;
        tile.remove();
        this._updateWebcamVisibility();

        // If this is our own camera tile, stop the actual stream and reset
        // the camera button state so it doesn't still appear active.
        if (userId === this.user.id) {
          this.voice.stopWebcam();
          const btn = document.getElementById('webcam-toggle');
          if (btn) {
            btn.textContent = '📷';
            btn.title = 'Camera';
            btn.classList.remove('sharing');
          }
        }
      });
      tile.appendChild(closeBtn);

      grid.appendChild(tile);
    }

    container.style.display = 'flex';

    const videoEl = tile.querySelector('video');
    if (videoEl.srcObject === stream) videoEl.srcObject = null;
    videoEl.srcObject = stream;
    videoEl.play().catch(() => {});
    videoEl.onloadedmetadata = () => { videoEl.play().catch(() => {}); };

    // Retry playback for late-arriving tracks
    let _retries = 0;
    const _retryPlay = () => {
      if (!videoEl.srcObject || _retries > 15) return;
      if (videoEl.videoWidth === 0) {
        _retries++;
        if (_retries % 5 === 0) {
          const s = videoEl.srcObject;
          videoEl.srcObject = null;
          videoEl.srcObject = s;
        }
        videoEl.play().catch(() => {});
        setTimeout(_retryPlay, 500);
      }
    };
    setTimeout(_retryPlay, 600);

    // Apply saved webcam size
    const savedSize = localStorage.getItem('haven_webcam_size');
    if (savedSize) {
      const vh = parseInt(savedSize, 10);
      container.style.maxHeight = vh + 'vh';
      grid.style.maxHeight = (vh - 2) + 'vh';
      const tileMaxW = Math.max(vh * 1.33, 15);
      document.querySelectorAll('.webcam-tile').forEach(t => { t.style.maxWidth = tileMaxW + 'vw'; });
      document.querySelectorAll('.webcam-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
    }

    this._updateWebcamVisibility();
  } else {
    // Stream ended — remove tile
    const tileId = `webcam-tile-${userId || 'self'}`;
    const tile = document.getElementById(tileId);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = null;
      tile.remove();
    }
    // Reset own button if our cam ended externally
    if (userId === this.user.id || userId === 'self') {
      const btn = document.getElementById('voice-cam-btn');
      if (btn) {
        btn.textContent = '📷';
        btn.title = 'Camera';
        btn.classList.remove('sharing');
      }
    }
    // Close any PiP overlay for this user
    const pipEl = document.getElementById(`webcam-pip-${userId || 'self'}`);
    if (pipEl) pipEl.remove();

    this._updateWebcamVisibility();
  }
},

_updateWebcamVisibility() {
  const container = document.getElementById('webcam-container');
  const grid = document.getElementById('webcam-grid');
  const label = document.getElementById('webcam-label');
  const count = grid.children.length;
  if (count === 0) {
    container.style.display = 'none';
    container.classList.remove('webcam-focus-mode');
    this._removeWebcamIndicator();
  } else {
    label.textContent = `📷 ${count} camera${count !== 1 ? 's' : ''}`;
  }
},

_showWebcamIndicator(count) {
  let ind = document.getElementById('webcam-indicator');
  if (!ind) {
    ind = document.createElement('button');
    ind.id = 'webcam-indicator';
    ind.className = 'screen-share-indicator'; // reuse same styling
    ind.addEventListener('click', () => {
      const container = document.getElementById('webcam-container');
      if (container) {
        container.style.display = 'flex';
        // Exit focus mode if it was active
        container.classList.remove('webcam-focus-mode');
        const grid = document.getElementById('webcam-grid');
        if (grid) grid.querySelectorAll('.webcam-tile').forEach(t => t.classList.remove('webcam-focused'));
        // Re-apply saved size
        const saved = localStorage.getItem('haven_webcam_size') || '25';
        const vh = parseInt(saved, 10);
        container.style.maxHeight = vh + 'vh';
        grid.style.maxHeight = (vh - 2) + 'vh';
        const tileMaxW = Math.max(vh * 1.33, 15);
        document.querySelectorAll('.webcam-tile').forEach(t => { t.style.maxWidth = tileMaxW + 'vw'; });
        document.querySelectorAll('.webcam-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
      }
      ind.remove();
    });
    document.querySelector('.channel-header')?.appendChild(ind);
  }
  ind.textContent = `📷 ${count} camera${count > 1 ? 's' : ''} hidden`;
},

_removeWebcamIndicator() {
  document.getElementById('webcam-indicator')?.remove();
},

_closeWebcam() {
  // If user is actively sharing their webcam, stop it
  if (this.voice && this.voice.isWebcamActive) {
    this._toggleWebcam();
  }
  const container = document.getElementById('webcam-container');
  const grid = document.getElementById('webcam-grid');
  // Remove all tiles
  if (grid) {
    grid.querySelectorAll('.webcam-tile').forEach(t => {
      const vid = t.querySelector('video');
      if (vid) vid.srcObject = null;
      t.remove();
    });
  }
  // Remove any PiP overlays
  document.querySelectorAll('.webcam-pip-overlay').forEach(p => p.remove());
  container.style.display = 'none';
  container.classList.remove('webcam-focus-mode');
  this._removeWebcamIndicator();
},

_toggleWebcamFocus(tile) {
  const container = document.getElementById('webcam-container');
  const grid = document.getElementById('webcam-grid');
  const wasFocused = tile.classList.contains('webcam-focused');

  // Don't allow focus on minimized tiles
  if (tile.classList.contains('webcam-minimized')) return;

  // Remove focus from all tiles first
  grid.querySelectorAll('.webcam-tile').forEach(t => t.classList.remove('webcam-focused'));
  container.classList.remove('webcam-focus-mode');

  if (!wasFocused) {
    tile.classList.add('webcam-focused');
    container.classList.add('webcam-focus-mode');
    // Clear ALL inline size constraints so pure CSS focus mode takes over
    container.style.maxHeight = '';
    container.style.minHeight = '';
    grid.style.maxHeight = '';
    tile.style.maxWidth = '';
    const vid = tile.querySelector('video');
    if (vid) vid.style.maxHeight = '';
  } else {
    // Restore slider-based size
    const saved = localStorage.getItem('haven_webcam_size') || '25';
    const vh = parseInt(saved, 10);
    container.style.maxHeight = vh + 'vh';
    grid.style.maxHeight = (vh - 2) + 'vh';
    const tileMaxW = Math.max(vh * 1.33, 15);
    document.querySelectorAll('.webcam-tile').forEach(t => { t.style.maxWidth = tileMaxW + 'vw'; });
    document.querySelectorAll('.webcam-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
  }
},

_popOutWebcam(tile, userId) {
  const video = tile.querySelector('video');
  if (!video || !video.srcObject) return;

  // If already in PiP, exit it
  if (document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }

  if (tile.classList.contains('webcam-popped-out')) return;

  // Try native Picture-in-Picture first
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    video.requestPictureInPicture().then(() => {
      const popoutBtn = tile.querySelector('.stream-popout-btn');
      if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = 'Pop in camera'; }
      tile.classList.add('webcam-popped-out');

      video.addEventListener('leavepictureinpicture', () => {
        if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out camera'; }
        tile.classList.remove('webcam-popped-out');
      }, { once: true });
    }).catch(() => {
      this._popOutWebcamOverlay(tile, userId);
    });
  } else {
    this._popOutWebcamOverlay(tile, userId);
  }
},

_popOutWebcamOverlay(tile, userId) {
  const video = tile.querySelector('video');
  if (!video || !video.srcObject) return;

  const stream = video.srcObject;
  const peer = this.voice.peers.get(userId);
  const who = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Camera');

  const pipId = `webcam-pip-${userId || 'self'}`;
  if (document.getElementById(pipId)) return;

  const savedOpacity = parseInt(localStorage.getItem('haven_pip_opacity') ?? '100');
  const pip = document.createElement('div');
  pip.id = pipId;
  pip.className = 'music-pip-overlay webcam-pip-overlay';
  pip.style.opacity = savedOpacity / 100;

  pip.innerHTML = `
    <div class="music-pip-embed stream-pip-video"></div>
    <div class="music-pip-controls">
      <button class="music-pip-btn stream-pip-popin" title="Pop back in">⧈</button>
      <span class="music-pip-label">📷 ${who}</span>
      <span class="music-pip-vol-icon" title="Window opacity">👁</span>
      <input type="range" class="music-pip-vol pip-opacity-slider" min="20" max="100" value="${savedOpacity}">
      <button class="music-pip-btn stream-pip-fullscreen" title="Fullscreen">⤢</button>
      <button class="music-pip-btn stream-pip-close" title="Close">✕</button>
    </div>
  `;

  document.body.appendChild(pip);

  const pipVideo = document.createElement('video');
  pipVideo.autoplay = true;
  pipVideo.playsInline = true;
  pipVideo.muted = true;
  pipVideo.srcObject = stream;
  const mirrorCss = (userId === this.user.id) ? 'transform:scaleX(-1);' : '';
  pipVideo.style.cssText = `width:100%;height:100%;object-fit:cover;display:block;${mirrorCss}`;
  pip.querySelector('.stream-pip-video').appendChild(pipVideo);
  pipVideo.play().catch(() => {});

  const popoutBtn = tile.querySelector('.stream-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = 'Pop in camera'; }
  tile.classList.add('webcam-popped-out');

  const popIn = () => {
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out camera'; }
    tile.classList.remove('webcam-popped-out');
  };

  const closePip = () => {
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out camera'; }
    tile.classList.remove('webcam-popped-out');
  };

  pip.querySelector('.stream-pip-popin').addEventListener('click', popIn);
  pip.querySelector('.stream-pip-close').addEventListener('click', closePip);
  pip.querySelector('.stream-pip-fullscreen').addEventListener('click', (e) => {
    e.stopPropagation();
    const vid = pip.querySelector('video');
    const target = vid || pip;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => {});
    }
  });

  pip.querySelector('.pip-opacity-slider').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    pip.style.opacity = val / 100;
    localStorage.setItem('haven_pip_opacity', val);
  });

  this._initPipDrag(pip, pip);

  const streamTrack = stream.getVideoTracks()[0];
  if (streamTrack) {
    const prevOnEnded = streamTrack.onended;
    streamTrack.onended = () => {
      if (prevOnEnded) prevOnEnded();
      popIn();
    };
  }
},

_handleScreenStream(userId, stream, { force = false } = {}) {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  const label = document.getElementById('screen-share-label');

  if (stream) {
    // Honour auto-accept setting — show a join prompt instead of opening the tile automatically
    const autoAccept = force || localStorage.getItem('haven_auto_accept_streams') !== 'false';
    if (!autoAccept && userId !== null && userId !== this.user.id) {
      const peer = this.voice.peers.get(userId);
      const who = peer ? peer.username : 'Someone';
      this._showToast(`${this._escapeHtml(who)} started sharing their screen`, 'info', {
        label: 'Join',
        onClick: () => this._handleScreenStream(userId, stream, { force: true })
      }, 8000);
      return;
    }

    // Create a tile for this user's stream
    const tileId = `screen-tile-${userId || 'self'}`;
    let tile = document.getElementById(tileId);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = tileId;
      tile.className = 'screen-share-tile';

      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true; // Always mute — screen audio routes through WebRTC audio track
      tile.appendChild(vid);

      const lbl = document.createElement('div');
      lbl.className = 'screen-share-tile-label';
      const peer = this.voice.peers.get(userId);
      const who = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Someone');
      lbl.textContent = who;
      tile.appendChild(lbl);

      // Audio controls overlay (volume + mute for stream audio)
      const controls = document.createElement('div');
      controls.className = 'stream-audio-controls';
      controls.id = `stream-controls-${userId || 'self'}`;

      const muteBtn = document.createElement('button');
      muteBtn.className = 'stream-mute-btn';
      muteBtn.title = 'Mute/Unmute stream audio';
      muteBtn.textContent = '🔊';
      muteBtn.dataset.muted = 'false';

      const volSlider = document.createElement('input');
      volSlider.type = 'range';
      volSlider.className = 'stream-vol-slider';
      volSlider.min = '0';
      volSlider.max = '200';
      volSlider.title = 'Stream volume (0–200%)';

      const volPct = document.createElement('span');
      volPct.className = 'stream-vol-pct';

      // Restore saved volume
      try {
        const savedVols = JSON.parse(localStorage.getItem('haven_stream_volumes') || '{}');
        const sv = savedVols[userId] ?? 100;
        volSlider.value = String(sv);
        volPct.textContent = sv + '%';
      } catch { volSlider.value = '100'; volPct.textContent = '100%'; }

      muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMuted = muteBtn.dataset.muted === 'true';
        if (isMuted) {
          const vol = parseFloat(volSlider.value) / 100;
          this.voice.setStreamVolume(userId, vol);
          muteBtn.textContent = '🔊';
          muteBtn.dataset.muted = 'false';
          muteBtn.classList.remove('muted');
        } else {
          this.voice.setStreamVolume(userId, 0);
          muteBtn.textContent = '🔇';
          muteBtn.dataset.muted = 'true';
          muteBtn.classList.add('muted');
        }
      });

      volSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = parseInt(volSlider.value);
        this.voice.setStreamVolume(userId, val / 100);
        volPct.textContent = val + '%';
        muteBtn.textContent = val === 0 ? '🔇' : '🔊';
        muteBtn.dataset.muted = val === 0 ? 'true' : 'false';
        muteBtn.classList.toggle('muted', val === 0);
        try {
          const vols = JSON.parse(localStorage.getItem('haven_stream_volumes') || '{}');
          vols[userId] = val;
          localStorage.setItem('haven_stream_volumes', JSON.stringify(vols));
        } catch {}
      });

      controls.appendChild(muteBtn);
      controls.appendChild(volSlider);
      controls.appendChild(volPct);
      tile.appendChild(controls);

      // Double-click to toggle focus mode (expand tile to fill chat area)
      tile.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this._toggleStreamFocus(tile);
      });

      // Pop-out button
      const popoutBtn = document.createElement('button');
      popoutBtn.className = 'stream-popout-btn';
      popoutBtn.title = 'Pop out stream';
      popoutBtn.textContent = '⧉';
      popoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._popOutStream(tile, userId);
      });
      tile.appendChild(popoutBtn);

      // Fullscreen button — makes the video element fill the screen
      const fsBtn = document.createElement('button');
      fsBtn.className = 'stream-fullscreen-btn';
      fsBtn.title = 'Fullscreen';
      fsBtn.textContent = '⛶';
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = tile.querySelector('video');
        const target = vid || tile;
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => {});
        }
      });
      tile.appendChild(fsBtn);

      // Minimize button — hides tile but KEEPS audio playing
      const minBtn = document.createElement('button');
      minBtn.className = 'stream-minimize-btn';
      minBtn.title = 'Minimize (keep audio)';
      minBtn.textContent = '─';
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideStreamTile(tile, userId, who, false);
      });
      tile.appendChild(minBtn);

      // Close button — hides tile and mutes its audio (can be restored from hidden bar)
      const closeBtn = document.createElement('button');
      closeBtn.className = 'stream-close-btn';
      closeBtn.title = 'Close (stop audio)';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideStreamTile(tile, userId, who, true);
      });
      tile.appendChild(closeBtn);

      grid.appendChild(tile);
    }

    // Show the container BEFORE assigning srcObject — browsers won't decode
    // video frames inside a display:none container, causing a black rectangle
    // that only fixes itself on layout reflow (e.g. resizing the slider).
    container.style.display = 'flex';

    const videoEl = tile.querySelector('video');
    // Force a layout reflow so the video element has real dimensions
    void videoEl.offsetHeight;
    // Force re-render if the same stream is re-assigned (otherwise it's a no-op → black screen)
    if (videoEl.srcObject === stream) {
      videoEl.srcObject = null;
    }
    videoEl.srcObject = stream;
    videoEl.play().catch(() => {});
    // Also re-play when metadata loads (handles late-arriving tracks)
    videoEl.onloadedmetadata = () => { videoEl.play().catch(() => {}); };

    // WebRTC video tracks often arrive muted (no frames yet). Retry playback
    // until the video actually has dimensions, which means frames are flowing.
    let _retries = 0;
    const _retryPlay = () => {
      if (!videoEl.srcObject || _retries > 20) return;
      if (videoEl.videoWidth === 0) {
        _retries++;
        // Re-trigger srcObject assignment to prod the decoder
        if (_retries % 5 === 0) {
          const s = videoEl.srcObject;
          videoEl.srcObject = null;
          videoEl.srcObject = s;
        }
        videoEl.play().catch(() => {});
        setTimeout(_retryPlay, 500);
      }
    };
    setTimeout(_retryPlay, 600);
    this._screenShareMinimized = false;
    this._removeScreenShareIndicator();
    // Apply saved stream size so it doesn't start at default/cut-off height
    const savedStreamSize = localStorage.getItem('haven_stream_size');
    if (savedStreamSize) {
      const vh = parseInt(savedStreamSize, 10);
      container.style.maxHeight = vh + 'vh';
      grid.style.maxHeight = (vh - 2) + 'vh';
      document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
    }
    // Update label accounting for hidden tiles, and refresh hidden streams bar
    this._updateHiddenStreamsBar();
    this._updateScreenShareVisibility();
    // Notify server we're watching this stream
    if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
      this.socket.emit('stream-watch', { code: this.voice.currentChannel, sharerId: userId });
    }
  } else {
    // Stream ended — remove this tile
    const tileId = `screen-tile-${userId || 'self'}`;
    const tile = document.getElementById(tileId);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = null;
      tile.remove();
    }
    // If our OWN stream ended (e.g. browser "Stop sharing" button),
    // reset the screen-share button so it doesn't stay in "stop" state
    if (userId === this.user.id || userId === 'self') {
      const ssBtn = document.getElementById('screen-share-btn');
      if (ssBtn) {
        ssBtn.textContent = '🖥️';
        ssBtn.title = 'Share Screen';
        ssBtn.classList.remove('sharing');
      }
    }
    // Notify server we stopped watching
    if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
      this.socket.emit('stream-unwatch', { code: this.voice.currentChannel, sharerId: userId });
    }
    this._updateHiddenStreamsBar();
    this._updateScreenShareVisibility();
  }
},

// ── Audio Device Enumeration ─────────────────────────────

async _populateAudioDevices() {
  const inputSelect  = document.getElementById('voice-input-device');
  const outputSelect = document.getElementById('voice-output-device');
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
      } catch {}
    }
    devices = await navigator.mediaDevices.enumerateDevices();
    if (tempStream) tempStream.getTracks().forEach(t => t.stop());
  } catch (err) {
    console.warn('[Haven] Could not enumerate audio devices:', err);
    return;
  }

  const inputs  = devices.filter(d => d.kind === 'audioinput');
  const outputs = devices.filter(d => d.kind === 'audiooutput');

  const savedInput  = localStorage.getItem('haven_input_device') || '';
  const savedOutput = localStorage.getItem('haven_output_device') || '';

  // Populate input
  inputSelect.innerHTML = '<option value="">Default Microphone</option>';
  for (const dev of inputs) {
    const label = dev.label || `Microphone ${inputs.indexOf(dev) + 1}`;
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = label;
    if (savedInput === dev.deviceId) opt.selected = true;
    inputSelect.appendChild(opt);
  }

  // Populate output
  outputSelect.innerHTML = '<option value="">Default Speaker</option>';
  for (const dev of outputs) {
    const label = dev.label || `Speaker ${outputs.indexOf(dev) + 1}`;
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = label;
    if (savedOutput === dev.deviceId) opt.selected = true;
    outputSelect.appendChild(opt);
  }
},

// ── Mic Level Meter ──────────────────────────────────────

_startMicMeter() {
  if (this._micMeterRAF) return;
  const fill = this._micMeterFill;
  if (!fill) return;

  const tick = () => {
    const level = (this.voice && this.voice.inVoice) ? this.voice.currentMicLevel : 0;
    fill.style.width = level + '%';
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

_applyStreamLayout(mode) {
  const grid = document.getElementById('screen-share-grid');
  if (!grid) return;
  grid.classList.remove('layout-vertical', 'layout-side-by-side', 'layout-grid-2x2');
  if (mode === 'vertical') grid.classList.add('layout-vertical');
  else if (mode === 'side-by-side') grid.classList.add('layout-side-by-side');
  else if (mode === 'grid-2x2') grid.classList.add('layout-grid-2x2');
  // 'auto' = no extra class, default CSS applies
},

_applyWebcamLayout(mode) {
  const grid = document.getElementById('webcam-grid');
  if (!grid) return;
  grid.classList.remove('layout-vertical', 'layout-side-by-side', 'layout-grid-2x2');
  if (mode === 'vertical') grid.classList.add('layout-vertical');
  else if (mode === 'side-by-side') grid.classList.add('layout-side-by-side');
  else if (mode === 'grid-2x2') grid.classList.add('layout-grid-2x2');
},

_updateScreenShareVisibility() {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  const label = document.getElementById('screen-share-label');
  const totalCount = grid.children.length;
  const visibleCount = grid.querySelectorAll('.screen-share-tile:not([data-hidden=\"true\"])').length;
  const hiddenCount = totalCount - visibleCount;
  if (totalCount === 0) {
    container.style.display = 'none';
    this._screenShareMinimized = false;
    this._removeScreenShareIndicator();
    // Clean up hidden streams bar
    document.getElementById('hidden-streams-bar')?.remove();
  } else if (visibleCount === 0) {
    // All tiles hidden — collapse the container to avoid empty gray space,
    // but keep the "hidden streams" bar in the header so user can restore.
    container.style.display = 'none';
  } else if (this._screenShareMinimized) {
    this._showScreenShareIndicator(totalCount);
  } else {
    container.style.display = 'flex';
    const labelParts = [`🖥️ ${visibleCount} stream${visibleCount !== 1 ? 's' : ''}`];
    if (hiddenCount > 0) labelParts.push(`(${hiddenCount} hidden)`);
    label.textContent = labelParts.join(' ');
  }
},

_hideScreenShare() {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  // Just minimize — don't destroy streams or stop sharing
  container.style.display = 'none';
  this._screenShareMinimized = true;
  // Show a "streams hidden" indicator if there are still tiles
  if (grid.children.length > 0) {
    this._showScreenShareIndicator(grid.children.length);
  }
},

_showScreenShareIndicator(count) {
  let ind = document.getElementById('screen-share-indicator');
  if (!ind) {
    ind = document.createElement('button');
    ind.id = 'screen-share-indicator';
    ind.className = 'screen-share-indicator';
    ind.addEventListener('click', () => {
      const container = document.getElementById('screen-share-container');
      const grid = document.getElementById('screen-share-grid');
      // Restore all hidden tiles and their audio
      if (grid) {
        grid.querySelectorAll('.screen-share-tile[data-hidden="true"]').forEach(t => {
          t.style.display = '';
          delete t.dataset.hidden;
          if (t.dataset.muted === 'true') {
            delete t.dataset.muted;
            const uid = t.id.replace('screen-tile-', '');
            const volSlider = t.querySelector('.stream-vol-slider');
            const vol = volSlider ? parseInt(volSlider.value) / 100 : 1;
            this.voice.setStreamVolume(uid, vol);
          }
        });
      }
      container.style.display = 'flex';
      this._screenShareMinimized = false;
      ind.remove();
      document.getElementById('hidden-streams-bar')?.remove();
      this._updateScreenShareVisibility();
    });
    document.querySelector('.channel-header')?.appendChild(ind);
  }
  ind.textContent = `🖥️ ${count} stream${count > 1 ? 's' : ''} hidden`;
},

_removeScreenShareIndicator() {
  document.getElementById('screen-share-indicator')?.remove();
},

// ── Hide / Show individual stream tiles ─────────────

_hideStreamTile(tile, userId, who, muteAudio = false) {
  tile.style.display = 'none';
  tile.dataset.hidden = 'true';
  if (muteAudio) {
    tile.dataset.muted = 'true';
    // Mute this stream's audio via gain node + audio element
    this.voice.setStreamVolume(userId, 0);
    // Also pause the underlying audio element to guarantee silence
    const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (audioEl) { audioEl.volume = 0; try { audioEl.pause(); } catch {} }
  }
  // Notify server we stopped watching this stream
  if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
    this.socket.emit('stream-unwatch', { code: this.voice.currentChannel, sharerId: userId });
  }
  this._updateHiddenStreamsBar();
  this._updateScreenShareVisibility();
},

_showStreamTile(tileId, userId) {
  const tile = document.getElementById(tileId);
  if (tile) {
    tile.style.display = '';
    delete tile.dataset.hidden;
    // Re-play video (browsers may pause while display:none)
    const vid = tile.querySelector('video');
    if (vid && vid.srcObject) vid.play().catch(() => {});
    // Restore audio if it was muted by close
    if (tile.dataset.muted === 'true') {
      delete tile.dataset.muted;
      // Resume the audio element that was paused when hiding
      const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (audioEl && audioEl.paused) { try { audioEl.play(); } catch {} }
      // Check if the user had manually muted the stream before closing —
      // if so, keep it muted instead of restoring volume
      const muteBtn = tile.querySelector('.stream-mute-btn');
      if (muteBtn && muteBtn.dataset.muted === 'true') {
        // User had it muted — re-mute
        if (userId) this.voice.setStreamVolume(userId, 0);
      } else {
        const volSlider = tile.querySelector('.stream-vol-slider');
        const vol = volSlider ? parseInt(volSlider.value) / 100 : 1;
        if (userId) this.voice.setStreamVolume(userId, vol);
      }
    }
    // Notify server we're watching this stream again
    if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
      this.socket.emit('stream-watch', { code: this.voice.currentChannel, sharerId: userId });
    }
  }
  this._updateHiddenStreamsBar();
  this._updateScreenShareVisibility();
},

_updateHiddenStreamsBar() {
  const grid = document.getElementById('screen-share-grid');
  const container = document.getElementById('screen-share-container');
  let bar = document.getElementById('hidden-streams-bar');
  const hiddenTiles = grid.querySelectorAll('.screen-share-tile[data-hidden="true"]');

  if (hiddenTiles.length === 0) {
    if (bar) bar.remove();
    return;
  }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'hidden-streams-bar';
    bar.className = 'hidden-streams-bar';
    // Insert inside voice-controls so it groups with other header buttons
    document.querySelector('.voice-controls')?.appendChild(bar);
  }

  bar.innerHTML = `<button class="hidden-stream-restore-btn" title="Show hidden streams">🖥 ${hiddenTiles.length} stream${hiddenTiles.length > 1 ? 's' : ''} hidden</button>`;

  // Bind restore button — clicking it restores all hidden streams
  bar.querySelector('.hidden-stream-restore-btn').addEventListener('click', () => {
    hiddenTiles.forEach(t => {
      t.style.display = '';
      delete t.dataset.hidden;
      const uid = t.id.replace('screen-tile-', '');
      // Re-play video (browsers may pause while display:none)
      const vid = t.querySelector('video');
      if (vid && vid.srcObject) vid.play().catch(() => {});
      // Restore audio if it was muted by close
      if (t.dataset.muted === 'true') {
        delete t.dataset.muted;
        // Resume the audio element that was paused when hiding
        const audioEl = document.getElementById(`voice-audio-screen-${uid}`);
        if (audioEl && audioEl.paused) { try { audioEl.play(); } catch {} }
        // Check if the user had manually muted before closing
        const muteBtn = t.querySelector('.stream-mute-btn');
        if (muteBtn && muteBtn.dataset.muted === 'true') {
          this.voice.setStreamVolume(uid, 0);
        } else {
          const volSlider = t.querySelector('.stream-vol-slider');
          const vol = volSlider ? parseInt(volSlider.value) / 100 : 1;
          this.voice.setStreamVolume(uid, vol);
        }
      }
      // Notify server we're watching again
      if (this.voice && this.voice.inVoice && uid !== String(this.user?.id)) {
        this.socket.emit('stream-watch', { code: this.voice.currentChannel, sharerId: parseInt(uid) || uid });
      }
    });
    this._updateHiddenStreamsBar();
    this._updateScreenShareVisibility();
  });

  // Show the container only if there are still visible tiles — _updateScreenShareVisibility handles this.
  // (Removed forced container.style.display = 'flex' that caused empty gray space.)
},

_closeScreenShare() {
  // If user is actively sharing, stop that stream
  if (this.voice && this.voice.screenStream) {
    this._toggleScreenShare(); // stops sharing
  }
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  const tiles = grid ? grid.querySelectorAll('.screen-share-tile') : [];

  // Mute all remote stream audio and fully remove tiles
  tiles.forEach(t => {
    const uid = t.id.replace('screen-tile-', '');
    this.voice.setStreamVolume(uid, 0);
    const audioEl = document.getElementById(`voice-audio-screen-${uid}`);
    if (audioEl) { audioEl.volume = 0; try { audioEl.pause(); } catch {} }
    // Notify server we stopped watching
    if (this.voice && this.voice.inVoice && uid !== String(this.user.id)) {
      this.socket.emit('stream-unwatch', { code: this.voice.currentChannel, sharerId: parseInt(uid) || uid });
    }
    const vid = t.querySelector('video');
    if (vid) vid.srcObject = null;
    t.remove();
  });

  container.style.display = 'none';
  container.classList.remove('stream-focus-mode');
  this._screenShareMinimized = false;
  this._removeScreenShareIndicator();
  document.getElementById('hidden-streams-bar')?.remove();
},

// ── Screen Share Audio ──────────────────────────────

_handleScreenAudio(userId) {
  const tileId = `screen-tile-${userId || 'self'}`;
  const tile = document.getElementById(tileId);
  if (tile) {
    // Remove opposite badge first (mutually exclusive)
    tile.querySelector('.stream-no-audio-badge')?.remove();
    if (!tile.querySelector('.stream-audio-badge')) {
      const badge = document.createElement('div');
      badge.className = 'stream-audio-badge';
      badge.innerHTML = '🔊 Audio';
      tile.appendChild(badge);
    }
    // Restore audio controls visibility since audio is available
    const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
    if (controls) controls.style.display = '';
  }
  // Flash controls visible briefly
  const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
  if (controls) {
    controls.style.opacity = '1';
    setTimeout(() => { controls.style.opacity = ''; }, 3000);
  }
},

_handleScreenNoAudio(userId) {
  const tileId = `screen-tile-${userId || 'self'}`;
  const tile = document.getElementById(tileId);
  if (!tile) {
    // Tile may not exist yet — defer until it's created
    const checkInterval = setInterval(() => {
      const t = document.getElementById(tileId);
      if (t) {
        clearInterval(checkInterval);
        this._applyNoAudioBadge(t, userId);
      }
    }, 200);
    setTimeout(() => clearInterval(checkInterval), 5000);
    return;
  }
  this._applyNoAudioBadge(tile, userId);
},

_applyNoAudioBadge(tile, userId) {
  // Remove opposite badge first (mutually exclusive)
  tile.querySelector('.stream-audio-badge')?.remove();
  if (tile.querySelector('.stream-no-audio-badge')) return;
  // Add the no-audio badge
  const badge = document.createElement('div');
  badge.className = 'stream-no-audio-badge';
  badge.innerHTML = '🔇 No Audio';
  tile.appendChild(badge);
  // Hide audio controls since there's no audio to control
  const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
  if (controls) controls.style.display = 'none';
},

// ── Stream Viewer Badges ─────────────────────────────

_updateStreamViewerBadges() {
  const grid = document.getElementById('screen-share-grid');
  if (!grid) return;
  const streams = this._streamInfo || [];

  grid.querySelectorAll('.screen-share-tile').forEach(tile => {
    const uid = tile.id.replace('screen-tile-', '');
    const numericUid = parseInt(uid);
    const streamInfo = streams.find(s => s.sharerId === numericUid || String(s.sharerId) === uid);

    // Remove old viewer badge
    tile.querySelector('.stream-viewer-badge')?.remove();

    const viewers = streamInfo ? streamInfo.viewers : [];
    if (viewers.length === 0) return;

    const badge = document.createElement('div');
    badge.className = 'stream-viewer-badge';
    const names = viewers.map(v => v.username).join(', ');
    const eyeCount = viewers.length;
    badge.innerHTML = `<span class="viewer-eye">👁</span> ${eyeCount}`;
    badge.title = `Watching: ${names}`;
    tile.appendChild(badge);
  });
},

// ── Stream Focus & Pop-out ──────────────────────────

_toggleStreamFocus(tile) {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  const wasFocused = tile.classList.contains('stream-focused');

  // Remove focus from all tiles first
  grid.querySelectorAll('.screen-share-tile').forEach(t => {
    t.classList.remove('stream-focused');
  });
  container.classList.remove('stream-focus-mode');

  if (!wasFocused) {
    tile.classList.add('stream-focused');
    container.classList.add('stream-focus-mode');
    // Clear inline max-height so CSS flex constraints take over (viewport-bounded)
    container.style.maxHeight = '';
    grid.style.maxHeight = '';
    const vid = tile.querySelector('video');
    if (vid) vid.style.maxHeight = '';
  } else {
    // Restore slider-based size
    const saved = localStorage.getItem('haven_stream_size') || '50';
    const vh = parseInt(saved, 10);
    container.style.maxHeight = vh + 'vh';
    grid.style.maxHeight = (vh - 2) + 'vh';
    document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
  }
},

/** Collapse the stream container when all tiles are popped out (no visible streams) */
_updateStreamContainerCollapse() {
  const container = document.querySelector('.screen-share-container');
  if (!container) return;
  const tiles = container.querySelectorAll('.screen-share-tile');
  const allPopped = tiles.length > 0 && [...tiles].every(t => t.classList.contains('stream-popped-out'));
  container.classList.toggle('all-streams-popped', allPopped);
},

_popOutStream(tile, userId) {
  const video = tile.querySelector('video');
  if (!video || !video.srcObject) return;

  // If already in Picture-in-Picture, exit it
  if (document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }

  // If already popped out, don't open another
  if (tile.classList.contains('stream-popped-out')) return;

  // Try native Picture-in-Picture first (OS-level window, can be dragged to other screens)
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    video.requestPictureInPicture().then(() => {
      const popoutBtn = tile.querySelector('.stream-popout-btn');
      if (popoutBtn) { popoutBtn.textContent = '\u29C8'; popoutBtn.title = 'Pop in stream'; }
      tile.classList.add('stream-popped-out');
      this._updateStreamContainerCollapse();

      video.addEventListener('leavepictureinpicture', () => {
        if (popoutBtn) { popoutBtn.textContent = '\u29C9'; popoutBtn.title = 'Pop out stream'; }
        tile.classList.remove('stream-popped-out');
        this._updateStreamContainerCollapse();
      }, { once: true });
    }).catch(() => {
      // Fallback to in-page overlay if native PiP fails
      this._popOutStreamWindow(tile, userId);
    });
  } else {
    this._popOutStreamWindow(tile, userId);
  }
},

_popOutStreamWindow(tile, userId) {
  const video = tile.querySelector('video');
  if (!video || !video.srcObject) return;

  const stream = video.srcObject;
  const peer = this.voice.peers.get(userId);
  const who = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Stream');

  // Create floating in-page overlay (like music PiP) instead of window.open
  const pipId = `stream-pip-${userId || 'self'}`;
  if (document.getElementById(pipId)) return; // already open

  const savedOpacity = parseInt(localStorage.getItem('haven_pip_opacity') ?? '100');
  const pip = document.createElement('div');
  pip.id = pipId;
  pip.className = 'music-pip-overlay stream-pip-overlay';
  pip.style.opacity = savedOpacity / 100;
  pip.style.width = '480px';
  pip.style.minHeight = '320px';

  pip.innerHTML = `
    <div class="music-pip-embed stream-pip-video"></div>
    <div class="music-pip-controls">
      <button class="music-pip-btn stream-pip-popin" title="Pop back in">⧈</button>
      <span class="music-pip-label">🖥️ ${who}</span>
      <span class="music-pip-vol-icon stream-pip-opacity-icon" title="Window opacity">👁</span>
      <input type="range" class="music-pip-vol pip-opacity-slider stream-pip-opacity" min="20" max="100" value="${savedOpacity}">
      <button class="music-pip-btn stream-pip-fullscreen" title="Fullscreen">⤢</button>
      <button class="music-pip-btn stream-pip-close" title="Close">✕</button>
    </div>
  `;

  document.body.appendChild(pip);

  // Clone video into PiP (keep original in tile for when user pops back in)
  const pipVideo = document.createElement('video');
  pipVideo.autoplay = true;
  pipVideo.playsInline = true;
  pipVideo.muted = true;
  pipVideo.srcObject = stream;
  pipVideo.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
  pip.querySelector('.stream-pip-video').appendChild(pipVideo);
  pipVideo.play().catch(() => {});

  const popoutBtn = tile.querySelector('.stream-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = 'Pop in stream'; }
  tile.classList.add('stream-popped-out');
  this._updateStreamContainerCollapse();

  // Pop-in handler (minimize — return to inline grid)
  const popIn = () => {
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out stream'; }
    tile.classList.remove('stream-popped-out');
    this._updateStreamContainerCollapse();
  };

  // Close handler (destroy PiP overlay AND hide the inline tile)
  const closePip = () => {
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out stream'; }
    tile.classList.remove('stream-popped-out');
    this._updateStreamContainerCollapse();
    // Also hide the stream tile — user wants to close the stream, not just pop back in
    const peer = this.voice.peers.get(userId);
    const who2 = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Stream');
    this._hideStreamTile(tile, userId, who2, true);
  };

  pip.querySelector('.stream-pip-popin').addEventListener('click', popIn);
  pip.querySelector('.stream-pip-close').addEventListener('click', closePip);
  pip.querySelector('.stream-pip-fullscreen').addEventListener('click', (e) => {
    e.stopPropagation();
    const vid = pip.querySelector('video');
    const target = vid || pip;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => {});
    }
  });

  pip.querySelector('.stream-pip-opacity').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    pip.style.opacity = val / 100;
    localStorage.setItem('haven_pip_opacity', val);
  });

  // Dragging (whole overlay is drag handle, except buttons/sliders)
  this._initPipDrag(pip, pip);

  // Clean up if stream ends
  const streamTrack = stream.getVideoTracks()[0];
  if (streamTrack) {
    const prevOnEnded = streamTrack.onended;
    streamTrack.onended = () => {
      if (prevOnEnded) prevOnEnded();
      popIn();
    };
  }
},

// ── Music Streaming ───────────────────────────────

_openMusicModal() {
  if (!this.voice || !this.voice.inVoice) {
    this._showToast('Join voice first to share music', 'error');
    return;
  }
  document.getElementById('music-link-input').value = '';
  document.getElementById('music-link-preview').innerHTML = '';
  document.getElementById('music-link-preview').classList.remove('active');
  document.getElementById('music-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('music-link-input').focus(), 100);
},

_closeMusicModal() {
  document.getElementById('music-modal').style.display = 'none';
},

_previewMusicLink(url) {
  const preview = document.getElementById('music-link-preview');
  if (!url) { preview.innerHTML = ''; preview.classList.remove('active'); return; }
  const platform = this._getMusicPlatform(url);
  const embedUrl = this._getMusicEmbed(url);
  if (platform && embedUrl) {
    preview.classList.add('active');
    preview.innerHTML = `${platform.icon} <strong>${platform.name}</strong> — Ready to share`;
  } else {
    preview.classList.remove('active');
    preview.innerHTML = '';
  }
},

_shareMusic() {
  const url = document.getElementById('music-link-input').value.trim();
  if (!url) { this._showToast('Please paste a music link', 'error'); return; }
  if (!this._getMusicEmbed(url)) {
    this._showToast('Unsupported link — try Spotify, YouTube, or SoundCloud', 'error');
    return;
  }
  if (!this.voice || !this.voice.inVoice) { this._showToast('Join voice first', 'error'); return; }
  this.socket.emit('music-share', { code: this.voice.currentChannel, url });
  this._closeMusicModal();
},

_stopMusic() {
  if (this.voice && this.voice.inVoice) {
    this.socket.emit('music-stop', { code: this.voice.currentChannel });
  }
  this._hideMusicPanel();
},

_showMusicSearchResults(data) {
  // Remove any existing search picker
  this._closeMusicSearchPicker();

  const { results, query, offset } = data;
  if (!results || results.length === 0) {
    this._showToast(offset > 0 ? 'No more results' : `No results for "${query}"`, 'error');
    return;
  }

  const picker = document.createElement('div');
  picker.id = 'music-search-picker';
  picker.className = 'music-search-picker';
  picker.innerHTML = `
    <div class="music-search-picker-header">
      <span>🔍 Results for "<strong>${this._escapeHtml(query)}</strong>"</span>
      <button class="music-search-picker-close" title="Cancel">✕</button>
    </div>
    <div class="music-search-picker-list">
      ${results.map((r, i) => `
        <div class="music-search-picker-item" data-video-id="${r.videoId}">
          <div class="music-search-picker-thumb">
            ${r.thumbnail ? `<img src="${this._escapeHtml(r.thumbnail)}" alt="" loading="lazy">` : '<span>🎵</span>'}
          </div>
          <div class="music-search-picker-info">
            <div class="music-search-picker-title">${this._escapeHtml(r.title || `Result ${offset + i + 1}`)}</div>
            <div class="music-search-picker-meta">${this._escapeHtml(r.channel)}${r.duration ? ` · ${r.duration}` : ''}</div>
          </div>
          <button class="music-search-picker-play" data-video-id="${r.videoId}" title="Play this">▶</button>
        </div>
      `).join('')}
    </div>
    <div class="music-search-picker-footer">
      <button class="music-search-picker-more">More results</button>
      <button class="music-search-picker-cancel">Cancel</button>
    </div>
  `;

  // Insert above the message input area
  const msgArea = document.getElementById('message-area');
  msgArea.appendChild(picker);

  // Event handlers
  picker.querySelector('.music-search-picker-close').addEventListener('click', () => this._closeMusicSearchPicker());
  picker.querySelector('.music-search-picker-cancel').addEventListener('click', () => this._closeMusicSearchPicker());
  picker.querySelector('.music-search-picker-more').addEventListener('click', () => {
    const newOffset = (offset || 0) + 5;
    this._musicSearchOffset = newOffset;
    this.socket.emit('music-search', { query: this._musicSearchQuery, offset: newOffset });
    this._closeMusicSearchPicker();
    this._showToast('Loading more…', 'info');
  });

  picker.querySelectorAll('.music-search-picker-play').forEach(btn => {
    btn.addEventListener('click', () => {
      const videoId = btn.dataset.videoId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      this.socket.emit('music-share', { code: this.voice.currentChannel, url });
      this._closeMusicSearchPicker();
    });
  });

  // Also allow clicking the whole row
  picker.querySelectorAll('.music-search-picker-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.music-search-picker-play')) return; // already handled
      const videoId = item.dataset.videoId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      this.socket.emit('music-share', { code: this.voice.currentChannel, url });
      this._closeMusicSearchPicker();
    });
  });
},

_closeMusicSearchPicker() {
  const existing = document.getElementById('music-search-picker');
  if (existing) existing.remove();
},

_handleMusicShared(data) {
  const embedUrl = this._getMusicEmbed(data.url);
  if (!embedUrl) return;
  const platform = this._getMusicPlatform(data.url);
  const panel = document.getElementById('music-panel');
  const container = document.getElementById('music-embed-container');
  const label = document.getElementById('music-panel-label');

  // Clean up previous player references
  this._musicYTPlayer = null;
  this._musicSCWidget = null;
  this._musicPlatform = platform ? platform.name : null;
  this._musicPlaying = true;
  this._musicActive = true;
  this._musicUrl = data.url;
  this._removeMusicIndicator();

  let iframeH = '152';
  if (data.url.includes('spotify.com')) iframeH = '152';
  else if (data.url.includes('soundcloud.com')) iframeH = '166';
  else if (data.url.includes('youtube.com') || data.url.includes('youtu.be')) iframeH = '200';

  // Wrap iframe in a container; overlay blocks direct clicks for SoundCloud (Haven has API control)
  // For Spotify & YouTube, no overlay — user interacts with their native controls (seek bar, etc.)
  const isSpotify = data.url.includes('spotify.com');
  const isYouTube = data.url.includes('youtube.com') || data.url.includes('youtu.be') || data.url.includes('music.youtube.com');
  const needsOverlay = !isSpotify && !isYouTube; // only SoundCloud gets the click-blocker now
  // YouTube embeds: origin param tells Google which page hosts the iframe.
  // We skip referrerpolicy=no-referrer so the IFrame API (enablejsapi) can
  // communicate with the parent window; the origin= param already handles
  // the "Video unavailable" issue that self-hosted instances used to trigger.
  container.innerHTML = `<div class="music-embed-wrapper"><iframe id="music-iframe" src="${embedUrl}" width="100%" height="${iframeH}" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>${needsOverlay ? '<div class="music-embed-overlay"></div>' : ''}</div>`;
  if (data.resolvedFrom === 'spotify') {
    label.textContent = `🎵 🟢 Spotify (via YouTube) — shared by ${data.username || 'someone'}`;
  } else {
    label.textContent = `🎵 ${platform ? platform.name : 'Music'} — shared by ${data.username || 'someone'}`;
  }
  panel.style.display = 'flex';

  // Update play/pause button — hide for Spotify (no external API)
  const ppBtn = document.getElementById('music-play-pause-btn');
  if (ppBtn) {
    ppBtn.textContent = isSpotify ? '' : '⏸';
    ppBtn.style.display = isSpotify ? 'none' : '';
  }

  // Seek bar — hide for Spotify (no external API for position tracking)
  const seekSlider = document.getElementById('music-seek-slider');
  const timeCur = document.getElementById('music-time-current');
  const timeDur = document.getElementById('music-time-duration');
  const hideSeek = isSpotify;
  if (seekSlider) seekSlider.style.display = hideSeek ? 'none' : '';
  if (timeCur) timeCur.style.display = hideSeek ? 'none' : '';
  if (timeDur) timeDur.style.display = hideSeek ? 'none' : '';

  // Apply saved volume
  const savedVol = parseInt(localStorage.getItem('haven_music_volume') ?? '80');
  document.getElementById('music-volume-slider').value = savedVol;

  // For Spotify: volume can only be controlled inside the embed — show disclaimer
  const volSlider = document.getElementById('music-volume-slider');
  const muteBtn = document.getElementById('music-mute-btn');
  if (isSpotify) {
    if (volSlider) { volSlider.disabled = true; volSlider.title = 'Use Spotify\'s built-in controls for volume'; }
    if (muteBtn) { muteBtn.disabled = true; muteBtn.title = 'Use Spotify\'s built-in controls for volume'; }
  } else {
    if (volSlider) { volSlider.disabled = false; volSlider.title = ''; }
    if (muteBtn) { muteBtn.disabled = false; muteBtn.title = 'Mute/Unmute'; }
  }

  // Show next/prev/shuffle for SoundCloud & YouTube playlists only (not single YT videos, not Spotify)
  const isSoundCloud = data.url.includes('soundcloud.com');
  const showTrackBtns = isSoundCloud || this._musicIsYTPlaylist;
  const prevBtn = document.getElementById('music-prev-btn');
  const nextBtn = document.getElementById('music-next-btn');
  const shuffleBtn = document.getElementById('music-shuffle-btn');
  if (prevBtn) prevBtn.style.display = showTrackBtns ? '' : 'none';
  if (nextBtn) nextBtn.style.display = showTrackBtns ? '' : 'none';
  if (shuffleBtn) shuffleBtn.style.display = showTrackBtns ? '' : 'none';


  // Initialize platform-specific APIs for volume & sync control
  const iframe = document.getElementById('music-iframe');
  if (iframe) {
    if (data.url.includes('youtube.com') || data.url.includes('youtu.be') || data.url.includes('music.youtube.com')) {
      this._initYouTubePlayer(iframe, savedVol);
    } else if (data.url.includes('soundcloud.com')) {
      this._initSoundCloudWidget(iframe, savedVol);
    }
  }

  const who = data.userId === this.user?.id ? 'You shared' : `${data.username} shared`;
  const platformLabel = data.resolvedFrom === 'spotify' ? 'Spotify (via YouTube)' : (platform ? platform.name : 'music');
  this._showToast(`${who} ${platformLabel}`, 'info');
},

_initYouTubePlayer(iframe, volume) {
  // YouTube IFrame API — load the API script once, then create a player
  if (!window.YT || !window.YT.Player) {
    if (!document.getElementById('yt-iframe-api')) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
    // Wait for API to load, then retry
    const check = setInterval(() => {
      if (window.YT && window.YT.Player) {
        clearInterval(check);
        this._createYTPlayer(iframe, volume);
      }
    }, 200);
    setTimeout(() => clearInterval(check), 10000); // give up after 10s
  } else {
    this._createYTPlayer(iframe, volume);
  }
},

_createYTPlayer(iframe, volume) {
  try {
    this._musicYTPlayer = new YT.Player(iframe, {
      events: {
        onReady: (e) => {
          e.target.setVolume(volume);
          this._startMusicTimeTracking();
        },
        onStateChange: (e) => {
          // Sync Haven's play/pause state when user interacts with YT's native controls
          const ppBtn = document.getElementById('music-play-pause-btn');
          const pipPP = document.getElementById('music-pip-pp');
          if (e.data === YT.PlayerState.PLAYING) {
            this._musicPlaying = true;
            if (ppBtn) ppBtn.textContent = '⏸';
            if (pipPP) pipPP.textContent = '⏸';
          } else if (e.data === YT.PlayerState.PAUSED) {
            this._musicPlaying = false;
            if (ppBtn) ppBtn.textContent = '▶';
            if (pipPP) pipPP.textContent = '▶';
          } else if (e.data === YT.PlayerState.ENDED) {
            // Auto-advance: if YouTube playlist, play the next video
            if (this._musicIsYTPlaylist) {
              try { e.target.nextVideo(); } catch {}
            } else {
              this._musicPlaying = false;
              if (ppBtn) ppBtn.textContent = '▶';
              if (pipPP) pipPP.textContent = '▶';
            }
          }
        }
      }
    });
  } catch { /* iframe may already be destroyed */ }
},

_initSoundCloudWidget(iframe, volume) {
  // SoundCloud Widget API
  if (!window.SC || !window.SC.Widget) {
    if (!document.getElementById('sc-widget-api')) {
      const tag = document.createElement('script');
      tag.id = 'sc-widget-api';
      tag.src = 'https://w.soundcloud.com/player/api.js';
      document.head.appendChild(tag);
    }
    const check = setInterval(() => {
      if (window.SC && window.SC.Widget) {
        clearInterval(check);
        this._createSCWidget(iframe, volume);
      }
    }, 200);
    setTimeout(() => clearInterval(check), 10000);
  } else {
    this._createSCWidget(iframe, volume);
  }
},

_createSCWidget(iframe, volume) {
  try {
    this._musicSCWidget = SC.Widget(iframe);
    this._musicSCShuffle = false;
    this._musicSCTrackCount = 0;
    this._musicSCCurrentIndex = 0;
    this._musicSCWidget.bind(SC.Widget.Events.READY, () => {
      this._musicSCWidget.setVolume(volume);
      this._startMusicTimeTracking();
      // Get track count for shuffle support
      this._musicSCWidget.getSounds((sounds) => {
        this._musicSCTrackCount = sounds ? sounds.length : 0;
      });
    });
    // Auto-advance on track finish (supports shuffle)
    this._musicSCWidget.bind(SC.Widget.Events.FINISH, () => {
      if (this._musicSCShuffle && this._musicSCTrackCount > 1) {
        // Pick a random track that isn't the current one
        let next = (this._musicSCCurrentIndex + 1) % this._musicSCTrackCount;
        if (this._musicSCTrackCount > 2) {
          next = Math.floor(Math.random() * (this._musicSCTrackCount - 1));
          if (next >= this._musicSCCurrentIndex) next++;
        }
        this._musicSCCurrentIndex = next;
        this._musicSCWidget.skip(next);
      } else {
        this._musicSCWidget.next();
      }
    });
    // Track current index for shuffle
    this._musicSCWidget.bind(SC.Widget.Events.PLAY, () => {
      this._musicSCWidget.getCurrentSoundIndex((idx) => { this._musicSCCurrentIndex = idx; });
    });
  } catch { /* iframe may already be destroyed */ }
},

_handleMusicStopped(data) {
  this._stopMusicTimeTracking();
  this._musicYTPlayer = null;
  this._musicSCWidget = null;
  this._musicPlatform = null;
  this._musicPlaying = false;
  this._hideMusicPanel();
  const who = data.userId === this.user?.id ? 'You' : (data.username || 'Someone');
  this._showToast(`${who} stopped the music`, 'info');
},

_handleMusicControl(data) {
  if (data.action === 'pause') {
    this._pauseMusicEmbed();
    this._musicPlaying = false;
  } else if (data.action === 'play') {
    this._playMusicEmbed();
    this._musicPlaying = true;
  } else if (data.action === 'next') {
    this._musicNextTrack();
  } else if (data.action === 'prev') {
    this._musicPrevTrack();
  } else if (data.action === 'shuffle') {
    this._musicToggleShuffle();
  }
  const ppBtn = document.getElementById('music-play-pause-btn');
  if (ppBtn) ppBtn.textContent = this._musicPlaying ? '⏸' : '▶';
},

_toggleMusicPlayPause() {
  if (this._musicPlaying) {
    this._pauseMusicEmbed();
    this._musicPlaying = false;
  } else {
    this._playMusicEmbed();
    this._musicPlaying = true;
  }
  const ppBtn = document.getElementById('music-play-pause-btn');
  if (ppBtn) ppBtn.textContent = this._musicPlaying ? '⏸' : '▶';
  // Broadcast to others in voice
  if (this.voice && this.voice.inVoice) {
    this.socket.emit('music-control', {
      code: this.voice.currentChannel,
      action: this._musicPlaying ? 'play' : 'pause'
    });
  }
},

_musicTrackControl(action) {
  // Execute locally
  if (action === 'next') this._musicNextTrack();
  else if (action === 'prev') this._musicPrevTrack();
  else if (action === 'shuffle') this._musicToggleShuffle();
  // Broadcast to others in voice
  if (this.voice && this.voice.inVoice) {
    this.socket.emit('music-control', {
      code: this.voice.currentChannel,
      action
    });
  }
},

_musicNextTrack() {
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.nextVideo) {
      this._musicYTPlayer.nextVideo();
    } else if (this._musicSCWidget) {
      this._musicSCWidget.next();
    }
  } catch { /* player may not support next */ }
},

_musicPrevTrack() {
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.previousVideo) {
      this._musicYTPlayer.previousVideo();
    } else if (this._musicSCWidget) {
      this._musicSCWidget.prev();
    }
  } catch { /* player may not support prev */ }
},

_musicToggleShuffle() {
  try {
    this._musicSCShuffle = !this._musicSCShuffle;
    const btn = document.getElementById('music-shuffle-btn');
    if (btn) btn.classList.toggle('active', this._musicSCShuffle);
    // YouTube has native shuffle support for playlists
    if (this._musicYTPlayer && this._musicYTPlayer.setShuffle) {
      this._musicYTPlayer.setShuffle(this._musicSCShuffle);
    }
    // SoundCloud: immediately skip to a random track when shuffle is turned ON
    if (this._musicSCShuffle && this._musicSCWidget && this._musicSCTrackCount > 1) {
      let next = (this._musicSCCurrentIndex + 1) % this._musicSCTrackCount;
      if (this._musicSCTrackCount > 2) {
        next = Math.floor(Math.random() * (this._musicSCTrackCount - 1));
        if (next >= this._musicSCCurrentIndex) next++;
      }
      this._musicSCCurrentIndex = next;
      this._musicSCWidget.skip(next);
    }
    this._showToast(this._musicSCShuffle ? 'Shuffle on' : 'Shuffle off', 'info');
  } catch { /* player may not support shuffle */ }
},

_playMusicEmbed() {
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.playVideo) {
      this._musicYTPlayer.playVideo();
    } else if (this._musicSCWidget) {
      this._musicSCWidget.play();
    } else {
      // Spotify or fallback — restore paused src to resume
      const iframe = document.getElementById('music-iframe');
      if (iframe) {
        const src = iframe.dataset.pausedSrc || iframe.src;
        delete iframe.dataset.pausedSrc;
        if (src && src !== 'about:blank') iframe.src = src;
      }
    }
  } catch { /* player may be destroyed */ }
},

_pauseMusicEmbed() {
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.pauseVideo) {
      this._musicYTPlayer.pauseVideo();
    } else if (this._musicSCWidget) {
      this._musicSCWidget.pause();
    } else {
      // Spotify — no external API; remove src to pause, store for resume
      const iframe = document.getElementById('music-iframe');
      if (iframe) {
        iframe.dataset.pausedSrc = iframe.src;
        iframe.src = 'about:blank';
      }
    }
  } catch { /* player may be destroyed */ }
},

_hideMusicPanel() {
  this._stopMusicTimeTracking();
  // Clean up PiP overlay if active
  if (this._musicPip) {
    this._musicPip.remove();
    this._musicPip = null;
  }
  const panel = document.getElementById('music-panel');
  if (panel) {
    document.getElementById('music-embed-container').innerHTML = '';
    panel.style.display = 'none';
  }
  this._removeMusicIndicator();
  this._musicActive = false;
},

_minimizeMusicPanel() {
  document.getElementById('music-panel').style.display = 'none';
  // Show an indicator in the channel header so user can reopen
  if (this._musicActive) {
    this._showMusicIndicator();
  }
},

_popOutMusicPlayer() {
  const panel = document.getElementById('music-panel');
  const container = document.getElementById('music-embed-container');
  if (!container || !container.innerHTML.trim()) {
    this._showToast('No music playing', 'error');
    return;
  }

  // If already in PiP overlay, pop back in
  if (this._musicPip) {
    this._popInMusicPlayer();
    return;
  }

  // Create floating PiP overlay
  const pip = document.createElement('div');
  pip.id = 'music-pip-overlay';
  pip.className = 'music-pip-overlay';

  const volume = parseInt(document.getElementById('music-volume-slider')?.value ?? '80');
  const platform = this._musicPlatform || 'Music';
  const playing = this._musicPlaying;

  const savedOpacity = parseInt(localStorage.getItem('haven_pip_opacity') ?? '100');

  pip.innerHTML = `
    <div class="music-pip-header" id="music-pip-drag">
      <button class="music-pip-btn" id="music-pip-popin" title="Minimize (back to panel)">─</button>
      <span class="music-pip-label">🎵 ${platform}</span>
      <button class="music-pip-btn" id="music-pip-fullscreen" title="Fullscreen">⤢</button>
      <button class="music-pip-btn" id="music-pip-close" title="Close / stop music">✕</button>
    </div>
    <div class="music-pip-embed" id="music-pip-embed"></div>
    <div class="music-pip-controls">
      <button class="music-pip-btn" id="music-pip-pp" title="Play/Pause">${playing ? '⏸' : '▶'}</button>
      <span class="music-pip-vol-icon" id="music-pip-mute" title="Mute">🔊</span>
      <input type="range" class="music-pip-vol" id="music-pip-vol" min="0" max="100" value="${volume}">
      <span class="pip-opacity-divider"></span>
      <span class="music-pip-vol-icon" id="music-pip-opacity-icon" title="Window opacity">👁</span>
      <input type="range" class="music-pip-vol pip-opacity-slider" id="music-pip-opacity" min="20" max="100" value="${savedOpacity}">
    </div>
  `;

  pip.style.opacity = savedOpacity / 100;

  document.body.appendChild(pip);

  // Move the embed wrapper (with live iframe) into the PiP overlay — no reload!
  const embedWrapper = container.querySelector('.music-embed-wrapper');
  if (embedWrapper) {
    // Remove the click-blocking overlay so user can interact directly in PiP
    const overlay = embedWrapper.querySelector('.music-embed-overlay');
    if (overlay) overlay.style.display = 'none';
    document.getElementById('music-pip-embed').appendChild(embedWrapper);
  }

  // Hide the original panel
  panel.style.display = 'none';
  this._showMusicIndicator();
  this._musicPip = pip;

  // Update popout button icon to show "pop-in"
  const popBtn = document.getElementById('music-popout-btn');
  if (popBtn) { popBtn.textContent = '⧈'; popBtn.title = 'Pop back in'; }

  // ── PiP controls ──
  document.getElementById('music-pip-popin').addEventListener('click', () => this._popInMusicPlayer());
  document.getElementById('music-pip-close').addEventListener('click', () => this._stopMusic());
  document.getElementById('music-pip-pp').addEventListener('click', () => {
    this._toggleMusicPlayPause();
    document.getElementById('music-pip-pp').textContent = this._musicPlaying ? '⏸' : '▶';
  });
  document.getElementById('music-pip-vol').addEventListener('input', (e) => {
    this._setMusicVolume(parseInt(e.target.value));
    document.getElementById('music-pip-mute').textContent = parseInt(e.target.value) === 0 ? '🔇' : '🔊';
  });
  document.getElementById('music-pip-mute').addEventListener('click', () => {
    this._toggleMusicMute();
    const v = parseInt(document.getElementById('music-volume-slider')?.value ?? '0');
    document.getElementById('music-pip-vol').value = v;
    document.getElementById('music-pip-mute').textContent = v === 0 ? '🔇' : '🔊';
  });

  // ── Opacity ──
  document.getElementById('music-pip-opacity').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    pip.style.opacity = val / 100;
    localStorage.setItem('haven_pip_opacity', val);
  });

  // ── Fullscreen ──
  const toggleMusicFS = () => {
    const el = pip;
    if (document.fullscreenElement === el) {
      document.exitFullscreen().catch(() => {});
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el).catch(() => {});
    }
  };
  document.getElementById('music-pip-fullscreen').addEventListener('click', toggleMusicFS);
  document.getElementById('music-pip-embed').addEventListener('dblclick', toggleMusicFS);
  document.addEventListener('fullscreenchange', () => {
    const fsBtn = document.getElementById('music-pip-fullscreen');
    if (!fsBtn) return;
    if (document.fullscreenElement === pip) {
      fsBtn.textContent = '⤡'; fsBtn.title = 'Exit fullscreen';
    } else {
      fsBtn.textContent = '⤢'; fsBtn.title = 'Fullscreen';
    }
  });

  // ── Dragging ──
  this._initPipDrag(pip, document.getElementById('music-pip-drag'));
},

_popInMusicPlayer() {
  const pip = this._musicPip;
  if (!pip) return;

  const container = document.getElementById('music-embed-container');
  const panel = document.getElementById('music-panel');

  // Move embed wrapper back to the panel
  const embedWrapper = pip.querySelector('.music-embed-wrapper');
  if (embedWrapper && container) {
    // Re-add the click-blocking overlay
    const overlay = embedWrapper.querySelector('.music-embed-overlay');
    if (overlay) overlay.style.display = '';
    container.appendChild(embedWrapper);
  }

  pip.remove();
  this._musicPip = null;

  // Restore panel
  if (this._musicActive && panel) {
    panel.style.display = 'flex';
    this._removeMusicIndicator();
  }

  // Restore popout button icon
  const popBtn = document.getElementById('music-popout-btn');
  if (popBtn) { popBtn.textContent = '⧉'; popBtn.title = 'Pop out player'; }
},

_initPipDrag(pip, handle) {
  let dragging = false, startX, startY, origX, origY;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return; // don't interfere with button clicks
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = pip.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    pip.style.left = (origX + e.clientX - startX) + 'px';
    pip.style.top = (origY + e.clientY - startY) + 'px';
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
  // Touch support
  handle.addEventListener('touchstart', (e) => {
    dragging = true;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    const rect = pip.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    pip.style.left = (origX + t.clientX - startX) + 'px';
    pip.style.top = (origY + t.clientY - startY) + 'px';
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
  }, { passive: true });
  document.addEventListener('touchend', () => { dragging = false; });
},

_showMusicIndicator() {
  let ind = document.getElementById('music-indicator');
  if (ind) return; // already showing
  ind = document.createElement('button');
  ind.id = 'music-indicator';
  ind.className = 'music-indicator';
  ind.textContent = '🎵 Music playing';
  ind.title = 'Click to show music player';
  ind.addEventListener('click', () => {
    // If PiP is active, pop back in first
    if (this._musicPip) {
      this._popInMusicPlayer();
      return;
    }
    const panel = document.getElementById('music-panel');
    panel.style.display = 'flex';
    ind.remove();
  });
  // Append inside voice-controls so it groups with other header buttons
  document.querySelector('.voice-controls')?.appendChild(ind);
},

_removeMusicIndicator() {
  document.getElementById('music-indicator')?.remove();
},

_setMusicVolume(vol) {
  localStorage.setItem('haven_music_volume', vol);
  const muteBtn = document.getElementById('music-mute-btn');
  if (muteBtn) muteBtn.textContent = vol === 0 ? '🔇' : '🔊';
  // Apply to active player
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.setVolume) {
      this._musicYTPlayer.setVolume(vol);
    } else if (this._musicSCWidget) {
      this._musicSCWidget.setVolume(vol);
    }
  } catch { /* player may be gone */ }
},

_toggleMusicMute() {
  const slider = document.getElementById('music-volume-slider');
  const muteBtn = document.getElementById('music-mute-btn');
  if (!slider) return;
  if (parseInt(slider.value) > 0) {
    slider.dataset.prevValue = slider.value;
    slider.value = 0;
    muteBtn.textContent = '🔇';
  } else {
    slider.value = slider.dataset.prevValue || 80;
    muteBtn.textContent = '🔊';
  }
  this._setMusicVolume(parseInt(slider.value));
},

// ── Seek bar & time tracking ──────────────────────────
_seekMusic(pct) {
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.getDuration) {
      const dur = this._musicYTPlayer.getDuration();
      if (dur > 0) this._musicYTPlayer.seekTo(dur * pct / 100, true);
    } else if (this._musicSCWidget) {
      this._musicSCWidget.getDuration((dur) => {
        if (dur > 0) this._musicSCWidget.seekTo(dur * pct / 100);
      });
    }
  } catch { /* player may be gone */ }
},

_startMusicTimeTracking() {
  this._stopMusicTimeTracking();
  const seekSlider = document.getElementById('music-seek-slider');
  const curEl = document.getElementById('music-time-current');
  const durEl = document.getElementById('music-time-duration');
  const fmt = (s) => { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

  this._musicTimeInterval = setInterval(() => {
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.getCurrentTime && this._musicYTPlayer.getDuration) {
        const cur = this._musicYTPlayer.getCurrentTime() || 0;
        const dur = this._musicYTPlayer.getDuration() || 0;
        if (curEl) curEl.textContent = fmt(cur);
        if (durEl) durEl.textContent = fmt(dur);
        if (seekSlider && !this._musicSeeking && dur > 0) seekSlider.value = (cur / dur * 100).toFixed(1);
      } else if (this._musicSCWidget) {
        this._musicSCWidget.getPosition((pos) => {
          this._musicSCWidget.getDuration((dur) => {
            const curS = (pos || 0) / 1000;
            const durS = (dur || 0) / 1000;
            if (curEl) curEl.textContent = fmt(curS);
            if (durEl) durEl.textContent = fmt(durS);
            if (seekSlider && !this._musicSeeking && durS > 0) seekSlider.value = (curS / durS * 100).toFixed(1);
          });
        });
      }
    } catch { /* player gone */ }
  }, 500);
},

_stopMusicTimeTracking() {
  if (this._musicTimeInterval) { clearInterval(this._musicTimeInterval); this._musicTimeInterval = null; }
  const seekSlider = document.getElementById('music-seek-slider');
  const curEl = document.getElementById('music-time-current');
  const durEl = document.getElementById('music-time-duration');
  if (seekSlider) seekSlider.value = 0;
  if (curEl) curEl.textContent = '0:00';
  if (durEl) durEl.textContent = '0:00';
},

_getMusicEmbed(url) {
  this._musicIsYTPlaylist = false;
  if (!url) return null;
  const spotifyMatch = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
  if (spotifyMatch) return `https://open.spotify.com/embed/${spotifyMatch[1]}/${spotifyMatch[2]}?theme=0&utm_source=generator&autoplay=1`;
  // Extract YouTube playlist ID if present
  const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  const listParam = listMatch ? `&list=${listMatch[1]}` : '';
  this._musicIsYTPlaylist = !!listMatch;
  const ytMusicMatch = url.match(/music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (ytMusicMatch) return `https://www.youtube-nocookie.com/embed/${ytMusicMatch[1]}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&rel=0${listParam}`;
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `https://www.youtube-nocookie.com/embed/${ytMatch[1]}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&rel=0${listParam}`;
  this._musicIsYTPlaylist = false;
  if (url.includes('soundcloud.com/')) {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=false`;
  }
  return null;
},

_getMusicPlatform(url) {
  if (!url) return null;
  if (url.includes('spotify.com')) return { name: 'Spotify', icon: '🟢' };
  if (url.includes('music.youtube.com')) return { name: 'YouTube Music', icon: '🔴' };
  if (url.includes('youtube.com') || url.includes('youtu.be')) return { name: 'YouTube', icon: '🔴' };
  if (url.includes('soundcloud.com')) return { name: 'SoundCloud', icon: '🟠' };
  return null;
},

};
