// Screen share and webcam: turning them on and off, showing the video that
// arrives from others, webcam tiles and pop-outs, and the watchdog that
// notices a stream that has stopped moving.

export default {

// NS slider is handled directly via the input event listener in _setupUI

// ── Screen Share ──────────────────────────────────────

async _toggleScreenShare() {
  if (!this.voice.inVoice) return;

  // Spam-click guard, mirroring the one _joinVoice has had for a while.
  // Without it a double-click (or a laggy UI registering two triggers) ran
  // shareScreen twice, which fired _createPeer twice within ~120ms and put two
  // voice-offer SDP negotiations in flight against each other. The resulting
  // glare shows up as a stalled stream and garbled audio. Reported with
  // WebRTC-internals evidence by @RCCore. (#5426)
  if (this._togglingScreenShare) return;
  this._togglingScreenShare = true;
  try {
    await this._doToggleScreenShare();
  } finally {
    this._togglingScreenShare = false;
  }
},

async _doToggleScreenShare() {
  // Block screen share if streams are disabled in this channel
  const _ssCh = this.channels.find(c => c.code === this.voice.currentChannel);
  if (_ssCh && _ssCh.streams_enabled === 0) {
    this._showToast(t('voice.streams_disabled'), 'error');
    return;
  }

  if (this.voice.isScreenSharing) {
    await this.voice.stopScreenShare();
    document.getElementById('screen-share-btn').textContent = '🖥️';
    document.getElementById('screen-share-btn').title = t('voice.screen_share');
    document.getElementById('screen-share-btn').classList.remove('sharing');
    this._showToast(t('voice.screen_share_stopped'), 'info');
  } else {
    const ok = await this.voice.shareScreen();
    if (ok) {
      document.getElementById('screen-share-btn').textContent = '🛑';
      document.getElementById('screen-share-btn').title = t('voice.stop_share');
      document.getElementById('screen-share-btn').classList.add('sharing');
      // Register a one-time listener for desktop-app share-mode updates so
      // the audio badge reflects the actual capture path (per-app /
      // system-clean / fallback / loopback). Browser users won't fire this.
      if (!this._shareModeListenerInstalled) {
        this._shareModeListenerInstalled = true;
        window.addEventListener('haven:share-audio-mode', (ev) => {
          try { this._applyShareAudioModeBadge(ev.detail); } catch (e) { console.warn('share mode badge update failed:', e); }
        });
      }
      // Native desktop capture has no Chromium MediaStream for local preview.
      if (this.voice.screenStream) {
        this._handleScreenStream(this.user.id, this.voice.screenStream);
      }
      // Show audio/no-audio badge
      if (this.voice.screenHasAudio) {
        this._handleScreenAudio(this.user.id);
        this._showToast(t('voice.screen_share_started_audio'), 'success');
      } else {
        this._handleScreenNoAudio(this.user.id);
        this._showToast(t('voice.screen_share_started_no_audio'), 'info');
      }
    } else {
      this._showToast(t('voice.screen_share_cancelled'), 'error');
    }
  }
},

async _toggleWebcam() {
  if (!this.voice.inVoice) return;

  const btn = document.getElementById('voice-cam-btn');
  if (this.voice.isWebcamActive) {
    await this.voice.stopWebcam();
    btn.textContent = '📷';
    btn.title = t('voice.panel.camera');
    btn.classList.remove('sharing');
    this._handleWebcamStream(this.user.id, null);
    this._showToast(t('voice.camera_stopped'), 'info');
  } else {
    const ok = await this.voice.startWebcam();
    if (ok) {
      btn.textContent = '🛑';
      btn.title = t('voice.stop_camera');
      btn.classList.add('sharing');
      this._handleWebcamStream(this.user.id, this.voice.webcamStream);
      this._showToast(t('voice.camera_started'), 'success');
    } else {
      this._showToast(t('voice.camera_error'), 'error');
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
      const name = this.voice.peerName(userId);
      const who = (userId === null || userId === this.user.id) ? t('voice_runtime.you') : (name || t('voice.someone'));
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
      popoutBtn.title = t('media.pop_out_camera');
      popoutBtn.textContent = '⧉';
      popoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._popOutWebcam(tile, userId);
      });
      tile.appendChild(popoutBtn);

      // Fullscreen button
      const fsBtnWC = document.createElement('button');
      fsBtnWC.className = 'stream-fullscreen-btn';
      fsBtnWC.title = t('media.fullscreen');
      fsBtnWC.textContent = '⛶';
      fsBtnWC.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = tile.querySelector('video');
        const target = vid || tile;
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
        } else {
          (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
        }
      });
      tile.appendChild(fsBtnWC);

      // Minimize button — collapses tile but keeps in grid
      const minBtn = document.createElement('button');
      minBtn.className = 'stream-minimize-btn';
      minBtn.title = t('media.minimize');
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
      closeBtn.title = t('media.close_camera');
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
            btn.title = t('voice.panel.camera');
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
    videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
    videoEl.onloadedmetadata = () => { videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ }); };

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
        videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
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
        btn.title = t('voice.panel.camera');
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
    label.textContent = `📷 ${t(count === 1 ? 'voice_runtime.camera_one' : 'voice_runtime.camera_other', { count })}`;
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
  ind.textContent = `📷 ${t(count === 1 ? 'voice_runtime.camera_hidden_one' : 'voice_runtime.camera_hidden_other', { count })}`;
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
    document.exitPictureInPicture().catch(() => { /* already left picture-in-picture */ });
    return;
  }

  if (tile.classList.contains('webcam-popped-out')) return;

  // Try native Picture-in-Picture first
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    video.requestPictureInPicture().then(() => {
      const popoutBtn = tile.querySelector('.stream-popout-btn');
      if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = t('media.pop_in_camera'); }
      tile.classList.add('webcam-popped-out');

      video.addEventListener('leavepictureinpicture', () => {
        if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = t('media.pop_out_camera'); }
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
  const name = this.voice.peerName(userId);
  const who = userId === null || userId === this.user.id ? t('voice_runtime.you') : (name || t('voice_runtime.camera'));

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
      <button class="music-pip-btn stream-pip-popin" title="${t('media.pop_back_in')}">⧈</button>
      <span class="music-pip-label"><span class="music-pip-label-icon" aria-hidden="true">📷</span> ${who}</span>
      <span class="music-pip-vol-icon" title="${t('voice_runtime.window_opacity')}">👁</span>
      <input type="range" class="music-pip-vol pip-opacity-slider" min="20" max="100" value="${savedOpacity}">
      <button class="music-pip-btn stream-pip-fullscreen" title="${t('media.fullscreen')}">⤢</button>
      <button class="music-pip-btn stream-pip-close" title="${t('modals.common.close')}">✕</button>
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
  pipVideo.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });

  const popoutBtn = tile.querySelector('.stream-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = t('media.pop_in_camera'); }
  tile.classList.add('webcam-popped-out');

  const popIn = () => {
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = t('media.pop_out_camera'); }
    tile.classList.remove('webcam-popped-out');
  };

  const closePip = () => {
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = t('media.pop_out_camera'); }
    tile.classList.remove('webcam-popped-out');
  };

  pip.querySelector('.stream-pip-popin').addEventListener('click', popIn);
  pip.querySelector('.stream-pip-close').addEventListener('click', closePip);
  pip.querySelector('.stream-pip-fullscreen').addEventListener('click', (e) => {
    e.stopPropagation();
    const vid = pip.querySelector('video');
    const target = vid || pip;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
    } else {
      (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
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
    // Honour auto-accept setting — show a join prompt instead of opening the
    // tile automatically. Clicking the sharer's live badge counts as the
    // accept for that share, so it skips the prompt too (#5636).
    const accepted = !!(this._acceptedStreams && this._acceptedStreams.has(userId));
    const autoAccept = force || accepted || localStorage.getItem('haven_auto_accept_streams') !== 'false';
    if (!autoAccept && userId !== null && userId !== this.user.id) {
      const who = this.voice.peerName(userId) || t('voice.someone');
      // Keep the offered stream so the live badge can open it after the
      // prompt has gone (#5636).
      if (!this._pendingStreamOffers) this._pendingStreamOffers = new Map();
      this._pendingStreamOffers.set(userId, stream);
      this._showToast(t('voice.sharing_started', { who: this._escapeHtml(who) }), 'info', {
        label: t('voice_runtime.join'),
        onClick: () => this._handleScreenStream(userId, stream, { force: true })
      }, 8000);
      return;
    }
    this._pendingStreamOffers?.delete(userId);

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
      const name = this.voice.peerName(userId);
      const who = userId === null || userId === this.user.id ? t('voice_runtime.you') : (name || t('voice.someone'));
      lbl.textContent = who;
      tile.appendChild(lbl);

      // Audio controls overlay (volume + mute for stream audio)
      const controls = document.createElement('div');
      controls.className = 'stream-audio-controls';
      controls.id = `stream-controls-${userId || 'self'}`;

      const muteBtn = document.createElement('button');
      muteBtn.className = 'stream-mute-btn';
      muteBtn.title = t('media.stream_mute');
      muteBtn.textContent = '🔊';
      muteBtn.dataset.muted = 'false';

      const volSlider = document.createElement('input');
      volSlider.type = 'range';
      volSlider.className = 'stream-vol-slider';
      volSlider.min = '0';
      volSlider.max = '200';
      volSlider.title = t('media.stream_volume');

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
        } catch { /* storage blocked or corrupt: the volume holds for this session only */ }
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
      popoutBtn.title = t('media.pop_out_stream');
      popoutBtn.textContent = '⧉';
      popoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._popOutStream(tile, userId);
      });
      tile.appendChild(popoutBtn);

      // Fullscreen button — makes the video element fill the screen
      const fsBtn = document.createElement('button');
      fsBtn.className = 'stream-fullscreen-btn';
      fsBtn.title = t('media.fullscreen');
      fsBtn.textContent = '⛶';
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = tile.querySelector('video');
        const target = vid || tile;
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
        } else {
          (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
        }
      });
      tile.appendChild(fsBtn);

      // Minimize button — hides tile but KEEPS audio playing
      const minBtn = document.createElement('button');
      minBtn.className = 'stream-minimize-btn';
      minBtn.title = t('media.stream_minimize');
      minBtn.textContent = '─';
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideStreamTile(tile, userId, who, false);
      });
      tile.appendChild(minBtn);

      // Close button — hides tile and mutes its audio (can be restored from hidden bar)
      const closeBtn = document.createElement('button');
      closeBtn.className = 'stream-close-btn';
      closeBtn.title = t('media.stream_close');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideStreamTile(tile, userId, who, true);
      });
      tile.appendChild(closeBtn);

      grid.appendChild(tile);
    }

    // A share the viewer had to accept may have had its audio parked while
    // the Join prompt was up. The tile exists now, so let it play (#5636).
    if (userId !== null && userId !== this.user.id) this.voice.flushPendingScreenAudio?.(userId);

    // Show the container BEFORE assigning srcObject — browsers won't decode
    // video frames inside a display:none container, causing a black rectangle
    // that only fixes itself on layout reflow (e.g. resizing the slider).
    container.style.display = 'flex';

    const videoEl = tile.querySelector('video');
    // Force a layout reflow so the video element has real dimensions
    void videoEl.offsetHeight;
    // Skip srcObject reassignment if the existing stream already wraps the
    // same live video track AND we're already getting frames. WebRTC fires
    // track.onunmute on every transient packet-loss / bitrate-adapt blip;
    // each fire calls back into here with `new MediaStream([sameTrack])`.
    // Reassigning srcObject in those moments kicks the browser out of
    // fullscreen (and pop-out, on some platforms) because the fullscreen
    // element's underlying media briefly "changes". Only swap if the track
    // is actually different or we don't have frames yet.
    const newVideoTrack = stream.getVideoTracks()[0] || null;
    const curStream = videoEl.srcObject;
    const curVideoTrack = curStream ? (curStream.getVideoTracks?.()[0] || null) : null;
    // If the currently attached track is dead (readyState !== 'live'), we MUST
    // reassign — even if the new track has the same id, the browser will keep
    // rendering a black frame from the dead source. This happens on reshare
    // when the sharer's stopScreenShare ends the track but the viewer's
    // element still holds a reference to that dead MediaStreamTrack.
    const curTrackIsDead = !!curVideoTrack && curVideoTrack.readyState !== 'live';
    const sameLiveTrack = !curTrackIsDead &&
      newVideoTrack && curVideoTrack &&
      newVideoTrack.id === curVideoTrack.id &&
      newVideoTrack.readyState === 'live' &&
      videoEl.videoWidth > 0;
    if (!sameLiveTrack) {
      // Force re-render if the same stream is re-assigned (otherwise it's a no-op → black screen)
      if (videoEl.srcObject === stream) {
        videoEl.srcObject = null;
      }
      videoEl.srcObject = stream;
    }
    videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
    // Also re-play when metadata loads (handles late-arriving tracks)
    videoEl.onloadedmetadata = () => { videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ }); };

    // WebRTC video tracks often arrive muted (no frames yet). Retry playback
    // until the video actually has dimensions, which means frames are flowing.
    let _retries = 0;
    let _renegotiateRequested = false;
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
        // After ~3s of no frames, ask the sharer to re-issue the offer.
        // A hung renegotiation on the sharer side, an ICE restart that
        // didn't carry video, or simply a dropped voice-offer all leave
        // the receiver with audio-but-no-video. Asking for a renegotiate
        // is the only way to recover without a full leave/rejoin.
        // (#5347 v3.15.5)
        if (!_renegotiateRequested && _retries >= 6 &&
            this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
          _renegotiateRequested = true;
          this.socket.emit('request-screen-renegotiate', {
            code: this.voice.currentChannel,
            sharerId: userId
          });
        }
        videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
        setTimeout(_retryPlay, 500);
      }
    };
    setTimeout(_retryPlay, 600);
    this._startStreamStallWatchdog(tileId, userId);
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
    // Stream ended — remove this tile. The next share from this person gets
    // the prompt again, and any offer that never got a tile is gone (#5636).
    this._pendingStreamOffers?.delete(userId);
    this._acceptedStreams?.delete(userId);
    const tileId = `screen-tile-${userId || 'self'}`;
    this._cancelScreenNoAudioTimer(userId);
    this._removeScreenSharePiP(userId);
    this._stopStreamStallWatchdog(tileId);
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
        ssBtn.title = t('voice.screen_share');
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

// ── Stream Frame-Progress Watchdog ───────────────────────
//
// `videoWidth > 0` only proves that metadata arrived once. On a reshare the
// element keeps the dimensions of the stream it was previously showing, so a
// tile can sit on a frozen or black frame indefinitely while videoWidth reads
// as healthy — and _retryPlay, which bails the moment videoWidth is non-zero,
// never runs. That is the "black screen until I dragged the resize slider"
// case: the slider forced a reflow, which nudged the decoder, which is not a
// recovery path anyone should have to discover.
//
// Watch the decoded-frame counter instead. It is the only signal that says
// frames are actually arriving *now*.
_startStreamStallWatchdog(tileId, userId) {
  if (!this._streamStallTimers) this._streamStallTimers = {};
  this._stopStreamStallWatchdog(tileId);

  const readFrames = (videoEl) => {
    try {
      const q = videoEl.getVideoPlaybackQuality && videoEl.getVideoPlaybackQuality();
      if (q && typeof q.totalVideoFrames === 'number') return q.totalVideoFrames;
    } catch { /* no playback stats: fall back to the WebKit counter below */ }
    return typeof videoEl.webkitDecodedFrameCount === 'number'
      ? videoEl.webkitDecodedFrameCount
      : -1;
  };

  let lastFrames = -1;
  let stalls = 0;

  this._streamStallTimers[tileId] = setInterval(() => {
    const tile = document.getElementById(tileId);
    const videoEl = tile && tile.querySelector('video');
    if (!tile || !videoEl || !videoEl.srcObject) {
      this._stopStreamStallWatchdog(tileId);
      return;
    }
    // A hidden tile or a backgrounded window legitimately stops decoding.
    // Treating that as a stall would spam the sharer with renegotiate
    // requests every time someone minimises a stream.
    if (tile.dataset.hidden === 'true' || document.hidden) { stalls = 0; return; }

    const track = videoEl.srcObject.getVideoTracks
      ? videoEl.srcObject.getVideoTracks()[0]
      : null;
    // Nothing is meant to be flowing — not a stall.
    if (!track || track.readyState !== 'live' || track.muted) { stalls = 0; return; }

    const frames = readFrames(videoEl);
    if (frames < 0) { this._stopStreamStallWatchdog(tileId); return; } // unsupported

    if (frames > lastFrames) {
      lastFrames = frames;
      stalls = 0;
      return;
    }

    stalls++;
    if (stalls === 2) {
      // ~3s without a new frame. Re-attach the stream: a fresh srcObject
      // assignment rebuilds the element's decode pipeline, which is what the
      // accidental resize was really doing.
      console.warn('[Stream] No frames for', tileId, '— re-attaching srcObject');
      const s = videoEl.srcObject;
      videoEl.srcObject = null;
      videoEl.srcObject = s;
      videoEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
    } else if (stalls === 4 && userId && userId !== this.user.id &&
               this.voice && this.voice.inVoice) {
      // ~6s. Re-attaching didn't help, so the problem is upstream of us.
      //
      // The budget below is the fix for the loop @RCCore identified (#5426).
      // A renegotiation delivers a new stream, which re-arms this watchdog
      // with stalls back at 0, so the `stalls >= 12` give-up further down was
      // unreachable: every request reset the counter that was supposed to
      // stop the requests. On a link that is dropping frames for bandwidth
      // reasons rather than signalling reasons, each renegotiation interrupts
      // the buffer and causes the very stall that triggers the next one.
      //
      // The budget lives on `this` keyed by sharer, so it survives re-arms,
      // and it backs off rather than hammering at a fixed interval.
      if (!this._renegBudget) this._renegBudget = {};
      const now = Date.now();
      const b = this._renegBudget[userId] || { count: 0, nextAllowed: 0, windowStart: now };
      if (now - b.windowStart > 120000) { b.count = 0; b.windowStart = now; }

      if (b.count >= 3) {
        console.warn('[Stream] Renegotiate budget spent for', userId,
          '— not asking again this window. The stream is likely bandwidth-starved, not stuck.');
      } else if (now < b.nextAllowed) {
        // Backing off; say nothing and let the next tick reconsider.
      } else {
        b.count++;
        b.nextAllowed = now + (5000 * b.count);   // 5s, 10s, 15s
        this._renegBudget[userId] = b;
        console.warn('[Stream] Still no frames for', tileId, '— requesting renegotiate',
          `(${b.count}/3 this window)`);
        this.socket.emit('request-screen-renegotiate', {
          code: this.voice.currentChannel,
          sharerId: userId
        });
      }
      this._renegBudget[userId] = b;
    } else if (stalls >= 12) {
      // ~18s of nothing after both recovery attempts. Stop burning a timer;
      // a fresh share or rejoin will re-arm this.
      console.warn('[Stream] Giving up frame watchdog for', tileId);
      this._stopStreamStallWatchdog(tileId);
    }
  }, 1500);
},

_stopStreamStallWatchdog(tileId) {
  if (this._streamStallTimers && this._streamStallTimers[tileId]) {
    clearInterval(this._streamStallTimers[tileId]);
    delete this._streamStallTimers[tileId];
  }
},

};
