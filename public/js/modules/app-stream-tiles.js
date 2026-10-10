// Stream tiles: layouts, hiding and showing a tile, screen share audio and
// no-audio badges, who is watching, focus mode and pop-out windows.

export default {

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
  // Focus mode hides every tile but the focused one, so once that tile is
  // gone (its sharer stopped, or it was closed or minimised) the remaining
  // streams sat invisible in a blank container until something happened to
  // reset it. Drop back to the grid instead. (#5609)
  if (container.classList.contains('stream-focus-mode') &&
      !grid.querySelector('.screen-share-tile.stream-focused:not([data-hidden="true"])')) {
    this._exitStreamFocus();
  }
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
    // All tiles hidden: collapse the container to avoid empty gray space,
    // but keep the "hidden streams" bar in the header so user can restore.
    container.style.display = 'none';
  } else if (this._screenShareMinimized) {
    this._showScreenShareIndicator(totalCount);
  } else {
    container.style.display = 'flex';
    const labelParts = [`🖥️ ${t(visibleCount === 1 ? 'voice_runtime.stream_one' : 'voice_runtime.stream_other', { count: visibleCount })}`];
    if (hiddenCount > 0) labelParts.push(t('voice_runtime.hidden_count', { count: hiddenCount }));
    label.textContent = labelParts.join(' ');
  }
},

_hideScreenShare() {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  // Just minimize; don't destroy streams or stop sharing
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
  ind.textContent = `🖥️ ${t(count === 1 ? 'media.hidden_streams_one' : 'media.hidden_streams_other', { count })}`;
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
    if (audioEl) { audioEl.volume = 0; audioEl.pause(); }
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
    if (vid && vid.srcObject) vid.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
    // Restore audio if it was muted by close
    if (tile.dataset.muted === 'true') {
      delete tile.dataset.muted;
      // Resume the audio element that was paused when hiding
      const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (audioEl && audioEl.paused) audioEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
      // Check if the user had manually muted the stream before closing;
      // if so, keep it muted instead of restoring volume
      const muteBtn = tile.querySelector('.stream-mute-btn');
      if (muteBtn && muteBtn.dataset.muted === 'true') {
        // User had it muted: re-mute
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

  bar.innerHTML = `<button class="hidden-stream-restore-btn" title="${t('media.show_hidden_streams')}">🖥 ${t(hiddenTiles.length === 1 ? 'media.hidden_streams_one' : 'media.hidden_streams_other', { count: hiddenTiles.length })}</button>`;

  // Bind restore button: clicking it restores all hidden streams
  bar.querySelector('.hidden-stream-restore-btn').addEventListener('click', () => {
    hiddenTiles.forEach(t => {
      t.style.display = '';
      delete t.dataset.hidden;
      const uid = t.id.replace('screen-tile-', '');
      // Re-play video (browsers may pause while display:none)
      const vid = t.querySelector('video');
      if (vid && vid.srcObject) vid.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
      // Restore audio if it was muted by close
      if (t.dataset.muted === 'true') {
        delete t.dataset.muted;
        // Resume the audio element that was paused when hiding
        const audioEl = document.getElementById(`voice-audio-screen-${uid}`);
        if (audioEl && audioEl.paused) audioEl.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
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

  // Show the container only if there are still visible tiles; _updateScreenShareVisibility handles this.
  // (Removed forced container.style.display = 'flex' that caused empty gray space.)
},

_closeScreenShare() {
  // "Close" the stream viewer by closing each visible tile the same way the
  // per-tile ✕ does: hide it and mute its audio, but KEEP the tile (and its
  // live track reference) in the DOM so it stays restorable from the
  // hidden-streams bar or the LIVE badge.
  //
  // This deliberately does NOT:
  //   • stop the local user's own outgoing share; that's the job of the
  //     screen-share toggle button. Closing the *viewer* must never kill your
  //     *broadcast* (this used to call _toggleScreenShare()).
  //   • remove tiles or null their <video> srcObject, destroying the only
  //     reference to a sharer's still-live track leaves no ontrack/onunmute
  //     event to rebuild from, so the stream could never be reopened and a
  //     reshare wouldn't reattach without a full reload. That was the root
  //     cause of the "one X breaks everything" report.
  const grid = document.getElementById('screen-share-grid');
  if (!grid) return;
  // Snapshot first. _hideStreamTile flips data-hidden as it goes, which would
  // otherwise mutate a live NodeList mid-iteration.
  const visibleTiles = Array.from(
    grid.querySelectorAll('.screen-share-tile:not([data-hidden="true"])')
  );
  visibleTiles.forEach(tile => {
    const raw = tile.id.replace('screen-tile-', '');
    // Use a numeric id where possible so the stream-unwatch emitted by
    // _hideStreamTile passes the server's isInt(sharerId) check (a string id
    // would be silently dropped, leaving a stale viewer count).
    const uid = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
    this._hideStreamTile(tile, uid, null, true);
  });
  // _hideStreamTile already refreshes the hidden-streams bar and collapses the
  // container via _updateScreenShareVisibility, so there's nothing else to do.
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
      badge.innerHTML = `🔊 ${t('voice_runtime.audio')}`;
      tile.appendChild(badge);
    }
    // If the desktop app already reported a specific audio mode for this
    // share (per-app, system-clean, fallback, loopback), reflect it now.
    this._applyShareAudioModeBadge(window.__havenShareAudioMode);
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

// Update the streamer's own audio badge to reflect the actual capture mode
// reported by the desktop app. Browser users won't have this info; they'll
// just see the generic "🔊 Audio" badge.
_applyShareAudioModeBadge(modeInfo) {
  if (!modeInfo) return;
  const tile = document.getElementById(`screen-tile-${this.user?.id || 'self'}`);
  const badge = tile?.querySelector('.stream-audio-badge');
  if (!badge) return;

  // Strip prior mode classes
  badge.classList.remove('mode-app', 'mode-system-clean', 'mode-fallback', 'mode-loopback');

  let label, cls, tip;
  switch (modeInfo.applied) {
    case 'app':
      label = modeInfo.detail
        ? t('voice_runtime.app_audio_detail', { detail: modeInfo.detail })
        : t('voice_runtime.app_audio');
      cls   = 'mode-app';
      tip   = t('voice_runtime.app_audio_tip', { app: modeInfo.detail || t('voice_runtime.selected_app') });
      break;
    case 'system-clean':
      label = t('voice_runtime.system_audio');
      cls   = 'mode-system-clean';
      tip   = t('voice_runtime.system_audio_tip');
      break;
    case 'fallback-system-clean':
      label = t('voice_runtime.system_audio_fallback');
      cls   = 'mode-fallback';
      tip   = modeInfo.detail
        ? t('voice_runtime.system_audio_fallback_tip_reason', { reason: modeInfo.detail })
        : t('voice_runtime.system_audio_fallback_tip');
      break;
    case 'system-loopback':
      label = t('voice_runtime.all_audio');
      cls   = 'mode-loopback';
      tip   = modeInfo.detail
        ? t('voice_runtime.all_audio_tip_reason', { reason: modeInfo.detail })
        : t('voice_runtime.all_audio_tip');
      break;
    default:
      return;
  }
  badge.innerHTML = label;
  badge.classList.add(cls);
  badge.title = tip;
  // Also expose on the badge for tooltip-aware UIs
  badge.setAttribute('data-mode', modeInfo.applied);
},

_handleScreenNoAudio(userId) {
  const tileId = `screen-tile-${userId || 'self'}`;
  this._cancelScreenNoAudioTimer(userId);
  const tile = document.getElementById(tileId);
  if (!tile) {
    // Tile may not exist yet, so defer until it's created
    const checkInterval = setInterval(() => {
      const t = document.getElementById(tileId);
      if (t) {
        this._cancelScreenNoAudioTimer(userId);
        this._applyNoAudioBadge(t, userId);
      }
    }, 200);
    const timeout = setTimeout(() => this._cancelScreenNoAudioTimer(userId), 5000);
    if (!this._screenNoAudioTimers) this._screenNoAudioTimers = new Map();
    this._screenNoAudioTimers.set(String(userId ?? 'self'), { checkInterval, timeout });
    return;
  }
  this._applyNoAudioBadge(tile, userId);
},

_cancelScreenNoAudioTimer(userId) {
  const key = String(userId ?? 'self');
  const pending = this._screenNoAudioTimers?.get(key);
  if (!pending) return;
  clearInterval(pending.checkInterval);
  clearTimeout(pending.timeout);
  this._screenNoAudioTimers.delete(key);
},

_resetScreenShareUiState(userId) {
  this._cancelScreenNoAudioTimer(userId);
  this._removeScreenSharePiP(userId);
  const tile = document.getElementById(`screen-tile-${userId || 'self'}`);
  tile?.querySelector('.stream-no-audio-badge')?.remove();
  tile?.querySelector('.stream-audio-badge')?.remove();
  const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
  if (controls) controls.style.display = '';
},

_removeScreenSharePiP(userId) {
  const key = userId || 'self';
  if (!this._screenPipGenerations) this._screenPipGenerations = new Map();
  this._screenPipGenerations.set(key, (this._screenPipGenerations.get(key) || 0) + 1);
  this._screenPipNativeRequests?.delete(key);
  this._screenPipNativeActive?.delete(key);
  this._screenPipTrackCleanups?.get(key)?.();
  const tile = document.getElementById(`screen-tile-${key}`);
  const nativePipVideo = document.pictureInPictureElement;
  if (nativePipVideo && tile?.contains(nativePipVideo)) {
    document.exitPictureInPicture?.().catch(() => { /* already left picture-in-picture */ });
  }
  const pip = document.getElementById(`stream-pip-${key}`);
  const pipVideo = pip?.querySelector('video');
  if (pipVideo) pipVideo.srcObject = null;
  pip?.remove();
  const popoutBtn = tile?.querySelector('.stream-popout-btn');
  if (popoutBtn) {
    popoutBtn.textContent = '⧉';
    popoutBtn.title = t('media.pop_out_stream');
  }
  tile?.classList.remove('stream-popped-out');
  this._updateStreamContainerCollapse();
},

_bindScreenPipTrack(userId, streamTrack, onEnded) {
  const key = userId || 'self';
  if (!this._screenPipTrackCleanups) this._screenPipTrackCleanups = new Map();
  this._screenPipTrackCleanups.get(key)?.();
  const previousOnEnded = streamTrack.onended;
  let active = true;
  const handleEnded = () => {
    if (typeof previousOnEnded === 'function') previousOnEnded.call(streamTrack);
    if (active) onEnded();
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (streamTrack.onended === handleEnded) streamTrack.onended = previousOnEnded;
    if (this._screenPipTrackCleanups.get(key) === cleanup) {
      this._screenPipTrackCleanups.delete(key);
    }
  };
  streamTrack.onended = handleEnded;
  this._screenPipTrackCleanups.set(key, cleanup);
  return cleanup;
},

_applyNoAudioBadge(tile, userId) {
  // Remove opposite badge first (mutually exclusive)
  tile.querySelector('.stream-audio-badge')?.remove();
  if (tile.querySelector('.stream-no-audio-badge')) return;
  // Add the no-audio badge
  const badge = document.createElement('div');
  badge.className = 'stream-no-audio-badge';
  badge.innerHTML = `🔇 ${t('voice_runtime.no_audio')}`;
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
  badge.title = t('users.watching_stream_title', { names });
    tile.appendChild(badge);
  });
},

// ── Stream Focus & Pop-out ──────────────────────────

_toggleStreamFocus(tile) {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  const wasFocused = tile.classList.contains('stream-focused');

  // Leave focus mode first, whichever tile held it.
  this._exitStreamFocus();
  if (wasFocused) return;

  tile.classList.add('stream-focused');
  container.classList.add('stream-focus-mode');
  // Clear inline max-height so CSS flex constraints take over (viewport-bounded)
  container.style.maxHeight = '';
  grid.style.maxHeight = '';
  const vid = tile.querySelector('video');
  if (vid) vid.style.maxHeight = '';
},

// Leave focus mode and put the slider-based size back. Runs on the second
// double-click, and whenever the focused tile goes away. (#5609)
_exitStreamFocus() {
  const container = document.getElementById('screen-share-container');
  const grid = document.getElementById('screen-share-grid');
  if (!container || !grid) return;
  grid.querySelectorAll('.screen-share-tile.stream-focused').forEach(t => t.classList.remove('stream-focused'));
  if (!container.classList.contains('stream-focus-mode')) return;
  container.classList.remove('stream-focus-mode');
  const saved = localStorage.getItem('haven_stream_size') || '50';
  const vh = parseInt(saved, 10);
  container.style.maxHeight = vh + 'vh';
  grid.style.maxHeight = (vh - 2) + 'vh';
  document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
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
  const stream = video.srcObject;
  const key = userId || 'self';

  // If already in Picture-in-Picture, exit it
  if (document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => { /* already left picture-in-picture */ });
    return;
  }

  // If already popped out, don't open another
  if (tile.classList.contains('stream-popped-out')) return;

  if (!this._screenPipGenerations) this._screenPipGenerations = new Map();
  const generation = (this._screenPipGenerations.get(key) || 0) + 1;
  this._screenPipGenerations.set(key, generation);
  if (!this._screenPipNativeRequests) this._screenPipNativeRequests = new Map();
  this._screenPipNativeRequests.set(key, generation);
  const isCurrent = () => this._screenPipGenerations.get(key) === generation &&
    document.getElementById(`screen-tile-${key}`) === tile &&
    tile.querySelector('video') === video && video.srcObject === stream;
  const activateNativePip = () => {
    if (!isCurrent()) return false;
    if (this._screenPipNativeRequests.get(key) === generation) {
      this._screenPipNativeRequests.delete(key);
    }
    if (!this._screenPipNativeActive) this._screenPipNativeActive = new Map();
    if (this._screenPipNativeActive.get(key) === generation) return true;
    this._screenPipNativeActive.set(key, generation);
    const popoutBtn = tile.querySelector('.stream-popout-btn');
    if (popoutBtn) { popoutBtn.textContent = '\u29C8'; popoutBtn.title = t('media.pop_in_stream'); }
    tile.classList.add('stream-popped-out');
    this._updateStreamContainerCollapse();

    video.addEventListener('leavepictureinpicture', () => {
      if (!isCurrent()) return;
      if (this._screenPipNativeActive?.get(key) === generation) {
        this._screenPipNativeActive.delete(key);
      }
      if (popoutBtn) { popoutBtn.textContent = '\u29C9'; popoutBtn.title = t('media.pop_out_stream'); }
      tile.classList.remove('stream-popped-out');
      this._updateStreamContainerCollapse();
    }, { once: true });
    return true;
  };

  // Try native Picture-in-Picture first (OS-level window, can be dragged to other screens)
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    video.requestPictureInPicture().then(() => {
      if (!isCurrent()) {
        const newerRequest = this._screenPipNativeRequests?.get(key);
        const newerActive = this._screenPipNativeActive?.get(key);
        if (document.pictureInPictureElement === video &&
            !newerRequest && !newerActive) {
          document.exitPictureInPicture?.().catch(() => { /* already left picture-in-picture */ });
        }
        return;
      }
      activateNativePip();
    }).catch(() => {
      if (this._screenPipNativeRequests?.get(key) === generation) {
        this._screenPipNativeRequests.delete(key);
      }
      if (document.pictureInPictureElement === video && activateNativePip()) return;
      // Fallback to in-page overlay if native PiP fails
      if (isCurrent()) this._popOutStreamWindow(tile, userId);
    });
  } else {
    this._popOutStreamWindow(tile, userId);
  }
},

_popOutStreamWindow(tile, userId) {
  const video = tile.querySelector('video');
  if (!video || !video.srcObject) return;

  const stream = video.srcObject;
  const name = this.voice.peerName(userId);
  const who = userId === null || userId === this.user.id ? t('voice_runtime.you') : (name || t('voice_runtime.stream'));

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
      <button class="music-pip-btn stream-pip-popin" title="${t('media.pop_back_in')}">⧈</button>
      <span class="music-pip-label"><span class="music-pip-label-icon" aria-hidden="true">🖥️</span> ${who}</span>
      <span class="music-pip-vol-icon stream-pip-opacity-icon" title="${t('voice_runtime.window_opacity')}">👁</span>
      <input type="range" class="music-pip-vol pip-opacity-slider stream-pip-opacity" min="20" max="100" value="${savedOpacity}">
      <button class="music-pip-btn stream-pip-maximize" title="${t('voice_runtime.maximize')}">⛶</button>
      <button class="music-pip-btn stream-pip-fullscreen" title="${t('media.fullscreen')}">⤢</button>
      <button class="music-pip-btn stream-pip-close" title="${t('modals.common.close')}">✕</button>
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
  pipVideo.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });

  const popoutBtn = tile.querySelector('.stream-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = t('media.pop_in_stream'); }
  tile.classList.add('stream-popped-out');
  this._updateStreamContainerCollapse();

  let cleanupTrack = null;

  // Pop-in handler (minimize: return to inline grid)
  const popIn = () => {
    cleanupTrack?.();
    pipVideo.srcObject = null;
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = t('media.pop_out_stream'); }
    tile.classList.remove('stream-popped-out');
    this._updateStreamContainerCollapse();
  };

  // Close handler (destroy PiP overlay AND hide the inline tile)
  const closePip = () => {
    cleanupTrack?.();
    pipVideo.srcObject = null;
    pip.remove();
    if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = t('media.pop_out_stream'); }
    tile.classList.remove('stream-popped-out');
    this._updateStreamContainerCollapse();
    // Also hide the stream tile; user wants to close the stream, not just pop back in
    const name2 = this.voice.peerName(userId);
    const who2 = userId === null || userId === this.user.id ? t('voice_runtime.you') : (name2 || t('voice_runtime.stream'));
    this._hideStreamTile(tile, userId, who2, true);
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

  // Maximize toggle: snap the overlay to fill the whole window (a full monitor
  // when the browser is maximized on it), then restore the previous size.
  const maxBtn = pip.querySelector('.stream-pip-maximize');
  maxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const maximized = pip.classList.toggle('stream-pip-maximized');
    maxBtn.classList.toggle('active', maximized);
    maxBtn.title = t(maximized ? 'voice_runtime.restore' : 'voice_runtime.maximize');
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
    cleanupTrack = this._bindScreenPipTrack(userId, streamTrack, popIn);
  }
},

};
