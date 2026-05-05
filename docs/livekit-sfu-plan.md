# Optional LiveKit SFU — Implementation Plan (#76)

Status: planning. Code does not exist yet. Hand this whole doc to the implementer agent (Opus or Sonnet).

---

## 1. Goals & non-goals

**Goals**

- Add an *optional* LiveKit-backed SFU mode for voice channels with > N participants, while keeping the existing P2P mesh as the default.
- Off by default. Vanilla `docker compose up -d` keeps shipping the P2P-only stack we have today. No new ports, no new container, no new env vars in the default flow.
- One-click opt-in. An admin should be able to enable SFU mode from `Settings → Admin → Voice` without touching `docker-compose.yml`, generating keys by hand, or editing `.env` files.
- Pluggable signaling layer (`VoiceProvider`) so we can swap LiveKit for Mediasoup/Janus later without rewriting the renderer.
- Per-channel auto-upgrade. Below threshold → mesh. At/above threshold → SFU. Admin sets the threshold (default 5).
- Preserve E2E ethos as much as possible. Document clearly when SFU is in use that the server *can* see media (LiveKit insertable-stream E2EE is a stretch goal, not v1).

**Non-goals**

- No mid-call seamless transition between mesh and SFU. v1: the provider is decided when the first user joins the call and stays for that call. (Future work.)
- No native GPU encoding pipeline (the issue thread brings this up — that's an unrelated Haven-Desktop project, not this one).
- No managed/hosted LiveKit. Self-hosters bring their own (or we run one alongside).
- No mobile-app changes in v1 beyond verifying `livekit-client` works in the React Native (or whatever shipped) WebView/native bridge. If it doesn't, mobile keeps mesh.

---

## 2. Why LiveKit (not Mediasoup)

| | LiveKit | Mediasoup |
|---|---|---|
| Distribution | Single Go binary, official Docker image | Node addon + worker processes, build from source |
| Ops surface | Two ports + WS proxy | TCP + a UDP port range (typically 40000-49999) |
| Self-host story | "Drop the container in" | "Tune your firewall" |
| Client SDK | Mature, browser + RN + Swift + Kotlin | Mature, browser-focused |
| Fit for Haven's audience | Lower-friction self-host | Slightly better Node integration |

LiveKit wins on operational simplicity, which is the deciding factor for Haven's "self-host on a $5 VPS" audience. Per ancsemi's comment in #76: "LiveKit ships as one binary — operationally simpler for self-hosters."

---

## 3. Architecture: the `VoiceProvider` interface

The current voice stack is monolithic mesh:

- **Server**: `src/socketHandlers/voice.js` brokers `voice-offer` / `voice-answer` / `voice-ice-candidate` between peers in a `voice:${code}` socket.io room.
- **Client**: `public/js/voice.js` (~76 KB) holds the per-peer `RTCPeerConnection` map and tracks all the renegotiation logic for screen share / webcam / music streams.

We refactor in two passes:

**Pass A — extract interface (no behavior change, ships first):**

```js
// src/voice/provider.js
class VoiceProvider {
  // Server-side
  async onUserJoined(socket, channelCode, userMeta) { /* ... */ }
  async onUserLeft(socket, channelCode) { /* ... */ }
  // Returns the per-channel client config blob to hand the renderer
  async getClientConfig(channelCode, userId) { /* ... */ }
}

class P2PVoiceProvider extends VoiceProvider { /* current behavior */ }
class LiveKitVoiceProvider extends VoiceProvider { /* new */ }
```

The existing `voice-offer/answer/ice-candidate` handlers move into `P2PVoiceProvider`. The voice handler becomes a thin dispatcher that picks a provider per channel.

**Pass B — add the LiveKit provider:**

Server side, the LiveKit provider does not relay signaling. Instead, on `voice-join` it:
1. Mints a LiveKit access token (room = `${LIVEKIT_ROOM_PREFIX}-${channelCode}`, identity = userId, permissions derived from Haven role).
2. Emits `voice-existing-users` *plus* a new `voice-provider-config` payload: `{ provider: 'livekit', wsUrl, token }`.
3. Client sees `voice-provider-config` and routes through `LiveKitClient` instead of building peer connections.

Client side, `public/js/voice.js` becomes a router. Two adapter modules:
- `voice-mesh.js` — current code, lifted as-is.
- `voice-livekit.js` — uses `livekit-client` SDK, bridges the same public API the rest of the app calls (`mute`, `setOutputDevice`, `startScreenShare`, etc).

The rest of the app (UI, modals, voice panel, PiP) only sees the bridged API and never knows which provider is active.

---

## 4. Deployment: bundled compose service

To deliver "one-click intuitive opt-in", we ship LiveKit as a *commented-out* service in `docker-compose.yml`. The admin UI uncomments it for them via a server-side helper, OR we ship it always-running but only used when toggled on. The simpler option:

**Option A (recommended): always running, only used when enabled.**

```yaml
services:
  haven:
    # ... existing ...
    environment:
      # Auto-injected by Haven on first SFU opt-in (do not edit by hand):
      - LIVEKIT_API_KEY=
      - LIVEKIT_API_SECRET=
      - LIVEKIT_WS_URL=
      - LIVEKIT_ROOM_PREFIX=haven
    depends_on:
      - livekit

  livekit:
    image: livekit/livekit-server:latest
    container_name: haven-livekit
    profiles: ["sfu"]              # only starts when `--profile sfu`
    network_mode: host             # required for SFU media UDP
    environment:
      - LIVEKIT_KEYS=${LIVEKIT_API_KEY}:${LIVEKIT_API_SECRET}
    restart: unless-stopped
```

The `profiles: ["sfu"]` directive means LiveKit doesn't start unless the admin runs `docker compose --profile sfu up -d`. The admin UI shows them the exact one-line command after enabling SFU.

**Option B (even more invisible, more work): Haven shells out to `docker compose up livekit`.**

Requires the Haven container to have docker socket access. Risky. Recommend Option A.

---

## 5. First-time setup wizard (one-click intuitive)

When the admin opens `Settings → Admin → Voice → Enable SFU mode` for the first time:

1. **Modal step 1 — explanation.** "SFU mode lets voice channels scale beyond ~6 people without crippling uploads. Trade-off: media flows through your server instead of peer-to-peer, so the server can theoretically see voice/video. Start it?" with a Read-more link to docs.
2. **Modal step 2 — auto-config.** Server generates `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (`crypto.randomBytes(16/32).toString('hex')`), writes them to `data/livekit.env` (NOT committed), and persists the SFU enable flag + threshold to `server_settings`.
3. **Modal step 3 — what to do next.** Shows a copy-to-clipboard one-liner: `docker compose --profile sfu up -d`. Also shows the LiveKit WS URL setting, defaulting to `wss://${same-host}:7880` so most reverse-proxied installs Just Work.
4. **Health check.** After the admin clicks "I've done that", Haven probes `LIVEKIT_WS_URL` and shows a green dot if reachable, red dot + diagnostic hint if not. The toggle stays off until the probe is green at least once. (Prevents enabling SFU before the container is up, which would just break voice for everyone.)

The admin who *doesn't* opt in never sees any of this. Default install is unchanged.

---

## 6. Auto-upgrade threshold logic

Server side, in the `voice-join` handler, before deciding which provider to use:

```js
const sfuEnabled = getSetting('sfu_enabled') === 'true';
const sfuThreshold = parseInt(getSetting('sfu_threshold')) || 5;
const currentRoomSize = (voiceUsers.get(code)?.size) || 0;
const willBeSize = currentRoomSize + 1;

const useSfu = sfuEnabled && willBeSize >= sfuThreshold && livekitHealthy();
const provider = useSfu ? livekitProvider : p2pProvider;
```

**Important constraint for v1**: once a room is using a provider, it sticks with that provider for the duration. New joiners after the threshold is crossed *follow the room's current provider*. This avoids the seamless-transition rabbit hole.

We track room provider state in memory in `voiceProviders: Map<channelCode, 'p2p' | 'livekit'>`. Cleared when the room empties (already happens in `handleVoiceLeave`).

---

## 7. Server-side changes (file by file)

| File | Change |
|---|---|
| `src/voice/provider.js` (new) | `VoiceProvider` base, `P2PVoiceProvider`, `LiveKitVoiceProvider` |
| `src/voice/livekitToken.js` (new) | thin wrapper over `livekit-server-sdk` for token mint |
| `src/socketHandlers/voice.js` | route `voice-join` / `voice-leave` to the active provider, leave the existing P2P signal handlers but only register them when `provider === 'p2p'` for that room |
| `src/socketHandlers/admin.js` | new allowed keys: `sfu_enabled`, `sfu_threshold`, `sfu_ws_url`. Enabling triggers the setup-wizard helper |
| `src/voice/setup.js` (new) | generate `livekit.env`, return one-liner for the admin |
| `src/voice/health.js` (new) | periodic probe of LiveKit WS, expose `livekitHealthy()` |
| `src/socketHandlers/index.js` | wire the new handlers into `ctx` |
| `package.json` | add `livekit-server-sdk` |
| `docker-compose.yml` | add the `livekit` service with `profiles: ["sfu"]` |
| `Dockerfile` | no change needed |
| `server.js` | on boot, if `sfu_enabled`, log "SFU mode active, threshold N" |

---

## 8. Client-side changes (file by file)

| File | Change |
|---|---|
| `public/js/voice.js` | becomes the router. Public API stays identical. |
| `public/js/voice/voice-mesh.js` (new) | current peer-connection code, lifted |
| `public/js/voice/voice-livekit.js` (new) | LiveKit adapter using `livekit-client` |
| `public/js/voice/voice-api.js` (new) | shared types and the abstract API the modules implement |
| `public/app.html` | conditionally load `livekit-client` only when SFU is enabled (lazy) |
| `public/js/modules/app-admin.js` | the SFU enable wizard, threshold input, health-status indicator |
| `public/js/modules/app-socket.js` | handle `voice-provider-config`, route to the right adapter |
| `public/css/style.css` | small style for the SFU status pill in the voice panel |
| `public/locales/en.json` | strings for the wizard, status indicator, and an "in SFU mode" footnote in the voice panel |
| `package.json` (web side, none — `livekit-client` loaded from CDN OR vendored under `public/vendor/livekit-client.min.js` to avoid CDN runtime dep) | vendor the build to keep Haven offline-installable |

---

## 9. Network requirements & TLS (the real deployment headache)

LiveKit needs:
- **TCP 7880** — signaling/WS (must be HTTPS to be usable from a browser)
- **TCP 7881** — TURN/TCP fallback
- **UDP 7882 + range** — RTC media (LiveKit defaults to a single port via `RTCPort` mode, which is what we'll use; avoids the Mediasoup-style port range problem)

Most Haven self-hosters are already running behind a reverse proxy (Caddy / Traefik / nginx) for HTTPS on the main 3000 port. We document two patterns in `docs/examples/`:
- **Caddy**: snippet that reverse-proxies `livekit.example.com` to `localhost:7880` (already shown by @metheos in the issue thread — credit them).
- **Traefik**: same idea (we already ship `docs/examples/haven-traefik-coturn/` so it slots in).

Users without HTTPS infrastructure can't use SFU. The wizard tells them this honestly and links to the Caddy quick-start. **This is the one place where "intuitive" loses to "physically cannot work without TLS" — accept and document.**

The setup wizard's WS URL field defaults to `wss://${window.location.hostname}:7880` and clearly says "This must be HTTPS-terminated. Use a reverse proxy if you don't have one."

---

## 10. Migration / rollout phases

**Phase 0 — interface refactor (no user-visible change).**
Ship Pass A from §3. Mesh continues to work exactly as today. Smoke-test voice/screen-share/music-share. Tag a release. *This is the safe foundation.*

**Phase 1 — LiveKit provider, opt-in only, no auto-upgrade.**
Add the LiveKit provider, the wizard, the docker-compose profile. Threshold is effectively `1` when enabled — i.e. SFU is used for *every* voice call once the admin turns it on. Lets us validate the path without the threshold logic getting in the way.

**Phase 2 — auto-upgrade threshold.**
Add the per-room provider decision from §6. Mesh stays for small rooms even on SFU-enabled servers, which is what most admins actually want.

**Phase 3 — quality of life.**
Health-check probe, SFU status pill in the voice panel, admin metrics ("X voice calls today: Y SFU, Z mesh"), per-channel override (force SFU, force mesh).

**Phase 4 (future, not in this scope).**
- E2EE via LiveKit insertable streams (preserves the no-server-can-listen guarantee).
- Mid-call provider transition.
- Mediasoup adapter.

Each phase ships independently. Don't bundle.

---

## 11. Open questions / risks

1. **Mobile.** Is the Haven mobile client able to load `livekit-client`? If it's a thin WebView wrapper, yes. If it's React Native, the LiveKit RN SDK works but is a bigger lift. **Action: confirm before Phase 1.**
2. **Desktop (Electron).** `livekit-client` works in Electron, but `desktopCapturer` source IDs vs LiveKit's screen-share API need a thin shim. We already had a desktopCapturer churn moment recently (commit `fix(#184)`); pull that knowledge in.
3. **TURN coexistence.** Haven already supports `TURN_URL` for the mesh path. LiveKit can share that TURN server (it accepts external TURN config). Plumb the existing `TURN_URL` env into the LiveKit config so admins don't configure it twice.
4. **Port conflict.** If the user runs `--profile sfu` but already has something on 7880, the container fails silently. Health check from §5 catches this — surface the error in the admin UI.
5. **Database migration.** None needed. SFU state is in `server_settings` (already a generic key/value table) and per-room provider state is in-memory.
6. **Existing TURN codepath.** The mesh path uses `RTCPeerConnection` with an iceServers list. Make sure the LiveKit adapter doesn't accidentally inherit / override that — they live in separate adapters specifically to avoid this.
7. **Recording.** LiveKit can record. We do *not* enable that feature. Make it explicit in code (`recording: false` in token grants) so a future careless commit can't accidentally start storing voice.

---

## 12. Acceptance criteria

The implementation is "done" for v1 when:

- [ ] `docker compose up -d` (no profile flag) on a fresh install gives the same voice behavior as today. Zero behavior change for users who never opt in.
- [ ] Enabling SFU in the admin UI walks the admin through key generation and gives them the exact `docker compose --profile sfu up -d` command. They never edit a YAML or `.env` file by hand.
- [ ] After enabling SFU, joining a voice channel with 1-4 people uses mesh (in Phase 2+). Joining with 5+ uses LiveKit. The voice panel shows a small "SFU" / "P2P" indicator so users / admins can see what's happening.
- [ ] If LiveKit container is down, voice falls back to mesh and a one-line warning surfaces in the voice panel ("SFU unavailable, using P2P").
- [ ] Mute/unmute, deafen, screen share, webcam, music share, voice-kick all work in both modes. Public API of `voice.js` is identical.
- [ ] No regression in mesh-only mode for small rooms (most users).
- [ ] Docs page added under `docs/` explaining SFU mode, when to enable it, and the privacy trade-off.

---

## 13. What this is NOT a green-light for

- Switching Haven to SFU-by-default. Don't.
- Building our own SFU. Don't.
- Tying Haven to LiveKit Cloud / any hosted service. The provider must work fully self-hosted.
- Recording features. Out of scope.
