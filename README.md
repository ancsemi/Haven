# ⬡ HAVEN — Private Chat That Lives On Your Machine

> **Your server. Your rules. No cloud. No accounts with Big Tech. No one reading your messages.**

![Version](https://img.shields.io/github/v/release/ancsemi/Haven?label=version&color=blue)
![License](https://img.shields.io/badge/license-MIT--NC-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)

Haven is a self-hosted Discord alternative. Run it on your machine. Invite friends with a code. No cloud. No email signup. No tracking. Free forever.

<img width="1917" height="948" alt="Screenshot 2026-02-14 102013" src="https://github.com/user-attachments/assets/0c85ca6c-f811-43db-a26b-9b66c418830e" />

---

## 🖥️ NEW — Haven Desktop (Beta)

> **Want a native desktop experience?** Haven Desktop is a standalone app that connects to any Haven server — with features that go beyond the browser.

**[Haven Desktop](https://github.com/ancsemi/Haven-Desktop)** is now available as a public beta. Download the installer and connect to your server in seconds.

- **Per-Application Audio** — share audio from a single app during screen share, just like Discord. Powered by native WASAPI (Windows) and PulseAudio (Linux) hooks.
- **Audio Device Switching** — change your mic and speaker mid-call without leaving voice chat
- **Native Desktop Notifications** — OS-level notifications via the system tray
- **Minimize to Tray** — keeps running quietly in the background
- **One-Click Install** — NSIS installer (Windows), AppImage / .deb (Linux). Download, run, done.

> **⚠️ This is a beta release.** Bugs are expected. Your feedback is what makes it better — please [open an issue](https://github.com/ancsemi/Haven-Desktop/issues) if something breaks or feels off.
>
> **You still need a Haven server.** The desktop app is a client — it connects to a Haven server. Download and run [Haven](https://github.com/ancsemi/Haven) first if you haven't already.

📥 **[Download Haven Desktop →](https://github.com/ancsemi/Haven-Desktop/releases/latest)**

---

## 📱 Amni-Haven Android — Now on Google Play!

> **Want Haven on your phone?** Amni-Haven Android is a native Android app built from the ground up by Amnibro, now available on Google Play.

**Amni-Haven Android** features full chat and voice support, push notifications, and a true mobile-native experience.

- **Native Android** — built from scratch specifically for Haven, not a web wrapper
- **Push Notifications** — real-time notifications via Google Play services
- **Full Chat & Voice** — all the features you love, in your pocket

> **You still need a Haven server.** The Android app is a client — it connects to a Haven server. Download and run [Haven](https://github.com/ancsemi/Haven) first if you haven't already.

*Built with ❤️ by **Amnibro** — huge thanks for his incredible work building the Amni-Haven Android app from the ground up.*

📲 **[Get it on Google Play →](https://play.google.com/store/apps/details?id=com.havenapp.mobile&gl=US)**

---

## 🌐 Try Haven — No Download Required

> **Want to see what Haven looks like before hosting your own?** Jump into the community server and explore — chat, voice, themes, the works.

🔗 **[Join the Community Server →](https://haven.moviethingy.xyz/)**

After signing up, enter this channel code to join: **`da0b9be7`**

*Volunteer-hosted community server — thanks MutantRabbit!*

---

## NEW in v2.0.0 — Import Your Discord History

> **Leaving Discord?** Haven can import your entire server's message history — directly from the app. No external tools, no command-line exports, no hassle.

Open **Settings → Import** and connect with your Discord token. Haven pulls every channel, thread, forum post, announcement, reaction, pin, attachment, and avatar — then lets you map them to Haven channels. Your community's history comes with you.

- **Direct Connect** — paste your Discord token, pick a server, select channels & threads, import
- **File Upload** — or upload a DiscordChatExporter JSON/ZIP if you prefer
- **Full fidelity** — messages, replies, embeds, attachments, reactions, pins, forum tags, all preserved
- **Discord avatars** — imported messages show the original author's Discord profile picture
- **All channel types** — text, announcement, forum, media, plus active & archived threads

Your entire Discord history, now on a server you own. No one can delete it, no one can read it, no one can take it away.

---

## Quick Start — Docker (Recommended)

**Option A — Pre-built image** (fastest, easiest updates):
```bash
docker pull ghcr.io/ancsemi/haven:latest
docker run -d -p 3000:3000 -v haven_data:/data ghcr.io/ancsemi/haven:latest
```

Or with Docker Compose (recommended):
```bash
git clone https://github.com/ancsemi/Haven.git
cd Haven
docker compose up -d
```
The shipped `docker-compose.yml` uses the pre-built image by default.

**Option B — Build from source** (only if you need to modify the code):
```bash
git clone https://github.com/ancsemi/Haven.git
cd Haven
```
Uncomment `build: .` in `docker-compose.yml`, then:
```bash
docker compose up -d
```

Open `https://localhost:3000` → Register with username `admin` → Create a channel → Share the code with friends. Done.

> Certificate warning is normal — click **Advanced → Proceed**. Haven uses a self-signed cert for encryption.

**Updating** — if using the pre-built image (default):
```bash
docker compose pull
docker compose up -d --force-recreate
```

**Check your version**: visit `https://localhost:3000/api/version` in your browser.

**Option C — One-click cloud deploy** (Zeabur):

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates?repoURL=https://github.com/ancsemi/Haven)

---

## Quick Start — Windows (No Docker)

1. Download and unzip this repository
2. Double-click **`Start Haven.bat`**
3. If Node.js isn't installed, the script will offer to install it for you automatically

That's it. The batch file handles everything — Node.js installation, dependencies, SSL certificates, config — and opens your browser. Register as `admin` to get started.

> **Don't have Node.js?** No problem. The launcher detects this and can install it for you with one keypress. Or install it yourself from [nodejs.org](https://nodejs.org/) and restart your PC.

## Quick Start — Linux / macOS (No Docker)

```bash
chmod +x start.sh
./start.sh
```

Or manually: `npm install && node server.js`

---

## Who Is This For?

- **Small friend groups** who want a private place to talk
- **Self-hosters** who run services on their own hardware
- **Privacy-conscious communities** done with Big Tech
- **LAN gaming crews** who need voice + screen share without Discord
- **Homelab enthusiasts** looking for a lightweight chat service

---

<img width="1918" height="945" alt="Screenshot 2026-02-13 174344" src="https://github.com/user-attachments/assets/a1925091-46de-4fa6-bb8d-788985c974be" />


## Why Not Discord?

| | Discord | Haven |
|---|---------|-------|
| **Hosting** | Their cloud | Your machine |
| **Account** | Email + phone required | No email, no verification |
| **Your data** | Stored by Discord Inc. | Never leaves your server |
| **Cost** | Nitro upsells, boosts | Free forever |
| **Telemetry** | Analytics, tracking | Zero telemetry |
| **Source code** | Closed | Open (AGPL-3.0) |

---

## Features

| Category | What You Get |
|----------|-------------|
| **Chat** | Real-time messaging, image uploads (paste/drag/drop) with click-to-enlarge lightbox, typing indicators, message editing, replies, emoji reactions, @mentions with autocomplete, `:emoji` autocomplete, message pinning (admin) |
| **Voice** | Peer-to-peer audio chat, per-user volume sliders, mute/deafen, join/leave audio cues, talking indicators, click usernames for profile/DM |
| **Screen Share** | Multi-stream screen sharing with tiled grid layout, per-user video tiles, one-click close |
| **Channels** | Hierarchical channels with sub-channels, private (invite-only) sub-channels with 🔒 indicator, channel topics |
| **Join Codes** | Per-channel invite codes with admin controls: public/private visibility, static/dynamic mode, time-based or join-based auto-rotation, manual rotation |
| **Avatars** | Upload profile pictures (including animated GIFs!), choose avatar shape (circle/square/hexagon/diamond), per-user shapes visible to everyone |
| **Formatting** | **Bold**, *italic*, ~~strikethrough~~, `code`, \|\|spoilers\|\|, auto-linked URLs, fenced code blocks with language labels, blockquotes |
| **Link Previews** | Automatic OG metadata previews for shared URLs with title, description, and thumbnail |
| **GIF Search** | GIPHY-powered GIF picker — search and send GIFs inline (admin-configurable API key), plus a ★ Favorites tab that keeps the GIFs you actually use, stored in your own browser |
| **Custom Stickers** | Upload your own sticker packs (single or bulk), send from the picker or with `:stickername:` shortcodes — fresh installs ship with a starter pack |
| **Personas** | Send messages as alternate characters — type `::Name your message` with autocomplete, per-persona avatars, and `@PersonaName` mentions |
| **Direct Messages** | Private 1-on-1 conversations — click 💬 on any user in the member list |
| **User Status** | Online, Away, Do Not Disturb, Invisible — with custom status text and auto-away after 5 min idle |
| **Rich Presence** | See what people are playing and listening to, in the member list and on their profile — powered by **Last.fm**, **Steam**, **Spotify**, or Haven's own voice-channel music player. Entirely optional, can be hidden per-category, never shared while you're Invisible, and never written to the database |
| **File Sharing** | Upload and share PDFs, documents, audio, video, archives (up to 25 MB) with inline players |
| **Persistent Unread** | Server-tracked read state — unread badges survive page refreshes and reconnects |
| **Slash Commands** | `/shrug`, `/tableflip`, `/roll 2d20`, `/flip`, `/me`, `/spoiler`, `/tts`, and more — type `/` to see them all |
| **Search** | Search messages in any channel with Ctrl+F |
| **Themes** | 20+ themes with stackable visual effects: CRT, Matrix Rain, Cyberpunk Text Scramble, Snowfall, Campfire Embers, and more — configurable intensity/frequency sliders |
| **Multi-Server** | Add friends' Haven servers to your sidebar with live online/offline status |
| **Notifications** | 5 notification sounds, per-channel volume controls |
| **Moderation** | Admin: kick, mute (timed), ban, delete users, delete channels, auto-cleanup. Role system with granular permissions. |
| **Security** | Bcrypt passwords, JWT auth, HTTPS/SSL, rate limiting, CSP headers, input validation |
| **E2E Encryption** | ECDH P-256 + AES-256-GCM encrypted DMs — private keys never leave the browser |
| **Discord Import** | Import your entire Discord server history — channels, threads, forums, reactions, pins, avatars — directly from Haven's UI or via file upload |
| **Game** | Shippy Container — Drew's shipment got hung up. Server-wide leaderboard. |
| **Translations** | 7 languages out of the box (English, French, German, Spanish, Polish, Russian, Chinese). Community-contributed. |


<img width="1917" height="911" alt="Screenshot 2026-02-16 013038" src="https://github.com/user-attachments/assets/79b62980-0822-4e9d-b346-c5a93de95862" />


---

## 🌐 Translations (i18n)

Haven supports multiple languages. Users can switch languages from **Settings → Language** or the login page. The choice is saved per-browser.

| Language | Code | Status |
|----------|------|--------|
| English | `en` | ✅ Complete (reference) |
| Français | `fr` | 🟡 AI-generated, needs review |
| Deutsch | `de` | 🟡 AI-generated, needs review |
| Español | `es` | 🟡 AI-generated, needs review |
| Polski | `pl` | 🟢 Human-translated |
| Русский | `ru` | 🟢 Human-translated |
| 中文 | `zh` | 🟡 AI-generated, needs review |

### ⚠️ Translation Quality

Non-English translations were initially generated with AI assistance and **have not been fully reviewed by native speakers**. They may contain awkward phrasing, incorrect terminology, or outright errors. If you speak one of these languages, corrections are hugely appreciated.

### Contributing a Translation

**Improve an existing language:**
1. Open `public/locales/{code}.json` (e.g. `fr.json`)
2. Fix any incorrect or awkward translations
3. Submit a PR

**Add a new language:**
1. Copy `public/locales/en.json` to `public/locales/{code}.json`
2. Translate all values (keep the keys unchanged)
3. Fill in the `_meta` block with your language name and flag
4. Add the code to the `SUPPORTED` array in `public/js/i18n.js`
5. Add a `<option>` to both language selectors in `public/index.html` and `public/app.html`
6. Submit a PR

### Maintenance Reality

Translations are a community effort. As new features are added to Haven, new English strings appear, and other languages will fall behind until someone updates them. **Missing keys gracefully fall back to the English text**, so nothing breaks — you'll just see some English mixed in until someone contributes the translation.

If you'd like to "own" a language and keep it current, reach out via an issue. Long-term language maintainers are welcome and appreciated.

## Letting Friends Connect Over the Internet

When your friends are not on your WiFi network, you need to set up a means for them to connect remotely. There are many ways to do this, but in this documentation we'll cover two ways, both with varying levels of safety and difficulty. 

### Method 1 - Port forwarding - Safety Level: Unsafe

Opening up a port on your router means anybody on the entire internet is allowed to reach your Haven login page. There are a few issues with this approach that aren't immediately obvious. 
- Bot networks: Malicious actors use cheap [VPS services](https://en.wikipedia.org/wiki/Virtual_private_server) to run bot networks 24/7. The goal of these bot networks is simple: to detect vulnerable or poorly configured web services. Once you port forward on your network, within minutes your IP will start getting hit with malicious requests. Majority of these requests are harmless and will get rejected by Haven and/or your computer's firewall, but the risk of getting hacked is certainly not zero. 
   - These bot networks also consume a small fraction of your internet bandwidth. Nothing substantial, but it isn't zero either.
- DHCP risk: Majority of home routers use [DHCP](https://en.wikipedia.org/wiki/Dynamic_Host_Configuration_Protocol) to assign IP addresses on your WiFi network. This means your security cameras get a random IP, your printer gets a random IP, and obviously anything else that's on your WiFi gets a random IP. These addresses usually stay the same for a while, which is what makes this insidious. It works fine until the device or the router reboots, and then the device hosting Haven can land on a different IP. Now your port forward is pointing at whatever device took the old address. Your friends can't reach Haven anymore, and something else on your network is sitting there exposed instead.
   - The solution here is assigning a static IP to the device you're running Haven on. (Please refer to Step 2a)
- Brute force possibility: Your Haven login page is now reachable by the entire internet, and Haven currently has no rate limiting. Bots will throw username and password combinations at it from old data breaches, so if you reused a password from another site then you're vulnerable. 
   - Not to mention a persistent attacker hammering your Haven login page will slow down your service or flat out cause a [DoS](https://en.wikipedia.org/wiki/Denial-of-service_attack) which takes it completely offline.  

Nonetheless, if you understand the risks involved in port forwarding, please proceed below:

#### Step 1 — Find Your Public IP

Go to [whatismyip.com](https://whatismyip.com). That's the address your friends will use.

#### Step 2 — Port Forward

1. Log into your router (usually `http://192.168.1.1` or `http://10.0.0.1`)
2. Find **Port Forwarding** (sometimes called NAT or Virtual Servers)
3. Forward port **3000** (TCP) to your PC's local IP
4. Save

> **Find your local IP:** Open Command Prompt → type `ipconfig` → look for IPv4 Address (e.g. `192.168.1.50`), please jot this down for step 2a.

#### Step 2a: Static IP Assignment (Optional, but highly recommended to prevent complications further down the line)
1. Refer to [this guide](https://technologyaccent.com/how-to-find-mac-address-on-linux-mac-windows-and-android/). You're looking to find the MAC Address for the computer or server you'll be using to host Haven. It typically looks like A1:B2:3C:4D:5E:6F. If your computer has multiple network cards, like an ethernet card and a WiFi card, make sure to lookup the MAC address for your primary network card.
2. You'll also need your **private IP address**. You got this from Step 2.
3. Within your router admin page, find **Manual / Static IP Assignment** (typically under LAN / DHCP settings)
4. In the client / machine name, paste the MAC address. In the IP address section, enter the private IP address you located in step 2. Since you're using the IP your machine already has, your router will not complain that the IP is already taken.
5. Save your changes.
6. All the devices on your network will briefly disconnect and reconnect. Once you reconnect, locate your private IP address again and confirm it's still the same.

#### Step 3 — Windows Firewall

Open PowerShell as Administrator and run:
```powershell
New-NetFirewallRule -DisplayName "Haven Chat" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

#### Step 4 — Share With Friends

Send them:
```
https://YOUR_PUBLIC_IP:3000
```

Tell them to click **Advanced** → **Proceed** on the certificate warning. It's normal.

### Method 2 - Tailscale / Wireguard - Safety Level: Safe
- Unlike port forwarding, Tailscale does not require you to touch your router or your computer's firewall. Tailscale uses [Wireguard](https://en.wikipedia.org/wiki/WireGuard) under the hood, which is the same protocol many reputable VPN companies use. Wireguard creates an encrypted, end-to-end tunnel from your computer to your friend's computer. Most firewalls, like the one your router and computer use, allow outbound connections by default. Tailscale establishes a persistent, outbound connection to the Tailscale coordination server, which then allows your friends to connect. This is why configuring your firewall is not a requirement for this method. 
  
- Anyone who wants access to your Haven server will first need a **Share link** generated by you, the administrator, via your Tailscale admin dashboard. If you follow this guide correctly, your friend will **only** have access to Haven and strictly nothing else on your device.
- The obvious tradeoff with this approach is setup. Both you and your friends will need to connect to Tailscale anytime you want to access Haven. But the bright side of this approach is once setup is complete, and you're logged in, connecting to Tailscale is as simple as flipping a switch. Tailscale works on pretty much all devices you can think of, and it's seamless.
- To be clear, Tailscale does change your device's DNS settings. But unlike a traditional VPN, Tailscale **does not** route your internet traffic through some remote server. Tailscale is **purely** a connection between your computer, and your friend's computer. Your IP does not change and your internet speed doesn't slow down in any meaningful way.

> #### ⚠️ Voice chat over a *shared device*
> Text chat, uploads, and everything that flows **through** the Haven server work perfectly with the shared-device setup below. **Voice is the exception.** Haven voice is peer-to-peer: everyone in a call opens a direct connection to every *other* person in the call, not just to the host. Sharing a single device only puts the **host** machine on the shared path, so your friends can reach the host but not each other — and the return path from the host back to a friend isn't guaranteed either. The classic symptom is **one-directional audio** (everyone hears the host, but the host can't hear anyone). This isn't a bug in the shared-device config — it's just that a single shared machine can't provide the full mesh of paths a peer-to-peer call needs.
>
> Two ways to get voice working, most-recommended first:
> 1. **Add a TURN server** in Haven under **Settings → Admin → Voice & Connectivity (STUN/TURN)**. TURN relays all voice media through one reachable point, so the peer-to-peer paths are no longer required and the secure single-device sharing below keeps working exactly as written. This is the recommended fix — it keeps least-privilege sharing intact. (You can run your own [coturn](https://github.com/coturn/coturn) server or use a hosted TURN provider.)
> 2. **Put everyone on the same tailnet** instead of sharing one device. Tailnet members get direct connectivity to one another, so the mesh forms and voice works both ways. This works, but it gives your friends **broader access than device-sharing does** — read **Step 4** below and only do this if you accept that tradeoff.

#### Step 1 - Make an account
- Visit https://tailscale.com and make an account. Tailscale will walk you through downloading Tailscale onto your device, you may proceed with that.

- Once Tailscale is running on your machine, it may ask you to add another device, click the "Skip" button at the bottom of the page.

 
#### Step 2: Navigate to Tailscale admin page
Click [here](https://console.tailscale.com/admin/machines) to access the admin page. Here, you will see a list of all the devices on your Tailnet. 

#### Step 3: Lock down access
- Currently, if you share access to your Tailscale device, any other ports that are open on your machine will be reachable by your friends. We solve this issue by setting up ACL rules. ACL Rules will ensure only Haven is accessible by your friends, and strictly nothing else.
- On your Tailscale admin page, click "Access Controls".
- Click "JSON Editor" and replace everything in that section with the following, secure config:
   - Please ensure you copy everything, including the trailing comma at the end of the code block 
  ```
  {
  "grants": [
    // autogroup:member are members of your tailnet. We are sharing a device with your friends, NOT adding them to our tailnet. So you are the only person on your tailnet who should have this permission. And therefore, we are giving members of this tailnet unrestricted access to everything.
    {
      "src": ["autogroup:member"],
      "dst": ["*"],
      "ip":  ["*"],
    },

    // autogroup:shared are your friends who are connecting to your shared machine. This control restricts the port your friends may use to connect to your machine. If you changed your Haven port, make sure to change the ports to whatever port you set. Otherwise, leave everything below as default. 
    {
      "src": ["autogroup:shared"],
      "dst": ["*"],
      "ip":  ["3000", "3001"],
    },
  ],
   }
  ```

#### Step 4: Share, not invite
- This step is critical. There is a fundamental difference between inviting someone to your tailnet, and simply sharing one machine. The settings above DO NOT apply if you invite someone to your tailnet, and they will get access to your **whole tailnet**. If your Haven computer is running any other web server, or if you add more Tailscale devices down the road, your friends will have access to them. You do not want this. 
- To **SHARE** a device, go to your Tailscale admin page, click the 3 dot menu next to your device, and click **Share**. If you are sharing a link, make sure **Reusable link** is turned off. This way, each link you use only works once, and you maintain complete control over who can access your shared device.

#### Step 5: Sharing the link
- Once you provide a share link to your friend, he will need to make an account on Tailscale, download the client and connect on his machine. Please note, your friend **does not** need to share anything from his end. Only the person hosting Haven will have to share.
- Once your friend accepts the link, his device will now be able to reach your shared device.

#### Step 6: Usage
- Once everything is wired up, go to your Tailscale admin page, find your device, and notice the **IP Address** listed next to your device. This is your Tailnet IP address. It is not your actual IP address.
- Accessing Haven is as simple as going to https://TailscaleIPAddress:3000 (or whatever port you configured in ACL settings)
- Please note: If you are the one hosting Haven, you may also access Haven from your LAN IP that Haven is running on (typically 192.168.X.X), but your friends **need** to use your Tailscale IP. 

---

## Configuration

Haven creates a `.env` config file automatically on first launch — you don't need to create or rename anything. It lives in your **data directory**:

| OS | Data Directory |
|----|---------------|
| Windows | `%APPDATA%\Haven\` |
| Linux / macOS | `~/.haven/` |

> **Running Haven as a systemd service?** systemd runs the unit as the user
> you set in `User=` (often `root`), so `~/.haven/` resolves to that user's
> home (e.g. `/root/.haven/`) — *not* the directory you ran Haven from
> manually during testing. Set `HAVEN_DATA_DIR` to an absolute path in your
> `.env` *or* the unit's `Environment=` line so manual and service runs share
> the same data, certs, and `.env`. Example:
> ```
> Environment=HAVEN_DATA_DIR=/opt/haven-data
> ```

| Setting | Default | What It Does |
|---------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SERVER_NAME` | `Haven` | Your server's display name |
| `ADMIN_USERNAME` | `admin` | Register with this name to get admin powers |
| `JWT_SECRET` | *(auto-generated)* | Security key — don't share or edit this |
| `STEAM_API_KEY` | *(empty)* | Steam Web API Key for rich presence. Get yours at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) (any domain works). Once set, users can link their Steam account in **Settings → Connections** |
| `SSL_CERT_PATH` | *(auto-detected)* | Path to SSL certificate |
| `SSL_KEY_PATH` | *(auto-detected)* | Path to SSL private key |
| `HAVEN_DATA_DIR` | *(see above)* | Override the data directory location |
| `PUBLIC_URL` | *(auto-detected)* | Your server's public address, including `https://`. Only needed if Haven can't work it out itself — see below |

After editing `.env`, restart the server.

> **Steam or Spotify linking sending people to the wrong address?** If you run
> Haven behind Docker port mapping (say `8080:3000`), a reverse proxy that
> strips the port out of the Host header, or a Cloudflare Tunnel, the server
> can't reliably guess its own public address, so those sign-in round-trips
> fail. Set it explicitly:
> ```
> PUBLIC_URL=https://haven.example.com:8443
> ```
> For security this one is `.env`-only and deliberately **not** editable from
> the admin panel — a callback address that could be changed from the web UI
> would be a way to hijack sign-in redirects.

### Running Multiple Servers

You can run more than one Haven instance on the same machine. Each instance
needs its own copy of Haven, its own port, and its own data directory so the
databases don't conflict.

1. Clone or copy the Haven folder to a separate directory for each server.
2. In each copy, edit `.env` and set a unique `PORT` (e.g. `3000`, `3001`).
3. Set a unique `HAVEN_DATA_DIR` in each `.env` so each server stores its data
   separately (e.g. `HAVEN_DATA_DIR=C:\HavenData\server1`).
4. Start each server independently with `Start Haven.bat` (or `start.sh`).

That's it -- each instance runs on its own port with its own database,
uploads, and settings.

---

## Slash Commands

Type `/` in the message box to see the full list. Here are some highlights:

| Command | What It Does |
|---------|-------------|
| `/shrug` | ¯\\_(ツ)_/¯ |
| `/tableflip` | (╯°□°)╯︵ ┻━┻ |
| `/unflip` | ┬─┬ ノ( ゜-゜ノ) |
| `/roll 2d20` | Roll dice (any NdN format) |
| `/flip` | Flip a coin |
| `/me does something` | Italic action text |
| `/spoiler secret text` | Hidden spoiler text |
| `/tts hello` | Text-to-speech |
| `/nick NewName` | Change your username |
| `/clear` | Clear your chat view |
| `/bbs` | "Will be back soon" |
| `/afk` | "Away from keyboard" |

---

## Themes

25 themes, switchable from the sidebar:

**Haven** · **Discord** · **Matrix** · **Tron** · **HALO** · **Lord of the Rings** · **Cyberpunk** · **Nord** · **Dracula** · **Bloodborne** · **Ice** · **Abyss**

Your theme choice persists across sessions.


<img width="1919" height="908" alt="Screenshot 2026-02-16 013319" src="https://github.com/user-attachments/assets/f061491e-d998-4160-9971-b846cea83cd4" />


---

## Voice Chat

1. Join a text channel
2. Click **🎤 Join Voice**
3. Allow microphone access
4. Adjust anyone's volume with their slider
5. Click **📞 Leave** when done

Voice is peer-to-peer — audio goes directly between users, not through the server. Requires HTTPS.

- **Join / leave cues** — synthesized audio tones when users enter or leave voice.
- **Talking indicators** — usernames glow green when speaking (300 ms hysteresis for smooth animation).
- **Screen sharing** — click **🖥️ Share Screen** to broadcast your display. Multiple users can share simultaneously in a tiled grid.

---

## Admin Guide

If you registered with the admin username, you can:

- **Create / delete channels**
- **Kick users** — disconnects them (they can rejoin)
- **Mute users** — timed mute (can't send messages)
- **Ban users** — permanent ban (can't connect)
- **Delete users** — remove banned accounts (frees up their username)
- **Auto-cleanup** — configure automatic deletion of old messages (Settings → Admin)
- **Server settings** — EULA, max message age, DB size limits

Access admin controls in the **Settings** panel (⚙️ gear icon in the sidebar).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "SSL_ERROR_RX_RECORD_TOO_LONG" | Your browser is using `https://` but the server is running HTTP. **Change the URL to `http://localhost:3000`**, or install OpenSSL and restart to enable HTTPS (see below). |
| "Node.js is not installed" | The launcher offers to install it automatically. Or run `winget install OpenJS.NodeJS.LTS` in a terminal, restart, and try again. |
| Browser shows blank page | Clear cache or try incognito/private window |
| Friends can't connect | Check port forwarding + firewall. Make sure server is running. |
| "Error: EADDRINUSE" | Another app is using port 3000. Change `PORT` in `.env`. |
| Voice chat echoes | Use headphones |
| Voice doesn't work remotely | Must use `https://`, not `http://` |
| Certificate error in browser | Normal — click Advanced → Proceed |

### HTTPS / SSL Details

Haven **automatically generates self-signed SSL certificates** on first launch — but only if **OpenSSL** is installed on your system.

**How to tell which mode you're in:** Look at the startup banner in the terminal window. If the URL shows `http://` — you're on HTTP. If it shows `https://` — you're on HTTPS.

**If Haven falls back to HTTP** (no OpenSSL, or cert generation failed):
- Everything works fine for local use — just use `http://localhost:3000`
- Voice chat will only work on localhost, not for remote friends
- To enable HTTPS:
  1. Install OpenSSL: [slproweb.com/products/Win32OpenSSL.html](https://www.slproweb.com/products/Win32OpenSSL.html) (the "Light" version)
  2. During install, choose "Copy OpenSSL DLLs to the Windows system directory"
  3. Restart your PC
  4. Delete `%APPDATA%\Haven\certs` and re-launch `Start Haven.bat`

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Shift+Enter` | New line |
| `Ctrl+F` | Search messages |
| `@` | @mention autocomplete |
| `:` | Emoji autocomplete (type 2+ chars) |
| `/` | Slash command autocomplete |
| `::` | Persona autocomplete (send as one of your personas) |
| `Tab` | Select autocomplete suggestion |

---

## Backing Up Your Data

All your data lives in a dedicated directory **outside** the Haven code folder:

| OS | Location |
|----|----------|
| Windows | `%APPDATA%\Haven\` |
| Linux / macOS | `~/.haven/` |

Inside you'll find:
- **`haven.db`** — all messages, users, and channels
- **`.env`** — your configuration
- **`certs/`** — SSL certificates
- **`uploads/`** — uploaded images

Copy the entire folder somewhere safe to back up everything. The Haven code directory contains no personal data.

### Built-In Backups

You don't have to copy files by hand — Haven has backup tools built into the Admin panel (**Settings → Admin → Backup**):

- **One-click backup export** — download a backup archive with checkboxes for what to include (channels/roles, users, server settings, messages, uploaded files, and optionally DMs)
- **Scheduled auto-backups** — configure automatic backups on a schedule (daily, weekly, etc.)
- **Restore from backup** — upload a backup file to restore a server; the previous database and uploads are kept as `.pre-restore` copies for one cycle as a safety net

---

## GIF Search — GIPHY API Setup

Haven has a built-in GIF picker powered by **GIPHY**. To enable it you need a free API key.

### 1. Create a GIPHY Developer Account

1. Go to [developers.giphy.com](https://developers.giphy.com/)
2. Sign up for an account (or sign in)

### 2. Create an App

1. Click **Create an App**
2. Choose **API** (not SDK)
3. Give it any name (e.g. "Haven Chat") and a short description
4. Copy the **API Key** shown on the next page

### 3. Add the Key in Haven

1. Log into Haven as your **admin** account
2. Click the **GIF button** (🎞️) in the message input area
3. You'll see a setup prompt — paste your API key and save
4. The key is stored server-side in the database — only admins can see or change it

That's it. All users can now search and send GIFs.

> **Free tier:** GIPHY's free tier allows plenty of requests for a private chat server — you'll never come close to the limit.

---

## Rich Presence — Show What You're Playing & Listening To

Haven can show a member's current game or track in the member list and on their
profile card. Games take precedence in the member list so the sidebar stays
scannable, and the profile card shows a line for each, so someone doing both
gets both.

There are four sources, and **you only need as many as you want**:

| Source | Setup | Covers |
|--------|-------|--------|
| **Haven's music player** | None — works immediately | Whatever is playing in a Haven voice channel |
| **Last.fm** ⭐ | Server admin adds one API key; each user enters their username | Spotify, Apple Music, YouTube Music, Navidrome, Plex — anything that scrobbles |
| **Steam** | Server admin adds one API key; each user links their account | Games |
| **Spotify** | Server admin adds a client ID + secret; each user signs in | Spotify only |

### Why Last.fm is the recommended music source

Linking is just a username — no sign-in redirect, nothing stored, no per-user
cap. And because Spotify, Apple Music, YouTube Music, Navidrome and Plex all
scrobble to Last.fm, one connection covers whatever you actually listen with.

Spotify's own integration works, but a Spotify app in development mode is
limited to a small number of listed users, so it does not scale to a whole
server without extra approval from Spotify.

> Scrobbling has to be switched on in Last.fm's own settings first. Haven's
> setup panel explains how for each service.

### Adding the keys

1. Log into Haven as your **admin** account
2. Go to **Settings → Connections**
3. Each provider has a **Set up** button with a link to where its key comes from
4. Paste the key and save — it's written to `.env` automatically, no restart needed

Already configured a provider and need to swap a key (it leaked, or Steam
revoked it)? Hit **Change key** on that row. There's no need to hand-edit
`.env`.

### Privacy

Presence is **off until you turn it on**, is never shared while your status is
**Invisible**, can be hidden per-category (games separately from music), and is
never written to the database — it lives in memory only.

---

## Roadmap

Planned features — roughly in priority order:

| Feature | Status | Description |
|---------|--------|-------------|
| **Sub-channels** | ✅ Done | Hierarchical channels with auto-membership inheritance and private (invite-only) sub-channels |
| **Join code management** | ✅ Done | Admin controls: public/private visibility, static/dynamic mode, time/join-based rotation |
| **Role system** | ✅ Done | Role-based access with granular per-channel permissions |
| **Avatar system** | ✅ Done | Profile picture uploads with selectable avatar shapes (circle, square, hexagon, diamond) |
| **Effect system** | ✅ Done | 15+ stackable visual effects with configurable intensity/frequency |
| **Webhook / Bot support** | ✅ Done | Incoming webhooks and a lightweight bot API for external integrations |
| **Thread replies** | ✅ Done | Threaded conversations that branch off a message |
| **End-to-end encryption** | ✅ Done | ECDH P-256 + AES-256-GCM encryption for DMs — private keys stay in the browser |
| **Multi-factor authentication** | ✅ Done | TOTP authenticator app support (Google Authenticator, Authy, etc.) with backup codes |
| **Session invalidation on password change** | ✅ Done | All active sessions are forcibly logged out when a user changes their password |
| **Recovery-key password reset** | ✅ Done | Generate one-time recovery codes from Settings (🔑 Recovery) — reset your password from the login screen with no admin involvement and no email required |
| **Android App** | ✅ Released! | [Get it on Google Play](https://play.google.com/store/apps/details?id=com.havenapp.mobile&gl=US) |
| **Desktop App** | ✅ Beta! | https://github.com/ancsemi/Haven-Desktop |

> Want something else? Open an issue — PRs are always welcome.

---

## FAQ

**Is there an iOS app?**
We'd love to build one, but we don't currently have the capability to develop a native iOS app. It's on the list, but there's no timeline. In the meantime, Haven works great as a PWA — open your server URL in Safari and tap **Add to Home Screen** for an app-like experience.

**Is there an Android app?**
Yes! [Amni-Haven Android](https://play.google.com/store/apps/details?id=com.havenapp.mobile&gl=US) is available on Google Play, built from the ground up by Amnibro.

**Is there a desktop app?**
Yes — [Haven Desktop](https://github.com/ancsemi/Haven-Desktop) is available for Windows, macOS, and Linux with features like per-app audio sharing, native notifications, and system tray support.

**Can I use Haven without self-hosting?**
Yes. You can join someone else's Haven server if they share an invite link with you. You only need to self-host if you want to run your own server.

**Is Haven end-to-end encrypted?**
Haven supports optional E2EE for direct messages (ECDH P-256 + AES-256-GCM). Channel messages are stored on your server, so your data security depends on your hosting setup.

**Can I create bots for Haven?**
Yes. Haven supports webhooks with a REST API — bots can send messages, delete messages, play soundboard sounds, register custom slash commands, and receive message callbacks with HMAC-signed payloads. Set up webhooks in **Settings → Server Admin Settings → Bots**. See the [Bot Developer Guide](GUIDE.md#-bot--webhook-developer-guide) for full API docs.

**Does Haven have moderation tools?**
Yes — role-based permissions, kick/ban/mute, slow mode, read-only announcement channels, IP banning, and a full moderation REST API for bot-driven moderation.

**How do I report a bug or request a feature?**
Open an issue on [GitHub](https://github.com/ancsemi/Haven/issues). PRs are always welcome.

---

## License

AGPL-3.0 — free to use, modify, and share. Any modified version you deploy as a network service must release its source code. See [LICENSE](LICENSE).

Original project: [github.com/ancsemi/Haven](https://github.com/ancsemi/Haven)

---

<p align="center">
  <b>⬡ Haven</b> — Because your conversations are yours.
</p>
