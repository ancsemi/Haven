// Screen share and webcam: turning them on and off, showing the video that
// arrives from others, webcam tiles and pop-outs, and the watchdog that
// notices a stream that has stopped moving.

export default {

// NS slider is handled directly via the input event listener in _setupUI

_createFullscreenCallToolbar(tile) {
  const toolbar = document.createElement('div');
  toolbar.className = 'fullscreen-call-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', t('voice.panel.call_controls'));

  const addButton = (className, titleKey, icon, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `fullscreen-call-control ${className}`;
    button.title = t(titleKey);
    button.setAttribute('aria-label', button.title);
    button.textContent = icon;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      return action();
    });
    toolbar.appendChild(button);
    return button;
  };

  addButton('fullscreen-call-mute', 'voice.mute', '🎙️', () => this._toggleMute?.());
  addButton('fullscreen-call-deafen', 'voice.deafen', '🔊', () => this._toggleDeafen?.());
  addButton('fullscreen-call-camera', 'voice.panel.camera', '📷', () => this._toggleWebcam?.());
  addButton('fullscreen-call-share', 'voice.screen_share', '🖥️', () => this._toggleScreenShare?.());

  const picker = document.createElement('select');
  picker.className = 'fullscreen-stream-select';
  picker.title = t('voice_runtime.stream');
  picker.setAttribute('aria-label', t('voice_runtime.stream'));
  picker.addEventListener('click', event => event.stopPropagation());
  picker.addEventListener('change', (event) => {
    event.stopPropagation();
    this._selectFullscreenStream(tile, picker.value);
  });
  toolbar.appendChild(picker);
  if (!this._fullscreenStreamPickers) this._fullscreenStreamPickers = new Map();
  this._fullscreenStreamPickers.set(picker, tile);

  const audioPopover = document.createElement('div');
  audioPopover.className = 'fullscreen-audio-popover';
  audioPopover.hidden = true;
  audioPopover.setAttribute('role', 'group');
  audioPopover.setAttribute('aria-label', t('voice.panel.call_settings'));
  const audioTrigger = addButton('fullscreen-call-audio', 'voice.panel.call_settings', '⚙️', () => {
    this._toggleFullscreenAudioPopover(tile, audioPopover, audioTrigger);
  });
  audioTrigger.setAttribute('aria-expanded', 'false');
  const addDeviceSelect = (kind, labelKey, id) => {
    const label = document.createElement('label');
    label.textContent = t(labelKey);
    const select = document.createElement('select');
    select.id = `${tile.id || 'fullscreen'}-${kind}-device`;
    select.className = `fullscreen-device-select fullscreen-device-${kind}`;
    select.dataset.deviceKind = kind;
    select.setAttribute('aria-label', t(labelKey));
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', (event) => {
      event.stopPropagation();
      this._applyVoiceDeviceSelection?.(kind, select.value);
    });
    label.appendChild(select);
    audioPopover.appendChild(label);
    select.dataset.sourceId = id;
  };
  addDeviceSelect('input', 'voice_settings.input', 'voice-input-device');
  addDeviceSelect('camera', 'voice_settings.camera', 'voice-cam-device');
  addDeviceSelect('output', 'voice_settings.output', 'voice-output-device');
  const volumeLabel = document.createElement('label');
  volumeLabel.textContent = t('settings.sounds_section.volume');
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '200';
  volume.className = 'fullscreen-call-volume';
  volume.setAttribute('aria-label', t('settings.sounds_section.volume'));
  volume.addEventListener('click', event => event.stopPropagation());
  volume.addEventListener('input', (event) => {
    event.stopPropagation();
    const value = Number(volume.value) / 100;
    this.voice?.setVoiceMasterVolume?.(value);
    const mainSlider = document.getElementById('voice-master-volume');
    if (mainSlider) mainSlider.value = volume.value;
    this._syncFullscreenCallVolume();
  });
  volumeLabel.appendChild(volume);
  audioPopover.appendChild(volumeLabel);
  audioPopover.addEventListener('click', event => event.stopPropagation());
  audioPopover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this._closeFullscreenAudioPopover(tile, audioPopover, audioTrigger);
    audioTrigger.focus();
  });
  toolbar.appendChild(audioPopover);
  toolbar.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || audioPopover.hidden) return;
    event.preventDefault();
    this._closeFullscreenAudioPopover(tile, audioPopover, audioTrigger);
    audioTrigger.focus();
  });
  addButton('fullscreen-call-leave', 'voice.disconnect', '✕', () => {
    if (!this.voice?.inVoice) return;
    this._leaveVoice?.();
    this._exitFullscreenCallControls();
  });
  addButton('fullscreen-call-exit', 'media.exit_fullscreen', '⛶', () => this._exitFullscreenCallControls());

  tile.appendChild(toolbar);
  if (!this._fullscreenCallToolbars) this._fullscreenCallToolbars = new Set();
  this._fullscreenCallToolbars.add(toolbar);
  this._bindFullscreenCallTile(tile, toolbar);
  this._refreshFullscreenStreamPicker();
  this._syncFullscreenCallControls();
  return toolbar;
},

_bindFullscreenCallTile(tile, toolbar) {
  if (!this._fullscreenCallTileBindings) this._fullscreenCallTileBindings = new Map();
  if (this._fullscreenCallTileBindings.has(tile)) return;
  const onFullscreenChange = () => {
    const active = this._fullscreenElement() === tile;
    toolbar.hidden = !active;
    tile.classList.toggle('is-fullscreen', active);
    if (active) {
      // Browsers can report the same fullscreen state more than once (and the
      // WebKit-prefixed event may arrive as well). Setting up again would save
      // the already-suffixed label as the original and reset the chosen source.
      if (this._fullscreenCallActiveTile === tile) return;
      // Fullscreen moved straight from another tile: put that one back first,
      // since its own listener may not have run yet.
      if (this._fullscreenCallActiveTile) this._endFullscreenCallTile(this._fullscreenCallActiveTile);
      this._fullscreenCallActiveTile = tile;
      this._fullscreenCallOriginalStream = tile._fullscreenCallSourceStream || tile.querySelector('video')?.srcObject || null;
      this._fullscreenCallSelectedTile = tile;
      tile._fullscreenCallOriginalLabel = this._fullscreenStreamLabelNode(tile)?.textContent ?? null;
      this._setFullscreenVideoSource(tile, tile, this._fullscreenCallOriginalStream);
      this._revealFullscreenCallControls(tile);
      this._refreshFullscreenStreamPicker?.();
    } else {
      this._endFullscreenCallTile(tile);
    }
  };
  const onActivity = () => this._revealFullscreenCallControls(tile);
  // Controls are up only while the pointer is over the screen: hide them the
  // moment it leaves, unless the settings popup is open.
  const onPointerLeave = () => {
    if (this._fullscreenElement() !== tile) return;
    clearTimeout(tile._fullscreenControlsTimer);
    if (tile.classList.contains('fullscreen-popup-open')) return;
    const focused = document.activeElement;
    // A focused button would keep the toolbar showing (:focus-within). A
    // dropdown is left alone so it does not close under the user.
    if (focused && toolbar.contains?.(focused) && focused.matches?.('button')) focused.blur?.();
    tile.classList.add('fullscreen-controls-idle');
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  tile.addEventListener('mouseleave', onPointerLeave);
  tile.addEventListener('mousemove', onActivity);
  tile.addEventListener('touchstart', onActivity, { passive: true });
  tile.addEventListener('focusin', onActivity);
  toolbar.addEventListener('focusin', onActivity);
  toolbar.addEventListener('click', event => event.stopPropagation());
  toolbar.addEventListener('dblclick', event => event.stopPropagation());
  this._fullscreenCallTileBindings.set(tile, { toolbar, onFullscreenChange, onActivity, onPointerLeave });
},

// The element in fullscreen, including the WebKit-prefixed API older Safari uses.
_fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
},

_exitDocumentFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    Promise.resolve(exit.call(document)).catch(() => { /* fullscreen refused or already exited */ });
  } catch { /* fullscreen refused or already exited */ }
},

// Puts a tile back as it was before fullscreen: its own stream and label, the
// settings popup closed, no idle state. Safe to call more than once.
_endFullscreenCallTile(tile) {
  if (this._fullscreenCallActiveTile !== tile) return;
  this._setFullscreenVideoSource(tile, tile, this._fullscreenCallOriginalStream);
  this._restoreFullscreenStreamLabel(tile);
  const toolbar = this._fullscreenCallTileBindings?.get(tile)?.toolbar;
  const audioPopover = toolbar?.querySelector('.fullscreen-audio-popover');
  const audioTrigger = toolbar?.querySelector('.fullscreen-call-audio');
  if (audioPopover && audioTrigger) this._closeFullscreenAudioPopover(tile, audioPopover, audioTrigger);
  this._fullscreenCallActiveTile = null;
  this._fullscreenCallOriginalStream = null;
  this._fullscreenCallSelectedTile = null;
  tile._fullscreenCallOriginalLabel = null;
  clearTimeout(tile._fullscreenControlsTimer);
  tile.classList.remove('fullscreen-controls-idle');
},

_revealFullscreenCallControls(tile) {
  tile.classList.remove('fullscreen-controls-idle');
  clearTimeout(tile._fullscreenControlsTimer);
  if (this._fullscreenElement() !== tile) return;
  tile._fullscreenControlsTimer = setTimeout(() => {
    const binding = this._fullscreenCallTileBindings?.get(tile);
    const hasFocus = !!(binding?.toolbar && document.activeElement &&
      binding.toolbar.contains?.(document.activeElement));
    const hovering = !!binding?.toolbar.matches?.(':hover');
    const popupOpen = tile.classList.contains('fullscreen-popup-open');
    if (!hasFocus && !hovering && !popupOpen && this._fullscreenElement() === tile) {
      tile.classList.add('fullscreen-controls-idle');
    }
  }, 3200);
},

_toggleTileFullscreen(tile) {
  if (this._fullscreenElement()) {
    this._exitDocumentFullscreen();
    return;
  }
  const request = tile.requestFullscreen || tile.webkitRequestFullscreen;
  if (!request) return;
  try {
    Promise.resolve(request.call(tile)).catch(() => { /* fullscreen unavailable in this context */ });
  } catch { /* fullscreen unavailable in this context */ }
},

_exitFullscreenCallControls() {
  if (!this._fullscreenElement() || !this._fullscreenCallActiveTile) return;
  this._exitDocumentFullscreen();
},

_toggleFullscreenAudioPopover(tile, popover, trigger) {
  if (!popover.hidden) {
    this._closeFullscreenAudioPopover(tile, popover, trigger);
    return;
  }
  popover.hidden = false;
  tile.classList.add('fullscreen-popup-open');
  trigger.setAttribute('aria-expanded', 'true');
  this._populateFullscreenAudioPopover(popover);
},

_closeFullscreenAudioPopover(tile, popover, trigger) {
  popover.hidden = true;
  tile.classList.remove('fullscreen-popup-open');
  trigger.setAttribute('aria-expanded', 'false');
},

async _populateFullscreenAudioPopover(popover) {
  try { await this._populateAudioDevices?.(); } catch { /* existing device panel owns enumeration errors */ }
  for (const select of popover.querySelectorAll('select[data-device-kind]')) {
    const source = document.getElementById(select.dataset.sourceId);
    if (!source) continue;
    const options = Array.from(source.options || []).map(option => option.cloneNode(true));
    select.replaceChildren(...options);
    select.value = source.value;
    select.disabled = !!source.disabled;
    select.title = source.title || '';
  }
  this._syncFullscreenCallVolume();
},

_syncFullscreenCallVolume() {
  const mainSlider = document.getElementById('voice-master-volume');
  const volume = this.voice?._voiceMasterLevel?.() ??
    (mainSlider ? Number(mainSlider.value) / 100 : 1);
  for (const toolbar of this._fullscreenCallToolbars || []) {
    const slider = toolbar.querySelector('.fullscreen-call-volume');
    if (slider) slider.value = String(Math.round(volume * 100));
  }
},

_syncFullscreenCallControls() {
  const voice = this.voice;
  const inVoice = !!voice?.inVoice;
  const channel = this.channels?.find(item => item.code === voice?.currentChannel);
  const streamsDisabled = !!channel && channel.streams_enabled === 0;
  for (const toolbar of this._fullscreenCallToolbars || []) {
    const mute = toolbar.querySelector('.fullscreen-call-mute');
    if (mute) {
      const muted = !!voice?.isMuted;
      mute.disabled = !inVoice;
      mute.classList.toggle('muted', muted);
      mute.title = t(muted ? 'voice.unmute' : 'voice.mute');
      mute.setAttribute('aria-label', mute.title);
      mute.setAttribute('aria-pressed', String(muted));
    }
    const camera = toolbar.querySelector('.fullscreen-call-camera');
    if (camera) {
      const active = !!voice?.isWebcamActive;
      camera.disabled = !inVoice || streamsDisabled;
      camera.classList.toggle('sharing', active);
      camera.textContent = active ? '🛑' : '📷';
      camera.title = t(streamsDisabled ? 'voice.streams_disabled' : active ? 'voice.stop_camera' : 'voice.panel.camera');
      camera.setAttribute('aria-label', camera.title);
      camera.setAttribute('aria-pressed', String(active));
    }
    const deafen = toolbar.querySelector('.fullscreen-call-deafen');
    if (deafen) {
      const deafened = !!voice?.isDeafened;
      deafen.disabled = !inVoice;
      deafen.classList.toggle('deafened', deafened);
      deafen.textContent = deafened ? '🔇' : '🔊';
      deafen.title = t(deafened ? 'voice.undeafen' : 'voice.deafen');
      deafen.setAttribute('aria-label', deafen.title);
      deafen.setAttribute('aria-pressed', String(deafened));
    }
    const share = toolbar.querySelector('.fullscreen-call-share');
    if (share) {
      const active = !!voice?.isScreenSharing;
      share.disabled = !inVoice || streamsDisabled;
      share.classList.toggle('sharing', active);
      share.textContent = active ? '🛑' : '🖥️';
      share.title = t(streamsDisabled ? 'voice.streams_disabled' : active ? 'voice.stop_share' : 'voice.screen_share');
      share.setAttribute('aria-label', share.title);
      share.setAttribute('aria-pressed', String(active));
    }
    const leave = toolbar.querySelector('.fullscreen-call-leave');
    if (leave) leave.disabled = !inVoice;
  }
},

_listLiveFullscreenStreams(excludeTile = null) {
  const tiles = document.querySelectorAll('.webcam-tile, .screen-share-tile');
  return Array.from(tiles).flatMap(tile => {
    const isCamera = (tile.className || '').split(/\s+/).includes('webcam-tile');
    const container = isCamera ? document.getElementById('webcam-container') : null;
    if (tile === excludeTile || !tile.parentNode || tile.dataset.hidden === 'true' ||
        tile.classList.contains('webcam-minimized') || tile.classList.contains('stream-hidden') ||
        (container && (container.hidden || container.style.display === 'none'))) return [];
    const video = tile.querySelector('video');
    const stream = tile._fullscreenCallSourceStream || video?.srcObject;
    const track = stream?.getVideoTracks?.().find(item => item.readyState === 'live');
    if (!track) return [];
    const labelNode = this._fullscreenStreamLabelNode(tile);
    const originalLabel = tile === this._fullscreenCallActiveTile ? tile._fullscreenCallOriginalLabel : null;
    const tileUserId = tile._fullscreenCallUserId;
    const isOwnStream = tileUserId == null ||
      (this.user?.id != null && String(tileUserId) === String(this.user.id));
    const who = (isOwnStream && this.user?.username) || originalLabel ||
      labelNode?.textContent || this.voice?.peerName?.(tileUserId) || t('voice.someone');
    return [{ tile, video, stream, label: `${who} · ${t(isCamera ? 'voice.panel.camera' : 'voice.screen_share')}` }];
  });
},

_fullscreenStreamLabelNode(tile) {
  const isCamera = (tile?.className || '').split(/\s+/).includes('webcam-tile');
  return tile?.querySelector(isCamera ? '.webcam-tile-label' : '.screen-share-tile-label') || null;
},

_restoreFullscreenStreamLabel(tile) {
  const label = this._fullscreenStreamLabelNode(tile);
  if (label && tile._fullscreenCallOriginalLabel != null) {
    label.textContent = tile._fullscreenCallOriginalLabel;
  }
},

_updateFullscreenTileSource(tile, stream) {
  for (const { track, handler } of tile._fullscreenCallTrackHandlers || []) {
    track.removeEventListener?.('ended', handler);
  }
  tile._fullscreenCallTrackHandlers = [];
  tile._fullscreenCallSourceStream = stream;
  for (const track of stream?.getVideoTracks?.() || []) {
    if (track.readyState !== 'live' || !track.addEventListener) continue;
    const handler = () => {
      if (tile._fullscreenCallSourceStream !== stream) return;
      const video = tile.querySelector('video');
      this._updateFullscreenTileSource(tile, null);
      if (video?.srcObject === stream) video.srcObject = null;
      this._handleFullscreenSourceEnded(tile);
    };
    track.addEventListener('ended', handler, { once: true });
    tile._fullscreenCallTrackHandlers.push({ track, handler });
  }
  const activeTile = this._fullscreenCallActiveTile;
  if (!activeTile) return;
  if (tile === activeTile) {
    this._fullscreenCallOriginalStream = stream;
    if (this._fullscreenCallSelectedTile && this._fullscreenCallSelectedTile !== tile) {
      const selected = this._fullscreenCallSelectedTile;
      const selectedStream = selected._fullscreenCallSourceStream || selected.querySelector('video')?.srcObject;
      this._setFullscreenVideoSource(activeTile, selected, selectedStream || null);
    } else {
      this._setFullscreenVideoSource(activeTile, tile, stream);
    }
  } else if (this._fullscreenCallSelectedTile === tile && stream) {
    this._setFullscreenVideoSource(activeTile, tile, stream);
  }
},

_setFullscreenVideoSource(targetTile, sourceTile, stream) {
  const video = targetTile?.querySelector('video');
  if (!video) return;
  video.srcObject = stream;
  video.style.transform = sourceTile?._fullscreenCallMirrored ? 'scaleX(-1)' : '';
  const selectedSource = this._listLiveFullscreenStreams().find(item => item.tile === sourceTile);
  const label = this._fullscreenStreamLabelNode(targetTile);
  if (selectedSource && label) label.textContent = selectedSource.label;
},

_handleFullscreenSourceEnded(tile) {
  const activeTile = this._fullscreenCallActiveTile;
  if (activeTile && this._fullscreenCallSelectedTile === tile) {
    const fallback = this._listLiveFullscreenStreams(tile)[0];
    if (fallback) {
      this._setFullscreenVideoSource(activeTile, fallback.tile, fallback.stream);
      this._fullscreenCallSelectedTile = fallback.tile;
    } else {
      this._exitFullscreenCallControls();
    }
  }
  this._refreshFullscreenStreamPicker();
},

_refreshFullscreenStreamPicker() {
  const streams = this._listLiveFullscreenStreams();
  // Rebuilding an open dropdown closes it, and this runs on many events, so
  // the options are only rebuilt when a stream or its label actually changed.
  const signature = streams.map(item => `${item.tile.id}\u0000${item.label}`).join('\u0001');
  for (const [picker] of this._fullscreenStreamPickers || []) {
    const currentValue = this._fullscreenCallSelectedTile?.id || this._fullscreenCallActiveTile?.id || '';
    if (picker._fullscreenStreamSignature !== signature) {
      picker.replaceChildren();
      for (const item of streams) {
        const option = document.createElement('option');
        option.value = item.tile.id;
        option.textContent = item.label;
        picker.appendChild(option);
      }
      picker._fullscreenStreamSignature = signature;
    }
    const nextValue = streams.some(item => item.tile.id === currentValue) ? currentValue : streams[0]?.tile.id;
    if (nextValue !== undefined && picker.value !== nextValue) picker.value = nextValue;
    picker.disabled = streams.length < 2;
  }
},

_selectFullscreenStream(fullscreenTile, sourceTileId) {
  if (this._fullscreenElement() !== fullscreenTile || !fullscreenTile.parentNode) return;
  const sourceTile = document.getElementById(sourceTileId);
  if (!sourceTile || !sourceTile.parentNode) return;
  const stream = this._listLiveFullscreenStreams().find(item => item.tile === sourceTile)?.stream;
  if (!stream || !fullscreenTile.querySelector('video')) {
    this._refreshFullscreenStreamPicker();
    return;
  }
  if (!this._fullscreenCallOriginalStream) this._fullscreenCallOriginalStream = fullscreenTile.querySelector('video').srcObject;
  this._setFullscreenVideoSource(fullscreenTile, sourceTile, stream);
  this._fullscreenCallActiveTile = fullscreenTile;
  this._fullscreenCallSelectedTile = sourceTile;
  this._refreshFullscreenStreamPicker();
},

_handleFullscreenTileRemoval(tile) {
  if (!tile) return;
  const activeTile = this._fullscreenCallActiveTile;
  if (activeTile === tile) {
    this._exitFullscreenCallControls();
    this._endFullscreenCallTile(tile);
  } else if (activeTile && this._fullscreenCallSelectedTile === tile) {
    const fallback = this._listLiveFullscreenStreams(tile)[0];
    if (fallback) {
      this._setFullscreenVideoSource(activeTile, fallback.tile, fallback.stream);
      this._fullscreenCallSelectedTile = fallback.tile;
    } else {
      this._exitFullscreenCallControls();
    }
  }
  const binding = this._fullscreenCallTileBindings?.get(tile);
  if (binding) {
    binding.toolbar.hidden = true;
    tile.classList.remove('is-fullscreen');
    const audioPopover = binding.toolbar.querySelector('.fullscreen-audio-popover');
    const audioTrigger = binding.toolbar.querySelector('.fullscreen-call-audio');
    if (audioPopover && audioTrigger) this._closeFullscreenAudioPopover(tile, audioPopover, audioTrigger);
    document.removeEventListener?.('fullscreenchange', binding.onFullscreenChange);
    document.removeEventListener?.('webkitfullscreenchange', binding.onFullscreenChange);
    tile.removeEventListener?.('mouseleave', binding.onPointerLeave);
    tile.removeEventListener?.('mousemove', binding.onActivity);
    tile.removeEventListener?.('touchstart', binding.onActivity);
    tile.removeEventListener?.('focusin', binding.onActivity);
    this._fullscreenCallTileBindings.delete(tile);
    clearTimeout(tile._fullscreenControlsTimer);
    this._fullscreenCallToolbars?.delete(binding.toolbar);
    this._fullscreenStreamPickers?.forEach((owner, picker) => {
      if (owner === tile) this._fullscreenStreamPickers.delete(picker);
    });
  }
  this._refreshFullscreenStreamPicker();
},

_handleFullscreenTileHidden(tile) {
  const activeTile = this._fullscreenCallActiveTile;
  if (activeTile === tile) {
    this._exitFullscreenCallControls();
  } else if (activeTile && this._fullscreenCallSelectedTile === tile) {
    const fallback = this._listLiveFullscreenStreams(tile)[0];
    if (fallback) {
      this._setFullscreenVideoSource(activeTile, fallback.tile, fallback.stream);
      this._fullscreenCallSelectedTile = fallback.tile;
    } else {
      this._exitFullscreenCallControls();
    }
  }
  this._refreshFullscreenStreamPicker();
},

_cleanupFullscreenCallTiles() {
  for (const tile of [...(this._fullscreenCallTileBindings?.keys() || [])]) {
    this._handleFullscreenTileRemoval(tile);
  }
},

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
  this._syncFullscreenCallControls();
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
  this._syncFullscreenCallControls();
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
      tile._fullscreenCallUserId = userId;
      tile._fullscreenCallMirrored = userId === this.user.id;

      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      // Always muted: a camera carries no sound (voice plays on its own), and
      // an unmuted video may not start without a tap where autoplay needs a
      // gesture, as in the Android app, so cameras stayed black until a
      // reconnect.
      vid.muted = true;
      // Mirror own camera (like a mirror), but show others normally
      if (tile._fullscreenCallMirrored) vid.style.transform = 'scaleX(-1)';
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
        this._toggleTileFullscreen(tile);
      });
      tile.appendChild(fsBtnWC);
      this._createFullscreenCallToolbar(tile);

      // Minimize button: collapses tile but keeps in grid
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
        if (tile.classList.contains('webcam-minimized')) this._handleFullscreenTileHidden(tile);
        else this._refreshFullscreenStreamPicker();
      });
      tile.appendChild(minBtn);

      // Close button: removes tile entirely
      const closeBtn = document.createElement('button');
      closeBtn.className = 'stream-close-btn';
      closeBtn.title = t('media.close_camera');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vidEl = tile.querySelector('video');
        this._handleFullscreenTileRemoval(tile);
        this._updateFullscreenTileSource(tile, null);
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
      this._refreshFullscreenStreamPicker();
    }

    container.style.display = 'flex';

    const videoEl = tile.querySelector('video');
    tile._fullscreenCallMirrored = userId === this.user.id;
    if (this._fullscreenCallActiveTile !== tile || this._fullscreenCallSelectedTile === tile) {
      videoEl.style.transform = tile._fullscreenCallMirrored ? 'scaleX(-1)' : '';
    }
    if (videoEl.srcObject === stream) videoEl.srcObject = null;
    videoEl.srcObject = stream;
    this._updateFullscreenTileSource(tile, stream);
    this._refreshFullscreenStreamPicker();
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
    // Stream ended: remove tile
    const tileId = `webcam-tile-${userId || 'self'}`;
    const tile = document.getElementById(tileId);
    if (tile) {
      const vid = tile.querySelector('video');
      this._handleFullscreenTileRemoval(tile);
      this._updateFullscreenTileSource(tile, null);
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

    this._refreshFullscreenStreamPicker();
    this._syncFullscreenCallControls();
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
      this._handleFullscreenTileRemoval(t);
      this._updateFullscreenTileSource(t, null);
      if (vid) vid.srcObject = null;
      t.remove();
    });
  }
  this._refreshFullscreenStreamPicker();
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
      <span class="music-pip-label"><span class="music-pip-label-icon" aria-hidden="true">📷</span> ${this._escapeHtml(who)}</span>
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
    // The video's frame goes fullscreen, not the video itself: a video in
    // fullscreen gets the browser's own controls, and a click on it paused
    // the stream.
    const target = pip.querySelector('.stream-pip-video') || pip;
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
    // Honour auto-accept setting: show a join prompt instead of opening the
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
      this._showToast(t('voice.sharing_started', { who }), 'info', {
        label: t('voice_runtime.join'),
        onClick: () => {
          // The prompt outlives the share: once it has ended (or a newer one
          // took its place) Join opened an empty tile with its controls and
          // no picture. Only the share still on offer opens.
          if (this._pendingStreamOffers?.get(userId) !== stream) {
            this._showToast(t('voice.sharing_ended', { who }), 'info');
            return;
          }
          this._handleScreenStream(userId, stream, { force: true });
        }
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
      tile._fullscreenCallUserId = userId;

      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true; // Always mute; screen audio routes through WebRTC audio track
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

      // Fullscreen the tile so controls can remain inside its fullscreen subtree.
      const fsBtn = document.createElement('button');
      fsBtn.className = 'stream-fullscreen-btn';
      fsBtn.title = t('media.fullscreen');
      fsBtn.textContent = '⛶';
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleTileFullscreen(tile);
      });
      tile.appendChild(fsBtn);
      this._createFullscreenCallToolbar(tile);

      // Minimize button: hides tile but KEEPS audio playing
      const minBtn = document.createElement('button');
      minBtn.className = 'stream-minimize-btn';
      minBtn.title = t('media.stream_minimize');
      minBtn.textContent = '─';
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideStreamTile(tile, userId, who, false);
      });
      tile.appendChild(minBtn);

      // Close button: hides tile and mutes its audio (can be restored from hidden bar)
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
      this._refreshFullscreenStreamPicker();
    }
    tile._fullscreenCallMirrored = false;

    // A share the viewer had to accept may have had its audio parked while
    // the Join prompt was up. The tile exists now, so let it play (#5636).
    if (userId !== null && userId !== this.user.id) this.voice.flushPendingScreenAudio?.(userId);

    // Show the container BEFORE assigning srcObject; browsers won't decode
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
    // reassign. Even if the new track has the same id, the browser will keep
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
    this._updateFullscreenTileSource(tile, stream);
    this._refreshFullscreenStreamPicker();
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
    // Stream ended: remove this tile. The next share from this person gets
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
      this._handleFullscreenTileRemoval(tile);
      this._updateFullscreenTileSource(tile, null);
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
    this._refreshFullscreenStreamPicker();
    this._syncFullscreenCallControls();
    this._updateScreenShareVisibility();
  }
},

// ── Stream Frame-Progress Watchdog ───────────────────────
//
// `videoWidth > 0` only proves that metadata arrived once. On a reshare the
// element keeps the dimensions of the stream it was previously showing, so a
// tile can sit on a frozen or black frame indefinitely while videoWidth reads
// as healthy, and _retryPlay, which bails the moment videoWidth is non-zero,
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
    // Nothing is meant to be flowing, so not a stall.
    if (!track || track.readyState !== 'live') { stalls = 0; return; }
    // Chromium also mutes the incoming track when frames stop arriving over
    // the network, which is what a stream frozen by a bad link looks like
    // (audio keeps playing, the picture stops until you rejoin). By default a
    // muted track is left alone, since a sharer showing a still screen can
    // look the same. The Debug toggle treats it as a stall instead, for
    // people who hit the frozen-stream case (reported over a VPN and TURN).
    let recoverMuted = false;
    try { recoverMuted = localStorage.getItem('haven_recover_muted_streams') === '1'; } catch { /* storage blocked: the default */ }
    if (track.muted && !recoverMuted) { stalls = 0; return; }

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
      console.warn('[Stream] No frames for', tileId, ': re-attaching srcObject');
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
          '(not asking again this window). The stream is likely bandwidth-starved, not stuck.');
      } else if (now < b.nextAllowed) {
        // Backing off; say nothing and let the next tick reconsider.
      } else {
        b.count++;
        b.nextAllowed = now + (5000 * b.count);   // 5s, 10s, 15s
        this._renegBudget[userId] = b;
        console.warn('[Stream] Still no frames for', tileId, ': requesting renegotiate',
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
