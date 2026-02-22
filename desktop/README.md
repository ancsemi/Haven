# Haven Desktop

Native desktop client for Haven with per-app audio streaming.

## Key Feature: Per-App Audio Streaming

Stream specific application audio (games, Spotify, etc.) into your Haven voice channel — without sharing your entire desktop audio or microphone. Uses a virtual audio cable (VB-CABLE on Windows, PulseAudio/PipeWire null-sink on Linux) to capture and route audio per-process.

## Architecture

```
desktop/
├── package.json              # Electron app manifest & build config
├── src/
│   ├── main.js               # Electron main process (window, tray, IPC)
│   ├── tray.js               # System tray integration
│   ├── audio/
│   │   ├── audio-router.js   # Native audio session routing (WASAPI / PulseAudio)
│   │   └── audio-capture.js  # Web Audio API capture + mixer (renderer)
│   └── renderer/
│       ├── audio-panel.js    # Per-app audio routing UI (injected into voice controls)
│       ├── audio-settings.js # Audio input/output device selection menu
│       └── voice-integration.js  # Wires AudioMixer into Haven's WebRTC voice pipeline
├── preload/
│   └── preload.js            # Context bridge (safe IPC for renderer)
├── assets/                   # Icons (tray, app icon) — PNG + SVG
├── build/                    # Electron-builder resources (icon.png, icon.ico)
├── installer/
│   └── nsis-hooks.nsh        # NSIS installer hooks (optional VB-CABLE install)
└── audio-drivers/            # Place VB-CABLE installer here for bundling
```

## How it works

1. **Electron** wraps Haven's web UI in a native window (loads your server URL)
2. The **preload script** exposes a `window.havenDesktop` API to the renderer
3. Three **renderer scripts** are injected after page load:
   - **audio-panel.js** — 🎵 button in voice controls, shows audio-producing apps
   - **audio-settings.js** — Audio device selection (mic + speaker dropdowns in Settings)
   - **voice-integration.js** — Patches VoiceManager to mix app audio into WebRTC
4. When the user routes an app → its audio goes to a **virtual cable** endpoint
5. The **AudioMixer** captures from the virtual cable and combines it with the mic
6. The mixed stream replaces the WebRTC audio track sent to peers
7. Other users in the voice channel hear the app audio + your microphone

## Platform Support

| Feature | Windows | Linux | macOS |
|---------|---------|-------|-------|
| Per-app audio routing | ✅ VB-CABLE + WASAPI | ✅ PulseAudio/PipeWire null-sink | 🔜 BlackHole |
| Audio device selection | ✅ | ✅ | ✅ |
| System tray | ✅ | ✅ | ✅ |
| Virtual cable auto-install | ✅ NSIS hook | ✅ `pactl load-module` | 🔜 |

## Development

```bash
cd desktop
npm install
npm run start
```

Make sure your Haven server is running (default: `https://localhost:3000`).
The desktop app auto-detects HTTPS/HTTP and accepts self-signed certs for localhost.

## Building

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Requirements

- **Node.js** 18+
- **Windows:** VB-CABLE (free) — https://vb-audio.com/Cable/
  - Can be installed during Haven Desktop setup or from the audio panel
  - **Optional:** [SoundVolumeView](https://www.nirsoft.net/utils/sound_volume_view.html) (free) — place `SoundVolumeView.exe` in `audio-drivers/` for automated per-app routing. Without it, Windows Sound Settings opens for manual routing.
- **Linux:** PulseAudio or PipeWire (most distros have one pre-installed)
  - Haven creates a null-sink module automatically — no extra install needed

## Status

🚧 **In Development** — Core audio pipeline working, Electron app launches and connects successfully.

### TODO

- [x] Create app icons (icon.png, icon.ico, tray-icon.png)
- [x] Linux audio routing (PulseAudio/PipeWire null-sink)
- [x] Audio input/output device selection menu
- [x] Hook AudioMixer into Haven's WebRTC voice pipeline
- [x] Test VB-CABLE detection and installation flow
- [x] Implement per-process audio routing (SoundVolumeView + fallback)
- [x] HTTPS auto-detect + self-signed cert acceptance
- [x] Server unreachable retry page
- [x] Security hardening (URL validation, sandbox, openExternal)
- [ ] Test full voice pipeline (route app audio, verify peers hear it)
- [ ] Auto-updater (electron-updater)
- [ ] macOS audio routing (BlackHole)
- [ ] Code signing for distribution
- [ ] Replace placeholder icons with designed assets
