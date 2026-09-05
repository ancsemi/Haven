# Changelog

All notable changes to Haven are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/). Haven uses [Semantic Versioning](https://semver.org/).

> **Deploy checklist** — after committing changes:
> 1. `git push origin main` — pushes code **and** GitHub Pages site (`docs/`)
> 2. `website/index.html` is auto-synced from `docs/index.html` — keep them identical
> 3. Restart the Haven server to pick up `server.js` / `socketHandlers.js` changes

---

## [Unreleased]

### Fixed
- **Cloudflare Tunnel on Windows never worked out of the box.** The installer's Cloudflare
  option says "auto-downloads cloudflared", but nothing downloaded it and the tunnel module
  only ever ran `cloudflared` from PATH, so a fresh install that picked Cloudflare always
  ended in "cloudflared binary not found in PATH" (reported by a self-hoster 2026-09-05).
  The tunnel module now looks on PATH, then in `<data dir>/bin`, and fetches the official
  release binary into that folder on first start when neither has it (Windows and Linux;
  macOS gets a `brew install cloudflared` hint). A failed download says exactly which file
  to drop where. The installer pre-fetches the same file when Cloudflare is chosen.
- **A refused port on Windows now says why.** `EACCES` on Windows is almost always a port
  inside a Hyper-V/WSL reserved range rather than a privilege problem; the startup error
  now points at `netsh interface ipv4 show excludedportrange protocol=tcp` and the
  `winnat` restart instead of only mentioning ports below 1024.

### Added
- **Copy an invite as an email card (#5559).** Each invite link has an envelope
  button that copies a formatted invitation, in your theme and language and with
  the server's branding, ready to paste into an email. Thanks to @birdcrazy.
- **Markdown keyboard shortcuts (#5571).** With text selected, Ctrl/Cmd+I, Ctrl/Cmd+B,
  Ctrl/Cmd+Shift+C, Ctrl/Cmd+Shift+X and Ctrl/Cmd+Shift+P wrap it in italic, bold,
  code, strikethrough and spoiler markers. Works in the message box, threads, PiP
  DMs and the message editor, which also gets the paste-a-link-over-text shortcut.
  Thanks to @birdcrazy.

### Fixed
- **Replying to a bot showed [Deleted User] as the author (#5564, #5566).** Reply
  banners now name webhook bots, imported messages and personas the same way the
  message itself does. Thanks to @delenda-delenda.
- **Emoji in soundboard names vanished after saving (#5565, #5567).** Upload and
  rename stripped everything outside ASCII. Names now keep letters in any script,
  emoji, flags and keycaps. Thanks to @delenda-delenda.
- **Picking a Messages sound previewed nothing while the Notifications toggle was
  off,** which is the default, so a new account could not try the sounds out. The
  settings preview plays regardless of the toggle; the toggle still decides what
  plays for real messages.
- **Stream and video announcement bots bridged through Ferry lost their link and
  thumbnail.** CouchBot-style promotion bots type the ping line ("X is now live")
  and put the stream link, title, and thumbnail in a rich embed. Ferry only read
  the embed when the Discord message had no text, so Haven got the ping line and
  nothing to click or look at. Rich (bot-composed) embeds are now read alongside
  the typed text: the Twitch / YouTube / Kick link and the thumbnail come through
  with it. The promoted link is checked against the link policy on its own, so an
  allowlist server that has not added a host (kick.com is not in the starter list)
  drops just that link and still relays the announcement and its picture. Discord's
  own unfurl of a typed link is still ignored so Haven does not preview it twice.

### Changed
- **Admin settings visibility comes from one access table (#5558).** Which
  sections a moderator sees is now decided in one place instead of a dozen
  special cases, and Auto-Mod, Guest Access and Stickers have their own entries
  in the admin navigation. Thanks to @birdcrazy.

---

## [4.3.0] - 2026-09-03

Forum channels and self-serve Groups are the big two, the whole interface is
translatable now, and a large batch of contributor work landed alongside them: a
Compact theme and layout, listening presence from your music player, the encryption
groundwork for group DMs, GIPHY back as the GIF provider, and images that phones could
see but desktops could not. No migration steps: the one new database column is added
on first start.

### Added
- **Forum channels (#144).** Any channel can be a forum: tick Forum when creating it,
  or flip it in Channel Functions. Every message in a forum channel is a topic, replies
  go in that message's thread with a reply count shown on the topic, and a new reply
  bumps the topic back to the newest end of the channel, right above the message box,
  so old topics resurface instead of sinking. Requested by @ArtyDaSmarty and shaped in
  the community chat.
- **Groups, roles people join themselves (#5548).** A role at level 0 is a Group.
  Members pick their own Groups from their profile settings, see which channels each
  one grants, and can leave again, with no moderator involved. Thanks to @birdcrazy.
- **The whole interface is translatable (#5551).** Every hardcoded string in the client
  now goes through the language files, with Portuguese carried along and the other
  languages falling back to English one string at a time. The tests treat English as
  the base, so adding an English string no longer requires writing the Portuguese for
  it. Thanks to @bernardokcosta.
- **Compact theme and Compact Layout plugin (#5549, #5552).** A dense graphite Theme
  API v1 theme, and an optional plugin that folds the server rail into the sidebar and
  docks account and voice controls in its footer, switchable with Ctrl+Alt+C. Both are
  off by default. Structural plugins now share one layout owner, so Braid and Compact
  hand the layout back and forth cleanly. Thanks to @bernardokcosta.
- **Theme safe mode (#5545).** If a theme or plugin makes the page unusable, open
  `/app.html?haven-safe-mode=1` to load without them and reset your choices.
  Thanks to @bernardokcosta.
- **Listening presence (#5523).** Your profile card can show what you are playing. A
  music player that can run a plugin or a script (Havidrome for Navidrome is the first)
  posts to a personal webhook URL from Settings, Activity, and the card shows the track
  with cover art and a live progress bar. The contract is in `docs/listening-api.md`.
  Thanks to @Bo0sted.
- **Group DM encryption groundwork (#5499).** The crypto core and key distribution for
  end to end encrypted group DMs, with a test suite written as attacks rather than happy
  paths. No interface yet. Thanks to @Amnibro.
- **Voice connectivity test (#5542).** Admin settings can now test the STUN and TURN
  servers Haven will use and say which ones answer, and the TURN troubleshooting notes
  point there first.
- **Paste a link over selected text to make a markdown link (#5553).** Works in
  channels, threads and DM windows. Thanks to @birdcrazy.
- **One right-click menu for people (#5554).** Right-clicking a name in the member list
  or on a message opens one menu with the profile actions and, for moderators, the
  role, channel and moderation actions behind a divider. Clicking an avatar on a profile
  card opens it full size. The hover preview card stays, with a switch under Settings,
  Chat to turn it off, and the gear buttons stay and open the same menu. Thanks to
  @Bo0sted.
- **Braid spacing levels (#5494).** Compact, Cozy and Spacious, plus readable ink on the
  Android badge. Thanks to @Amnibro.

### Changed
- **Full image mode uses the whole message width.** The largest image setting was
  capped at well under half of a desktop chat pane, so it never read as large.
- **invite_users opens the Admin tab (#5470).** Holders of that permission saw an Admin
  tab that did nothing when clicked. The three places that gated it now share one check.
- **GIPHY is the supported GIF provider again (#5546).** Tenor is no longer offered for
  new setups; an existing Tenor key keeps working if no GIPHY key is set. Thanks to
  @Amnibro.
- **`npm test` runs the suite serially,** so a green run means what it says.
- **Website:** desktop download links point at Desktop 1.4.29.

### Fixed
- **Images that showed on Haven Mobile were blank on desktop (#5550).** Signed Discord
  links from Ferry and bots were escaped before the media proxy fetched them, so they
  404ed. Thanks to @Amnibro.
- **Screen share and webcam teardown on leaving voice (#5426).** Leaving voice used to
  fire renegotiations at peers that were about to close, and a stale continuation could
  wipe out a share started right after rejoining. Per-peer work also runs concurrently
  now instead of one viewer at a time. For anyone still seeing stutter through a TURN
  relay there is an opt-in Debug toggle, Gentler screen share for relay connections, to
  try and report back on.
- **Braid grouped main channels into the wrong sub-channel card (#5507).** Thanks to
  @Amnibro.
- **A direct message with someone you also share a group DM with** always opens the
  direct message, not the group.
- **Profile saves no longer clear your Groups, and Group channel lookups no longer leak
  private channel names (#5548).**
- **The listening webhook checks its token before reading the upload (#5523),** and the
  open profile card only redraws when something on it actually changed.

---

## [4.2.0] - 2026-09-01

Voice connectivity is the theme. A server whose admin had set their own STUN server
could lose calls between browsers entirely from one typo, with nothing anywhere saying
why, and it took the people who reported it days to work out what was happening. Also
a written contract for theme authors, a way for bots to clear messages in bulk, and a
dependency sweep that clears everything npm audit was flagging. No migration steps.

### Added
- **Themes have a written contract now (#5544).** Custom themes kept breaking on Haven
  updates because nothing said which parts were safe to build on. Theme API v1 names the
  variables and hooks that will not change without a major version, with an authoring
  guide and a test that fails the build if the contract drifts.
- **Bots can clear messages in bulk (#5541).** One call deletes up to 100 recent messages
  in the bot's channel instead of a request per message, with attachments and thread
  replies cleaned up properly. Thanks to @bernardokcosta.
- **Haven checks the STUN servers an admin configures (#5542).** Only the built-in ones
  were ever tested, so a list of your own was taken on trust. Dead entries are named in
  the browser console, and if every one is unreachable with no TURN set, the existing
  connectivity warning says so.

### Fixed
- **One wrong STUN server no longer takes out voice between browsers (#5542).** Setting
  your own STUN servers replaces Haven's built-in ones rather than adding to them, so a
  single bad entry left browsers unable to find each other across networks while phone
  clients carried on working. That combination reads as Haven breaking web calls rather
  than as a wrong address, which is exactly how it was reported. If every configured
  server is unreachable and there is no TURN relay, Haven now falls back to its own for
  that session. Your setting is left exactly as you saved it, and the warning still names
  what to fix. Found by @Vinylwalk3r, @birdcrazy and @dronostyka between them.
- **eturnal and coturn setup notes,** with the one setting people miss called out in both.

### Security
- **Cleared 12 dependency advisories, 7 of them high.** Two sit directly under the chat
  transport rather than off in build tooling: the websocket library could disclose
  uninitialised memory and be driven to exhaust memory, and the Socket.IO parser could be
  exhausted through binary attachments. Every Haven message travels through both. Lockfile
  only, and nothing crossed a major version.

---

## [4.1.0] - 2026-08-30

Mostly hardening and follow-through on 4.0.0, plus bots can play audio in voice now.
Two of the fixes below are worth updating for on their own: deleted attachments were
still downloadable, and bot message deletion was throwing where nobody could see it.
No migration steps.

### Added
- **Bots can play audio into a voice channel (#5540).** A bot with voice permission can
  upload an MP3, WAV or OGG through the webhook API and have it played to everyone in the
  channel it is sitting in, with a queue, skip and stop. Files are checked by their actual
  bytes rather than their extension, capped at 10 MB and 5 minutes, served only through a
  short-lived link tied to the current track, and deleted as soon as they finish playing.
  Nothing is kept across a restart. Thanks to @bernardokcosta.
- **Gentler screen share for relay connections (Settings, Debug).** For the long-running
  screen-share desync over TURN in #5426. Lowers the video bitrate and lets the encoder
  drop frames rather than hold framerate and build a backlog, which is the wrong tradeoff
  once a relay falls back to TCP. Off by default and only the person sharing needs it, so
  please try it and say whether it holds.
- **eturnal documented as a TURN alternative,** with the setting people miss called out in
  both it and coturn (#5542).

### Security
- **Deleted attachments were still downloadable (#5540 review).** Moving a file into
  deleted-attachments is how Haven takes it away, and the guard could be walked past with
  three different spellings of the same path. Filenames do not change when a file is moved
  there, so anyone who saw an attachment while it was posted could still fetch it
  afterwards. Deleting a message now actually revokes the file.
- **Registration could hand out admin on a server that already had one (#5539).**
  `ADMIN_USERNAME` is meant to bootstrap the first admin and nothing more, which is how
  login already treated it, but registration promoted on the username alone. Rename the
  admin account or remove it while another admin holds the server, and the next person to
  register the old name arrived as a second admin. First-run setup and genuine
  re-bootstrapping are unchanged.

### Fixed
- **Attachment cleanup was throwing on every path that ran it from `server.js`.** A missing
  import meant the retention sweep and the orphaned-channel cleanup silently never
  relocated anything, and a bot deleting one of its own messages with an attachment
  returned a 500 with the message already gone from the database but still on everyone's
  screen until they reloaded.
- **Screen shares that stopped reaching other people (#5543).** Renegotiation offers above
  16 KB were rejected without a word, and a sender whose answer went missing stayed stuck
  until it rejoined the call. Offers and answers are now correlated, an unanswered one
  rolls back and retries with a budget, and the size limit is raised while staying clear of
  the transport's own frame limit. Thanks to @bernardokcosta.
- **An SSO admin could not hand over admin at all (#5539).** Transfer Admin asks for a
  Haven password, and an account that signs in through OIDC has none, so on an SSO-only
  server the feature was closed rather than awkward. Those accounts confirm with their
  authenticator code instead, with two-factor required first.
- **Two memory leaks in the client (#5426).** Decrypted images in DMs never released their
  blobs, so scrolling a media-heavy conversation locked up memory for the life of the tab,
  and the custom dropdowns added a document listener per open that was never removed. Both
  found by @RCCore.
- **Ferry relayed image-bot posts as links instead of pictures.** SaucyBot and similar post
  the image as an embed, and only the summary was coming across, so Haven had a link to
  unfurl rather than a picture to show. Reported by Raidenphantom.
- **Theme picker inconsistencies (#5536, #5537).** Several bundled themes were missing from
  the admin Default Theme list, the login page showed a different set again, and the button
  for the active theme did not read as active. Thanks to @birdcrazy. The login page also
  stopped pinning whichever default a visitor happened to see first, so changing the server
  default now reaches people who have not signed in.
- **"Automatic" in the language picker now names the language it resolved to (#5538),** so
  a server default that is being applied correctly no longer looks like it is being ignored.

## [4.0.0] - 2026-08-27

This is a big release, and the version reflects that. There are no migration steps and
nothing to reconfigure: the database changes only add to what is already there, and the new
Discord bridge arrives switched off, so a server that updates keeps working the way it did.
It does touch shared ground, including the path every message takes on its way out, so take
a backup before you update (Settings, Server Admin Settings, Backup) the way you would with
any large release. Ferry in particular is brand new and has not been through a real
deployment yet, so please report anything that looks off.

### Added
- **Ferry, a two-way bridge between Haven and Discord.** Haven channels can now be paired
  with Discord channels, and messages cross in both directions. A relayed message shows up
  on Discord under the Haven author's own name and picture rather than as one anonymous
  bot, and Discord messages arrive in Haven with the sender's name and avatar. Each pairing
  picks its own direction, either two-way or one-way, and whether it mirrors every message
  in the channel or only the ones a member deliberately addresses with the `=>` prefix, with
  autocomplete for picking a destination. There is also an opt-in one-way Discord DM. Set it
  up in Settings, Server Admin Settings, Ferry: it walks you through creating the Discord
  bot, and the whole thing runs inside Haven, so nothing new has to be exposed to the
  internet. Sending is gated behind a new Send to Discord role permission which starts off
  for everyone, so nobody can reach another server's Discord until you say so. Pings are off
  by default, and `@everyone` stays blocked even when you turn them on. Set `PUBLIC_URL` in
  your `.env` if you want Haven avatars and images to appear on the Discord side.
- **Search is now a panel instead of a takeover.** Results open over the member list the way
  Discord does it, the panel survives channel switches and closes only when you close it,
  public channels share one panel, and each DM keeps its own.
- **A secure voice gateway for bots (#5531).** Bots can join voice with access that is
  scoped and granted deliberately rather than assumed.
- **A RepoCloud deploy button (#5532).** One more hosting route for people who would rather
  not run the server themselves.

### Fixed
- **The welcome screen no longer hides behind the server banner.** On the no-channel-selected
  view, "Welcome to Haven" was rendering underneath the banner image. It had been that way
  since banners shipped.
- **Steam and Spotify linking works for accounts that have changed their password.** Linking
  failed with "Link session expired" for anyone who had changed their password, had an admin
  reset it, or used a recovery code. New accounts were unaffected, which is why it looked
  random rather than broken.
- **Channel code rotation leaves clients in a working state (#5521, #5525).** Rotating a
  channel's code could leave the people already in it holding a stale one, and voice now
  recovers properly afterwards too.
- **The docked soundboard handle points the right way.** Its arrow was mirrored against the
  members handle directly above it, and its position on mobile was wrong.
- **Invite link refinements (#5524).** An invite whose uses are all spent now reads as used
  rather than sitting there saying Active until it expires, and the expiry dropdown is wide
  enough for its longest option.

### Changed
- **Admin settings are grouped.** The admin sidebar was twenty entries in one flat run while
  the user side already had headings. It is now sorted into Server, People & Access, Content,
  Integrations, and Maintenance, with related entries sitting together. Nothing was removed.
- **Admins can clear an integration key, not just overwrite it (#5529).**
- Added josolanes to the donor credits.

---

## [3.50.0] - 2026-08-25

### Fixed
- **Steam and Spotify account linking works again (#5527).** Clicking Link opened a window that said "Internal server error" and nothing else, on every server. Two files had ended up requiring each other in a loop, so one of them started up holding an empty copy of the other and the token check it needed was simply missing. It has been broken since 3.45.0, which went unnoticed because the failure only appears at the moment somebody clicks Link, not at startup. Existing API keys and settings need no changes. Reported by @birdcrazy.
- **Images and GIFs stop vanishing on a tab left open for days.** Remote images are fetched through Haven rather than directly, so the sender's link cannot see who viewed it, and that used a pass that expires after about two days. It was collected once when the page loaded and never renewed, so a browser tab left open over a weekend quietly lost the ability to load any new remote image, GIFs from the picker included, leaving a blank gap where the picture should be. Reloading fixed it, which is exactly why it looked random. The pass now renews on a timer, on reconnect, and one more time automatically if an image fails anyway.
- **Automatic language selection (#5522).** Haven did not reliably pick up the language your browser is set to. Contributed by @bernardokcosta.

### Added
- **Find someone in the member list without scrolling.** There is now a search box above the member list in the right sidebar. It filters as you type, Escape or the small cross clears it, and the Online and Offline counts show how many people matched rather than the full total.
- **Members are ordered by role instead of purely alphabetically.** Admins and moderators now sit at the top of the member list, with names ordered alphabetically inside each role level, so the people who can actually help are where you would look for them. Online and offline stay separated as before, and anyone who has hidden their role badge is not given away by their position. Suggested by @birdcrazy.
- **See what is signed in to your account, and sign the rest out.** Settings has a Sessions pane listing the devices with Haven open right now, showing the browser, the address it is connected from and how long it has been there, with your current one marked. Alongside it is a button that signs out every other device, which asks for your password first so someone at your unlocked screen cannot lock you out of your own account. Because a device that is signed in but closed will not appear in the list, that button is the thing to use if you think somebody else has your account. Suggested by TGS.
- **Freeze animated images in chat (#5526).** Looping GIFs in a busy channel can be hard to read past. Settings now has Animated Images in Chat, with the same three choices as the animated avatar setting: leave them looping, play only while you point at one, or show the first frame and nothing more. It affects only what you see. It is set to leave them looping unless you change it, on the grounds that a GIF is something a person chose to post rather than background decoration. Requested by @birdcrazy.
- **Profile picture borders, and a say in whether avatars animate (#5510).** Contributed by @Bo0sted.

### Security
- **Signing out really signs out.** Changing your password disconnected your other devices and looked like it had worked, but the old sign-in stayed valid for direct requests to the server, so someone who had got hold of it could keep using it. Anyone who changed their password *because* their account was compromised would have watched the intruder disappear and still left them a way in. Both halves are now checked in the same place, so an old sign-in stops working everywhere at once. Found while building the sessions pane above.

### Documentation
- **Voice over a shared-device Tailscale setup (#5518 follow-up).** The Tailscale method shares one machine, but Haven voice is peer-to-peer and needs a path between every pair of people in the call, not just to the host. The result is one-directional audio: everyone hears the host, the host hears nobody. The guide now explains why and gives the two fixes, adding a TURN server or putting everyone on the same tailnet, along with the tradeoff between them.
- **Spotify rich presence needs a Premium account (#5528).** Spotify restricted its Web API to paid accounts, and Haven's setup steps still told people a free account was fine, so anyone following them hit a wall several steps in with no explanation. The steps and the README now say so up front. Last.fm remains the recommended music source and has no such requirement. Reported by @birdcrazy.

## [3.49.0] - 2026-08-22

### Added
- **Haven speaks Brazilian Portuguese (#5516).** The eighth language out of the box, and the only one currently translated in full: every one of the 1,634 phrases in the interface, where the other locales still fall back to English in places. The first pass was machine-generated and then reviewed line by line by a native speaker, which is the part that matters. Contributed by @bernardokcosta.
- **See how much upload storage each member is using.** Admins had no way to tell who was filling the disk short of going through the uploads folder by hand, which meant a server could not answer the simple question of whether one person was using more than their share. All Members now shows a size per member, with a breakdown of channels, DMs and avatars behind a tooltip, a filter that ranks everyone by storage used, and a running total for the server. Sizes are read from disk when the list is built, so deleting a file drops it from the count with no bookkeeping to fall out of step. Moderator-only, and files uploaded before this show as an unattributed total rather than being guessed at. Direct message attachments are encrypted, so only their size is known, never their contents. Suggested by TGS and bo0sted.
- **Google can be taken out of the picture (#5514).** Two connections nobody could opt out of are gone. The fonts are now bundled with Haven instead of being fetched from Google Fonts on every visit, and the Content-Security-Policy has been tightened so they cannot quietly come back. The Google STUN servers have been dropped from the voice fallback pool, which now runs on three independent providers. Mobile push is a separate matter, since Google is what wakes an Android phone, so it gets a switch instead: Settings, Security, FCM Privacy. Turning it off skips FCM entirely and leaves browser notifications alone, so only turn it off if everyone on your server has a UnifiedPush app installed. Contributed by @Bo0sted.
- **Invite links can stand in for the registration token (#5508).** On a server with the registration token switched on, an invite link still left the recipient facing a box asking for a code they did not have. There is now an admin switch that lets a valid invite link register on its own, off by default. An invite link arriving at the sign-in page opens the registration tab straight away, and a link that turns out to be expired or used up puts the token box back rather than leaving the person stuck. New links now default to a single use and 30 days rather than unlimited and never. Contributed by @birdcrazy.
- **Bots on your own network can be called back (#5518).** Haven refuses to send webhook callbacks to private addresses, which is right by default but blocked the ordinary case of a bot running on the same LAN or in a neighbouring Docker container. Setting `HAVEN_ALLOW_PRIVATE_CALLBACKS=true` allows them. It is deliberately an environment variable and not a switch in the admin panel, because setting a callback URL only needs the webhook permission rather than full admin, so a switch in the interface could be flipped by the very account the guard exists to contain. Cloud metadata addresses stay blocked either way. Reported by @josolanes.
- **Admins are told when the disk reserve runs out (#5505).** The reserve added in 3.48.0 keeps a server recoverable, but the only sign it had kicked in was a line in the server log and an error for whoever happened to try an upload, so an admin not watching either found out when people started complaining. Admins now get a warning in the header the moment uploads start being refused, with the free space and the reserve size behind it, and it clears itself once there is room again. Admins only, and it does not nag: it appears when the state changes, not on a timer. Reported by @KentuckyFriedBlyat.

### Fixed
- **Banned users no longer turn up in @mention autocomplete.** The list feeding autocomplete joined users to channel membership without checking for a ban, and banning deliberately leaves those rows alone so that unbanning restores membership, so a banned person kept appearing as a suggestion. They now disappear the moment the ban lands, for people already sitting in the channel rather than only after switching away and back.
- **Channel lists refresh after a main channel is deleted (#5519).** Every other change to a channel told everyone's sidebar to update, and deletion was the one that did not, so a deleted channel sat there until something else happened to refresh it. Contributed by @birdcrazy.
- **Last.fm album art loads again (#5515).** Last.fm began serving cover images from a subdomain that was not on the allowlist, so the art came back blank for anyone using it for music presence. Contributed by @Bo0sted.

### Security
- **Webhook callbacks are much harder to point somewhere they should not go (#5520).** The old check read the callback address as text, which meant it could be walked around by writing the same address a different way, and it never looked at what a hostname actually resolved to. It now rejects addresses written in decimal, hexadecimal or octal, the IPv4-in-IPv6 forms, and URLs carrying credentials; it inspects every address a hostname resolves to and refuses the lot if any of them is private; it pins the connection to the address that passed the check, so a second DNS answer cannot swap in a private one after the fact; and it does not follow redirects. One deadline now covers name lookup and delivery together. Contributed by @bernardokcosta.
  - **Worth knowing if you run Haven in Kubernetes or Docker:** because hostnames are now resolved and checked, a callback pointing at something like `http://mybot.default` that lands on an internal address will be refused where it previously went through. Set `HAVEN_ALLOW_PRIVATE_CALLBACKS=true` to keep it working.

### Documentation
- **Point `SSL_CERT_PATH` at `fullchain.pem`, not `cert.pem`.** With Let's Encrypt or certbot, `cert.pem` holds only your own certificate and leaves out the intermediate one above it. Browsers quietly paper over the gap by fetching the missing piece themselves, so the site looks fine in Chrome while curl, link checkers and various mobile and API clients reject it. Haven's own setup script already copies the right file, so this only affects anyone setting the path by hand.
- **Background images in custom themes.** Documented how to set one, which was possible but not written down anywhere.

## [3.48.0] - 2026-08-19

### Added
- **Every thread in a channel, in one list (#5506).** Threads were only reachable from the message that started them, so finding one again meant scrolling the channel back to wherever it began. There is now a thread button beside the files and media button in the channel header. It lists every thread in the channel with who started it, how many replies it has, when it was last active and a preview of the opening message, and a search box filters on the text or the author. Picking one jumps to the message and opens the thread. Sorted by most recent reply, so whatever is still alive sits at the top. Not shown in DMs, since that content is encrypted and the server has nothing readable to list. Collected and mocked up by @birdcrazy.
- **Display names in any script (#5509).** Display names were limited to English letters and digits, so anyone whose name is not written in Latin script had to transliterate it. They now accept letters, numbers and accent marks from any script, so Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew and the rest all work, and the 2 to 20 limit counts characters as you see them rather than as the computer stores them. What the old rule was quietly protecting is kept: no dots or slashes, so a display name still cannot be a working link, and no invisible characters, so two names cannot look identical while being different and nobody can flip the sidebar backwards. Requested by @Amatsutsumi.
- **A role permission for seeing every channel (#5512).** Linking channels to a role only covers the channels you remember to tick, so a server-wide Mod role still needed adding to each new channel by hand. There is now a permission that means exactly what it says: holders see every channel, including ones created later, without anyone keeping a list. Only the server owner can grant it, since it reveals private channels, and taking it away takes the access back rather than leaving a former moderator sitting in every private channel. Contributed by @Amnibro, asked for by a self-hoster running a community server.
- **Haven now keeps disk space in reserve (#5505).** A full disk did not just stop uploads, it wedged the server: deleting a message is itself a write, so an admin could not clear the files that filled the disk, and the way out was closed. Haven now refuses to hand out the last of the space, keeping 512 MB free by default so there is always room to delete things. Set `HAVEN_DISK_RESERVE_MB` if that does not suit your setup. Chat is deliberately unaffected, since a server that stops accepting messages is a poor way to learn your disk is full. Reported by @KentuckyFriedBlyat.
- **Invite buttons on the member lists (#5496).** Inviting someone used to mean finding the invite section in Settings. There are now buttons in the user list and All Members, shown only to people who are actually allowed to invite. Contributed by @birdcrazy.
- **A cancel button on uploads in progress.** The progress bar above the composer had no way to stop an upload once it started, so a wrong or oversized file had to finish before anything else could be sent. Cancelling now aborts every file in flight, including the rest of a queued batch, and reports as a plain notice rather than an upload failure.

### Fixed
- **Signing in through Authentik and other providers that keep the trailing slash (#5501, #12).** Haven was stripping the trailing slash off the identity provider address when it read the setting back, so what you typed was stored correctly but never matched what the provider published, and sign-in failed with the provider unreachable. It now works whether or not the address ends in a slash, and the sign-in token is checked against the provider's own spelling. Existing accounts are unaffected either way: editing that slash no longer stops Haven recognising people who have already signed in with it. Found and fixed by @birdcrazy, reported by @RCCore and @jesjhoward.
- **A role editor button that did nothing, with no error (#5511).** On a server whose files were updated without the server itself being restarted, the newer buttons in Role Management quietly did nothing: no toast, no error, no saved change. The reporter spent 45 minutes on an Admin role Save before finding out why. Those actions now say plainly when the server has not answered and point at the real cause. Contributed by @Amnibro.
- **Haven refuses to start on a half-updated install rather than misbehaving later (#5513).** Updating by copying a new release over an old folder never deletes anything, so a file that Haven split into a folder years ago can still be sitting there, and it wins. One self-hoster had been running months-old chat code underneath completely current files, which explained a long trail of unrelated-looking problems. Haven now checks for this at startup and stops with the file to delete, instead of booting a mix of versions. Contributed by @Amnibro.
- **A double divider in the channel right-click menu (#5502).** The separator above Rename Channel and Create Sub-channel stayed put even when neither was shown, so people without those permissions saw two lines with nothing between them. Contributed by @birdcrazy.
- **Moderators who can ban can now unban.** Undoing a ban was the last thing in the ban family still restricted to admins, so a moderator could ban someone, see them in the list, turn down their appeal, and then be told only an admin could reverse it, which left the person who made the mistake unable to fix it. It carries the same rank rule as banning: you can lift your own bans and those of anyone below you, but not an admin's and not a peer's.
- **Nesting a channel under a parent needed the wrong permission (#5500, #5492).** Anyone allowed to create channels could make a top-level channel and move it under a parent they had nothing to do with, which is what the manage-sub-channels permission exists to prevent. Moving a channel in now costs the same permission on the same parent as moving it out, in both directions, so the two halves of the same job stop disagreeing. Reported and fixed with @birdcrazy.
- **Braid Layout: Join and Create a Channel came back, and the Encryption entry works (#5497).** In the Braid layout those two sections could not be reopened once collapsed, and the Encryption menu entry did nothing at all. Contributed by @Amnibro, reported by @birdcrazy.
- **The new invite buttons could not be translated.** They pointed at text that did not exist in the English file, and English is what every other language falls back to per phrase, so no locale could pick them up.

### Documentation
- **A design for end-to-end encrypted group DMs (#5498).** Group DMs do not exist yet, so this is a written plan rather than a feature: one encryption key per group per period, handed to each member over the private channel that already exists between them, replaced whenever the membership changes. Written by @Amnibro.

## [3.47.0] — 2026-08-13

### Added
- **The emoji picker is now built from Unicode's own list instead of a hand-written one.** The old list was maintained by hand and had gaps. The server now builds the whole categorised set from Unicode's published `emoji-test.txt` and serves it, and your device draws the glyphs with its own font, so they look the way they do everywhere else on your machine. A copy of the current standard ships with Haven, so this works with no internet at all. There is also an optional monthly check for a newer standard under Settings → Admin → Emojis, off by default, which you can pin on or off for the whole server with `UNICODE_EMOJI_AUTO_UPDATE` if you would rather it never reached out. Custom emojis are untouched either way, and the bundled flag images stay, since Unicode's own flags do not render on every system. Thanks to @Bo0sted.

### Fixed
- **Giving a role a new permission did nothing until everyone reconnected.** Ticking a box in Role Management saved correctly but never reached the people who held that role, so a moderator granted, say, the IP-ban permission kept the old set and the option stayed missing from their ban menu until they signed out and back in. Everyone holding an edited role now gets their permissions refreshed on the spot. The same event was also throwing an error in the background, which stopped the Role Management window refreshing for any other admin watching it.
- **Sending a message could push a notification of it back to your own phone.** If a device had ever been signed into a second account, the earlier account's notification registration stayed behind pointing at that same device. Notifications skip whoever sent the message, but that leftover registration counted as somebody else, so it was a valid target that happened to be your own phone. Signing in now takes the device over from any previous account, and existing duplicates are cleared once on startup. This mattered most on the Android app, where the registration never expires on its own, so it would not have sorted itself out with time. Thanks to @Bo0sted.
- **White button text on light themes.** Buttons like Join and Send draw their label in white on the theme's accent colour, which is fine on the default purple but close to invisible on the lighter themes. Tron, Ice, CRT, Nord, Dracula, Minecraft, Zelda, HALO, LoTR, Elden Ring, Dark Souls, Scripture, FFX and Daylight now use a dark label taken from their own palette, as does the bundled Braid theme, which was the worst of them. Custom themes can set `--accent-text` to do the same. Matrix and Fallout are unchanged, since their buttons were already dark with a glowing outline by design.
- **The Voice & Connectivity settings had no entry in the sidebar (#5493).** The STUN and TURN section was reachable only by scrolling past Limits and noticing it, unlike every other admin section. It now has its own sidebar entry. The guide also explains it, including the part that catches people out: a TURN server set in Settings wins, and your `TURN_*` environment variables are ignored while it is filled in. Thanks to @josolanes.
- **Clearing a message while editing it now offers to delete it** rather than quietly cancelling the edit. Thanks to @Bo0sted.
- **Spoilers no longer leak their contents.** Custom emojis, inline code and code blocks all showed straight through an unrevealed spoiler, and a link wrapped in a spoiler hid its own text while its preview card sat below showing the title, description and image in full. All of them are now hidden until the spoiler is opened. Thanks to @Bo0sted.
- **Typing `::` to pick a persona no longer fights the emoji autocomplete**, and the persona avatar in that list is cropped to a small circle instead of rendering full size. Right-clicking a misspelled word while editing a message now opens the browser's own spell-check menu instead of Haven's. Thanks to @Bo0sted.
- **Emoji with a skin tone were not being enlarged** when sent on their own, because the tone counted as leftover text. Thanks to @Bo0sted.

### Documentation
- The bundled Braid themes and the two bundled plugins are now covered in the guide. They ship switched off, so an admin has to publish a theme before it appears in the picker, which is the usual reason one looks missing after an update. The Docker note explains that themes and plugins live in the image rather than the data volume. Thanks to @birdcrazy.

## [3.46.0] — 2026-08-10

### Added
- **A "Flag after" list of accounts that sit online and silent.** New Settings → Moderation section. An account can stay connected and showing green for hours doing nothing — no messages, no voice, no status change — which is what a script parked to watch a server looks like, since a real client trips auto-away when the person steps away. The list shows accounts that have been online and idle past a threshold you set (default 4 hours), longest-idle first. It is read-only, something to look at rather than an automatic action, and it is available to admins and to moderators who can act on it (ban, kick, audit, or view members). A moderator sees only this section, none of the admin-only ones.
- **An invite-users permission.** Handing out invite links used to require admin or manage-server, so letting someone bring people in meant handing over the whole server. There is now a permission that covers exactly that. Holders see and edit only the links they made, capped at 25, and cannot touch the server-wide code or vanity link. Redeeming a link only ever joins public, top-level channels, same as before.
- **The admin panel now says which settings come from an environment variable.** Server name, STUN, TURN and the GIF keys can be set in the panel or through the environment, with the stored value winning. Each of those fields now shows the environment value as a placeholder and a note saying which variable it comes from, so an admin who set `SERVER_NAME` in their compose file no longer opens Settings to a blank box with no idea whether it took. Secrets are reported as present without showing the value.
- **A short identity reminder the first time you open a DM.** Haven does not verify who anyone is, and on an open server someone can register a name matching a person you trust and message you as them. A small dismissable notice at the top of a DM reminds people to check before sharing anything. Shows once, on both the popped-out and full-pane DM views, with a "don't show again" button.

### Fixed
- **Pasting a file into a thread posted it instantly.** A stray Ctrl+V dropped an image straight into the thread with no chance to cancel. Threads now hold pasted and dropped files as removable previews and only send them when you send the reply, like the main and DM composers already do. Reported by test1.
- **Channel management leaked outside the channel it was granted on (#5467).** Creating a sub-channel accepted a global create-channels permission, so anyone allowed to start their own channel could add rooms inside channels they had nothing to do with. It now requires manage-sub-channels on that specific parent, and the menu only offers the Channel Functions and Create Sub-channel buttons in channels where you actually hold the permission, instead of showing buttons whose saves would be refused.
- **Attachments outlived the messages that pointed at them.** Deleting a channel dropped its messages but left every file ever posted there orphaned in uploads. And in DMs, deleting an image you had just posted left the file behind, because the client read attachment URLs out of the last rendered batch and a just-posted image was never in it. Both now clean up the files, skipping any that another surviving message still links to.

## [3.45.0] — 2026-08-10

### Added
- **Sign in with your own identity provider (#12).** Members can now sign in with an account from Authentik, Keycloak, Authelia, Auth0 or anything else that speaks OpenID Connect, instead of a Haven password. Set the issuer address and client ID under Settings → Security, put the client secret in your `.env` as `OIDC_CLIENT_SECRET`, and a sign-in button appears on the login page. The secret is deliberately kept out of the database so your backups never carry an identity-provider credential around with them.

  Encrypted DMs are unlocked by a key derived from what you type when you sign in, and someone signing in through a provider never types a password into Haven. Those accounts are asked to set a separate encryption passphrase the first time they sign in, and for it again on each new device. It never reaches the server in any form, so nobody can reset it, including the server admin, and the setup page says so rather than leaving it to be discovered later. Getting it wrong is safe: the stored key is left alone instead of being overwritten, so your other devices keep working.

  A federated account never inherits admin from the directory and never takes over an existing local account, so a directory user who names themselves after your admin gets an ordinary account with a suffixed name. Linking a provider sign-in to a Haven account you already have, and signing out of the provider when you sign out of Haven, are not included yet. Suggested by @Lordingard, with an implementation sketch from @Amnibro.

### Fixed
- **A channel setting the server refused would still look like it had changed.** Every row in the Channel Functions panel applies its new value the moment you click it so the switch feels instant, but when the server turned the change down, nothing put the row back. The result was a message saying the setting had not changed sitting next to a switch showing that it had. Reported against Welcome Messages, though it applied to every row in that panel.
- **The blank bar under the debug footer in the desktop app.** Desktop builds before v1.4.26 drew their own footer bar and reserved a strip of space for it. Newer Haven versions hide that footer, but an out-of-date desktop install still reserves the space, leaving an empty bar pinned under the status bar. That reservation is made from inside the desktop app, which is why no amount of fixing it here ever worked. Haven now overrules it, so the debug footer is the last thing on screen whichever desktop version you are running.
- **Follow-up messages did not line up with the message above them.** When you send several messages in a row, only the first shows your avatar and the rest indent to match it. The two indents were written out separately in five places and two of them disagreed, so on the Spacious density and under both Braid themes the follow-ups sat slightly to the left of the first message. One is now worked out from the other, so they cannot drift apart again, and a custom theme that follows the same convention gets it right for free.

## [3.44.2] — 2026-08-09

### Fixed
- **Transferring admin now adds the new admin to every public channel.** Admins deliberately cannot leave channels, so that whoever runs the server can see what happens in all of them. That guarantee quietly broke on a transfer: the incoming admin only had whatever channels they had already joined as a member, and no way to add themselves to the rest. They are now joined to all of them automatically. Hiding a channel from your own sidebar is a personal view setting and still works.

## [3.44.1] — 2026-08-08

### Fixed
- **YouTube embeds showed "Error 153" instead of playing.** Since 3.41.0 Haven has told browsers not to say which page a request came from when they load something on another site, which is what stopped X from refusing to play its videos. YouTube wants the opposite: with nothing to identify the page hosting it, its player refuses to start. The two embeds Haven creates (chat links and the Listen Together player) now pass along just the server address, with no page path and no invite code, which is enough for YouTube and still keeps invite links out of it. Reported by @BolVerK.
- **Thread replies skipped every message check (#5483).** The thread handler grew up beside the normal one and never picked up its checks, so a reply in a thread ignored the link policy, went through even while the sender was muted, ignored a channel being read-only, and had no length limit. Caught by @birdcrazy.
- **Popped-out DMs did not show the link warnings (#5483).** The check that decides whether a view is a DM was looking for a marker that does not exist in the page, so a DM popped out over a normal channel was never recognised as a DM and its links were left clickable. Full-screen DMs were unaffected. Also caught by @birdcrazy.

## [3.44.0] — 2026-08-08

### Fixed
- **The "check direct messages" auto-mod setting did nothing for encrypted DMs (#5483).** DMs are end-to-end encrypted, so the server receives ciphertext and genuinely cannot read the links inside. The toggle existed anyway, which quietly promised protection it could not deliver. The check now runs in the recipient's app instead, after it decrypts and before anything is clickable: a link to a domain you have not allowed renders as plain text with a warning rather than a working link, and images from those domains are replaced with a click-to-load placeholder. Senders are told before the message goes out. The rules themselves moved into one file that both the server and the browser load, so the two cannot drift into disagreeing about what a link points at. The setting's description now explains what it actually does, including that it depends on the recipient's app implementing it. Thanks to @birdcrazy for catching it.
- **Screen sharing could get stuck in a renegotiation loop (#5426).** When a share dropped frames, a watchdog asked the sharer to renegotiate after about six seconds. The renegotiation delivered a new stream, which restarted the watchdog with a fresh counter, so the give-up limit that was supposed to stop this was never reached. On a connection that was dropping frames for bandwidth reasons rather than signalling reasons, each renegotiation interrupted the stream and caused the next stall. Requests are now capped at three per sharer per two minutes with a widening gap between them, and the cap is cleared when a sharer deliberately starts a new share. Diagnosed by @RCCore from WebRTC-internals captures.
- **Double-clicking the screen-share button started two shares at once (#5426).** The join-voice button has had a guard against this for a while; the screen-share button did not, so a double-click or a laggy UI could put two SDP negotiations in flight against each other and leave the stream stalled with garbled audio.
- **Audio is now given priority over video during a screen share (#5426).** When a share ramps up to 1080p the encoder takes the whole uplink for a moment, audio packets queue behind it, and the browser fills the gap with synthesised samples, which is the robotic warble people hear. Audio is a fraction of video's bandwidth, so prioritising it costs the picture almost nothing and keeps speech intelligible through the ramp.
- **Screen-share audio arriving before its video ended up in the voice mixer permanently.** Track order is not guaranteed, and the code meant to hold early audio until its video showed up was never actually reached, so that audio was filed as voice and stayed there. It is now held briefly and re-checked, falling back to voice if no video follows so nobody's speech can go missing.

## [3.43.0] — 2026-08-07

### Added
- **Haven fetches remote images itself now, and clients never contact other sites.** Previously an image link in a message was loaded straight from wherever it was hosted, in every viewer's browser. That handed the owner of that link the IP address and browser details of everyone who scrolled past it, without anyone clicking anything and with nothing on screen to suggest a request had been made. Haven now fetches each image once, caches it on disk for 30 days, and serves it from your own server. Covers inline images, markdown images, link-preview thumbnails and revealed hidden images. A pleasant side effect, and the reason Discord does the same: an embed keeps working after the original link expires or the host goes offline, so old conversations stop rotting. On by default, with a size shown in Settings → Security and a switch to turn it off if bandwidth is tight. Thanks to @MutantRabbit767 for pushing on this.
- **Link-preview videos no longer phone home on their own.** The poster image comes from the cache and the video itself does not preload, so the remote host is contacted only if someone actually presses play. Video is still streamed from the source rather than proxied; that is a deliberate limit, since relaying video needs range requests and considerably more bandwidth.
- **Protections are on out of the box.** Auto-mod, allowlist link mode, the 24-hour hold on links from new accounts, and the image proxy all default to on, for new installs and existing ones alike. The two settings that can genuinely break something stay off and must be chosen deliberately: relay-only voice, which needs a TURN server, and automatic IP bans, which can catch bystanders on shared connections. If you turn any of this off, it stays off.

### Fixed
- **Moderators with the ban permission can ban from the sidebar.** The ⛔ option in the member gear menu was gated on being an admin, even though the server has always accepted the `ban_user` permission. Moderators could ban from the admin members list but not from the sidebar they actually work in, which made it look like their permission was not working.
- **The "also ban IP" option can finally be granted to a role.** `ban_ip` was accepted by the server but missing from the role editor's permission list, so there was no way to tick it for anyone. That made the IP-ban checkbox on the ban dialog admin-only in practice, no matter what a moderator's role said. The permission now appears in the role editor, and the checkbox correctly reads server-wide permissions rather than only channel-scoped ones.

## [3.42.0] — 2026-08-07

### Added
- **Auto-Mod: a configurable link policy for the whole server.** New section under Settings → Auto-Mod. Pick a mode (allowlist blocks everything you have not approved, blocklist only stops domains you name), manage the domain list from the same panel, and blocked content is rejected the moment it is sent, so it never reaches anyone else. It checks messages, edits, DMs, display names, status text, bios and channel topics, because a link parked in a profile reaches just as many people as one posted in a channel. Twenty common domains are added to the allowlist on first run to get you started, and the panel shows the most-blocked domains of the past week with one-click "allow" for anything caught by mistake. Off by default; existing servers see no change until an admin enables it.
- **Link previews are now gated on the same domain policy.** This one is worth understanding even if you skip the rest: Haven renders linked images and preview thumbnails directly from the other site in every viewer's browser. That means a hostile link handed its author the IP address and browser details of everyone who scrolled past the message, with nobody clicking anything. With previews restricted to allowed domains, no client is ever told to fetch from a domain you have not approved.
- **New accounts can be stopped from posting links for a set number of hours.** Applies even to allowed domains. This is the rule that breaks the register, post a link, get banned, register again loop, and it does it without needing to recognise the link.
- **Warn, mute and ban escalation.** Blocked attempts accumulate as strikes over a rolling window, with configurable thresholds for each step and an optional matching IP ban. Admins are never escalated against, and strikes can be cleared per user.
- **Relay-only voice, under Settings → Security.** Haven voice is peer-to-peer, which means that by default everyone in a call can see everyone else's IP address. It is simply how the connection gets made: no click, no prompt, no indication it happened. Turning this on routes voice through your TURN server so participants only ever see the TURN server's address. It needs a TURN server configured first and Haven will not let you enable it without one, since voice cannot work otherwise.
- **IP bans accept CIDR ranges** (`203.0.113.0/24`, `2001:db8::/64`). An IPv6 subscriber is normally handed an entire /64, so banning one of their addresses accomplished nothing.

### Fixed
- **IP bans only half-applied.** The web gate and the voice/chat connection gate disagreed about what an address is: one saw `1.2.3.4`, the other saw the same address in its IPv6 form. Banning someone blocked their web requests while their live connection carried on working. Both now use one shared address format, and banning an IP disconnects anyone already connected from it, including everyone inside a banned range.
- **IP bans behind a reverse proxy recorded the wrong address entirely.** If Haven runs behind nginx, Cloudflare or similar, every connection was logged under the proxy's address rather than the visitor's. Ticking "also ban IP" on a ban would therefore have banned the proxy and locked out every user on the server. Addresses now respect the same `TRUST_PROXY` setting the rest of Haven uses.
- **The per-address connection limit did nothing behind a proxy,** for the same reason: every visitor shared a single bucket.
- **Message rate limiting was per connection, not per person.** Two browser tabs bought twice the send rate, and reconnecting reset the limit outright. It now applies per account, so the cap means what it says.

## [3.41.0] — 2026-08-05

### Added
- **A Security section in admin settings, starting with the Referrer-Policy header (#5475).** Haven used to hardcode how much of your page address browsers share with other sites. It is now a setting under Settings → Security, with the safe choices listed first and plain-language descriptions of what each one shares. Six of the eight standard policies are offered; the two that would send your full page address to other sites are deliberately left out, because Haven invite links live in that address. Thanks to @Bo0sted.
- **Braid Layout v1.5 (#5477).** The in-call controls that stock Haven keeps in the right sidebar (camera, screen share, soundboard, listen together, and the settings panel with the stream quality pickers) now live in a dock at the bottom of the left sidebar, so a call has everything in reach without opening the People panel. The server strip handles any number of servers on one row instead of stacking them vertically, switching between Braid and the classic layout is one click in both directions (or Ctrl+Shift+B), and Mod Mode's drag handles no longer leak into the strip. Thanks to @Amnibro.
- **Channel creators and channel moderators can invite people to private channels (#5466).** Previously this was admin-only, which meant the person who made a private channel could not add anyone to it.

### Changed
- **Twitter/X video embeds now play without any setup.** X refuses to serve its videos to anyone whose browser says where the request came from, and Haven's old default said exactly that, so every X video embed showed a still frame and a dead play button on every Haven server. The default is now Same-Origin, which sends nothing to other sites while still working normally inside your own server, so it shares strictly less than before. If some other site turns out to want a referrer and one of its images stops loading, Settings → Security has the old value at the top of the list, labelled as the pre-3.41.0 default.
- **Read-only channels hide the message box instead of showing one that rejects you (#5468).** The composer is now hidden per channel when a read-only override applies.
- **The desktop app banner can be dismissed, and no longer appears inside the desktop app itself.** Its X button now closes it for good rather than bringing it back on the next load.
- **The update banner clears itself once the server is up to date**, instead of sitting there after you have already updated.

### Fixed
- **Web clients were kicking themselves out of voice every 60 seconds (#5463, #5444).** Haven watches for its own timers stalling, because that usually means the computer slept and the connection is dead. Chrome slows a background tab's timers to one tick per minute once the tab has been idle for a while, which looked exactly like a sleep, so the app dropped and rebuilt its connection once a minute for as long as the tab sat in the background. Everyone in the call heard a leave sound followed by a join sound each time. That signal is now only trusted while the tab is actually on screen; locking your PC, which is the case the check exists for, still works because Windows does not mark the page hidden. Tabbing away from a live call and back also no longer cycles the connection. Reported by @AlexT2803, whose logs pinned down the exact 60 second cadence.
- **Haven Desktop burned CPU and GPU while sitting in an audio-only voice call (#5456).** Two frame loops started when the app opened and never stopped: the microphone level meter from the settings panel, which kept writing to the page on every frame even with settings closed, and the built-in performance counter. A frame loop that never ends keeps the renderer drawing on every screen refresh, which is what kept the GPU busy with nothing moving on screen. The meter now runs only while it is visible, and the counter samples in short bursts. Reported by Andalishious.
- **File themes inherited the previous theme's effects, and an enabled theme could override the one you picked (#5476).** Switching from a built-in theme like FFX to a published file theme left the water and wave overlays running on top of it, which was very visible on a light theme. Separately, a published theme toggled on in Settings would win over whatever the theme picker had selected, so clicking a theme appeared to do nothing. Thanks to @Amnibro.
- **The voice channel "..." menu no longer shifts the other users' icons** when it opens.
- **The sidebar collapse button stays pinned to the panel edge.**
- **Disconnects now record why they happened (#5463)**, so the log says something like "disconnected [ping timeout]" instead of just a name.

### Security
- **Updated adm-zip to 0.6.0 (CVE-2026-39244) (#5473).** A crafted ZIP file could make the old version try to allocate 4GB of memory. Haven uses that library to read Discord export files during an import. Thanks to @anupamme.

---

## [3.40.0] — 2026-08-03

### Added
- **GIF search works on new servers again (#5472).** GIPHY stopped issuing API keys to new applications, so the setup guide walked admins to a page that could never finish and GIF search stayed switched off forever. Tenor is now the preferred provider, with a setup guide to match, and it can be configured in the same place. Servers that already have a GIPHY key keep working exactly as before, and the picker footer tells you which service actually served the GIFs. Thanks to @Amnibro.
- **Braid themes and the Braid Layout plugin.** An optional darker mint-on-slate theme (plus a light variant) and a simplified two-edge layout that folds the server rail into the sidebar and tucks header extras into a single menu. Both are opt-in and off by default: admins publish the themes under Settings → Custom Themes, and the layout is enabled per person under Plugins. Every control the layout hides stays reachable from its menu. Thanks to @Amnibro.

### Changed
- **The member list gives each name its own line.** A custom status and a game used to sit on the same row as the username, and both reserved width, so anyone doing both had their name squeezed down to a character and an ellipsis. Whatever someone is doing now shows on a smaller second line underneath, and only one thing appears there: a game outranks music, and any activity outranks a custom status. People with nothing to show keep a single-line row at the same height as before.
- **The status bar shows an address worth sharing.** It used to display whatever address your own browser connected on, which for the person running the server meant "localhost:3000" behind a hide toggle and a click-to-copy, neither of which was any use. It now shows the address other people could actually connect on: an active tunnel if there is one, otherwise your configured public address. When there is nothing shareable to show, the whole thing is hidden rather than offering to copy an address that only works on one machine.
- Haven now runs on Node 24 and 26. The launcher used to refuse to start on anything newer than Node 22 based purely on the version number; it now checks whether the database module actually loads, which is the thing that matters. Thanks to @Amnibro.

### Fixed
- **Haven could appear to crash silently on launch (#5471).** If the port was already taken, the failure was caught by the keep-alive handler and written to the crash log, leaving a process running that never got a network connection. There was no banner, no error and no exit, and the launcher's readiness check was satisfied by the older process still holding the port, so it reported that Haven was live. Every retry left another invisible copy behind. A failed start now says which port and why, then exits. Diagnosis and fix from @Amnibro.
- **The profile card opened behind the member list on narrow windows (#5465).** Below 900px the member list becomes a slide-in panel that sits above the page, and the profile card was underneath it and its shading. Reported by @birdcrazy.

---

## [3.39.0] — 2026-08-02

### Added
- **Interface zoom (#5464).** The four fixed font-size tiers are replaced by a Zoom slider (70–150%) in Settings → Layout & Density that scales the **whole** interface, not just text: sidebars, the server rail, avatars, icons, spacing and headers all grow together, and the layout reflows instead of running off screen. Your old Small/Normal/Large/XL choice is migrated to the closest zoom level automatically, and the setting is applied before the first paint so nothing jumps on load. At 100% the UI is unchanged from before. Thanks to @Bo0sted for a meticulous conversion.
- **Keyboard control for the emoji picker (#5459).** Ctrl+E opens and closes it, arrow keys move a highlight through the grid, Enter inserts the highlighted emoji and closes, Shift+Enter inserts without closing so you can pick several, and Escape closes. The first emoji is highlighted the moment the picker opens, so Enter works without arrowing first. Thanks to @Bo0sted.
- **Sliding switches for on/off settings.** Settings that toggle something now render as switches instead of checkboxes, themed from your accent colour. Settings → Layout & Density has a **Toggle Style** control to switch back to classic boxes. Lists where you tick items — permissions, channel and media pickers, backup contents, polls — deliberately stay as checkboxes, since those are selections rather than settings.
- **Activity toggles in the status menu.** Clicking your status dot now also offers Music Activity and Game Activity under a Share Activity heading, so you can flip what you broadcast without opening Settings. The full Activity section is unchanged and still holds the master switch and account connections. A toggle only reads as on when something would actually be shared; ticking one with no linked account takes you to Settings → Activity to set it up.

### Changed
- **The status dot is now a button.** It always opened the status menu, but an 8px dot did not look clickable. It now sits inside a proper button with hover and focus states, while keeping its own shapes for Do Not Disturb, Away and Invisible.

### Fixed
- **AI noise suppression failed after leaving and rejoining a call (#5458).** The worklet module is registered per AudioContext, but the check that decided whether to register it keyed on a value that survived teardown. Rejoining built a fresh AudioContext, skipped registration, and enabling Suppression (AI) threw an InvalidStateError. The check now keys on the AudioContext itself. Reported by @Serionard.
- **AI noise suppression produced a constant crackle (#5458).** The worklet drained its output buffer with no headroom, and because RNNoise's 480-sample frames do not divide evenly into the browser's 128-sample audio blocks, the buffer periodically ran dry and emitted digital silence — measured at 5.07% of all output samples, in gaps recurring around 72 Hz, which is audible as broadband clicking. Output now goes through a ring FIFO with independent read and write cursors and two frames of pre-fill. This adds roughly 9–19 ms of latency and a one-off ~19 ms of silence when you switch suppression on. Diagnosis and approach from @Serionard.
- **The member-list gear menu did nothing on narrow windows (#5462).** Below 900px the right sidebar becomes a slide-in overlay with a very high stacking order, and the gear menu was opening behind it. Reported by @birdcrazy.
- **Channel-scoped delete permissions were ignored (#5461).** Someone granted "delete any message" through a channel's own role saw no Delete option, because the client decided from your level rather than your permissions. Separately, deleting a channel only ever consulted server-wide roles, so a channel creator holding delete_channel through the channel role could not delete the channel they had just made, nor its sub-channels. Both now honour channel-scoped grants, and a grant on a parent channel covers its sub-channels. Reported by @birdcrazy.
- **Changing the Channel Creator Role reported "No changes to save" (#5461).** The setting saved correctly; only the confirmation was wrong. Reported by @birdcrazy.
- **Hint text under a setting could overlap its control.** Hints sat 2px too high and ran the full panel width, so they slid underneath the control on the right. They now clear it and wrap before reaching it.
- **The PiP thread panel lost its clamp to the viewport height** in the web client, so on a short window it could extend past the bottom of the screen.
- **Admin action buttons no longer sit in ragged rows.** View Bans, View IP Bans, View Deleted Users and View All Members now share an even grid.

---

## [3.38.0] — 2026-07-28

### Added
- **Delete several messages at once (#5460).** The "Select messages" tool (mods/admins) now has a **Delete** button next to "Move to", so you can multi-select and remove a batch in one go with an "are you sure" confirm. Deletion runs through the same per-message permission rules as a single delete, so it can never remove more than you could delete one at a time.
- **Configurable channel-creator role (#5461).** When a non-admin who has permission to create channels makes one, they are auto-granted a role inside that channel so they can manage it. That already happened for top-level channels using the highest channel-scoped role; it is now a setting in Admin → Roles (pick a specific role, keep the default, or turn it off) and also applies to sub-channels. Admins are never auto-assigned anything.
- **Ban appeals (#5457).** A banned user who signs in with the correct password now sees the ban reason and a box to send the admins an appeal, instead of a dead-end error. Appeals show up next to the user in the Banned Users list with an option to unban or dismiss, and online admins get a heads-up when one arrives. The reason is only revealed after the password is verified, so it never leaks on a bare username guess.
- **Opt-in Cloudflare Turnstile CAPTCHA on registration.** Admins can require a Turnstile challenge on the sign-up form (Admin → Settings) to slow down automated account creation. Off by default; needs a Turnstile site key and secret.
- **Opt-in global registration rate limit.** A server-wide cap on how many new accounts can be created per hour, to blunt bot waves. Off by default and configurable in Admin → Settings.
- **Admin bulk cleanup tool for bot-wave accounts.** A new admin utility to review and remove batches of recently-created spam/bot accounts at once instead of one at a time, with a vetting checklist before anything is deleted.

### Fixed
- **AI noise suppression (RNNoise) was a silent no-op.** The main thread posted a WebAssembly.Module into the AudioWorklet via postMessage, but Module does not survive structured clone into AudioWorkletGlobalScope (the port fires messageerror, never message). The worklet never initialised and permanently passed mic audio through unprocessed, while rnnoiseReady still reported healthy. The worklet now receives raw WASM **bytes**, compiles inside the worklet, and reports ready/error back to the main thread. Also: HTTP status check on rnnoise.wasm, messageerror logging, rnnoiseReady only true after worklet confirm, and AudioContext prefers sampleRate 48000 so a 96 kHz headset does not defeat the model. Thanks to @Serionard for the full diagnosis (#5458).
- **Voice roster no longer strobes empty while you are still in voice.** Transient empty voice-users-update snapshots (prune/rejoin races) are ignored while you are in voice on that channel, and a follow-up poll refreshes the real list. The right VOICE panel still follows the **channel you are viewing** (not the channel you are connected to).
- **Screen shares that appeared at join then vanished are recovered more aggressively.** renegotiate-screen retries if the peer is not ready yet; the viewer watchdog runs longer and re-checks live tiles; ICE heal / fast-path rejoin re-arms screen recovery; connectionState connected re-delivers screen tracks when ontrack does not re-fire.
- **voice-rejoin while already bound on the same socket is a no-op.** It no longer fans out join/leave or forces peer rebuilds (which could look like a disconnect and kill stream tiles). voice-existing-users without skipRenegotiate will not tear down healthy peers either; only missing peers are created.
- **Voice users are no longer pruned during their reconnect grace window (#5444).** A brief socket flap could evict someone from the voice roster before their reconnect landed, so others saw them drop and rejoin. The prune now respects the reconnect grace window and leaves them in place.

### Changed
- Desktop image copy from the lightbox uses main-process clipboard IPC more reliably (base64 payload, window focus, DOM decode fallback) and no longer shows a browser-only error toast inside the desktop app. (Desktop package change pairs with this.)

---

## [3.37.2] — 2026-07-25

### Fixed
- **`:emoji` autocomplete menu could stop working until a page refresh.** The `#emoji-dropdown` is a single shared node that gets re-parented next to whichever input is active (#5296). Opening the suggestions inside an inline message-edit box parked the node in that message; saving or cancelling the edit ran `innerHTML = originalHtml` and deleted it, so every later `:emoji` threw on the missing element and autocomplete died everywhere (including the main composer) until a full refresh. The node holds no state, so it is now recreated on demand when it has gone missing. Thanks to @Bo0sted (#5454).
- **Admin password reset window rendered raw translation keys.** The reset modals were written as `t('key') || 'English fallback'`, but `t()` returns the raw key string for a missing key, so the fallback never fired and the whole window showed labels like `modals.admin_reset_pw.title` instead of real sentences (#5451). The missing text has been added to the locale file, and `t()` now falls back to English for any key a non-English locale is missing, so a gap shows readable English instead of a raw key across every language.

### Changed
- **Admin password reset now explains the 2FA requirement clearly.** Resetting another user's password requires that user to have two-factor authentication enabled first, so the temporary password alone cannot be used to take over their account. That requirement is intended, but it used to surface as a red error that looked like a malfunction. It now shows a calm informational popup that states it is a security requirement, explains why it exists, and tells you the user must enable 2FA before the reset will run (#5451).
- **Channel ID, header icons, and the voice-channel user list now scale with Font Size.** These sidebar and header elements were fixed-size and ignored Settings → Layout & Density → Font Size, so raising the size left them small. They now scale across the Small/Large/Extra Large tiers with the rest of the UI (#5450).

### Documentation
- **Refined the remote-access guide.** The README now explains the risks of port forwarding and adds a safer alternative using Tailscale, with a locked-down ACL so friends can only reach Haven and nothing else on your machine. Thanks to @Bo0sted (#5452).

---

## [3.37.1] — 2026-07-25

### Fixed
- **Link-preview embeds no longer show up inconsistently.** Opening a channel full of links — most noticeably a freshly loaded screen of imported Discord history — fired one `/api/link-preview` request per link all at once, blew past the server's 60/min per-IP limit, and 429'd the overflow. A rejected request returned `null` and rendered no card, so embeds "sometimes popped up with all the images, sometimes with none." Fetches now go through a client-side scheduler that caps concurrency (3 at a time) and retries 429s with backoff, honouring a new `Retry-After` header the server sends on the rate-limited response, so every preview resolves instead of being silently dropped.
- **Matrix theme: the edit-message box rendered as a blank solid-green block.** Matrix was the one built-in theme with no `::selection` override, so selected text fell through to the global rule (white text on the accent colour). Matrix's accent `#00ff41` is light enough that white-on-green is nearly invisible, and because mobile browsers auto-select a field's contents when it's focused, opening the editor on a message turned the whole textarea into an unreadable green rectangle. Matrix now uses dark, high-contrast selection text (matching the Fallout terminal theme's convention), so the editor — and any selected text — stays legible.

---

## [3.37.0] — 2026-07-23

### Added
- **Persistent welcome messages for new members.** Welcome messages used to be live-only: drawn on screen from the real-time join event and never saved, so they only appeared for whoever happened to be viewing that exact channel at that instant, vanished on reload, and re-fired every time a member reconnected (which made them look random and out of chronological order). A new member's welcome is now posted once, when they register, as a saved message in every channel flagged to show them, so it stays in history for everyone like Discord. A new per-channel **Welcome Messages** toggle lives in Channel Functions (admin only) and defaults on for the server's first/default channel; the existing admin welcome-message template still controls the text and doubles as the on/off switch (an empty template turns the feature off).
- **Emoji picker overhaul (#5449).** The picker now renders every category as one continuous scrolling list with sticky headers, so scrolling past the end of one category flows into the next and clicking a category tab jumps to its section. Your server's custom emoji now sit first for quick access (unchanged if you have none), and there is full **skin tone** support: a hand button beside the search bar opens a tone picker, your choice is remembered, and it applies everywhere emoji appear — the picker, reactions and quick reactions. Contributed by Bo0sted.
- **Right-click context menu for messages (#5446).** Right-clicking a message opens a themed, cursor-positioned menu mirroring the hover toolbar's actions (edit, reply, quote, pin, react, thread, copy link, protect, delete), gated on the same permissions. It defers to the image menu on images and to the browser's native copy when text is selected. Contributed by Bo0sted.
- **Type-to-focus the message box (#5445).** Start typing anywhere with nothing focused and no popup or modal open, and the message box takes over so the first keystroke lands there. Modifier combos and keyboard shortcuts are left alone, and it stays out of the way during IME composition. Contributed by Bo0sted.
- **`STEAM_API_KEY` documented (#5447).** Added to the README config table and `.env.example` with a link to the Steam dev portal, and `docker-compose.override.yml` is now gitignored. Contributed by KevonLin.

### Fixed
- **Steam account linking behind a CDN, proxy or tunnel (#5448).** When Haven ran behind a CDN → proxy → Docker chain on a non-standard port, the Steam OpenID callback could be built from the proxy's internal address and fail verification. `baseUrl()` now honours `X-Forwarded-Host` when trust proxy is enabled and only appends a genuine external port otherwise, and the project-root `.env` is loaded as a fallback so a manually set `PUBLIC_URL` always applies. Adds diagnostic logging on the failure path. Contributed by KevonLin.

---

## [3.36.0] — 2026-07-21

### Added
- **Opt-in "repair voice audio after a reconnect" toggle (Settings → Debug, #5444).** If you sometimes rejoin a voice call and still can't hear one or more people until you leave and rejoin, there's a new Debug toggle for it. When two people reconnect at the same moment, their connections can collide mid-repair (both sides ICE-restart every peer at once) and the losing offer's restart intent was dropped on rollback — so the media path never actually restarted, the two sides' ICE credentials crossed, and one direction of audio stayed dead until a manual rejoin. Turning this on carries the restart through so Haven re-runs it and the audio comes back on its own. Off by default while it's being verified in the field.

### Changed
- **The voice channel panel is less cluttered.** Mic and speaker icons now appear only when someone is actually muted or deafened, instead of every participant carrying two faded glyphs, so names are easier to read at a glance. The "you" tag next to your own name is gone (you know who you are), and the LIVE badge is now a compact red dot plus viewer count — hover it for the full "who's watching" detail.

### Fixed
- **Voice recovers audio more reliably after a brief disconnect (#5444).** After a reconnect Haven ICE-restarts each peer to repair the media path, but if that restart couldn't be issued the peer was silently abandoned with no retry, leaving that person's audio dead until a manual rejoin. The recovery now verifies each connection a few seconds after the restart and re-attempts it while the path is still broken.
- **Fewer ICE servers handed to the browser (#5444).** With no custom STUN configured, Haven handed out four built-in STUN servers; adding a TURN relay made five, which Chrome warns slows down connection setup — and measurably delayed reconnecting after a socket flap. The list is now capped at four, always keeping your TURN relay, so connections establish faster.

---

## [3.35.0] — 2026-07-19

### Added
- **`PUBLIC_URL` for OAuth and OpenID callbacks (#5443).** When Haven runs behind Docker port mapping (8080→3000), a reverse proxy that strips the port out of the Host header, or a Cloudflare Tunnel, the server could not reliably work out its own public-facing address, so Steam and Spotify callback URLs came out wrong and linking failed. Setting `PUBLIC_URL` in `.env` makes `baseUrl()` use that value verbatim for every callback it builds (Steam OpenID `return_to` and `realm`, and the Spotify OAuth `redirect_uri`). Left unset, behaviour is exactly as before. It is deliberately *not* writable from the admin UI — a UI-settable callback base would be a redirect-hijack vector. Contributed by KevonLin.
- **Integration keys can be replaced from Settings (#5442).** The key setup form only rendered while a provider was still unconfigured, so once `STEAM_API_KEY` (or the Spotify / Last.fm keys) had been set there was no way to swap a leaked or revoked key without hand-editing `.env` and restarting. Every configured integration now shows an admin-only "Change key" button that reveals the same form, with the hint reworded to make clear it replaces the current key. Saving a new `STEAM_API_KEY` also triggers a presence poll straight away, so a rotated key takes effect immediately instead of on the next 60-second tick. Contributed by KevonLin.

---

## [3.34.0] — 2026-07-19

### Added
- **Favorite GIFs.** The GIF picker now has two tabs: **Search** and **★ Favorites**. Hover any GIF and a star appears in its corner — click it to keep that GIF, click it again to drop it. The search box doubles as a filter on the Favorites tab, so a big collection stays usable. Favorites are stored in your own browser, so they never leave your machine, they are per-device, and the Favorites tab keeps working even on a server that has no GIPHY key set up.

### Fixed
- **The ping reading in the status bar was mostly fiction.** Two different places sent latency probes but both measured against one shared timestamp, so a probe's reply could be timed against an entirely different probe's send time. The result was a random number between 0 and 15 seconds — which is why even a server running on the same machine could report multi-second ping. Probes are now queued and paired with their own reply, and outstanding probes are discarded on disconnect instead of reporting the length of the outage as latency.
- **"Everyone can see me in voice except me."** If the local in-voice flag got out of step with the actual call, the voice panel filtered you out of your own channel and nothing ever put you back. Haven now checks the live peer connections before trusting that flag, and a watchdog repairs the voice UI if it drifts — so you no longer end up staring at a "Join Voice" button while you are already in the call.
- **Voice user rows no longer sprout a blank second line.** As soon as someone picked up a LIVE, camera or viewer badge, the status icons wrapped onto a row of their own and sat at the far right of it, looking like an empty row. Long names now truncate instead of wrapping.

---

## [3.33.0] — 2026-07-18

### Added
- **Rich presence — see what people are playing and listening to.** The member list shows one activity per person (games take precedence, so the sidebar stays scannable) and the profile card shows a line for each, so someone doing both gets both. Four sources: Haven's own voice-channel music player (works immediately, no setup), **Last.fm**, **Steam**, and **Spotify**.
- **Last.fm is the recommended music source.** Linking is just your username — no sign-in redirect, nothing stored — and because Spotify, Apple Music, YouTube Music, Navidrome and Plex all scrobble to Last.fm, one connection covers whatever you actually listen with. Note that scrobbling has to be switched on in Last.fm's own settings first; the setup panel explains how for each service.
- **Activity privacy controls** in Settings → Activity. Games and music can be hidden separately or sharing turned off entirely, and nothing is ever shared while your status is Invisible. Activity is never written to the database, so no listening history is kept.
- **Admins can paste API keys directly into Settings** instead of editing `.env` by hand, with step-by-step instructions for each service. Keys apply immediately — no server restart.
- **Settings navigation is grouped** into Appearance, Chat, Privacy & Presence, Account & Security and Advanced. Nine sections that previously had no nav entry are now one click away, and the highlighted entry follows what you are actually looking at as you scroll.
- **The settings panel can be resized.** It still opens at its usual size, but the drag handle now works — previously it was capped at exactly the width it opened at.

### Fixed
- **`.mov` videos (and more audio formats) now play inline** instead of showing a download card. Also covers `.m4v`, `.ogv`, `.m4a`, `.aac`, `.flac` and `.opus`. If a file genuinely cannot be decoded by the browser, the attachment falls back to a download link rather than leaving a dead player.
- **`@` mentions sometimes did nothing.** Three separate causes, all of which left the member list empty with no error anywhere. Typing `@` with an empty list now re-fetches it automatically.
- **Copying an image from the viewer** could fail with "Write permission denied", and reported the wrong error when it did.
- **The status bar could be shown once and then never hidden again** — the checkbox appeared to do nothing.
- **The emoji customise panel covered the row of slots** you needed to click, if the full emoji picker was already open.
- **Language selector showed "GB", "RU" and "ES"** instead of flags on Windows.
- **Image Display settings section had no working nav link** (duplicate element id).

---

## [3.32.0] — 2026-07-13

### Added
- **Restore progress bar (#5438).** Restoring a backup now shows a real upload percentage as the file transfers, then a server-side extraction bar as the archive is unzipped to disk, so a large restore no longer sits with no feedback for many minutes.
- **Notification pop-up cooldown.** Settings → Sounds has a new "Limit pop-up notifications" option (off by default) that throttles how often desktop/browser notification pop-ups appear, so a burst of messages or a flaky connection cannot keep popping the app up. Notification sounds and unread badges are unaffected.

### Changed
- **The status bar hides the server address by default every session.** It now starts hidden and is only shown after you click the eye toggle, and that choice is no longer remembered between sessions.

### Fixed
- **linux/arm64 Docker image restored (#5439).** Starting with 3.31.1 the published multi-arch image silently lost its arm64 variant, because the untagged per-arch child manifests from the push-by-digest build were being pruned from GHCR, forcing Apple Silicon Macs onto slow amd64 emulation. Each architecture is now published as its own persistent tag and merged into the multi-arch manifest, so both arches ship and survive, and the workflow now fails loudly if either is missing.
- **Sidebar collapse arrows no longer leave a gap.** On narrow windows the voice/users panel can shrink below its requested width; the collapse arrows now snap to the panel's actual edge once its width settles instead of hovering to its left.

## [3.31.2] — 2026-07-11

### Fixed
- **The manual "Download Backup" button now works on large servers (#5434).** Automatic backups were fixed in 3.31.0, but the manual download still built the entire zip to a temporary file before sending anything, so on a big server (30GB of files) it sat silent for minutes and a proxy in front of Haven returned a 502 before the download ever started. The download now streams the archive straight to the browser as it builds, so it starts immediately and stays alive for the whole transfer.

## [3.31.1] — 2026-07-10

### Fixed
- **Restoring a large backup no longer fails with "failed to fetch" (#5436).** Restoring a full backup that included files broke on three separate limits: the server aborted any request that took longer than 30 seconds (which is the ~30s "failed to fetch" people saw), the upload itself was capped at 4GB, and the restore read the entire uploaded zip into memory the way the old backup path did, so a large archive ran the server out of memory. Restores now allow long uploads, accept large files, and stream the archive straight to disk, so a 15GB or larger backup restores without crashing. Slow-header (slowloris) protection is unchanged.

### Changed
- **The backup screen now spells out that only full backups can be restored in place (#5435).** A backup has to include both Messages and Uploaded files to be restorable from the Restore box; smaller channels/users/settings backups are meant to be re-imported by hand. That was always the case but wasn't stated, so a partial backup failing to restore looked like a bug.

## [3.31.0] — 2026-07-10

### Added
- **Rich link preview cards for Bluesky and X/Twitter posts (#5429).** Social links now render as full embed cards with the author's avatar and name, the post text, sized media (a play badge marks videos), and engagement counts (replies / reposts / likes / views), bringing the desktop and web client in line with the mobile app's embeds. Embed size is now a single Off / Small / Medium / Full preference shared by the Settings ▸ Link Previews picker and a new per-embed ⤢ toggle, with a per-embed caret to collapse a single preview. Generic links and YouTube use the same card chrome. Older size values (Normal / Large) migrate automatically. Contributed by Amnibro.

### Fixed
- **Backups that include files no longer crash the server (#5434).** Server backups built the entire zip in memory before writing it out, so once the uploads folder grew large (reported around 30GB) the process ran out of memory and went down, while a structure-only backup stayed tiny and worked fine. Backups now stream straight to disk as they build, so memory stays flat no matter how much is stored, for both manual downloads and scheduled auto-backups. The archive format is unchanged, so existing backups still restore.

### Changed
- Refined the Russian wording on the password recovery screen (#5420). Contributed by CUBEEEK.

## [3.30.3] — 2026-07-07

### Fixed
- **"Create Channel" sidebar section stayed visible for users who could only create sub-channels (#5433 follow-up).** The flat permissions list sent to the client for UI gating mixed server-wide and channel-scoped grants together, so a user with `create_channel` scoped to a single channel saw the always-on sidebar "Create Channel" section — a dead control, since every submission creates a top-level channel and gets denied by the (correctly scoped) server check. That section is now gated on a global-only permission check, so it only appears for admins and users with a genuine server-wide `create_channel` grant.

## [3.30.2] — 2026-07-06

### Fixed
- **Betsy Ross and Gadsden flags didn't match the aspect ratio of the other Flags emoji.** They were noticeably flatter/wider than the rest of the set, since their source artwork wasn't 4:3 like the bundled country flags. Both are now cropped to the same 4:3 frame (canton preserved in full on Betsy Ross; snake and lettering preserved in full on Gadsden), so they sit consistently alongside every other flag.

## [3.30.1] — 2026-07-06

### Fixed
- **Flags emoji category showed bare country codes on Windows.** Windows browsers don't render Unicode regional-indicator flags and fall back to the two-letter code ("US", "GB", "DE", …), so the new Flags category looked like a list of letters there. Every country flag is now a bundled SVG image, so flags render the same on every platform — in the picker, in messages, and in reactions.

## [3.30.0] — 2026-07-06

### Added
- **Flags emoji category.** The emoji picker has a new Flags category with a broad set of country flags. The US flag leads the list, followed by two classic American flags — the Betsy Ross flag and the Gadsden ("Don't Tread on Me") flag — which ship built in and render inline in messages and reactions like any other emoji.
- **Screen share pop-out maximize toggle (#5430).** The screen-share pop-out window now has a maximize/restore toggle so a shared stream can fill the pop-out.

### Improved
- **Smarter emoji search.** Typing an actual punctuation mark now finds the matching emoji — e.g. `?` surfaces ❓ and ⁉️, `!` surfaces ❗, and `#` or a digit matches its keycap emoji. Search also covers the new bundled flag emoji by name.

### Fixed
- **"New messages" divider and auto-scroll stopped appearing (#5432).** Opening a channel recorded it as fully read before its history finished loading, so the last-read divider from #5259 had nothing to anchor to. The read position is now saved after the history request, restoring the divider and the jump-to-unread scroll.
- **Channel-scoped role permissions leaked server-wide (#5433).** Per-assignment permission checkboxes ticked on a role granted inside a specific channel (e.g. "create channel", "rename sub-channels") were being applied everywhere. They're now scoped to the channel they were granted in and its sub-channels; server-wide assignments still apply everywhere as before.

### Changed
- **README refresh (#5431).** Documented custom stickers and personas, the built-in backup tools, and the `::` persona shortcut, marked the Russian translation as human-reviewed, and updated roadmap statuses.

## [3.29.0] — 2026-06-29

### Added
- **Spoiler images and a per-viewer Hide Image option.** When sending an image you can now mark it as a spoiler — an eye toggle on each queued image — and it renders blurred behind a "Spoiler" label for everyone, revealing on click. Works for normal uploads, encrypted DM images, and persona/bundled sends. Separately, you can right-click any image already in chat and choose "Hide Image" to collapse it to a placeholder in your own view only; it's stored per-device, and clicking the placeholder restores the image.
- **Invite link management.** Admins can now create and manage multiple invite links from a dedicated menu, each with its own per-link channel grants, optional expiry, and use limits. Copying a link is reliable with a clear success toast and a dedicated popout, and the landing site can auto-join the community from an `?invite=` link instead of manual code entry.

### Fixed
- **Guests couldn't reach sub-channels or voice rooms in their allowed area (#5401).** The guest access picker only listed top-level channels and auto-joined just the public sub-channels under a whitelisted parent, so private sub-channels were unreachable and voice rooms a guest wasn't a member of failed with "not a member of this channel" (the server already allowed guests to use voice once they were in the room). The picker now lists every channel individually — parents, sub-channels, and voice rooms, each tagged so you can see what's private or voice — and guests are joined to exactly the rooms you select (ticking a sub-channel includes its parent so it appears in the sidebar). The server still enforces membership and per-channel settings, so nothing is widened beyond what you grant.
- **Back-to-back messages from one person showed as separate blocks in pop-out DMs and threads.** Consecutive messages from the same sender within a few minutes now group together — no repeated name/avatar header — the way the main channel already does, in both the DM pop-out and in threads. In threads, deleting the first message of a group now promotes the next reply so it keeps its author header.

### Changed
- **Haven Desktop download links bumped to v1.4.25** on the landing pages.

## [3.28.0] — 2026-06-26

### Added
- **Admin-only "Hide Channel" to declutter the sidebar (#5409).** Admins can't leave channels (they need access to all of them), so their channel list just keeps growing. Right-click a channel (admin only) to hide it from your own sidebar without touching membership or affecting anyone else. Hidden channels stay fully accessible: an "N hidden channels" bar at the bottom of the list opens a modal to unhide them individually or all at once. Stored per-device in localStorage, like mute. The channel you're currently viewing is never hidden out from under you.

### Fixed
- **Screen-share audio drifted out of sync over TURN relays (#5426).** Incoming screen-share audio was routed through Haven's Web Audio mixer, which pulls at the AudioContext's fixed clock while WebRTC's jitter buffer adapts to relay jitter — the two clocks drift apart and, after a minute or two on a relayed connection, the audio stutters and desyncs from the video continuously (LAN was unaffected). Native audio playout is now the default, keeping the jitter buffer in charge end to end, so screen-share audio stays in sync. The Web Audio mixer is now an opt-in toggle ("Web Audio mixing for screen-share audio") for the >100% per-stream volume boost; normal 0–100% volume works in the default path.
- **Custom sounds, emojis, and stickers didn't update live (#5426).** They're uploaded and deleted over HTTP, so other connected clients only saw the change after a full restart. Uploads, deletes, and renames now broadcast a refresh signal and every client reloads the affected library immediately.
- **Voice could go silent for some peers after a brief disconnect (#5427).** Web clients (Firefox/Edge) reported being dropped from voice and reconnecting audible to some people but silent to others, with nothing self-correcting. On a quick reconnect the existing peer connections are kept, but a now-dead relayed path can keep reporting "connected" while no media flows. After a reconnect while still in voice, Haven now ICE-restarts every peer (a restart repairs both directions of a connection and is near-seamless on healthy links), staggered to avoid a burst of offers.
- **Reopening a screen share could stick on "Requesting stream…" (#5426).** Closing a stream tile and trying to watch again fired a single request; if it lost a race, the viewer was stranded until they rejoined or restarted. The watch path now uses the same retry watchdog late joiners already use, re-requesting until a live video track arrives.
- **Sub-channel access via a crafted code or deep link (#5408).** A non-member could paste a sub-channel's code into "Join a Channel" (or open a `?channel=` deep link) and be added directly to that sub-channel, unlocking its full history and posting. Joins by code now require membership of the parent channel, private subs are never granted by code, and rejections reuse the generic "invalid code" error so a code's existence isn't revealed. Existing members are unaffected.
- **Guests couldn't see the Join Voice button in allowed channels (#5401).** An earlier fix let guests into voice on the server and in `_joinVoice`, but the checks that decide whether the Join Voice button even shows still required `use_voice`, so guests never saw a way in. Those gates (header actions, channel context menu, sidebar double-click) now exempt guests too; the server still enforces membership and per-channel voice settings, so nothing is widened beyond a guest's allowed channels.
- **Server address in the status bar didn't copy in the desktop app.** `navigator.clipboard.writeText()` fails silently in Electron's BrowserView, so clicking the address did nothing. Added the hidden-textarea `execCommand('copy')` fallback the other copy buttons already use (#182).

### Changed
- **Full Russian retranslation** from @CUBEEEK (#5421), validated against the English source.

## [3.27.0] — 2026-06-23

### Added
- **Admin-configurable STUN/TURN voice servers (#5399).** A new **Settings → Voice & Connectivity** section lets server admins point voice and screen share at their own STUN servers (one `stun:` URI per line, or comma-separated) and an optional TURN server with static credentials — without setting environment variables or redeploying. `/api/ice-servers` now resolves in the order admin setting → `STUN_URLS` / `TURN_URL` env → built-in STUN pool, so a server can be fixed live from the admin panel. The TURN password is stored as an admin-only sensitive setting and every value is scheme/length validated before it's saved. Clients that can't reach any STUN server now show a one-time warning toast explaining that calls may only work on the local network until an admin configures STUN/TURN, instead of silently hanging on "ICE: Connecting…".

### Fixed
- **The stream viewer's "close" (✕) button broke screen sharing.** The viewer header has two different ✕ buttons: the per-tile ✕ safely hides a single stream (restorable), but the header ✕ stopped your own broadcast *and* fully tore down every stream tile. Destroying a tile dropped the only reference to a sharer's still-live video, so the stream couldn't be reopened and even a fresh reshare wouldn't reattach without a full hard-refresh — it also closed streams you were only watching and removed the restore button. The header ✕ now closes streams the same restorable way the per-tile ✕ does (hide + mute, recoverable from the hidden-streams bar or the LIVE badge) and never stops your own share.

## [3.26.0] — 2026-06-21

### Added
- **Per-channel Soundboard toggle.** The Channel Functions menu (the ⚙️ panel, admins / `create_channel`) now has a **Soundboard** ON/OFF switch alongside Voice, Text, Streams, Music, and Media. Turning it off for a channel stops anyone from playing soundboard sounds into that channel's voice chat: `_playSoundFile` checks the voice channel's `soundboard_enabled` before routing audio into the VC mix and shows a notice instead. New `soundboard_enabled` column on `channels` (defaults to on), wired through the existing `toggle-channel-permission` handler and `getEnrichedChannels`.

### Fixed
- **Auto-cleanup was deleting persona avatars and other non-post files (#5423).** The file sweep deleted everything in `uploads/` that wasn't on a hand-maintained allow-list (server icon, user avatars, custom emojis/sounds, webhook avatars, referenced attachments), so any file type nobody remembered to protect got wiped — persona avatars now, server stickers/emojis before that. Cleanup is now inverted: it follows the messages it deletes, relocating their attachments to `deleted-attachments/` (only when no surviving message still references them) and purging that folder by age. The main `uploads/` directory is never scanned, so avatars, persona avatars, emojis, sounds, stickers, and the server icon are safe by default — including future file types.
- **Sub-channel Rename and Organize ignored the permissions named for them (#5424).** Rename only appeared for moderators (effective level ≥ 25) and Organize (reorder / move / reparent / set category) was gated on the server-wide `create_channel` permission on both the client button and every server handler — so granting `rename_sub_channel` or `manage_sub_channels` did nothing for those actions, while Set Topic and Create Sub-channel worked because they were already tied to their own permissions. Rename and Organize now follow the matching permissions; organizing a parent's sub-channels accepts `manage_sub_channels` scoped to that parent, while top-level / server-structure changes still require `create_channel`.
- **Non-image attachments queued on their own never sent (#5425).** The non-image upload queue (#5417) only flushed inside `if (hasImages)`, and the empty-send guard only checked for queued images, so a queued PDF/audio/video/etc. with no image alongside it never uploaded — with message text the text sent and the file stayed stuck in the queue; with no text the send returned early and did nothing. The send path now tracks `hasFiles`, lets a file-only message through, and flushes the image and file queues independently.
- **Late joiners and tile-less viewers couldn't (re)open an active screen share.** Users who joined a voice channel after a screen share had already started, or who had dismissed the stream tile, had no way back into the live stream. They can now reopen any active screen share in the channel.
- **Screen-share audio could play twice (#5426).** Stream audio was being routed through both a Web Audio gain node and the underlying media element at the same time, doubling it. It now plays through a single path.

### Changed
- **Haven Desktop download links bumped to v1.4.24** on the landing pages (#5422 hotfix).
- **Refreshed donor and sponsor credits** from the latest contribution list.

## [3.25.2] — 2026-06-18

### Fixed
- **App loaded completely blank — no servers, channels, users, or DMs, and nothing was clickable (regression in 3.25.x).** Three of the front-end JavaScript modules (`app-messages.js`, `app-media.js`, and `app-ui.js`) had been silently truncated mid-file in an earlier commit, cutting off the end of each file. Because the app bundles these modules together at startup, a single unterminated file is a fatal parse error that stops the entire interface from initializing — so the page connected to the server but rendered nothing and ignored every click. All three files have been restored to their complete form. If you were stuck on a blank Haven screen, update and hard-refresh (Ctrl+Shift+R) and it will load normally again.

## [3.25.1] — 2026-06-18

### Fixed
- **Haven Desktop stuck on "Loading Haven…" / CSP-blocked i18n init.** `app.html` had a single inline `<script>i18n.init();</script>` tag that the page CSP (no `'unsafe-inline'` in `script-src`) was refusing to execute on strict clients, leaving the locale layer uninitialized and the desktop preload hanging on the splash. Moved the bootstrap call into `i18n.js` itself (`I18n.init()` at the bottom of the module) and removed the inline tag from `app.html`. `init()` is idempotent so the `auth.js` `await window.i18n.init()` call still resolves against the same shared promise.

---

## [3.25.0] — 2026-06-17

### Added
- **Soundboard sidebar mode.** New non-blocking side panel that pins the soundboard alongside chat instead of opening it as a modal popup. Toggle from Settings → Sounds → Sidebar Mode, or from the popup checkbox. Includes a resizable handle, collapsible category groups (Custom / Built-in), a search input, and a fixed-position arrow toggle that slides with the panel. The panel and the popup share the same backing list, so hotkeys keep working in either mode. Auto-closes when you leave voice (the panel doubles as a "you're in voice" affordance).
- **Custom sound management.** Settings → Sounds → Manage now lets you hide individual sounds from the soundboard (visibility toggle per row) and reorder them with drag-and-drop. Hidden sounds stay available for hotkey playback and Assign-to-Events but are pruned from the visible grid. Order is persisted per-user.
- **Bluesky link previews (#5412).** `/api/link-preview` now resolves Bluesky post URLs (`bsky.app/profile/.../post/...`) into the same preview-card format used for other social platforms, including avatar, display name, post text, and timestamp.
- **Link preview size picker.** Settings → Layout now has an Off / Normal / Large picker for link preview cards, matching the existing image display picker. "Off" hides all link previews; "Large" widens the card to 600px with a bigger thumbnail.
- **File upload queue for non-image attachments (#5417).** Non-image files (PDFs, audio, video, archives, etc.) now queue as a removable chip in the same bar as image previews and only upload when you hit Send. Works for the upload button, paste, and drag-drop in the main composer. Replaces the old "instant upload on selection" behavior. PiP DM and threads still use the immediate-upload path.

### Changed
- **Soundboard popout no longer blocks Assign / Manage (#5419).** Opening the Sound Manager while the soundboard is popped out now still lets you reach the Assign-to-Events and Manage tabs. Previously the modal-opener early-returned for *any* tab if the PiP was active, which made the admin Custom Sounds button silently do nothing. Now only the Soundboard tab refocuses the PiP; other tabs open the modal as expected.
- **Sound Manager dropdown is now a custom component (#5418).** The Assign-to-Events `<select>` lists were replaced with a div-based dropdown that stays inside the modal, flips above when there's not enough room below, and scrolls when the option list is long. Native `<select>` popups render outside the Haven window and couldn't be constrained.
- **better-sqlite3 upgraded to v12.10.0.** Adds prebuilt binaries for Node 22 through 26.
- **`start.sh` no longer kills processes on the configured port (#5415).** The `lsof -ti:$PORT | xargs kill -9` block could collateral-kill unrelated processes on shared hosts. The script now fails fast with EADDRINUSE if the port is busy, which is the correct behavior. Contributed by @MutantRabbit767.

### Fixed
- **Soundboard sidebar rendered at the far LEFT of the window instead of next to voice/users.** `#app-body` uses CSS flex `order` for layout (server-bar=0, sidebar=1, main=2, right-sidebar=3) and the new `.sb-sidebar-panel` had no explicit order, so it inherited 0 and landed at the leftmost position. Added `order: 3` for the soundboard panel and bumped the right-sidebar to `order: 4`.
- **Soundboard collapse arrows snapped instead of sliding.** Both the voice and soundboard collapse buttons have their `right` position set imperatively in JS when the sidebars open/close, but the CSS `transition` only animated color/background. Added `right` (and `top` for the soundboard variant) to the transition list so the buttons slide with the panels.
- **Sidebar toggle arrow visually crowded the first sound row.** With the panel open and the toggle staggered at top:114px (the closed-state stagger), the arrow ended up at the same vertical position as the top of the sound list. When the panel is open, the toggle now sits at top:72px (aligned with the header) — the voice toggle's position is never reused horizontally while the panel is open, so the stagger isn't needed there. Closed-state still uses 114px to prevent stacking with the voice toggle at right:0.
- **Sound manager dropdown overflowed the Haven window.** See the dropdown rewrite above (#5418).
- **Residual UTF-8 mojibake across the UI (#5418).** A previous repair pass missed several spots. Restored theme logos (`eldenring 💍`, `zelda 🗡️`, `gospel 🕊️`, `halo ⌁`, `nord ❄`, `minecraft ⛏️`, `ffx ⚔️`, `fallout ☢️`, `scripture ✝️`, `cloudy ☁`), the Sound Manager built-in group label (`🎙️ Sounds`), the bot detail Moderation label (`🛡️`), the avatar-save error indicator (`❌`), three em-dashes and the `⚖️` balance scale on the TOS page in `public/index.html`. All visible icon corruption from the v3.17.0-era cp1252 round-trip should now be gone.
- **Soundboard surfaces stayed open after leaving voice.** The sidebar panel, the popout PiP, and the sound modal all now close automatically when you leave a voice chat. Routing sound effects through the VC requires being in voice, and the panel doubles as a "you're in voice" affordance.
- **Shared stickers no longer moved to `deleted-attachments/` on message/DM delete (#5413).** Sticker URLs live under `/uploads/stickers/` and were being incorrectly matched by the per-message attachment cleanup regex. Added `stickers/` to the negative lookahead in all five definitions of `UPLOAD_PATH_RE` / `UPLOAD_PATH_EXACT_RE`. Contributed by @Amnibro.
- **Slash subcommand picker follow-up for #5403.** Subcommands now show up correctly in the autocomplete list when typing slash commands, with their per-subcommand description.
- **Chat scroll-jumping when images/media load.** Two root causes: `.chat-image` had no placeholder dimensions before load (every image jumped from 0×0 to up to 180×180), and each `<img>`'s `onload` fired an instant hard-snap to bottom. Added minimum dimensions to reserve space, and switched the per-image scroll callbacks to a 50 ms-debounced version so a batch of images loading at different speeds collapses into a single scroll.
- **Auto-heal users with zero channel memberships on bootstrap.** Legacy accounts that somehow ended up in `users` with no rows in `channel_members` (typically from interrupted server-list-sync runs in pre-3.20 builds) now get auto-joined to the configured default channels — or, if no defaults are set, to every public non-DM channel — when the socket connects. Restores visibility without a manual "join by code" step.
- **Sound migration parsing.** Edge-case where the migration step that converts old per-user sound prefs to the new schema would skip a row if it had a stray empty media line.
- **Missing sound pref functions / broken template literal in app-media.js.** A previous commit introduced a syntax error in the persona-prefix handling block; restored.

---

## [3.24.0] — 2026-06-07

### Added
- **Bulk sticker upload in the Sticker Manager (#5406).** Admins can now select multiple sticker images at once from Settings → Admin → Stickers, have sticker names auto-generated from filenames, and optionally apply one shared pack name to the whole batch. The flow mirrors bulk emoji upload, but respects the separate sticker size limit and stores everything in the existing sticker packs/picker pipeline.
- **Dedicated Desktop mute/PTT cue toggle (Haven-Desktop #37).** Settings → Sounds now has a new **Mute / PTT Cues** toggle that controls the short tones used for mute, unmute, deafen, and Desktop push-to-talk. This lets Desktop users silence the PTT beeps without muting all other Haven sounds.

### Fixed
- **Deleting DMs no longer sweeps server stickers into `deleted-attachments/` (#5411).** Sticker files live under the shared `uploads/stickers/` library, not per-message attachments, so cleanup and delete flows now leave them alone instead of treating them like disposable uploads.
- **Private channel message links are hardened and no longer leak a joinable channel code in the URL (#5408).** Sharing or opening a message link no longer doubles as an uncontrolled invite path into hidden/private channels.

## [3.23.0] — 2026-06-03

### Added
- **Private webhook bot replies (`ephemeral` + `recipient_id`) (#5404).** `POST /api/webhooks/:token` now accepts `ephemeral: true` plus `recipient_id` to deliver a bot message only to one channel member without storing it in chat history. The server validates that the recipient is a member of the webhook's channel before delivery. Clients render these with an "Only visible to you" pill so recipients can distinguish private bot output (for example dashboard login tokens) from normal channel messages.

## [3.22.0] — 2026-06-01

### Added
- **"Never expire" option for login sessions (#5391 followup).** The `session_duration_days` admin setting now accepts `0` to mean "never expire" — JWTs are signed with no `exp` claim and stay valid until the user logs out or their password changes. The Settings → Uploads & Limits input is now a dropdown (Never / 1 / 7 / 30 / 90 / 365 days) instead of a number entry, and new installs default to **Never**. Existing servers seeded with `7` on older versions keep that value until the admin picks something else, so no behavioral change on upgrade. Was the root cause of #5391 — users kept silently losing their session after the default 7-day expiry, with no obvious cue that re-login was needed. Self-hosters who actually want short-lived tokens can still pick a value; everyone else can stop worrying about it.

### Changed
- **Unified first-time popup queue.** The desktop-app promo and Android beta promo used to race each other on first visit, with separate "Don't show again" checkboxes that were easy to miss and persisted under inconsistent localStorage keys. They now show one at a time in a single sequenced flow with a small footer bar (`1 of 2`, `Skip all`, `Next` / `Done`), so users can click through or dismiss the whole batch in one go. Dismissal is also now permanently sticky per popup id — any close action marks that id seen forever, regardless of whether a checkbox is ticked. Legacy `haven_desktop_promo_dismissed` / `haven_ab_promo_nodisplay` / `haven_multi_role_notice_v1` keys are migrated into the new `haven_welcome_seen_v1` map on first load, so anyone who already hit "Don't show again" in an earlier version doesn't see those popups again after upgrading. New popups added in future versions still appear (only specific ids the user has actually been shown get persisted as seen — Skip-all does not preemptively dismiss things that don't exist yet).

### Removed
- **Multi-role-per-channel admin notice.** Long-running admins know about it by now and new admins have known no different; the one-time popup has served its purpose. The `haven_multi_role_notice_v1` key continues to be migrated into the new welcome-seen map for the benefit of anyone whose dismissal needs to survive future popup rework.

### Fixed
- **Android beta popup silently re-appeared on upgrade.** The `_ab_v3_migrated` block that the v3 release used to wipe stale beta dismissals was still active on every load and would re-show the modal to anyone who'd previously dismissed it. Removed in favor of the new welcome-popup migration path, which only ever sets, never clears.
- **Guest mode: selecting a parent channel no longer strands its sub-channels (#5401).** Guest auto-join now expands selected parent channels to include their public sub-channels, so guests can open nested rooms under allowed parents without manual extra joins.
- **Guest mode: voice chat works for guests in allowed channels (#5401).** Guest sessions are now exempt from the `use_voice` role gate (client and server) while still respecting per-channel `voice_enabled` toggles and membership checks.



### Added
- **Server-side per-channel mute (#5399 followup).** Channel mute state has only ever lived in browser localStorage, which meant the server's push helper had no idea who'd muted what and pushed every message to every member regardless. Mobile users in particular reported getting FCM pings for channels they'd muted in the web client weeks earlier; on Android there was no way to silence a noisy channel short of disabling Haven notifications system-wide. A new `user_channel_prefs` table now mirrors the mute set on the server, with `GET /api/user/channel-prefs`, `POST /api/user/channel-prefs/mute` (single-toggle), and `PUT /api/user/channel-prefs/muted` (transactional bulk replace, capped at 500 entries) backing it. `sendPushNotifications` filters muted recipients out of both the web-push subscription loop and the FCM inactive-members list. Existing clients converge automatically on first connect — the renderer unions localStorage with the server set and pushes the merged list back up, so nobody loses their existing mutes.

### Fixed
- **Blank login page / blank app shell after updating directly from v3.18.0 (#5399).** Two SyntaxErrors had been quietly sitting in `main` since the v3.19.0 Guest mode merge (`b6b95bd`): a duplicate `const loginForm` redeclaration in `auth.js`, and an orphan `_setupServerBar() {` opener with no body in `app-ui.js` (a half-merged method definition that was never closed). Anyone already running v3.19.x kept working because their cached/loaded modules survived the crash on initial parse, but users updating directly from v3.18.0 — the prior version many self-hosters were sitting on — hit both errors on first load and got a blank login page followed by a blank app. Mistakenly attributed to the v3.20.1 STUN refresh at first; that work is unaffected.
- **Bot slash command registration now supports discoverable subcommands in autocomplete (#5403).** `POST /api/webhooks/:token/commands` accepts an optional `subcommands` array (`{ name, description }`), persists it per command, and `/api/bot-commands` now flattens those into picker entries like `/rss add` with per-subcommand descriptions. Callback payload format remains unchanged (`command` is base command, `args` carries the subcommand text and arguments).
- **`/api/ice-servers` was still returning dead STUN URLs (#5399 followup).** The server-side default in `/api/ice-servers` was still handing out `stun.stunprotocol.org` + `stun.nextcloud.com` — the same pair the v3.20.1 client fix had to route around. Any Haven server using the server-side STUN defaults was giving its clients dead endpoints and only working at all because `voice.js` had been updated to ignore them. Mirrored the same Cloudflare/Metered/Twilio/Google fallback list on the server so the two sides stay in sync.
- **Right-click → Copy image silently failed for almost everyone, on both static images and GIFs.** Two compounding causes: the previous implementation awaited an `Image()` load + `canvas.toBlob` before calling `navigator.clipboard.write`, by which point the user-gesture token had been dropped and Chromium silently rejected the write with `NotAllowedError`; on top of that, Electron's renderer added enough latency around fetch+decode that even a corrected promise-based path was unreliable. Rewrote with three strategies tried in order: under Haven Desktop, hand the PNG bytes to the main process via a new `clipboard:write-image` IPC (Electron's `clipboard.writeImage` has no gesture restrictions); otherwise call `navigator.clipboard.write` with a promise-based `ClipboardItem` so the gesture token is preserved; last-ditch, copy the image URL as text so the user has something to paste. Failure toasts now include the underlying error message so diagnosing future regressions doesn't require devtools.
- **Image and member context menus appeared offscreen on top of the image lightbox or PiP DM.** Both `.image-context-menu` and `.user-context-menu` sat at `z-index: 10001`, which left them buried under the image lightbox (`100010`) and the PiP DM panel (`99999`). Right-clicking an enlarged image or a member while a PiP DM was open made the menu look like it vanished. Bumped both to `100020`.
- **Password eye-icon toggle sat on top of the typed characters.** The `.haven-pw-wrap` wrapper was `inline-block` with no width hint, so the inner input collapsed to its intrinsic width and the absolutely-positioned eye sat directly over the right edge of the password text instead of in its own gutter. The wrap is now a full-width block and the input fills it with reserved right-padding for the toggle.

---

## [3.20.1] — 2026-05-31

### Fixed
- **Voice and screen-share broken outside local network on servers without TURN (#5399).** Both hardcoded default STUN servers had gone offline (`stun.stunprotocol.org` was decommissioned upstream; `stun.nextcloud.com` stopped responding to binding requests), which left any Haven instance using the default ICE config unable to gather server-reflexive candidates. The visible symptom was LAN-to-LAN voice still working (host candidates don't need STUN) while anyone outside the server's subnet got stuck on "ICE: Connecting…" indefinitely; soundboard and screen-share failed to external users for the same reason. Replaced the defaults with a non-Google preferred pool (Cloudflare, Metered, Twilio) plus a runtime probe that opens a throwaway `RTCPeerConnection` against each default URL and prunes the ones that don't respond with a `srflx` candidate inside ~2.5 seconds. If every preferred server fails the probe, a Google fallback pool is brought in automatically as a last resort. Admin-configured TURN servers (`/api/ice-servers`) continue to take precedence over both defaults and probe results, so anyone running their own TURN is unaffected.

---

## [3.20.0] — 2026-05-31

### Added
- **IP-level bans for moderators (new feature).** Adds a per-server IP ban list, gated on a new `ban_ip` role permission (admins always have it). Three ways to use it:
  - The `Ban User` modal now shows an "Also ban recent IP address(es)" checkbox when the moderator has the `ban_ip` permission. When checked, up to the 5 most recently observed IPs for that user are added to the ban list as a side effect of the user ban.
  - A new "Banned IPs" entry under `Settings → Admin → Members` opens a manage modal where any qualifying moderator can directly ban or unban an arbitrary IP address with a free-form reason.
  - The HTTP layer (Express) and Socket.IO layer both consult the ban list before routing a request — the HTTP path uses a 30-second cache that is invalidated whenever the ban list changes. Live sockets coming from a freshly-banned IP are disconnected immediately.
  - Two new tables back this: `ip_bans (ip PRIMARY KEY, banned_by, reason, created_at)` and `user_ips (user_id, ip, last_seen)`, the latter populated by the socket auth middleware and capped to 5 most-recent distinct IPs per user.
  - Caveats: exact-string match only (no CIDR / IPv6 /64 normalization in v1), and IP bans can collateral-affect users behind shared NAT, CGNAT, or large institutional networks — moderators should prefer user-ban + scrub for most cases and reserve IP ban for repeat ban-evaders.

---

## [3.19.1] — 2026-05-31

### Fixed
- **Desktop App: settings checkboxes and keybind recorders unresponsive until the matching left-nav was clicked (Haven-Desktop #36).** The Shortcuts section's record buttons and the Desktop App / Debug section's preference change-listeners were only wired up *on* the click of the left-nav item that owns them, so a user who opened Settings and scrolled straight to a checkbox or keybind recorder would find them unresponsive until they happened to click "Shortcuts" or "Desktop App" in the nav. Both Desktop-only sections are now initialised eagerly the moment Settings opens, so every control is responsive immediately regardless of where the user scrolls.

### Added
- **Two new opt-in Desktop debug toggles for Nvidia G-Sync / VRR FPS-drop (Haven-Desktop #35).** Under `Settings → Debug` (Desktop only): "Disable GPU vsync (Nvidia G-Sync fix)" and "Remove Chromium frame-rate cap (Nvidia G-Sync fix)". Workarounds for the upstream Chromium issue where renderers on Nvidia G-Sync displays get stuck negotiating a tiny refresh rate after the window is hidden/restored and never recover (whole app drops to ~5 FPS). Off by default because both flags can introduce visible tearing on non-VRR monitors. Require Haven Desktop 1.4.21+ and a restart to take effect.

---

## [3.19.0] — 2026-06-01

### Added
- **Join as Guest mode (#5381).** New admin setting (Settings → Admin → "Join as Guest") lets self-hosters open the server to drop-in guests. Guests pick a username on the login page (no password, no recovery, no E2E key), get a `GUEST` badge in the member list and in chat, and are auto-joined only to the channels the admin whitelists. Direct messages are off-limits for guests: the DM pane is hidden client-side, and the server rejects `start-dm` socket events for defense-in-depth. The guest's `users` row is deleted ~5 s after their last socket disconnects, freeing the username for the next person.

### Fixed
- **Bot slash-commands now resolve to the right bot when multiple bots share a command name (#5398).** The slash-command lookup joined `bot_commands` to `webhooks` on command name alone, so a slash command registered in channel A could fire a webhook callback registered to channel B if both used the same command (commonly `/play`, `/help`, etc.). The query now also scopes by `webhook.channel_id`, so each channel's bot owns its own command namespace.

---

## [3.18.3] — 2026-05-31

### Fixed
- **Shortcut-recorder toast now tells you what's actually wrong (#184).** Previously every failed PTT/mute/deafen bind showed the same vague "may already be in use, or the desktop app version doesn't support this binding type yet" message regardless of cause. The recorder now reads the structured outcome from the desktop IPC (`{ ok, reason }`, Haven Desktop 1.4.20+) and shows a specific toast: "that combo is already in use" for conflicts, or "the native input hook (uiohook) isn't loaded — launch from a terminal to see install steps, or pick a regular key combo" for Mouse4/5 + bare-modifier binds when `uiohook-napi` failed to load. Falls back to the old toast on older Desktop builds.

---

## [3.18.2] — 2026-05-31

### Fixed
- **Donors "Thank You" modal** — the Ko-fi donate button could fall below the visible area on shorter screens, forcing users to scroll inside the modal to find it. The modal is now a flex column: the tier lists own the scroll, and the donate button is pinned to the bottom of the modal so it's always visible.

---

## [3.18.1] — 2026-05-31

### Fixed
- **Screen-share framerate and quality cap too conservative (#5379).** The per-resolution bitrate ceiling for screen share was being applied as a hard `RTCRtpSender.encodings[0].maxBitrate` and the previous values (1.5 / 3 / 5 Mbps for 720 / 1080 / 1440) were well below what modern home internet can sustain. With the cap set that low the encoder had no choice but to drop framerate to stay inside it, which produced exactly the symptom users were reporting ("two of us on good internet still have to drop to 720p30 to keep it smooth"). Three changes together: (1) bitrate ceilings bumped to 4 / 8 / 14 Mbps for 720 / 1080 / 1440 (and 8 Mbps for "source"), in line with what OBS and YouTube Live recommend for those resolutions; (2) the screen-share video track now gets `contentHint = 'motion'` so the encoder biases toward smoothness instead of sharpness (correct default for games, videos, and scrolling content, which is what most screen shares are); (3) every screen-share sender now sets `degradationPreference = 'maintain-framerate'` and also pins `encodings[0].maxFramerate` to the user's chosen FPS so when bandwidth does get tight the encoder drops resolution before it drops frames. Net effect: the existing 1080p30 default actually delivers 1080p30, instead of degrading to 720p15ish under the old cap.
- **Russian translation (`ru.json`) refreshed to match current `en.json` (#5395, thanks @QuiXMaDe).** Pulls in all the keys that landed in 3.17.x and 3.18.0 (server-synced nicknames UI, per-channel default role labels, `/break` command help, admin password reset flow, channel auto-clear timer, sticker size setting, etc.). Validated against `scripts/validate-locales.js` with zero warnings.

---

## [3.18.0] — 2026-05-27

### Added
- **#5397: Bot-driven moderation REST API.** Webhook bots can now optionally kick, ban, unban, mute, and unmute users via five new endpoints (`POST /api/webhooks/:token/moderation/{kick,ban,unban,mute,unmute}`). The permission is **off by default for every bot** — only admins (not just `manage_webhooks`-holding mods) can flip the new "Allow this bot to perform moderation actions" checkbox in the bot's edit panel. Backed by a new `webhooks.can_moderate` column and a `requireModBot()` guard that returns 403 if a bot without the flag tries to call any of the endpoints. Endpoints reuse the same DB tables and side effects as the JWT-authenticated `/api/moderation/*` (rate-limited via `webhookLimiter`, admin-target guard preserved). Bots without `can_moderate` continue to work for messaging and slash commands — the new endpoints simply 403 until an admin opts them in.
- **Dynamic DNS auto-update (DuckDNS / Cloudflare / generic).** New `src/ddns.js` module pings your DNS provider with the server's current public IP on boot and every N minutes (default 5). Disabled unless `DDNS_PROVIDER` is set in `.env`; supports `duckdns` (`DDNS_DOMAINS`+`DDNS_TOKEN`), `cloudflare` (token + zone/record IDs), and `generic` (`DDNS_URL` with `{ip}` template). Two new admin endpoints: `GET /api/admin/ddns/status` (last result) and `POST /api/admin/ddns/refresh` (force update now). Solves the "ISP rotated my IP and the domain points at the old one" problem — set it once and forget it.
- **#5394: Server-synced nicknames.** Nicknames now persist server-side so they follow you to new devices and browsers. They're still personal and private (only you see them). On first connect after this update, any nicknames already stored in your browser are pushed up automatically. The server sends your nickname list back on each login so everything stays in sync without any manual re-entry.
- **#5389: Per-channel default role.** Channel Functions → "Default Role" picks a server role that gets auto-granted (channel-scoped) to every current member and to anyone who joins later. Setting it backfills all existing members in one transaction; clearing it leaves prior grants in place so admins can decide whether to revoke from the Roles UI. New `channels.default_role_id` column (nullable FK → roles, SET NULL on delete), new `set-channel-default-role` socket event gated on `manage_roles`, and the auto-grant fires through the public-join, server-code, and vanity-code join paths. DMs are excluded since they have no roles. `INSERT OR IGNORE` on `user_roles (user_id, role_id, channel_id)` keeps repeated joins idempotent.
- **#5392: Admin-adjustable max sticker file size.** Stickers had a hard-coded 1 MB ceiling that made them feel cramped compared to images — small enough that most "GIF library" candidates failed to upload. Admin Settings → Uploads & Limits now has a "Max Sticker File Size (KB)" input (256–10240 KB, default 1024). The server already read `max_sticker_kb` per-upload via `createStickerUpload()`, so this just surfaces and validates the setting. Bump it up if you want stickers to double as a GIF library.
- **#5393: `/break` slash command + persona compacting hard-stop.** Different personas sent in quick succession under the same account were sometimes still visually compacting into a single grouped block for *other* viewers (not the poster — they saw it correctly), making the personas indistinguishable. Three defensive layers now: (1) the grouping check also compares `persona_username` and the displayed `username`, so even if a stale or missing `persona_id` slips through the wire the displayed name still forces a break; (2) a new `break_chain` column on `messages` lets any message hard-stop compaction with the previous one; (3) the new `/break <message>` slash command (also surfaced in the autocomplete list) lets users manually force a fresh group whenever they want, including for normal non-persona messages. The flag round-trips through the SELECT projections, the broadcast object, and the rendered DOM data-attrs so it survives reconnects, history pagination, and DOM trimming.
- **#5300: Admin password reset (opt-in) backend.** New `admin_password_reset_enabled` server setting (default `false`) lets admins enable a "reset user password to a one-time temp value" flow. New socket event `admin-reset-user-password` (admin-only, gated on the setting) generates a 16-hex-char temp password (`XXXX-XXXX-XXXX-XXXX`), bcrypt-hashes it, bumps `password_version` (which invalidates the target's existing JWTs via the existing pwv-rejection path), sets a new `must_change_password` flag on the user row, and returns the plaintext temp password to the admin once. Audit-logged as `admin_password_reset`. Login response now carries `mustChangePassword: bool`, and a new `POST /api/auth/change-password-required` endpoint accepts a valid token + new password and clears the flag. The setting is also mirrored into `/api/public-config` so any user can see whether admins on this server have this power before signing up. Admin Settings has a checkbox + warning text covering the E2E impact (the user's wrap key derives from the password, so old encrypted DM history becomes unrecoverable on their side, matching the existing recovery-codes flow). Backend by @Amnibro (#5318).
- **#5390: Channel auto-clear messages timer mode.** In addition to the existing timed-delete (full channel wipe on a schedule), channels can now be set to "auto-clear" mode — messages are wiped on the interval without deleting the channel itself. New `auto_delete_mode` column on `channels` (`delete` vs `clear`); the cleanup interval branches accordingly between full channel delete and a message-only wipe (`channel-messages-cleared` broadcast refreshes the viewer). The channel badge shows hours plus a recurring glyph so it's visually distinct from one-shot expiry.

### Fixed
- **Screen-share reshare: black screen and invisible tile (#5390).** Re-sharing the screen (stop → start again without leaving the call) could leave peers with a black video tile or no tile at all. `stopScreenShare` now awaits per-peer renegotiation with `Promise.allSettled` (8 s safety cap) instead of racing against a fixed 3 s timeout. Dead-track detection in the `sameLiveTrack` guard forces a `srcObject` reassignment on reshare, and `ontrack.onended` skips tile teardown if a new screen-share is already registered, preventing a split-second where the tile disappears before the new stream attaches.
- **Screen-share fullscreen exit: ghost tile on transient `track.onunmute` (#5391).** Exiting fullscreen on a screen-share tile and then resuming could trigger a spurious `onunmute` event that reassigned `srcObject` even when the same live track was still rendering, causing a brief freeze or blank tile. The reassignment is now skipped when the track is already attached and live.
- **Channels-list watchdog: HTTP validate + retry + reload on silence (#5391).** In rare cases — typically after a long tab sleep or a flaky reconnect — the socket would appear connected but the server would stop sending `channels-list` updates, leaving the UI stale. The watchdog now HTTP-validates the session and retries the socket event on silence; if validation itself fails it triggers a clean page reload rather than leaving the user in a broken state indefinitely.
- **Landing-page emojis rendering as `?` / `??` after site edits.** PowerShell 5.1's `Set-Content` without `-Encoding utf8` was rewriting `docs/index.html` and `website/index.html` as Windows-1252, silently destroying any Unicode outside that range (emojis → `?`, em-dashes → stray 0x97 bytes). Restored correct UTF-8 BOM encoding on both files and added `.editorconfig` + `.gitattributes` guardrails so the encoding survives future edits.

---

## [3.17.4] — 2026-05-26

### Fixed
- **iOS Web (Safari + Chrome + every other iOS browser): no audio from other people in voice channels and no audio on incoming screen shares.** WebKit's `MediaStreamAudioSourceNode` produces silence for audio tracks pulled from an `RTCPeerConnection` (long-standing WebKit bug, every iOS browser inherits it because Apple forces them all onto WebKit). Haven was routing every incoming remote audio track through Web Audio (`createMediaStreamSource → gainNode → destination`) and muting the `<audio>` element itself, which works on every other browser but means iOS users heard absolute nothing in voice — calls looked connected, peer cards lit up, but the audio was a black hole. Now iOS specifically skips the Web Audio graph and lets the `<audio>` element play the stream natively, using the element's own `volume` property for per-user / per-screen-share volume. Trade-off on iOS only: no >100% volume boost and no per-remote-peer talking analyser (the server-pushed `voice-speaking` events still drive talk indicators), in exchange for audio that actually plays. Affects `_playAudio` and `_playScreenAudio` in `voice.js`. iOS video was working already (`<video playsinline autoplay>` is set on webcam and screen-share video tiles) — the user-visible "video and audio both broken" symptom was actually audio-only, but with audio silent the call felt completely dead.

### Restored
- **Opt-in toggle: "Apply voice processing to screen-share audio" (Settings → Debug).** 3.17.3 removed echo cancellation / noise suppression / auto gain control from screen-share audio unconditionally so music and game audio would sound right, which is the correct default for almost everyone. But for the minority sharing voice content (tutorial narration, podcasts, a recorded meeting) the cleanup actually helps, and removing it outright was too aggressive. The original filter chain is back as an opt-in debug toggle (`pref-debug-screen-share-voice-proc`, localStorage key `screen_share_voice_processing`) — default off (matching 3.17.3 behavior), flip it on if you're sharing voice content. Microphone always gets full voice processing regardless.

---

## [3.17.3] — 2026-05-26

### Fixed
- **Mobile "Join Voice" button stayed visible after joining a voice channel (#5387).** The mobile-only floating join button was hidden via `style.display = 'none'` in JS, but `style.css` declares `.mobile-voice-join { display: flex !important; }` inside the `@media (max-width: 768px)` block. `!important` won the cascade so the button kept showing while the user was already in the call. The same race could leave it hidden after leaving in some channel-switch paths. Now uses `setProperty('display', 'none', 'important')` when hiding and `removeProperty('display')` when showing, so the inline style actually beats the stylesheet's `!important` rule and the regular media-query default is restored when in-call state ends. Applied in `app-voice.js` and three places in `app-channels.js` that toggle the same element during channel switches and welcome-screen returns.
- **Language preference didn't always switch the UI (#5386).** Picking a new language in Settings persisted the choice to `localStorage` but only re-applied translations on elements with `data-i18n` attributes already present in the DOM. Anything rendered dynamically by JS (modals, picker entries, button labels that were templated, toasts) kept its previous-language text until the next full reload. `setLocale()` now persists the choice immediately, then triggers a single `window.location.reload()` so every dynamically-built string comes back in the new language. Defensive: `localStorage` is written *before* the locale fetch so a network blip on the locale JSON can't lose the user's selection.

### Added
- **Admin setting: Default Language (#5386).** New `default_locale` server setting (under Admin → Server Settings → Default Theme) lets admins pick the language new users see on their first visit before they've touched the language picker. Choices match the supported set (English, French, German, Spanish, Polish, Russian, Chinese) plus an "Auto-detect (browser)" default. Exposed unauthenticated via `/api/public-config` so `i18n._detect()` can consult it before falling back to the browser's `navigator.language`. Once a user picks their own language it wins from then on — the admin default only fires on first contact.
- **Screen-share audio: full-fidelity by default for music / game audio (#5379).** Sharing screen audio used to apply the same Chromium voice processing chain (echo cancellation, noise suppression, auto gain control) as the microphone, which mangled music and game audio into a flat, low-bitrate-sounding stream. Those filters are now disabled unconditionally on the `getDisplayMedia` audio track (the previous opt-in debug toggle has been removed). The microphone is on a separate `getUserMedia` stream and still gets the voice-processing pipeline — only the system-audio capture from your screen share is full-fidelity now.

### Notes
- 3.17.3 also bundles the Haven Desktop 1.4.17 release, which addresses a screen-share encoder stall when the desktop window is hidden behind another full-size window. Desktop changelog: see `Haven-Desktop/CHANGELOG.md`.

---

## [3.17.2] — 2026-05-25

### Fixed
- **Right-side userlist hidden behind the message composer on tablet widths (#5384).** Between 769 and 900px the right sidebar slid in over the chat area as designed, but its `z-index: 1100` sat well below the composer's `99995`, so the bottom ~70px of the panel disappeared under the textarea and tapping that band did nothing. The mobile-overlay backdrop had the same bug. Bumped both sidebars (`.sidebar` and `.right-sidebar` on mobile breakpoints) to `100000` and the overlay to `99996` so they clear the composer while still sitting under modals (`100001`). Same fix applied to the ≤768px breakpoint.
- **Mobile "Voice / Stage active" indicator opened the sidebar without dimming the background (#5385).** Tapping the floating voice indicator slid the right userlist in via the `mobile-right-open` class but skipped the `.mobile-overlay.active` toggle, so the page underneath stayed fully interactive and tap-outside-to-close did nothing. Now mirrors the Members-button flow and activates the overlay too.
- **`pin_message` role permission did nothing in the message context menu.** The Pin / Unpin item was gated on `_canModerate()` (moderator level 25+) instead of the actual `pin_message` permission, so granting it to a role had no visible effect. The backend already enforced the right permission, only the client-side gating was wrong. Changed to `_hasPerm('pin_message')` so the button shows up exactly when the permission is granted.

### Documented
- **Reverse Proxy (Caddy / nginx / Traefik) section added to `GUIDE.md`.** Walks through setting `FORCE_HTTP=true` in `.env`, a minimal Caddyfile, an nginx snippet with the WebSocket `Upgrade` headers, and the tunnel + Caddy chain pattern. Common gotchas table covers the "browser still shows the self-signed cert" trap (missing `FORCE_HTTP=true`).

---

## [3.17.1] — 2026-05-23

### Added
- **Show/hide password toggle on every password input.** An eye button now appears inside login, register, SSO, recovery, and settings password fields so you can verify what you typed before submitting. Works on dynamically-injected forms too (transfer admin, delete account, E2E unlock, etc.).

### Fixed
- **Server fails to start with `ERR_INVALID_PACKAGE_CONFIG` on newer Node / Docker (#5374).** `package.json` in 3.17.0 contained a stray Windows-1252 em-dash byte (0x97) in the `description` field, producing invalid UTF-8. Newer Node versions (and the official Docker image) refuse to load the package and the container restart-loops. Replaced with plain ASCII so the file parses cleanly everywhere. Affects all 3.17.0 Docker deployments and self-hosted setups on Node 24+.
- **Expired/invalid tokens now redirect to login instead of stranding users on an empty channel list (#5375).** Previously the client required three consecutive socket auth errors before clearing the token, but transport errors mixed in could prevent the counter from ever tripping. JWT verify failures and `Session expired` are 100% deterministic and never transient, so the client now redirects to `/` on the first one. If your channel list ever went empty with a "Server Error" red dot after a long absence, that's why — and a single relaunch will now bounce you straight to the login screen.

---

## [3.17.0] — 2026-05-23

### Added
- **Pinned messages PiP floating panel (#5370).** A pop-out button (⧉) in the pinned-panel header opens a draggable, resizable picture-in-picture overlay so you can browse and manage pins without leaving the message feed. Supports jump-to-message, unpin (with confirm), and live updates when pins change. The panel closes automatically on channel switch so stale pins never linger.
- **Fullscreen button for pins PiP.** A maximize button in the PiP header expands the panel to fill the viewport, matching the behavior of the DM PiP.

### Fixed
- **Muted channels now block bot/webhook notifications and badge re-seeding.** Bot and webhook messages (sent with `user_id = null`) could bypass the mute check in the notification path — added a per-channel mute guard in `_fireNativeNotification` as defense-in-depth. Additionally, on reconnect or any channel-list refresh, the server's stale unread count was being re-imported for muted channels (the server has no knowledge of client-side mute state), so badges could reappear every session even for channels you'd muted. The `channels-list` handler now skips muted channels when seeding unread counts.
- **DM status dot showing offline users as online (#5372).** The presence dot on DM entries was not correctly reflecting offline state in certain cases.
- **PiP panel rendering below the message-input area (#5373).** Fixed z-index layering so PiP overlays always render above the composer toolbar.
- **Pinned panel action buttons now right-aligned.** Layout fix so the unpin and close buttons sit flush to the right edge of the panel header.

---

## [3.16.15] — 2026-05-20

### Fixed
- **Version display regression from v3.16.14 (#5369).** The v3.16.14 release tag was created without bumping `package.json`, so servers running v3.16.14 reported version v3.16.13 via `GET /api/version` and the `session-info` socket event. Corrected in this release.
- **Voice chat: ACTUAL ROOT CAUSE of the recurring self-vanish bug (#5347) — channel code rotation desync.** The new server-side `[VoiceDiag]` logs from the previous patch lit it up immediately: every time the bug hit, the server's auto-rotation timer had just rotated the channel's code (e.g. `95aa65d9 → aaeb3979`), but the voice clients still in the channel kept emitting `voice-rejoin` / `request-voice-users` / `voice-mute-state` with the OLD code. The server couldn't find the old code in the DB (because it was just updated), and the existing `channel-code-rotated` client handler only migrated `this.currentChannel` — it never touched `this.voice.currentChannel`. So every voice client was stuck holding a dead reference, the watchdog/self-heal loop ran forever, peers couldn't connect, and "everyone has to leave and rejoin to recover" was the only escape.
  - **Client now migrates voice-side state on rotation** (`this.voice.currentChannel` and `this.voice._softLeftChannel`), not just the text-channel state.
  - **Server now migrates the voice socket-room AND broadcasts the rotation event to the voice room too**, so users in voice but not viewing the text channel still receive the update.
  - **`pendingVoiceLeave` grace-period keys are rekeyed to the new code** so an in-flight disconnect mid-rotation can still be cancelled correctly.
- **Voice chat: null `audioCtx.currentTime` crash on leave (`voice.js:1829`).** The noise-gate `setInterval` and its hold-timeout could fire once after `leave()` nulled `this.audioCtx`, throwing `Cannot read properties of null (reading 'currentTime')`. Added guards so both paths bail safely if the audio context is gone.

---

## [3.16.14] — 2026-05-19

### Fixed
- **Voice chat: recurring "I vanished from my own voice panel even though I can still talk" glitch (#5347, again).** Previous patches added a soft-leave deferral and a passive self-inject in `voice-users-update`, but neither fixed the underlying cause: the server's `disconnect` handler was eagerly removing the user from `voiceUsers` on every blip and broadcasting `voice-user-left` to peers. On the common transient case (Electron renderer briefly suspends, NAT rebind, brief Wi-Fi hiccup) the user reconnected within a second or two, but by then peers had already torn down their `RTCPeerConnection`s — or worse, the server's roster was empty and the rejoin never fully repaired the local UI, so the user kept seeing only other people in the voice panel while their own mic still worked. This release stops the bleeding at the source:
  - **Server-side 4 s grace period before evicting on disconnect.** Instead of immediately calling `handleVoiceLeave`, the server now schedules eviction 4 seconds out. If the user's voice slot is reclaimed by a `voice-join` or `voice-rejoin` from a new socket before the timer fires, the eviction is cancelled, the `voiceUsers` entry is rebound to the new socketId, and peers are never told `voice-user-left` — meaning their `RTCPeerConnection`s stay live and audio is uninterrupted across the blip.
  - **Fast-path rejoin that skips peer renegotiation.** When the grace-period fast-path triggers, the server sends `voice-existing-users` with a new `skipRenegotiate` flag so the rejoining client does NOT rebuild fresh `RTCPeerConnection`s on top of working ones (which would have killed audio for no reason).
  - **Client-side voice roster watchdog.** Every 10 seconds, if we're in voice and the socket is connected, the client polls the server's authoritative roster with an `iAmInVoice: true` hint. If the server confirms we're missing despite claiming to be in voice, the existing self-heal path fires `voice-rejoin` automatically — so even if some edge case still leaves us in a desynced state, it self-corrects within 10 s instead of sticking forever until manual leave+rejoin.
  - Verbose `[VoiceDiag]` / `[VoiceWatchdog]` / `[VoiceSelfHeal]` server + client logs at every critical transition so any remaining edge case is trivially diagnosable from a single screenshot of the console.

---

## [3.16.13] — 2026-05-17

### Added
- **Channel and sub-channel composers are now drag-resizable (#5327).** Channel text areas previously auto-grew up to a hard cap of 5 lines and could not be enlarged further, which made composing longer multi-paragraph messages painful. A vertical drag handle (the same UI shipped for PiP DMs in v3.16.x) now sits at the top of the message-input area for channels and threads: grab it and drag up to expand the textarea up to 60 % of the viewport, drag back down to collapse. The dragged height is sticky across keystrokes and message sends — internally, the manual height is written as `min-height` inline on the textarea, which overrides the auto-grow's CSS `max-height` cap until the user manually shrinks it again.
- **Sub-channels inherit parent channel role access on creation (#5328).** When a sub-channel is created under a parent channel that has role-based access configured (e.g. a `@Mods` role granted on promote), the new sub-channel automatically copies the parent's `role_channel_access` rows and grants membership to current holders of any role marked `grant_on_promote`. Previously, every new sub-channel started with no role access at all, so admins had to re-add every role to every sub-channel by hand. Existing sub-channels are not touched (so any per-sub customisation you've already set up is preserved); the inheritance only runs at creation time, and per-sub access can still be customised afterwards in Channel Settings.

### Fixed
- **Voice chat: "I lose myself in the right panel after a while and have to leave + rejoin, which kicks everyone else out."** Two converging issues were driving the symptom on long-lived sessions:
  - **Transient socket blips were tearing down the entire voice session.** The `disconnect` handler used to immediately call `_softLeave()` — flipping `inVoice = false`, killing the mic stream and every `RTCPeerConnection` — on every dropped frame from the socket. Socket.io reconnects within a few hundred milliseconds on most blips (Electron renderer momentarily suspending, brief Wi-Fi hiccup, server-side keepalive miss), but by the time we reconnected the voice session was already in pieces and the panel could no longer self-inject us because `inVoice` was false. The teardown is now deferred by 2 seconds; if the socket reconnects in time (the common case), the soft-leave is cancelled and `voice-rejoin` rebinds our voice slot to the new socketId without rebuilding the mic or peers.
  - **When the panel did still drop us, we'd silently stay broken until a manual leave+rejoin.** The existing defensive self-injection patched the visible roster but never re-registered us with the server, so peers still had our stale socketId and our audio was dead until we manually toggled. The `voice-users-update` handler now also emits `voice-rejoin` (throttled to once per 3 s) whenever it has to inject self into the roster, so the server cleans up any stale entry of us and re-broadcasts a fresh roster to peers automatically.

---

## [3.16.12] — 2026-05-16

### Fixed
- **Voice chat: missing-self in the right panel after a server restart / reconnect race.** When the server briefly didn't have us in the voice roster at the moment a `voice-users-update` was rendered (re-render from a stale `_lastVoiceUsers` cache, a `request-voice-users` reply that arrived before our `voice-join` was processed, or a `voice-count-update` snapshot taken during a prune-and-re-register window), the right voice panel could show every other participant but omit ourselves while the status bar still said "Voice Connected". `_renderVoiceUsers()` now belt-and-suspenders injects the local user when we're in voice on the channel being rendered, tracked via a new `_lastVoiceUsersChannel` so the injection is correctly scoped (no false positives when viewing one channel while voice-connected to another). The `voice-count-update` handler does the same for the sidebar badge so the count never undershoots.
- **Voice chat: stale roster after a server reboot.** `request-voice-users` server-side now prunes stale voice entries before responding, and re-broadcasts the fresh roster to everyone in the room if any ghosts were removed. Previously, clients that reconnected after a server restart could momentarily see the pre-restart roster (or duplicate entries while peers were still reconnecting) until the next broadcast tick.
- **"Start Voice did nothing, I clicked it 15 times and got 15 toasts at once."** Three converging bugs caused the multi-press / multi-toast behaviour during a server outage:
  - `_fetchIceServers()` had no timeout, so when the server was unreachable the fetch hung until the network stack gave up, leaving `voice.join()` in-flight for tens of seconds while the user mashed the button. It now aborts after 4 seconds and falls back to the default STUN-only ICE config.
  - The Start Voice button accepted re-entrant presses while a join was in-flight. The first click would buffer a `voice-join` socket emit (socket.io queues emits while disconnected) and every subsequent click would buffer another, plus a stray `voice-leave` from the in-flight `voice.leave()` called at the top of `voice.join()`. All of them fired against the freshly-reconnected socket once the server came back, producing the toast flood and duplicate session churn. `_joinVoice()` now sets an `_joiningVoice` flag, disables the join buttons for the duration, and ignores re-entrant presses until the join resolves.
  - `voice.join()` no longer attempts to emit `voice-join` while the socket is disconnected — it bails immediately and returns `false`, so a click during the outage produces a clear "Disconnected" toast instead of silently queueing work. The `connect` handler still auto-rejoins voice from the persisted `haven_voice_channel` once the socket is back, so users don't need to click anything.

---

## [3.16.11] — 2026-05-16

### Fixed
- **Removed servers no longer reappear after a restart.** `ServerManager.add()` now honors the local "removed" set on bootstrap and sync paths — only an explicit click on **Add Server** in the modal can resurrect a previously-removed entry. Previously, every code path that called `add()` (Desktop history merge, Sync Servers, encrypted-backup pull) would silently delete the URL from the removed set and re-add it, so deleting a server in Manage Servers only stuck for one session.
- **Transient server restarts no longer log users out.** The socket `connect_error` handler now requires three consecutive auth errors before clearing the token and bouncing to the login page, instead of nuking the session on the first error. A single transient `Authentication required` / `Session expired` during a server restart (DB not yet ready, middleware racing init) is treated as recoverable. The streak resets on a successful connect.

---

## [3.16.10] — 2026-05-15

### Fixed
- **Displayed server version was stuck at `v3.16.5` even after updating (#5364).** The `v3.16.6` commit bumped `package.json` to `3.16.5` (off-by-one), and none of the subsequent v3.16.7 / v3.16.8 / v3.16.9 commits actually bumped the version field. Because both `/api/version` and the `session-info` socket emit read directly from `package.json`, every installation since v3.16.6 has reported itself as `v3.16.5` in the status bar regardless of which release was actually deployed — which also kept the in-app update banner flagging an update that users had already installed. Fixed by bumping `package.json` to `3.16.10` and bumping all `?v=` cache-bust query strings in `app.html` so the client also picks up the freshly versioned assets.
- **Belatedly shipping the originally-intended v3.16.5 fixes.** The `## [3.16.5]` changelog entry described an `edit-message` DM-PiP fix and a more detailed encrypted-upload error toast, but the corresponding code changes (`public/js/modules/app-admin.js`, `public/js/modules/app-utilities.js`, `src/socketHandlers/messages.js`) were never committed and only existed in the working tree. They are now committed as part of this release. Editing a message from a DM PiP while focused on a different server channel now resolves the correct channel server-side, and encrypted DM upload failures now show the underlying error message in the toast.

---

## [3.16.9] — 2026-05-15

### Fixed
- **You don't appear in the voice panel or sidebar while in voice.** After a socket reconnect (or any event that triggered a server-side voice broadcast during the rejoin window), `pruneStaleVoiceUsers` could briefly remove your entry before `voice-rejoin` re-registered the new socket. The resulting `voice-users-update` snapshot would contain everyone else but not you. Since `isInVoice` was still `true`, the self-filter didn't run, but your entry was simply absent from the server's payload, and the panel would stick showing only other participants. The fix: when we are confirmed to be in voice on a channel but our own entry is missing from the server snapshot, we inject it from local state before rendering.

---

## [3.16.8] — 2026-05-15

### Fixed
- **Phantom unread badge on current channel after returning from background.** When the app was backgrounded (alt-tabbed, minimised, or the BrowserView was hidden in Desktop's multi-server switcher) while the user was already at the bottom of a channel, incoming messages bumped the sidebar unread badge even though the user was actively reading that channel. The badge-clearing code only fires when a *new* message arrives while the page is visible, so if no further messages arrived the stale badge was stuck permanently. The fix clears the badge (and syncs `mark-read` to the server) immediately when the window/tab regains visibility and the user is still coupled to the bottom of the current channel.

---

## [3.16.7] — 2026-05-15

### Fixed
- **Images attached alongside a persona message now send as the persona.** Previously, when a user typed `::PersonaName message` with an image queued, the text arrived attributed to the persona but the image was a separate bare message from the real account. The image send now inherits the persona prefix, so both the text and any bundled images show the same persona.
- **Persona badge showed `??` instead of an icon.** The `🎭` persona label badge was rendering with a literal `??` placeholder (a forgotten CSS `::before` value) prepended to the word "persona". It now shows a 🎭 icon.

---

## [3.16.6] — 2026-05-15

### Added
- **Unpin from pinned-message panel.** Users with the `pin_message` permission (or admin) now see an **Unpin** button on every entry in the pinned-messages panel. Clicking it shows an "are you sure?" confirmation before removing the pin — no more having to scroll back to the original message, especially useful for encrypted DMs where that scroll is very far.

### Fixed
- **Webhook permission was admin-only despite a dedicated `manage_webhooks` role permission.** The `create-webhook`, `get-webhooks`, `delete-webhook`, and `toggle-webhook` socket handlers all rejected non-admin users even when they had `manage_webhooks` granted through a role. Now those handlers (and the per-channel Webhooks entry in the channel context menu) are accessible to any user with `manage_webhooks`. The bot-manager modal in Admin Settings remains admin-only.

---

## [3.16.5] — 2026-05-14

### Fixed
- **Editing messages in DM PiP did nothing.** The server's `edit-message` handler always resolved the target channel from `socket.currentChannel`. When a user was viewing a server channel but had a DM open in the floating PiP panel, `socket.currentChannel` pointed to the server channel — so the message lookup failed silently, the client's optimistic edit was rolled back, and nothing happened. The handler now accepts an optional `channelCode` from the client and falls back to `socket.currentChannel` (same pattern used by `delete-message`). The client now sends `channelCode` when editing from the PiP panel.
- **Encrypted image upload failure toast now shows the specific error.** When uploading an image in an E2E DM fails, the "Encrypted image upload failed" toast now includes the underlying error message (e.g. "Upload failed (403)" or "E2E not ready") to help diagnose the cause. Both the image path (`_uploadImage`) and the general file path (`_maybeUploadEncryptedDmFile`) are updated.

---

## [3.16.4] — 2026-05-14

### Fixed
- **Unicode letters blocked in channel names (#5362).** The channel-name validation regex used `\w` which is ASCII-only even with the `u` flag in JavaScript. Umlauts (ä, ö, ü), accented letters, and other non-ASCII characters were rejected with "invalid characters." Added `\p{L}\p{M}` (Unicode letter and combining-mark categories) to the regex, so any language's script is now accepted.

---

## [3.16.3] — 2026-05-14

### Fixed
- **Video/audio files not categorized in media gallery (#5361).** File attachments are stored in message content as `[file:name](url|size)`. The `|size` suffix was part of the URL field, causing the extension regex to fail (e.g. `.mp4|2.5` didn't match `\.mp4(?:$|[?#])`). As a result, all video and audio files fell into the "files" tab instead of "videos" or "audios." Fixed by updating the file-link regex to stop at `|`, and stripping the `|size` suffix from bare upload URLs before extension testing.

---

## [3.16.2] — 2026-05-13

### Fixed
- **[Windows] Start Haven.bat crashes CMD past v3.15.1 (#5358).** The SSL cert-generation block was restructured to use `goto` labels instead of a compound `else-if` + `call :subroutine`. On some Windows versions, returning from a `call` subroutine nested inside an `else-if` compound block causes cmd.exe to exit the script rather than return to the caller, closing the CMD window without any error output. The new `goto`-based flow keeps `%OPENSSL_CMD%` as a plain statement (outside any compound block) so it expands correctly at execution time without needing a subroutine at all, preserving the fix from #5351.
- **Published/custom theme not retained after page refresh (#5359).** Two root causes: (1) `window.havenSocket` was never assigned, so when a user clicked a published file theme button, the `set-preference` socket event was silently dropped and the server never stored the preference. On next load the server sent back an empty theme preference and the client fell through to the server's default theme, overwriting the `file:xxx` value in localStorage. Fixed by assigning `window.havenSocket` in `app.js` after the socket is created. (2) `theme-init.js` only set `data-theme` on early load; for `file:` themes it did not inject the CSS `<link>`, causing a flash of unstyled content on app.html refresh and no theme at all on the login page (where plugin-loader never runs). Fixed by injecting the `<link>` tag in `theme-init.js` when the saved theme is a `file:` theme, using `data-theme="haven"` as a stable base — matching what `applyFileTheme()` does — so the file theme applies immediately on both the app and login pages.

---

## [3.16.1] — 2026-05-12

### Fixed
- Voice presence: clicking Leave Voice now clears the right voice panel and the channel sidebar count immediately, without waiting for the server's `voice-users-update` broadcast to come back. After the server emit, the leaver was no longer in the `voice:<code>` room, so the broadcast could miss them and the panel stayed showing them as a participant. Mirrors the optimistic update already done on join. (#5347)
- Voice presence: defensively filter the local user out of incoming `voice-users-update` and `voice-count-update` payloads when not actually in voice on that channel, so a stale or in-flight broadcast can't re-populate the panel/sidebar after a leave.

---

## [3.15.8] — 2026-05-12

The one nobody saw coming. The reason all the v3.15.3-3.15.7 voice fixes appeared not to work for users is that **none of the client-side changes since v3.14.14 were actually being delivered to browsers.** The `<script>` cache-bust strings in app.html were pinned at `?v=3.15.2` and the ES-module imports inside app.js (which load app-voice.js, app-socket.js, app-users.js, etc.) were pinned at `?v=3.14.14`. Browsers happily kept serving the cached pre-3.15.4 client JS even on a fully-updated 3.15.7 server. So everything fixed since v3.14.14 was running on the server but missing from the client. The screen-share renegotiation work (3.15.5), the sidebar/voice-panel sync (3.15.4), the `_softLeave` rejoin path (3.15.4), the persona autocomplete fixes (3.15.6) — none of it ever ran in any browser. Apologies for the runaround on this one. (#5347)

### Fixed
- Bumped every `?v=` cache-bust string in `public/app.html` (3.15.2 → 3.15.8) and `public/js/app.js` (3.14.14 → 3.15.8). Forces every browser to fetch the post-3.14.14 client JS that the previous releases shipped to the server but never to the user.

---

## [3.15.7] — 2026-05-09

Hotfix on top of 3.15.4-3.15.6 (#5347). The voice presence work in 3.15.4 added a `getUserAllRoles` lookup inside `broadcastVoiceUsers` but the helper was never destructured from `createPermissions(db)`, so every voice broadcast (join, leave, mute, etc.) was throwing `ReferenceError: getUserAllRoles is not defined`. The error happened inside an async socket handler, so the server stayed up but the broadcast never completed: clients kept showing whoever was last successfully broadcast, ghost users persisted after leaves, and rejoiners didn't appear in the roster until everyone left and rejoined. This is the actual cause of the long-standing "voice list disagrees with reality" symptom, not the things 3.15.3-3.15.5 patched around it.

### Fixed
- **`ReferenceError: getUserAllRoles is not defined` on every voice broadcast (#5347).** Added the missing destructure in `setupSocketHandlers` and re-exported it on the shared ctx so domain modules can use it too. Voice user broadcasts now actually complete.
- **Saved server list (`PUT /api/auth/user-servers`) rejected as `PayloadTooLargeError` once the list got past ~50 servers.** The per-route `express.json({ limit: '96kb' })` in `auth.js` was being preempted by the global 16kb parser registered in `server.js`. Bumped the global json/urlencoded limit to 128kb. Individual routes still set their own tighter limits where appropriate.

---

## [3.15.6] — 2026-05-09

Follow-up fixes for personas (#5353).

### Fixed
- **Persona `::` autocomplete appeared in fullscreen DM view.** The PiP input already suppressed it, but the main `#message-input` (used when you open a DM as a full channel view) still ran `_checkPersonaTrigger`. Added a guard at the top of that function that bails out whenever the active channel is a DM.
- **Nickname set for a user overrode the persona name on their messages.** Message rendering called `_getNickname(msg.user_id, ...)` unconditionally, so any local nickname for the real account replaced the persona's display name. Persona messages now use `msg.username` (the persona name) directly, bypassing the nickname lookup.

---

## [3.15.5] — 2026-05-09

Long-standing screen-share reliability fixes. The flow had multiple silent-failure paths that left receivers with audio but no video (or no tile at all). This run unblocks the most common ones with a recovery handshake.

### Fixed
- **Screen share goes live but never appears for some viewers.** `_renegotiate` called `RTCPeerConnection.createOffer()` without checking `signalingState`, so any renegotiation that fired while a previous offer/answer was still pending threw and the catch silently swallowed it. The peer ended up with audio (already on the stable m-section) but no screen video, with no retry. The renegotiate now waits up to ~5s for the connection to reach a stable state before issuing the offer.
- **Late-joiner renegotiate skipped adding screen tracks if the sharer also had a webcam on.** The sharer's `renegotiate-screen` handler used a generic "any video sender exists" check to decide whether to add the screen tracks, which was true the moment a webcam track was attached. Result: late joiners got the webcam but never the screen. Now matches by track identity so screen tracks are added if and only if they aren't already on the connection.
- **`screen-share-started` was emitted after the renegotiation completed.** That meant receivers' `ontrack` for the new screen video could fire before `screenSharers.has(sharerId)` was true, so the screen-vs-webcam classifier in voice.js fell through to a default route that misbehaves when stale webcam state is present. The notification is now emitted before the per-peer renegotiation loop starts.
- **No recovery when the renegotiation offer was dropped or stalled.** Added a `request-screen-renegotiate` server event the receiver fires (a) ~3s after `screen-share-started` if no video receiver appeared on the peer, and (b) once during the existing video tile retry loop if `videoWidth` stays at 0. The server forwards a `renegotiate-screen` to the sharer, which re-issues an offer for that specific peer. This is what unblocks the "saw the indicator, heard the join sound, but the tile is empty / never came up" pattern that's been hitting one specific user in particular for months.

---

## [3.15.4] — 2026-05-09

Deeper voice presence fix on top of 3.15.3 (#5347). The previous patches cleaned up ghost entries but didn't address the actual reason peers couldn't see or hear each other after long idle periods.

### Fixed
- **Left sidebar and right voice panel could disagree (#5347 follow-up).** The two panels were driven by two unrelated client stores (`voice-users-update` only updated the right panel; `voice-count-update` only updated the sidebar). When one event arrived stale or out of order — typical in the rejoin / reconnect storm reported in the issue — the two views diverged and stayed diverged until a full reload. The right-panel handler now updates the sidebar stores as well, so both views are derived from the same authoritative event and cannot drift apart.
- **Reconnect after socket drop stopped using `voice-rejoin` (#5347 follow-up).** When the socket dropped while in voice, `_softLeave` cleaned up local audio and cleared `inVoice` / `currentChannel` so the reconnect handler couldn't tell we had been in voice. It fell back to a delayed `setTimeout(1500)` auto-rejoin that emitted plain `voice-join` instead of `voice-rejoin`, and `voice-join`'s stale-entry branch did not broadcast `voice-user-left` to the rest of the room. Other peers held on to a dead `RTCPeerConnection` and the rejoiner's fresh offer was applied on top of it, so audio never re-established. `_softLeave` now stashes the channel intent in `_softLeftChannel`, the reconnect handler picks that up and immediately re-acquires the mic, and `voice-join`'s stale-entry branch now mirrors `voice-rejoin` and broadcasts `voice-user-left` so peers tear down dead connections cleanly.
- **Connection-time voice snapshot was racing voice-rejoin's broadcast.** The 3.15.3 fix re-broadcast the room roster after pruning ghosts at connection time, but that broadcast went out before `voice-rejoin` had finished re-adding the rejoining user, so other clients briefly received a roster missing the rejoiner and the sidebar latched onto that view. The connection snapshot now only sends the count update to the connecting socket and lets `pruneStaleVoiceUsers` handle the per-ghost `voice-user-left` broadcast on its own.

---

## [3.15.3] — 2026-05-08

Further voice presence fix on top of 3.14.1 / 3.14.3 (#5347).

### Fixed
- **Voice list shows users who already left (#5347 follow-up).** Two server read paths (the connection-time voice snapshot and `get-voice-counts`) iterated the voice room map without pruning ghost entries from sockets that had disconnected in ways the cleanup missed (rejoin races, owner-mismatch on disconnect, dropped events). The result was the right-side voice panel showing the correct users while the left-side channel indicator still listed someone who left long ago. Both paths now prune first, broadcast the fresh roster (and `voice-user-left`) when they remove anyone so peer clients tear down dead RTCPeerConnections, and the disconnect handler also runs a prune pass on rooms it doesn't own so missed cleanups don't accumulate.

---

## [3.15.2] — 2026-05-08

Bug fixes for the media gallery, personas, and thread panel.

### Fixed
- **Thread panel hidden behind message bar (#5354).** Thread dock z-index raised above the composer bar so it's no longer clipped at wider viewport widths.
- **Persona autocomplete shown in DMs and threads (#5353).** The `::` persona autocomplete no longer appears in DM messages or thread replies, where personas aren't supported.
- **Persona tooltip shows raw i18n key (#5353).** The "Sent via …" badge tooltip was displaying `app.messages.via_persona` (missing locale key) instead of the actual real username.
- **Double ✕ button in media gallery (#5352).** The auto-inject expand/close control group is now skipped for the gallery modal, which already has its own close button.
- **Media gallery shown in DMs (#5352).** The gallery toolbar button is now hidden when viewing a DM channel, where it would show "no media available".
- **OpenSSL not recognized when starting Haven (#5351).** Fixed a cmd.exe delayed-expansion bug where `%OPENSSL_CMD%` expanded to empty inside the outer compound block even though OpenSSL had been found; the cert-generation command is now called via a subroutine so the variable expands at execution time.

---

## [3.15.1] — 2026-05-08

Polish pass on 3.15.0's Channel Media Gallery and Personas.

### Added
- **Persona prefix changed to `::` with autocomplete (#86, #5349).** The persona send prefix is now `::Name your message` (the previous `>>` was treated as a nested blockquote by the markdown renderer whenever the persona lookup didn't match). Typing `::` at the start of a message opens an autocomplete dropdown of your personas; arrow keys / Tab / Enter pick one and insert the full prefix.
- **`@PersonaName` mentions (#5349).** Persona names now resolve as `@`-mentions and ping the persona's owner. Names are gathered from messages as they render, so any persona that has spoken in the channel becomes mentionable.
- **Jump-to-message button on photo + video tiles in the gallery (#5350).** Each tile now has an arrow button in the top-right corner that closes the gallery and scrolls to the source message. Hovering or focusing the tile reveals the button.
- **Click-to-play video lightbox in the gallery (#5350).** Clicking a video tile now opens an inline player overlay with full controls instead of silently closing the gallery. The jump button (above) is preserved for navigating to the source message.

### Fixed
- **Message grouping bug when sending consecutive messages from different personas (#5349).** Subsequent messages from a different persona were being attributed to the first persona's avatar header because the "compact" grouping check only compared `user_id`. Grouping now also compares `persona_id`, and the message's persona id is persisted in the DOM so newly appended messages correctly start a new group.
- **Persona names with spaces not matching (#5349).** The server used a regex that excluded whitespace when extracting the persona name from the `::` prefix, so a persona called `Persona 1` would be parsed as `Persona` and fail the DB lookup, leaving the raw text unsent as a persona. Replaced with a loop over the user's own personas (sorted longest-name-first), doing a case-insensitive startsWith check. Handles any name regardless of spaces.
- **Image lightbox appearing underneath the media gallery modal (#5350).** Lightbox `z-index` bumped from `10000` to `100010` so it sits above modal overlays (`z-index: 100001`).
- **Top-bar header buttons (search, pinned, gallery, copy, etc.) now follow the existing "Colorful Emoji" / "Monochrome" toolbar setting in Appearance.** Previously these were monochrome-only regardless of the user's choice.
- **Burn-after-read channel resolved from PiP container instead of currentChannel.** Sending a burn-after-read message from the DM PiP was incorrectly using `currentChannel` (the channel visible in the main view) rather than the PiP's channel code.

### Security / verification
- Verified `get-channel-media` already enforces channel membership (`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`) with admin override, so users only see media from channels they're in.
- Verified the persona send-message handler already uses `WHERE user_id = ? AND name = ? COLLATE NOCASE`, so only the persona's owner can speak through it.

---

## [3.15.0] — 2026-05-08

### Added
- **Channel Media Gallery (#5350).** New 🖼 button in the channel header opens a near full-screen modal with five tabs: Photos, Videos, Audio, Files, and Links. Photos and videos render as a clickable album-style grid (photos open in the lightbox, videos jump to the source message). Audio, files, and links use a list layout with inline players, download links, and a jump-to-message button. Each entry shows the date it was posted. Tab counts update on open. Powered by a new `get-channel-media` socket handler that scans the channel for upload paths and external links.
- **Personas (#86, #5349).** Profile settings now have a "👥 Personas" section where you can create up to 25 named alter-egos with their own name and avatar, then send messages as one of them by typing `::Name your message` in chat (case-insensitive, the prefix is stripped before send). Each persona-sent message is stored with both the persona identity AND your real account ID, so messages are visibly tagged with a small `persona` badge (hover to see the real sender) and remain fully moderatable. Persona avatars upload via the same magic-byte-validated path as user avatars (2 MB cap). Persona names cannot collide with existing usernames or display names to prevent impersonation.

---

## [3.14.16] — 2026-05-07

### Fixed
- **Browser cache force-refreshed after status-icon patch series.** All `?v=` cache-busting strings on script and stylesheet tags bumped so browsers fetch updated files instead of serving stale cached copies from the 3.14.11+ patch set.
- **Message status icons (E2E lock, burn flame) completely reworked in the message layout.** Icons were rendering in a right-gutter column that misaligned with compact (grouped) messages and collided with message text on narrow layouts. They now occupy a fixed, right-anchored slot: the lock always sits at `right: 8px`, the flame shifts left in JS when both icons are present. Covers full-mode, compact-mode, and DM PiP renders. DM PiP fixed slot tightened to avoid excess whitespace when only one icon (or neither) is shown.
- **PiP parent message action controls anchored to outer message box.** The reply/react/etc. toolbar that appears on hover for parent messages inside the DM PiP was mispositioned after the inline status icon refactor. Controls are now anchored relative to the outer `.message` container.

---

## [3.14.10] — 2026-05-07

- **E2E recovery error messaging overhaul.** `e2e.syncFromServer()` now returns `{ ok, reason }` instead of a bare boolean, distinguishing `no-backup`, `bad-password`, `network`, and `error` cases. The "Recover Keys from Backup" toast now tells the user *exactly* what failed and — critically — **never** advises Reset for `bad-password` or `network` failures (Reset destroys all encrypted DMs). Previously a transient network blip or stale `wrappingKey` would surface as "no server backup found or password mismatch — try Reset instead", luring users into permanent data loss. All four `syncFromServer` callers in `app-platform.js` updated to consume the new structured result.
- **Recovery toast no longer disappears in 3 seconds.** Error toasts from the recovery flow now stay 8–10 s and use the standard opaque toast background (was 15 % opaque, essentially unreadable against animated theme backgrounds).
- **Composer no longer hides behind theme particle effects.** `.message-input-area` (input, toolbar, send button) given an explicit `z-index` above the `#fx-layers` overlay so gold-particle / snow / RGB themes don't render *over* the typing area.
- **Burn-after-read indicator cleanup.** Removed the orange vertical `border-left` line on burn-pending message bodies (it looked like a quote bar). The compact-mode flame icon is now vertically centered (was top-aligned to line 1) so it lines up with single-line messages and stays consistent with full-mode placement.
- **Manage Servers modal now fills its height when resized.** Added `.modal-flex` to the modal and a CSS rule so `.manage-servers-list` participates in the flex column layout. Dragging the bottom-right resize handle taller no longer leaves a giant empty band below the server rows.

---

## [3.14.6] — 2026-05-07

### Changed
- **DM channel codes are no longer exposed on the client.** DMs are implemented as special channels internally and have always carried a routing code, but that code is a pure implementation detail with no user-facing meaning. The server now strips `display_code`, `code_visibility`, `code_mode`, `code_rotation_type`, and `code_rotation_interval` from every DM channel object before sending it to clients. The `Copy DM Link` option has been removed from the DM right-click context menu, and the copy-link button is no longer rendered in the message toolbar inside DMs. The code still exists in the DB and is used by the server for socket-room routing; clients just no longer have access to a copyable version of it.

---

## [3.14.5] — 2026-05-07

### Security
- **#5348 — Third parties could join DMs via channel code or message link.** DM channel codes are not exposed in the web or desktop clients, but the Android client's long-press menu surfaced a `Copy Channel Code` option. Anyone with that code (or a `copy DM link` URL from the `...` menu) could call `join-channel` and be inserted as a member. Even though E2E prevents them from reading message content, they could observe metadata (who, when, how often). Fixed in the server's `join-channel` handler: any channel lookup that resolves to an `is_dm` channel now returns the same generic `Invalid channel code` error, indistinguishable from a non-existent code. No client changes required.

### Added
- **`Recover Keys from Backup` in the E2E dropdown.** The `🔐 Encryption options` menu (visible when in a DM) now has a middle option between `Verify Encryption` and `Reset Encryption Keys`. `🔄 Recover Keys from Backup` re-fetches the server-side encrypted keypair and unwraps it with your password. This is the non-destructive recovery path: existing encrypted messages remain readable after recovery. It's the right tool when a device ends up in ghost-state (e.g. auto-login without a password, or IndexedDB was cleared). If no server backup is found, it tells you to use Reset instead.

---

## [3.14.4] — 2026-05-07

### Fixed
- **Threads were still reachable inside DMs.** A previous attempt at removing them only unhooked the PiP code path (and even that broke - clicking Thread in a PiP DM dumped the user into the fullscreen pane, where the thread button was still wired). Threads are now removed from DMs at every layer: the message toolbar omits the thread button when the surrounding channel is a DM (PiP renders are tagged via `_isDmRender`), the existing thread preview block is suppressed on DM messages, the main-pane click handler bails out with a toast for DM channels, the PiP click handler no longer escalates to fullscreen, and the server's `send-thread-message` and `get-thread-messages` socket handlers reject any message whose channel has `is_dm = 1`. Threads remain available in regular channels and sub-channels exactly as before.

### Added
- **`Add to Channel` in the user gear menu.** The right-click context menu has had an `Invite to Channel` submenu for a while, but the gear menu (`Assign Role` / `Kick` / `Mute` / `Ban` / `Delete User` / `Transfer Admin`) didn't surface the same action. Added an `➕ Add to Channel` entry that mirrors the context menu's filter (any non-DM, non-private channel the caller can see; admins also see private channels) and opens a lightweight one-click picker. Server-side `invite-to-channel` permission gating is unchanged - the picker is purely an additional surface for an action that was already supported.

---

## [3.14.3] — 2026-05-07

### Fixed
- **#5325: Burn-after-read DMs never burned, and the sender saw no flame indicator on their own message.** `_wireBurnMessages` was being called with the freshly-appended message element as its `root`, then walking it with `querySelectorAll('.message-burn-pending:not([data-burn-wired])')`. `querySelectorAll` only matches *descendants* of the root, so the message element's own `.message-burn-pending` class was never picked up - sender got no flame label, recipient got no click-to-reveal button, and because the recipient never clicked anything, `mark-burning` never fired, `burning_started_at` was never stamped, and the server's burn sweep had nothing to count from. Burn DMs just sat in the channel forever. The wiring now treats the root element as a candidate too. (Note: a separate, deeper E2E key-sync issue can cause some DMs to render as `[Encrypted - unable to decrypt]` on devices that registered a fresh keypair after the message was sent. That is being tracked separately - the burn timer now fires regardless of whether the recipient can decrypt the plaintext.)
- **#5347 follow-up: voice participant list still didn't refresh until full client reload.** The 3.14.1 fix addressed the rejoin-after-disconnect path, but the underlying roster-update gate was still wrong: `voice-users-update` only re-rendered when the event's `channelCode` matched `this.currentChannel` (the *text* channel currently being viewed). If a user was talking on voice channel B but had clicked over to read text in channel A, every subsequent join/leave on B was discarded by the client. Now also re-renders whenever the user is actually in voice on the channel, independent of which text channel they're viewing.

---

## [3.14.2] — 2026-05-07

### Fixed
- **Role Assignment Center: per-user permission edits silently reverted on reopen.** `get-role-assignment-data` only sent each held role's *default* permissions back to the modal, so the checkbox grid was always seeded from `role_permissions` even after the admin had saved per-user overrides into `user_role_perms`. The save toast was honest — the overrides were persisted — but the next open looked identical to the last, making it appear nothing had stuck. Each `currentRoles` entry now carries an `effectivePerms` array (role defaults +/- the user's overrides for that exact `(role, channel)` scope) and the RAC seeds its checkboxes from that.
- **Role Assignment Center: assigning one role wiped every other role at the same scope.** `assign-role` ran a blanket `DELETE FROM user_roles WHERE user_id = ? AND channel_id = ?` (or the equivalent for server-wide) before re-inserting the single role being saved, which made the multi-role design the modal advertises ("Users may hold multiple roles per scope") impossible — saving an edit to one role silently revoked every sibling role. The handler now only replaces the row for *this* `(user, role, channel)` tuple.
- **Role Assignment Center: channel pane showed every channel for admins, even ones the target user couldn't access.** Admins could "assign" a Channel Mod role for a channel the user wasn't a member of, with no visual indication and no actual access being granted. The pane now only lists channels the target user is actually in (parent + subs), and adds an inline `+ Add user to channel…` picker for admins / `manage_roles` holders so the user can be invited into a new channel from inside the modal before being given a role there.
- **Role Assignment Center: `Transfer Admin` listed as a checkbox permission.** The `transfer-admin` socket handler is gated solely by `socket.user.isAdmin`; the `transfer_admin` permission row had no effect anywhere in the codebase, so it could be granted, look granted, and still do nothing. Removed from the RAC permissions grid entirely. The actual ownership transfer flow (gear menu → Transfer Admin, password-confirmed) is unchanged.
- **`assign-role`: `customPerms` was not validated against the caller's privileges.** A non-admin user with `promote_user` could craft a socket payload that included `manage_roles`, `manage_server`, `delete_channel`, etc. in `customPerms` and have the server insert a positive `user_role_perms` row for those, escalating the target above the caller. The server now drops admin-only perms unless the caller is an admin, drops anything the caller doesn't currently hold, and preserves any pre-existing override the caller wasn't authorised to touch (so a non-admin promoter can't strip an admin-granted override either).

---

## [3.14.1] — 2026-05-07

### Fixed
- **#5347: Voice rejoin after random disconnects leaves users with broken audio and empty voice panel.** Three independent bugs in the voice rejoin path were combining to produce the reported symptoms (rejoined users invisible to others, audio silent in both directions, voice bar still says "Voice Connected" while the panel shows "No one in voice", needing to leave and rejoin two or three times before voice recovers):
  - The server-side `voice-rejoin` handler silently overwrote the user's entry in `voiceUsers` without firing `voice-user-left` to the rest of the room. Other clients held on to a stale `RTCPeerConnection` from the previous session and the rejoiner's fresh offer was applied on top of dead ICE, so the audio path never re-established. It now mirrors the cleanup `voice-join` does — kicks the previous socket cleanly, broadcasts the leave, then re-adds the user. As a side effect the rejoin now also preserves `isMuted` / `isDeafened`, refreshes `voiceLastActivity` (so the AFK timer doesn't fire on a rejoiner), and includes the channel's `voiceBitrate` in the response (which `voice-join` already did).
  - The client `voice-offer` handler accepted the new offer onto an existing peer connection even when its `connectionState` was `failed` / `closed` or its `iceConnectionState` was `failed` / `closed`. The peer is now torn down and rebuilt in those states so the renegotiation starts clean.
  - The 2-second leave-retry in `VoiceManager.leave()` could fire `voice-leave` for a channel the user had already rejoined in the meantime, silently kicking them out server-side while the client UI still showed them connected — exactly matching the screenshot in the issue (voice bar shows "Voice Connected #ANC" but the voice panel reads "No one in voice"). The retry now bails out if the user has rejoined any voice channel.
  - Defensive: `_createPeer` now closes any pre-existing peer for the same userId before creating a new one, so an unexpected duplicate can't leak a second `RTCPeerConnection` and audio element.

---

## [3.14.0] — 2026-05-06

### Added
- **#5344: Registration token gate.** New admin-controlled gate that sits alongside (or instead of) the username whitelist on the registration page. When enabled, anyone signing up must enter a token the admin generated. The token is a 16-character hex string with Generate / Reroll, Copy, and Clear buttons in Settings → Admin → Whitelist. New `GET /api/auth/registration-info` exposes only a `requiresToken` boolean (never the token itself) so the registration page can reveal the field on demand. Whitelist + token can be active at the same time — both checks must pass.
- **#5345: Default channels for invite joiners + private-channel safety fix.** When someone joins via the server invite code or vanity link, admins can now curate exactly which public channels they land in via a checkbox list under Settings → Admin → Server Invite Code. "Select all" stores no allowlist (default behavior — every public channel). At the same time, the auto-join logic was tightened so private parent channels (`is_private = 1` or `code_visibility = 'private'`) are **never** unlocked by an invite code regardless of the allowlist — previously a private top-level channel was being granted alongside everything else, contradicting the original spec.

### Fixed
- **#5280: Burn-after-read DM toggle is now a true on/off toggle.** The 🔥 button used to auto-disarm itself after a single message, even though the click handler reads as a toggle. Now the toggle persists across messages until the user clicks it again to disarm (or switches to a non-DM channel, which still clears it for safety). Tooltip and toast text updated to reflect the persistent behavior.

### Added
- **#5341: Multi-role assignments per user.** Users can now hold multiple roles in the same channel or category scope simultaneously. The single-role dropdown in the "Assign Role" modal has been replaced with a checkbox list that pre-checks every role the user already holds and diffs the result on confirm — one click assigns newly checked roles and revokes unchecked ones, all without a reload. The Role Assignment Center (RAC) config pane now shows a per-role card list with state indicators (held / pending add / pending remove / edited), a Configure button that opens a level + permissions editor with an optional apply-to-sub-channels checkbox, and an add-role dropdown for assigning additional roles to the same scope. Voice users now carry a full `roles[]` array; in chat, the author's primary badge continues to use the highest role with a `+N` suffix when more roles are held (hover reveals the full list). The All Members admin list and profile popup both show the complete role set. A one-time admin notice explains the new system on first login.
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
- **#5342: Media bundled with a text message was blocked by slow mode.** When text and queued images were sent together, the client fired two separate socket events — the text consumed the slow-mode tick and each image immediately hit the cooldown and was rejected with a "wait Xs" toast. Messages sent as part of a combined text+image call now carry a `bundled=true` flag, and the server skips the slow-mode gate for bundled messages since the parent text already consumed the slot. Fix applies to both the main channel composer and the PiP DM image queue.
- **False CRITICAL performance alerts fired when the window was in the background.** Chromium throttles `requestAnimationFrame` to ~1 FPS when the renderer is hidden, which caused the FPS monitor to report 1–2 FPS averages and fire CRITICAL alerts every 15 seconds on perfectly healthy instances. Frame counting and the baseline timer now pause whenever `document.hidden` is true, so background throttling never pollutes the rolling sample window.
- **#5280 (follow-up): Burn-on-read visual indicator and pagination edge cases.** Senders no longer see the "tap to view" placeholder on their own burn messages (clicking it was inadvertently triggering mark-burning for the sender instead of the recipient). A small flame label now appears in the message header of every unstarted burn message so both sender and recipient see a visible indicator before the countdown starts; the label removes itself once the live countdown pill takes over. Burn messages loaded via forward or backward scroll pagination now also get the placeholder and countdown wired correctly (both pagination paths were missing the `_wireBurnMessages` call).
- **PiP DM and thread text inputs can now be resized vertically.** Both inputs had `resize: none` with a hard 120 px height cap. Changed to `resize: vertical` (200 px max, min-height keeps the handle visible); send/emoji buttons stay anchored to the bottom via `align-items: flex-end`. The drag handle is positioned center-horizontally for easier grabbing.

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
- **R