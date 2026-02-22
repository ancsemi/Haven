# Haven Desktop — Project Roadmap & Session Guide

> **Purpose:** This file is a handoff document. If you're an AI assistant picking this up
> in a new session, read this first — it tells you exactly where things stand, what's been
> built, what's broken, and what needs to happen next.
>
> **Last updated:** February 21, 2026

---

## 1. Project Overview

**Haven** is a self-hosted Discord alternative (Node.js, Express, Socket.IO, SQLite, WebRTC).
The **Haven Desktop** app is an Electron wrapper that adds per-app audio streaming — letting
users route specific application audio (games, Spotify, etc.) into their voice channel.

| Item | Value |
|------|-------|
| **Repo** | `ancsemi/Haven` on GitHub |
| **Local path** | `c:\Users\cjr29\Desktop\Tools & MISC\_ Bots\Haven\Haven\` |
| **Desktop app path** | `c:\Users\cjr29\Desktop\Tools & MISC\_ Bots\Haven\Haven\desktop\` |
| **Haven version** | 2.2.0 |
| **Node version** | v20.10.0 |
| **GitHub Pages** | `https://ancsemi.github.io/Haven/` (served from `docs/` folder on `main`) |
| **Domain** | `haven-app.com` (GoDaddy, account ANCsemi, Customer #700591019) |
| **Domain DNS status** | **NOT configured yet** — do NOT add a CNAME to `docs/` until DNS is set up |

---

## 2. Git Status (as of Feb 21, 2026)

**Branch:** `main` — latest commit: `56bbb5b`

**Pushed to GitHub:**
- Fix setup wizard (issue #42): `d91ab67`
- Fix invite code text field: `56bbb5b`
- Website URL revert (CNAME disaster cleanup): `30bcdf3`, `7fa4602`

**Local only (not pushed):**
- `desktop/` — entire Electron app folder (untracked, node_modules installed)
- `public/js/app.js` — `window.app = new HavenApp()` (desktop voice hook needs this)
- `server.js` — FORCE_HTTP support (issue #48)
- `src/database.js`, `src/auth.js`, `src/socketHandlers.js` — auto-assign roles (issue #14)
- `README.md` — added Desktop App row to roadmap table
- `package-lock.json` — minor change

**To push everything:**
```bash
git add desktop/ public/js/app.js server.js src/ .env.example README.md \
  docker-entrypoint.sh start.sh "Start Haven.bat"
git commit -m "Add Haven Desktop app + FORCE_HTTP + auto-assign roles"
git push
```

---

## 3. File Map — Desktop App

```
desktop/
├── package.json                    # Electron 33, electron-builder 25, build targets
├── README.md                       # Architecture overview
├── ROADMAP.md                      # ← YOU ARE HERE
├── .gitignore                      # Ignores dist/, node_modules/, *.exe drivers
│
├── src/
│   ├── main.js                     # Electron main process — window, tray, IPC, script injection
│   ├── tray.js                     # System tray with Show/Hide, minimize-to-tray, quit
│   │
│   ├── audio/
│   │   ├── audio-router.js         # Native audio routing: WASAPI (Win) + PulseAudio/PipeWire (Linux)
│   │   └── audio-capture.js        # Web Audio API capture + AudioMixer class (renderer-side)
│   │
│   └── renderer/                   # Scripts injected into Haven's web UI via executeJavaScript()
│       ├── audio-panel.js          # 🎵 button in voice controls → per-app routing UI
│       ├── audio-settings.js       # Mic/speaker dropdown menus injected into Settings modal
│       └── voice-integration.js    # Patches VoiceManager.join()/leave() to use AudioMixer
│
├── preload/
│   └── preload.js                  # contextBridge → window.havenDesktop API
│
├── assets/
│   ├── icon.svg                    # 512px purple hexagon with H (vector source)
│   ├── icon.png                    # 512x512 rasterized (programmatic)
│   ├── tray-icon.svg               # 16px version
│   └── tray-icon.png               # 16x16 rasterized
│
├── build/
│   ├── icon.png                    # electron-builder resource (512x512)
│   └── icon.ico                    # Windows ICO (wraps the PNG)
│
├── installer/
│   └── nsis-hooks.nsh              # NSIS hooks for optional VB-CABLE install during setup
│
└── audio-drivers/
    └── README.md                   # Instructions: place VBCABLE_Setup_x64.exe here
```

---

## 4. How the Audio Pipeline Works

```
┌─────────────┐
│ App (Spotify)│──▸ VB-CABLE Input ──▸ AudioCaptureStream ──┐
└─────────────┘    (or PulseAudio        (getUserMedia)      │
                    null-sink)                                │
┌─────────────┐                                              ▼
│ Microphone  │──▸ VoiceManager ──▸ noise gate ──▸ AudioMixer ──▸ RTCPeerConnection
└─────────────┘     (existing)        (existing)    (new)         (replaceTrack)
```

1. **audio-router.js** (main process) detects audio-producing apps and routes them to a virtual cable
2. **voice-integration.js** (renderer) patches `VoiceManager.join()` to create an `AudioMixer`
3. The mixer takes the mic stream (existing noise-gated `localStream`) + virtual cable capture
4. The combined stream is swapped onto all `RTCPeerConnection` senders via `replaceTrack()`
5. Peers hear mic + app audio. The user controls per-app volume from the audio panel.

---

## 5. What's Done ✅

| Feature | Status | Files |
|---------|--------|-------|
| Electron window, tray, IPC | ✅ Complete | `main.js`, `tray.js`, `preload.js` |
| Windows audio routing (WASAPI enum, VB-CABLE detect/install) | ✅ Complete | `audio-router.js` |
| Linux audio routing (PulseAudio/PipeWire null-sink) | ✅ Scaffolded | `audio-router.js` |
| Per-app audio routing UI | ✅ Complete | `audio-panel.js` |
| Audio device selection (mic/speaker dropdowns) | ✅ Complete | `audio-settings.js` |
| AudioMixer → WebRTC voice pipeline integration | ✅ Scaffolded | `voice-integration.js` |
| Placeholder icons (PNG, ICO, SVG) | ✅ Created | `assets/`, `build/` |
| NSIS installer hooks | ✅ Complete | `installer/nsis-hooks.nsh` |
| **Per-app audio device routing (Windows)** | ✅ **Complete** | `audio-router.js` (SoundVolumeView) |
| **Self-signed cert acceptance for localhost** | ✅ **Complete** | `main.js` (session cert verify) |
| **HTTPS auto-detect + HTTP fallback** | ✅ **Complete** | `main.js` (did-fail-load retry) |
| **Server unreachable retry page** | ✅ **Complete** | `main.js` (data: URL error page) |
| **window.app global** (voice hook target) | ✅ **Complete** | `public/js/app.js` |
| **Security hardening** | ✅ **Complete** | `main.js` (URL validation, sandbox, openExternal) |
| **VB-CABLE detection** (WMI, no extra modules) | ✅ **Complete** | `audio-router.js` |
| **npm scripts** (& in path workaround) | ✅ **Fixed** | `package.json` |
| Bug fix: setup wizard (#42) | ✅ Pushed | `public/js/app.js` |
| Bug fix: invite code text field | ✅ Pushed | `public/js/app.js` |
| Bug fix: FORCE_HTTP for reverse proxy (#48) | ✅ **Local** | `server.js`, startup scripts |
| Bug fix: Auto-assign roles (#14) | ✅ **Local** | `database.js`, `auth.js`, `socketHandlers.js`, `app.js` |

---

## 6. What Needs Work 🚧

### Priority 1 — ~~Must do before first test~~ ✅ DONE

| Task | Status |
|------|--------|
| **`npm install`** | ✅ Done. Removed phantom `node-audio-volume-mixer` dependency. |
| **Test Electron launch** | ✅ Working. HTTPS auto-detected, self-signed certs accepted. |
| **Test VB-CABLE detection** | ✅ Working. `isDriverInstalled()` uses WMI (no extra PS modules). Correctly reports false when absent. |
| **Test audio session enum** | ✅ Working. `getAudioApplications()` WASAPI script returns apps. Tested with `getVirtualDevices()` too — lists all audio devices, marks NVIDIA Virtual + Voicemod as virtual. |

### Priority 2 — Core functionality gaps (partially done)

| Task | Status |
|------|--------|
| **Per-process audio routing** | ✅ **Implemented.** Uses SoundVolumeView (free Nirsoft CLI). Falls back to opening Windows Sound Settings for manual routing. Also restores app to default device on unroute. Place `SoundVolumeView.exe` in `audio-drivers/` for automated routing. |
| **`window.app.voice` reference** | ✅ **Fixed.** Added `window.app = new HavenApp()` to `public/js/app.js`. `voice-integration.js` can now find and patch VoiceManager. |
| **Test voice pipeline integration** | 🔲 **Not yet tested.** Need to join a voice channel in the desktop app, route an app, verify peers hear mixed audio. Requires VB-CABLE or Voicemod (user has Voicemod installed). |
| **Test Linux null-sink flow** | 🔲 **Not yet tested.** Need a Linux machine to verify `pactl load-module module-null-sink`, app enumeration, and `pactl move-sink-input`. |

### Priority 3 — Polish

| Task | Details |
|------|---------|
| **Real app icons** | Current icons are programmatically generated (blocky hexagon). Replace with proper designed assets. Need `icon.png` (512x512), `icon.ico` (multi-res), `icon.icns` (macOS), `tray-icon.png` (16x16 or 22x22). |
| **macOS audio routing** | Not implemented. Likely needs [BlackHole](https://github.com/ExistentialAudio/BlackHole) or a similar virtual audio driver. |
| **Auto-updater** | Add `electron-updater` for GitHub Releases-based auto-updates. |
| **Code signing** | Windows: Authenticode. macOS: Apple Developer ID + notarization. Linux: N/A. |
| **Settings UI polish** | The `audio-settings.js` device dropdowns inject into Haven's settings modal — verify they actually appear in the right place (may need to adjust the CSS selector for the modal). |

### Priority 4 — Domain & website

| Task | Details |
|------|---------|
| **Configure GoDaddy DNS** | Add A records pointing to GitHub Pages IPs (`185.199.108-111.153`) + CNAME `www` → `ancsemi.github.io`. |
| **Wait for DNS propagation** | Verify with `nslookup haven-app.com` before touching the repo. |
| **Add CNAME file** | ONLY after DNS resolves: create `docs/CNAME` containing `haven-app.com`. Last time this was done prematurely and caused a redirect disaster (site went to empty GoDaddy parking page while the link was being shared). |
| **Email setup** | User asked about email — options: Google Workspace, Zoho Mail (free tier), or Cloudflare Email Routing. Needs MX records on GoDaddy. |

---

## 7. Key Technical Notes

### Haven's voice system (`public/js/voice.js`)
- `VoiceManager` class — manages WebRTC peer connections
- `join(channelCode)` calls `getUserMedia()`, builds a noise gate via Web Audio API, stores processed stream as `this.localStream`
- `this.localStream` tracks are added to every `RTCPeerConnection` via `addTrack()`
- To mix in app audio, `voice-integration.js` replaces `localStream` with the mixer's output and calls `replaceTrack()` on all senders

### Haven's app instance
- `public/js/app.js` creates `window.app = new HavenApp()` ← **confirmed & fixed (was missing `window.app =`)**
- `window.app.voice` is the `VoiceManager` instance
- `voice-integration.js` looks for this reference to hook into

### CNAME lesson learned
- **NEVER** add `docs/CNAME` before DNS is configured on the registrar
- GitHub Pages will start redirecting to the custom domain immediately
- If the domain doesn't resolve, users get a blank/parking page
- The old URL (`ancsemi.github.io/Haven/`) will 301-redirect and browsers cache 301s aggressively

### Icons
- Generated programmatically (pure Node.js, no dependencies): purple hollow hexagon with "H"
- The PNG/ICO files work for Electron but look rough — replace with designed assets when ready
- Branding: purple hexagon, color `#7c5cfc`

---

## 8. How to Resume Development

```bash
# 1. Navigate to the project
cd "c:\Users\cjr29\Desktop\Tools & MISC\_ Bots\Haven\Haven"

# 2. Start the Haven server (needed for the desktop app to connect to)
npm start
# → runs on https://localhost:3000 (HTTPS by default)

# 3. In a second terminal, run the desktop app
cd desktop
npm install          # first time only — already done as of Feb 21 2026
npm run start        # launches Electron, auto-detects HTTPS/HTTP
```

**Note:** If the project path contains `&` or special characters, `npm run start`
uses a node-based launcher to avoid Windows CMD path issues. This is already
configured in `package.json`.

### If picking up in a new AI session:
Point the assistant to this file:
```
Read desktop/ROADMAP.md — it's the project handoff document with full status,
file map, architecture, and prioritized TODO list for the Haven Desktop app.
```

---

## 9. User Preferences (for AI assistants)

The user (cjr29 / ANCsemi) prefers:
- **Tone:** Kind, humble, casual
- **Length:** Few sentences or less, no special formatting unless needed
- **Approach:** Just do it — don't ask for permission, make reasonable decisions
- **Branding:** Purple hexagon with H, color `#7c5cfc`
