/**
 * Haven Desktop — Audio Device Settings Panel (Renderer)
 *
 * Adds an audio input/output device selection menu to Haven's settings UI.
 * Users can choose which microphone and speaker to use.
 *
 * Only active inside the Electron desktop app (window.havenDesktop).
 */

(function () {
  'use strict';

  if (!window.havenDesktop) return;

  const api = window.havenDesktop.audio;
  let settingsInjected = false;

  /**
   * Inject audio device dropdowns into Haven's settings modal.
   * We look for the settings modal and add our section to it.
   */
  async function injectDeviceSettings() {
    // Find the settings modal body (Haven uses a modal with id or class)
    const modal = document.querySelector('.settings-modal, #settings-modal, .modal-body, [data-section="settings"]');
    if (!modal || settingsInjected) return;
    if (document.getElementById('haven-audio-device-settings')) return;

    const section = document.createElement('div');
    section.id = 'haven-audio-device-settings';
    section.innerHTML = `
      <div class="audio-device-section">
        <h3 class="audio-device-title">🎧 Audio Devices</h3>
        <div class="audio-device-row">
          <label class="audio-device-label" for="haven-input-device">Microphone (Input)</label>
          <select id="haven-input-device" class="audio-device-select">
            <option value="">Loading...</option>
          </select>
        </div>
        <div class="audio-device-row">
          <label class="audio-device-label" for="haven-output-device">Speaker (Output)</label>
          <select id="haven-output-device" class="audio-device-select">
            <option value="">Loading...</option>
          </select>
        </div>
        <div class="audio-device-hint">
          Changes take effect the next time you join voice chat.
        </div>
      </div>
    `;

    modal.appendChild(section);
    settingsInjected = true;

    await populateDevices();
    bindDeviceEvents();
  }

  /**
   * Populate the device dropdowns with available system devices.
   * Uses both the native API (system device names) and the browser
   * MediaDevices API (device IDs needed for getUserMedia).
   */
  async function populateDevices() {
    const inputSelect  = document.getElementById('haven-input-device');
    const outputSelect = document.getElementById('haven-output-device');
    if (!inputSelect || !outputSelect) return;

    // Get browser-enumerated devices (these have the deviceId we need for getUserMedia)
    let browserDevices = [];
    try {
      browserDevices = await navigator.mediaDevices.enumerateDevices();
    } catch {}

    const audioInputs  = browserDevices.filter(d => d.kind === 'audioinput');
    const audioOutputs = browserDevices.filter(d => d.kind === 'audiooutput');

    // Get saved preferences
    const defaults = await api.getDefaultDevices();

    // Populate input dropdown
    inputSelect.innerHTML = '<option value="">System Default</option>';
    for (const device of audioInputs) {
      const label = device.label || `Microphone ${audioInputs.indexOf(device) + 1}`;
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = label;
      if (defaults.input === device.deviceId) opt.selected = true;
      inputSelect.appendChild(opt);
    }

    // Populate output dropdown
    outputSelect.innerHTML = '<option value="">System Default</option>';
    for (const device of audioOutputs) {
      const label = device.label || `Speaker ${audioOutputs.indexOf(device) + 1}`;
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = label;
      if (defaults.output === device.deviceId) opt.selected = true;
      outputSelect.appendChild(opt);
    }
  }

  /**
   * Bind change events on the device selects.
   */
  function bindDeviceEvents() {
    const inputSelect  = document.getElementById('haven-input-device');
    const outputSelect = document.getElementById('haven-output-device');

    if (inputSelect) {
      inputSelect.addEventListener('change', async () => {
        const deviceId = inputSelect.value || null;
        await api.setDefaultDevice({ deviceId, type: 'input' });
        // Store locally too so voice.js can read it
        localStorage.setItem('haven_input_device', deviceId || '');
      });
    }

    if (outputSelect) {
      outputSelect.addEventListener('change', async () => {
        const deviceId = outputSelect.value || null;
        await api.setDefaultDevice({ deviceId, type: 'output' });
        // Store locally and set the output device on all audio elements
        localStorage.setItem('haven_output_device', deviceId || '');
        applyOutputDevice(deviceId);
      });
    }
  }

  /**
   * Apply the selected output device to all <audio> and <video> elements.
   * Uses HTMLMediaElement.setSinkId() (Chromium-based browsers support this).
   */
  function applyOutputDevice(deviceId) {
    if (!deviceId) return;
    document.querySelectorAll('audio, video').forEach(el => {
      if (typeof el.setSinkId === 'function') {
        el.setSinkId(deviceId).catch(() => {});
      }
    });
  }

  // ── Inject styles ────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('haven-audio-device-styles')) return;
    const style = document.createElement('style');
    style.id = 'haven-audio-device-styles';
    style.textContent = `
      #haven-audio-device-settings {
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px solid var(--border, #2d3050);
      }

      .audio-device-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--text, #e2e4f0);
        margin-bottom: 16px;
      }

      .audio-device-row {
        margin-bottom: 14px;
      }

      .audio-device-label {
        display: block;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-muted, #9498b3);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .audio-device-select {
        width: 100%;
        padding: 8px 12px;
        background: var(--bg-input, #15172a);
        color: var(--text, #e2e4f0);
        border: 1px solid var(--border, #2d3050);
        border-radius: 8px;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s;
      }
      .audio-device-select:hover {
        border-color: var(--accent, #7c5cfc);
      }
      .audio-device-select:focus {
        border-color: var(--accent, #7c5cfc);
        box-shadow: 0 0 0 2px rgba(124, 92, 252, 0.2);
      }

      .audio-device-hint {
        font-size: 11px;
        color: var(--text-dim, #5d6180);
        margin-top: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Bootstrap ────────────────────────────────────────────
  injectStyles();

  // Watch for the settings modal to appear in the DOM
  const observer = new MutationObserver(() => {
    const modal = document.querySelector('.settings-modal, #settings-modal, .modal-body, [data-section="settings"]');
    if (modal && !document.getElementById('haven-audio-device-settings')) {
      settingsInjected = false;
      injectDeviceSettings();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also try immediately in case settings is already open
  injectDeviceSettings();

  // Expose a global so voice.js integration can read the preferred device
  window._havenAudioDevicePrefs = {
    getInputDeviceId:  () => localStorage.getItem('haven_input_device') || '',
    getOutputDeviceId: () => localStorage.getItem('haven_output_device') || '',
  };

})();
