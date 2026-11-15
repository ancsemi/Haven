// Voice and music controls: join and leave buttons, the music player, audio
// and camera device pickers, stream and webcam layout, noise suppression,
// screen share quality, and the callbacks the voice engine reports through.

export default {

_bindVoiceControls() {
  // Voice buttons
  document.getElementById('voice-join-btn').addEventListener('click', () => this._joinVoice());
  document.getElementById('voice-join-mobile')?.addEventListener('click', () => {
    this._joinVoice();
    this._closeMobilePanels();
  });
  document.getElementById('voice-mute-btn').addEventListener('click', () => this._toggleMute());
  document.getElementById('voice-deafen-btn').addEventListener('click', () => this._toggleDeafen());
  document.getElementById('voice-mute-btn-header')?.addEventListener('click', () => this._toggleMute());
  document.getElementById('voice-deafen-btn-header')?.addEventListener('click', () => this._toggleDeafen());
  document.getElementById('voice-leave-sidebar-btn').addEventListener('click', () => this._leaveVoice());
  document.getElementById('voice-cam-btn').addEventListener('click', () => this._toggleWebcam());
  document.getElementById('screen-share-btn').addEventListener('click', () => this._toggleScreenShare());
  document.getElementById('voice-soundboard-btn')?.addEventListener('click', () => this._openSoundModal('soundboard'));
  document.getElementById('voice-listen-together-btn')?.addEventListener('click', () => this._openMusicModal());
  document.getElementById('screen-share-minimize').addEventListener('click', () => this._hideScreenShare());
  document.getElementById('screen-share-close').addEventListener('click', () => this._closeScreenShare());
  document.getElementById('webcam-collapse-btn').addEventListener('click', () => {
    const wc = document.getElementById('webcam-container');
    if (wc) {
      wc.style.display = 'none';
      // Show a restore indicator in the channel header
      const grid = document.getElementById('webcam-grid');
      const count = grid ? grid.children.length : 0;
      if (count > 0) this._showWebcamIndicator(count);
    }
  });
  document.getElementById('webcam-close-btn').addEventListener('click', () => {
    this._closeWebcam();
  });

  // Music controls
  document.getElementById('music-share-btn')?.addEventListener('click', () => this._openMusicModal());
  document.getElementById('share-music-btn').addEventListener('click', () => this._shareMusic());
  document.getElementById('share-music-playlist-btn')?.addEventListener('click', () => this._shareMusicPlaylist());
  document.getElementById('cancel-music-btn').addEventListener('click', () => this._closeMusicModal());
  document.getElementById('music-modal').addEventListener('click', (e) => {
    if (e.target.id === 'music-modal') this._closeMusicModal();
  });
  document.getElementById('music-stop-btn').addEventListener('click', () => this._stopMusic());
  document.getElementById('music-close-btn').addEventListener('click', () => {
    this._minimizeMusicPanel();
  });
  document.getElementById('music-queue-btn')?.addEventListener('click', () => this._openMusicQueueModal());
  document.getElementById('close-music-queue-btn')?.addEventListener('click', () => this._closeMusicQueueModal());
  document.getElementById('shuffle-music-queue-btn')?.addEventListener('click', () => this._shuffleMusicQueue());
  document.getElementById('music-queue-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'music-queue-modal') this._closeMusicQueueModal();
  });
  document.getElementById('music-popout-btn').addEventListener('click', () => this._popOutMusicPlayer());
  document.getElementById('music-play-pause-btn').addEventListener('click', () => this._toggleMusicPlayPause());
  document.getElementById('music-next-btn').addEventListener('click', () => this._musicTrackControl('next'));
  document.getElementById('music-mute-btn').addEventListener('click', () => this._toggleMusicMute());
  document.getElementById('music-volume-slider').addEventListener('input', (e) => {
    this._setMusicVolume(parseInt(e.target.value));
  });
  // Seek slider: user drags to scrub position
  const seekSlider = document.getElementById('music-seek-slider');
  seekSlider.addEventListener('input', () => { this._musicSeeking = true; });
  seekSlider.addEventListener('change', (e) => {
    this._musicSeeking = false;
    const pct = parseFloat(e.target.value);
    this._suppressMusicBroadcasts();
    this._seekMusic(pct);
    this._withMusicDuration((durationSeconds) => {
      const positionSeconds = durationSeconds > 0 ? (durationSeconds * pct) / 100 : 0;
      this._emitMusicSeek(positionSeconds, durationSeconds);
    });
    this._setMusicActivityHint(t('media.music_seeked'));
  });
  document.getElementById('music-link-input').addEventListener('input', (e) => {
    this._previewMusicLink(e.target.value.trim());
  });
  document.getElementById('music-link-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); this._shareMusic(); }
  });

  // Voice controls, now pinned at bottom of right sidebar
  // The header voice-active-indicator opens the RIGHT sidebar on mobile
  document.getElementById('voice-active-indicator')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // On mobile, open the RIGHT sidebar so the user can access voice controls
    const appBody = document.getElementById('app-body');
    if (window.innerWidth <= 900 && appBody) {
      appBody.classList.add('mobile-right-open');
      // Activate the mobile-overlay backdrop too, so tap-outside-to-close
      // works the same way as it does for the Members button. Without this
      // the sidebar slides in but the dim overlay never appears (#5385).
      document.getElementById('mobile-overlay')?.classList.add('active');
    }
  });

  // Voice settings slide-up toggle
  document.getElementById('voice-settings-toggle')?.addEventListener('click', () => {
    const panel = document.getElementById('voice-settings-panel');
    if (!panel) return;
    const btn = document.getElementById('voice-settings-toggle');
    if (panel.style.display === 'none') {
      panel.style.display = '';
      if (btn) btn.classList.add('active');
      // Populate audio device dropdowns each time panel opens
      this.callSettingsDevices.refresh();
    } else {
      panel.style.display = 'none';
      if (btn) btn.classList.remove('active');
    }
  });

  // The settings panel itself (devices, camera, noise, screen share).
  this._mountVoiceSettingsPanel();
  // The same settings as a Settings page, usable outside a call.
  this._mountCallSettingsPage?.();

  // Stream size slider
  const streamSizeSlider = document.getElementById('stream-size-slider');
  if (streamSizeSlider) {
    const savedSize = localStorage.getItem('haven_stream_size');
    if (savedSize) streamSizeSlider.value = savedSize;
    let _resizeRAF = null;
    const applySize = () => {
      if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
      _resizeRAF = requestAnimationFrame(() => {
        // Auto-exit fullscreen (focus mode) when user adjusts the size slider
        const container = document.getElementById('screen-share-container');
        const grid = document.getElementById('screen-share-grid');
        if (container.classList.contains('stream-focus-mode')) {
          grid.querySelectorAll('.screen-share-tile').forEach(t => t.classList.remove('stream-focused'));
          container.classList.remove('stream-focus-mode');
        }
        const vh = parseInt(streamSizeSlider.value, 10);
        container.style.maxHeight = vh + 'vh';
        grid.style.maxHeight = (vh - 2) + 'vh';
        document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
        localStorage.setItem('haven_stream_size', vh);
        _resizeRAF = null;
      });
    };
    applySize();
    streamSizeSlider.addEventListener('input', applySize);
  }

  // ── Stream layout picker ──
  const layoutBtn = document.getElementById('stream-layout-btn');
  const layoutMenu = document.getElementById('stream-layout-menu');
  if (layoutBtn && layoutMenu) {
    const savedLayout = localStorage.getItem('haven_stream_layout') || 'auto';
    this._applyStreamLayout(savedLayout);
    layoutMenu.querySelector(`[data-layout="${savedLayout}"]`)?.classList.add('active');

    layoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layoutMenu.classList.toggle('open');
    });
    layoutMenu.querySelectorAll('.stream-layout-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.dataset.layout;
        layoutMenu.querySelectorAll('.stream-layout-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this._applyStreamLayout(mode);
        localStorage.setItem('haven_stream_layout', mode);
        layoutMenu.classList.remove('open');
      });
    });
    document.addEventListener('click', () => layoutMenu.classList.remove('open'));
  }

  // ── Webcam size slider ──
  const webcamSizeSlider = document.getElementById('webcam-size-slider');
  if (webcamSizeSlider) {
    const savedWcSize = localStorage.getItem('haven_webcam_size');
    if (savedWcSize) webcamSizeSlider.value = savedWcSize;
    let _wcResizeRAF = null;
    const applyWcSize = () => {
      if (_wcResizeRAF) cancelAnimationFrame(_wcResizeRAF);
      _wcResizeRAF = requestAnimationFrame(() => {
        const container = document.getElementById('webcam-container');
        const grid = document.getElementById('webcam-grid');
        // Auto-exit focus mode when resizing
        if (container.classList.contains('webcam-focus-mode')) {
          grid.querySelectorAll('.webcam-tile').forEach(t => t.classList.remove('webcam-focused'));
          container.classList.remove('webcam-focus-mode');
        }
        const vh = parseInt(webcamSizeSlider.value, 10);
        container.style.maxHeight = vh + 'vh';
        grid.style.maxHeight = (vh - 2) + 'vh';
        // Scale tile width proportionally with the slider
        const tileMaxW = Math.max(vh * 1.33, 15); // ~4:3 aspect ratio
        document.querySelectorAll('.webcam-tile').forEach(t => { t.style.maxWidth = tileMaxW + 'vw'; });
        document.querySelectorAll('.webcam-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
        localStorage.setItem('haven_webcam_size', vh);
        _wcResizeRAF = null;
      });
    };
    applyWcSize();
    webcamSizeSlider.addEventListener('input', applyWcSize);
  }

  // ── Webcam layout picker ──
  const wcLayoutBtn = document.getElementById('webcam-layout-btn');
  const wcLayoutMenu = document.getElementById('webcam-layout-menu');
  if (wcLayoutBtn && wcLayoutMenu) {
    const savedWcLayout = localStorage.getItem('haven_webcam_layout') || 'auto';
    this._applyWebcamLayout(savedWcLayout);
    wcLayoutMenu.querySelector(`[data-layout="${savedWcLayout}"]`)?.classList.add('active');

    wcLayoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      wcLayoutMenu.classList.toggle('open');
    });
    wcLayoutMenu.querySelectorAll('.stream-layout-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.dataset.layout;
        wcLayoutMenu.querySelectorAll('.stream-layout-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this._applyWebcamLayout(mode);
        localStorage.setItem('haven_webcam_layout', mode);
        wcLayoutMenu.classList.remove('open');
      });
    });
    document.addEventListener('click', () => wcLayoutMenu.classList.remove('open'));
  }

  // ── Webcam collapse button ── (handler already bound above)

  // Wire up the voice manager's video callback
  this.voice.onScreenStream = (userId, stream) => this._handleScreenStream(userId, stream);
  // Wire up webcam video callback
  this.voice.onWebcamStream = (userId, stream) => this._handleWebcamStream(userId, stream);
  // Wire up screen share audio callback
  this.voice.onScreenAudio = (userId) => this._handleScreenAudio(userId);
  // Wire up no-audio indicator for streams without audio
  this.voice.onScreenNoAudio = (userId) => this._handleScreenNoAudio(userId);

  // Wire up voice join/leave audio cues + Desktop OS notifications
  this.voice.onVoiceJoin = (userId, username) => {
    this.notifications.playDirect('voice_join');
    if (window.havenDesktop?.notify && userId !== this.user?.id && this.notifications.popupAllowed()) {
      const name = this._getNickname(userId, username) || username;
      window.havenDesktop.notify(t('voice.notification_title'), t('voice.joined_notification', { name }), { silent: true });
    }
  };
  this.voice.onVoiceLeave = (userId, username) => {
    this.notifications.playDirect('voice_leave');
    if (window.havenDesktop?.notify && userId !== this.user?.id && this.notifications.popupAllowed()) {
      const name = this._getNickname(userId, username) || username;
      window.havenDesktop.notify(t('voice.notification_title'), t('voice.left_notification', { name }), { silent: true });
    }
  };
  // Wire up screen share start audio cue
  this.voice.onScreenShareStarted = (userId, username) => {
    this.notifications.playDirect('stream_start');
  };

  // Clear the per-sharer renegotiation budget when they deliberately start a
  // new share, so the loop guard from #5426 does not carry a spent budget
  // over from a previous stream.
  this.voice.onScreenShareRestart = (userId) => {
    if (this._renegBudget) delete this._renegBudget[userId];
    this._resetScreenShareUiState(userId);
  };

  // Wire up AFK auto-move
  this.voice.onAfkLeave = (minutes) => {
    this._showToast(t('voice.left_for_afk', { minutes }), 'info');
  };
  this.voice.onAfkMove = (channelCode) => {
    this._showToast(t('voice.moved_to_afk'), 'info');
    this._updateVoiceButtons(false);
    this._updateVoiceStatus(false);
    this._updateVoiceBar();
    // Switch to the AFK channel and rejoin voice there
    this.switchChannel(channelCode);
    setTimeout(() => this._joinVoice(), 500);
  };

  // Wire up voice-kicked (joined from another client/tab)
  this.voice.onVoiceKicked = (channelCode, reason) => {
    this._showToast(reason || t('voice.disconnected_other_client'), 'info');
    this._updateVoiceButtons(false);
    this._updateVoiceStatus(false);
    this._updateVoiceBar();
  };
  // Re-render voice user list when webcam status changes
  this.voice.onWebcamStatusChange = () => {
    if (this._lastVoiceUsers) this._renderVoiceUsers(this._lastVoiceUsers);
  };

  // Surface a STUN/connectivity failure so external-network users aren't left
  // staring at "ICE: Connecting..." with no clue why (#5399).
  this.voice.onConnectivityWarning = (msg) => {
    this._showToast(msg, 'error', null, 12000);
  };

  // Wire up talking indicator
  this.voice.onTalkingChange = (userId, isTalking) => {
    const resolvedId = userId === 'self' ? this.user.id : userId;
    document.querySelectorAll(`.channel-voice-user[data-user-id="${resolvedId}"], .voice-user-item[data-user-id="${resolvedId}"]`).forEach(el => {
      el.classList.toggle('talking', isTalking);
    });
    // Speaking counts as activity: reset idle timer so presence stays online
    // and the server gets a voice-activity ping for AFK tracking
    if (userId === 'self' && isTalking) this._resetIdle?.();
  };

  // Watch for the voice UI drifting out of step with the actual session
  // (see _reconcileVoiceUi) and repair it instead of stranding the user on a
  // "Join Voice" button while they're still in the call.
  this._startVoiceUiReconciler?.();

  this._redirectFileVideoFullscreen();
},

_redirectFileVideoFullscreen() {
  const ask = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (opts) {
    const wrap = this.classList?.contains('file-video') && !document.documentElement.hasAttribute('data-desktop-app') && this.closest('.file-video-wrap');
    return ask.call(wrap || this, opts);
  };
},

};
