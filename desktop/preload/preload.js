/**
 * Haven Desktop — Preload Script
 *
 * Exposes a safe, narrow API to the renderer process via contextBridge.
 * The renderer (Haven's web UI) can call these methods to interact with
 * native desktop features without having direct access to Node.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('havenDesktop', {
  // ── Platform info ──────────────────────────────────────
  platform: process.platform,
  isDesktop: true,

  // ── Settings ───────────────────────────────────────────
  settings: {
    get:    (key)        => ipcRenderer.invoke('settings:get', key),
    set:    (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getAll: ()           => ipcRenderer.invoke('settings:getAll'),
  },

  // ── Server connection ──────────────────────────────────
  server: {
    setUrl: (url) => ipcRenderer.invoke('server:setUrl', url),
    getUrl: ()    => ipcRenderer.invoke('server:getUrl'),
  },

  // ── Audio routing (virtual cable) ──────────────────────
  audio: {
    /** Get list of running apps that are producing audio */
    getRunningApps:    ()      => ipcRenderer.invoke('audio:getRunningApps'),
    /** Get current audio routes */
    getRoutes:         ()      => ipcRenderer.invoke('audio:getRoutes'),
    /** Route an app's audio to a virtual cable device */
    setRoute:          (route) => ipcRenderer.invoke('audio:setRoute', route),
    /** Remove a route (restore to default) */
    removeRoute:       (appId) => ipcRenderer.invoke('audio:removeRoute', appId),
    /** Get available audio devices (real + virtual) */
    getDevices:        ()      => ipcRenderer.invoke('audio:getDevices'),
    /** Check if virtual audio cable driver is installed */
    isDriverInstalled: ()      => ipcRenderer.invoke('audio:isDriverInstalled'),
    /** Prompt to install the virtual audio cable driver */
    installDriver:     ()      => ipcRenderer.invoke('audio:installDriver'),
    /** Get all system input/output audio devices with details */
    getSystemDevices:  ()      => ipcRenderer.invoke('audio:getSystemDevices'),
    /** Set preferred default audio device ({ deviceId, type: 'input'|'output' }) */
    setDefaultDevice:  (opts)  => ipcRenderer.invoke('audio:setDefaultDevice', opts),
    /** Get saved default device preferences */
    getDefaultDevices: ()      => ipcRenderer.invoke('audio:getDefaultDevices'),
    /** Check if SoundVolumeView is available for automated per-app routing */
    isSVVAvailable:    ()      => ipcRenderer.invoke('audio:isSVVAvailable'),
  },

  // ── Window controls (frameless title bar) ──────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  // ── Zoom ───────────────────────────────────────────────
  zoom: {
    get: ()      => ipcRenderer.invoke('zoom:get'),
    set: (factor) => ipcRenderer.invoke('zoom:set', factor),
  },

  // ── Native notifications ───────────────────────────────
  notify: ({ title, body, icon }) => {
    ipcRenderer.send('notification:show', { title, body, icon });
  },

  // ── Shell ──────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
