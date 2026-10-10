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
      this._populateAudioDevices();
    } else {
      panel.style.display = 'none';
      if (btn) btn.classList.remove('active');
    }
  });

  // ── Audio device dropdowns (input & output & camera) ──
  const inputDeviceSelect  = document.getElementById('voice-input-device');
  const outputDeviceSelect = document.getElementById('voice-output-device');
  const camDeviceSelect    = document.getElementById('voice-cam-device');
  if (inputDeviceSelect) {
    inputDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      localStorage.setItem('haven_input_device', deviceId);
      // Hot-swap if in voice
      if (this.voice && this.voice.inVoice) {
        this.voice.switchInputDevice(deviceId);
      }
    });
  }
  if (outputDeviceSelect) {
    outputDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      localStorage.setItem('haven_output_device', deviceId);
      // Hot-swap output
      if (this.voice) {
        this.voice.switchOutputDevice(deviceId);
      }
    });
  }
  if (camDeviceSelect) {
    camDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      localStorage.setItem('haven_cam_device', deviceId);
      // Hot-swap camera if webcam is active
      if (this.voice && this.voice.isWebcamActive) {
        this.voice.switchCamera(deviceId);
      }
    });
  }
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

  // ── Noise mode selector ──
  const noiseModeSelect = document.getElementById('voice-noise-mode');
  const noiseGateRow = document.getElementById('noise-gate-row');
  const nsSlider = document.getElementById('voice-ns-slider');

  // Restore saved mode
  const savedNoiseMode = localStorage.getItem('haven_noise_mode') || 'gate';
  noiseModeSelect.value = savedNoiseMode;
  noiseGateRow.style.display = savedNoiseMode === 'gate' ? '' : 'none';

  noiseModeSelect.addEventListener('change', (e) => {
    const mode = e.target.value;
    noiseGateRow.style.display = mode === 'gate' ? '' : 'none';
    if (this.voice) this.voice.setNoiseMode(mode);
    // Update mic meter threshold visibility
    if (mode === 'gate') {
      this._updateMicMeterThreshold(parseInt(nsSlider.value, 10));
    } else {
      this._updateMicMeterThreshold(0);
    }
  });

  nsSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (this.voice && this.voice.inVoice) {
      this.voice.setNoiseSensitivity(val);
    }
    localStorage.setItem('haven_ns_value', val);
    this._updateMicMeterThreshold(val);
  });

  // Restore saved gate sensitivity
  const savedNsVal = localStorage.getItem('haven_ns_value');
  if (savedNsVal !== null) nsSlider.value = savedNsVal;

  // ── Mic level meter ──
  this._micMeterFill = document.getElementById('mic-meter-fill');
  this._micMeterThreshold = document.getElementById('mic-meter-threshold');
  this._micMeterRAF = null;
  this._updateMicMeterThreshold(savedNoiseMode === 'gate' ? parseInt(nsSlider.value, 10) : 0);
  this._startMicMeter();

  // ── Screen share quality dropdowns ──
  const screenResSelect = document.getElementById('screen-res-select');
  const screenFpsSelect = document.getElementById('screen-fps-select');
  if (screenResSelect) {
    // Restore saved value (0 = "source")
    const savedRes = localStorage.getItem('haven_screen_res') || '1080';
    screenResSelect.value = savedRes === '0' ? 'source' : savedRes;
    screenResSelect.addEventListener('change', (e) => {
      const val = e.target.value === 'source' ? 0 : parseInt(e.target.value, 10);
      this.voice.setScreenResolution(val);
    });
  }
  // ── Screen share bitrate stepper (300 to 10000 Kbps + unlimited) ──
  // The value is an editable input: type a number and confirm with Enter or
  // by leaving the field; out-of-range input clamps to the nearest bound.
  // Holding a step button auto-repeats with acceleration.
  const bitrateMinus = document.getElementById('screen-bitrate-minus');
  const bitratePlus = document.getElementById('screen-bitrate-plus');
  const bitrateValue = document.getElementById('screen-bitrate-value');
  // Commit guards: declared up here, above commitBitrateInput. ES modules run
  // in strict mode, so assigning before the `let` executes throws
  // "bitrateBlurSuppressed is not defined" on every typed commit (#5672).
  let bitrateEscapePressed = false;
  let bitrateBlurSuppressed = false;
  // Unconditional field write. Stepper presses are explicit user intent to
  // change the value, so they must sync the field even while it is focused:
  // button pointerdown is preventDefaulted (focus stays in the field) and
  // renderBitrate skips focused inputs. Without this, the field keeps the
  // stale text and the next blur re-commits it, silently reverting the step
  // (and re-applying the old cap to a live share).
  const writeBitrateField = (kbps) => {
    if (!bitrateValue) return;
    if ('value' in bitrateValue) {
      bitrateValue.value = kbps > 0 ? `${kbps} Kbps` : t('voice_settings.bitrate_unlimited');
    } else {
      bitrateValue.textContent = kbps > 0 ? `${kbps} Kbps` : t('voice_settings.bitrate_unlimited');
    }
  };
  const renderBitrate = (kbps) => {
    if (!bitrateValue) return;
    if (document.activeElement === bitrateValue) return; // don't fight typing
    writeBitrateField(kbps);
  };
  const parseBitrateInput = () => {
    const raw = String(bitrateValue?.value ?? bitrateValue?.textContent ?? '').toLowerCase();
    // "unlimited"/"ilimitado" (or empty unit text) means uncapped.
    if (/unlimited|ilimitado|inf/.test(raw)) return 0;
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return null;
    const n = parseInt(digits, 10);
    if (!Number.isSafeInteger(n)) return null;
    if (n <= 0) return 0;
    if (n < 300) return 300;
    if (n > 10000) return 0; // above the range wraps to unlimited
    return n;
  };
  const commitBitrateInput = () => {
    const parsed = parseBitrateInput();
    if (parsed === null) {
      renderBitrate(this.voice.screenBitrate);
      return;
    }
    this.voice.setScreenBitrate(parsed);
    // The programmatic blur below re-fires the blur listener: suppress that
    // second commit (Enter confirmed once already). The flag wraps a
    // synchronous blur() dispatch.
    if (bitrateValue && 'value' in bitrateValue) {
      bitrateBlurSuppressed = true;
      try { bitrateValue.blur?.(); } finally { bitrateBlurSuppressed = false; }
    }
    renderBitrate(this.voice.screenBitrate);
  };
  const stepBitrate = (dir) => {
    const cur = this.voice.screenBitrate || 0;
    let next;
    if (dir < 0) {
      // From unlimited, step down into the top of the range.
      next = cur === 0 ? 10000 : cur - 100;
    } else {
      // Past the top of the range wraps to unlimited.
      next = cur === 0 ? 300 : cur + 100;
    }
    this.voice.setScreenBitrate(next);
    writeBitrateField(this.voice.screenBitrate);
  };
  // Press-and-hold auto-repeat: first repeat after 400 ms, then every 80 ms
  // with the step doubling every ~10 repeats so long holds move fast.
  const holdRepeat = (button, dir) => {
    if (!button) return;
    let timer = null;
    let interval = null;
    let repeats = 0;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(interval);
      timer = interval = null;
      repeats = 0;
    };
    const tick = () => {
      repeats++;
      const magnitude = repeats > 20 ? 400 : repeats > 10 ? 200 : 100;
      const cur = this.voice.screenBitrate || 0;
      let next;
      if (dir < 0) {
        // From unlimited, step down into the top of the range; from a capped
        // value, saturate at the 300 floor. A raw `cur - magnitude` can land
        // exactly on 0 (e.g. 400 − 400), which means unlimited. A hold
        // sliding down must never jump to uncapped.
        if (cur === 0) next = 10000;
        else next = Math.max(300, cur - magnitude);
      } else {
        next = cur === 0 ? 300 : cur + magnitude;
      }
      this.voice.setScreenBitrate(next);
      writeBitrateField(this.voice.screenBitrate);
    };
    let pressed = false;
    // Active pointer for the current press: a second finger's pointerdown is
    // ignored instead of overwriting `timer` and leaking the first press's
    // timeout (which would arm an interval after both fingers lifted).
    let activePointerId = null;
    button.addEventListener('pointerdown', (e) => {
      if (activePointerId !== null) return; // multitouch: keep the first press
      e.preventDefault();
      activePointerId = e.pointerId ?? 'mouse';
      pressed = true;
      stepBitrate(dir); // immediate single step on press
      timer = setTimeout(() => {
        interval = setInterval(tick, 80);
      }, 400);
    });
    // Keyboard activation (Enter/Space) fires click with detail === 0 and no
    // pointerdown. Pointer clicks carry detail >= 1. Checking detail (not just
    // `pressed`) means a stale `pressed` from a drag-off release can never
    // swallow the next keyboard activation, while a pointer click following
    // its own pointerdown is still consumed exactly once, including the
    // touch sequence pointerup → pointerleave → click. A keyboard step never
    // touches the active pointer's state: its timers and trailing click still
    // belong to that press, so a second finger stays ignored instead of
    // overwriting `timer` and leaking an interval.
    button.addEventListener('click', (e) => {
      if (e && e.detail === 0) {
        stepBitrate(dir);
        return;
      }
      if (pressed) { pressed = false; return; }
      stepBitrate(dir);
    });
    const clearPress = (e) => {
      // Only the press's own pointer may end it; another pointer's leave must
      // not disarm the active hold.
      if (e && e.pointerId !== undefined && activePointerId !== null &&
          e.pointerId !== activePointerId) return;
      activePointerId = null;
      stop();
    };
    // pointerup is followed by click, which consumes `pressed` above. The
    // flag itself is left for click, but the timers stop here. pointerleave
    // must NOT clear `pressed`: on touch the sequence is pointerup →
    // pointerleave → click, so clearing on leave would double-step.
    // pointercancel is never followed by click, so it clears both.
    button.addEventListener('pointerup', clearPress);
    button.addEventListener('pointerleave', (e) => {
      // End the hold timers and release the pointer guard so the next press
      // works even after a drag-off release outside the button (which sends
      // no pointerup/click here). `pressed` is deliberately kept for the
      // trailing click: on touch the sequence is pointerup → pointerleave →
      // click, so clearing it here would double-step. A stale `pressed` with
      // no click coming is harmless: the next keyboard click (detail === 0)
      // steps regardless.
      if (e && e.pointerId !== undefined && activePointerId !== null &&
          e.pointerId !== activePointerId) return;
      activePointerId = null;
      stop();
    });
    // pointercancel is never followed by click, so it clears both, but only
    // when it belongs to the active press. Clearing `pressed` before the
    // identity check (as a previous version did) let a second, ignored
    // pointer's cancel disarm the first press, and the trailing click then
    // double-stepped.
    button.addEventListener('pointercancel', (e) => {
      if (e && e.pointerId !== undefined && activePointerId !== null &&
          e.pointerId !== activePointerId) return;
      pressed = false;
      activePointerId = null;
      stop();
    });
  };
  if (bitrateMinus && bitratePlus && bitrateValue) {
    renderBitrate(this.voice.screenBitrate);
    holdRepeat(bitrateMinus, -1);
    holdRepeat(bitratePlus, +1);
    // Escape discards the typed text instead of confirming it: without the
    // flag the blur() below would run commitBitrateInput() and apply the
    // very value the user was cancelling (renderBitrate skips focused inputs).
    // (Flags declared above, next to the other bitrate state.)
    const restoreBitrateDisplay = () => {
      const kbps = this.voice.screenBitrate;
      if ('value' in bitrateValue) {
        bitrateValue.value = kbps > 0 ? `${kbps} Kbps` : t('voice_settings.bitrate_unlimited');
      } else {
        bitrateValue.textContent = kbps > 0 ? `${kbps} Kbps` : t('voice_settings.bitrate_unlimited');
      }
    };
    bitrateValue.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitBitrateInput();
      } else if (e.key === 'Escape') {
        bitrateEscapePressed = true;
        restoreBitrateDisplay();
        bitrateValue.blur?.();
      }
      e.stopPropagation();
    });
    bitrateValue.addEventListener('blur', () => {
      if (bitrateEscapePressed) {
        bitrateEscapePressed = false;
        restoreBitrateDisplay();
        return;
      }
      if (bitrateBlurSuppressed) return; // Enter already committed
      commitBitrateInput();
    });
    bitrateValue.addEventListener('focus', () => {
      bitrateValue.select?.();
    });
  }
  if (screenFpsSelect) {
    const savedFps = localStorage.getItem('haven_screen_fps') || '30';
    screenFpsSelect.value = savedFps;
    screenFpsSelect.addEventListener('change', (e) => {
      this.voice.setScreenFrameRate(parseInt(e.target.value, 10));
    });
  }
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

  // ── File video fullscreen: redirect to wrapper for proper controls ──
  // When a .file-video triggers fullscreen (via native controls), intercept and
  // fullscreen the .file-video-wrap parent instead so controls stay visible.
  if (!document.documentElement.hasAttribute('data-desktop-app')) {
    // Web-only: Desktop app has its own shim in app-preload.js
    const origRequestFS = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (opts) {
      if (this.classList?.contains('file-video')) {
        const wrap = this.closest('.file-video-wrap');
        if (wrap) return origRequestFS.call(wrap, opts);
      }
      return origRequestFS.call(this, opts);
    };
  }
},

};
