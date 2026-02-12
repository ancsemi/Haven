# Changelog

All notable changes to Haven are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/). Haven uses [Semantic Versioning](https://semver.org/).

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
