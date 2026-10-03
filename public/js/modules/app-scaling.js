// ═══════════════════════════════════════════════════════════
// Large Server Setup (Settings, admin only)
//
// The voice relay card is saved with its own button and takes effect at once
// (the server restarts the relay and relayed calls reconnect), so it is kept
// out of the general Save/Cancel snapshot. The checklist below it only jumps
// to the settings pages that already hold those options.
// ═══════════════════════════════════════════════════════════

export default {

_setupLargeServerSection() {
  const section = document.getElementById('section-large-server');
  if (!section || this._largeServerReady) return;
  this._largeServerReady = true;

  section.querySelectorAll('input[name="voice-relay-mode"]').forEach(radio => {
    radio.addEventListener('change', () => this._updateLargeServerVisibility());
  });

  const port = document.getElementById('voice-relay-port');
  const workers = document.getElementById('voice-relay-workers');
  port?.addEventListener('input', () => this._updateRelayPortHint());
  workers?.addEventListener('change', () => this._updateRelayPortHint());

  document.getElementById('voice-relay-detect')?.addEventListener('click', () => {
    const btn = document.getElementById('voice-relay-detect');
    const input = document.getElementById('voice-relay-address');
    btn.disabled = true;
    btn.textContent = t('settings.admin.large_server.detecting');
    this.socket.emit('voice-relay-detect-address', null, (res) => {
      btn.disabled = false;
      btn.textContent = t('settings.admin.large_server.detect');
      if (res?.address) input.value = res.address;
      else this._showToast(t('settings.admin.large_server.detect_failed'), 'error');
    });
  });

  document.getElementById('voice-relay-save')?.addEventListener('click', () => this._saveVoiceRelay());
  document.getElementById('voice-relay-install-btn')?.addEventListener('click', () => this._installVoiceRelay());
  this.socket.on('voice-relay-install-progress', ({ line } = {}) => {
    const log = document.getElementById('voice-relay-install-log');
    if (log && line) { log.textContent = line; log.classList.remove('is-error'); }
  });

  section.querySelectorAll('[data-large-server-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector(`.settings-nav-item[data-target="${btn.dataset.largeServerOpen}"]`)?.click();
    });
  });

  this.socket.on('voice-relay-status', (status) => {
    this._voiceRelayStatus = status;
    this._updateLargeServerVisibility();
    this._updateRelayPortHint();
  });
},

/** Fills the page from saved settings and asks the server how the relay is doing. */
_renderLargeServerSection() {
  if (!this.user?.isAdmin) return;
  this._setupLargeServerSection();
  const s = this.serverSettings || {};
  const mode = s.voice_relay_mode === 'builtin' ? 'builtin' : 'off';
  const radio = document.querySelector(`input[name="voice-relay-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  const port = document.getElementById('voice-relay-port');
  if (port) port.value = s.voice_relay_port || '40000';
  const workers = document.getElementById('voice-relay-workers');
  if (workers) workers.value = s.voice_relay_workers || '1';
  const address = document.getElementById('voice-relay-address');
  if (address) address.value = s.voice_relay_address || '';
  this._updateLargeServerVisibility();
  this.socket.emit('voice-relay-status');
},

_updateLargeServerVisibility() {
  const mode = document.querySelector('input[name="voice-relay-mode"]:checked')?.value || 'off';
  // Not installed yet: the install step comes before the settings.
  const installed = this._voiceRelayStatus ? this._voiceRelayStatus.available !== false : true;
  const options = document.getElementById('voice-relay-builtin-options');
  if (options) options.style.display = mode === 'builtin' && installed ? '' : 'none';
  const install = document.getElementById('voice-relay-install');
  if (install) install.style.display = mode === 'builtin' && !installed ? '' : 'none';
  const saveRow = document.getElementById('voice-relay-save')?.parentElement;
  if (saveRow) saveRow.style.display = mode === 'builtin' && !installed ? 'none' : '';
  this._updateRelayPortHint();
  this._renderVoiceRelayStatus();
},

_relayPorts(port, workers) {
  return workers > 1 ? `${port}-${port + workers - 1}` : String(port);
},

_updateRelayPortHint() {
  const hint = document.getElementById('voice-relay-port-hint');
  if (!hint) return;
  const port = parseInt(document.getElementById('voice-relay-port')?.value, 10) || 40000;
  const workers = parseInt(document.getElementById('voice-relay-workers')?.value, 10) || 1;
  const ports = this._relayPorts(port, workers);
  hint.textContent = t('settings.admin.large_server.port_hint', { ports })
    + (this._voiceRelayStatus?.docker ? ' ' + t('settings.admin.large_server.docker_hint', { ports }) : '');
},

_renderVoiceRelayStatus() {
  const el = document.getElementById('voice-relay-status');
  const st = this._voiceRelayStatus;
  const chosen = document.querySelector('input[name="voice-relay-mode"]:checked')?.value || 'off';
  const installBtn = document.getElementById('voice-relay-install-btn');
  if (installBtn && !this._voiceRelayInstalling) installBtn.disabled = !!st?.installing;
  if (!el) return;
  el.className = 'large-server-status';
  if (!st) { el.textContent = ''; return; }
  if (chosen !== (st.mode === 'builtin' ? 'builtin' : 'off')) {
    el.textContent = t(chosen === 'builtin' ? 'settings.admin.large_server.status_unsaved_on' : 'settings.admin.large_server.status_unsaved_off');
  } else if (st.mode !== 'builtin') {
    el.textContent = t('settings.admin.large_server.status_off');
  } else if (st.state === 'running') {
    el.textContent = t('settings.admin.large_server.status_running', {
      address: st.address || '?',
      ports: (st.ports || []).length > 1 ? `${st.ports[0]}-${st.ports[st.ports.length - 1]}` : String((st.ports || [])[0] || ''),
      calls: st.calls || 0,
      people: st.people || 0,
    });
    el.classList.add('is-running');
  } else if (st.state === 'starting') {
    el.textContent = t('settings.admin.large_server.status_starting');
  } else if (st.error) {
    el.textContent = t('settings.admin.large_server.status_error', { error: st.error });
    el.classList.add('is-error');
  } else {
    el.textContent = '';
  }
},

_installVoiceRelay() {
  const btn = document.getElementById('voice-relay-install-btn');
  const log = document.getElementById('voice-relay-install-log');
  this._voiceRelayInstalling = true;
  if (btn) btn.disabled = true;
  if (log) { log.textContent = t('settings.admin.large_server.installing'); log.classList.remove('is-error'); }
  this.socket.emit('voice-relay-install', null, (res) => {
    this._voiceRelayInstalling = false;
    if (btn) btn.disabled = false;
    if (res?.ok) {
      if (log) log.textContent = '';
      this._showToast(t('settings.admin.large_server.installed'), 'success');
      this.socket.emit('voice-relay-status');
    } else if (log) {
      log.textContent = t('settings.admin.large_server.install_failed', { error: res?.error || '?' });
      log.classList.add('is-error');
    }
  });
},

_saveVoiceRelay() {
  const mode = document.querySelector('input[name="voice-relay-mode"]:checked')?.value || 'off';
  const payload = {
    mode,
    port: String(document.getElementById('voice-relay-port')?.value || '40000').trim(),
    workers: String(document.getElementById('voice-relay-workers')?.value || '1'),
    address: (document.getElementById('voice-relay-address')?.value || '').trim(),
  };
  const btn = document.getElementById('voice-relay-save');
  if (btn) btn.disabled = true;
  if (mode === 'builtin') {
    this._voiceRelayStatus = { ...(this._voiceRelayStatus || {}), mode: 'builtin', state: 'starting', available: true };
    this._renderVoiceRelayStatus();
  }
  this.socket.emit('voice-relay-save', payload, (res) => {
    if (btn) btn.disabled = false;
    if (!res || res.error) {
      this._showToast(res?.error || t('settings.admin.large_server.status_error', { error: '?' }), 'error');
      this.socket.emit('voice-relay-status');
      return;
    }
    this.serverSettings = {
      ...(this.serverSettings || {}),
      voice_relay_mode: payload.mode, voice_relay_port: payload.port,
      voice_relay_workers: payload.workers, voice_relay_address: payload.address,
    };
    this._voiceRelayStatus = res.status;
    this._renderVoiceRelayStatus();
    this._showToast(t('settings.admin.large_server.saved'), 'success');
  });
},

};
