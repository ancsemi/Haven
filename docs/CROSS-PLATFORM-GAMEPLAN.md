# Haven Cross-Platform Compatibility Gameplan

## Problem Statement

Most Haven users run the **Docker build** and many use **Linux**. Three key features currently have platform-specific limitations:

| Feature | Windows Desktop | Linux Desktop | Docker (headless) | Web Browser |
|---------|----------------|--------------|-------------------|-------------|
| **Notifications** | Electron native | Electron native | N/A (no GUI) | Web Push (VAPID) |
| **Per-App Audio** | WASAPI loopback | PipeWire/PulseAudio | N/A (no audio) | Not possible |
| **Screen Streaming** | desktopCapturer | desktopCapturer | N/A (no display) | getDisplayMedia |

The Docker container is a **headless server**: it has no display, no audio stack, and no notification UI. These features are inherently **client-side**, not server-side. The Docker instance only needs to **relay** data between clients that _do_ have these capabilities.

---

## Key Insight

**Docker doesn't need to run notifications, audio capture, or streaming; it just needs to broker them.**

The architecture should be:
```
[Client A: Browser/Desktop]  ←→  [Haven Server (Docker)]  ←→  [Client B: Browser/Desktop]
     ↑ notifications                   ↑ relay only              ↑ notifications
     ↑ audio capture                                             ↑ audio playback
     ↑ screen share                                              ↑ screen view
```

---

## 1. Notifications: Already Solved ✅

**Current state:** Haven already supports Web Push notifications via VAPID keys + service worker (`sw.js`). This works for:
- **Browser clients** on any OS (Chrome, Firefox, Edge), including Linux
- **Mobile browsers** (Android Chrome, iOS Safari 16.4+)
- **Docker server** generates and delivers push payloads via `web-push` npm package

**What's already working:**
- `push-subscribe` / `push-unsubscribe` socket events
- Server-side push delivery on DMs and @mentions
- Service worker handles background push display
- VAPID key auto-generation on first run

**Remaining gap:** The Electron desktop app uses its own notification system via `new Notification()` in the renderer. This works on Windows and Linux desktops. No action needed.

**Docker-specific:** Push notifications work out of the box from Docker. The server sends them; the client (browser) receives and displays them. No display server needed on the Docker host.

---

## 2. Per-App Audio Capture: Needs Client-Side Fallback Strategy

### Current Architecture
- **Windows:** Compiles a C# WASAPI helper (`haven-capture.cs`) at runtime → per-process audio loopback
- **Linux Desktop:** PipeWire `pw-loopback` or PulseAudio `pactl load-module module-null-sink` + `move-sink-input`
- **Docker:** No audio stack → feature unavailable

### The Problem
Docker containers don't have audio subsystems. But per-app audio capture is a **client-side** operation: it captures audio from apps running on the **user's machine**, not the server.

### Solution: This Feature Only Applies to Desktop App Users

Per-app audio routing is fundamentally a **desktop app** feature. The audio capture happens locally, gets mixed with the mic, and sent via WebRTC to other voice participants through the server.

**Action items:**

1. **Graceful degradation in web/Docker clients** (Priority: LOW)
   - The audio panel UI should detect when running in a browser (not Electron) and hide per-app audio options
   - Show a message: "Per-app audio sharing requires the Haven Desktop app"
   - The server relay for voice (WebRTC signaling) works regardless of platform

2. **Linux Desktop improvements** (Priority: MEDIUM)
   - The PipeWire path in `audio-router.js` already has detection (`_detectLinuxAudioSystem()`)
   - Needs testing on common distros: Ubuntu 22.04+, Fedora 38+, Arch, Debian 12
   - **PipeWire** (default on Fedora, Ubuntu 22.10+): Use `pw-loopback` (already implemented)
   - **PulseAudio** (older distros): Use `pactl` null-sink (already implemented)
   - Add a fallback to `Electron desktopCapturer` system audio when neither works

3. **System audio fallback** (Priority: HIGH)
   - Even without per-app routing, users can share **system audio** via `desktopCapturer`
   - This works on Windows, Linux (X11/Wayland with PipeWire), and macOS
   - Make this the default option, with per-app routing as an "advanced" feature

### Implementation Checklist
- [ ] Add platform detection in audio panel: hide per-app UI when `!window.electronAPI`
- [ ] Add "Share System Audio" as the primary option (uses `desktopCapturer` / `getDisplayMedia`)
- [ ] Keep "Share App Audio" as secondary option (desktop-only, shows requirements)
- [ ] Test PipeWire path on Ubuntu 24.04, Fedora 40, Arch
- [ ] Test PulseAudio fallback on Ubuntu 20.04, Debian 11
- [ ] Add error messages that guide users to install PipeWire if missing

---

## 3. Screen/Game Streaming: Needs WebRTC Browser Path

### Current Architecture
- **Desktop app:** Uses `desktopCapturer` to capture screens/windows
- **Browser:** Can use `getDisplayMedia()` API (no Electron needed)
- **Docker server:** Relays WebRTC signaling + optional TURN relay

### The Problem
Screen sharing requires WebRTC, which Haven already uses for voice chat. The **signaling** goes through the Socket.IO server (works from Docker). The **media** goes peer-to-peer or through a TURN server.

### Solution: Ensure WebRTC Streaming Works for Browser Clients

**Action items:**

1. **Browser screen sharing** (Priority: HIGH)
   - Use `navigator.mediaDevices.getDisplayMedia()` for browser clients
   - This works on Chrome, Firefox, Edge on Windows, Linux, and macOS
   - The user picks a screen/window/tab to share; OS handles the capture
   - No Electron or server-side support needed

2. **TURN server for Docker deployments** (Priority: HIGH)
   - Peer-to-peer WebRTC often fails behind NAT/Docker networks
   - Haven already supports TURN configuration (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` env vars)
   - **Document this clearly**: Docker users MUST configure a TURN server for reliable voice/streaming
   - Recommend `coturn` as a sidecar container in `docker-compose.yml`

3. **Add coturn to docker-compose.yml** (Priority: HIGH)
   ```yaml
   coturn:
     image: coturn/coturn:latest
     network_mode: host
     volumes:
       - ./turnserver.conf:/etc/coturn/turnserver.conf
     restart: unless-stopped
   ```
   With a template `turnserver.conf`:
   ```
   listening-port=3478
   tls-listening-port=5349
   realm=haven.example.com
   server-name=haven.example.com
   use-auth-secret
   static-auth-secret=GENERATE_A_SECRET_HERE
   total-quota=100
   stale-nonce=600
   cert=/etc/ssl/certs/turn.pem
   pkey=/etc/ssl/private/turn.key
   no-multicast-peers
   ```

4. **Linux Wayland compatibility** (Priority: MEDIUM)
   - `getDisplayMedia()` works on Wayland via PipeWire portal
   - Electron's `desktopCapturer` has known Wayland issues; fallback to `getDisplayMedia()` even in desktop app when Wayland detected
   - Detection: check `process.env.XDG_SESSION_TYPE === 'wayland'`

### Implementation Checklist
- [ ] Add `getDisplayMedia()` path in `voice.js` for browser clients
- [ ] Add coturn service to `docker-compose.yml` with template config
- [ ] Add `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` to Docker docs / `.env.example`
- [ ] Test WebRTC voice + screen share from browser → Docker → browser
- [ ] Add Wayland detection in desktop app, fallback to `getDisplayMedia()` API
- [ ] Document: "For Docker deployments, a TURN server is required for voice and streaming"

---

## 4. Docker-Specific Recommendations

### 4a. Environment Variable Documentation
Create a `.env.example` file documenting all configuration:
```env
# Haven Server Configuration
PORT=3000
DOMAIN=haven.example.com

# SSL (optional; use reverse proxy instead for Docker)
SSL_CERT_PATH=
SSL_KEY_PATH=

# TURN Server (REQUIRED for voice/streaming behind NAT)
TURN_URL=turn:haven.example.com:3478
TURN_USERNAME=
TURN_CREDENTIAL=

# Web Push Notifications (auto-generated if empty)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=admin@example.com

# Tunnel (optional: expose without port forwarding)
TUNNEL_ENABLED=false
```

### 4b. Reverse Proxy Guide
Most Docker users will run Haven behind nginx/Traefik/Caddy. Document:
- WebSocket upgrade headers (`Upgrade`, `Connection`)
- Proxy buffer size for file uploads
- SSL termination at the proxy level

### 4c. Health Check Endpoint
The `/api/health` endpoint already exists and returns server status. Docker Compose can use it:
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

---

## 5. Priority Roadmap

### Phase 1: Immediate (Before Release)
1. ✅ Web Push notifications already work from Docker
2. Add coturn sidecar to `docker-compose.yml`
3. Create `.env.example` with all configuration documented
4. Add "TURN server required" note to Docker deployment docs
5. Hide per-app audio UI in browser clients

### Phase 2: Short Term (1-2 weeks post-release)
1. Browser `getDisplayMedia()` screen sharing path
2. Test Linux Desktop audio on 5 common distros
3. Reverse proxy documentation (nginx, Caddy, Traefik)
4. Wayland `desktopCapturer` fallback

### Phase 3: Medium Term (1 month)
1. Optional coturn auto-configuration via Haven admin panel
2. Audio quality/bitrate controls for bandwidth-limited Docker deployments
3. Screen share quality selector (resolution, framerate)
4. Mobile browser voice chat testing (iOS Safari, Android Chrome)

---

## Summary

| Feature | Docker Fix Needed? | What to Do |
|---------|-------------------|------------|
| **Notifications** | No, already works | Web Push via VAPID is platform-agnostic |
| **Per-App Audio** | No, client-side feature | Hide UI in browser, ensure Linux Desktop works |
| **System Audio** | No, client-side feature | `getDisplayMedia()` works in browsers |
| **Screen Streaming** | Yes, needs TURN relay | Add coturn to docker-compose, document TURN config |
| **Voice Chat** | Yes, needs TURN relay | Same TURN server fixes voice and streaming |

The core insight: **Docker is a relay, not a source**. All capture/display features happen on the client. The server's job is signaling (Socket.IO) and relay (TURN). Focus Docker improvements on making the relay layer bulletproof.
