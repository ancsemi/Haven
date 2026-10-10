# Haven Desktop App: Directive

> **Purpose:** This document captures the full design intent, architecture, and requirements
> for the Haven Desktop App. The desktop app is being rebuilt **from scratch** in a **separate
> repository**, completely independent from the Haven server repo.

---

## 1. Vision

A native desktop client for Haven that makes the entire experience brainlessly simple:
install, launch, and you're chatting. No terminal commands, no config files, no friction.

The desktop app is **not** part of the Haven server. It connects **to** a Haven server the same
way a browser does. It's just a better experience.

---

## 2. User Flow

### First Launch (Fresh Install)

1. **Admin launches their Haven server** the normal way (Start Haven.bat, `npm start`, Docker, etc.)
2. **Browser users** see a popup prompting them to install the Haven Desktop App.
3. Clicking "Install" downloads a **one-click installer** (Windows `.exe` / Linux `.AppImage` or `.deb`).
4. User runs the installer. **No wizard, no options, no confusion**: just install and launch.
5. Desktop app opens to a **Welcome Screen** with two cards:
   - **"Join a Server"**: Enter a server address (IP/domain) and connect.
   - **"Host My Own"**: For admins who want to run a server from this machine.
6. A **"Remember my choice"** checkbox saves the preference for future launches.

### "Join a Server" Path

1. User enters the server address (e.g., `https://192.168.1.100:3000`).
2. App validates the connection (tries HTTPS first, falls back to HTTP).
3. On success, loads the Haven web UI inside the native window.
4. Subsequent launches skip the Welcome Screen and go straight to the server.

### "Host My Own" Path

1. App **auto-detects** whether a Haven server is installed on this machine.
   - Looks for `server.js` + `package.json` in expected locations (sibling directory, env var, etc.)
2. **If server found:** Shows "Launch Server" button. Clicking starts the server as a child process,
   then connects to `https://localhost:3000`.
3. **If server NOT found:** Informs the user. Offers two options:
   - "Place your server files in [path]" (for users who have a server but it's elsewhere)
   - **"Start Server Setup"**: Begins a one-click server installation wizard:
     - Downloads/installs Node.js if needed
     - Clones or downloads the Haven server
     - Runs `npm install`
     - Generates certs and .env
     - Starts the server
4. Subsequent launches **automatically start the server** and open the app (if "remember" was checked).

### Returning User

- If "remember my choice" was set to **Join**: App launches and connects to saved server URL.
- If "remember my choice" was set to **Host**: App launches the server process first, then connects.
- If saved server is unreachable: Show the Welcome Screen again with retry option.

---

## 3. Core Features

### Window & Chrome
- Native window with app icon, proper title ("Haven"), dark theme
- System tray integration (minimize to tray, restore on double-click)
- Tray context menu: Show/Hide, Start Minimized toggle, Minimize to Tray toggle, Quit
- Single instance lock (second launch brings existing window to front)
- Window bounds persistence (remembers size and position)
- Zoom controls (Ctrl+/Ctrl- or IPC)
- Auto-hide menu bar
- macOS: hidden inset title bar with traffic lights

### Security
- Context isolation + sandbox enabled
- No `nodeIntegration` in renderer
- Preload script with `contextBridge` for safe IPC
- Accept self-signed certificates for localhost only (Haven generates self-signed certs)
- Navigation restricted to configured server URL + localhost
- Block `<webview>` tags
- Block `window.open` to untrusted origins
- Permission handler: only allow microphone, camera, notifications, clipboard, media keys
- Shell.openExternal restricted to `http://` and `https://` URLs only
- Allowed settings whitelist (renderer can't overwrite critical config)

### Server Management (Built-in)
- Start/stop Haven server as a managed child process
- Auto-detect Haven server installation on the local machine
- Server log forwarding to renderer
- Health check via `/api/health` endpoint
- Graceful shutdown (SIGTERM, then SIGKILL after 5s)
- One-click server setup for users who don't have a server installed

### Notifications & Badges
- Native OS notifications (Electron `Notification` API)
- Taskbar flash on new messages when window is not focused
- Overlay icon (red dot) for unread messages
- Auto-clear badge when window gains focus

### Per-App Audio Routing (Flagship Feature)
- Stream specific application audio (games, Spotify, etc.) into voice channels
- **Windows:** WASAPI per-process loopback capture (Win10 21H2+) + SoundVolumeView for device routing
- **Linux:** PipeWire/PulseAudio null-sink + `pactl move-sink-input`
- **macOS:** BlackHole virtual audio driver (future)
- Built-in audio engine: no external drivers required for basic capture
- System-wide audio capture via Electron `desktopCapturer` loopback
- Audio panel UI (🎵 button in voice controls) showing audio-producing apps
- Per-app volume control
- AudioMixer combines mic + app audio → replaces WebRTC audio track

### Audio Device Management
- Enumerate system input/output devices (OS-level, beyond what browser exposes)
- Mic and speaker dropdown menus injected into Haven's Settings modal
- Set default input/output device
- Remember device preferences

### Desktop-Specific UI Injections
- Draggable title bar region (CSS `-webkit-app-region: drag`)
- Renderer scripts injected after page load:
  - `audio-panel.js`: Per-app audio routing UI
  - `audio-settings.js`: Audio device selection dropdowns
  - `voice-integration.js`: Patches VoiceManager to use AudioMixer for WebRTC
  - `server-manager.js`: Server start/stop controls

---

## 4. Architecture (Previous Implementation)

```
desktop/                            # Electron app (separate repo going forward)
├── package.json                    # Electron 33, electron-builder 25
├── src/
│   ├── main.js                     # Main process: window, tray, IPC, welcome screen
│   ├── tray.js                     # System tray manager
│   ├── audio/
│   │   ├── audio-router.js         # Native audio routing (WASAPI / PulseAudio / PipeWire)
│   │   ├── audio-loopback.js       # Native loopback capture engine
│   │   ├── audio-capture.js        # Web Audio API capture + AudioMixer (renderer-side)
│   │   ├── haven-capture.cs        # C# native WASAPI capture helper (compiled at runtime)
│   │   └── get-audio-apps.ps1      # PowerShell script for Windows audio session enumeration
│   └── renderer/                   # Scripts injected into Haven's web UI
│       ├── audio-panel.js          # 🎵 button → per-app routing UI
│       ├── audio-settings.js       # Mic/speaker dropdown menus in Settings
│       ├── voice-integration.js    # Patches VoiceManager.join()/leave() for AudioMixer
│       └── server-manager.js       # Server start/stop controls
├── preload/
│   └── preload.js                  # contextBridge → window.havenDesktop API
├── assets/                         # Icons (tray, app icon): PNG + SVG
├── build/                          # electron-builder resources (icon.png, icon.ico)
├── installer/
│   └── nsis-hooks.nsh              # NSIS installer hooks
└── audio-drivers/
    └── README.md                   # Instructions for bundling SoundVolumeView etc.
```

### Preload API (`window.havenDesktop`)

The preload script exposes these IPC channels to the renderer:

```javascript
window.havenDesktop = {
  isDesktop: true,
  platform: process.platform,

  settings: {
    get(key),
    set(key, value),
    getAll(),
  },

  server: {
    setUrl(url),
    getUrl(),
  },

  audio: {
    getRunningApps(),
    getRoutes(),
    setRoute(route),
    removeRoute(appId),
    getDevices(),
    isDriverInstalled(),
    getSystemDevices(),
    setDefaultDevice({ deviceId, type }),
    getDefaultDevices(),
    getEngineStatus(),
    startCapture(pid),
    stopCapture(key),
    startSystemCapture(),
    stopSystemCapture(),
    getCaptureStatus(),
    enableSystemLoopback(),
    installDriver(),
    isSVVAvailable(),
    onCaptureData(callback),
    onCaptureStatus(callback),
  },

  window: {
    minimize(),
    maximize(),
    close(),
  },

  zoom: {
    get(),
    set(factor),
  },

  badge: {
    flash(),
    clear(),
  },

  notification: {
    show({ title, body, icon }),
  },

  shell: {
    openExternal(url),
  },

  serverManager: {
    findRoot(),
    status(),
    start(),
    stop(),
    getLogs(),
    onLog(callback),
    onStopped(callback),
  },

  screenPicker: {
    getSources(),
  },
};
```

---

## 5. Build & Distribution

### Targets
- **Windows:** NSIS one-click installer (`.exe`) + portable
- **Linux:** AppImage + `.deb`
- **macOS:** `.dmg` (future)

### electron-builder Config
- `appId`: `com.haven.desktop`
- `productName`: `Haven`
- NSIS: `oneClick: true`, `perMachine: false`, `runAfterFinish: true`
- Extra resources: `audio-drivers/` bundled into app resources

### Icons
- Need proper designed assets (previous were programmatically generated placeholder hexagons)
- Required: `icon.png` (512x512), `icon.ico` (multi-res Windows), `icon.icns` (macOS), `tray-icon.png` (16x16)
- Branding: purple hexagon, primary color `#7c5cfc`

---

## 6. Integration Points with Haven Server

The desktop app is a **client** of the Haven server. It does NOT modify the server.
However, the server provides these endpoints that the desktop app uses:

- `/api/health`: Health check (used by server manager to detect if server is running)
- Standard Haven web UI (loaded in the Electron BrowserWindow)

### Optional Server-Side Support (for the future)

The server *could* optionally provide:
- `/api/desktop/info`: Installer metadata (version, available platforms)
- `/api/desktop/download`: Serve installer files from `public/downloads/`

These are **not required** for the desktop app to function. The app can be distributed
via GitHub Releases independently.

---

## 7. What the Server Should NOT Contain

- No `desktop/` directory
- No `build-desktop.bat`
- No desktop-specific API routes in `server.js`
- No `desktop-promo.js` in `public/js/`
- No desktop app button in `app.html`
- No desktop-specific CSS styles
- The server's `voice.js` Electron compatibility check is fine to keep (it's a
  graceful degradation, not a dependency)

---

## 8. Key Design Principles

1. **Completely separate repo**: The desktop app has its own git repository, its own
   package.json, its own CI/CD. It connects to Haven like any browser client.
2. **One-click everything**: Install should be one click. Server setup should be one click.
   No terminal required for end users.
3. **Cross-platform**: Windows and Linux from day one. macOS when possible.
4. **No external drivers**: The built-in audio engine uses WASAPI loopback and
   PipeWire/PulseAudio null-sinks. No VB-CABLE installation required.
5. **Graceful degradation**: If native audio capture isn't available, system audio
   capture via Electron desktopCapturer still works.
6. **Security first**: Sandbox, context isolation, restricted navigation, permission
   whitelisting.

---

## 9. Previous Implementation Status (for reference)

### What Was Working
- Electron window with dark theme, system tray, single instance lock
- Welcome screen with Join/Host cards
- Server URL persistence and HTTPS/HTTP auto-detection
- Self-signed cert acceptance for localhost
- Window bounds persistence, zoom controls
- WASAPI audio session enumeration (Windows)
- VB-CABLE detection (WMI)
- Per-app audio device routing via SoundVolumeView
- Linux PulseAudio/PipeWire null-sink scaffolding
- Audio panel UI, device selection UI
- NSIS installer hooks
- Server management (start/stop as child process)

### What Was Not Tested
- Full voice pipeline integration (AudioMixer → WebRTC replaceTrack)
- Linux null-sink audio routing end-to-end
- macOS support

### What Was Missing
- One-click server setup wizard
- Real designed icons (had placeholder hexagons)
- Auto-updater (electron-updater)
- Code signing
- macOS audio routing (BlackHole)
