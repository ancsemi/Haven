# Changelog

All notable changes to Haven are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/). Haven uses [Semantic Versioning](https://semver.org/).

---

## [1.4.4] — 2025-07-18

### Added
- **User profile pictures (PFP)** — users can upload a custom avatar (max 2 MB) via Settings. Avatars appear in chat messages and the online-users list. Letter-based fallback when no avatar is set.
- **Avatar upload endpoint** — `POST /api/upload-avatar` with magic-byte validation for PNG/JPEG/GIF/WebP.
- **Socket-based avatar sync** — `set-avatar` event propagates avatar changes to all connected clients in real-time; online-user lists update immediately.
- **Modernized emoji picker** — expanded from ~300 to ~500+ emojis across 10 categories. New "Monkeys" category (🙈🙉🙊🐵🐒🦍🦧), new "Faces" category (👀👁️👅💋🧠🦷🦴). Smileys expanded with 🫣🫢🫥🫤🥹🥲🫠🤫🤥🫨🤠🤑🤓🥴🤧😷🤒🤕. People expanded with pointing gestures, shrug/facepalm, bowing, and couple emojis. Animals, Food, Travel, Objects, and Symbols categories all substantially expanded.
- **AIM Classic notification sounds** — four synthesized approximations of the original AOL Instant Messenger sounds:
  - **AIM Message** — the iconic rising two-tone "ding ding" with overtone shimmer
  - **AIM Door Open** — ascending creaky chime (buddy sign-on)
  - **AIM Door Close** — descending thump with low slam (buddy sign-off)
  - **AIM Nudge** — buzzy sawtooth vibration pattern
- **Join/Leave sound selectors** — new "User Joined" and "User Left" dropdowns in Settings > Sounds, with AIM Door Open/Close as built-in options.
- **Admin custom sound uploads** — admins can upload custom notification audio files (max 1 MB, MP3/OGG/WAV/WebM) via Settings > Admin > Custom Sounds. Custom sounds appear as options in all notification dropdowns.
- **Custom sound management** — preview and delete buttons for each uploaded sound. Sounds stored in `custom_sounds` database table with file-on-disk storage.
- **Audio file playback engine** — `NotificationManager` gains `_playFile(url)` method with `Audio` object caching for efficient custom sound playback.

### Changed
- **Emoji categories restructured** — reorganized into 10 categories (was 8): Smileys, People, Monkeys, Animals, Faces, Food, Activities, Travel, Objects, Symbols.
- **Message avatar rendering** — messages now render `<img>` tags for users with profile pictures, with automatic fallback to letter-avatar on load error.
- **Online-users list** — each user entry now shows a small avatar circle (24px) before the username.
- **CSP mediaSrc** — added `"data:"` to Content Security Policy for audio data URI support.

---

## [1.4.3] — 2026-02-16

### Added
- **Comprehensive Terms of Service & EULA v2.0** — rewrote the 8-clause Release of Liability into a full 12-section Terms of Service, End User License Agreement & Release of Liability covering: age restriction & eligibility, service description, no warranty, assumption of risk, release of liability & limitation of damages, indemnification, user conduct & content, data handling & privacy, intellectual property, dispute resolution & governing law (with 1-year limitation period, class action waiver), termination (with survival of key sections), and general provisions (severability, waiver, modification, assignment).
- **18+ age verification gate** — users must check a separate age-confirmation checkbox ("I confirm that I am 18 years of age or older") before login or registration. The server enforces `ageVerified: true` on both `/api/auth/login` and `/api/auth/register` and rejects requests without it.
- **Age attestation stored in database** — `eula_acceptances` table gains an `age_verified` column; every login/register records whether the user attested to being 18+.
- **Dual-checkbox validation** — client requires both age-checkbox and EULA-checkbox to be checked before allowing auth. Clicking "I Accept" in the EULA modal checks both; "Decline" unchecks both.
- **LICENSE updated** — added Section 4 (Age Restriction) and Section 5 (Indemnification) to the MIT-NC license.

### Changed
- **EULA version bumped to 2.0** — all existing users must re-accept the new terms on next login (localStorage key now checks for `'2.0'`).
- **EULA modal widened** — `max-width` increased from 600 px to 700 px for readability of the longer agreement.
- **CSS** — added `h4` heading styles and `ul` bullet-list styles inside `.eula-content` for the new sections, plus spacing between stacked checkboxes.

---

## [1.4.2] — 2026-02-16

### Fixed
- **Admin status & display name lost on reconnect** — the socket auth middleware now refreshes both `is_admin` and `display_name` from the database on every connection, instead of trusting the JWT payload which could be stale. Additionally, admin status is synced from `.env ADMIN_USERNAME` on every socket connect (not just login), so `.env` changes take effect without requiring a re-login.
- **Server pushes authoritative user info on connect** — a new `session-info` event fires on every socket connect/reconnect, overwriting the client's `localStorage` with the server's truth (id, username, isAdmin, displayName). This prevents stale or corrupted local data from hiding the display name or admin controls.

---

## [1.4.1] — 2026-02-16

### Added
- **Independent voice & text channels** — voice and text are now fully decoupled, matching Discord's model. You can be in voice on one channel while reading/typing in another. Voice persists across text channel switches. The server uses dedicated `voice:<code>` socket.io rooms so voice signaling and updates reach participants regardless of which text channel they're viewing.
- **Sidebar voice indicators** — channels with active voice users show a 🔊 count badge in the left sidebar, so you can see at a glance where people are talking without clicking into each channel.
- **Roadmap section in README** — planned features (webhooks/bots, permission levels, threads, file sharing, E2EE) are now listed in a roadmap table.

### Fixed
- **Mobile input field sizing** — shortened placeholder to "Message..." on narrow screens, reduced button sizes from 40 px to 34 px, tightened padding, and lowered the auto-resize cap to 90 px. The input no longer starts too small or jumps to an awkward height on tap.
- **Mobile header voice overflow** — voice controls no longer wrap to a second line and get cut off. Removed `flex-wrap`, compacted button labels ("🎤▾" instead of "🎤 Voice ▾" on ≤ 768 px), and allowed the controls container to shrink.
- **Voice updates reaching wrong clients** — `broadcastVoiceUsers` previously emitted only to the text-channel room (`channel:<code>`), so users in voice who had switched text channels missed updates. It now emits to both `voice:<code>` and `channel:<code>`.

---

## [1.4.0] — 2026-02-16

### Added
- **Display name ≠ login name** — users now have a separate display name that is shown everywhere (messages, voice, leaderboards, online list). The login username is set at registration and never changes, so nobody forgets their credentials. Display names allow spaces, don't need to be unique, and can be changed at will via the ✏️ button. The immutable login name is shown as a small `@username` subtitle in the sidebar.
- **Mobile voice join** — "🎤 Join Voice" button added to the right-sidebar users panel, accessible on phones where the header voice button is hidden.

### Fixed
- **Mobile viewport — message input visible** — switched from `100vh` (which doesn't account for browser chrome) to `100dvh` (dynamic viewport height). The text input no longer hides behind the phone's URL bar.
- **Mobile header decluttered** — delete, search, pin, and copy-code buttons are now hidden on screens ≤ 768 px. Features are still accessible via long-press or sidebar.
- **GIF picker branding** — corrected "Search Tenor…" / "Powered by Tenor" to "Search GIPHY…" / "Powered by GIPHY" to match the actual API in use.
- **Mobile toolbar tap-to-reveal at 768 px** — the message action toolbar (react, reply, pin, edit, delete) now hides/shows on tap across all mobile breakpoints, not just ≤ 480 px.

### Improved
- **Status bar hidden on mobile** — the ping / server / encryption status bar is suppressed on phones to reclaim vertical space.

---

## [1.3.9] — 2026-02-16

### Fixed
- **Slash commands working after every deploy** — static file caching dropped from 1 h to always-revalidate (ETag). Previously, browsers could serve stale JS for up to an hour after a server restart, causing commands and other new features to appear broken.

### Improved
- **Mobile message actions — tap to reveal** — react, reply, pin, edit, and delete buttons are now hidden until you tap a message, drastically reducing clutter on phone screens. Tap another message to move the toolbar; tap empty space or the input to dismiss.

---

## [1.3.8] — 2026-02-16

### Fixed
- **Leaderboard scoring now persists** — removed `noopener` from the Shippy Container popup so `postMessage` score submissions actually reach the main app. Scores are saved correctly again.
- **Dracula theme darkened** — replaced grey background values with much darker tones so the theme lives up to its name.

### Added
- **In-game leaderboard** — the Shippy Container game now shows a live leaderboard panel beside the canvas, updated on launch and after every run. The old sidebar leaderboard button and modal are removed.
- **High-score announcements** — when a player beats their personal best, a 🏆 status toast is broadcast to the channel.
- **Voice controls dropdown** — mute, deafen, screen share, and noise suppression are tucked behind a single "🎤 Voice ▾" button; a compact "✕" leave button stays visible. Keeps the header clean.
- **5 new themes** — Dark Souls 🔥, Elden Ring 💍, Minecraft ⛏️, Final Fantasy X ⚔️, and Legend of Zelda 🗡️ join the theme picker.
- **Themed slider fills** — all range sliders (volume, noise suppression, stream size) now fill their left portion with accent-colored gradients and glow effects that match the active theme.

---

## [1.3.7] — 2026-02-15

### Fixed
- **Voice leave audio cue** — leaving voice chat now plays the descending tone (matching the cue other users already heard) so you get audible confirmation.
- **Stream ghost tiles cleaned up on leave** — all screen-share tiles are properly destroyed when leaving voice. Previously, tiles persisted with dead video sources and showed black screens when restored.

### Added
- **"Left voice chat" toast** — a brief info toast confirms you disconnected, mirroring the existing "Joined voice chat" toast.
- **Escape closes all modals** — pressing Escape now dismisses every open modal overlay (settings, bans, leaderboard, add-server) in addition to the search and theme panels it already handled.

---

## [1.3.6] — 2026-02-11

### Fixed
- **Noise suppression default lowered to 10%** — 50% was too aggressive for most microphones; new users now start at 10%.
- **RGB theme speed dramatically increased** — previous fastest setting is now the slowest. Uses fixed 16 ms tick with variable hue step (0.8°–4.0° per tick) for smooth, visible cycling.
- **Custom theme triangle now affects backgrounds** — triangle saturation is passed as the vibrancy parameter, so moving the picker visibly changes background tinting, not just accent highlights.
- **Switching to DMs no longer hides voice controls** — voice mute/deafen/leave buttons persist when in a call regardless of which channel is being viewed.
- **Stream "Hide" button removed** — per-tile close buttons are gone; the header minimize button keeps streams accessible and always allows restoring them.
- **Minimize no longer stops your own screen share** — minimizing the stream panel just hides the UI; your share continues broadcasting.

### Added
- **Stream size slider** — a range slider in the streams header adjusts the viewer height (20–90 vh), persisted to localStorage.
- **Theme popup menu** — themes moved from an inline sidebar section (that could scroll off-screen) to a floating popup panel pinned above the sidebar bottom bar. The bottom bar always shows theme/game/leaderboard buttons and the voice bar.

---

## [1.3.5] — 2026-02-14

### Changed
- **Noise suppression → sensitivity slider** — replaced the on/off NS toggle button with an adjustable slider (0–100). Sensitivity maps to the noise gate threshold (0 = off, 100 = aggressive gating). The slider sits inline in the voice controls when in a call.
- **Custom theme overhaul** — the triangle colour picker now dramatically affects the entire UI. Backgrounds, text, borders, links, glow effects, and even success/danger/warning colours are all derived from the chosen hue. The `vibrancy` parameter (used internally) controls how saturated the backgrounds and text become — the triangle’s saturation/value selection now produces visibly different themes instead of only tweaking subtle highlights.

### Added
- **RGB cycling theme** — new 🌈 RGB button in the theme selector. Continuously shifts the entire UI through all hues like gaming RGB peripherals. Two sliders control **Speed** (how fast it cycles) and **Vibrancy** (how saturated/tinted the backgrounds and text become). Settings persist in localStorage.

---

## [1.3.4] — 2026-02-14

### Added
- **Noise suppression (noise gate)** — Web Audio noise gate silences background noise (keyboard, fans, breathing) before sending audio to peers. Runs at 20 ms polling with fast 15 ms attack / gentle 120 ms release. Toggle on/off with the 🤫 NS button in voice controls (enabled by default).
- **Persistent voice across channels** — joining voice in one channel no longer disconnects when switching text channels. A pulsing green voice bar in the sidebar shows which channel you're connected to, with a quick-disconnect button. Voice controls dynamically show/hide based on whether the active text channel matches your voice channel.
- **Server leaderboard** — new 🏆 Leaderboard button in the sidebar opens a modal showing the top 20 Shippy Container scores server-wide, complete with medal indicators for the top 3.

### Fixed
- **Shippy Container frame-rate physics** — game physics normalised to a 60 fps baseline using delta-time scaling. Players on 144 Hz (or any refresh rate) monitors now experience identical gravity, pipe speed, and spawn timing as 60 Hz players. Pipe spawning switched from frame-count based (every 90 frames) to time-based (every 1.5 s). Scale capped at 3× to prevent teleportation on tab-switch.

---

## [1.3.3] — 2026-02-13

### Fixed — Bug Fixes
- **Upload error handling** — both image and file upload handlers now check HTTP status before parsing JSON, giving users clear error messages instead of cryptic "Not Found" toasts.
- **Screen share X button** — clicking close now minimises the screen-share container instead of destroying all streams. A pulsing indicator button appears in the channel header so you can bring the view back. New incoming streams auto-restore the container.
- **Online users visibility** — users are now visible across all channels as soon as they connect, not only in the specific channel they are currently viewing. Disconnect events broadcast to all active channels.
- **DM button feedback** — clicking 💬 now shows a toast ("Opening DM with …"), disables the button during the request, scrolls the sidebar to the newly-opened DM channel, and re-enables after a timeout fallback.

### Changed
- **Tenor → GIPHY migration** — GIF search backend and client switched from Tenor (Google) to GIPHY. New admin setup guide, server proxy endpoints, and response parsing. All `media.tenor.com` URL patterns updated to `media*.giphy.com`. README updated with simpler GIPHY key setup instructions.

### Added
- **Custom theme with triangle picker** — new 🎨 "Custom" button in the theme selector. Opens an inline HSV triangle colour picker (canvas-based hue bar + SV triangle) that live-generates a full theme palette from a single accent colour. Custom HSV values persist in localStorage and apply instantly on page load (no flash).

---

## [1.3.2] — 2026-02-12

### Fixed — Security Hardening II
- **Upload serving headers** — non-image uploads now served with `Content-Disposition: attachment`, preventing HTML/SVG files from executing in the browser when accessed directly.
- **Image magic-byte validation** — uploaded images are verified by reading file header bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `GIF8x`, WebP `RIFF…WEBP`), not just MIME type. Spoofed files are rejected and deleted.
- **CSP tightened** — removed `ws:` from `connect-src`, allowing only `wss:` (encrypted WebSocket connections).
- **Inline event handler removed** — link preview `onerror` attribute replaced with delegated JS listener, eliminating a CSP `unsafe-inline` bypass vector.
- **Password minimum raised** — registration now requires 8+ characters (was 6).
- **Account enumeration mitigated** — registration endpoint no longer reveals whether a username is already taken.

### Added — Quality of Life
- **Password change from settings** — new 🔒 Password section in the settings modal lets users change their password (current → new → confirm) without logging out. Backend `POST /api/auth/change-password` issues a fresh JWT on success.
- **Emoji picker upgrade** — categorized tabs (Smileys, People, Animals, Food, Activities, Travel, Objects, Symbols), search bar, scrollable grid with 280+ emojis. Replaces the old flat 40-emoji palette.
- **`/butt` slash command** — `( . )( . )` — companion to `/boobs`.

---

## [1.3.1] — 2026-02-12

### Fixed — Security Hardening
- **GIF endpoints now require authentication** — `/api/gif/search` and `/api/gif/trending` were previously unauthenticated, allowing anyone to probe the server and burn Tenor API quota. Now require a valid JWT.
- **GIF endpoint rate limiting** — new per-IP rate limiter (30 req/min) prevents abuse.
- **Version fingerprint removed** — `/api/health` no longer exposes the Haven version number to the public internet.
- **HTTP redirect server (port 3001) hardened** — added rate limiting, `x-powered-by` disabled, header/request timeouts, and replaced open redirect (`req.hostname`) with fixed `localhost` redirect target.
- **DNS rebinding SSRF protection** — link preview endpoint now resolves DNS and checks the resulting IP against private ranges, defeating rebinding attacks where `attacker.com` resolves to `127.0.0.1`.
- **Link preview rate limiting** — new per-IP rate limiter (30 req/min) prevents abuse of the outbound HTTP fetcher.
- **HSTS header** — forces browsers to use HTTPS for 1 year after first visit, preventing protocol downgrade attacks.
- **Permissions-Policy header** — explicitly denies camera, geolocation, and payment APIs to the page.
- **Referrer-Policy header** — `strict-origin-when-cross-origin` prevents full URL leakage in referrer headers.
- **X-Content-Type-Options** — `nosniff` header prevents MIME-type sniffing on uploaded files.
- **Server request timeouts** — headersTimeout (15s), requestTimeout (30s), keepAliveTimeout (65s), and absolute socket timeout (120s) to prevent Slowloris-style attacks.

---

## [1.3.0] — 2026-02-12

### Added — Direct Messages
- **Private 1-on-1 conversations** — click 💬 on any user in the member list to open a DM.
- DMs appear in a separate "Direct Messages" section in the sidebar.
- If a DM already exists with that user, it reopens instead of creating a duplicate.
- Both users are notified in real-time when a DM is created.

### Added — User Status
- **4 status modes** — Online (green), Away (yellow), Do Not Disturb (red), Invisible (grey).
- **Custom status text** — set a short message (up to 128 chars) visible in the member list.
- **Status picker** — click the status dot next to your username in the sidebar.
- **Auto-away** — automatically switches to Away after 5 minutes of inactivity; returns to Online on activity.
- **Persisted in database** — status survives reconnects and page refreshes.

### Added — Channel Topics
- **Admin-settable topic** — thin topic bar below the channel header with the channel's description.
- Click the topic bar to edit (admin-only). Non-admins see the topic as read-only.
- Topics are stored in the database and broadcast to all channel members on change.

### Added — General File Sharing
- **Upload files up to 25 MB** — PDFs, documents (Word/Excel/PowerPoint), audio (MP3/OGG/WAV), video (MP4/WebM), archives (ZIP/7z/RAR), text, CSV, JSON, Markdown.
- **File attachment cards** — styled download cards with file type icons, names, sizes, and download buttons.
- **Inline audio/video players** — audio and video files render with native HTML5 players directly in chat.
- **Separate upload endpoint** — `/api/upload-file` with expanded MIME whitelist and 25 MB limit.

### Added — Persistent Read State
- **Server-tracked unread counts** — `read_positions` table tracks the last-read message per user per channel.
- Unread badges now survive page refreshes, reconnects, and browser restarts.
- Mark-read is debounced (500 ms) and fires on message load and new message receipt.
- Channels list includes accurate unread counts from the server on load.

### Changed — Database
- New `read_positions` table for persistent unread tracking.
- New columns on `users`: `status`, `status_text`.
- New columns on `channels`: `topic`, `is_dm`.
- New column on `messages`: `original_name` (for file upload metadata).
- All migrations are safe — existing databases upgrade automatically.

### Changed
- Version bumped to 1.3.0.
- Member list now shows status dots (colored by status) and custom status text.
- Member list includes a DM button (💬) on each user for quick DM access.
- Channel list split into regular channels and DM section.
- `get-channels` now returns topic, is_dm, dm_target, and server-computed unread counts.
- `emitOnlineUsers` now includes user status and status text in the payload.

---

## [1.2.0] — 2026-02-12

### Added — Voice UX
- **Join / leave audio cues** — synthesized tones play when users enter or leave voice chat.
- **Talking indicators** — usernames glow green while speaking, with 300 ms hysteresis for smooth animation.
- **Multi-stream screen sharing** — multiple users can share screens simultaneously in a CSS Grid tiled layout with per-user video tiles, labels, and close buttons.

### Added — Message Pinning
- **Pin / unpin messages** (admin-only) — pin button in message hover toolbar.
- **Pinned messages panel** — sidebar panel listing all pinned messages in a channel with jump-to-message.
- **50-pin cap per channel** to prevent abuse.
- **Database-backed** — new `pinned_messages` table with foreign keys; pins survive restarts.

### Added — Enhanced Markdown
- **Fenced code blocks** — triple-backtick blocks with optional language labels render with styled monospace containers.
- **Blockquotes** — lines starting with `>` render with left-border accent styling.

### Added — Link Previews
- **Automatic OpenGraph previews** — shared URLs fetch title, description, and thumbnail server-side.
- **30-minute cache** — previews are cached to avoid repeated fetches.
- **SSRF protection** — private/internal IPs are blocked from the preview fetcher.

### Added — GIF Search
- **Tenor-powered GIF picker** — search and send GIFs inline from the message input.
- **Admin-configurable API key** — Tenor API key can be set from the admin GIF picker UI with an inline setup guide.
- **Server-stored key** — API key saved in `server_settings` DB table (never exposed to non-admins).

### Fixed — Security
- **Admin username hijack via rename** — non-admin users can no longer claim the admin username through `/nick` or rename.
- **XSS via attribute injection** — `_escapeHtml` now escapes `"` and `'` characters, preventing injection through OG metadata or user content.
- **SSRF in link previews** — `/api/link-preview` now blocks requests to localhost, private ranges (10.x, 192.168.x, 172.16-31.x), link-local (169.254.169.254), and internal domains.
- **API key leak** — `get-server-settings` no longer sends sensitive keys (e.g. `tenor_api_key`) to non-admin users.
- **Cross-channel reaction removal** — `remove-reaction` now verifies the message belongs to the current channel.
- **Voice signaling without membership** — `voice-offer`, `voice-answer`, and `voice-ice-candidate` now verify the sender is in the voice room.
- **Typing indicator channel check** — typing events now verify the user is in the claimed channel.

### Fixed — Bugs
- **Voice audio broken** — eliminated duplicate `MediaStreamSource` creation; single source now splits to analyser and gain node.
- **Spotty talking indicator** — added 300 ms sustain hysteresis to prevent flicker during natural speech pauses.
- **Screen share invisible** — added SDP rollback for renegotiation glare, `event.streams[0]` for proper stream association, `track.onunmute`, and explicit `play()` on muted video tiles.
- **GIF send completely broken** — fixed wrong property names (`channelCode` → `code`, `this.replyTo` → `this.replyingTo`) that silently dropped every GIF message.
- **Reconnect dead channel** — socket reconnect now re-emits `enter-channel`, `get-messages`, `get-channel-members`, and other state-restoring events.
- **Screen share privacy leak** — closing the screen share viewer now actually stops the broadcast (calls `stopScreenShare()`) instead of just hiding the UI.
- **Auto-scroll failure** — `_scrollToBottom` after appending messages now uses the force flag to prevent large messages from blocking scroll.
- **Delete-user FK violation** — user deletion now cleans up `pinned_messages`, `high_scores`, `eula_acceptances`, and `user_preferences` to prevent foreign key errors.
- **Delete-channel incomplete** — channel deletion now explicitly removes associated pinned messages.
- **Delete-message incomplete** — message deletion now removes associated pinned message entries.
- **LIKE wildcard injection** — search-messages now escapes `%`, `_`, and `\` in search queries.

### Changed — Performance
- **N+1 query eliminated** — `get-messages` replaced 240 individual queries (for 80 messages) with 3 batch queries using `WHERE ... IN (...)` for reply context, reactions, and pin status.

### Changed
- `edit-message`, `delete-message`, `pin-message`, `unpin-message` DB operations wrapped in try/catch for graceful error handling.
- Version bumped to 1.2.0.

---

## [1.1.0] — 2026-02-11

### 🔒 Data Isolation

All user data now lives **outside** the Haven code directory, making it physically impossible to accidentally commit or share personal data.

### Changed
- **Database, .env, certs, and uploads** are now stored in:
  - **Windows:** `%APPDATA%\Haven\`
  - **Linux / macOS:** `~/.haven/`
- **SSL certificates are auto-detected** — if certs exist in the data directory, HTTPS enables automatically without needing to edit `.env`.
- **Start Haven.bat** and **start.sh** generate certs and bootstrap `.env` in the external data directory.
- **Automatic one-time migration** — existing data in the old project-directory locations is moved to the new data directory on first launch.

### Added
- New `src/paths.js` module — single source of truth for all data directory paths.
- `HAVEN_DATA_DIR` environment variable — override where data is stored.

### Updated
- README.md, GUIDE.md, and .env.example updated to reflect new data locations.

---

## [1.0.0] — 2026-02-10

### 🎉 First Public Release

Haven is now ready for public use. This release includes all features from the alpha series plus security hardening and polish for distribution.

### Added — Slash Command Autocomplete
- **Type `/`** and a Discord-style tooltip dropdown appears with all available commands.
- **Keyboard navigation** — Arrow keys to browse, Tab to select, Escape to dismiss.
- **Descriptions & argument hints** for every command.

### Added — New Slash Commands
- `/roll [NdN]` — Roll dice (e.g. `/roll 2d20`). Defaults to 1d6.
- `/flip` — Flip a coin (heads or tails).
- `/hug <@user>` — Send a hug.
- `/wave` — Wave at the chat.
- `/nick <name>` — Change your username.
- `/clear` — Clear your chat view (local only).

### Added — Message Search
- **Ctrl+F** or 🔍 button opens a search bar in the channel header.
- Results panel with highlighted matches.
- Click a result to scroll to that message with a flash animation.

### Added — 6 New Themes
- **Cyberpunk** — Neon pink and electric yellow
- **Nord** — Arctic blue and frost
- **Dracula** — Deep purple and blood red
- **Bloodborne** — Gothic crimson and ash
- **Ice** — Pale blue and white
- **Abyss** — Deep ocean darkness

### Fixed — Security
- **Privilege escalation via rename** — Users can no longer gain admin by renaming to the admin username.
- **Upload extension bypass** — Server now forces file extensions based on validated MIME type.
- **Banned user upload bypass** — Banned users can no longer upload images via the REST API.
- **Upload rate limiting** — 10 uploads per minute per IP.
- **Spoiler CSP violation** — Spoiler click handler moved from inline to delegated (CSP-safe).
- **postMessage origin check** — Game score listener validates origin before accepting.
- **Event listener leak** — Game score listener registered once, not per button click.

### Changed
- Version bumped to 1.0.0 for public release.
- README rewritten as user-facing documentation.
- All personal data scrubbed from codebase.
- Added MIT LICENSE file.
- 12 themes total (6 new added to the original 6).

---

## [0.6.0-alpha] — 2026-02-10

### Added — Emoji Picker
- **Emoji button** in the message input bar — click to open a 40-emoji palette.
- **Insert at cursor** — emojis are inserted at the current cursor position, not appended.
- **Curated set** — 40 of the most useful emojis across smileys, gestures, objects, and symbols.

### Added — Message Reactions
- **Hover toolbar** — hover any message to see React 😀 and Reply ↩️ buttons.
- **Quick-pick palette** — click React to get a fast 8-emoji picker (👍👎😂❤️🔥💯😮😢).
- **Toggle reactions** — click an existing reaction badge to add/remove your own reaction.
- **"Own" highlight** — reactions you've placed are visually highlighted with accent color.
- **Persistent** — reactions stored in database (`reactions` table) and survive restarts.
- **Real-time sync** — all users in the channel see reactions update instantly.

### Added — @Mentions with Autocomplete
- **Type `@`** in the message input to trigger an autocomplete dropdown.
- **Live filtering** — as you type, the dropdown narrows to matching usernames.
- **Keyboard nav** — Arrow keys to navigate, Enter/Tab to select, Escape to dismiss.
- **Click to select** — click any suggestion to insert `@username` into your message.
- **Visual highlight** — `@mentions` render with accent-colored pill styling in chat.
- **Self-highlight** — mentions of your own username are extra-bold for visibility.
- **Channel-aware** — only members of the current channel appear in suggestions.

### Added — Reply to Messages
- **Reply button** — hover any message and click ↩️ to reply.
- **Reply bar** — preview bar appears above the input showing who/what you're replying to.
- **Cancel reply** — click ✕ on the reply bar to clear.
- **Reply context** — replied messages show a colored banner above them linking back to the original.
- **Threaded feel** — replies group visually with the parent message's author color.
- **Persistent** — `reply_to` column in messages table; reply context survives reloads.

### Changed — Database
- Added `reply_to` column to `messages` table (auto-migrated on existing databases).
- New `reactions` table with unique constraint per (message, user, emoji).
- Safe migration: existing databases are upgraded without data loss.

### Changed — Backend
- `get-messages` now returns reactions and reply context for each message.
- `send-message` accepts optional `replyTo` field.
- New socket events: `add-reaction`, `remove-reaction`, `get-channel-members`.
- `reactions-updated` broadcast to all channel members on any reaction change.
- `channel-members` event returns member list for @mention autocomplete.
- Emoji validation: only actual emoji characters accepted (regex unicode property check).

---

## [0.5.0-alpha] — 2026-02-10

### Added — Multi-Server Sidebar
- **Server bar** (far left) — Discord-style vertical strip showing all your Haven servers.
- **Live status lights** — Green (online), grey (offline), yellow (checking) status dots on each server icon.
- **Add/remove servers** — Modal dialog to add friends' Haven servers by name + URL.
- **Health check API** — `GET /api/health` returns server name, status, and version. CORS-enabled for cross-server pings.
- **One-click connect** — Click any server icon to open it in a new tab.
- **`ServerManager` class** (`servers.js`) — Client-side server list stored in `localStorage` with 30-second polling.

### Added — Image Sharing
- **Image upload** — Upload button in message input area. Max 5 MB (jpg, png, gif, webp).
- **Clipboard paste** — Paste images directly from clipboard into chat.
- **Drag & drop** — Drag image files onto the chat area to upload.
- **Inline rendering** — Uploaded images and image URLs render as clickable inline images in chat.
- **Server-side handling** — Multer middleware with random filenames, MIME type validation, size limits.
- **Upload authentication** — JWT token required for uploads.

### Added — Voice Volume Control
- **Per-user volume sliders** — Range inputs (0–200%) below each voice user in the panel.
- **Persistent settings** — Volume preferences saved in `localStorage` per user ID.
- **Auto-applied** — Saved volumes automatically applied when peers connect.
- **"you" tag** — Your own entry in voice shows a label instead of a slider.

### Added — Notification Tones
- **Web Audio API engine** — Zero-dependency synthesized notification sounds.
- **5 built-in tones** — Ping, Chime, Blip, Bell, Drop.
- **Configurable** — Choose which sound plays for messages (right sidebar panel).
- **Enable/disable toggle** — Master on/off switch for all notifications.
- **Volume slider** — Independent notification volume control.
- **Event triggers** — Sounds on new message (from others) and user join.

### Added — Cross-Platform Support
- **`start.sh`** — Linux/macOS launcher with: Node.js detection, auto dependency install, auto SSL cert generation, process management, clean shutdown on Ctrl+C, browser auto-open.
- **`.env.example`** — Template configuration file with full documentation.
- **`SERVER_NAME`** — New `.env` variable for naming your Haven instance.

### Fixed — Security
- **JWT timing bug** — `JWT_SECRET` auto-generation now runs *before* `auth.js` is loaded, fixing a race condition where the first boot used a different secret than subsequent boots.
- **JWT fallback removed** — `auth.js` no longer has a hardcoded fallback secret. If `JWT_SECRET` is missing, the server exits with a clear error.
- **Channel membership enforcement** — `enter-channel` and `voice-join` now verify the user is actually a member before granting access.
- **Atomic channel deletion** — `delete-channel` now wrapped in a SQLite transaction for data integrity.

### Changed
- **`server.js`** — Restructured require order (JWT auto-gen before auth load), added multer, health endpoint, upload endpoint, SERVER_NAME in banner.
- **`package.json`** — Version bumped to 0.5.0, added multer dependency.
- **`public/app.html`** — Added server bar, image upload button, file input, notification settings panel, add-server modal.
- **`public/js/app.js`** — Full rewrite with ServerManager, NotificationManager, image upload/paste/drag-drop, volume sliders, server bar rendering.
- **`public/js/voice.js`** — Added `setVolume()`, `_getSavedVolume()` methods, auto-apply saved volume on stream play.
- **`public/css/style.css`** — Added 7 new CSS sections: server bar, modal, chat images, upload button, volume sliders, notification settings, drag-over state.
- **`.gitignore`** — Added `public/uploads/*`, `haven.db-shm`, `haven.db-wal`.
- **`Start Haven.bat`** — Made generic (no hardcoded IP), increased startup timeout.
- **`README.md`** — Full rewrite with updated features, cross-platform install, expanded roadmap.

---

## [0.4.0-alpha] — 2026-02-10

### Added — Security Hardening
- **Helmet security headers** — CSP, X-Content-Type-Options, X-Frame-Options, HSTS, no X-Powered-By.
- **API rate limiting** — 20 requests per 15 minutes per IP on auth endpoints.
- **Socket connection rate limiting** — Max 15 connections per minute per IP.
- **Socket event flood protection** — Per-connection: max 60 events/10s, max 10 messages/10s.
- **Input validation on all socket events** — Type checks, string length bounds, regex for channel codes, integer checks.
- **Body size limits** — Express JSON parsing capped at 16KB.
- **Static file hardening** — `dotfiles: 'deny'`.
- **CORS lockdown** — Socket.IO CORS set to `origin: false`.
- **Auto-generated JWT secret** — 48-byte random secret on first run.
- **Safe URL regex (client)** — Tightened URL matching, `nofollow`, URL constructor validation.
- **User Guide** — `GUIDE.md` created.

---

## [0.3.0-alpha] — 2026-02-10

### Added
- **HTTPS / SSL support** — Self-signed certificate, auto-detection from `.env`.
- **HTTP → HTTPS redirect** — Secondary listener on port 3001.

---

## [0.2.0-alpha] — 2026-02-10

### Added
- **6 UI themes** — Haven, Discord, Matrix, Tron, HALO, Lord of the Rings.
- **Status bar** — LEDs, ping, channel name, online count, clock.
- **`Start Haven.bat`** — Windows one-click launcher.
- **Unread badges** — Channel list badges.
- **Message grouping** — Compact mode for consecutive messages.

### Fixed
- **App crash** — `initThemeSwitcher()` extracted to shared `theme.js`.

---

## [0.1.0-alpha] — 2026-02-10

### Added
- Core server (Express + Socket.IO).
- User authentication (bcrypt + JWT).
- Secret channels with invite codes.
- Real-time text chat with history.
- Voice chat (WebRTC).
- Admin controls.
- SQLite database.
- `.env` configuration.
