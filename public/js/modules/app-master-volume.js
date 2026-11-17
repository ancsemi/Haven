// Master volume (Settings, Sounds): one level for everyone's voice and one
// for every notification sound, applied on top of each person's own volume
// and each sound's own volume. Sliders in that section show their value, as a
// percent or, with "Show volumes in dB", in decibels.

export default {

_setupMasterVolume() {
  const voice = document.getElementById('voice-master-volume');
  if (voice && this.voice) {
    voice.value = String(Math.round(this.voice._voiceMasterLevel() * 100));
    voice.addEventListener('input', () => {
      this.voice.setVoiceMasterVolume(voice.value / 100);
      this._syncFullscreenCallVolume?.();
    });
  }
  const notif = document.getElementById('notif-master-volume');
  if (notif && this.notifications) {
    notif.value = String(Math.round(this.notifications.master * 100));
    notif.addEventListener('input', () => this.notifications.setMasterVolume(notif.value / 100));
  }

  // The soundboard, for what this person plays (#5804). It scales what the
  // call hears too, so it is a "how loud am I" level, not a local one.
  const board = document.getElementById('soundboard-master-volume');
  if (board) {
    let saved = 100;
    try { saved = parseInt(localStorage.getItem('haven_soundboard_volume') || '100', 10); } catch { /* storage blocked: full volume */ }
    board.value = String(Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 100);
    board.addEventListener('input', () => {
      try { localStorage.setItem('haven_soundboard_volume', board.value); } catch { /* storage blocked: lasts until reload */ }
    });
  }

  let showDb = false;
  try { showDb = localStorage.getItem('haven_volume_show_db') === '1'; } catch { /* storage blocked: show percent */ }
  // Notification sounds play at the slider's value squared (a gentler curve),
  // so their decibels are 40 log10; voice gain is linear, 20 log10.
  const format = (input) => {
    const pct = Number(input.value);
    if (!showDb) return `${pct}%`;
    if (pct <= 0) return t('settings.sounds_section.volume_off');
    const db = (input.dataset.curve === 'linear' ? 20 : 40) * Math.log10(pct / 100);
    return `${db > 0.05 ? '+' : ''}${db.toFixed(1)} dB`;
  };
  const updates = [...document.querySelectorAll('#section-sounds input[type="range"]')].map((input) => {
    const out = document.createElement('output');
    out.className = 'vol-readout';
    input.after(out);
    const update = () => { out.textContent = format(input); };
    input.addEventListener('input', update);
    update();
    return update;
  });
  const toggle = document.getElementById('volume-show-db');
  if (toggle) {
    toggle.checked = showDb;
    toggle.addEventListener('change', () => {
      showDb = toggle.checked;
      try { localStorage.setItem('haven_volume_show_db', showDb ? '1' : '0'); } catch { /* storage blocked: the choice lasts until reload */ }
      updates.forEach(u => u());
    });
  }
},

};
