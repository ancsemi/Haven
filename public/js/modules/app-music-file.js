// Listen Together with audio files uploaded to this server (#5826).
//
// The other sources are players from YouTube, SoundCloud and Spotify, which
// can refuse a track for one listener and not another. A file uploaded here
// plays straight from the server in an <audio> element, for everyone the
// same, with nothing outside involved. It is wrapped in the handful of calls
// the music code already makes on YouTube's player (play, pause, seek, time,
// volume), so the sync, seek bar and queue work on it unchanged.

const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)$/i;

export default {

// A file on this server, by its /uploads/ path.
_isMusicFileUrl(url) {
  return typeof url === 'string' && /^\/uploads\/[^?#\s]+$/.test(url) && AUDIO_EXT.test(url);
},

// A full link to a file on this server, as copied from a message, becomes
// its /uploads/ path; anything else is returned as it was.
_musicLocalPath(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.origin === location.origin && /^\/uploads\//.test(u.pathname)) return u.pathname;
  } catch { /* not a link at all: the music code says so */ }
  return url;
},

// The player the time, seek and volume code talks to: YouTube's, or the file's.
_musicApiPlayer() {
  return this._musicYTPlayer || this._musicFilePlayer || null;
},

_musicFileEmbedHtml(url, title) {
  const name = title || decodeURIComponent(url.split('/').pop() || '');
  return `<div class="music-embed-wrapper music-file-wrapper">
    <span class="music-file-icon" aria-hidden="true">🎵</span>
    <span class="music-file-title">${this._escapeHtml(name)}</span>
    <audio id="music-audio" src="${this._escapeHtml(url)}" preload="auto" autoplay></audio>
  </div>`;
},

_initMusicFilePlayer(audio, volume) {
  if (!audio) return;
  this._musicFileAudio = audio;
  const player = {
    playVideo: () => audio.play().catch(err => console.warn('[music] file did not start:', err.name)),
    pauseVideo: () => audio.pause(),
    seekTo: (seconds) => { audio.currentTime = Math.max(0, seconds); },
    getCurrentTime: () => audio.currentTime || 0,
    getDuration: () => (Number.isFinite(audio.duration) ? audio.duration : 0),
    setVolume: (v) => { audio.volume = Math.max(0, Math.min(100, Number(v) || 0)) / 100; },
  };
  player.setVolume(volume);
  // A replaced or stopped <audio> still fires its pause (and sometimes other
  // events) a moment later. Only the current one may report, or skipping a
  // track would send a pause that stops the next one for everyone.
  const current = () => this._musicFileAudio === audio;
  audio.addEventListener('loadedmetadata', () => {
    if (!current()) return;
    this._musicFilePlayer = player;
    this._startMusicTimeTracking();
    this._flushPendingMusicSyncState();
  }, { once: true });
  // The same reports YouTube's player gives through onStateChange.
  audio.addEventListener('play', () => {
    if (!current()) return;
    this._setMusicPlayingUi(true);
    if (!this._shouldSuppressMusicBroadcasts()) this._emitMusicControl('play');
  });
  audio.addEventListener('pause', () => {
    if (!current() || audio.ended) return;
    this._setMusicPlayingUi(false);
    if (!this._shouldSuppressMusicBroadcasts()) this._emitMusicControl('pause');
  });
  audio.addEventListener('ended', () => {
    if (!current()) return;
    this._setMusicPlayingUi(false);
    this._emitMusicFinished();
  });
  audio.addEventListener('error', () => {
    if (!current()) return;
    this._setMusicActivityHint(t('voice.music_file_failed'));
    this._showToast(t('voice.music_file_failed'), 'error');
  });
},

// An <audio> taken out of the page can keep playing while anything still
// holds it, so it is paused before the panel is cleared or replaced.
_stopMusicFilePlayer() {
  try { this._musicFileAudio?.pause(); } catch (err) { console.warn('[music] could not pause the file:', err.message); }
  this._musicFileAudio = null;
  this._musicFilePlayer = null;
},

// "Play for everyone in voice" on an uploaded audio file.
_musicListenHtml(fileUrl, fileName) {
  if (!this._isMusicFileUrl(fileUrl)) return '';
  return `<button type="button" class="media-btn media-listen" data-url="${this._escapeHtml(fileUrl)}" data-title="${this._escapeHtml(fileName || '')}" title="${t('voice.music_file_listen')}" aria-label="${t('voice.music_file_listen')}">${this._mediaIcon('music')}</button>`;
},

_setupMusicListenButtons() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.media-listen');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.voice || !this.voice.inVoice || !this.voice.currentChannel) {
      this._showToast(t('voice.music_file_join_voice'), 'info');
      return;
    }
    this.socket.emit('music-share', { code: this.voice.currentChannel, url: btn.dataset.url, title: btn.dataset.title || '' });
  }, true);
},

};
