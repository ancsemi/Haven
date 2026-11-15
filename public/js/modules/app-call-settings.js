// Mounts the call settings panel in the voice sidebar. The controls are
// described and built in call-settings-panel.js and driven by the call
// settings layer, so other places (the fullscreen popup, a pre-call page) can
// show the same controls. The sidebar copy keeps the element ids that themes,
// plugins and user CSS rely on.

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
    getMicLevel: () => (this.voice && this.voice.inVoice ? this.voice.currentMicLevel : 0),
  });
},

};
