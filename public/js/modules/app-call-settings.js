// Mounts the call settings panel in the voice sidebar. The controls are
// described and built in call-settings-panel.js and driven by the call
// settings layer, so other places (the fullscreen popup, a pre-call page) can
// show the same controls. The sidebar copy keeps the element ids that themes,
// plugins and user CSS rely on. The fullscreen call popup mounts its own copy.

import { createDeviceList, createCallSettingsPanel } from './call-settings-panel.js?v=4.29.57';

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

};
