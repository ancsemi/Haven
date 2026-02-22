/**
 * Haven Desktop — Main Process
 *
 * Responsibilities:
 *   1. Create & manage the BrowserWindow (load Haven web UI)
 *   2. System tray integration (minimize-to-tray, notifications)
 *   3. Virtual audio cable management (install/route per-app audio)
 *   4. IPC bridge between renderer and native audio subsystem
 *   5. Auto-update checks
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const Store  = require('electron-store');
const { AudioRouter } = require('./audio/audio-router');
const { TrayManager }  = require('./tray');

// ── Persistent settings ──────────────────────────────────
const store = new Store({
  defaults: {
    serverUrl: 'https://localhost:3000',
    minimizeToTray: true,
    startMinimized: false,
    audioRoutes: [],          // saved per-app audio routing config
    theme: 'system',          // 'system' | 'dark' | 'light'
    windowBounds: { width: 1280, height: 800 },
    zoomFactor: 1.0,
  }
});

// ── Globals ──────────────────────────────────────────────
let mainWindow  = null;
let trayManager = null;
let audioRouter = null;

// ── Accept self-signed certificates for localhost ────────
// Haven generates self-signed certs by default. Session-level cert
// verification is set in createWindow() for comprehensive coverage.

// ── Single instance lock ─────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Force dark window chrome ─────────────────────────────
nativeTheme.themeSource = 'dark';

// ── Create the main window ───────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width:  bounds.width,
    height: bounds.height,
    minWidth: 800,
    minHeight: 600,
    title: 'Haven',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#191b28',
    show: !store.get('startMinimized'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
    autoHideMenuBar: true,
    // macOS: inset traffic lights for clean look
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
    } : {}),
  });

  // Accept self-signed certs for localhost at the session level.
  // Haven generates self-signed certs by default; without this, Electron
  // rejects HTTPS connections to localhost (including Socket.IO websockets).
  mainWindow.webContents.session.setCertificateVerifyProc((request, callback) => {
    try {
      const { hostname } = new URL(request.hostname ? `https://${request.hostname}` : request.url || '');
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        callback(0); // 0 = certificate is trusted
        return;
      }
    } catch {}
    callback(-3); // -3 = use default Chromium verification
  });

  // Load Haven web UI — try saved URL, then auto-detect HTTPS/HTTP
  const serverUrl = store.get('serverUrl');
  let failedOnce = false;

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    console.error(`[Haven Desktop] Page load failed (${errorCode}): ${errorDesc} — ${validatedURL}`);

    // If the saved URL failed, try the alternate protocol before showing retry page
    if (!failedOnce) {
      failedOnce = true;
      try {
        const u = new URL(validatedURL || serverUrl);
        if (u.protocol === 'http:') {
          // Haven likely runs HTTPS — try https on same port
          u.protocol = 'https:';
          console.log(`[Haven Desktop] Retrying with ${u.href}`);
          mainWindow.loadURL(u.href);
          return;
        } else if (u.protocol === 'https:') {
          // Maybe server is HTTP-only — try http on same port
          u.protocol = 'http:';
          console.log(`[Haven Desktop] Retrying with ${u.href}`);
          mainWindow.loadURL(u.href);
          return;
        }
      } catch {}
    }

    // Both protocols failed — show retry page
    const retryUrl = store.get('serverUrl');
    mainWindow.webContents.loadURL(`data:text/html,` + encodeURIComponent(`<html>
<head><style>
  body { background: #191b28; color: #e2e4f0; font-family: 'Segoe UI', system-ui, sans-serif;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         height: 100vh; margin: 0; text-align: center; }
  h2 { margin-bottom: 8px; } p { color: #9498b3; margin-bottom: 24px; }
  button { background: #7c5cfc; color: #fff; border: none; padding: 10px 28px;
           border-radius: 8px; font-size: 15px; cursor: pointer; margin: 6px; }
  button:hover { background: #9478ff; }
  .hint { font-size: 13px; color: #5d6180; margin-top: 16px; }
</style></head>
<body>
  <h2>Can't reach Haven server</h2>
  <p>${retryUrl}</p>
  <button onclick="location.href='${retryUrl}'">Retry</button>
  <p class="hint">Make sure the Haven server is running.<br>Default: npm start in the Haven folder.</p>
</body></html>`));
  });

  mainWindow.loadURL(serverUrl);

  // Zoom
  mainWindow.webContents.setZoomFactor(store.get('zoomFactor'));

  // Save window bounds on resize/move
  const saveBounds = () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (store.get('minimizeToTray') && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject desktop-specific CSS overrides (e.g., drag region for title bar)
  // and renderer scripts for audio panel, device settings, and voice integration.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      /* Draggable title bar region */
      .topbar, .header, #topbar {
        -webkit-app-region: drag;
      }
      .topbar button, .topbar input, .topbar select,
      .header button, .header input {
        -webkit-app-region: no-drag;
      }
    `);

    // Inject renderer scripts (audio panel, device settings, voice integration)
    const rendererScripts = [
      path.join(__dirname, 'renderer', 'audio-panel.js'),
      path.join(__dirname, 'renderer', 'audio-settings.js'),
      path.join(__dirname, 'renderer', 'voice-integration.js'),
    ];
    for (const scriptPath of rendererScripts) {
      try {
        const code = fs.readFileSync(scriptPath, 'utf-8');
        mainWindow.webContents.executeJavaScript(code).catch(err => {
          console.warn('[Haven Desktop] Script injection error:', path.basename(scriptPath), err.message);
        });
      } catch (err) {
        console.warn('[Haven Desktop] Could not inject renderer script:', scriptPath, err.message);
      }
    }
  });
}

// ── App lifecycle ────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();

  // System tray
  trayManager = new TrayManager(mainWindow, store);

  // Audio router
  audioRouter = new AudioRouter(store);
  await audioRouter.initialize();

  // Register IPC handlers
  registerIPC();

  app.on('activate', () => {
    // macOS dock click
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (audioRouter) audioRouter.cleanup();
  if (trayManager) trayManager.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ─────────────────────────────────────────
function registerIPC() {

  // ── Settings ─────────────────────────────────────────
  ipcMain.handle('settings:get', (_, key) => store.get(key));
  ipcMain.handle('settings:set', (_, key, value) => {
    store.set(key, value);
    return true;
  });
  ipcMain.handle('settings:getAll', () => store.store);

  // ── Server URL ───────────────────────────────────────
  ipcMain.handle('server:setUrl', (_, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, reason: 'URL must start with http:// or https://' };
    }
    store.set('serverUrl', url);
    if (mainWindow) mainWindow.loadURL(url);
    return true;
  });
  ipcMain.handle('server:getUrl', () => store.get('serverUrl'));

  // ── Audio routing ────────────────────────────────────
  ipcMain.handle('audio:getRunningApps', () => {
    return audioRouter.getAudioApplications();
  });

  ipcMain.handle('audio:getRoutes', () => {
    return audioRouter.getRoutes();
  });

  ipcMain.handle('audio:setRoute', (_, route) => {
    return audioRouter.setRoute(route);
  });

  ipcMain.handle('audio:removeRoute', (_, appId) => {
    return audioRouter.removeRoute(appId);
  });

  ipcMain.handle('audio:getDevices', () => {
    return audioRouter.getVirtualDevices();
  });

  ipcMain.handle('audio:isDriverInstalled', () => {
    return audioRouter.isDriverInstalled();
  });

  // ── Audio device enumeration (input/output selection) ──
  // These return OS-level audio device lists via PowerShell (Win) or pactl (Linux).
  // The renderer also enumerates via navigator.mediaDevices, but this gives
  // more system-level detail and lets us set default devices.

  ipcMain.handle('audio:getSystemDevices', () => {
    return audioRouter.getSystemAudioDevices();
  });

  ipcMain.handle('audio:setDefaultDevice', (_, { deviceId, type }) => {
    return audioRouter.setDefaultDevice(deviceId, type);
  });

  ipcMain.handle('audio:getDefaultDevices', () => {
    return audioRouter.getDefaultDevices();
  });

  ipcMain.handle('audio:isSVVAvailable', () => {
    return audioRouter.isSoundVolumeViewAvailable();
  });

  ipcMain.handle('audio:installDriver', async () => {
    const alreadyInstalled = audioRouter.isDriverInstalled();
    if (alreadyInstalled) {
      return { success: true, reason: 'already-installed' };
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Install VB-CABLE Virtual Audio Driver',
      message:
        'Haven needs a virtual audio driver to enable per-app audio streaming.\n\n' +
        'Haven will automatically download and install VB-CABLE (free, from vb-audio.com).\n\n' +
        '• The driver will be downloaded (~1 MB)\n' +
        '• A UAC prompt will ask for administrator privileges\n' +
        '• Installation takes just a few seconds',
      buttons: ['Download & Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response !== 0) {
      return { success: false, reason: 'cancelled' };
    }

    // Show a progress message while downloading
    let progressWindow = null;
    try {
      progressWindow = new BrowserWindow({
        width: 380, height: 160,
        parent: mainWindow,
        modal: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        frame: false,
        transparent: false,
        backgroundColor: '#191b28',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      progressWindow.loadURL(`data:text/html,` + encodeURIComponent(`<html>
<head><style>
  body { background: #191b28; color: #e2e4f0; font-family: 'Segoe UI', system-ui, sans-serif;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         height: 100vh; margin: 0; text-align: center; }
  .spinner { width: 36px; height: 36px; border: 3px solid #2a2d40;
             border-top-color: #7c5cfc; border-radius: 50%;
             animation: spin 0.8s linear infinite; margin-bottom: 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { color: #9498b3; font-size: 14px; margin: 0; }
</style></head>
<body>
  <div class="spinner"></div>
  <p>Downloading VB-CABLE driver…</p>
</body></html>`));
    } catch {}

    const installResult = await audioRouter.installDriver();

    // Close progress window
    try { if (progressWindow && !progressWindow.isDestroyed()) progressWindow.close(); } catch {}

    if (!installResult.success) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Installation Issue',
        message: installResult.reason || 'VB-CABLE installation did not complete.',
        detail: installResult.downloadUrl
          ? `You can install it manually from:\n${installResult.downloadUrl}`
          : undefined,
        buttons: ['OK'],
      });
    } else {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'VB-CABLE Installed',
        message: 'VB-CABLE virtual audio driver was installed successfully!\n\nYou can now route per-app audio through Haven.',
        buttons: ['OK'],
      });
    }

    return installResult;
  });

  // ── Window controls (for frameless window) ───────────
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());

  // ── Zoom ─────────────────────────────────────────────
  ipcMain.handle('zoom:get', () => mainWindow?.webContents.getZoomFactor());
  ipcMain.handle('zoom:set', (_, factor) => {
    const clamped = Math.max(0.5, Math.min(2.0, factor));
    mainWindow?.webContents.setZoomFactor(clamped);
    store.set('zoomFactor', clamped);
    return clamped;
  });

  // ── Notifications (native OS) ────────────────────────
  ipcMain.on('notification:show', (_, { title, body, icon }) => {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon });
      n.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
      });
      n.show();
    }
  });

  // ── Shell ────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', (_, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
    console.warn('[Haven Desktop] Blocked openExternal for non-http URL:', url);
    return Promise.resolve();
  });
}
