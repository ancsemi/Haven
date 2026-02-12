// ═══════════════════════════════════════════════════════════
// Haven — Notification Tone System (Web Audio API + Audio Files)
// Zero dependencies — generates tones programmatically,
// plays AIM-style sounds & custom uploaded audio files
// ═══════════════════════════════════════════════════════════

class NotificationManager {
  constructor() {
    this.audioCtx = null;
    this.enabled = this._loadPref('haven_notif_enabled', true);
    this.volume = this._loadPref('haven_notif_volume', 0.5);
    this.mentionVolume = this._loadPref('haven_notif_mention_volume', 0.8);
    this.sounds = {
      message: this._loadPref('haven_notif_msg_sound', 'ping'),
      mention: this._loadPref('haven_notif_mention_sound', 'bell'),
      join: this._loadPref('haven_notif_join_sound', 'chime'),
      leave: this._loadPref('haven_notif_leave_sound', 'drop'),
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
    if (!this.enabled || this.volume <= 0) return;
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

  // ── Voice action cues (always play at current volume) ───
  mute_on()  { this._playTone([600, 400], [0.06, 0.08], 'sine'); }
  mute_off() { this._playTone([400, 600], [0.06, 0.08], 'sine'); }
  deafen_on()  { this._playTone([500, 350, 250], [0.05, 0.06, 0.08], 'sine'); }
  deafen_off() { this._playTone([250, 350, 500], [0.05, 0.06, 0.08], 'sine'); }
  voice_join() { this._playTone([440, 554, 659], [0.08, 0.08, 0.14], 'sine'); }
  voice_leave(){ this._playTone([659, 554, 440], [0.08, 0.08, 0.14], 'triangle'); }

  // ── AIM Classic Sounds (synthesized approximations) ────

  aim_message() {
    // Classic AIM "ding ding" two-tone incoming message
    if (!this.enabled || this.volume <= 0) return;
    try {
      const ctx = this._getCtx();
      const vol = this.volume * this.volume;
      const now = ctx.currentTime;
      // First tone: bright ding
      const o1 = ctx.createOscillator(); const g1 = ctx.createGain();
      o1.type = 'sine'; o1.frequency.setValueAtTime(1318.5, now); // E6
      o1.connect(g1); g1.connect(ctx.destination);
      g1.gain.setValueAtTime(vol, now);
      g1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      o1.start(now); o1.stop(now + 0.16);
      // Overtone shimmer
      const o1b = ctx.createOscillator(); const g1b = ctx.createGain();
      o1b.type = 'sine'; o1b.frequency.setValueAtTime(2637, now);
      o1b.connect(g1b); g1b.connect(ctx.destination);
      g1b.gain.setValueAtTime(vol * 0.3, now);
      g1b.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      o1b.start(now); o1b.stop(now + 0.11);
      // Second tone: slightly lower
      const o2 = ctx.createOscillator(); const g2 = ctx.createGain();
      o2.type = 'sine'; o2.frequency.setValueAtTime(1046.5, now + 0.12); // C6
      o2.connect(g2); g2.connect(ctx.destination);
      g2.gain.setValueAtTime(Math.max(vol * 0.8, 0.001), now + 0.12);
      g2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      o2.start(now + 0.12); o2.stop(now + 0.31);
    } catch { /* audio context not available */ }
  }

  aim_door_open() {
    // Classic AIM door open — ascending creaky chime
    if (!this.enabled || this.volume <= 0) return;
    try {
      const ctx = this._getCtx();
      const vol = this.volume * this.volume;
      const now = ctx.currentTime;
      const freqs = [330, 415, 523, 659, 784];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i < 3 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(f, now + i * 0.07);
        osc.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(Math.max(vol * (0.6 + i * 0.1), 0.001), now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.18);
        osc.start(now + i * 0.07); osc.stop(now + i * 0.07 + 0.19);
      });
    } catch { /* audio context not available */ }
  }

  aim_door_close() {
    // Classic AIM door slam — descending thump
    if (!this.enabled || this.volume <= 0) return;
    try {
      const ctx = this._getCtx();
      const vol = this.volume * this.volume;
      const now = ctx.currentTime;
      const freqs = [784, 659, 440, 330, 220];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i < 2 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(f, now + i * 0.06);
        osc.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(Math.max(vol * (0.8 - i * 0.1), 0.001), now + i * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.15);
        osc.start(now + i * 0.06); osc.stop(now + i * 0.06 + 0.16);
      });
      // Low thud for the "slam"
      const thud = ctx.createOscillator(); const tg = ctx.createGain();
      thud.type = 'sine'; thud.frequency.setValueAtTime(80, now + 0.28);
      thud.connect(tg); tg.connect(ctx.destination);
      tg.gain.setValueAtTime(Math.max(vol * 0.6, 0.001), now + 0.28);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      thud.start(now + 0.28); thud.stop(now + 0.46);
    } catch { /* audio context not available */ }
  }

  aim_nudge() {
    // Classic AIM nudge — buzzy vibration sound
    if (!this.enabled || this.volume <= 0) return;
    try {
      const ctx = this._getCtx();
      const vol = this.volume * this.volume;
      const now = ctx.currentTime;
      for (let i = 0; i < 6; i++) {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150 + (i % 2) * 50, now + i * 0.06);
        osc.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(Math.max(vol * 0.4, 0.001), now + i * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.05);
        osc.start(now + i * 0.06); osc.stop(now + i * 0.06 + 0.055);
      }
    } catch { /* audio context not available */ }
  }

  // ── Custom Sound File Playback ──────────────────────────

  _playFile(url) {
    if (!this.enabled || this.volume <= 0) return;
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
    if (!this.enabled) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.volume = Math.max(0, Math.min(1, this.volume));
      utter.rate = 1;
      utter.pitch = 1;
      speechSynthesis.speak(utter);
    } catch { /* speech synthesis not available */ }
  }

  // ── Public API ──────────────────────────────────────────

  play(event) {
    const sound = this.sounds[event];
    if (!sound || sound === 'none') return;

    // Use mention volume if this is a mention event
    const origVol = this.volume;
    if (event === 'mention') {
      this.volume = this.mentionVolume;
    }

    // Custom uploaded sound (format: "custom:soundname")
    if (sound.startsWith('custom:')) {
      const name = sound.substring(7);
      // Look up URL from custom sounds select options
      const sel = document.getElementById('notif-msg-sound') || document.getElementById('notif-mention-sound');
      if (sel) {
        const opt = sel.querySelector(`option[value="${CSS.escape(sound)}"]`);
        if (opt && opt.dataset.url) {
          this._playFile(opt.dataset.url);
        }
      }
      this.volume = origVol;
      return;
    }

    // Built-in synth or AIM sound
    if (typeof this[sound] === 'function') this[sound]();

    this.volume = origVol;
  }

  /** Play a named tone directly (bypasses event→sound mapping). Used for UI cues. */
  playDirect(toneName) {
    if (!this.enabled || this.volume <= 0) return;
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

  setSound(event, sound) {
    this.sounds[event] = sound;
    this._savePref(`haven_notif_${event}_sound`, sound);
  }
}
