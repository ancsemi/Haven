// Listening together: sharing a YouTube or SoundCloud link or playlist,
// the queue, play, pause, seek and volume kept in sync for everyone in
// voice, and the music player panel and its pop-out.

export default {

// ── Music Streaming ───────────────────────────────

_openMusicModal() {
  if (!this.voice || !this.voice.inVoice) {
    this._showToast(t('toasts.join_voice_first'), 'error');
    return;
  }
  document.getElementById('music-link-input').value = '';
  document.getElementById('music-link-preview').innerHTML = '';
  document.getElementById('music-link-preview').classList.remove('active');
  this._updateMusicModalButtons(null);
  document.getElementById('music-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('music-link-input').focus(), 100);
},

_closeMusicModal() {
  document.getElementById('music-modal').style.display = 'none';
},
//Determine playlist ID
_getYouTubePlaylistInfo(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const isYouTubeHost = host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be';
    if (!isYouTubeHost) return null;
    const listId = parsed.searchParams.get('list');
    if (!listId) return null;
    if (parsed.pathname === '/playlist') return { isPlaylistOnly: true, playlistId: listId };
    const videoId = host === 'youtu.be'
      ? parsed.pathname.replace(/^\/+/, '').split('/')[0]
      : parsed.searchParams.get('v');
    if (videoId) return { isPlaylistOnly: false, videoId, playlistId: listId };
  } catch { /* not a valid address, so not a YouTube link */ }
  return null;
},

_updateMusicModalButtons(url) {
  const shareBtn = document.getElementById('share-music-btn');
  const playlistBtn = document.getElementById('share-music-playlist-btn');
  if (!shareBtn || !playlistBtn) return;
  const info = url ? this._getYouTubePlaylistInfo(url) : null;
  if (info?.isPlaylistOnly) {
    shareBtn.style.display = 'none';
    playlistBtn.style.display = '';
  } else if (info) {
    shareBtn.style.display = '';
    playlistBtn.style.display = '';
  } else {
    shareBtn.style.display = '';
    playlistBtn.style.display = 'none';
  }
},

_previewMusicLink(url) {
  const preview = document.getElementById('music-link-preview');
  if (!url) {
    preview.innerHTML = '';
    preview.classList.remove('active');
    this._updateMusicModalButtons(null);
    return;
  }
  const playlistInfo = this._getYouTubePlaylistInfo(url);
  if (playlistInfo) { //Conditional display of playlist parsing
    preview.classList.add('active');
    preview.innerHTML = playlistInfo.isPlaylistOnly
      ? t('voice_runtime.youtube_playlist_ready')
      : t('voice_runtime.youtube_playlist_video');
    this._updateMusicModalButtons(url);
    return;
  }
  const platform = this._getMusicPlatform(url);
  const embedUrl = this._getMusicEmbed(url);
  if (platform && embedUrl) {
    preview.classList.add('active');
    preview.innerHTML = `${platform.icon} <strong>${platform.name}</strong> — ${t('voice.music_ready')}`;
  } else {
    preview.classList.remove('active');
    preview.innerHTML = '';
  }
  this._updateMusicModalButtons(url);
},

_shareMusic() {
  const url = document.getElementById('music-link-input').value.trim();
  if (!url) { this._showToast(t('toasts.paste_music_link'), 'error'); return; }
  if (!this._getMusicEmbed(url)) {
    this._showToast(t('toasts.unsupported_music_link'), 'error');
    return;
  }
  if (!this.voice || !this.voice.inVoice) { this._showToast(t('toasts.join_voice_required'), 'error'); return; }
  this.socket.emit('music-share', { code: this.voice.currentChannel, url });
  this._closeMusicModal();
},
//Playlist queue addition
_shareMusicPlaylist() {
  const url = document.getElementById('music-link-input').value.trim();
  if (!url) { this._showToast(t('toasts.paste_music_link'), 'error'); return; }
  const info = this._getYouTubePlaylistInfo(url);
  if (!info?.playlistId) { this._showToast(t('toasts.playlist_not_found'), 'error'); return; }
  if (!this.voice || !this.voice.inVoice) { this._showToast(t('toasts.join_voice_required'), 'error'); return; }
  this.socket.emit('music-share-playlist', { code: this.voice.currentChannel, playlistId: info.playlistId });
  this._closeMusicModal();
},

_stopMusic() { //Check for music management role to halt playback
  if (!this._canControlMusic()) {
    this._showToast(t('toasts.music_stop_forbidden'), 'error');
    return;
  }
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
    this._showToast(offset > 0 ? t('toasts.no_more_results') : t('toasts.no_results_for', { query }), 'error');
    return;
  }

  const picker = document.createElement('div');
  picker.id = 'music-search-picker';
  picker.className = 'music-search-picker';
  picker.innerHTML = `
    <div class="music-search-picker-header">
      <span>${t('voice_runtime.results_for', { query: `<strong>${this._escapeHtml(query)}</strong>` })}</span>
      <button class="music-search-picker-close" title="${t('modals.common.cancel')}">✕</button>
    </div>
    <div class="music-search-picker-list">
      ${results.map((r, i) => `
        <div class="music-search-picker-item" data-video-id="${r.videoId}" data-title="${this._escapeHtml(r.title || t('voice_runtime.result', { number: offset + i + 1 }))}">
          <div class="music-search-picker-thumb">
            ${r.thumbnail ? `<img src="${this._escapeHtml(r.thumbnail)}" alt="" loading="lazy">` : '<span>🎵</span>'}
          </div>
          <div class="music-search-picker-info">
            <div class="music-search-picker-title">${this._escapeHtml(r.title || t('voice_runtime.result', { number: offset + i + 1 }))}</div>
            <div class="music-search-picker-meta">${this._escapeHtml(r.channel)}</div>
          </div>
          <button class="music-search-picker-play" data-video-id="${r.videoId}" data-title="${this._escapeHtml(r.title || t('voice_runtime.result', { number: offset + i + 1 }))}" title="${t('voice_runtime.play_this')}">▶</button>
        </div>
      `).join('')}
    </div>
    <div class="music-search-picker-footer">
      <button class="music-search-picker-more">${t('voice_runtime.more_results')}</button>
      <button class="music-search-picker-cancel">${t('modals.common.cancel')}</button>
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
    this._showToast(t('toasts.loading_more'), 'info');
  });

  picker.querySelectorAll('.music-search-picker-play').forEach(btn => {
    btn.addEventListener('click', () => {
      const videoId = btn.dataset.videoId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      this.socket.emit('music-share', {
        code: this.voice.currentChannel,
        url,
        title: btn.dataset.title || ''
      });
      this._closeMusicSearchPicker();
    });
  });

  // Also allow clicking the whole row
  picker.querySelectorAll('.music-search-picker-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.music-search-picker-play')) return; // already handled
      const videoId = item.dataset.videoId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      this.socket.emit('music-share', {
        code: this.voice.currentChannel,
        url,
        title: item.dataset.title || ''
      });
      this._closeMusicSearchPicker();
    });
  });
},

_closeMusicSearchPicker() {
  const existing = document.getElementById('music-search-picker');
  if (existing) existing.remove();
},

_handleMusicShared(data) {
  //Switch to active voice channel if reconnecting and music is shared so playback will resume
  if (!this.currentChannel && this.voice && this.voice.currentChannel) {
    this.switchChannel(this.voice.currentChannel);
  }
  const embedUrl = this._getMusicEmbed(data.url);
  if (!embedUrl) return;
  const platform = this._getMusicPlatform(data.url);
  const panel = document.getElementById('music-panel');
  const container = document.getElementById('music-embed-container');
  const label = document.getElementById('music-panel-label');
  if (this.voice && this.voice.inVoice) this._updateVoiceButtons(true);

  // Clean up previous player references
  this._musicYTPlayer = null;
  this._musicSCWidget = null;
  this._musicPlatform = platform ? platform.name : null;
  this._musicPlaying = data.syncState?.isPlaying !== false;
  this._musicActive = true;
  this._musicUrl = data.url;
  this._musicTrackId = data.trackId || null;
  this._musicRequestorId = data.userId || null;
  this._setMusicActivityHint('');
  this._pendingMusicSyncState = data.syncState || null;
  this._musicSuppressBroadcastUntil = 0;
  this._musicLastTrackedPosition = null;
  this._musicLastTrackedAt = 0;
  this._musicLastSeekBroadcastAt = 0;
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
  // Same per-iframe referrerpolicy as the chat YouTube embed. The document
  // default (same-origin since 3.41.0) sends no referrer cross-origin, which
  // YouTube reports as "Error 153" and other providers can reject too. The
  // origin alone is enough for them and carries no invite code.
  container.innerHTML = `<div class="music-embed-wrapper"><iframe id="music-iframe" src="${embedUrl}" width="100%" height="${iframeH}" frameborder="0" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>${needsOverlay ? '<div class="music-embed-overlay"></div>' : ''}</div>`;
  const labelText = data.resolvedFrom === 'spotify'
    ? t('voice.music_shared_spotify', { user: data.username || t('voice.someone') })
    : t('voice.music_shared', {
      platform: platform ? platform.name : t('voice.music'),
      user: data.username || t('voice.someone')
    });
  label.innerHTML = `<span class="music-pip-label-icon" aria-hidden="true">🎶</span> ${this._escapeHtml(labelText)}`;
  panel.style.display = 'flex';

  // Update play/pause button — hide for Spotify (no external API)
  const ppBtn = document.getElementById('music-play-pause-btn');
  if (ppBtn) {
    ppBtn.textContent = isSpotify ? '' : (data.syncState?.isPlaying === false ? '▶' : '⏸');
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
    if (volSlider) { volSlider.disabled = true; volSlider.title = t('media.spotify_volume_hint'); }
    if (muteBtn) { muteBtn.disabled = true; muteBtn.title = t('media.spotify_volume_hint'); }
  } else {
    if (volSlider) { volSlider.disabled = false; volSlider.title = ''; }
    if (muteBtn) { muteBtn.disabled = false; muteBtn.title = t('media.mute_unmute'); }
  }

  // Show next button for SoundCloud (has internal tracks) or when the queue has items
  const isSoundCloud = data.url.includes('soundcloud.com');
  const nextBtn = document.getElementById('music-next-btn');
  const hasQueue = (this._musicQueue?.length || 0) > 0;
  if (nextBtn) nextBtn.style.display = (isSoundCloud || hasQueue) && !isSpotify ? '' : 'none';


  // Initialize platform-specific APIs for volume & sync control
  const iframe = document.getElementById('music-iframe');
  if (iframe) {
    if (data.url.includes('youtube.com') || data.url.includes('youtu.be') || data.url.includes('music.youtube.com')) {
      this._initYouTubePlayer(iframe, savedVol);
    } else if (data.url.includes('soundcloud.com')) {
      this._initSoundCloudWidget(iframe, savedVol);
    }
  }

  const who = data.userId === this.user?.id
    ? t('voice_runtime.you_shared')
    : t('voice_runtime.user_shared', { user: data.username });
  this._applyMusicControlPermissions();

  const platformLabel = data.resolvedFrom === 'spotify' ? 'Spotify (via YouTube)' : (platform ? platform.name : t('voice.music'));
  this._showToast(t('voice_runtime.shared_platform', { who, platform: platformLabel }), 'info');
},
//Check for perms to adjust music stuff, like queue and removals
_canControlMusic() {
  return this.user?.isAdmin ||
    this._musicRequestorId === this.user?.id ||
    this._hasPerm('manage_music_queue');
},
//Music control permission validation
_applyMusicControlPermissions() {
  const allowed = this._canControlMusic();
  const restricted = t('toasts.music_stop_forbidden');
  const ppBtn = document.getElementById('music-play-pause-btn');
  const seekSlider = document.getElementById('music-seek-slider');
  const nextBtn = document.getElementById('music-next-btn');
  const stopBtn = document.getElementById('music-stop-btn');
  const pipPpBtn = document.getElementById('music-pip-pp');
  const pipStopBtn = document.getElementById('music-pip-close');
  if (ppBtn) {
    ppBtn.disabled = !allowed;
    ppBtn.title = allowed ? t('media.music_play_pause') : restricted;
  }
  if (seekSlider) {
    seekSlider.disabled = !allowed;
    seekSlider.title = allowed ? t('media.music_seek') : restricted;
  }
  if (nextBtn) {
    nextBtn.disabled = !allowed;
    nextBtn.title = allowed ? t('media.music_next') : restricted;
  }
  if (stopBtn) {
    stopBtn.disabled = !allowed;
    stopBtn.title = allowed ? t('media.music_stop') : restricted;
  }
  if (pipPpBtn) {
    pipPpBtn.disabled = !allowed;
    pipPpBtn.title = allowed ? t('media.music_play_pause') : restricted;
  }
  if (pipStopBtn) {
    pipStopBtn.disabled = !allowed;
    pipStopBtn.title = allowed ? t('media.music_stop') : restricted;
  }
},

_updateMusicQueueState(payload) {
  const queue = Array.isArray(payload?.queue) ? payload.queue : [];
  this._musicQueue = queue;
  this._musicUpNext = payload?.upNext || queue[0] || null;
  this._syncMusicQueueUi();
  this._renderMusicQueueModal();
  const nextBtn = document.getElementById('music-next-btn');
  if (nextBtn && nextBtn.style.display !== 'none') {
    if (!this._musicUrl?.includes('soundcloud.com') && queue.length === 0) {
      nextBtn.style.display = 'none';
    }
  } else if (nextBtn && queue.length > 0 && !this._musicUrl?.includes('spotify.com')) {
    nextBtn.style.display = '';
  }
},

_syncMusicQueueUi() {
  const text = this._musicUpNext?.title
    ? t('voice_runtime.up_next', { title: this._truncateMusicQueueTitle(this._musicUpNext.title, 54) })
    : t('media.music_up_next_empty');
  const title = this._musicUpNext?.title || t('voice_runtime.nothing_queued');
  const targets = ['music-up-next', 'music-pip-up-next'];
  targets.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.title = title;
  });
},

_setMusicActivityHint(text) {
  ['music-activity-hint', 'music-pip-activity-hint'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
},
//Trim titles to save on modaL small space
_truncateMusicQueueTitle(title, max = 54) {
  if (!title || title.length <= max) return title || '';
  return title.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
},

_openMusicQueueModal() {
  this._renderMusicQueueModal();
  document.getElementById('music-queue-modal').style.display = 'flex';
},

_closeMusicQueueModal() {
  document.getElementById('music-queue-modal').style.display = 'none';
},
//Table modal for queue management
_renderMusicQueueModal() {
  const body = document.getElementById('music-queue-body');
  const summary = document.getElementById('music-queue-summary');
  const table = body?.closest('.music-queue-table');
  const tableWrap = table?.closest('.music-queue-table-wrap');
  if (!body || !summary || !table || !tableWrap) return;
  const queue = this._musicQueue || [];
  const canManage = this.user?.isAdmin || this._hasPerm('manage_music_queue');
  table.classList.toggle('music-queue-readonly', !canManage);
  const shuffleBtn = document.getElementById('shuffle-music-queue-btn');
  if (shuffleBtn) shuffleBtn.style.display = (canManage && queue.length >= 2) ? '' : 'none';
  summary.textContent = queue.length
    ? t(queue.length === 1 ? 'voice_runtime.queued_one' : 'voice_runtime.queued_other', { count: queue.length })
    : t('media.music_queue_empty_summary');
  if (!queue.length) {
    body.innerHTML = `<tr><td colspan="5" class="music-queue-empty">${t('media.music_queue_is_empty')}</td></tr>`;
    return;
  }
  body.innerHTML = queue.map((item, idx) => `
    <tr class="music-queue-row" data-entry-id="${this._escapeHtml(item.id)}" draggable="${canManage ? 'true' : 'false'}">
      <td class="music-queue-col-handle">${canManage ? `<span class="music-queue-drag-handle" title="${t('voice_runtime.drag_reorder')}">⋮⋮</span>` : ''}</td>
      <td class="music-queue-col-pos"><span class="music-queue-pos">${idx + 1}</span></td>
      <td class="music-queue-col-requested-by">
        <span class="music-queue-requestor" title="${this._escapeHtml(item.username || t('app.messages.unknown_user'))}">${this._escapeHtml(this._truncateMusicQueueTitle(item.username || t('app.messages.unknown_user'), 24))}</span>
      </td>
      <td class="music-queue-title-cell">
        <div class="music-queue-title" title="${this._escapeHtml(item.title || t('voice_runtime.untitled_track'))}">${this._escapeHtml(this._truncateMusicQueueTitle(item.title || t('voice_runtime.untitled_track'), 80))}</div>
      </td>
      <td class="music-queue-col-actions">${canManage ? `<button class="music-queue-remove-btn" title="${t('voice_runtime.remove_queue')}">✕</button>` : ''}</td>
    </tr>
  `).join('');

  body.querySelectorAll('.music-queue-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('.music-queue-row');
      const entryId = row?.dataset.entryId;
      if (!entryId || !this.voice?.currentChannel) return;
      this.socket.emit('music-queue-remove', { code: this.voice.currentChannel, entryId });
    });
  });

  if (canManage) {
    let dragEntryId = null;
    const scrollDraggedTable = (deltaY) => {
      if (!dragEntryId || !deltaY) return;
      tableWrap.scrollTop += deltaY;
    };
    tableWrap.onwheel = (e) => {
      if (!dragEntryId) return;
      e.preventDefault();
      scrollDraggedTable(e.deltaY);
    };
    tableWrap.ondragover = (e) => {
      if (!dragEntryId) return;
      const rect = tableWrap.getBoundingClientRect();
      const edgeThreshold = 48;
      if (e.clientY < rect.top + edgeThreshold) scrollDraggedTable(-18);
      else if (e.clientY > rect.bottom - edgeThreshold) scrollDraggedTable(18);
    };
    body.querySelectorAll('.music-queue-row').forEach(row => {
      // dragstart fires on the <tr> (the draggable element), so e.target is always the
      // row — never the handle child. Track mousedown on the handle instead.
      let dragFromHandle = false;
      row.querySelector('.music-queue-drag-handle')?.addEventListener('mousedown', () => {
        dragFromHandle = true;
      });
      row.addEventListener('mouseup', () => {
        dragFromHandle = false;
      });
      row.addEventListener('dragstart', (e) => {
        if (!dragFromHandle) { e.preventDefault(); return; }
        dragFromHandle = false;
        dragEntryId = row.dataset.entryId;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        dragFromHandle = false;
        row.classList.remove('dragging');
        body.querySelectorAll('.music-queue-row').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragEntryId || dragEntryId === row.dataset.entryId) return;
        body.querySelectorAll('.music-queue-row').forEach(r => r.classList.toggle('drag-over', r === row));
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const targetId = row.dataset.entryId;
        body.querySelectorAll('.music-queue-row').forEach(r => r.classList.remove('drag-over'));
        if (!dragEntryId || !targetId || dragEntryId === targetId || !this.voice?.currentChannel) return;
        const nextIds = [...queue.map(item => item.id)];
        const from = nextIds.indexOf(dragEntryId);
        const to = nextIds.indexOf(targetId);
        if (from === -1 || to === -1) return;
        const [moved] = nextIds.splice(from, 1);
        nextIds.splice(to, 0, moved);
        this.socket.emit('music-queue-reorder', { code: this.voice.currentChannel, entryIds: nextIds });
      });
    });
  } else {
    tableWrap.onwheel = null;
    tableWrap.ondragover = null;
  }
},
//Basic queue shuffle, rendered in-modal
_shuffleMusicQueue() {
  if (!this.voice?.currentChannel) return;
  this.socket.emit('music-queue-shuffle', { code: this.voice.currentChannel });
},

_suppressMusicBroadcasts(ms = 1500) {
  this._musicSuppressBroadcastUntil = Date.now() + ms;
},

_shouldSuppressMusicBroadcasts() {
  return Date.now() < (this._musicSuppressBroadcastUntil || 0);
},

_setMusicPlayingUi(isPlaying) {
  this._musicPlaying = !!isPlaying;
  const label = this._musicPlaying ? '⏸' : '▶';
  const ppBtn = document.getElementById('music-play-pause-btn');
  if (ppBtn && ppBtn.style.display !== 'none') ppBtn.textContent = label;
  const pipPP = document.getElementById('music-pip-pp');
  if (pipPP) pipPP.textContent = label;
},

_getEffectiveMusicSyncState(syncState) {
  if (!syncState) return null;
  const effective = { ...syncState };
  if (effective.isPlaying && Number.isFinite(effective.positionSeconds)) {
    const updatedAt = Number(effective.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt > 0) {
      const elapsed = Math.max(0, Date.now() - updatedAt) / 1000;
      effective.positionSeconds += elapsed;
      if (Number.isFinite(effective.durationSeconds)) {
        effective.positionSeconds = Math.min(effective.positionSeconds, effective.durationSeconds);
      }
    }
  }
  return effective;
},

_withMusicTiming(callback) {
  if (this._musicYTPlayer && this._musicYTPlayer.getCurrentTime && this._musicYTPlayer.getDuration) {
    const positionSeconds = this._musicYTPlayer.getCurrentTime() || 0;
    const durationSeconds = this._musicYTPlayer.getDuration() || 0;
    callback(positionSeconds, durationSeconds);
    return;
  }
  if (this._musicSCWidget) {
    this._musicSCWidget.getPosition((pos) => {
      this._musicSCWidget.getDuration((dur) => {
        callback((pos || 0) / 1000, (dur || 0) / 1000);
      });
    });
    return;
  }
  callback(0, 0);
},

_withMusicDuration(callback) {
  if (this._musicYTPlayer && this._musicYTPlayer.getDuration) {
    callback(this._musicYTPlayer.getDuration() || 0);
    return;
  }
  if (this._musicSCWidget) {
    this._musicSCWidget.getDuration((dur) => {
      callback((dur || 0) / 1000);
    });
    return;
  }
  callback(0);
},

_captureCurrentMusicSyncState(callback) {
  if (!this._musicActive) {
    callback(null);
    return;
  }
  this._withMusicTiming((positionSeconds, durationSeconds) => {
    callback({
      isPlaying: !!this._musicPlaying,
      positionSeconds: Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : null,
      updatedAt: Date.now()
    });
  });
},

_restoreMusicSyncStateAfterMove(syncState) {
  if (!syncState) return;
  this._pendingMusicSyncState = syncState;
  this._suppressMusicBroadcasts(2500);
  const apply = () => this._applyMusicSyncState(syncState);
  /* The embed iframe is moved in the DOM during pop-out/pop-in, which can briefly interrupt the YT/SC player API.
  Cascade three attempts at increasing delays to catch whichever moment the player finishes re-stabilizing. Should probably
   convert this to a triggered event from the pop-out later by adding a trigger.*/
  requestAnimationFrame(() => setTimeout(apply, 0));
  setTimeout(apply, 150);
  setTimeout(apply, 500);
},

_emitMusicControl(action) {
  if (!this.voice || !this.voice.inVoice) return;
  this._withMusicTiming((positionSeconds, durationSeconds) => {
    this.socket.emit('music-control', {
      code: this.voice.currentChannel,
      action,
      positionSeconds,
      durationSeconds
    });
  });
},

_emitMusicFinished(isSkip = false) {
  if (!this.voice || !this.voice.inVoice || !this._musicTrackId) return;
  this._withMusicTiming((positionSeconds, durationSeconds) => {
    this.socket.emit('music-finished', {
      code: this.voice.currentChannel,
      trackId: this._musicTrackId,
      positionSeconds: Number.isFinite(positionSeconds) ? positionSeconds : undefined,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined,
      ...(isSkip && { isSkip: true })
    });
  });
},

_emitMusicSeek(positionSeconds, durationSeconds) {
  if (!this.voice || !this.voice.inVoice) return;
  const pct = durationSeconds > 0 ? (positionSeconds / durationSeconds) * 100 : undefined;
  this.socket.emit('music-seek', {
    code: this.voice.currentChannel,
    position: pct,
    positionSeconds,
    durationSeconds
  });
  this._musicLastTrackedPosition = positionSeconds;
  this._musicLastTrackedAt = Date.now();
  this._musicLastSeekBroadcastAt = Date.now();
},

_seekMusicToSeconds(seconds) {
  try {
    if (this._musicYTPlayer && this._musicYTPlayer.seekTo) {
      this._musicYTPlayer.seekTo(Math.max(0, seconds), true);
    } else if (this._musicSCWidget) {
      this._musicSCWidget.seekTo(Math.max(0, seconds) * 1000);
    }
  } catch { /* player gone? */ }
},

_applyMusicSyncState(syncState) {
  if (!syncState) return;
  const effectiveState = this._getEffectiveMusicSyncState(syncState);
  if (!this._musicYTPlayer && !this._musicSCWidget) {
    this._pendingMusicSyncState = effectiveState;
    return;
  }
  this._pendingMusicSyncState = null;
  this._suppressMusicBroadcasts();
  if (Number.isFinite(effectiveState.positionSeconds)) {
    this._seekMusicToSeconds(effectiveState.positionSeconds);
    this._musicLastTrackedPosition = effectiveState.positionSeconds;
    this._musicLastTrackedAt = Date.now();
  }
  if (typeof effectiveState.isPlaying === 'boolean') {
    if (effectiveState.isPlaying) this._playMusicEmbed();
    else this._pauseMusicEmbed();
    this._setMusicPlayingUi(effectiveState.isPlaying);
  }
},

_flushPendingMusicSyncState() {
  if (this._pendingMusicSyncState) this._applyMusicSyncState(this._pendingMusicSyncState);
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
          this._flushPendingMusicSyncState();
        },
        onStateChange: (e) => {
          // Sync Haven's play/pause state when user interacts with YT's native controls
          if (e.data === YT.PlayerState.PLAYING) {
            this._setMusicPlayingUi(true);
            if (!this._shouldSuppressMusicBroadcasts()) this._emitMusicControl('play');
          } else if (e.data === YT.PlayerState.PAUSED) {
            this._setMusicPlayingUi(false);
            if (!this._shouldSuppressMusicBroadcasts()) this._emitMusicControl('pause');
          } else if (e.data === YT.PlayerState.ENDED) {
            // Signal the server — it will pop the queue and emit music-shared for the next track
            this._setMusicPlayingUi(false);
            this._emitMusicFinished();
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
      this._flushPendingMusicSyncState();
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
        if (this._musicSCTrackCount > 1) this._musicSCWidget.next();
        else this._emitMusicFinished();
      }
    });
    // Track current index for shuffle
    this._musicSCWidget.bind(SC.Widget.Events.PLAY, () => {
      this._setMusicPlayingUi(true);
      if (!this._shouldSuppressMusicBroadcasts()) this._emitMusicControl('play');
      this._musicSCWidget.getCurrentSoundIndex((idx) => { this._musicSCCurrentIndex = idx; });
    });
    this._musicSCWidget.bind(SC.Widget.Events.PAUSE, () => {
      this._setMusicPlayingUi(false);
      if (!this._shouldSuppressMusicBroadcasts()) this._emitMusicControl('pause');
    });
  } catch { /* iframe may already be destroyed */ }
},

_handleMusicStopped(data) {
  this._stopMusicTimeTracking();
  this._musicYTPlayer = null;
  this._musicSCWidget = null;
  this._musicPlatform = null;
  this._musicTrackId = null;
  this._musicRequestorId = null;
  this._musicPlaying = false;
  this._hideMusicPanel();
  this._updateMusicQueueState({ queue: [], upNext: null });
  const who = data.userId === this.user?.id ? t('voice_runtime.you') : (data.username || t('voice.someone'));
  this._showToast(t('voice.music_stopped', { who }), 'info');
},

_handleMusicControl(data) {
  if (data.action === 'pause') {
    this._suppressMusicBroadcasts();
    this._pauseMusicEmbed();
    this._setMusicPlayingUi(false);
    this._setMusicActivityHint(t('voice_runtime.user_paused', { user: data.username || t('voice.someone') }));
  } else if (data.action === 'play') {
    this._suppressMusicBroadcasts();
    this._playMusicEmbed();
    this._setMusicPlayingUi(true);
    this._setMusicActivityHint(t('voice_runtime.user_resumed', { user: data.username || t('voice.someone') }));
  } else if (data.action === 'next') {
    this._suppressMusicBroadcasts();
    this._musicNextTrack();
  } else if (data.action === 'prev') {
    this._suppressMusicBroadcasts();
    this._musicPrevTrack();
  } else if (data.action === 'shuffle') {
    this._suppressMusicBroadcasts();
    this._musicToggleShuffle();
  }
  if (data.syncState) this._applyMusicSyncState(data.syncState);
},

_handleMusicSeek(data) {
  if (!data) return;
  if (data.syncState) this._applyMusicSyncState(data.syncState);
  else if (typeof data.positionSeconds === 'number') this._applyMusicSyncState({ positionSeconds: data.positionSeconds });
  else if (typeof data.position === 'number') this._seekMusic(data.position);
  if (data.username) this._setMusicActivityHint(t('voice_runtime.user_seeked', { user: data.username }));
},

_toggleMusicPlayPause() {
  this._suppressMusicBroadcasts();
  if (this._musicPlaying) {
    this._pauseMusicEmbed();
    this._setMusicPlayingUi(false);
    this._setMusicActivityHint(t('voice_runtime.you_paused'));
  } else {
    this._playMusicEmbed();
    this._setMusicPlayingUi(true);
    this._setMusicActivityHint(t('voice_runtime.you_resumed'));
  }
  this._emitMusicControl(this._musicPlaying ? 'play' : 'pause');
},

_musicTrackControl(action) {
  if (action === 'next' && !this._musicSCWidget) {
    this._emitMusicFinished(true);
    return;
  }
  this._suppressMusicBroadcasts();
  if (action === 'next') this._musicNextTrack();
  else if (action === 'prev') this._musicPrevTrack();
  else if (action === 'shuffle') this._musicToggleShuffle();
  if (this.voice && this.voice.inVoice) {
    this.socket.emit('music-control', { code: this.voice.currentChannel, action });
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
    this._showToast(this._musicSCShuffle ? t('voice.shuffle_on') : t('voice.shuffle_off'), 'info');
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
  this._pendingMusicSyncState = null;
  this._musicTrackId = null;
  this._musicRequestorId = null;
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
    this._showToast(t('toasts.no_music_playing'), 'error');
    return;
  }

  // If already in PiP overlay, pop back in
  if (this._musicPip) {
    this._popInMusicPlayer();
    return;
  }
  //PiP changes look larger than reality because of indentation changes from wrapping
  this._captureCurrentMusicSyncState((syncState) => {
    // Create floating PiP overlay
    const pip = document.createElement('div');
    pip.id = 'music-pip-overlay';
    pip.className = 'music-pip-overlay';

    const volume = parseInt(document.getElementById('music-volume-slider')?.value ?? '80');
    const platform = this._musicPlatform || t('voice.music');
    const playing = this._musicPlaying;

    const savedOpacity = parseInt(localStorage.getItem('haven_pip_opacity') ?? '100');

    pip.innerHTML = `
      <div class="music-pip-header" id="music-pip-drag">
        <button class="music-pip-btn" id="music-pip-popin" title="${t('media.music_pip_minimize')}">─</button>
        <div class="music-pip-copy">
          <span class="music-pip-label"><span class="music-pip-label-icon" aria-hidden="true">🎶</span> ${platform}</span>
          <span class="music-up-next music-pip-up-next" id="music-pip-up-next">${t('media.music_up_next_empty')}</span>
        </div>
        <span class="music-activity-hint" id="music-pip-activity-hint"></span>
        <button class="music-pip-btn" id="music-pip-queue-btn" title="${t('media.music_queue')}">☰</button>
        <button class="music-pip-btn" id="music-pip-fullscreen" title="${t('media.fullscreen')}">⤢</button>
        <button class="music-pip-btn" id="music-pip-close" title="${t('media.music_stop')}">✕</button>
      </div>
      <div class="music-pip-embed" id="music-pip-embed"></div>
      <div class="music-pip-controls">
        <button class="music-pip-btn" id="music-pip-pp" title="${t('media.music_play_pause')}">${playing ? '⏸' : '▶'}</button>
        <span class="music-pip-vol-icon" id="music-pip-mute" title="${t('media.music_mute')}">🔊</span>
        <input type="range" class="music-pip-vol" id="music-pip-vol" min="0" max="100" value="${volume}">
        <span class="pip-opacity-divider"></span>
        <span class="music-pip-vol-icon" id="music-pip-opacity-icon" title="${t('voice_runtime.window_opacity')}">👁</span>
        <input type="range" class="music-pip-vol pip-opacity-slider" id="music-pip-opacity" min="20" max="100" value="${savedOpacity}">
      </div>
    `;

    pip.style.opacity = savedOpacity / 100;

    document.body.appendChild(pip);
    this._syncMusicQueueUi();
    this._applyMusicControlPermissions();

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
    this._restoreMusicSyncStateAfterMove(syncState);

    // Update popout button icon to show "pop-in"
    const popBtn = document.getElementById('music-popout-btn');
    if (popBtn) { popBtn.textContent = '⧈'; popBtn.title = t('media.pop_back_in'); }

    // ── PiP controls ──
    document.getElementById('music-pip-popin').addEventListener('click', () => this._popInMusicPlayer());
    document.getElementById('music-pip-queue-btn').addEventListener('click', () => this._openMusicQueueModal());
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
        document.exitFullscreen().catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
      } else {
        (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el).catch(() => { /* fullscreen refused (needs a click, or not allowed here): nothing changes */ });
      }
    };
    document.getElementById('music-pip-fullscreen').addEventListener('click', toggleMusicFS);
    document.getElementById('music-pip-embed').addEventListener('dblclick', toggleMusicFS);
    document.addEventListener('fullscreenchange', () => {
      const fsBtn = document.getElementById('music-pip-fullscreen');
      if (!fsBtn) return;
      if (document.fullscreenElement === pip) {
        fsBtn.textContent = '⤡'; fsBtn.title = t('media.exit_fullscreen');
      } else {
        fsBtn.textContent = '⤢'; fsBtn.title = t('media.fullscreen');
      }
    });

    // ── Dragging ──
    this._initPipDrag(pip, document.getElementById('music-pip-drag'));
  });
},

_popInMusicPlayer() {
  const pip = this._musicPip;
  if (!pip) return;

  this._captureCurrentMusicSyncState((syncState) => {
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

    this._restoreMusicSyncStateAfterMove(syncState);

    // Restore popout button icon
    const popBtn = document.getElementById('music-popout-btn');
    if (popBtn) { popBtn.textContent = '⧉'; popBtn.title = t('media.music_popout'); }
  });
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
    ind.textContent = `🎵 ${t('voice.music_playing')}`;
    ind.title = t('voice.music_show_player');
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
      if (dur > 0) this._seekMusicToSeconds(dur * pct / 100);
    } else if (this._musicSCWidget) {
      this._musicSCWidget.getDuration((dur) => {
        if (dur > 0) this._seekMusicToSeconds((dur / 1000) * pct / 100);
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
        const now = Date.now();
        if (curEl) curEl.textContent = fmt(cur);
        if (durEl) durEl.textContent = fmt(dur);
        if (seekSlider && !this._musicSeeking && dur > 0) seekSlider.value = (cur / dur * 100).toFixed(1);
        if (this._musicLastTrackedPosition != null && !this._shouldSuppressMusicBroadcasts()) {
          const elapsed = this._musicPlaying ? (now - (this._musicLastTrackedAt || now)) / 1000 : 0;
          const expected = this._musicLastTrackedPosition + Math.max(0, elapsed);
          if (Math.abs(cur - expected) > 2 && now - (this._musicLastSeekBroadcastAt || 0) > 1200) {
            this._emitMusicSeek(cur, dur);
          }
        }
        this._musicLastTrackedPosition = cur;
        this._musicLastTrackedAt = now;
      } else if (this._musicSCWidget) {
        this._musicSCWidget.getPosition((pos) => {
          this._musicSCWidget.getDuration((dur) => {
            const curS = (pos || 0) / 1000;
            const durS = (dur || 0) / 1000;
            const now = Date.now();
            if (curEl) curEl.textContent = fmt(curS);
            if (durEl) durEl.textContent = fmt(durS);
            if (seekSlider && !this._musicSeeking && durS > 0) seekSlider.value = (curS / durS * 100).toFixed(1);
            if (this._musicLastTrackedPosition != null && !this._shouldSuppressMusicBroadcasts()) {
              const elapsed = this._musicPlaying ? (now - (this._musicLastTrackedAt || now)) / 1000 : 0;
              const expected = this._musicLastTrackedPosition + Math.max(0, elapsed);
              if (Math.abs(curS - expected) > 2 && now - (this._musicLastSeekBroadcastAt || 0) > 1200) {
                this._emitMusicSeek(curS, durS);
              }
            }
            this._musicLastTrackedPosition = curS;
            this._musicLastTrackedAt = now;
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
  this._musicLastTrackedPosition = null;
  this._musicLastTrackedAt = 0;
},

_getMusicEmbed(url) {
  if (!url) return null;
  const spotifyMatch = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
  if (spotifyMatch) return `https://open.spotify.com/embed/${spotifyMatch[1]}/${spotifyMatch[2]}?theme=0&utm_source=generator&autoplay=1`;
  const ytMusicMatch = url.match(/music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (ytMusicMatch) return `https://www.youtube-nocookie.com/embed/${ytMusicMatch[1]}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&rel=0`;
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `https://www.youtube-nocookie.com/embed/${ytMatch[1]}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&rel=0`;
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
