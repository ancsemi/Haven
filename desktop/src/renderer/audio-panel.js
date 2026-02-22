/**
 * Haven Desktop — Audio Routing Panel (Renderer)
 *
 * Injects a per-app audio routing UI into Haven's voice chat interface.
 * Only active when running inside the Electron desktop app (detected
 * via window.havenDesktop).
 *
 * The panel lets users:
 *   1. See which apps are currently producing audio
 *   2. Route any app's audio to a virtual cable → voice chat
 *   3. Adjust per-app volume
 *   4. Install the virtual audio cable driver if not present
 */

(function () {
  'use strict';

  // Only run in desktop app
  if (!window.havenDesktop) return;

  const api = window.havenDesktop.audio;
  let panelEl = null;
  let isOpen  = false;
  let routes  = [];
  let apps    = [];
  let devices = [];
  let driverInstalled = false;
  let svvAvailable = false;

  // ── Inject the audio routing button into voice controls ──
  function injectButton() {
    // Wait for voice controls to exist
    const voiceControls = document.querySelector('.voice-controls, #voice-controls');
    if (!voiceControls) {
      setTimeout(injectButton, 2000);
      return;
    }

    // Don't double-inject
    if (document.getElementById('haven-audio-route-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'haven-audio-route-btn';
    btn.className = 'voice-btn';
    btn.title = 'App Audio Streaming';
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
    `;
    btn.addEventListener('click', togglePanel);
    voiceControls.appendChild(btn);
  }

  // ── Toggle the panel ─────────────────────────────────────
  async function togglePanel() {
    if (isOpen) {
      closePanel();
      return;
    }

    driverInstalled = await api.isDriverInstalled();
    routes  = await api.getRoutes();
    apps    = await api.getRunningApps();
    devices = await api.getDevices();

    // Check for SoundVolumeView (enables automated per-app routing on Windows)
    try {
      const svvInfo = await api.isSVVAvailable();
      svvAvailable = svvInfo?.available ?? false;
    } catch { svvAvailable = false; }

    openPanel();
  }

  // ── Build & show the panel ───────────────────────────────
  function openPanel() {
    if (panelEl) panelEl.remove();

    panelEl = document.createElement('div');
    panelEl.id = 'haven-audio-panel';
    panelEl.innerHTML = buildPanelHTML();
    document.body.appendChild(panelEl);

    // Bind events
    bindPanelEvents();
    isOpen = true;

    // Auto-refresh every 3 seconds
    panelEl._refreshTimer = setInterval(refreshApps, 3000);
  }

  function closePanel() {
    if (panelEl) {
      clearInterval(panelEl._refreshTimer);
      panelEl.remove();
      panelEl = null;
    }
    isOpen = false;
  }

  // ── HTML template ────────────────────────────────────────
  function buildPanelHTML() {
    if (!driverInstalled) {
      return `
        <div class="audio-panel-header">
          <span>🎵 App Audio Streaming</span>
          <button class="audio-panel-close" id="audio-panel-close">✕</button>
        </div>
        <div class="audio-panel-body">
          <div class="audio-panel-notice">
            <p><strong>Virtual Audio Cable Required</strong></p>
            <p>To stream app audio (games, music, etc.) into voice chat, Haven needs a virtual audio cable driver installed.</p>
            <button class="btn-accent" id="audio-install-driver">Install VB-CABLE (Free)</button>
            <p class="audio-panel-hint">Or <a href="#" id="audio-driver-link">download manually</a> from vb-audio.com</p>
          </div>
        </div>
      `;
    }

    const virtualDevices = devices.filter(d => d.isVirtual);
    const appRows = apps.map(app => {
      const route = routes.find(r => r.processName === app.name);
      return `
        <div class="audio-app-row" data-process="${app.name}">
          <div class="audio-app-info">
            <span class="audio-app-name">${escapeHtml(app.title || app.name)}</span>
            <span class="audio-app-process">${escapeHtml(app.name)}.exe</span>
          </div>
          <div class="audio-app-controls">
            ${route
              ? `<input type="range" class="audio-app-volume" min="0" max="200" value="${(route.volume || 100)}"
                   data-process="${app.name}" title="Volume: ${route.volume || 100}%">
                 <button class="audio-app-stop" data-process="${app.name}" title="Stop streaming">⏹</button>`
              : `<select class="audio-app-device" data-process="${app.name}">
                   <option value="">— Stream to voice —</option>
                   ${virtualDevices.map(d => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}
                 </select>
                 <button class="audio-app-start" data-process="${app.name}" title="Start streaming">▶</button>`
            }
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="audio-panel-header">
        <span>🎵 App Audio Streaming</span>
        <button class="audio-panel-close" id="audio-panel-close">✕</button>
      </div>
      <div class="audio-panel-body">
        ${apps.length === 0
          ? '<div class="audio-panel-empty">No apps are producing audio right now.<br>Play some music or start a game!</div>'
          : `<div class="audio-app-list">${appRows}</div>`
        }
        <div class="audio-panel-footer">
          <span class="audio-panel-hint">Route app audio into your voice channel. Others will hear it!</span>
          ${!svvAvailable ? '<span class="audio-panel-hint" style="margin-top:4px;display:block">⚠ For auto-routing, place <a href="#" id="audio-svv-link">SoundVolumeView.exe</a> in the audio-drivers folder. Without it, Windows Sound Settings will open for manual routing.</span>' : ''}
        </div>
      </div>
    `;
  }

  // ── Bind panel event listeners ───────────────────────────
  function bindPanelEvents() {
    panelEl.querySelector('#audio-panel-close')?.addEventListener('click', closePanel);

    // Install driver button
    panelEl.querySelector('#audio-install-driver')?.addEventListener('click', async () => {
      const result = await api.installDriver();
      if (result.success) {
        driverInstalled = true;
        panelEl.innerHTML = buildPanelHTML();
        bindPanelEvents();
      } else if (result.downloadUrl) {
        window.havenDesktop.openExternal(result.downloadUrl);
      }
    });

    panelEl.querySelector('#audio-driver-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.havenDesktop.openExternal('https://vb-audio.com/Cable/');
    });

    // SoundVolumeView download link
    panelEl.querySelector('#audio-svv-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.havenDesktop.openExternal('https://www.nirsoft.net/utils/sound_volume_view.html');
    });

    // Start streaming buttons
    panelEl.querySelectorAll('.audio-app-start').forEach(btn => {
      btn.addEventListener('click', async () => {
        const processName = btn.dataset.process;
        const select = panelEl.querySelector(`.audio-app-device[data-process="${processName}"]`);
        const targetDevice = select?.value;
        if (!targetDevice) return;

        await api.setRoute({ processName, targetDevice, volume: 100 });
        routes = await api.getRoutes();
        apps   = await api.getRunningApps();
        panelEl.innerHTML = buildPanelHTML();
        bindPanelEvents();
      });
    });

    // Stop streaming buttons
    panelEl.querySelectorAll('.audio-app-stop').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api.removeRoute(btn.dataset.process);
        routes = await api.getRoutes();
        apps   = await api.getRunningApps();
        panelEl.innerHTML = buildPanelHTML();
        bindPanelEvents();
      });
    });

    // Volume sliders
    panelEl.querySelectorAll('.audio-app-volume').forEach(slider => {
      slider.addEventListener('input', async () => {
        const processName = slider.dataset.process;
        const route = routes.find(r => r.processName === processName);
        if (route) {
          route.volume = parseInt(slider.value);
          slider.title = `Volume: ${route.volume}%`;
          await api.setRoute(route);
        }
      });
    });
  }

  // ── Refresh app list (polling) ───────────────────────────
  async function refreshApps() {
    if (!isOpen || !driverInstalled) return;
    const newApps = await api.getRunningApps();

    // Only re-render if the list changed
    const oldNames = apps.map(a => a.name).sort().join(',');
    const newNames = newApps.map(a => a.name).sort().join(',');
    if (oldNames !== newNames) {
      apps = newApps;
      routes = await api.getRoutes();
      panelEl.innerHTML = buildPanelHTML();
      bindPanelEvents();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Inject styles ────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #haven-audio-route-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
      }

      #haven-audio-panel {
        position: fixed;
        bottom: 60px;
        left: 260px;
        width: 380px;
        max-height: 500px;
        background: var(--bg-card, #1c1e33);
        border: 1px solid var(--border, #2d3050);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: var(--font, 'Segoe UI', system-ui, sans-serif);
      }

      .audio-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border, #2d3050);
        font-weight: 600;
        font-size: 14px;
        color: var(--text, #e2e4f0);
      }

      .audio-panel-close {
        background: none;
        border: none;
        color: var(--text-muted, #9498b3);
        cursor: pointer;
        font-size: 16px;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .audio-panel-close:hover {
        background: var(--bg-hover, #2c2f4a);
        color: var(--text, #e2e4f0);
      }

      .audio-panel-body {
        padding: 12px;
        overflow-y: auto;
        flex: 1;
      }

      .audio-panel-empty {
        text-align: center;
        padding: 24px 16px;
        color: var(--text-muted, #9498b3);
        font-size: 13px;
        line-height: 1.5;
      }

      .audio-panel-notice {
        text-align: center;
        padding: 16px;
      }
      .audio-panel-notice p {
        margin-bottom: 12px;
        color: var(--text-muted, #9498b3);
        font-size: 13px;
      }
      .audio-panel-notice p:first-child { color: var(--text, #e2e4f0); }

      .audio-app-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-radius: 8px;
        margin-bottom: 4px;
        transition: background 0.15s;
      }
      .audio-app-row:hover {
        background: var(--bg-hover, #2c2f4a);
      }

      .audio-app-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }
      .audio-app-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text, #e2e4f0);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .audio-app-process {
        font-size: 11px;
        color: var(--text-dim, #5d6180);
      }

      .audio-app-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      .audio-app-device {
        background: var(--bg-input, #15172a);
        color: var(--text, #e2e4f0);
        border: 1px solid var(--border, #2d3050);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
        max-width: 140px;
      }

      .audio-app-start, .audio-app-stop {
        background: none;
        border: 1px solid var(--border, #2d3050);
        color: var(--text, #e2e4f0);
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 14px;
      }
      .audio-app-start:hover { background: var(--accent, #7c5cfc); border-color: var(--accent); }
      .audio-app-stop:hover  { background: var(--danger, #f04747); border-color: var(--danger); }

      .audio-app-volume {
        width: 80px;
        accent-color: var(--accent, #7c5cfc);
      }

      .audio-panel-footer {
        padding: 8px 12px;
        border-top: 1px solid var(--border, #2d3050);
      }
      .audio-panel-hint {
        font-size: 11px;
        color: var(--text-dim, #5d6180);
      }
      .audio-panel-hint a {
        color: var(--text-link, #82aaff);
      }

      .btn-accent {
        background: var(--accent, #7c5cfc);
        color: #fff;
        border: none;
        padding: 8px 20px;
        border-radius: 8px;
        font-size: 14px;
        cursor: pointer;
        font-weight: 500;
      }
      .btn-accent:hover { background: var(--accent-bright, #9478ff); }
    `;
    document.head.appendChild(style);
  }

  // ── Bootstrap ────────────────────────────────────────────
  injectStyles();
  // Wait for DOM to be ready, then inject the button
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

  // Also re-inject when navigating within the SPA
  const observer = new MutationObserver(() => {
    if (!document.getElementById('haven-audio-route-btn')) {
      injectButton();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
