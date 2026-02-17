


# ⬡ HAVEN — Private Chat That Lives On Your Machine

> **Your server. Your rules. No cloud. No accounts with Big Tech. No one reading your messages.**

![Version](https://img.shields.io/badge/version-1.8.0-blue)
![License](https://img.shields.io/badge/license-MIT--NC-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)



<img width="1917" height="948" alt="Screenshot 2026-02-14 102013" src="https://github.com/user-attachments/assets/0c85ca6c-f811-43db-a26b-9b66c418830e" />


---

## What Is This?

Haven is a **private chat server** you run on your own computer. Think Discord, but:

- **You own everything** — messages, data, the server itself
- **Nothing leaves your machine** — no cloud, no telemetry, no analytics
- **No account with anyone** — no email, no phone number, no verification
- **Free forever** — no subscriptions, no Nitro, no ads

You launch it, your friends connect to your IP address, and you have a private group chat with voice, images, streaming, music, themes, and games. That's it.

---

## Features

| Category | What You Get |
|----------|-------------|
| **Chat** | Real-time messaging, image uploads (paste/drag/drop), typing indicators, message editing, replies, emoji reactions, @mentions with autocomplete, message pinning (admin) |
| **Voice** | Peer-to-peer audio chat, per-user volume sliders, mute/deafen, join/leave audio cues, talking indicators |
| **Screen Share** | Multi-stream screen sharing with tiled grid layout, per-user video tiles, one-click close |
| **Channels** | Hierarchical channels with sub-channels, private (invite-only) sub-channels with 🔒 indicator, channel topics |
| **Join Codes** | Per-channel invite codes with admin controls: public/private visibility, static/dynamic mode, time-based or join-based auto-rotation, manual rotation |
| **Avatars** | Upload profile pictures, choose avatar shape (circle/square/hexagon/diamond), per-user shapes visible to everyone |
| **Formatting** | **Bold**, *italic*, ~~strikethrough~~, `code`, \|\|spoilers\|\|, auto-linked URLs, fenced code blocks with language labels, blockquotes |
| **Link Previews** | Automatic OG metadata previews for shared URLs with title, description, and thumbnail |
| **GIF Search** | GIPHY-powered GIF picker — search and send GIFs inline (admin-configurable API key) |
| **Direct Messages** | Private 1-on-1 conversations — click 💬 on any user in the member list |
| **User Status** | Online, Away, Do Not Disturb, Invisible — with custom status text and auto-away after 5 min idle |
| **File Sharing** | Upload and share PDFs, documents, audio, video, archives (up to 25 MB) with inline players |
| **Persistent Unread** | Server-tracked read state — unread badges survive page refreshes and reconnects |
| **Slash Commands** | `/shrug`, `/tableflip`, `/roll 2d20`, `/flip`, `/me`, `/spoiler`, `/tts`, and more — type `/` to see them all |
| **Search** | Search messages in any channel with Ctrl+F |
| **Themes** | 20+ themes with stackable visual effects: CRT, Matrix Rain, Cyberpunk Text Scramble, Snowfall, Campfire Embers, and more — configurable intensity/frequency sliders |
| **Multi-Server** | Add friends' Haven servers to your sidebar with live online/offline status |
| **Notifications** | 5 notification sounds, per-channel volume controls |
| **Moderation** | Admin: kick, mute (timed), ban, delete users, delete channels, auto-cleanup. Role system with granular permissions. |
| **Security** | Bcrypt passwords, JWT auth, HTTPS/SSL, rate limiting, CSP headers, input validation |
| **Game** | Shippy Container — Drew's shipment got hung up. Server-wide leaderboard. |

<img width="1918" height="945" alt="Screenshot 2026-02-13 174344" src="https://github.com/user-attachments/assets/a1925091-46de-4fa6-bb8d-788985c974be" />

---

## Quick Start (Windows)

### 1. Install Node.js

Download and install from **[nodejs.org](https://nodejs.org/)** (LTS version). Restart your PC after installing.

### 2. Download Haven

Download this repository and unzip it anywhere. Desktop is fine.

### 3. Launch

Double-click **`Start Haven.bat`**

A terminal window opens. When you see `HAVEN is running`, it's ready.

### 4. Open the App

Your browser should open automatically. If not, go to:
```
https://localhost:3000
```

> You'll see a certificate warning — that's normal. Click **Advanced** → **Proceed**. Haven uses a self-signed certificate for encryption.

### 5. Create Your Admin Account

1. Click **Register**
2. Use the username `admin` (or whatever you set in your data directory's `.env`)
3. Pick a password
4. You're now the admin — you can create channels

### 6. Create a Channel & Invite Friends

1. Type a channel name in the sidebar and click **Create**
2. A channel code appears (8 characters like `a3f8b2c1`)
3. Send this code + your IP address to your friends
4. They go to `https://YOUR_IP:3000`, register, and enter the code

---

## Quick Start (Linux / macOS)

```bash
chmod +x start.sh
./start.sh
```

The script handles everything: checks Node.js, installs dependencies, generates SSL certs, and launches.

Or manually:
```bash
npm install
node server.js
```

<img width="1917" height="911" alt="Screenshot 2026-02-16 013038" src="https://github.com/user-attachments/assets/79b62980-0822-4e9d-b346-c5a93de95862" />

---

## Letting Friends Connect Over the Internet

If your friends aren't on your WiFi, you need to open a port on your router.

### Step 1 — Find Your Public IP

Go to [whatismyip.com](https://whatismyip.com). That's the address your friends will use.

### Step 2 — Port Forward

1. Log into your router (usually `http://192.168.1.1` or `http://10.0.0.1`)
2. Find **Port Forwarding** (sometimes called NAT or Virtual Servers)
3. Forward port **3000** (TCP) to your PC's local IP
4. Save

> **Find your local IP:** Open Command Prompt → type `ipconfig` → look for IPv4 Address (e.g. `192.168.1.50`)

### Step 3 — Windows Firewall

Open PowerShell as Administrator and run:
```powershell
New-NetFirewallRule -DisplayName "Haven Chat" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### Step 4 — Share With Friends

Send them:
```
https://YOUR_PUBLIC_IP:3000
```

Tell them to click **Advanced** → **Proceed** on the certificate warning. It's normal.

---

## Configuration

Settings are in the `.env` file, stored in your **data directory** (created automatically on first launch):

| OS | Data Directory |
|----|---------------|
| Windows | `%APPDATA%\Haven\` |
| Linux / macOS | `~/.haven/` |

| Setting | Default | What It Does |
|---------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SERVER_NAME` | `Haven` | Your server's display name |
| `ADMIN_USERNAME` | `admin` | Register with this name to get admin powers |
| `JWT_SECRET` | *(auto-generated)* | Security key — don't share or edit this |
| `SSL_CERT_PATH` | *(auto-detected)* | Path to SSL certificate |
| `SSL_KEY_PATH` | *(auto-detected)* | Path to SSL private key |
| `HAVEN_DATA_DIR` | *(see above)* | Override the data directory location |

After editing `.env`, restart the server.

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

12 themes, switchable from the sidebar:

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
| "Node.js is not installed" | Install from [nodejs.org](https://nodejs.org/). Restart PC. |
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
  1. Install OpenSSL: [slproweb.com/products/Win32OpenSSL.html](https://slproweb.com/products/Win32OpenSSL.html) (the "Light" version)
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
| `/` | Slash command autocomplete |
| `↑` `↓` | Navigate autocomplete |
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
| **Thread replies** | 📋 Planned | Threaded conversations that branch off a message |
| **End-to-end encryption** | ✅ Done | ECDH P-256 + AES-256-GCM encryption for DMs — private keys stay in the browser |
| **Android App** | 🚧 In Progress! | https://github.com/ancsemi/Haven-App |

> Want something else? Open an issue — PRs are always welcome.

---

## License

MIT-NC — free to use, modify, and share. **Not for resale.** See [LICENSE](LICENSE).

Original project: [github.com/ancsemi/Haven](https://github.com/ancsemi/Haven)

---

<p align="center">
  <b>⬡ Haven</b> — Because your conversations are yours.
</p>
