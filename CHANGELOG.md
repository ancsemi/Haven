# Changelog

All notable changes to Haven are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/). Haven uses [Semantic Versioning](https://semver.org/).

> **Deploy checklist** — after committing changes:
> 1. `git push origin main` — pushes code **and** GitHub Pages site (`docs/`)
> 2. `website/index.html` is auto-synced from `docs/index.html` — keep them identical
> 3. Restart the Haven server to pick up `server.js` / `socketHandlers.js` changes

---

## [3.13.0] — 2026-05-05

### Added
- **#5340: DM auto-cleanup notice banner.** When admin has enabled `cleanup_enabled` with a non-zero `cleanup_max_age_days`, every DM channel now shows a small one-line banner under the channel header reading "Messages older than N days are auto-deleted on this server." Reacts live to setting changes (no channel switch required) and is hidden in regular channels and on the welcome screen. Pure UX add — no schema or behavior change to cleanup itself.
- **Admin settings — Server Updates moved to top of sidebar.** The Server Updates section was buried below Backup with no sidebar link. It now sits at the top of the admin sidebar (first entry, above Branding) so admins can always find it quickly.

### Fixed
- **Admin settings — action buttons stretched full-width.** "Manage Sounds", "Manage Emojis", "Manage Stickers", "Manage Roles", "View Bans", "View Deleted Users", and "View All Members" buttons in the admin panel had `btn-full` applied, forcing them to span the entire settings panel width. Removed `btn-full` so they size naturally to their content and sit beside one another in a flex row where multiple buttons exist.
- **#5294: Admin-configurable login session duration.** New `session_duration_days` server setting (1–365, default 7) replaces the hard-coded `expiresIn: '7d'` on every JWT signing site in `src/auth.js`, and Settings → Uploads & Limits gets a new "Login session duration (days)" input. Existing tokens keep their original expiry — only newly-issued tokens (login, signup, TOTP confirm, password change, recovery, refresh) pick up the new value. Defaults preserve current behavior. Thanks @amnibro.
- **Webhook integration expansion.** Outbound bot callbacks now include:
  - **Per-event subscriptions** via a new `subscribed_events` column (CSV: `message`, `reaction-added`, `member-joined`, or `*` for all). Existing webhooks default to `*` so behavior is unchanged on upgrade.
  - **HMAC signature header upgraded** to the standard `sha256=<hex>` format under `X-Haven-Signature`, plus a new `X-Haven-Event` header so consumers can route without parsing the body.
  - **One automatic retry** with a 5-second delay on 5xx responses or network failures. 4xx responses are treated as bot rejection and not retried.
  - **Per-webhook delivery health** (`last_delivery_status`, `last_delivery_at`, `last_delivery_error`, `failure_count`) recorded on every attempt and surfaced in `webhooks-list` payloads for admin UIs.
  - **New event types** beyond the existing `message`: `reaction-added` fires when a user reacts to a message; `member-joined` fires when a user joins the channel.
  - **`test-webhook` admin socket event** that fires a synthetic `test` event so admins can verify their bot is reachable without manually triggering a real channel event.
  - **Inbound `reply_to` support** at `POST /api/webhooks/:token` — bots can now reply to a specific message in their channel; the response renders the standard inline reply preview in clients.
  - **Inbound `avatar_url` per-message override** alongside the existing `username` override, so a single bot can post under multiple personas.

### Fixed
- **#5337: Link previews show 429s when reopening a chat with multiple links.** Two compounding bugs — (1) the per-IP rate limiter ran *before* the cache lookup, so cached previews still burned a token and a chat with 30+ links could exhaust the budget on a single re-render; (2) the client refetched every preview from scratch on every channel switch / scroll re-render with no in-flight dedupe. Server now consults the cache first and only rate-limits cache misses, the per-minute budget is doubled (30 → 60), and the client keeps a 10-minute in-memory preview cache plus a per-URL inflight Promise so concurrent re-renders share one network request.
- **Phantom taskbar overlay badge with no on-screen indicator anywhere.** Two cases: (1) `_updateNestedIndicators` short-circuited on collapsed category labels, so unread sub-channels inside a collapsed category contributed to the desktop badge total without rendering any visible bubble — exactly the "taskbar lit, sidebar empty" symptom from the user-reported screenshots. Collapsed category labels now render a count bubble identical to collapsed parent channels. (2) `_updateDesktopBadge` and `_updateTabTitle` no longer count locally-muted channels, since their per-channel sidebar dot is suppressed and the server's snapshot doesn't know about local mutes — without this, a muted channel with new messages lit the taskbar with nothing visible to clear it.

---

## [3.12.0] — 2026-05-05

### Added
- **#5335: Starter sticker pack.** Fresh installs now ship with a small built-in "Starter" pack (8 reaction stickers: 👍, ❤️, 😂, 🔥, 🎉, ✅, ❌, 👀) so the picker isn't empty before any sticker is uploaded. The pack is seeded once at first run if no stickers exist; existing servers keep whatever they already have.
- **#5335: `:stickername:` shortcode in the composer.** Typing a sticker name surrounded by colons (e.g. `:fire:`) sends that sticker the same way `:emoji:` works for custom emojis. Lookup is exact-match against the stored sticker name.
- **#5335: Dedicated `manage_stickers` role permission.** Previously sticker upload/management was gated by `manage_emojis` for backwards-compat. There is now a separate `manage_stickers` permission that can be granted independently from emoji management. Existing roles with `manage_emojis` retain sticker access so nothing breaks on upgrade.

### Fixed
- **#5335: Emoji picker auto-closed when switching to the Stickers tab (and vice versa).** The picker rebuilt the section button DOM on each tab switch, but the global outside-click handler ran *after* the rebuild and saw the original click target detached from the picker subtree, so `picker.contains(e.target)` returned false and the picker was dismissed. The section toggle now calls `stopPropagation()` on the click event and short-circuits if the user re-clicks the active section, so the picker stays open across tab switches.
- **#5325 / #5280: Burn-after-read DM button gave no visible feedback and the placeholder showed a raw i18n key.** Both `_wireBurnMessages` and `_replaceBurnedMessage` used the broken `t('key') || 'fallback'` pattern — but `t()` returns the key string itself when a translation is missing, so the `||` short-circuit never fired and the literal `messages.burn_reveal` text was rendered to users on locales that didn't have the keys. Added the missing `app.input_bar.burn_btn`, `app.input_bar.burn_btn_armed`, `toasts.burn_armed`, `toasts.burn_disarmed`, `messages.burn_reveal`, and `messages.burn_done` keys to `en.json`, then switched every burn-related call site to a key-aware fallback (`const v = t(k); const text = (v && v !== k) ? v : 'fallback'`). The 🔥 toggle button also now fires a toast confirming the armed/disarmed state so the user knows the click registered.

---

## [3.11.2] — 2026-05-04

### Added
- **Quick links to Bans / Deleted Users from the All Members modal.** Mods and admins now see "View Bans" and "View Deleted Users" buttons in the bottom-left of the members list so they can jump between the three lists without going back through Settings → Admin. Buttons are hidden for users without `ban_user` (View Bans) or admin (View Deleted Users), and the server handlers re-validate permissions on emit, so DOM tampering can't reveal the lists.

### Fixed
- **#5307 (follow-up): "Delete DM" and "Delete Channel" confirm dialogs showed `settings.admin.delete` / `messages.delete` raw i18n keys instead of "Delete".** The DM-delete confirm passed `t('settings.admin.delete')` (no such key) as the button label, and the generic confirm modal's danger fallback referenced `t('messages.delete')` (also missing). `t()` returns the key string when a key is missing, so the `|| 'Delete'` short-circuit never fired. Both call sites now use `t('msg_toolbar.delete')`, which exists in every locale.
- **Manage Roles modal opened from the Role Assignment center showed an empty role list.** The click handler called `_loadRoles(cb)` and only opened the modal inside the callback, but `_loadRoles` only re-renders the sidebar when the role-modal is already visible — so by the time the modal opened, the sidebar render had already been skipped. The handler now uses `_openRoleModal()`, which shows the modal first and then loads, matching how the modal is opened from Settings.
- **Role Management modal didn't fill its window and resized vertical-only.** The inner role-editor layout was capped at `max-height: 60vh` so growing the modal taller left a tall blank gap above the Close button; `.modal-wide`'s `max-width: 720px` blocked horizontal resize entirely. The role modal is now a flex column (sidebar/detail panes grow with the modal, Close button pinned to the bottom-right), and its max-width is raised to `95vw` so the resize handle works in both directions.

---

## [3.11.1] — 2026-05-01

### Fixed
- **#184: Voice audio routed to the system default playback device instead of the user's chosen output.** `_ensureAudioCtx` constructed the `AudioContext` with no `sinkId` and `switchOutputDevice` only ran when the user opened the device picker, so anyone who picked their headset once and then re-joined voice would hear voice through their speakers until they re-opened the picker. The context now reads `localStorage.haven_output_device` at construction time and applies it via the `sinkId` constructor option (with a `setSinkId()` fallback for browsers/Electron builds that don't accept the option) so the saved sink takes effect on the very first track-add.

---

## [3.11.0] — 2026-05-01

### Added
- **Stickers (#5335).** Server admins (and anyone with `manage_emojis`) can upload sticker images grouped into named packs from Settings → Admin → Stickers. Stickers are larger than emojis (default 1 MB max, configurable via the `max_sticker_kb` server setting) and are sent as standalone images, not inline with text. The emoji picker now has an Emoji / Stickers section toggle; in the Stickers tab, packs appear as horizontal pills and stickers render as a 4-column thumbnail grid. Sending a sticker routes through the active composer (main channel, thread, or DM PiP) so replies and DM encryption keep working. Sticker URLs use the `/uploads/stickers/` prefix and render at sticker dimensions (`max-width: 180px`) instead of the regular chat-image cap.

### Fixed
- **#5333: DM PiP popped open over the channel you were already viewing.** `_openDMPiP` had no early return when the requested DM matched `currentChannel`, so the sidebar click handler, `dm-opened` socket event, channel-link click, and "Message [user]" button all could spawn a PiP that hovered over its own fullscreen view. Added a guard at the top of `_openDMPiP` so the function bails out when the DM is already the current channel.

---

## [3.10.14] — 2026-05-01

### Fixed
- **Long pinned messages were cut off and had no way to expand or scroll.** `.pinned-item-content` had a hard `max-height: 60px; overflow: hidden` cap — anything beyond a couple of lines was silently clipped with no indicator. Removed the cap; the pinned panel itself already scrolls, so long messages now show in full.
- **#5326: Message action toolbar and its overflow dropdown appeared behind other messages' `...` buttons on mobile/tablet.** The base `.msg-toolbar` z-index (10) was lower than `.msg-dots-btn` (12), and the overflow panel's z-index (12) was evaluated inside the toolbar's own stacking context, landing even lower in the paint order. Raised the base toolbar to z-20, the overflow panel to z-200, and explicitly set the selected-state toolbar to z-100 on coarse-pointer devices.
- **#5324: Images pasted into the DM PiP were sent instantly without a preview.** They now enter a per-PiP image queue that shows a preview bar above the input (same as the main channel), and are sent when the user presses Enter or taps Send — just like pasting into the main composer. The preview bar is cleared when the PiP is closed.
- **#5309: SVG files in DMs showed as a locked downloadable `.enc` file.** `_maybeUploadEncryptedDmFile` was always wrapping uploads in an `e2e-file:` marker (download attachment); image types including SVG now use the `e2e-img:` marker so they decrypt and render inline. Also, SVGs and other images are no longer sent immediately when selected or pasted in regular channels — they now go through the same preview queue as raster images, giving users a chance to review before sending.

---

## [3.10.13] — 2026-04-30

### Added
- **Role Management: "Members" button** lets admins assign or remove a role directly from the role detail panel, without having to navigate to member management. Opens a searchable member list showing who currently holds the role, with Assign / Remove toggles per member. Server-wide only; channel-specific role config is still in the Role Assignment menu.
- **#5248: Client-side DM search.** Searching inside a DM now runs locally against the cached message history for instant results, falling back to the server for older messages not yet loaded.

### Fixed
- **Voice speaking indicator stops illuminating after a while in VC.** The self-speaking highlight was driven by the server echoing `voice-speaking` back to the sender. If the sender's socket ever briefly lost its `voice:channel` room membership (e.g. during a reconnect grace-period window), the echo never arrived — and because `wasTalking` was already `true`, no new event was emitted until the next pause. The fix changes the self-indicator to use the local mic analyser directly, so it is driven purely by real-time mic level and is not affected by socket room state. Other users still see your talking indicator via the server relay, which is unchanged.
- **Voice: desktop app memory monitor could hard-reload the page mid-call** (visible every ~2 minutes during screen sharing). When screen sharing, RAM easily climbed above the previous 512 MB threshold, triggering a hard page reload. The threshold is now raised to 1536 MB, the soft-trim warning threshold to 500 MB, and the reload cooldown to 5 minutes. If the user is currently in voice or screen sharing the hard reload is skipped entirely regardless of memory level.
- **Voice: temp-voice channel deleted during a brief socket disconnect kicked users back to the welcome screen.** `handleVoiceLeave` now uses an 8-second grace period on socket disconnect before removing an empty temp channel. If the user reconnects within that window the deletion is cancelled. Intentional `voice-leave` events still clean up immediately.
- **Server `pingTimeout` raised from 30 s to 60 s** to give the Socket.IO heartbeat more slack during bandwidth-heavy screen-sharing sessions.
- **Channel category collapse state not persisting after server restart.** The localStorage key included the raw category name casing; if channels came back in different order after restart the key would not match. The key is now always lowercase.
- **#5309: SVG files sent in chat showed as a filename row, not as an image (PR #5314).** `_isImageUrl` and the E2E `e2e-img:` matcher now accept `.svg` / `image/svg+xml`. The static `/uploads` middleware gives SVGs appropriate CORS headers while keeping `Content-Disposition: attachment` for direct navigation and adding a strict CSP to block script execution inside the SVG.
- **#5324: Images pasted into the DM PiP were sent as download attachments instead of rendering inline.** Pasting into the PiP now uses the E2E-aware `_uploadImage` path for raster images.
- **#5325: Missing CSS for the burn-after-read feature.**
- **PiP DM: slash commands now processed before sending** (previously sent as literal text).
- **PiP DM message deletion** now correctly passes the channel code to the server.
- **Confirm modal sizing:** non-resizable, tighter layout.
- **Duplicate role button** now uses the themed prompt modal instead of `window.prompt`.

---

## [3.10.12] — 2026-04-30

### Added
- **#5282: Orphan-DM watchdog.** When one or both participants of a DM delete their account (or get force-removed), the `channel_members` rows vanish via `ON DELETE CASCADE` but the DM channel itself was left lingering with stale messages forever. The auto-cleanup routine now sweeps `is_dm=1` channels with member count below 2, moves their `/uploads/...` attachments into `deleted-attachments/`, and `DELETE`s the channel. Runs unconditionally — `cleanup_enabled` only gates message-age expiry.
- **#5255: PTT recorder accepts lone modifiers, extra mouse buttons, and a hold/toggle mode select.** Settings → Shortcuts → PTT (Haven Desktop only). Lone modifiers (just Alt / Ctrl / Shift) now commit on keyup if no other key was pressed — useful while gaming so PTT doesn't pull a hand off WASD. A new `mousedown` listener captures buttons 3+ (Mouse4 / Mouse5); left/middle/right pass through unchanged. The hardcoded "(toggle)" label is replaced with a hold/toggle `<select>` saved via `havenDesktop.shortcuts.setConfig({ pttMode })` (default `hold`). OS-level registration of bare modifiers/mouse buttons is a follow-up in Haven-Desktop; older desktop builds get an informative toast instead of a generic "in use" error.

### Fixed
- **#5310 + #5308: DM uploads were only encrypted for images going through the explicit "queue → preview → send" path.** Drag-and-drop, the 📎 button, paste in the main composer (for non-image files), and any paste into the DM PiP all routed through `_uploadGeneralFile`, which had no E2E branch — so non-image files in DMs (and any file pasted into the PiP) hit the server filesystem in plaintext, defeating the DM's E2E guarantee. `_uploadGeneralFile` now first calls `_maybeUploadEncryptedDmFile`: if the channel is an E2E DM with a known partner key, the file's bytes go through `e2e.encryptBytes` → opaque blob upload → and the metadata (mime / size / url / name) is wrapped in a new `e2e-file:{json}` marker that's encrypted as a normal text message. `_formatContent` renders that marker as a 🔒 download row, and a new `_decryptE2EFiles` (called next to `_decryptE2EImages` in every render path) wires the click → fetch → `e2e.decryptBytes` → save-as flow. Server-side static `/uploads` handler is unchanged — encrypted blobs are already opaque.
- **#5311: Collapsed sub-channel tag rows didn't show an unread indicator.** Categories and parent channels already bubble a count badge when collapsed and a "look inside" dot when expanded, but the per-parent tag groupings (e.g. an `Off-topic` tag inside a `Lounge` parent channel) were missing both. `_updateNestedIndicators` now walks `.sub-tag-label` rows and applies the same rules: count bubble when the tag is collapsed and any sub-channel under it has unreads, dot when the tag is expanded with unreads inside. The tag toggle handler also re-runs the indicator pass so the badge appears/disappears immediately on collapse/expand.
- **#5307: Delete confirmations were inconsistent — channel delete used the browser's native double-`confirm()` "web info box" while role/DM/message deletes used the themed modal.** All user-data delete actions (channel, role, user, account) now route through the themed `_showConfirmModal`. The two chained channel-delete prompts are merged into one modal with both the warning and finality copy. The themed modal also picks a smarter default button label: when `danger: true` and no `confirmLabel` is supplied, the OK button now reads "Delete" instead of "Confirm".
- **#5323: Large streaming sessions (50+ users joining around the same time) could trigger the auth rate limiter, blocking login with "Too many attempts".** The `authLimiter` was applied globally to every `/api/auth` route, including lightweight token-validation GETs that fire on every page load. Non-credential routes (`/validate`, `/user-servers`, `/totp/status`, etc.) no longer hit the limiter — it now only covers the routes that actually accept passwords or 2FA codes (login, register, TOTP validate/setup/disable, change-password, verify-password, and recovery flows).
- **Slash command autocomplete: pressing Enter when the dropdown is open now selects the active suggestion** (previously only Tab worked, causing partial commands like `/sh` to be sent as literal text in DMs where the server can't transform unrecognized commands).

---

## [3.10.11] — 2026-04-28

### Fixed
- **Other people's voice cutting out the moment you start sharing your screen.** The peer's voice track was being misclassified as screen-share audio after a renegotiation handed it a fresh stream id. Voice routing now consults the server-signaled `screenSharers` set (plus the actual presence of video tracks on the same stream) instead of guessing from stream-id changes, and updates the tracked voice stream id on every reneg so it doesn't pin to the very first one forever.
- **Mobile peers' camera / screen-share indicator only appearing after you yourself shared.** The user list re-render hooks were wired up for webcam start/stop but not for screen-share start/stop or the late-joiner `active-screen-sharers` snapshot, so the icon next to a sharer's name only refreshed when something else (typically you sharing too) forced a re-render. The screen-share events now trigger the same re-render path, and the user list also falls back on the live `screenSharers` signal if the server-side streams payload hasn't refreshed yet.

---

## [3.10.10] — 2026-04-28

### Changed
- **📌 pin icon dot is now a read-receipt.** Previously the dot lit up whenever a channel had any pinned message at all, so it was on permanently and gave you no signal. Now it only appears when there are unread pins: dot persists until you open the pinned panel once, and any newly-pinned message after that re-lights it. Per-channel state is persisted to localStorage.

---

## [3.10.9] — 2026-04-28

### Fixed
- **DM unread that kept coming back — even an hour after opening the message in PiP.** Opening a DM via the floating PiP panel cleared the badge locally but never told the server, so the very next `channels-list` snapshot (sent for any number of unrelated reasons — a peer joining voice, a role change, etc.) re-seeded the unread count from the stale server-side `read_position` and the dot kept popping back, re-firing OS notifications for messages already read.  PiP open now emits `mark-read` against the channel's known latest message id, and inbound messages into a visible PiP DM also emit synchronously instead of going through the shared 500 ms debounced timer (which was getting `clearTimeout`'d by any other channel switch).

---

## [3.10.8] — 2026-04-28

### Fixed
- **DM unread badge would not clear even after opening the DM repeatedly.** `_markRead` was debounced through a single `setTimeout` whose handle got cleared by the next channel switch — so a quick glance-then-leave dropped the emit on the floor and the server never recorded the read.  `switchChannel` now emits `mark-read` synchronously against the snapshot's `latestMessageId` (the in-channel scroll handler still uses the debounced path on top, and the server already takes `MAX(last_read, incoming)` so the two can't fight).
- **Win95 theme: dark, doubled-looking horizontal lines between every message group.**  The global `.message-user-sep` border (1 px in `var(--border)`) renders almost-black on Win95's `#bfbfbf` surface and visually pairs with the avatar's 3 px outset highlight to look like a doubled line.  Win95 now overrides the separator colour to `--border-light` (#dfdfdf) and tightens the spacing so it matches the subtler look of every other theme.
- **Donor list:** added AlexT.

---

## [3.10.7] — 2026-04-28

### Fixed
- **DMs (and any channel) staying unread after they were clearly viewed** — `_markRead` captured `this.currentChannel` lazily *inside* its 500 ms debounce timer. If the user clicked a DM and then switched to another channel within the debounce window (extremely common with quick "did anything new come in?" sweeps), the timer fired with the *new* current channel, so the DM the user actually opened was never marked read on the server. The debounce now snapshots the channel code at call time, mirrors the read state into local `unreadCounts` immediately so badges don't bounce back on the next `channels-list` snapshot, and `switchChannel` also fires an immediate mark-read against the server-supplied `latestMessageId` for the channel being entered — so even an empty render or one that happens after the user has navigated away no longer leaves the DM stuck with a phantom "1".
- **Win95 message group dividers looked buggy and inconsistent** — the previous attempt put a 1px `#c8c8c8` top-border on `.message + .message > .message-row:first-child`, but the selector only matched two adjacent group-leaders (it never matched `.message-compact → .message`), so the line appeared in some places and not others depending on whether the previous author's burst ended with a single message or a follow-up.  The Win95 theme already separates groups with the avatar bevel and author colour change; the extra divider is removed entirely.

### Desktop
- **Server-icon unread dots not lighting up for messages from a different/background server** — `notification-badge` used strict `webContents` identity to figure out which server the signal came from.  After a renderer reload (transient navigation, crash recovery), that identity changes and the lookup silently fails — the per-server map never gets updated, so no dot appears on any other view's sidebar.  Sender lookup now falls back to URL-match via `e.sender.getURL()`, and the badge map is broadcast to **every** open BrowserView (not just the currently-active one), so every sidebar updates its dots in real time.  Same fallback applies to the `report-known-server-urls` listener so background views' filter sets don't get lost on reload either.

---

---

## [3.10.6] — 2026-04-28

### Fixed
- **Win95 theme "dark sections" bug** — the welcome screen and right members panel could render near-black under the win95 theme while the explicitly-styled left sidebar and channel header still looked correct. Root cause was a stale inline CSS custom property (e.g. `--bg-primary`) left on `:root` from a prior `custom`/`rgb` theme session that wasn't cleared before the user landed on win95, so any surface relying on `var(--bg-primary)` inherited the dark colour. `theme-init.js` now strips known custom-theme inline vars from `:root` on load whenever the saved theme is not `custom` or `rgb`, and the win95 stylesheet now explicitly paints body, message area, messages, welcome screen, members panel and sidebar sections with `#bfbfbf !important` so even an exotic var leak can't paint them dark.
- **Win95 message dividers were too distracting** (Amnibro feedback) — the per-row `#808080` border between every consecutive line in a message group was removed; dividers now appear only between message *groups* (the boundary between one author's burst and the next) as a subtle 1px `#c8c8c8` top-border with a small spacer.
- **#5304: Multi-tier nested markdown lists** — the message renderer's old flat regex coalesced any indented `- ` or `1.` line into a single top-level list. The renderer is now a small stack-based parser that tracks `{ ordered, depth }` and produces correctly nested `<ul>`/`<ol>` trees. 2 spaces (or 1 tab) per level; mixed `-`, `*`, `+` and `N.` markers at different depths are supported.
- **#5267: "Update Now" button in admin Update panel was silently inert under Docker** — it now stays enabled regardless of install method. Click re-runs the update check, and for non-runnable methods (Docker, manual) the result modal renders the upgrade command in a code block with a Copy button (and a toast confirms when there's nothing to do).
- **YouTube embeds now recognise live, `/v/` and `gaming.youtube.com` URLs** — previously only the canonical `watch?v=` and `youtu.be/` forms produced a player; livestream links pasted from a phone share sheet now embed correctly.

### Docs
- **#5230: README now calls out the `HAVEN_DATA_DIR` pitfall when running under systemd** — services launched under systemd typically don't inherit the user's interactive `HAVEN_DATA_DIR`, so Haven defaults to `/root/.haven` and silently "loses" your existing data. The Data Directory table now points at the unit-file `Environment=` line as the supported way to make the variable visible to the service.
- **Donor list refreshed** — added ColKlink and Brian "TGS" Gilliford. Thank you both!

---

## [3.10.5] — 2026-04-28

### Fixed
- **#5301: Quick reaction picker and customize-quick-reactions panel were missing emoji name tooltips** — the full emoji picker already showed a name on hover, but the small quick-react row above it (and the slot buttons in the customize panel) didn't, so users had to guess what an unfamiliar emoji was called. Both surfaces now show the emoji name on hover, with custom emojis showing their `:name:` form.
- **#5297: Several slash commands still didn't work in DMs** after the recent const→let fix. The end-to-end DM path only re-implemented six commands client-side (spoiler, shrug, tableflip, unflip, lenny, me); commands like `/disapprove`, `/brb`, `/afk`, `/flip`, `/roll`, `/hug`, `/wave`, `/bbs`, `/boobs`, `/butt` would either show as a literal slash command or get rejected. The client now mirrors the full server-side command map for DMs so they all behave the same as in normal channels.
- **#5299: DM attachment cleanup didn't fire when the *other* member of the DM deleted the message, or when the entire DM was deleted.** Server-side `delete-message` now accepts the client-supplied attachment list for any DM (not just for the original author), so a recipient with delete permission cleans up the file properly. Server-side `delete-dm` now scans every plaintext message in the DM for `/uploads/...` URLs, accepts a list of decrypted URLs from the client for E2E messages, and moves all of them to `deleted-attachments/` before dropping the DM rows.

### Added
- **Themed confirm modal helper** so message-action confirms (delete message, pin message, delete DM) no longer show a Windows-styled native popup in Haven Desktop. They now use the same in-app `.modal-overlay` styling as the rest of Haven so they pick up your theme. Other admin/settings confirms still use the native dialog for now and will migrate over time.
- **Nested-unread "look inside" indicator** on category labels and on parent channels with sub-channels. When a section is expanded but contains an unread channel below the fold, a small accent-colored dot appears on the parent header so it's easier to spot in long sidebars without collapsing everything. The dot is intentionally distinct from the regular count bubble (which still appears when the section is collapsed).

---

## [3.10.4] — 2026-04-27

### Fixed
- **Self-DM ("Notes to self") sometimes wouldn't open the picture-in-picture panel** — reported by SerChiz. The PiP would show a loading state forever (or appear not to open at all) in specific edge cases: when the same DM was already the user's active main channel, when the local end-to-end key cache was missing the user's own key for self-DMs, or when the partner key fetch silently stalled. The PiP now (a) renders message history regardless of which channel is currently focused, (b) seeds the partner key for self-DMs from the local E2E key directly without a server round-trip, and (c) replaces the "Loading…" placeholder with a friendly fallback after 6 seconds so the panel never appears stuck.
- **DM picture-in-picture didn't actively clear unread for the DM open in the panel** — new messages arriving for the active PiP DM now mark the DM as read (and clear its unread badge) instead of bumping the unread count, so the badge no longer sticks while you're already reading the conversation.

---

## [3.10.3] — 2026-04-27

### Added
- **`#channel` autocomplete in the message composer** — typing `#` while composing now opens a live channel picker, matching the existing `@` and `:emoji:` autocompletes. Underscores in channel names are handled correctly so the inserted link works as soon as it lands in the input.

### Fixed
- **DM picture-in-picture panel hidden behind the input action bar** — the PiP panel's z-index was lower than the chat input's action buttons, so on some layouts the bottom of the panel was clipped. Bumped the PiP z-index above the input row.
- **Inviting a user to a channel showed a red error toast even on success** — the invite handler reused the error-toast style for its confirmation. Successful invites now produce a normal green success toast.
- **DM attachments orphaned on disk after delete** — deleting an end-to-end-encrypted DM message now also removes its uploaded attachment files instead of leaving them sitting in the uploads folder.
- **Server admins couldn't toggle the auto-backup settings from the UI** — the `update-server-setting` handler's allow-list was missing the `auto_backup_*` keys, so toggling them silently no-op'd. Whitelisted them.
- **Mobile: sidebar stayed open after tapping a DM** — opening a DM from the sidebar list now collapses the sidebar automatically, matching channel-tap behavior.
- **Mobile: modal expand and close buttons drifted out of alignment** — the two corner buttons in list-heavy modals are now aligned on small screens.
- **Voice: self-talking highlight didn't survive a left-sidebar re-render** — your own avatar's "talking" outline now persists locally and is reapplied whenever the sidebar redraws, instead of dropping for a frame.
- **Voice: regression where the local talk highlight was always on for everyone** — the always-on local highlight added in 3.10.2 was reverted; it is now gated behind a Debug-section toggle and defaults off, so the server echo continues to drive the indicator for almost everyone.
- **Settings: Force SDR toggle showed up in the web client** — the Force SDR (sRGB) preference is desktop-only and is now hidden when running outside Haven Desktop. It also moved to the Debug section, where the rest of the related toggles live.

---

## [3.10.2] — 2026-04-26

### Added
- **Pinned-message indicator** — the 📌 button in the channel header now shows a small accent-colored dot when the active channel has at least one pinned message, so you can tell at a glance without opening the panel. Updates live as messages get pinned and unpinned.

### Fixed
- **Server settings categories missing for non-admin server managers** — users with the `manage_server` permission (but not full admin) were missing every category they used to see in Settings → Admin. The category nav was looking for a `section-server` element that doesn't exist anymore, so nothing got unhidden. `manage_server` now reveals the full set of server-management categories (branding, members, whitelist, invite, cleanup, backup, limits, tunnel, bots, import, mod mode).
- **Inconsistent ordering between a message and its attachment** — when a message and its attachment share the same `created_at` timestamp (within the same second), the order they rendered in flipped depending on which scroll direction loaded them. Message queries now use `m.id` as a stable secondary sort key, so the attachment always stays on the same side of its caption.
- **Desktop crash on launch when a saved server's hostname stops resolving** — the new transient-error retry loop dereferenced `view.webContents` after the background pre-load view had already been destroyed, throwing `TypeError: Cannot read properties of undefined (reading 'isDestroyed')`. The retry now bails out cleanly if the view is gone, and background pre-load views never retry (those are best-effort and were already cleaned up silently).

---

## [3.10.1] — 2026-04-26

### Added
- **`@everyone` and `@here` mentions** — typing `@everyone` or `@here` now produces a real highlighted mention that pings every member of the channel (subject to the existing `mention_everyone` permission). Both options also appear in the `@`-autocomplete dropdown when you have permission. Senders without the permission have the trigger silently neutralized server-side, so they can't bypass it.
- **`#channel-name` autolinks** — typing `#general` (or any channel name) inside a message now turns into a clickable channel link that switches to that channel. Names are matched case-insensitively against the channels you can see.
- **Duplicate Role button** — the role editor now has a "📋 Duplicate" button next to "Delete". Prompts for a new name, then clones the source role's level, color, icon, and permissions. Auto-assign and channel-access linkage are intentionally not copied (they're rarely correct on a fresh clone).

### Fixed
- **Voice chat: occasional one-way audio when joining an existing call** — ICE candidates that arrived before the remote SDP description was set were being silently dropped, causing the connection to never finish negotiating media in one direction. Candidates are now buffered per-peer and flushed after `setRemoteDescription`, so cold-joining a call no longer ends in "I can see his mic light up but can't hear him".
- **DM picture-in-picture: first-message vs reply indentation mismatch** — the first message in a group still had its avatar gutter inherited from the main chat layout, so it sat 8 px to the right of compact follow-ups. PiP message rows now zero out their horizontal padding and the message body's left padding, so every line in the PiP aligns identically.
- **DM picture-in-picture: clicking an emoji in the reaction picker did nothing** — the `add-reaction` / `remove-reaction` server handlers looked up the channel from `socket.currentChannel` (the channel showing in the *main* pane), but the PiP can be opened over an unrelated channel. The lookup now uses the message's actual channel, and reactions inside the PiP are saved correctly.
- **Threads: web users seeing "X replies" but no messages, and reply box discarding sends** — same root cause. `get-thread-messages` and `send-thread-message` were also keying off `socket.currentChannel`, which gets stale if the user navigates away while a thread panel is still open. Both now resolve the channel from the parent message itself.
- **Desktop: server restart kicked users back to "Host or Join"** — a single transient `did-fail-load` (e.g. CONNECTION_REFUSED during the brief restart window) was enough to dump users back to the welcome screen. The desktop now retries up to 6 times with exponential back-off on transient errors before giving up.

---

## [3.10.0] — 2026-04-25

### Added
- **Drag-and-drop server reordering in the sidebar** — remote Haven servers in the left rail can now be reordered by dragging, just like channels. The new order persists locally and syncs across your devices via the same encrypted bundle the sidebar already uses.
- **`View Audit Log` permission** — the audit log is no longer admin-only. Any role with the new `View Audit Log` permission can open Settings → Admin → Audit Log and read the record (no other admin powers required).

### Fixed
- **Tag category headers in the Organize modal didn't actually reorder when dropped** — the per-tag sort dropdown inside each header was swallowing drag events on some browsers, so dragging looked like it worked but nothing moved. Switched to event delegation on the list container so dragover/drop fire reliably.

---

## [3.9.0] — 2026-04-25

### Added
- **Drag-and-drop tag categories in the Organize modal** — category headers in the Organize Sub-channels / Channels modal can now be reordered by dragging, mirroring how channels and sub-channels are already reordered. The new order persists to localStorage and (for server-level reorders by admins) syncs to all members through server settings.
- **Audit Log** — a new admin/moderator-visible record of significant server actions: server settings changes, channel create/delete/rename, role create/update/delete, role assign/revoke, member kicks, bans, unbans, mutes, unmutes, and display-name renames. Open it from Settings → Admin → Audit Log. Includes filtering by action type and actor, paginated loading, and a JSON export button.
- **Modal expand and close controls** — list-heavy modals now show top-right expand and close buttons even when the modal heading is wrapped in a flex container (previously the auto-injected controls were misplaced or hidden on those modals).

### Changed
- **Resizable list modals fill their available space** — the Organize, Banned Users, and Deleted Users modals no longer waste vertical space when resized; the inner list grows to fill the modal height. Other list-style modals can opt in by wrapping their body in a `modal-flex-body` container.

### Fixed
- **Sidebar lagging behind the Organize modal for sub-channel category moves** — moving a category up or down inside a sub-channel Organize modal now refreshes the sidebar immediately. Previously the sidebar only re-rendered for server-level category moves, leaving sub-channel order out of sync until the next render.
- **Sub-channel "Untagged" group order not persisting** — the saved category order now uses the same `__untagged__` placeholder that the Organize modal reads on next open, so dragging the Untagged group around no longer silently resets on reload.

---

## [3.8.0] — 2026-04-23

### Added
- **DM Picture-in-Picture panel** — DMs can now be opened in a floating PiP panel with full-fidelity message rendering (markdown tables, images, reactions, reply context), E2E message decryption, thread-parent context, and a channel picker for switching conversations without leaving the current view.
- **Backup option to include or exclude DMs** — the backup export now includes a toggle to opt DMs in or out of the backup. (#5277)
- **Configurable purge-on-ban** — admins can choose whether banning a member also purges their messages, and customize the placeholder text shown in place of purged messages. (#5279)
- **Server name and icon in browser tab** — the document title and favicon now reflect the currently active server name and icon. (#5284)

### Fixed
- **DM PiP E2E messages showing raw ciphertext** — encrypted DM messages in the PiP panel now decrypt correctly using the existing E2E key exchange.
- **Thread mention notifications not loading** — bumped module cache versions so mention pills inside thread notification toasts resolve correctly.
- **Message input auto-focusing on touch devices** — the message input no longer grabs focus automatically on touch/mobile, preventing the on-screen keyboard from popping up unexpectedly. (#5285)
- **Phantom channel unread count from thread replies** — `get-messages` filters out thread reply messages (`thread_id IS NOT NULL`) so they only render in the thread panel, but the per-channel `unreadCount` query in `channels-list` did not. Result: thread replies got counted as channel unreads, the user could never scroll past them to mark them read, and the channel badge stayed stuck (e.g. a persistent "5" on a channel that visibly had nothing new). The unread count, latest-id, and `mark-read-channel` queries now all exclude thread replies so channel-level read state is computed against the same set of messages the channel actually displays.
- **Phantom desktop taskbar badge with no in-app indicator** — background-preloaded server `BrowserView`s were reporting unreads to the main process for servers the active view's sidebar had no icon for. The taskbar lit up but no channel/DM/server-icon dot rendered anywhere visible. Each renderer now reports the set of server URLs its sidebar can display; main filters the taskbar overlay so a badge only fires when at least one open view can actually surface that server's unreads. (#5269)
- **Auto-backup admin endpoints returning 404** — the `/api/admin/auto-backups*` and `/api/admin/update/*` routes were registered after the catch-all 404 handler, so Express never reached them. Moved the catch-all (and the global error handler) to the very end of the route table so all admin endpoints resolve. (#5268)
- **Server unread-dot not lighting up in the desktop sidebar** — the main process keys per-server badge state by a normalized URL (no trailing slash, no `/app.html`), but the sidebar lookup used the raw user-entered URL, so the dot rarely matched. The renderer now normalizes both sides before comparing.
- **Channel marked as read while its server view is in the background** — when a backgrounded server's `currentChannel` received a message, the renderer was clearing its unread count as if the user were actively reading it. Now we only auto-clear when `document.hidden` is false, so background servers correctly accrue unreads (and surface them in the sidebar dot + taskbar badge).
- **Random `@text` rendering as a real mention** — the message renderer was styling any `@word` it found, even if it didn't match anyone on the server. Now only login names and display names that actually belong to a channel member (or the current user) get the mention pill; everything else stays as plain text. (#5273)
- **First-load mentions showing login names instead of display names** — on the very first channel render the member list often hadn't arrived yet, so `@loginname` rendered as the raw login. Switching channels then re-rendered with display names. The renderer now refreshes the current message list as soon as members arrive, so display names show on the first render too. (#5273)
- **Members modal channel counts inflated by DMs and stale rows** — the per-member channel counters in the Members modal were counting DM threads and old `channel_members` rows for channels that no longer exist. The count now joins the `channels` table and filters to non-DM channels only, so the number matches what each member actually sees in the sidebar.
- **Empty temporary voice channels lingering after everyone left** — when a non-admin was the last to leave a temp voice channel, the on-leave cleanup occasionally missed the room (abrupt disconnects, a reconnecting socket re-binding the entry, etc.) and the channel sat there until its 24h expiry. Added a 60-second safety-net sweep that prunes empty `is_temp_voice` channels regardless of who emptied them.

---

## [3.7.0] — 2026-04-22

### Added
- **Scheduled auto-backups** — admins can configure automatic server backups on a schedule (daily, weekly, etc.) directly from the Admin panel. (#5268)
- **In-app update check** — Haven now checks for new releases and shows a banner in the Admin panel when an update is available. (#5267)
- **Add all server members to channel** — channel creation now includes an option to add all existing server members at once. (#5271)
- **@mentions for usernames with spaces** — display names and usernames containing spaces can now be @mentioned correctly. (#5273)
- **Desktop → web client server list bootstrap** — the web client now inherits the server list from Haven Desktop on first load, so servers added in the desktop app appear automatically.

### Fixed
- **Mention display-name dedup** — server-side deduplication prevents duplicate display names in mention autocomplete; autocomplete inserts the login name when a display name differs so mentions resolve correctly. (#5273)
- **Server unread dot desktop-only** — the server unread indicator dot is now only rendered in the Desktop app, where it makes sense. (#5269)
- **Mobile responsive layout** — fixed several layout regressions on mobile viewports. (#5272, #5274)

---

## [3.6.0] — 2026-04-21

### Added
- **Channel and message deep links** — right-click any channel or DM to copy a shareable deep link. The message toolbar gains a copy-link button that jumps directly to the message after navigating. Links survive login via sessionStorage handoff (same pattern as invite codes).
- **Admin remote backup and restore** — the Admin settings tab now includes a Backup section with configurable export checkboxes (channels/roles, users, server settings, messages, uploaded files) and a restore upload field. Restore stages the data and exits so a supervisor (Docker, systemd, installer service) restarts Haven; the previous DB and uploads are preserved as `.pre-restore` copies for one cycle.

### Fixed
- **Server icon URL cache-busting** — server icon URLs are now cache-busted to bypass stale entries left over from before cross-origin support was added. (#5240)
- **Server list subpath URL preservation** — subpath-based server URLs (e.g. `https://host/community`) are now correctly preserved during normalization instead of being stripped to the origin.
- **SSO consent validate timeout** — tightened the SSO validate request to 4 seconds (watchdog at 5s) with fallback to the cached profile, preventing consent screens from getting stuck when validation is slow.

### Security
- **Cross-Origin-Resource-Policy and Vary headers** — image and health endpoints now return `Cross-Origin-Resource-Policy: cross-origin` and `Vary: Origin` to support cross-server icon loading without CORS errors.

---

## [3.5.0] — 2026-04-20

### Added
- **Threaded replies panel** — message threads now open in a dedicated right-side panel with parent context, inline reply flow, and live updates.
- **Thread previews in channel chat** — parent messages now show thread activity summaries with reply count, recent participants, and last activity timestamp.
- **Thread panel PiP mode and resize handle** — thread conversations can be popped out into a floating panel and resized for multitasking.
- **Toolbar icon and layout customization** — settings now include monochrome vs emoji toolbar styles, visible action slot count, and per-action order controls.

### Fixed
- **SSO approval reliability and feedback** — improved SSO consent/auth flow with clearer status messages, timeout handling, profile return via `postMessage`, and stronger fallback behavior.
- **Vanity invite continuity through auth redirects** — `invite` query params now persist through login/register flows and redirect correctly into `/app`.
- **Thread-aware message queries** — primary channel history now excludes thread replies to prevent duplicate rendering and keep main timelines clean.
- **Cache-busting version query injection** — static asset version query strings are now auto-injected more reliably to reduce stale client bundles after updates.

### Changed
- **SSO response metadata** — SSO auth responses now include display name data and stricter CORS/origin handling for cross-origin auth handoff.
- **Database schema for threads** — added `messages.thread_id` migration and index to support efficient threaded message fetches.

---

## [3.4.0] — 2026-04-19

### Added
- **Quote button** — a quote button in the message toolbar inserts a formatted quote of the selected message into the input box.
- **Up-arrow to edit last message** — pressing up in an empty message input opens the last message you sent for editing. Toggleable in Settings.
- **Bot API: delete messages & play soundboard sounds** — bots can now delete messages and trigger soundboard sound playback via the API.
- **SSO recent-servers dropdown** — the SSO "Link a Server" page now shows a dropdown of recently visited servers for quick selection.

### Fixed
- **Event sounds decoupled from notifications toggle** — join/leave sounds now play regardless of whether the master notifications toggle is off. (#5264)
- **Server icon cross-origin loading** — server icons fetched from external origins now include the correct `crossorigin` attribute, preventing CORS errors. (#5240)
- **Server list hides current server reliably** — the server list sidebar now uses the server fingerprint to identify and hide the host server, fixing cases where it appeared in its own list.
- **Server list removals persist** — manually removed servers are now normalized by origin and persist across syncs; the Desktop bridge also respects removals.
- **Server list sync on page refresh / auto-login** — the encrypted server list now syncs correctly when the page reloads or the user auto-logs in.
- **SSO consent page "Checking login status..."** — the SSO consent page no longer gets stuck in a loading state after a session is already established.
- **Desktop app promo skipped on mobile/tablet** — the desktop app promotional modal no longer appears on mobile or tablet devices.
- **Stale socket evicting active voice users** — a stale socket reconnect no longer incorrectly removes an active user from a voice channel.

### Security
- **Reply-to channel boundary validation** — the server now validates that a reply target belongs to the same channel, preventing cross-channel reply injection.
- **WebRTC payload size limits** — enforced maximum payload sizes on WebRTC data channel messages to limit potential abuse.

---

## [3.3.0] — 2026-04-18

### Added
- **Last read message indicator** — a subtle divider marks where you left off when you return to a channel. (#5259)
- **Per-event volume sliders** — separate volume controls for join and leave notification sounds in User Settings.
- **Server-list sync improvements** — the encrypted server list now resyncs periodically and on tab focus, so your server list stays current across devices without a full reload.

### Fixed
- **iOS Safari safe-area overlap** — additional safe-area inset fixes on mobile Safari preventing content from being clipped by notches and home indicator.
- **CSP upgrade-insecure-requests with FORCE_HTTP** — the Content Security Policy no longer forces HTTPS upgrades when `FORCE_HTTP=true` is set, which was breaking HTTP-only installs. (#5258)
- **Duplicate voice joins** — properly cleans up stale state from a race condition where rapidly clicking join could register a client twice in the same voice channel. (#5247)
- **Case-insensitive channel tag grouping** — channel tags are now matched case-insensitively, so `[General]` and `[general]` are treated as the same group. (#5260)
- **E2E backup clobber prevention** — the encryption backup flow now correctly distinguishes between "no backup exists" and "backup server unreachable," preventing a reachability failure from overwriting a valid backup. (#5261)

---

## [3.2.0] — 2026-04-16

### Added
- **Mark as Read context menu** — right-click a channel or DM to mark it as read. The option only appears when the channel has unread messages. Clears the unread badge and updates the server-side read position.

### Fixed
- **Pinned message jump** — clicking a pinned message now correctly scrolls to and highlights it even when the message has been trimmed from the DOM (more than 100 messages back). Previously this would silently fail.
- **iOS Safari mobile issues** — fixed double-tap zoom, scroll momentum, safe area insets, emoji picker positioning, and status picker rendering on Safari iOS.
- **Promo modal dismiss** — clicking the overlay to close a promotional modal now correctly respects the "Don't show again" checkbox. (#5257)

---

## [3.1.1] — 2026-04-15

### Added
- **Status bar toggle tab** — a small `📊` tab appears in the bottom-right corner when the status bar is hidden, providing an obvious one-click way to reveal it.
- **Server URL in status bar** — the status bar now displays the server address with click-to-copy functionality. A privacy toggle lets you hide/show the URL (useful for streamers). Copying works even when the address is hidden.

### Changed
- **Status bar default** — the status bar (debug footer) is now **hidden by default** on web/mobile. Users can enable it from Settings → Layout or by clicking the toggle tab. Desktop app behavior is unchanged.
- **Banner display settings** — banner height, vertical offset, and header style settings are now stored client-side (per-user preference) instead of server-side, so each user can customize their own view.

### Fixed
- **Mobile image overlap** — images in chat messages no longer overlap with adjacent messages on mobile devices. Root cause: flex items in the message list could shrink below their content height; now prevented with `flex-shrink: 0`.
- **Mobile reply banner overflow** — reply banners on mobile now wrap properly instead of overflowing off-screen.
- **Mobile message text overflow** — long words and URLs in messages now break correctly on mobile instead of overflowing horizontally.
- **Status bar hidden on mobile** — the status bar was previously force-hidden via CSS on tablets and phones; it now respects the user's setting and condenses non-critical items at smaller breakpoints instead of disappearing entirely.

---

## [3.1.0] — 2026-04-14

### Added
- **Server banners** — servers can now have a banner image displayed at the top of the chat area. Includes overlay and non-overlay display modes, a header style dropdown with four options (Transparent, Tinted, Solid, Full), height and vertical offset sliders, and gradient fade for a polished look.
- **Server icon sync** — server icon thumbnails are now included in the encrypted sync bundle so server icons persist across devices. (#5240)

### Fixed
- **Role icon upload** — fixed role icon upload (field name mismatch and response handling) and added auto-resize to 16x16 for consistency.
- **E2E encrypted notification content** — push and browser notifications for end-to-end encrypted messages now show generic placeholder text instead of raw JSON envelopes. (#5256)
- **Safari iOS layout** — fixed safe-area insets, keyboard overlap, and navigation dot positioning on Safari iOS.
- **Delete-user transaction safety** — added guards for non-existent tables in delete-user database transactions to prevent errors on fresh installs. (#5252)

---

## [3.0.0] — 2026-04-14

### Added
- **SSO registration (Link Server)** — users can register on a new Haven server using their identity from another Haven server. The "Link Server" tab on the auth page walks through a two-step flow: connect to your home server, approve the identity share, then set a local password. Username and profile picture are imported; E2E encryption is preserved since a password is still required on every server. Server-side includes consent page, auth code approval, authenticate endpoints, CORS handling, rate limiting (5 req/min/IP), and secure avatar download with magic-byte validation.
- **Advanced search filters** — search now supports `from:username`, `in:#channel`, and `has:image/file/link/video` filters. Filter tags render as badges in the search bar.
- **Reply notifications** — replies to your messages now trigger a distinct notification sound with separate volume control, configurable in User Settings.
- **Settings tab reorganization** — the settings panel is now split into User and Admin tabs with a tab bar for cleaner navigation.
- **Running Multiple Servers** — new README section documenting how to run multiple Haven instances on the same machine.

### Changed
- **Reply banner redesign** — reply indicators now use a compact pill-style design placed inside the message body instead of above it.
- **Emoji picker expansion** — expanded food, activities, and objects categories in the emoji picker.
- **Search bar** — wider input field and visual filter tag badges.

### Fixed
- **Ordered list renumbering** — messages starting with `2.` or `3.` (etc.) no longer render as `1.` when sent as separate messages. The original number is now preserved via the HTML `start` attribute.
- **YouTube seek slider alignment** — the progress slider thumb now aligns correctly with the track bar. (#5250)
- **Jump-to-message for search results and replies** — clicking a search result or reply reference now correctly scrolls to and highlights the target message.
- **DM search notice** — search in DMs now shows an appropriate notice when no results are found.
- **Voice double-join guard** — prevented a race condition where rapidly clicking voice join could connect twice.
- **@mention and :emoji autocomplete in edit mode** — autocomplete now works when editing an existing message, not just when composing.
- **Copy image clipboard format** — copying an image from chat now converts to PNG for clipboard compatibility. (#5246)
- **Mobile sidebar padding** — increased bottom padding on mobile sidebar for Android gesture bar clearance.
- **DM sidebar name updates** — DM sidebar now reflects display name changes without requiring a page reload.
- **Donors modal expand button** — excluded the donors modal from the expand/close button injection.
- **Auth page centering** — fixed vertical centering on small screens.
- **Tab-switch scroll position** — switching tabs while browsing message history no longer resets scroll position.
- **English flag emoji** — fixed corrupted flag emoji in the language selector.

---

## [2.9.9] — 2026-04-13

### Added
- **Encrypted server list sync** — your server list and ordering now sync across devices via an encrypted key stored on the server. Adding, removing, or reordering servers on one device automatically carries over when you log in elsewhere.
- **Jump-to-bottom button** — a floating button appears when you scroll up in chat, letting you jump back to the newest messages with one click.
- **Emoji picker in edit mode** — the emoji picker is now available when editing a message, not just when composing a new one.
- **`==highlight==` markdown** — wrap text in double equals signs to render it with a highlight background.
- **`/poll` slash command** — create inline polls with `/poll "Question" "Option 1" "Option 2" ...`.

### Changed
- **SVG toolbar icons** — the emoji and poll buttons in the message toolbar now use crisp SVG icons instead of text/emoji characters.
- **Codebase modularization** — the monolithic socket handler has been split into focused domain modules (messages, channels, voice, admin, etc.) for maintainability.

### Fixed
- **DM scroll position** — switching to a DM conversation no longer starts at the wrong scroll position.
- **Send button sizing** — the send button is now a consistent 42×42 px.
- **Lightbox arrow navigation** — left/right arrows in the image lightbox now work correctly.
- **Safari PWA fixes** — various Safari-specific issues in Progressive Web App mode have been addressed.
- **Scroll-to-bottom reliability** — improved auto-scroll when new messages arrive.
- **Add-server dialog centering** — the add server modal is now properly centered.
- **GIF hover preview** — the GIF hover animation now displays correctly.
- **Channel handler module export** — fixed a module export issue introduced during codebase modularization.

---

## [2.9.8] — 2026-04-12

### Added
- **Read-only channels** — admins can now mark any text channel as read-only. Members without the new `Read-Only Override` role permission can still read and react, but the message input is hidden. Useful for announcement-style channels. (#5231)
- **`Read-Only Override` role permission** — grants specific roles the ability to post in read-only channels.
- **Server-relayed mic illumination** — the speaking indicator now reflects what the server actually received rather than local mic detection. If your audio isn't making it to the server, the indicator won't light up, giving a more accurate picture of what others are hearing.
- **Role display picker** — new setting to choose between "Colored Name" (role color applied to the username) or "Dot" (small colored circle next to the name). Applies to both chat messages and the member list.
- **Welcome message** — admins can configure a custom welcome message shown when a user joins a channel. Use `{user}` as a placeholder for the username. Set via Admin Settings; leave blank to disable.
- **Masked link warning** — clicking a markdown link where the display text differs from the URL now shows a confirmation dialog with the real destination before navigating. Helps prevent phishing via disguised links.
- **Admin password reset via `.env`** — set `ADMIN_RESET_PASSWORD=<newpass>` in `.env` and restart. The admin password is updated, any ban/mute on the admin account is cleared, and the variable is automatically removed from `.env` after use.
- **Crash log** — uncaught exceptions, unhandled rejections, and non-zero exits are now written to `crash.log` in the data directory with timestamps and memory stats, surviving even when stdout isn't captured.
- **Event loop lag monitor** — logs a warning when the Node.js event loop is blocked for more than 500 ms, helping diagnose freezes on low-power hardware like Raspberry Pi.

### Changed
- **Role permission row highlight** — checking a permission in the role editor now lights up that entire row with an accent background, making it easier to see which permissions are enabled at a glance.
- **Dynamic memory watchdog threshold** — the memory warning threshold now auto-detects system RAM instead of using a hardcoded 350 MB limit, so Raspberry Pi and other low-memory hosts get appropriate warnings.

### Fixed
- **E2E pinned message decryption** — pinned messages in encrypted DMs are now decrypted before rendering in the pinned panel.
- **Pinned panel stale data** — switching channels now auto-closes the pinned panel so stale pins from the previous channel don't linger.
- **User deletion FK constraint errors** — deleting a user (admin purge or self-delete) now nullifies all non-cascading foreign key references before removing the user row, preventing SQLITE_CONSTRAINT failures.
- **User deletion audit trail** — the `deleted_users` audit record is now inserted inside the same transaction as the purge, so it rolls back cleanly if any step fails.
- **Desktop shortcut recording** — fixed several issues: global hotkey no longer swallows the keystroke while recording a new shortcut, config state updates correctly after setting or clearing a shortcut, and duplicate listener attachment is prevented.

---

## [2.9.7] — 2026-04-09

### Changed
- **Removed Google STUN dependency** — voice/WebRTC now defaults to open-source public STUN servers (`stun.stunprotocol.org` and `stun.nextcloud.com`) instead of Google's. No functional change for end users, just removes the Google dependency for a project built around self-hosting.

### Added
- **`STUN_URLS` environment variable** — server admins can now override the default STUN servers with their own (e.g., a self-hosted coturn instance) for fully self-contained voice with zero external dependencies. Comma-separated list of STUN URIs.

---

## [2.9.6] — 2026-04-07

### Added
- **Custom Terms of Service** — admins can now add custom terms that appear above the default Haven ToS on the login page. Set via a new textarea in Admin Settings. Supports plain text with paragraph breaks, max 50,000 characters. Leave empty to show only the default ToS. (#5229)

### Fixed
- **Unpin message visual bug** — unpinning a message while viewing the pinned messages panel no longer leaves the pin border on the message. The pinned panel item is also removed in real time and the count updates. (#5228)
- **Android app popup "Don't show this again"** — the checkbox now persists correctly across sessions. Previously the v3 migration flag used sessionStorage, causing dismissals to reset on every new session.
- **Android app popup layout** — moved the "NOW AVAILABLE" badge above the title instead of inline, and centered the title text.

---

## [2.9.5] — 2026-04-07

### Changed
- **License changed to AGPL-3.0** — Haven is now licensed under the GNU Affero General Public License v3, a widely recognized open-source license. This replaces the previous custom MIT-NC license. The AGPL ensures that anyone who forks and deploys Haven as a network service must release their source code under the same license, protecting the project from commercial exploitation while being a proper OSI-approved open-source license. Self-hosting, forking, and contributing remain fully encouraged. (#5227, #70)

---

## [2.9.4] — 2026-04-05

### Added
- **Two-way bot webhook callbacks** — bots can now have a Callback URL and optional Callback Secret in the bot settings panel. When a user sends a message in a channel where the bot lives, Haven fires a POST to that URL with event data (message content, author info, channel, timestamp). If a secret is set, the payload is signed with HMAC-SHA256 via an `X-Haven-Signature` header. Webhook messages from the bot itself won't trigger callbacks, preventing loops. (#194)
- **Community server** — added a "Try Haven" link to the website, README, and nav bar pointing to the volunteer-hosted community server at haven.moviethingy.xyz (hosted by MutantRabbit).

---

## [2.9.3] — 2026-04-05

### Changed
- **Android app popup updated for full release** — the in-app Android promotion has been refreshed to reflect that Amni-Haven Android is now a full release on Google Play (no longer a closed beta). The popup links directly to the Play Store listing. Existing users who dismissed the old beta popup will see the new announcement once.
- **Fixed Desktop app naming in README** — the Desktop app is "Haven Desktop", not "Amni-Haven Desktop". Corrected all references. Only the Android app carries the Amni branding (built by Amnibro).
- **Updated donor lists** — added c0urier (sponsor + donor) and deNully (donor).

---

## [2.9.2] — 2026-04-05

### Fixed
- **Per-app audio CSP fix** — Haven's Content Security Policy was missing `blob:` in `script-src`, which caused the Desktop app's AudioWorklet processor to be blocked by the browser on every session. The per-app audio pipeline was silently falling through to the deprecated ScriptProcessor fallback (and still producing no audio for many users). AudioWorklet now loads correctly. (#165)

---

## [2.9.1] — 2026-04-04

### Fixed
- **Sidebar "View All Members" button bypassed permissions** — the 👥 button in the sidebar was visible to all users regardless of the `view_all_members` permission. It's now hidden unless the user is an admin, moderator, or has the `view_all_members` permission. The server also rejects the request outright for unpermissioned users. (#220)

---

## [2.9.0] — 2026-04-02

### Added
- **Temporary voice channels** — users with the new "Create Temporary Channels" permission can create temp voice channels from the sidebar. Everyone on the server sees and can join them. When the last person leaves voice, the channel auto-deletes. There's also a 24-hour safety-net expiry on the off chance nobody ever leaves cleanly. The permission is off by default for all roles. (#163)

### Fixed
- **Voice permission lost when assigning a channel-scoped role server-wide** — assigning a role like Channel Mod across the whole server was wiping the user's existing server-scoped User role, which took away their voice access. The role replace now only removes roles of the same scope, so server roles and channel roles no longer clobber each other. (#195)
- **AFK idle skip reverted** — the previous fix that prevented the idle timer from firing while in voice was too broad. Staying in voice while idle should still count as idle (the AFK auto-move depends on it). The mic speech detection already resets idle status when you're actually talking, so active speakers are unaffected. (#217)

---

## [2.8.9] — 2026-04-01

### Fixed
- **Channel organize button now visible to all users** — the 📋 organize button was incorrectly gated behind admin-only. Any user can now open the organize modal to set their own personal channel sort preference. Admin-only controls (move up/down, tags) are hidden for non-admin users at the server level.
- **Collapsed parent badge no longer clears on click** — clicking a collapsed parent channel (whose badge shows aggregated unread counts from hidden sub-channels) no longer wipes the bubble badge. The badge only goes away once you expand and read the actual sub-channels. (#151)
- **Presence stays green while in voice** — the idle timer no longer fires "away" while you're connected to a voice channel. Whether you're talking or just listening, your presence stays online. The server's AFK auto-move system still handles truly inactive voice users separately.
- **Voice activity pings now also reset away presence** — if the idle timer had already fired before you started talking, speaking into your mic now immediately resets your status back to online for other users.

---

## [2.8.8] — 2026-03-31

### Fixed
- **Voice AFK moves during active speech** — speaking now resets the idle timer and sends voice-activity pings to the server, so you won't get moved to the AFK channel or show as "away" while actively talking. Pings also fire every 15s instead of 30s for better overlap with the server's AFK check interval.
- **Desktop app status bar visibility** — restored display fallback logic, `data-desktop-app` reinforcement, and inline `!important` override to ensure the status bar renders correctly in Electron across all DPI scales.

### Added
- **Video thumbnails** — uploaded videos now auto-generate a poster thumbnail from the first visible frame, so you can see a preview without having to hit play. Thumbnails are generated client-side, cached per URL, and capped at 480p JPEG.

---

## [2.8.7] — 2026-03-30

### Changed
- **Updated donor & sponsor lists** — added HoppyGamers, corrected sponsor/donor categorization, fixed chronological ordering.

---

## [2.8.6] — 2026-03-29

### Fixed
- **Heart/donate button position** — moved the ❤️ button to the right side of the sidebar bottom bar where it was in older versions, after the flex spacer alongside the voice controls.

---

## [2.8.5] — 2026-03-29

### Fixed
- **Noise gate lost on device switch** (#212) — switching microphones mid-call rebuilt the audio chain but forgot to restore the saved noise gate sensitivity, leaving the gate wide open. AI suppression mode was already re-applied; the gate and off modes now are too.
- **Screen share broken after reload** (#213) — when any participant reloaded the page, the `voice-rejoin` path did not tell active screen sharers or webcam users to renegotiate with the reconnected peer, so the rejoined user never received screen share video or audio tracks. The rejoin handler now mirrors the full join flow.
- **Start scripts ignore custom PORT** (#214) — `Start Haven.bat` and `start.sh` hardcoded port 3000 for kill, wait-loop, and display. Both now read `PORT=` from the `.env` file and use it throughout.
- **SSL cert errors hidden** (#214) — all three setup scripts (`Start Haven.bat`, `start.sh`, `Install Haven.ps1`) suppressed OpenSSL stderr, making it impossible to diagnose certificate generation failures. Errors are now shown.

## [2.8.4] — 2026-03-28

### Changed
- **AFK voice channel reworked** (#210) — AFK is now a per-channel setting instead of a server-wide admin option. Right-click any parent channel → ⚙️ Channel Functions → 💤 AFK Sub to designate a sub-channel as the AFK room. Each channel can have its own AFK sub and timeout, keeping groups segregated. The old admin-level AFK setting has been removed.

### Fixed
- **Video embed fullscreen** — fullscreened uploaded videos are now properly centered with visible controls and seek bar. Previously the video could appear off-center with controls clipped off-screen, and exiting fullscreen could break the window layout.

---

## [2.8.3] — 2026-03-27

### Added
- **Bulk emoji upload** (#202) — new "Bulk Upload" button in the Emoji Management modal lets admins select multiple image files at once. Names are auto-generated from filenames (lowercase, stripped of special characters). Skips files that exceed the server's max emoji size.
- **TTS permission** (#192) — new `use_tts` role permission (default ON for all users via the User role). Admins can revoke it per-role to prevent specific users from using `/tts`. Existing servers get the permission auto-granted on startup.
- **`/tts:stop` command** (#192) — instantly cancels any in-progress text-to-speech playback. Client-side only, no message sent.

### Fixed
- **Shippy Container popout** — the "Pop Out" button on the game iframe now checks if the popup window actually opened before closing the inline game. If the browser blocks the popup, the game stays in the iframe and a toast explains the issue instead of silently closing the game.

---

## [2.8.2] — 2026-03-24

### Added
- **Camera device selector** (#189) — users can now select their preferred camera from Settings → Voice & Video.

### Fixed
- **TTS looping** — `/tts` messages are now capped at 500 characters (server + client), and any in-progress speech is cancelled before a new one starts, preventing the infinite loop from very long messages.
- **TTS `@` mentions** — `@username` in TTS messages is now read as just the name instead of "at username".
- **`/spoiler` in E2E-encrypted DMs** — slash commands like `/spoiler` now work correctly in end-to-end encrypted DMs (they were previously sent as raw command text).
- **Channel sort mode sync** — channel sort order is now stored server-side and synced to all clients; admin changes broadcast to everyone in real time. Non-admins can still override locally.
- **Status bar in Desktop windowed mode** (#190) — the bottom status bar now displays correctly when the Desktop app is not maximized.

---

## [2.8.1] — 2026-03-21

### Added
- **Mute/deafen state sync** — mute and deafen status now broadcasts to all clients in real time, so users in one channel can see the mic/deafen state of anyone in a different channel.
- **Deafen implies mute** — deafening now auto-mutes your microphone. Undeafening restores your previous mute state (so manually muting first is remembered).
- **Graceful shutdown** — the server now handles SIGTERM and SIGINT cleanly, closing Socket.IO and HTTP connections before exiting. Fixes forced-kill behavior in Docker and process managers.
- **Opt-in: Hide Voice Panel** — new toggle in Settings → Sounds. Hides the right-sidebar voice users panel on desktop; voice users are still visible in the inline channel indicators.
- **Opt-in: Sidebar Voice Controls** — new toggle in Settings → Sounds. Moves the mute/deafen buttons from the voice panel header to the bottom sidebar bar.

### Fixed
- **Mute/deafen state lost on reconnect** — mute and deafen state is now re-broadcast to the server after a socket reconnect or tab refocus.

---

## [2.8.0] — 2026-03-18

### Added
- **Expanded permissions system** — three new delegatable permissions: `manage_roles` (edit/assign roles), `manage_server` (branding, whitelist, invite, cleanup, upload limit, tunneling), and `delete_channel`. Non-admins with these permissions can manage the server without full admin access. Includes server-side escalation guard preventing users from granting permissions they don't have. Based on community contribution by @Jaymus3 (#150).
- **Deleted users list** (#180) — admins can now view a list of deleted accounts in the admin panel.
- **Configurable voice bitrate** (#179) — voice chat bitrate is now adjustable in settings.

### Fixed
- **Clipboard copy buttons silent failure in Desktop app** (#182) — `navigator.clipboard.writeText()` fails silently in Electron BrowserView. All copy buttons (channel code, server code, webhook URL, wizard code, E2E safety code, tunnel URL, bot manager) now fall back to `execCommand('copy')` when the Clipboard API is unavailable.

---

## [2.7.9] — 2026-03-17

### Added
- **Custom login title** — admins can now set a custom title displayed on the login screen below the Haven logo. Configurable under Settings > Admin > Branding > Login Title (up to 40 characters).
- **Reset roles to default** — new "Reset to Default" button in the Roles settings panel. Wipes all current roles and re-creates the factory defaults (Server Mod, Channel Mod, User) with their original permissions and auto-assignments.

### Fixed
- **Desktop: push notification settings hidden** — the web push notification section in Settings is now hidden when running inside Haven Desktop, since the desktop app already provides native OS notifications. The section was non-functional in that context and showed a confusing "Registration failed" error.

---

## [2.7.8] — 2026-03-16

### Added
- **File upload progress bar** — a progress bar now appears above the message input during file and image uploads showing the real-time upload percentage.
- **View All Members permission** — new `view_all_members` permission that lets roles see all server members in the sidebar and member list, regardless of shared channels. Granted to Server Mod by default. Configurable per-role in admin settings.

### Fixed
- **Desktop notification click not navigating** — clicking a native OS notification in the Haven Desktop app now opens the app and switches to the correct channel or DM.
- **Stream close button now allows reopening** — the ✕ button on stream tiles now hides and mutes the stream instead of permanently removing it. Hidden streams can be restored via the "🖥 N streams hidden" bar, the ⋯ menu on the streamer's name, or by clicking their 🔴 LIVE badge.
- **Docker update instructions** — `docker-compose.yml` now defaults to the pre-built image (`ghcr.io/ancsemi/haven:latest`), fixing the issue where `docker compose up -d` would rebuild from source rather than use the pulled image. Update instructions updated throughout.

---

## [2.7.7] — 2026-03-16

### Added
- **Temporary channels** — admins can now create channels with an auto-delete timer (1 hour to 30 days). Temporary channels show a ⏱️ icon and tooltip with the expiry time, and are automatically cleaned up when their time is up.
- **Linux Docker prerequisites** — added a Linux Prerequisites section to the setup guide covering Docker Engine + Compose V2 installation and docker group setup.

### Fixed
- **Members list privacy** — the All Members list now only shows users who share at least one channel with you. Admins and mods still see everyone.
- **@ symbol in URLs breaking chat links** — URLs containing @ (like YouTube channel links) were being mangled by the mention highlighter. Links now use placeholder tokens during rendering so mentions can't match inside URLs.

---

## [2.7.6] — 2026-03-15

### Added
- **Per-feature channel toggles** — replaced the old "text only" / "voice only" channel modes with individual toggles for each feature: Voice, Text, Streams, Music, and Media. Admins can now mix and match any combination (e.g. media-only channels, voice + media but no text, etc.). Streams and Music automatically depend on Voice — disabling voice will disable both, and they can't be re-enabled until voice is turned back on.
- **Sideways popout menu for Channel Functions** — the channel functions panel now pops out to the side of the context menu instead of expanding vertically inline, keeping the menu compact.

### Fixed
- **Legacy channel type migration** — existing channels that were set to "text only" or "voice only" are automatically migrated to the new individual toggle system on server startup.

---

## [2.7.5] — 2026-03-14

### Added
- **Keyboard navigation shortcuts** — Alt+Up/Down to navigate channels, Alt+Shift+Up/Down to jump between unread channels, Ctrl+K for quick channel switcher.
- **Dynamic channel sort** — channels can be sorted dynamically in the sidebar.
- **Server notification dots (Desktop)** — server bar icons in Haven Desktop now show notification dots for cross-server unreads.

### Fixed
- **Scroll jumping when browsing history** — major overhaul of the infinite-scroll system. Removed `content-visibility: auto` from messages (root cause of unstable `scrollHeight`). Image load handlers were unconditionally yanking the viewport to the bottom even when the user had scrolled up; they now respect the coupling state. Backward pagination (loading older messages) uses element-based anchor pinning with async correction for images and embeds. Forward pagination (loading newer messages) now compensates `scrollTop` when trimming older messages from the top. Trim is centered around the viewport so the scrollbar lands mid-track with room to scroll either direction.
- **False re-coupling at artificial scroll bottom** — after trimming newer messages during history browsing, reaching the DOM "bottom" would falsely re-couple to the latest messages. Coupling now only engages when the DOM contains the actual latest messages.
- **Sub-channel creation permissions** — users with the `create_channel` permission could not create sub-channels (which required `manage_sub_channels`). Either permission now works.
- **E2E key reset blocked** — resetting encryption keys was blocked when encryption couldn't initialize. Now handled gracefully.

---

## [2.7.4] — 2026-03-11

### Added
- **Account recovery codes** — users can generate a set of one-time recovery codes in Settings (🔑 Recovery). If you ever forget your password, you can use one of these codes from the login screen to reset it without needing admin help or email. Recovery codes also work as an offline backup in case TOTP access is lost.

### Fixed
- **Admin panel member list showed extra role badges** — admin users appeared with both their DB-assigned roles (e.g. User, Jester) and the Admin badge in the All Members list. Now only the Admin badge is shown.
- **Admin Recovery button on login screen was broken** — inline event handler had a string escape bug that silently prevented the recovery form from toggling. Rewritten as a proper static handler.
- **E2E backup re-upload after account recovery** — when a user recovered their account on a device that still had E2E keys cached in IndexedDB, the server-side backup (public key) remained NULL, breaking encrypted sessions for other users. The client now detects this mismatch on connect and automatically re-uploads the backup.

---

## [2.7.3] — 2026-03-11

### Added
- **Fullscreen buttons on stream & webcam tiles** — inline screen-share and webcam tiles now have a dedicated fullscreen button (⛶) that appears on hover, alongside the existing pop-out button.
- **Fullscreen on stream/webcam PiP overlays** — the floating PiP overlay windows for screen share and webcam streams now include a fullscreen button (⤢) in the controls bar.

### Fixed
- **Video fullscreen in Desktop** — the native video controls' fullscreen button and the `...` menu fullscreen option now actually work inside Haven Desktop. Previously all fullscreen calls were silently ignored by Electron's BrowserView layer.
- **Uploaded video PiP seek bar** — entering PiP on an uploaded video now properly exposes a seek bar via MediaSession metadata, and wires up play/pause actions so the PiP controls are fully functional.
- **Sub-channel creation by mods** — mods with the `create_channel` permission were unable to create sub-channels (which required `manage_sub_channels`). Either permission now grants sub-channel create/delete access.

---

## [2.7.2] — 2026-03-10

### Fixed
- **Scroll-to-bottom cut off on new root messages** — root messages (new sender or reply) have `content-visibility: auto` applied for performance, which causes the browser to estimate their off-screen height at 64 px instead of the real ~80–120 px. `_scrollToBottom` was reading `scrollHeight` with the underestimate and landing short. Fix: newly appended root messages are forced to `content-visibility: visible` before the scroll so the real height is used immediately.
- **Channel / DM switch landing at wrong scroll position** — switching channels rendered up to 100 messages with `content-visibility` height estimates, then fired a single `requestAnimationFrame` correction. The correction was too early — height estimates kept resolving across subsequent frames, shifting `scrollHeight` after the correction had already fired. Fix: the last 15 messages in the rendered batch are forced visible before the initial scroll, and `_scrollToBottom` now loops up to 8 animation frames, re-scrolling until `scrollHeight` stabilises.

---

## [2.7.1] — 2026-03-09

### Added
- **Media toggle** — new 🖼️ Media setting in the Channel Functions panel lets admins disable image, video, and file uploads per channel. Enforced server-side on both the upload endpoint and message send (admins bypass). DB migration adds `media_enabled INTEGER DEFAULT 1` with a safe no-op on existing installs.
- **Channel Functions tooltips** — all seven rows in the Channel Functions panel now have descriptive `title` tooltip text explaining each setting.

### Fixed
- **Voice user limit permanently stuck at ∞** — a missing `const badge` declaration after a prior refactor caused the voice-limit row handler to silently crash, leaving the limit permanently at "unlimited". Fixed.
- **Text-only channels allow voice join** — all four voice-join entry points (header button, mobile button, channel double-click, and `_joinVoice()` itself) now check for `channel_type === 'text'` and block the join. Previously the guard was missing from all four paths.
- **Streams/music not restored when disabling text-only** — toggling a channel out of text-only mode now restores `streams_enabled` and `music_enabled` to 1 on both the server and the client panel.
- **Channel Functions menu cut off near bottom of screen** — the context menu's position clamp now re-runs after the Channel Functions panel expands, preventing it from being hidden off-screen when the channel is near the bottom of the sidebar.

### Improved
- **Channel Functions disabled-row style** — disabled cfn-rows now render their label with strikethrough text and reduced opacity, making it immediately clear when a feature is turned off.
- **Voice panel buttons respect channel settings** — screen share, camera, and listen-together buttons are greyed (disabled, grayscale, not-allowed cursor) on voice join when the channel has those features turned off. They are re-enabled on leave to not bleed into other channels.

---

## [2.7.0] — 2026-03-08

### Added
- **Collapsible right sidebar** — a toggle button on the right sidebar (voice/users panel) lets you collapse it to zero width for more message area space. The state persists across page reloads. The Join and Create sections in the sidebar also have their own collapsible headers now.
- **Automatic performance diagnostics** — a silent background FPS sampler starts 30 seconds after page load and evaluates every 15 seconds. It logs warnings at two severity levels (avg FPS < 30, avg FPS < 12) with full diagnostic snapshots including heap usage, DOM count, theme state, and RGB cycling status. A manual performance HUD is available via `app._perfHUD(true)` for real-time monitoring.

### Fixed
- **Progressive UI freeze with RGB theme** — the RGB cycling theme caused a devastating progressive freeze, degrading from 60 FPS to ~1 FPS over 5 minutes. Multiple layered root causes were identified and fixed:
  - CSS `transition: 0s` still caused Chromium/Oilpan to allocate zero-duration transition records on every tick, eventually overwhelming garbage collection. Fixed with `transition: none !important` and `animation: none !important` on all elements during RGB cycling.
  - `applyCustomVars()` was rewriting a `<style>` element's `textContent` 20×/s, churning CSSOM nodes inside Blink. Switched to `document.documentElement.style.setProperty()` which batches into a single style invalidation.
  - RGB cycle ran at 60 fps via `setInterval(16ms)` with ~5000 DOM nodes. Switched to `requestAnimationFrame` with adaptive throttling (70–220 ms) that skips ticks when the tab is hidden.
  - DOM message cap lowered from 200 to 100, cutting style recalculations in half.
  - Messages now use `content-visibility: auto` so Chromium skips style recalc for off-screen messages. Hidden modals use `content-visibility: hidden`.
  - Canvas particle effects (matrix rain, embers, snow) capped at ~30 fps instead of uncapped 60 fps.
  - Message hover transitions and box-shadows moved to `:hover` only instead of resting state.
- **Reflow storm when loading messages** — loading a channel's message history appended each message individually, causing hundreds of reflows. Messages are now built in a `DocumentFragment` and inserted in a single append.
- **Mobile message toolbar** — removed the broken double-tap and long-press methods for opening the message action toolbar on mobile. The ⋯ (three dots) button on each message is now the sole method and works reliably.

### Improved
- **App modularization** — the monolithic 17,000-line `app.js` has been split into 11 focused modules (`app-ui`, `app-messages`, `app-socket`, `app-voice`, `app-channels`, `app-admin`, `app-context`, `app-media`, `app-platform`, `app-users`, `app-utilities`), improving maintainability and load performance.
- **Server-side caching** — static assets now use 7-day cache headers with `immutable` and `etag` for faster repeat loads.
- **Server stability** — added a global `uncaughtException` handler to prevent the server process from crashing on unexpected errors.

---

## [2.6.0] — 2026-03-06

### Added
- **Haven Android beta sign-up** — a new green "Android Beta" pill button in the top bar opens a sign-up popup directing users to [amni-scient.com/amni-haven.html](https://amni-scient.com/amni-haven.html) to request access to the Haven Android closed beta on Google Play. The popup appears automatically for first-time visitors (after the desktop promo, if applicable) and can be permanently dismissed via "Don't show this again".
- **Android beta on the website** — the [Haven website](https://ancsemi.github.io/Haven/) now features a dedicated Android banner section with sign-up link, plus a download card in the download section.
- **Android beta in the README** — the repo README now includes a full Android beta section with sign-up link and feature highlights.

### Donors
- Added **Amnibro** to the sponsors list — a huge thank you for building the Haven Android app from the ground up. Incredible work.

---

## [2.5.8] — 2026-03-06

### Added
- **Auto-accept streams setting** — a new toggle in Settings → Sounds lets users opt out of automatically opening screen shares when someone starts streaming. When disabled, a toast notification with a **Join** button appears instead, letting you decide whether to open the stream tile. Auto-accept is on by default; the preference is persisted to `localStorage`.

---

## [2.5.7] — 2026-03-05

### Fixed
- **Right-click → Invite to Channel submenu now opens correctly** — the parent context menu had `overflow-y: auto` set, which trapped the absolutely-positioned submenu inside the scroll container instead of letting it fly out to the side. Removed that overflow constraint and replaced the static post-render flip logic with a live `mouseenter` handler that measures the trigger's position at hover time and opens the submenu left or right accordingly.
- **Email addresses no longer render as @mentions** — the `@mention` highlight regex matched any `@word` pattern, including the domain part of email addresses (e.g. `user@example.com` would tag `@example`). Added a negative lookbehind `(?<!\w)` so only mentions that appear after whitespace or punctuation are styled.

---

## [2.5.6] — 2026-03-04

### Added
- **Channel re-parenting** — admins (and users with the `create_channel` permission) can now restructure the channel tree without deleting and recreating channels. Two new right-click context menu actions:
  - **Move to…** — opens a picker listing all top-level parent channels so a channel can be nested as a sub-channel, or moved from one parent to another. If the channel is already a sub-channel, a "Promote to top-level" shortcut appears at the top of the list.
  - **Promote to Channel** — one-click converts any sub-channel back into a stand-alone top-level channel.
- **Resizable/expandable modals** — all modals can now be resized by dragging the bottom-right corner, and each modal header has an ⛶ expand button that toggles it to near-fullscreen (96 vw × 92 vh).
- **Organize drill-down** — in the server-level channel organize modal, double-clicking a parent channel that has sub-channels opens the sub-channel organizer for that parent in-place. A ← Back button returns to the top-level view.

### Fixed
- **Mobile message toolbar appears instantly on tap** — on Android (Chrome/Brave), CSS `:hover` fires on touch events, causing the emoji/pin/protect toolbar to show immediately instead of after a long-press. Hover-triggered display is now guarded by `@media (hover: hover)` so it only activates on devices with a real pointer, and a belt-and-suspenders `display: none !important` rule in the touch media query ensures the toolbar stays hidden until the long-press timer fires.
- **Mobile message toolbar pushes content sideways** — the toolbar had `position: static` in the phone (`max-width: 480px`) media query, making it render inline and shifting message text. Restored `position: absolute` for all viewport sizes.
- **Font size inconsistency between messages** — compact (continuation) messages were intentionally assigned a slightly smaller font-size in per-density overrides, making them visually smaller than the first message in a group. The compact-specific overrides are removed so all messages share the same font size.
- **Compact message timestamp overlaps text on mobile** — the inline timestamp shown on continuation messages was triggering via `:hover` on touch devices, overlapping the message content. It is now hidden with `display: none !important` on touch devices.

### Donors
- Added **john doe** to the one-time donors list — thank you!

---

## [2.5.5] — 2026-03-03

### Fixed
- **Settings layout broken after v2.5.4** — the commit that added Desktop Shortcuts dropped the opening `<div>` for the Layout Density section, causing every settings section below it to render as a horizontal row instead of a scrollable vertical list.
- **TOTP copy button silent failure in Desktop app** — `navigator.clipboard.writeText()` fails silently in Electron. Both the setup secret and backup codes copy buttons now fall back to `execCommand('copy')` when the Clipboard API is unavailable.
- **Settings modal closed by accidental backdrop click during TOTP setup** — clicking outside the modal while the TOTP setup form or backup codes view was visible would close the modal and lose setup progress. Backdrop clicks are now ignored while the TOTP flow is active.
- **Active sessions not invalidated when enabling 2FA** — enabling TOTP now bumps `password_version` and force-disconnects all other active sessions, matching the behavior of password changes. The activating session receives a fresh token and stays logged in.

---

## [2.5.4] — 2026-03-03

### Fixed
- **Link preview HTML entity decoding** — image URLs containing `&amp;` or other HTML entities (common in Reddit and other sites) were being served with raw entities, causing broken images in previews. All OG-scraped values are now entity-decoded before being sent to the client.
- **Reddit link previews** — Reddit doesn't serve OG tags to unknown bots, so previews showed no content for reddit.com links. The server now uses Reddit's JSON API (`.json` endpoint) to fetch rich post data directly, including title, subreddit, author, images, and gallery support (up to 4 images).
- **Twitter/X link previews with images** — when the Twitter oEmbed API returned title and description but no image, the image fallback was scraping the original twitter.com URL which serves a JS-only page. The fallback now proxies through fxtwitter.com, which serves bot-friendly OG-enriched HTML. Additionally, native twitter.com/x.com links where oEmbed fails now also try fxtwitter as a full preview source.

---

## [2.5.3] — 2026-03-03

### Added
- **Built-in AOL sounds** — five classic AOL audio cues are now bundled with Haven and appear in every server's soundboard and notification dropdowns automatically, with no upload required: *Door Open*, *Door Close*, *You've Got Mail*, *Message*, and *Files Done*. The files live in `public/sounds/` and are served as static assets; they appear at the top of the sound list with a 🔒 indicator and cannot be deleted or renamed.

---

## [2.5.2] — 2026-03-03

### Added
- **manage_soundboard permission** — new role permission allowing non-admin users to upload, rename, and delete custom soundboard sounds. Admins can grant it to any role via the role editor.

### Fixed / Improved
- **fxtwitter / vxtwitter embeds** — fixed a URL normalization bug where the Twitter oEmbed endpoint was being called with the proxy domain instead of a native twitter.com URL, causing embed data to come back empty for those links.
- **Pixiv link previews** — added a dedicated Pixiv oEmbed handler. Pixiv blocks generic HTML scrapers but exposes an oEmbed API, so artworks now generate proper previews with title, author, and thumbnail.
- **oEmbed autodiscovery** — the generic link scraper now detects `<link type="application/json+oembed">` tags in page HTML and falls back to that endpoint when OG tags are absent. This future-proofs embed support for any oEmbed-compatible site without needing per-site handlers.

---

## [2.5.1] — 2026-03-02

### Fixed
- **Image uploaded to wrong channel** — switching channels while an upload was in progress caused the image to be sent to the newly active channel instead of the one it was uploaded from. The target channel is now captured before the async upload begins.
- **Encrypted DM reply previews showed raw ciphertext** — the reply banner inside an encrypted DM showed garbled ciphertext instead of the decrypted message. The decrypt pass now also covers `replyContext.content`.
- **Voice chat unusable after mobile screen timeout / app backgrounding** — losing network focus removed the user from voice on the server side but left stale state on the client, so the leave button appeared but neither leaving nor rejoining worked without a full page reload. The socket disconnect handler now resets local voice state so the UI clears correctly and auto-rejoin on reconnect works as expected.
- **Custom emoji upload / delete restricted to admin only** — added a `manage_emojis` role permission. Admins can grant it to any role, giving those users the ability to upload and delete custom emojis and access the Emojis settings tab without needing full server admin.

---

## [2.5.0] — 2026-03-01

### Added
- **One-click installer** — new bootstrap installers for every platform: `Install Haven.bat` (Windows), `install.sh` (Linux/macOS), and `website/install.sh` / `website/Install Haven.bat` for download-and-run convenience. All download Haven, install Node.js if needed, and launch a local web-based setup wizard (`installer/server.js` + `installer/index.html`) that walks through server name, port, admin account, SSL, and push notification config.
- **FCM mobile push notifications** — `src/fcm.js` adds Firebase Cloud Messaging support. Three automatic modes: *direct* (place a Firebase service account JSON in the data directory), *custom relay* (set `FCM_RELAY_URL` + `FCM_PUSH_KEY` in `.env`), or *global relay* (no config needed — uses the Haven community relay automatically). Uses the existing `jsonwebtoken` dependency — no firebase-admin SDK required. Mobile tokens are stored in the `fcm_tokens` table and auto-cleaned on delivery failure. Contributed by @anmire (#109).
- **Push relay** — `haven-push-relay/` contains a standalone Express relay server and a Firebase Cloud Function for self-hosted FCM relay deployments.
- **Admin-only update banner** — new admin setting (Settings › Members) to hide the "update available" banner from regular members. When enabled, the banner is shown only to admin-role users. Contributed fix for #108.
- **Windows Inno Setup installer scripts** — `setup.iss` and `master-setup.iss` for building a native Windows `.exe` installer via Inno Setup.

### Fixed
- **Settings modal not loading 2FA status or roles** — the TOTP status check and roles list were only fetched when navigating to their respective nav items, so opening the modal via shortcuts landed on a blank page. Both are now loaded eagerly whenever the modal opens. Fixes #110.
- **Desktop app crashed when a friend sent an external server link** — the Electron `handleWindowOpen` handler was loading any URL with an `/app.html` path in-app (including links to friends' servers), and `did-fail-load` always reset to the welcome screen. Fixed: only registered servers load in-app; external servers open in the system browser; load failures on peer servers are handled silently without resetting the UI.

---

## [2.4.0] — 2026-03-01

### Added
- **Emoji upload crop/zoom editor** — a canvas-based crop/zoom editor now opens when you upload a custom emoji. Drag to reposition, scroll wheel or the slider to zoom. GIFs are passed through as-is (no re-encoding). Output is a 128×128 PNG.
- **Jumbo emoji for emoji-only messages** — when a message contains only emoji (Unicode or custom, up to 27), the emoji render at 2× size, Discord-style.
- **Ezmana added to donors list**

### Changed
- **Donors modal redesign** — tier titles (Sponsors / Donors) are now styled as full-width section dividers with ruled lines flanking the label, sitting above their respective card. The donor chip lists live in card-style containers with a thin scrollbar for when the list grows.

### Fixed
- **Editing a message now preserves markdown** — the edit box was populated from the rendered HTML (`textContent`), stripping all formatting. It now reads from a `data-rawContent` attribute that stores the original markdown source. Fixes #106.
- **"(edited)" no longer stacks on repeated edits** — the stale "(edited)" text was included in the edit-box content via `textContent`, causing it to be re-submitted and duplicated. Also fixed by the `data-rawContent` change. Fixes #106.

---

## [2.3.9] — 2026-03-01

### Added
- **Two-Factor Authentication (TOTP)** — users can protect their account with a TOTP authenticator app (Google Authenticator, Authy, etc.). Enable from Settings > Two-Factor. Includes QR code setup, manual secret entry, and 8 single-use backup codes. Login prompts for verification when 2FA is enabled. Admin recovery intentionally bypasses TOTP.
- **Native OS notifications for new messages** — when the Haven tab or window is not visible, new messages now fire a native OS notification toast (browser Notification API or Electron native notification). Desktop app always uses native notifications; browser falls back to the Notification API when push notifications aren't active.

### Fixed
- **2FA setup QR code and secret not displaying** — the server response field names didn't match what the client expected, resulting in a blank QR code and empty secret text.
- **Backup code rejected by browser validation** — switching to backup code mode left an empty `pattern` attribute on the input, causing the browser to reject valid alphanumeric backup codes.
- **Backup codes had no copy button** — added a clipboard copy button to the backup codes display in settings.

---

## [2.3.8] — 2026-02-28

### Fixed
- **Private channel code is now actually hidden from members** — previously, `code_visibility` (admin setting) and `is_private` (requires code to join) were independent flags. A member of a private channel could still see the real invite code in the channel header and share it freely. Now, any channel marked `is_private` automatically hides its code from regular members — only the channel creator, admins, and mod-level users can see it. The same applies when a channel has `code_visibility` set to private.

---

## [2.3.7] — 2026-02-27

### Fixed
- **Private channels are now actually private** — any member of a private channel could previously invite anyone to it via the right-click menu, bypassing the code requirement entirely. Regular members can no longer invite others to private channels. Only the channel creator, admins, and moderators (users with a `kick_user`-level permission in that channel) can invite. Private channels are also hidden from the invite submenu for non-admin users.

### Changed
- **Channel creator auto-gets mod role** — when a user creates a new top-level channel, they are automatically assigned the highest channel-scoped role (e.g. Channel Mod) for that channel. Previously the creator was just added as a regular member. This means channel creators can manage their own channel (rename, moderate, create sub-channels) without an admin needing to manually assign them a role.

---

## [2.3.6] — 2026-02-27

### Fixed
- **Docker healthcheck respects FORCE_HTTP** — the container healthcheck now uses HTTP when `FORCE_HTTP=true` is set, so reverse-proxy setups (Traefik, nginx, etc.) no longer mark the container as unhealthy. Previously the check always used HTTPS, which caused unhealthy status and missing routes.
- **Non-ASCII filenames in file transfer** — filenames containing Chinese characters (and other non-ASCII text) are no longer garbled when files are uploaded. The server now correctly re-encodes the filename from the raw multipart bytes to UTF-8.

---

## [2.3.5] — 2026-02-26

### Added
- **Donor list externalized** — sponsors and donors are now loaded from `donors.json` at the server root, so the list can be updated without editing HTML. The Thank You modal fetches `/api/donors` on open.

### Fixed
- **Password change redirect loop** — changing your password no longer kicks your own session into an infinite redirect. The server now sends the fresh token before disconnecting sockets, and the client guards against self-eviction during password changes.
- **Plugin loader scope** — the plugin loader now passes `globalThis` into the plugin sandbox as `_win`, so plugins can register classes that the loader can discover. Previously `new Function()` ran in a strict scope where `window` was inaccessible, breaking all plugins including the built-in MessageTimestamps.
- **MessageTimestamps plugin** — updated to register via `_win` so it loads correctly with the fixed plugin loader.

---

## [2.3.4] — 2026-02-26

### Added
- **Right-click voice users** — right-clicking a player name in the voice channel now opens the same volume/mute/deafen menu as the ⋯ button.
- **Donor tier background boxes** — each donor tier section in the Thank You modal now has a styled background card for better visual organization.

### Fixed
- **Duplicate theme effect sliders** — CRT and Glitch no longer show redundant speed sliders in the effect panel. Each effect now only appears in its dedicated editor section.
- **Hover profile card stuck open** — the translucent bio/profile popup that appears on hover now reliably closes when the mouse moves away, using a global mousemove safety net that tracks distance from both the trigger and the popup.
- **Profile card missing channel roles** — the profile popup now correctly shows channel-specific roles (e.g. Channel Mod) instead of only server-wide roles. Previously a user with a Channel Mod role would still display as just "User" in their profile card.

---

## [2.3.3] — 2026-02-25

### Added
- **DM & Nickname in member list** — the All Members panel now shows 💬 Message and 🏷️ Set Nickname buttons on every user row, so you can DM or nickname anyone without leaving the list.
- **Sidebar Members button** — new 👥 button in the sidebar gives all users quick access to the full member list (previously admin-only).
- **Remove from Channel** — admins and moderators can now remove users from specific channels via the member list.
- **Admin recovery endpoint** — new `/api/admin-recover` route lets the server owner reclaim admin access using their `.env` credentials if they get locked out.

### Fixed
- **Member list popup z-index** — action modals (Assign Role, Add/Remove Channel, Ban, Set Nickname) triggered from the All Members panel now correctly appear above the list instead of hiding behind it.
- **Profile hover popup stuck open** — the translucent bio/profile preview that appears on username hover now reliably fades away when the mouse moves off, using a global mousemove fallback to catch edge cases the old mouseout approach missed.
- **Role level enforcement on kick/ban/mute** — moderators can no longer kick, ban, or mute users with equal or higher role levels. Admins are always protected from non-admin actions.
- **Case-insensitive username registration** — usernames are now checked case-insensitively during signup to prevent duplicate accounts with different casing.
- **Role channel access on signup** — auto-assigned roles now correctly grant linked channel access when a new user registers.

---

## [2.3.2] — 2026-02-25

### Added
- **Sound Manager popout** — new 3-tab Sound Manager (Soundboard, Assign to Events, Manage) with hotkey binding, rename/delete, and event assignment for all 5 notification types.
- **Soundboard hotkey UX** — sounds now show a clear "Set hotkey" link or a visible "×" remove button instead of an unintuitive confirm dialog.

### Fixed
- **Kick now permanently revokes channel access** — kicking a user removes them from `channel_members` (and sub-channels), preventing them from simply reconnecting. The kicked user's socket rooms and channel list are also refreshed immediately.
- **Role auto-assign grants linked channel access** — auto-assigned roles now call `applyRoleChannelAccess()` so that roles with linked channels actually add users to those channels on join/invite.
- **Font size scaling in sub-menus** — added missing `[data-fontsize]` CSS overrides for settings hints, toggle rows, select rows, inputs, context menus, status bar, and settings nav items across all font size tiers.
- **Custom sounds populate all notification selects** — all 5 event selects (message, sent, mention, join, leave) now include uploaded custom sounds, not just 2 of them.
- **Notification sound fallback** — `notifications.js` now searches all selects and the custom sounds array for playback URLs.

---

## [2.3.1] — 2026-02-25

### Fixed
- **Plugin CSP error** — added `'unsafe-eval'` to Content Security Policy `scriptSrc` so plugins using `new Function()` (like MessageTimestamps) can load without EvalError.
- **Health check 404 spam** — multi-server sidebar health checks now extract the origin from stored server URLs before appending `/api/health`, fixing 404s when the URL contained a path (e.g. `/app`).

---

## [2.3.0] — 2026-02-24

### Added
- **Webcam video in voice channels** — new camera button in the voice panel lets users broadcast their webcam to all voice participants. Includes start/stop, device picker, late-joiner renegotiation, and per-user video tiles in a dedicated webcam grid.
- **Webcam grid UI** — resizable, collapsible webcam container with layout picker (Auto grid, Vertical stack, Side-by-side, 2×2), size slider, minimize/close controls, double-click focus mode, and Picture-in-Picture pop-out per tile.
- **Plugin & Theme system** — full hot-loadable plugin architecture with `HavenApi` (DOM helpers, data/localStorage, toasts, confirm dialogs). Server-side `/api/plugins` and `/api/themes` endpoints scan directories and parse JSDoc metadata. New Settings UI section with toggle switches and refresh. Includes example plugin: `MessageTimestamps.plugin.js`.
- **Two new light themes** — "Daylight" (warm/amber) and "Cloudy" (cool/blue-grey) with full CSS variable sets.
- **Font size picker** — Small (13px), Normal (15px), Large (17px), and Extra Large (20px) options in settings, persisted to localStorage.
- **Invite user to channel** — right-click any online user to invite them to a channel. Server validates membership, avoids duplicates, auto-joins sub-channels, auto-assigns roles, and notifies the invited user.
- **Admin "View All Members" panel** — admin modal showing every registered user with search, filters (All/Online/Offline/New/Banned), role badges, avatar, online status, join date, and channel count.
- **Profile hover popups** — hovering over a username or avatar shows a translucent profile preview with delay and auto-dismiss.
- **Haven Desktop beta** — standalone Electron desktop app now available at [github.com/ancsemi/Haven-Desktop](https://github.com/ancsemi/Haven-Desktop). Per-app audio, native notifications, system tray, one-click install.
- **Password version / session invalidation** — changing your password now force-disconnects all other active sessions via `force-logout` event. JWT includes `pwv` (password version) claim.
- **Server-sent toast events** — new `toast` socket event for server-to-client toast notifications.
- **Google Fonts CSP support** — added `fonts.googleapis.com` and `fonts.gstatic.com` to Content Security Policy.

### Fixed
- **Double-encoding of special characters** — server-side `sanitizeText()` no longer entity-encodes characters; client handles escaping, preventing double-encoding on display.
- **Flood-gate false disconnects on WebRTC signaling** — high-frequency WebRTC events now bypass the global event rate limiter.
- **Incomplete user deletion cleanup** — admin delete-user and self-delete now also purge `user_roles`, `read_positions`, `push_subscriptions`, and `fcm_tokens`.
- **Silent audio track leak** — silent audio track is now cached and reused; `AudioContext` properly closed on voice disconnect.
- **Auto-cleanup chunking** — large message deletions are now chunked (1,000 at a time) to avoid SQL timeouts.
- **Orphaned import temp file cleanup** — cleanup now also runs at startup, not just on the 15-minute interval.
- **Admin transfer atomicity** — admin transfer is now wrapped in a SQLite transaction.
- **Password minimum length** — registration now requires 8 characters (up from 6).

### Changed
- **Server-side `sanitizeText()` rewritten** — simplified to focused dangerous-tag removals plus event-handler and `javascript:` URI stripping.
- Website & docs updated to v2.3.0 with Haven Desktop beta links.

---

## [2.2.5] — 2026-02-23

### Security
- **Webhook avatar_url validation** — webhook POST `avatar_url` field now requires `http://` or `https://` protocol, blocking `data:` URIs and other non-HTTP schemes that could be used for IP tracking.

### Fixed
- **Missing express-rate-limit import** — the webhook rate limiter referenced `rateLimit` without a require, causing a crash on server startup.

### Removed
- **Desktop app code removed from server** — the `desktop/` directory, `build-desktop.bat`, desktop API routes (`/api/desktop/*`), desktop promotion popup, and all desktop-related UI elements have been surgically removed. The desktop app will be rebuilt as a separate project in its own repository.

### Changed
- Website & docs updated to v2.2.5.

---

## [2.2.4] — 2026-02-22

### Security
- **SSRF bypass in link previews** — link preview endpoint now uses `redirect: 'manual'` with manual redirect following (max 5 hops), re-validating each redirect target against private IP / DNS checks to prevent `evil.com` → 302 → `http://169.254.169.254/` style attacks.
- **JWT admin claim trust** — all 13 REST API admin endpoints now verify `is_admin` from the database instead of trusting the JWT claim, preventing demoted admins from using stale tokens.
- **Path traversal in avatar/icon uploads** — `set-avatar` and `server_icon` settings now validate paths with a strict regex (`/^\/uploads\/[\w\-.]+$/`) instead of a prefix check, blocking `../` traversal payloads like `/uploads/../../etc/passwd`.
- **mark-read missing membership check** — the `mark-read` socket event now verifies channel membership before allowing read-position writes, preventing any user from inserting read positions for channels they don't belong to.
- **transfer-admin race condition** — added a mutex flag and post-`await` DB re-check around the async `bcrypt.compare()` call, preventing concurrent transfer requests from racing past the admin verification.
- **Server-side content sanitization** — added `sanitizeText()` defense-in-depth filter that strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<meta>`, `<form>`, `<link>` tags, event handler attributes, and `javascript:` URIs. Applied to messages, edits, bios, and channel topics.
- **Dependency vulnerabilities** — patched all 6 npm audit findings (qs, bn.js, axios) via `npm audit fix` and `overrides` in package.json. Audit now reports **0 vulnerabilities**.

### Fixed
- **broadcastChannelLists DoS** — added 150 ms debounce to batch rapid channel mutations, preventing O(N × queries) storms when channels are reordered.
- **reorder-channels unbounded input** — capped the channel reorder array to 500 items to prevent excessive DB writes from a single socket event.

### Changed
- Documented intentional `rejectUnauthorized: false` usage in port-check (self-connection to own public IP only).
- Website & docs updated to v2.2.4.

---

## [2.2.3] — 2026-02-21

### Fixed
- **Screen share black screen on own view** — video elements were assigned their source while the container was still hidden (`display: none`), causing browsers to skip frame decoding. The container is now shown before setting `srcObject`, with a forced layout reflow so the first frame renders immediately.
- **Role save button buried in scroll** — the Save button was inside the scrollable permissions list, making it easy to miss. Moved it to the always-visible modal footer next to the Close button.
- **Role save confirmation too subtle** — replaced the brief in-button text flash with a proper green toast notification ("Role saved") that appears at the top of the screen.
- **Screen share quality controls (mid-stream)** — resolution and framerate changes now apply instantly to an active share via `applyConstraints()` and bitrate re-capping, without needing to stop and restart.
- **Screen share black screen on re-share** — `stopScreenShare` now fully awaits renegotiation before allowing a new share, and the `onunmute` handler no longer references a stale stream closure.
- **Auto-assign default role not persisting** — the auto-assign flag update is now wrapped in a database transaction, and the server returns fresh role data directly in the callback to avoid race conditions.

### Changed
- Website & docs updated to v2.2.3.

---

## [2.2.2] — 2026-02-21

### Added
- **FORCE_HTTP mode** — set `FORCE_HTTP=true` in `.env` to skip built-in SSL entirely, making reverse proxy setups (Caddy, nginx, Traefik) painless. Startup scripts also skip cert generation when enabled.
- **Auto-assign default roles** — roles can now be flagged as auto-assign in the admin panel. Flagged roles are automatically given to new users on registration and when joining a channel.

### Fixed
- **Docker ARM build failing** — replaced QEMU-based cross-compilation with native ARM runners (`ubuntu-24.04-arm64`) and a manifest merge step so the multi-arch image builds reliably.
- **HSTS header sent in HTTP mode** — Strict-Transport-Security is now disabled when FORCE_HTTP is active.
- **window.app not exposed globally** — the main app instance is now assigned to `window.app`, fixing integration hooks.

### Changed
- Website & docs updated to v2.2.2.

---

## [2.2.1] — 2026-02-21

### Fixed
- **Channel code hidden on mobile** — the channel code tag is now visible on tablet and phone with compact sizing instead of being hidden entirely.
- **Logout icon broken on Android** — replaced the Unicode power symbol (⏻) with an inline SVG that renders on all devices.
- **Mobile menu buttons missing on first load** — added an early media query so hamburger / users sidebar buttons render immediately instead of waiting for later CSS to load.
- **Status picker clipped on mobile** — switched from `position: absolute` (clipped by sidebar overflow) to `position: fixed` with JS-based placement.
- **Status change fails while disconnected** — status updates are now queued and applied automatically on reconnect, with a toast notification.
- **TURN credentials never fetched** — fixed localStorage key mismatch (`haven_token` → `token`) so voice chat works across networks, not just LAN.
- **File upload type restrictions removed** — server no longer blocks uploads by MIME type; a client-side warning is shown for risky file extensions instead.
- **Server branding not persisting** — added error handling for branding save failures.

### Changed
- Website & docs updated to v2.2.1 with download links and version history.

---

## [2.2.0] — 2026-02-20

### Added
- **CRT fishbowl vignette overlay** — the CRT effect now simulates the convex glass of a classic cathode-ray tube with a parabolic vignette, curved edges, phosphor glow, and a subtle glass reflection highlight.
- **CRT vignette darkness slider** — new slider in the effect panel controls how far the darkness encroaches from the edges and how dark it gets (0 = almost invisible, 100 = heavy CRT tunnel).
- **CRT scanline intensity slider** — new slider controls scanline opacity (0–80%) with lines that fade toward the center via a radial mask.
- **CRT flicker frequency range** — the CRT speed slider now maps to a wider flicker frequency range (half the previous slowest, double the previous fastest) for fine-grained control.
- **Inline YouTube embeds** — YouTube links posted in chat now render an inline video player directly in the message, supporting youtube.com, youtu.be, /shorts/, /embed/, and music.youtube.com URLs.
- **Emoji quickbar flip-below** — the quick-react emoji picker now detects when it would be clipped at the top of the viewport and flips below the message instead.

### Fixed
- **CRT vignette slider not appearing** — the vignette/scanline sliders are now injected directly into the effect speed editor block, fixing a visibility bug where the standalone editor div was never shown.
- **CRT vignette slider not working** — the flicker animation was overriding inline opacity; vignette now controls the gradient directly so both flicker and vignette coexist.
- **Reaction picker clipping** — emoji quickbar for messages near the top of the chat area no longer gets cut off.

### Changed
- **Website & docs** updated to v2.2.0 with feature descriptions and version history.
- **README** — version badge updated to v2.2.0.

---

## [2.1.0] — 2026-02-19

### Fixed
- **E2E encryption — multi-device key sync** — encrypted DM keys now stay in sync across multiple browsers and devices. Previously, logging in on a second device could cause key conflicts and break encryption for both sessions.
- **E2E encryption — infinite sync loop** — resolved a condition where two devices could repeatedly overwrite each other's keys, causing an endless conflict cycle.
- **Channel organizer — category/tag sorting** — the Up/Down buttons for reordering category headers (tag sections) in the Organize modal now work correctly. Previously, the buttons were disabled even when Manual Order was selected.
- **Channel organizer — channel sorting within groups** — moving channels up/down now correctly swaps within the visible tag group instead of the flat channel list.
- **Settings crash** — fixed a `TypeError` in server settings that could cause intermittent UI issues.

### Changed
- **E2E architecture improvements** — smarter key backup strategy prevents accidental overwrites when multiple devices are active. Cross-device sync notifications ensure all sessions stay current.
- **Cache-busting** — client JS files now use version-based cache keys to prevent stale code after updates.

---

## [2.0.1] — 2026-02-19

### Fixed
- **Security: removed GUI installer wizard** — the cross-platform GUI installer (PR #26) could open browser tabs and break running servers on the host machine. Reverted entirely.

---

## [2.0.0] — 2026-02-19

### Added
- **Discord history import — Direct Connect** — import your entire Discord server's message history directly into Haven. No external tools required. Built-in token retrieval instructions (Application tab → Local Storage method). Supports text channels, announcement channels, forum channels, media channels, threads (active + archived), and forum tags. Preserves messages, embeds, attachments, reactions, replies, pins, and Discord avatars.
- **Discord history import — File upload** — alternatively upload a DiscordChatExporter JSON or ZIP archive to import channel history.
- **Tabbed import modal** — the import dialog now has two tabs: 📁 Upload File and 🔗 Connect to Discord.
- **Discord avatar preservation** — imported messages display the original author's Discord avatar (CDN URL) instead of the Haven admin's avatar. New `webhook_avatar` database column.
- **Full server structure import** — import fetches announcement (type 5), forum (type 15), and media (type 16) channels in addition to text channels. Threads (active + archived public) are nested under their parent channels. Forum tags are resolved and displayed.
- **Channel type indicators** — import channel picker shows type icons: # text, 📢 announcement, 💬 forum, 🖼️ media, 🧵 thread.

### Fixed
- **E2E key loss on password change** — changing your password no longer orphans your encrypted DM key backup. The private key is now automatically re-wrapped with the new password and re-uploaded to the server, so login on new devices continues to work.
- **Scroll-to-bottom loop** — loading Discord CDN images (or any images) in chat no longer forces the viewport back to the bottom when you're scrolled up reading history.
- **ARM64 Docker support** (#34) — Docker image now builds and runs correctly on ARM64 (Raspberry Pi, Apple Silicon, etc.).

### Changed
- **Website & docs** updated to v2.0.0 with Discord import feature callout.
- **README** — added Discord import section with feature description.
- **GUIDE** — added Discord import instructions.

---

## [1.9.2] — 2026-02-18

### Added
- **Image lightbox** — clicking an image opens a full-screen overlay instead of a new tab. Click anywhere or press Escape to close.
- **Image display mode setting** — choose between compact thumbnails (default, 180px) or full-width Discord-style embeds in Settings › Layout.
- **Emoji autocomplete** — type `:` followed by 2+ characters to search emojis by name. Custom server emojis appear first. Navigate with arrow keys, insert with Enter/Tab.
- **Animated GIF avatars** — upload a GIF as your profile picture and it animates everywhere (messages, sidebar, profile popup). Format hint added to the upload UI.
- **Voice chat profile clicks** — click a username in the voice panel to open their profile popup (bio, DM, etc.), same as clicking a name in the sidebar.
- **Auto-focus message input** — the text box is automatically focused when switching channels or opening DMs.
- **Docker image publishing** — pre-built Docker images are now automatically pushed to GitHub Container Registry on every release (`ghcr.io/ancsemi/haven:latest`). No build step needed.

### Changed
- **Website & docs** updated to v1.9.2 with version history entries for v1.9.1.
- **README** — added Docker pull instructions, emoji autocomplete to keyboard shortcuts, updated feature descriptions.
- **GUIDE** — added pre-built Docker image quick start option.

### Fixed
- **Auto-cleanup deleting server assets** (#32) — the file cleanup routine now protects server icons, user avatars, custom emojis, custom sounds, and webhook avatars from deletion.

---

## [1.9.1] — 2026-02-18

### Added
- **Custom server emojis** — admins can upload PNG/GIF/WebP images as custom emojis (`:emoji_name:` syntax). Works in messages, reactions, and the emoji picker.
- **Emoji quickbar customization** — click the ⚙️ gear icon on the reaction picker to swap any of the 8 quick-react slots with any emoji (including custom ones). Saved per-user in localStorage.
- **DM deletion** — right-click (or click "...") on any DM conversation to delete it. Removes from your sidebar only.
- **Reply banner click-to-scroll** — clicking the reply preview above a message now smooth-scrolls to the original message and highlights it briefly.
- **Settings navigation sidebar** — the settings modal now has a left-side index with clickable categories (Layout, Sounds, Push, Password, and all admin subsections). Hidden on mobile.
- **Popout modals for sounds & emojis** — Custom Sounds and Custom Emojis management moved out of the inline settings panel into their own dedicated modals (like Bots/Roles). Keeps the settings menu lean.
- **JWT identity cross-check** — tokens are now validated against the actual database user, preventing token reuse across accounts (security hardening).

### Fixed
- **Docker entrypoint CRLF crash** — added `.gitattributes` to force LF line endings on shell scripts, plus a `sed` fallback in the Dockerfile.
- **Quick emoji editor immediately closing** — click events inside the editor propagated to the document-level close handler. Added `stopPropagation()` to all interactive elements.
- **Gear icon placement** — moved the ⚙️ customization button to the right of the "⋯" more-emojis button so frequent "..." clicks aren't blocked.

---

## [1.9.0] — 2026-02-17

### Added
- **First-time admin setup wizard** — 4-step guided setup on first launch: server name/description, create a channel, port reachability check, and summary with invite code.
- **Port reachability check** (`/api/port-check`) — tests if the server is accessible from the internet using external services (ipify + portchecker.io with self-connect fallback).
- **One-click Windows launcher** — `Start Haven.bat` handles everything: detects Node.js, offers automatic install (downloads Node 22 LTS MSI via PowerShell), installs npm dependencies, generates SSL certs, starts the server, and opens the browser.
- **Node.js auto-installer** (`install-node.ps1`) — PowerShell script that downloads and installs Node.js 22 LTS directly from nodejs.org. Pinned to v22 for native module compatibility.
- **Full emoji reaction picker** — the quick-react bar now has a `⋯` button that opens a scrollable, searchable panel with all emoji categories (not just 8 quick emojis).
- **Unified file upload button** — merged the image upload (landscape SVG) and file upload (paperclip) into one button. Images get queued with preview; other files upload immediately. Win95 theme shows 📎 instead of the SVG icon.
- **Input actions toolbar** — upload, emoji, and GIF buttons are now wrapped in a bordered backdrop box with vertical dividers (matching the channel header actions style).
- **Node.js version guard** — batch launcher and `package.json` engines field block Node ≥ 24 (where `better-sqlite3` prebuilt binaries don't exist yet).

### Fixed
- **E2E encryption: permanent decrypt failure** — partner public keys were cached forever and never re-fetched if the partner regenerated keys. Now always re-fetches, detects key changes, and invalidates the stale ECDH shared secret cache. Also fixed a race condition where messages were fetched before the partner key was available.
- **DM messages pushed to right side** — the E2E lock icon (🔒) in compact messages had `margin-left: auto` as a direct flex child, shoving the entire message content to the far right edge. Moved the lock inside `.message-content`.
- **Reactions appeared inconsistently** — in compact (grouped) messages, reactions were a flex sibling appearing to the right of the text instead of below. Now both compact and full messages use the same `.message-body` wrapper.
- **Reactions lost on message promotion** — `_promoteCompactToFull` used the wrong selector (`.reactions` → `.reactions-row`), silently dropping reactions when a group's root message was deleted.
- **`npm install` killed the batch launcher** — `npm` on Windows is `npm.cmd`; running it from a `.bat` without `call` transfers control permanently and the window vanishes. Added `call` keyword.
- **Node v24 build failures** — the auto-installer grabbed the latest LTS (v24), but `better-sqlite3` had no prebuilt binaries for it, causing a `node-gyp` compile attempt that fails without Python + C++ build tools. Pinned installer to Node 22 LTS.
- **`dotenv` MODULE_NOT_FOUND on fresh install** — an empty `node_modules` folder from a failed prior run caused the existence check to pass, skipping `npm install`. Changed to always run `call npm install` (fast no-op when deps exist).

### Changed
- **README restructured** — Docker-first install flow, "Who Is This For?" and "Why Not Discord?" sections added for non-technical audiences.
- **Website comparison table** — added Fluxer column and updated the screenshot.

---

## [1.8.2] — 2026-02-17

### Fixed
- **PiP reverted to native browser system** — the in-page overlay approach has been dropped in favor of the native Picture-in-Picture API (draggable to other screens). The overlay is now a slim fallback only when native PiP isn't supported. Fullscreen button removed.
- **YouTube playlist controls** — next, previous, and shuffle now work for YouTube playlists. The embed URL preserves the `list=` parameter so the IFrame API has playlist context. Controls are hidden for single videos (where they had no effect).
- **YouTube auto-advance** — when a video ends in a playlist, the next one plays automatically instead of showing end-screen suggestions that open new tabs.
- **Bot "Updated" toast was red** — server was emitting via the error channel. Now uses a dedicated `bot-updated` event with green success styling.
- **Toast hidden behind modals** — toast container z-index raised above modals so notifications are always visible.
- **Bot channel dropdown unordered** — channels now appear in server order with sub-channels indented under their parents.
- **Uncategorized DMs not collapsible** — the Uncategorized section now collapses/expands on click with state saved to localStorage, matching tagged DM categories.
- **HTTPS redirect hardcoded to localhost** — remote users hitting the HTTP port were redirected to `https://localhost` instead of the actual server host.
- **Duplicate avatar upload route** — two `/api/upload-avatar` handlers were registered; the first lacked the 2 MB size check. Removed the duplicate, added the size check to the primary handler.
- **Duplicate `get-webhooks` socket handler** — global and per-channel handlers both fired for every event. Added a guard so each only handles its own scope.
- **E2E safety number only 30 digits** — verification codes were half the documented length due to SHA-256 producing only 32 bytes. Switched to SHA-512 (64 bytes) for the full 60-digit output.
- **YouTube playlist flag not reset for Spotify** — sharing a Spotify link after a YouTube playlist left stale state, incorrectly showing track controls for Spotify.

### Added
- **Release tarball with fixed directory name** — GitHub Actions workflow now attaches a `haven.tar.gz` to each release that always extracts to `haven/` (no version in the path), so headless server users don't need to rename or update systemd paths on every update.

---

## [1.8.1] — 2026-02-16

### Fixed
- **Max upload size not applying client-side** — the drag-and-drop / file upload was hardcoded to reject files over 25 MB regardless of the admin setting. Now reads the server-configurable limit.
- **Message timestamp shift** — hovering over a compact (grouped) message no longer pushes the text rightward. Timestamp now uses `visibility` instead of `display` so it occupies space at all times.
- **Dual-role display** — users with Channel Mod + User roles no longer show both badges; the lower "User" badge is stripped when a higher role exists.
- **Mobile messages not updating** — when the app returns to foreground (tab becomes visible), messages, channel list, and member list are now re-fetched automatically. Socket reconnects if disconnected.
- **Mobile menu buttons not appearing** — foreground resume now triggers channel/data refresh which re-initializes the UI state.

### Changed
- **Mute/Deafen icons** — mic mute button now shows a microphone icon (🎙️) with a red strikethrough when muted. Deafen button shows a speaker icon (🔊/🔇). Previously both used speaker icons which was confusing.
- **Flash games are now optional** — SWF ROM files (~37 MB) are no longer shipped with Haven. The Activities panel shows a "Download Flash Games" button that fetches them on demand (admin only). Haven itself stays under 5 MB.
- **Carousel interval** — website hero image carousel slowed from 2s to 4s and uses fixed aspect ratio to prevent page jumping.

### Added
- **E2E verification codes** — DM channels now show a 🔐 button in the header that displays a 60-digit safety number. Both users see the same code and can compare out-of-band to verify no one is intercepting their encrypted messages (like Signal).
- **E2E per-account key sync** — private keys are now wrapped with the user's password (PBKDF2, 600k iterations) and stored encrypted on the server. Keys sync across devices automatically on login.
- **Flash ROM download system** — server endpoints `/api/flash-rom-status` and `/api/install-flash-roms` allow checking and downloading Flash game ROMs on demand.
- **Win95 theme: beveled buttons** — all voice, sidebar, modal, and toolbar buttons now have proper 3D outset/inset borders in the Win95 theme.
- **Win95 scrollbar fix** — eliminated double arrow boxes on scrollbars by hiding Chrome's extra scrollbar-button pseudo-elements.
- **Ruffle Flash CSP fix** — added `wasm-unsafe-eval` and `unpkg.com` worker-src to Content Security Policy headers so Ruffle WASM can load.
- **Website updates** — new screenshots, E2E encryption in feature cards and comparison table, expanded games card, updated file sharing limit (configurable up to 1.5 GB).

---

## [1.8.0] — 2026-02-16

### Added
- **End-to-end encrypted DMs** — DM messages are now encrypted client-side using ECDH P-256 + AES-256-GCM. Private keys never leave the browser (stored with `extractable: false` in IndexedDB). Not even the server host can read DM content. Encrypted messages display a lock icon (🔒) on root messages. Editing a DM re-encrypts the content. Falls back to unencrypted if either party hasn't generated keys yet.
- **Server-wide invite code** — admins can generate a single code that grants access to every channel and sub-channel in the server at once. Generate, copy, and clear from Admin Settings.
- **Channel organize modal** — parent channels can now be reordered, categorized, and sorted just like sub-channels. New "Organize" button in the Channels sidebar header (admin-only).
- **Cloudflare Tunnel documentation** — comprehensive setup guide in GUIDE.md covering installation, configuration, and troubleshooting.
- **`/gif` slash command** — type `/gif <query>` to search GIPHY inline and send a GIF directly from the message bar. Results appear in a floating picker grid above the input; click any GIF to send it.
- **Music player seek bar** — YouTube and SoundCloud players now show a draggable seek slider with current/total time display. Spotify hides the seek bar (no embeddable API).
- **Configurable max upload size** — admins can set the per-file upload limit (1–500 MB) from Admin Settings. Default remains 25 MB. Enforced server-side per-request.
- **Flash games via Ruffle** — 5 classic Flash games (Flight, Learn to Fly 3, Bubble Tanks 3, Tanks, Super Smash Flash 2) playable in-browser via the Ruffle Flash emulator.
- **.io Games browser** — browse and play popular .io multiplayer games from the Activities panel.

### Changed
- **Win95 theme polish** — scrollbars now display proper beveled 3D rectangles with outset/inset borders. Channel header uses the classic blue gradient. Sliders use rectangular gray thumbs with outset borders and sunken tracks. Text turns white on navy-background hover/active states.
- **CRT theme / effect separation** — selecting the CRT theme now only applies the amber color scheme and VT323 font. The CRT scanline + vignette effect is a separate opt-in from the Effects panel, no longer auto-applied.
- **E2E lock icon consistency** — lock badge now appears once on root messages only (right-aligned in the header), not on every compact/grouped message.
- **SQLite performance pragmas** — added `synchronous = NORMAL`, `cache_size = -64000` (64 MB), `busy_timeout = 5000`, `temp_store = MEMORY` for significantly faster writes and reduced lock contention.

### Fixed
- **User status stuck on idle** — fixed race condition where the idle timer's server emit was async but the local status wasn't updated immediately, causing activity events to not restore "online" status.
- **YouTube embeds "Video unavailable"** — switched from `youtube-nocookie.com` to `youtube.com/embed/` with explicit `origin=` parameter and removed `referrerpolicy="no-referrer"`, which was blocking IFrame API communication.
- **Push notification "Registration failed"** — improved error messages with actionable guidance: use Cloudflare Tunnel, access via localhost, or install a real SSL certificate. Added self-signed certificate detection heuristic.
- **Sub-channel membership grandfathering** — joining a parent channel now auto-adds members to existing sub-channels.
- **Duplicate channel roles** — fixed de-duplication in role assignment and profile queries.
- **Cloudflare tunnel URL timeout** — increased detection timeout and tightened regex to exclude false positives.
- **Game iframe CSP** — added `'self'` to `frame-src` directive; extracted inline scripts to external JS files to comply with CSP.

---

## [1.7.0] — 2026-02-16

### Added
- **Role inheritance / cascading** — server-scoped roles now automatically apply in every channel and sub-channel. Channel-scoped roles cascade to all sub-channels beneath them. Sub-channel roles remain limited to that sub-channel only.
- **Voice dot role color** — the online dot next to users in a voice channel now matches their highest role color instead of always being green.

### Fixed
- **Transfer Admin modal** — completely redesigned with a proper warning box, clearer layout, and inline error styling.
- **Noise-suppression slider invisible track** — the slider track is now thicker (6 px) with a visible border, and the thumb enlarged to 14 px so it's easy to grab.
- **User hover tooltip translucency** — tooltip popup now uses an opaque background (`--bg-secondary`) with a solid box-shadow instead of blending into the page.

---

## [1.6.0] — 2026-02-15

### Added
- **19-permission role system** — fine-grained permissions for server and channel roles (send messages, manage channels, kick/ban, pin, upload files, etc.).
- **Channel Roles panel** — per-channel role management with create / edit / delete / assign UI.
- **Default "User" role** — every new server automatically seeds a level-1 User role so members always have baseline permissions.
- **Server icon upload** — admins can upload a custom server icon displayed in the header.
- **Admin transfer** — server owners can transfer full admin rights to another user (password-verified).
- **Promotion permission** — a dedicated `promote_members` permission controlling who can assign roles.
- **Level-based thresholds** — users can only assign/edit roles whose level is strictly below their own.
- **Auto-assign roles** — roles marked auto-assign are automatically granted to users when they join a channel.
- **Voice controls in right sidebar** — mute / deafen / noise-suppression / leave moved into a persistent sidebar panel at the bottom.
- **Per-user volume control** — right-click a voice user for an individual volume slider.
- **Header voice indicator** — a compact voice badge in the header shows your current voice channel and lets you leave.
- **CRT scan-line theme effect** — optional retro CRT overlay toggled from the theme menu.

### Fixed
- **Idle status** — idle detection now works correctly across all tabs.
- **Role dropdown clipping** — dropdowns in the Channel Roles panel no longer clip behind other elements.
- **Mobile sidebar** — improved touch handling and layout on small screens.
- **Settings z-index** — settings modal no longer appears behind other overlays.
- **Voice banner position** — the "you are in voice" banner no longer overlaps content.
- **Admin self-nerf prevention** — admins cannot demote or remove their own admin role.
- **Noise-suppression slider** — value now persists correctly across reconnects.

---

## [1.5.0] — 2026-02-14

### Added
- **Private sub-channels** — when creating a sub-channel, a 🔒 Private checkbox is available. Private sub-channels only add the creator as initial member (not all parent members) and show a lock icon in the sidebar. Only users with the code can join.
- **Auto-join sub-channels** — when a user joins a parent channel, they're now automatically added to all non-private sub-channels of that parent. Previously, only users present at sub-channel creation were added.
- **Create sub-channel modal** — replaced the basic browser `prompt()` with a proper modal dialog that includes a name field and private checkbox.
- **Avatar system overhaul** — profile pictures now upload via HTTP (`/api/upload-avatar`) instead of Socket.io, fixing the silent disconnect caused by base64 data URLs exceeding Socket.io's 64KB buffer limit. Avatar shapes (circle, square, hexagon, diamond) are now stored per-user in the database and visible to all users in messages.
- **Avatar Save button** — avatar changes now require explicit save instead of auto-saving, preventing accidental changes.
- **Cyberpunk text scramble effect** — replaced the old CSS glitch animation with a JS-powered text scramble that randomly cycles text through random characters before resolving. Affects the HAVEN logo, channel names, section labels, usernames, and the channel header.
- **Glitch frequency slider** — configurable scramble frequency when the cyberpunk effect is active. Saved to localStorage.
- **Expanded scramble targets** — the text scramble effect now hits sidebar text, channel headers, user names, and section labels (not just the logo).

### Fixed
- **Channel code settings gear icon never appearing** — `this.isAdmin` was used in 3 places but never defined; should have been `this.user.isAdmin`. The ⚙️ gear icon next to channel codes now correctly appears for admins.
- **`_setupStatusPicker` crash** — `insertBefore` was called on the wrong parent node, causing `Uncaught NotFoundError`. Fixed to use `currentUser.parentNode`.
- **Messages breaking after avatar save** — root cause was Socket.io's `maxHttpBufferSize: 64KB` silently killing the connection when large base64 avatars were sent. Moved avatar upload to HTTP.
- **Avatar resetting on reload** — avatars are now persisted server-side via HTTP upload and reloaded from the database on reconnect.
- **Avatar shape affecting all users** — shapes were previously a local-only preference. Now stored in the `users` table and sent per-message so each user's chosen shape is visible to everyone.

### Changed
- **`is_private` column** added to `channels` table (migration auto-runs on startup).
- **`avatar_shape` column** added to `users` table.
- Version bumped to 1.5.0.
- Updated README features table, roadmap, and GUIDE with comprehensive documentation on channels, sub-channels, join codes, avatars, and effects.

---

## [1.4.7] — 2026-02-13

### Fixed
- **YouTube "Video unavailable" for host** — the browser was sending a `Referer` header containing the page's localhost / private-IP origin, which YouTube blocks. Added `referrerpolicy="no-referrer"` to YouTube iframes so no referrer is sent.
- **No time bar on YouTube music player** — the transparent overlay that blocked direct clicks on the embed has been removed for YouTube (was already removed for Spotify). Users can now interact with YouTube's native seek bar, progress indicator, and controls directly.
- **YouTube play/pause desync** — added an `onStateChange` handler to the YouTube iframe API so Haven's play/pause button stays in sync when users interact with YouTube's native controls.
- **Profile picture upload silently failing** — the `<label for="…">` pattern was unreliable in some browser / modal contexts. Added explicit JS click handlers (with `preventDefault`) as a bulletproof fallback for both the Settings and Edit Profile avatar upload buttons.
- **Gray wasted space in stream area** — when all stream tiles were hidden, the stream container (with its 180 px min-height and black background) remained visible. Now it collapses automatically when no visible tiles remain, while the "streams hidden" restore bar stays in the header.

### Added
- **Late joiner screen share support** — users who join a voice channel after someone has started screen sharing now receive the stream automatically. The server tracks active screen sharers per voice room and triggers WebRTC renegotiation so late joiners get the video tracks.

### Changed
- Version bumped to 1.4.7.

---

## [1.4.6] — 2026-02-13

### Fixed
- **Voice panel empty on channel switch** — switching to a DM and back no longer shows an empty voice user list. The client now requests the voice roster whenever changing channels.
- **Spotify embed unresponsive** — removed the click-blocking overlay that prevented all interaction with the Spotify player. Spotify embeds now allow direct click-through for play, pause, and song selection.
- **Spotify not playing for other users** — added `autoplay=1` parameter to the Spotify embed URL so playback starts automatically for all voice participants, not just the sharer.
- **Spotify play/pause destroying embed** — Haven's play button no longer blanks the iframe and reloads it. Spotify pause now stores the src for clean resume.
- **Profile picture upload broken** — the avatar upload `<label>` already triggered the file input natively via its `for` attribute; a redundant JS `.click()` call was causing a double-open that silently broke the `change` event. Removed the duplicate handler.
- **Stream viewer cut off on start** — streams now auto-apply the saved size on first display so they don't start at an inconsistent height.
- **Stream size slider jerky / hard to drag** — replaced raw per-frame DOM style updates with debounced resizing. The slider is now wider with a visible track bar, labeled, and drags smoothly.
- **Changelog dates from the future** — corrected twelve changelog entries that had dates of Feb 14–16 (future) or 2025 (wrong year). All dates now reflect their actual release day.

### Added
- **PiP opacity slider** — music player and stream pop-out windows now have an opacity slider (👁 20–100%) so you can see through them while gaming or browsing. Preference is saved to localStorage.
- **Spotify volume disclaimer** — when Spotify is the active music source, the Haven volume slider shows a tooltip indicating volume must be controlled within the Spotify embed (no external API available).

### Changed
- **Stream pop-out is now in-page** — stream windows pop out as draggable floating overlays (like the music PiP) instead of new browser windows, enabling opacity control and eliminating pop-up blocker issues.
- Version bumped to 1.4.6.

---

## [1.4.5] — 2026-02-12

### Fixed
- **SSL_ERROR_RX_RECORD_TOO_LONG on Windows** — `Start Haven.bat` always opened the browser with `https://` even when the server was running in HTTP mode (no valid SSL certs). The batch file now detects the actual protocol and opens the correct URL. ([#2](https://github.com/ancsemi/Haven/issues/2))
- **Unreliable OpenSSL detection in Start Haven.bat** — the `%ERRORLEVEL%` check inside a parenthesized `if` block was evaluated at parse time (classic cmd.exe bug), so the batch file could report "SSL certificate generated" even when OpenSSL wasn't installed. Replaced with `if errorlevel 1` (runtime-safe) and added a file-existence check after generation.

### Improved
- **Troubleshooting docs** — added SSL/HTTPS troubleshooting to both README and GUIDE, covering the `SSL_ERROR_RX_RECORD_TOO_LONG` error, how to tell if you're running HTTP vs HTTPS, and how to install OpenSSL on Windows.

---

## [1.4.4] — 2026-02-12

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

## [1.4.3] — 2026-02-12

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

## [1.4.2] — 2026-02-12

### Fixed
- **Admin status & display name lost on reconnect** — the socket auth middleware now refreshes both `is_admin` and `display_name` from the database on every connection, instead of trusting the JWT payload which could be stale. Additionally, admin status is synced from `.env ADMIN_USERNAME` on every socket connect (not just login), so `.env` changes take effect without requiring a re-login.
- **Server pushes authoritative user info on connect** — a new `session-info` event fires on every socket connect/reconnect, overwriting the client's `localStorage` with the server's truth (id, username, isAdmin, displayName). This prevents stale or corrupted local data from hiding the display name or admin controls.

---

## [1.4.1] — 2026-02-12

### Added
- **Independent voice & text channels** — voice and text are now fully decoupled, matching Discord's model. You can be in voice on one channel while reading/typing in another. Voice persists across text channel switches. The server uses dedicated `voice:<code>` socket.io rooms so voice signaling and updates reach participants regardless of which text channel they're viewing.
- **Sidebar voice indicators** — channels with active voice users show a 🔊 count badge in the left sidebar, so you can see at a glance where people are talking without clicking into each channel.
- **Roadmap section in README** — planned features (webhooks/bots, permission levels, threads, file sharing, E2EE) are now listed in a roadmap table.

### Fixed
- **Mobile input field sizing** — shortened placeholder to "Message..." on narrow screens, reduced button sizes from 40 px to 34 px, tightened padding, and lowered the auto-resize cap to 90 px. The input no longer starts too small or jumps to an awkward height on tap.
- **Mobile header voice overflow** — voice controls no longer wrap to a second line and get cut off. Removed `flex-wrap`, compacted button labels ("🎤▾" instead of "🎤 Voice ▾" on ≤ 768 px), and allowed the controls container to shrink.
- **Voice updates reaching wrong clients** — `broadcastVoiceUsers` previously emitted only to the text-channel room (`channel:<code>`), so users in voice who had switched text channels missed updates. It now emits to both `voice:<code>` and `channel:<code>`.

---

## [1.4.0] — 2026-02-12

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

## [1.3.9] — 2026-02-12

### Fixed
- **Slash commands working after every deploy** — static file caching dropped from 1 h to always-revalidate (ETag). Previously, browsers could serve stale JS for up to an hour after a server restart, causing commands and other new features to appear broken.

### Improved
- **Mobile message actions — tap to reveal** — react, reply, pin, edit, and delete buttons are now hidden until you tap a message, drastically reducing clutter on phone screens. Tap another message to move the toolbar; tap empty space or the input to dismiss.

---

## [1.3.8] — 2026-02-12

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

## [1.3.7] — 2026-02-12

### Fixed
- **Voice leave audio cue** — leaving voice chat now plays the descending tone (matching the cue other users already heard) so you get audible confirmation.
- **Stream ghost tiles cleaned up on leave** — all screen-share tiles are properly destroyed when leaving voice. Previously, tiles persisted with dead video sources and showed black screens when restored.

### Added
- **"Left voice chat" toast** — a brief info toast confirms you disconnected, mirroring the existing "Joined voice chat" toast.
- **Escape closes all modals** — pressing Escape now dismisses every open modal overlay (settings, bans, leaderboard, add-server) in addition to the search and theme panels it already handled.

---

## [1.3.6] — 2026-02-12

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

## [1.3.5] — 2026-02-12

### Changed
- **Noise suppression → sensitivity slider** — replaced the on/off NS toggle button with an adjustable slider (0–100). Sensitivity maps to the noise gate threshold (0 = off, 100 = aggressive gating). The slider sits inline in the voice controls when in a call.
- **Custom theme overhaul** — the triangle colour picker now dramatically affects the entire UI. Backgrounds, text, borders, links, glow effects, and even success/danger/warning colours are all derived from the chosen hue. The `vibrancy` parameter (used internally) controls how saturated the backgrounds and text become — the triangle’s saturation/value selection now produces visibly different themes instead of only tweaking subtle highlights.

### Added
- **RGB cycling theme** — new 🌈 RGB button in the theme selector. Continuously shifts the entire UI through all hues like gaming RGB peripherals. Two sliders control **Speed** (how fast it cycles) and **Vibrancy** (how saturated/tinted the backgrounds and text become). Settings persist in localStorage.

---

## [1.3.4] — 2026-02-12

### Added
- **Noise suppression (noise gate)** — Web Audio noise gate silences background noise (keyboard, fans, breathing) before sending audio to peers. Runs at 20 ms polling with fast 15 ms attack / gentle 120 ms release. Toggle on/off with the 🤫 NS button in voice controls (enabled by default).
- **Persistent voice across channels** — joining voice in one channel no longer disconnects when switching text channels. A pulsing green voice bar in the sidebar shows which channel you're connected to, with a quick-disconnect button. Voice controls dynamically show/hide based on whether the active text channel matches your voice channel.
- **Server leaderboard** — new 🏆 Leaderboard button in the sidebar opens a modal showing the top 20 Shippy Container scores server-wide, complete with medal indicators for the top 3.

### Fixed
- **Shippy Container frame-rate physics** — game physics normalised to a 60 fps baseline using delta-time scaling. Players on 144 Hz (or any refresh rate) monitors now experience identical gravity, pipe speed, and spawn timing as 60 Hz players. Pipe spawning switched from frame-count based (every 90 frames) to time-based (every 1.5 s). Scale capped at 3× to prevent teleportation on tab-switch.

---

## [1.3.3] — 2026-02-12

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
