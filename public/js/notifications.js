// ═══════════════════════════════════════════════════════════
// Haven — Notification Tone System (Web Audio API + Audio Files)
// Zero dependencies — generates tones programmatically,
// plays AIM-style sounds & custom uploaded audio files
// ═══════════════════════════════════════════════════════════

class NotificationManager {
  constructor() {
    this.audioCtx = null;
    this.enabled = this._loadPref('haven_notif_enabled', false);
    this.mentionsEnabled = this._loadPref('haven_notif_mentions_enabled', true);
    this.repliesEnabled = this._loadPref('haven_notif_replies_enabled', true);
    this.dmEnabled = this._loadPref('haven_notif_dm_enabled', true);
    this.volume = this._loadPref('haven_notif_volume', 0.5);
    this.mentionVolume = this._loadPref('haven_notif_mention_volume', 0.8);
    this.replyVolume = this._loadPref('haven_notif_reply_volume', 0.8);
    this.joinVolume = this._loadPref('haven_notif_join_volume', 0.8);
    this.leaveVolume = this._loadPref('haven_notif_leave_volume', 0.8);
    this.sounds = {
      message: this._loadPref('haven_notif_msg_sound', 'ping'),
      sent: this._loadPref('haven_notif_sent_sound', 'swoosh'),
      mention: this._loadPref('haven_notif_mention_sound', 'bell'),
      reply: this._loadPref('haven_notif_reply_sound', 'chime'),
      join: this._loadPref('haven_notif_join_sound', 'chime'),
      leave: this._loadPref('haven_notif_leave_sound', 'drop'),
      announcement: this._loadPref('haven_notif_announcement_sound', 'announcement'),
    };
    this._audioCache = {}; // cache Audio objects for custom sounds
  }

  _loadPref(key, fallback) {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    const n = parseFloat(v);
    return isNaN(n) ? v : n;
  }

  _savePref(key, value) {
    localStorage.setItem(key, String(value));
  }

  _getCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  // ── Synth Tone Engine ───────────────────────────────────

  _playTone(frequencies, durations, type = 'sine') {
    if (this.volume <= 0) return;
    try {
      const ctx = this._getCtx();
      const masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);

      let time = ctx.currentTime;
      frequencies.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, time);
        osc.connect(gain);
        gain.connect(masterGain);

        const dur = durations[i] || 0.15;
        const vol = this.volume * this.volume; // exponential curve for natural feel
        gain.gain.setValueAtTime(Math.max(vol, 0.001), time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
        osc.start(time);
        osc.stop(time + dur + 0.01);
        time += dur * 0.7;
      });
    } catch { /* audio context not available */ }
  }

  // ── Built-in Sounds ─────────────────────────────────────

  ping()  { this._playTone([880, 1320], [0.08, 0.12], 'sine'); }
  chime() { this._playTone([523, 659, 784], [0.1, 0.1, 0.2], 'sine'); }
  drop()  { this._playTone([600, 400], [0.1, 0.15], 'triangle'); }
  blip()  { this._playTone([1200], [0.06], 'square'); }
  bell()  { this._playTone([1047, 1319, 1568], [0.15, 0.15, 0.25], 'sine'); }
  alert() { this._playTone([880, 1100, 880, 1100], [0.08, 0.08, 0.08, 0.12], 'sine'); }
  chord() { this._playTone([523, 659, 784, 1047], [0.1, 0.08, 0.08, 0.2], 'sine'); }
  swoosh(){ this._playTone([400, 600, 800], [0.04, 0.04, 0.06], 'sine'); }  // soft ascending — "sent"
  announcement() { this._playTone([523, 659, 784, 1047], [0.12, 0.1, 0.1, 0.25], 'sine'); } // bright ascending chord — announcement

  // ── Voice action cues (always play at current volume) ───
  mute_on()  { this._playTone([600, 400], [0.06, 0.08], 'sine'); }
  mute_off() { this._playTone([400, 600], [0.06, 0.08], 'sine'); }
  deafen_on()  { this._playTone([500, 350, 250], [0.05, 0.06, 0.08], 'sine'); }
  deafen_off() { this._playTone([250, 350, 500], [0.05, 0.06, 0.08], 'sine'); }
  voice_join() { this._playTone([440, 554, 659], [0.08, 0.08, 0.14], 'sine'); }
  voice_leave(){ this._playTone([659, 554, 440], [0.08, 0.08, 0.14], 'triangle'); }
  stream_start() { this._playTone([523, 784, 1047], [0.06, 0.06, 0.12], 'sine'); }

  // ── Custom Sound File Playback ──────────────────────────

  _playFile(url) {
    if (this.volume <= 0) return;
    try {
      let audio = this._audioCache[url];
      if (!audio) {
        audio = new Audio(url);
        this._audioCache[url] = audio;
      }
      audio.volume = Math.max(0, Math.min(1, this.volume * this.volume));
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch { /* audio not available */ }
  }

  // ── Text-to-Speech ──────────────────────────────────────
  speak(text) {
    // TTS is sender-initiated (someone deliberately ran /tts), so don't
    // gate it behind the listener's master notification toggle. Volume
    // still applies via utter.volume below; setting volume to 0 mutes it.
    try {
      // Cancel any ongoing speech first to prevent overlap/queuing
      speechSynthesis.cancel();
      // Cap TTS length to prevent long messages from speaking forever
      const maxLen = 500;
      let cleaned = text.length > maxLen ? text.slice(0, maxLen) + '... message truncated' : text;
      // Strip @mentions so TTS doesn't read "at username"
      cleaned = cleaned.replace(/@(\w+)/g, '$1');
      const utter = new SpeechSynthesisUtterance(cleaned);
      utter.volume = Math.max(0, Math.min(1, this.volume));
      utter.rate = 1;
      utter.pitch = 1;
      speechSynthesis.speak(utter);
    } catch { /* speech synthesis not available */ }
  }

  stopTTS() {
    try { speechSynthesis.cancel(); } catch { /* not available */ }
  }

  // ── Public API ──────────────────────────────────────────

  play(event, opts) {
    // Per-type opt-in: mentions, replies, DMs bypass master toggle if their own toggle is on
    if (opts && opts.isMention && this.mentionsEnabled) { /* allowed */ }
    else if (opts && opts.isReply && this.repliesEnabled) { /* allowed */ }
    else if (opts && opts.isDm && this.dmEnabled) { /* allowed */ }
    // Regular message & announcement sounds are gated by the master toggle;
    // everything else (sent, join, leave) always plays
    else if ((event === 'message' || event === 'announcement') && !this.enabled) return;

    const sound = this.sounds[event];
    if (!sound || sound === 'none') return;

    // Use per-event volume if set
    const origVol = this.volume;
    if (event === 'mention') {
      this.volume = this.mentionVolume;
    } else if (event === 'reply') {
      this.volume = this.replyVolume;
    } else if (event === 'join') {
      this.volume = this.joinVolume;
    } else if (event === 'leave') {
      this.volume = this.leaveVolume;
    }

    // Custom uploaded sound (format: "custom:soundname")
    if (sound.startsWith('custom:')) {
      const name = sound.substring(7);
      // Look up URL from any notification select, or from app's custom sounds cache
      let url = null;
      const selIds = ['notif-msg-sound', 'notif-sent-sound', 'notif-mention-sound', 'notif-reply-sound', 'notif-join-sound', 'notif-leave-sound'];
      for (const id of selIds) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        const opt = sel.querySelector(`option[value="${CSS.escape(sound)}"]`);
        if (opt && opt.dataset.url) { url = opt.dataset.url; break; }
      }
      // Fallback: try app's customSounds array
      if (!url && window.app?.customSounds) {
        const cs = window.app.customSounds.find(s => s.name === name);
        if (cs) url = cs.url;
      }
      if (url) this._playFile(url);
      this.volume = origVol;
      return;
    }

    // Built-in synth or AIM sound
    if (typeof this[sound] === 'function') this[sound]();

    this.volume = origVol;
  }

  /** Play a named tone directly (bypasses event→sound mapping). Used for UI cues. */
  playDirect(toneName) {
    if (this.volume <= 0) return;
    if (typeof this[toneName] === 'function') this[toneName]();
  }

  setEnabled(val) {
    this.enabled = !!val;
    this._savePref('haven_notif_enabled', this.enabled);
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    this._savePref('haven_notif_volume', this.volume);
  }

  setMentionVolume(val) {
    this.mentionVolume = Math.max(0, Math.min(1, val));
    this._savePref('haven_notif_mention_volume', this.mentionVolume);
  }

  setReplyVolume(val) {
    this.replyVolume = Math.max(0, Math.min(1, val));
    this._savePref('haven_notif_reply_volume', this.replyVolume);
  }

  setJoinVolume(val) {
    this.joinVolume = Math.max(0, Math.min(1, val));
    this._savePref('haven_notif_join_volume', this.joinVolume);
  }

  setLeaveVolume(val) {
    this.leaveVolume = Math.max(0, Math.min(1, val));
    this._savePref('haven_notif_leave_volume', this.leaveVolume);
  }

  setSound(event, sound) {
    this.sounds[event] = sound;
    this._savePref(`haven_notif_${event}_sound`, sound);
  }
}
