// Mounts the call settings panel in the voice sidebar. The controls are
// described and built in call-settings-panel.js and driven by the call
// settings layer, so other places (the fullscreen popup, a pre-call page) can
// show the same controls. The sidebar copy keeps the element ids that themes,
// plugins and user CSS rely on. The fullscreen call popup and the Voice & video
// settings page mount their own copies.

import { createDeviceList, createCallSettingsPanel } from './call-settings-panel.js?v=4.29.71';
import { createMicPreview, createCameraPreview } from './call-settings-preview.js?v=4.29.71';

export default {

_mountVoiceSettingsPanel() {
  this.callSettingsDevices = createDeviceList();
  const host = document.getElementById('voice-settings-panel');
  if (!host) return;
  this.voiceSettingsPanel?.destroy();
  this.voiceSettingsPanel = createCallSettingsPanel(host, {
    settings: this.callSettings,
    devices: this.callSettingsDevices,
    legacyIds: true,
    getMicLevel: () => this._callSettingsMicLevel(),
  });
},

// A copy for the fullscreen call popup: every setting plus the voice volume,
// no element ids (the sidebar copy owns those). The caller destroys it when
// the popup closes, which stops its meter loop and subscriptions.
_mountFullscreenCallSettings(host) {
  if (!this.callSettingsDevices) this.callSettingsDevices = createDeviceList();
  const panel = createCallSettingsPanel(host, {
    settings: this.callSettings,
    devices: this.callSettingsDevices,
    include: ['voiceVolume'],
    getMicLevel: () => this._callSettingsMicLevel(),
  });
  this.callSettingsDevices.refresh();
  return panel;
},

_callSettingsMicLevel() {
  return this.voice && this.voice.inVoice ? this.voice.currentMicLevel : 0;
},

// Settings, Voice & video: the same controls, usable without joining a call,
// plus a microphone and camera test. Tests start only from their buttons and
// stop when the page is no longer on screen (settings closed, or another page
// picked), so no device stays open behind the user's back.
_mountCallSettingsPage() {
  const section = document.getElementById('section-call-settings');
  const host = document.getElementById('call-settings-page-panel');
  if (!section || !host) return;
  if (!this.callSettingsDevices) this.callSettingsDevices = createDeviceList();
  const micButton = document.getElementById('call-preview-mic');
  const camButton = document.getElementById('call-preview-camera');
  const video = document.getElementById('call-preview-video');
  const status = document.getElementById('call-preview-status');
  const loopback = document.getElementById('call-preview-loopback');
  const mic = createMicPreview({
    // The call's own noise gate and AI suppression (voice.js), so the test
    // sounds like a call. A test never touches a running call's chain.
    createChain: typeof MicChain === 'function'
      ? (stream) => new MicChain(stream, { noiseMode: this.callSettings.get('noiseMode') })
      : undefined,
    onOutputMissing: () => say('settings.call.output_missing'),
  });
  // The test plays the mic back on the output picked on this page, unless
  // the user is deafened in a call.
  const hearing = () => !!loopback?.checked && !this.voice?.isDeafened;
  mic.setOutput(this.callSettings.get('outputDevice'));
  mic.setPlayback(hearing());
  loopback?.addEventListener('change', () => mic.setPlayback(hearing()));
  this._syncCallSettingsPlayback = () => mic.setPlayback(hearing());
  this.callSettings.subscribe('outputDevice', (id) => mic.setOutput(id));
  this.callSettings.subscribe('noiseMode', (mode) => mic.setNoiseMode(mode));
  this.callSettings.subscribe('noiseSensitivity', (value) => mic.setNoiseSensitivity(value));
  const camera = createCameraPreview({
    constraintsFor: (id) => this.voice?._webcamConstraints?.(id) ?? (id ? { deviceId: { exact: id } } : true),
  });
  this.callSettingsPreview = { mic, camera };

  this.callSettingsPage?.destroy();
  this.callSettingsPage = createCallSettingsPanel(host, {
    settings: this.callSettings,
    devices: this.callSettingsDevices,
    include: ['voiceVolume'],
    getMicLevel: () => (mic.active ? mic.level() : this._callSettingsMicLevel()),
  });

  const label = (button, key) => {
    const span = button?.querySelector('span');
    if (!span) return;
    span.setAttribute('data-i18n', key);
    span.textContent = t(key);
  };
  const say = (key, params) => {
    if (!status) return;
    status.textContent = key ? t(key, params) : '';
    status.hidden = !key;
  };
  const failure = (err) => (err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
    ? 'settings.call.permission_denied' : 'settings.call.preview_failed');
  const sync = () => {
    label(micButton, mic.active ? 'settings.call.stop_mic' : 'settings.call.test_mic');
    label(camButton, camera.active ? 'settings.call.stop_camera' : 'settings.call.test_camera');
    micButton?.setAttribute('aria-pressed', String(mic.active));
    camButton?.setAttribute('aria-pressed', String(camera.active));
    if (video) {
      video.hidden = !camera.active;
      if (!camera.active) video.srcObject = null;
    }
  };

  const startMic = async () => {
    say(null);
    try {
      const { fellBack, superseded } = await mic.start(this.callSettings.get('inputDevice'));
      if (superseded) return;
      if (fellBack) say('settings.call.mic_missing');
      // Names show once the microphone has been allowed.
      this.callSettingsDevices.refresh();
    } catch (err) {
      console.warn('[CallSettings] microphone test failed', err);
      say(failure(err));
    }
    sync();
  };
  const startCamera = async () => {
    say(null);
    if (this.voice?.isWebcamActive) { say('settings.call.camera_in_call'); sync(); return; }
    try {
      const { fellBack, superseded } = await camera.start(this.callSettings.get('cameraDevice'));
      if (superseded) return;
      if (fellBack) say('settings.call.camera_missing');
      if (video) {
        video.srcObject = camera.stream;
        video.play?.()?.catch?.(() => { /* muted autoplay; the frame still shows */ });
      }
      this.callSettingsDevices.refresh();
    } catch (err) {
      console.warn('[CallSettings] camera test failed', err);
      say(failure(err));
    }
    sync();
  };
  const stopAll = () => {
    if (!mic.active && !camera.active) return;
    mic.stop();
    camera.stop();
    sync();
  };

  micButton?.addEventListener('click', () => {
    if (mic.active) { mic.stop(); say(null); sync(); } else startMic();
  });
  camButton?.addEventListener('click', () => {
    if (camera.active) { camera.stop(); say(null); sync(); } else startCamera();
  });
  // Picking another device or camera quality during a test switches to it.
  this.callSettings.subscribe('inputDevice', () => { if (mic.active) startMic(); });
  this.callSettings.subscribe('cameraDevice', () => { if (camera.active) startCamera(); });
  this.callSettings.subscribe('cameraQuality', () => { if (camera.active) startCamera(); });

  // Shown: list the devices. Hidden (whichever way settings closed): stop.
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.callSettingsDevices.refresh();
      else stopAll();
    }).observe(section);
  }
  sync();
  say(null);
},

};
