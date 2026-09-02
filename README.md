# ⬡ HAVEN

**A private Discord alternative that runs on your own machine.** No cloud, no company
account, no telemetry, no paid tier. Free forever.

![Version](https://img.shields.io/github/v/release/ancsemi/Haven?label=version&color=blue)
![License](https://img.shields.io/badge/license-AGPL--3.0-green)
![Node](https://img.shields.io/badge/node-18%20to%2026-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)

One person runs the server. Everyone else joins with a code. Messages, files and
voice never touch anybody else's infrastructure.

<img width="1917" height="948" alt="Haven chat interface" src="https://github.com/user-attachments/assets/0c85ca6c-f811-43db-a26b-9b66c418830e" />

---

## Get started in about a minute

**Docker**

```bash
docker run -d -p 3000:3000 -v haven_data:/data ghcr.io/ancsemi/haven:latest
```

**Windows**, no Docker: download the zip, unzip it, double-click **`Start Haven.bat`**.
It installs Node.js for you if you do not have it.

**Linux / macOS**, no Docker: `chmod +x start.sh && ./start.sh`

Then open `https://localhost:3000`, register with the username `admin`, make a
channel, share the code. The certificate warning on first load is expected, click
**Advanced** then **Proceed**.

[One-click cloud deploy on Zeabur](https://zeabur.com/templates?repoURL=https://github.com/ancsemi/Haven) · [on RepoCloud](https://repocloud.io/details/Haven/) · [Full setup guide](GUIDE.md)

---

## Three ways in

| | |
|---|---|
| 🖥️ **[Haven Desktop](https://github.com/ancsemi/Haven-Desktop/releases/latest)** | Windows and Linux. Per-app audio sharing (send one app’s sound, nothing else), device switching mid-call, native notifications, tray. It can also **run the server itself**. |
| 📱 **[Haven for Android](https://play.google.com/store/apps/details?id=com.havenapp.mobile&gl=US)** | On Google Play. Native, not a web wrapper. Full chat, voice and push notifications. Built by [Amnibro](https://github.com/Amnibro). |
| 🌐 **Any browser** | Nothing to install. Send a link, they are in. Works on phones. |

Apps and browser talk to the same server and see the same thing, so nobody has to
install anything to be included.

**Want to look around first?** The [community server](https://haven.moviethingy.xyz/?invite=da0b9be7)
is open, no code needed, just sign up. Volunteer-hosted, thanks MutantRabbit.

---

## Why bother

| | Discord | Haven |
|---|---------|-------|
| Hosting | Their cloud | Your machine |
| Account | Email and phone | No email, no verification |
| Your messages | Stored by Discord Inc. | Never leave your server |
| Cost | Nitro, boosts | Free, no paid tier |
| Telemetry | Analytics and tracking | None |
| Source | Closed | Open, AGPL-3.0 |

---

## What you get

**Coming from Discord**

- **Import your whole server history** from inside Haven. Every channel, thread,
  forum post, reaction, pin and attachment. Paste a token, pick a server, go.
- **Ferry, a two-way Discord bridge.** Messages pass both ways between a Haven
  channel and a Discord channel, under each person's real name. Friends who are not
  ready to leave Discord can still talk to the ones who did.

**Talking**

- Voice chat, peer to peer so audio never routes through the server. Per-user
  volume, mute, deafen, noise suppression, talking indicators.
- Screen sharing, several people at once in a tiled grid. Watch parties work.
- Listen together with synced playback from Spotify, YouTube and SoundCloud, or a
  music player right in the voice channel.
- Threads, replies, reactions, pins, editing, mentions, polls, search, link
  previews, code blocks, spoilers.
- Direct messages, **end-to-end encrypted**. Private keys never leave the browser,
  so not even the person hosting can read them.
- Rich presence for what people are playing and listening to, via Steam, Last.fm or
  Spotify. Off until you turn it on, never written to the database.

**Making it yours**

- 26 built-in themes, a colour picker, an RGB cycle, and stackable visual effects
  like CRT, Matrix rain and snowfall.
- A plugin and theme system, so you can drop in your own without forking anything.
- Custom stickers, custom emoji, personas (send as an alternate character),
  soundboard, avatar shapes and borders.
- Server branding, sidebar layout options, font size and density controls.
- 8 languages out of the box, community translated.

**Running it**

- **One-click updates from inside the app.** Haven takes a pre-update backup and
  restarts itself.
- **Built-in backups**, scheduled or on demand, with restore.
- **Single sign-on** via OpenID Connect, so Authentik, Keycloak, Authelia and Auth0
  all work as your login.
- **Bots and webhooks** with a REST API. Send messages, play soundboard sounds,
  register slash commands, join voice, receive signed callbacks.
- Roles with per-channel permissions. Kick, timed mute, ban, IP bans, slow mode,
  automod link filtering, an audit log, and a moderation API.
- Guest accounts, invite links, per-channel join codes with automatic rotation.
- Push notifications, including UnifiedPush if you would rather leave Google out.
- Built-in Cloudflare and LocalTunnel support, so friends can reach you without
  port forwarding.
- Bcrypt passwords, JWT auth, HTTPS, MFA, rate-limited logins, and a disk reserve
  so a full drive never wedges the server.

<img width="1917" height="911" alt="Haven with themes applied" src="https://github.com/user-attachments/assets/79b62980-0822-4e9d-b346-c5a93de95862" />

---

## Documentation

Everything in detail lives in **[GUIDE.md](GUIDE.md)**: setup, Docker, remote access
(port forwarding, Tailscale, Cloudflare Tunnel, reverse proxies), themes, voice and
TURN, Discord import, Ferry, encryption, backups, configuration, translations, the
bot API, and troubleshooting.

Release notes are in [CHANGELOG.md](CHANGELOG.md).

---

## Contributing

Issues and PRs are welcome, including translations and themes. If you are reporting
a bug, the version number from `https://your-server:3000/api/version` helps.

## License

AGPL-3.0. Free to use, modify and share. If you deploy a modified version as a
network service, you have to publish its source. See [LICENSE](LICENSE).

---

<p align="center">
  <b>⬡ Haven</b>. Because your conversations are yours.
</p>
