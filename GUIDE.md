# ⬡ Haven — User Guide

Welcome to **Haven**, your private chat server. This guide covers everything you need to get Haven running and invite your friends.

---

## 📋 What You Need

- **Windows 10 or 11** (macOS / Linux can run it manually)
- **Node.js** version 18 or newer → [Download here](https://nodejs.org/)
- About **50 MB** of disk space
- **OR** just [Docker](https://docs.docker.com/get-docker/) — no Node.js needed

---

## 🐳 Docker Setup (Alternative)

If you'd rather run Haven in a container (great for NAS boxes, servers, or if you just like Docker):

### Quick Start

**Option A — Pre-built image** (fastest):
```bash
docker pull ghcr.io/ancsemi/haven:latest
docker run -d -p 3000:3000 -v haven_data:/data ghcr.io/ancsemi/haven:latest
```

**Option B — Build from source**:
```bash
git clone https://github.com/ancsemi/Haven.git
cd Haven
docker compose up -d
```

That's it. Haven will be running at `https://localhost:3000`.

### What Happens Automatically

- Self-signed SSL certs are generated on first launch (needed for voice chat)
- Database, config, and uploads are stored in a Docker volume (`haven_data`)
- The container runs as a non-root user for security
- Restarts automatically if it crashes

### Customizing

Edit `docker-compose.yml` to change the port, server name, or other settings. The environment variables are commented out with examples — just uncomment what you need.

### Using a Local Folder Instead of a Volume

If you want your data in a specific folder (common on Synology / NAS):

```yaml
volumes:
  - /path/to/your/haven-data:/data
```

Replace the `haven_data:/data` line in `docker-compose.yml`.

### Updating

**Option A — Pre-built image** (default, recommended):
```bash
docker compose pull
docker compose up -d --force-recreate
```

**Option B — Built from source** (only if you uncommented `build: .`):
```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Your data is safe — it lives in the volume, not the container.

### Checking Your Version

Open this URL in your browser (replace with your domain/IP if needed):
```
https://localhost:3000/api/version
```

Or from inside the container:
```bash
docker compose exec haven cat /app/package.json | grep '"version"'
```

### Linux Prerequisites

If you're on Linux (Ubuntu, Mint, Debian, etc.), make sure you have Docker's official packages installed — the default `docker.io` package from some distros may be missing Compose V2.

**1. Install Docker Engine + Compose plugin:**

```bash
sudo apt update
sudo apt install ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$UBUNTU_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

**2. Add your user to the `docker` group** (so you don't need `sudo` for every command):

```bash
sudo usermod -aG docker $USER
newgrp docker
```

After that, `docker compose up -d` should work without errors.

---

## 🚀 Getting Started

### Step 1 — First Launch

Double-click **`Start Haven.bat`**

That's it. The batch file will:
1. Check that Node.js is installed
2. Install dependencies (first time only)
3. Generate SSL certificates (first time only)
4. Start the server
5. Open your browser to the login page

### Step 2 — Create Your Admin Account

1. On the login page, click **Register**
2. Create an account with the admin username (default: `admin` — check your data directory's `.env` file)
3. This account can create and delete channels

### Step 3 — Create a Channel

1. In the sidebar, use the **Create Channel** box (admin only)
2. Give it a name like "General" or "Gaming"
3. Haven generates a unique **channel code** (8 characters)
4. Share this code with your friends — it's the only way in

### Step 4 — Invite Friends

Send your friends:
1. Your server address: `https://YOUR_IP:3000`
2. The channel code

They'll register their own account, then enter the code to join your channel.

---

## 📂 Channels & Sub-Channels

### How Channels Work

Every conversation in Haven happens inside a **channel**. Channels are like rooms — each has a unique 8-character code (e.g. `a3f8b2c1`). To get into a channel, you either create it or enter its code.

### Creating Sub-Channels

Right-click (or click ⋯) on any channel to create a **sub-channel** beneath it. Sub-channels appear indented under their parent with a `↳` icon. They have their own code and their own message history.

**When you create a sub-channel:**
- All current parent channel members are **automatically added** to it
- The sub-channel gets its own unique invite code
- Max one level deep (no sub-sub-channels)

**When someone joins a parent channel later:**
- They're **automatically added** to all non-private sub-channels of that parent
- They do NOT get access to private sub-channels (see below)

### Private Sub-Channels 🔒

When creating a sub-channel, check the **🔒 Private** checkbox. Private sub-channels:
- Only add the **creator** as initial member (not all parent members)
- Show a **🔒** icon instead of `↳` in the sidebar
- Appear in *italic* text with reduced opacity
- Can only be joined by entering the sub-channel's code directly
- Are invisible to non-members (they won't see it in their channel list)

Use private sub-channels for admin-only discussions, sensitive topics, or small breakout groups within a larger channel.

---

## � Importing from Discord

Haven can import your entire Discord server's message history — directly from the app. No external tools required.

### Method 1: Direct Connect (Recommended)

1. Open **Settings** (⚙️ in the sidebar) → scroll to **Import Discord History**
2. Click the **🔗 Connect to Discord** tab
3. Get your Discord token:
   - Open Discord in your browser (or desktop app with dev tools enabled)
   - Press **F12** → go to the **Application** tab
   - In the left sidebar: **Local Storage** → **https://discord.com**
   - Find the key called **`token`** and copy its value (without quotes)
4. Paste the token and click **Connect**
5. Pick a server from the grid, then select which channels and threads to import
6. Click **Fetch Messages** — Haven downloads everything
7. In the preview, rename channels if you want, then click **Import**

**What gets imported:** messages, replies, embeds, attachments, reactions, pins, forum tags, and original Discord avatars.

**Channel types supported:** text, announcement, forum, media, plus active and archived threads.

### Method 2: File Upload

If you prefer, export your Discord data with [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) (JSON format), then:

1. Open **Settings** → **Import Discord History**
2. Click the **📁 Upload File** tab
3. Drag/drop or browse for the `.json` or `.zip` file
4. Preview, rename channels, and import

### Important Notes

- Imported messages appear as the original Discord usernames, but they're all stored under the admin account. They're clearly marked as imported from Discord.
- The import is **history only** — Discord roles, permissions, bots, and webhooks are not imported.
- Your Discord token is never stored by Haven. It's used only during the import session and discarded.

---

## �🔑 Join Code Settings (Admin)

Each channel's invite code can be configured by admins. Click the **⚙️ gear icon** next to the channel code in the header.

### Code Visibility
| Setting | Behavior |
|---------|----------|
| **Public** | All members can see the channel code |
| **Private** | Only admins see the code; others see `••••••••` |

### Code Mode
| Setting | Behavior |
|---------|----------|
| **Static** | Code never changes |
| **Dynamic** | Code automatically rotates based on a trigger |

### Rotation Triggers (Dynamic mode only)
| Trigger | Behavior |
|---------|----------|
| **Time-based** | Code rotates every X minutes |
| **Join-based** | Code rotates after X new members join |

You can also click **Rotate Now** to manually change the code immediately.

> 💡 Dynamic codes are great for public communities where you want to limit code sharing. Old codes stop working after rotation.

---

## 🖼️ Avatars

### Uploading a Profile Picture

1. Click the **⚙️ Settings** button in the sidebar
2. In the **Avatar** section, click **Upload**
3. Choose an image (max 2 MB; JPEG, PNG, GIF, or WebP)
4. Pick a shape: ⚪ Circle, ⬜ Square, ⬡ Hexagon, or ◇ Diamond
5. Click **Save**

Your avatar and shape are visible to everyone in messages and the member list. Each user's shape is stored independently.

### Removing Your Avatar

Click **Clear** to remove your avatar and revert to the default initial-letter avatar.

---

## 🎨 Themes & Effects

### Themes

Haven includes 20+ visual themes. Click the **🎨** button at the bottom of the sidebar to open the theme picker. Themes change colors, fonts, and overall aesthetic. Your choice is saved per browser.

### Effect Overlays

Effects are stackable visual layers on top of any theme. Choose from the effect selector in the theme popup:

| Effect | Description |
|--------|-------------|
| **⟳ Auto** | Matches your current theme's default effect |
| **🚫 None** | No overlays |
| **📺 CRT** | Retro scanlines + vignette + flicker |
| **Ⅿ Matrix** | Green digital rain cascade |
| **❄ Snowfall** | Falling snowflakes |
| **🔥 Campfire** | Ember particles + warm glow |
| **💍 Golden Grace** | Elden Ring-style golden particles |
| **🩸 Blood Vignette** | Dark pulsing edges |
| **☢️ Phosphor** | Fallout-style green vignette |
| **⚔️ Water Flow** | Gentle blue sidebar animation |
| **🧊 Frost** | Ice shimmer + icicle borders |
| **⚡ Glitch** | Cyberpunk text scramble (see below) |
| **⚜ Candlelight** | Warm sidebar glow |
| **🌊 Ocean Depth** | Deep blue vignette |
| **✝️ / ⛪ / 🕊️** | Sacred themed overlays |

### Cyberpunk Text Scramble ⚡

When the Glitch effect is active, text around the UI randomly "scrambles" — cycling through random characters before resolving back to the original text. This affects:
- The **HAVEN** logo
- Channel names in the sidebar
- Section labels
- Your username
- The channel header
- User names in the member list

A **Glitch Frequency** slider appears in the theme popup when this effect is active. Slide left for rare, subtle glitches — or right for constant chaos.

---

## 🌐 Setting Up Remote Access (Friends Over the Internet)

If your friends are **not** on your local WiFi, you need to set up port forwarding so they can reach your PC from the internet.

### Find Your Public IP

Visit [whatismyip.com](https://whatismyip.com) — the number shown (like `203.0.113.50`) is what your friends will use.

### Port Forwarding on Your Router

Every router is different, but the general steps are:

1. **Log into your router** — usually `http://192.168.1.1` or `http://10.0.0.1` in your browser
2. Find **Port Forwarding** (sometimes called NAT, Virtual Servers, or Applications)
3. Create a new rule:

   | Field | Value |
   |-------|-------|
   | Port | `3000` |
   | Protocol | TCP |
   | Internal IP | Your PC's local IP (e.g. `10.0.0.60`) |

4. Save and apply

> **How to find your local IP:** Open Command Prompt and type `ipconfig`. Look for the "IPv4 Address" under your Ethernet or WiFi adapter.

### Windows Firewall

The server needs permission to accept incoming connections:

1. Open **Start Menu** → search **"Windows Defender Firewall"**
2. Click **"Advanced settings"** on the left
3. Click **"Inbound Rules"** → **"New Rule..."**
4. Select **Port** → **TCP** → enter `3000`
5. Allow the connection → apply to all profiles
6. Name it something like "Haven Chat"

Or run this in PowerShell (as Administrator):
```powershell
New-NetFirewallRule -DisplayName "Haven_Chat" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### Tell Your Friends

Send them this URL:
```
https://YOUR_PUBLIC_IP:3000
```

> ⚠️ **Certificate Warning:** Your friends' browsers will show a security warning because Haven uses a self-signed certificate. This is normal and expected. Tell them to click **"Advanced"** → **"Proceed to site"**. The connection is still encrypted.

---

## � Cloudflare Tunnel (No Port Forwarding)

If you don't want to mess with port forwarding or expose your home IP, you can use a **Cloudflare Tunnel** to securely share your Haven server over the internet. Cloudflare gives your server a public URL and handles all the networking — no router config needed.

### Step 1 — Install Cloudflared

**Windows (via winget):**
```powershell
winget install cloudflare.cloudflared
```

**macOS (via Homebrew):**
```bash
brew install cloudflared
```

**Linux:**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
```

Verify it installed:
```bash
cloudflared --version
```

### Step 2 — Enable the Tunnel in Haven

1. Start Haven normally (`Start Haven.bat`)
2. Log in as admin
3. Open **⚙️ Settings** → scroll to the **Tunnel** section
4. Select **Cloudflare** as the tunnel provider
5. Flip the toggle **on**
6. Haven will start cloudflared and display your public URL (e.g. `https://abc-def-123.trycloudflare.com`)

### Step 3 — Share the URL

Copy the tunnel URL and send it to your friends. That's it — no port forwarding, no firewall rules, no IP address sharing. The URL changes each time you restart the tunnel, so you'll need to re-share it.

### How It Works

- Haven runs **cloudflared** as a child process that creates an encrypted tunnel to Cloudflare's network
- Cloudflare assigns a random public URL and proxies traffic through the tunnel to your local server
- Your home IP is **never exposed** to visitors — they only see Cloudflare's IP
- Since Haven runs HTTPS with a self-signed cert, the tunnel connects to `https://localhost:3000` with TLS verification disabled (the Cloudflare→You leg is already encrypted by the tunnel itself)

### Tunnel vs. Port Forwarding

| | Port Forwarding | Cloudflare Tunnel |
|---|---|---|
| **Router config** | Required | None |
| **Exposes home IP** | Yes | No |
| **Firewall rules** | Required | None |
| **Stable URL** | Your IP (may change) | Random URL (changes on restart) |
| **Push notifications** | ✅ (if HTTPS) | ✅ |
| **Voice chat** | ✅ | ✅ |

> 💡 **Tip:** For a permanent URL, you can set up a free Cloudflare account and use a named tunnel with your own domain. See [Cloudflare's tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for details.

### Troubleshooting Tunnels

| Problem | Solution |
|---------|----------|
| "cloudflared not found" | Restart your terminal after installing, or add it to your PATH manually |
| Tunnel shows "502 Bad Gateway" | Make sure Haven is running before enabling the tunnel |
| URL changes every restart | Normal for quick tunnels. Use a named tunnel + custom domain for permanence |
| "Connection refused" in tunnel logs | Haven isn't running on port 3000, or it's running HTTP instead of HTTPS |

---

## �🔧 Router-Specific Tips

### Xfinity / Comcast (XB7 Gateway)

1. Open the **Xfinity app** on your phone
2. Go to **WiFi** → scroll down → **Advanced settings** → **Port forwarding**
3. Select your PC from the device list
4. Add port `3000` (TCP/UDP) and apply
5. **Important:** Go to **Home** → disable **xFi Advanced Security** — it silently blocks all inbound connections
6. Verify the **reserved IP** in port forwarding matches your PC's actual IP (`ipconfig` to check)

### Common Issues

| Problem | Solution |
|---------|----------|
| **"SSL_ERROR_RX_RECORD_TOO_LONG"** | Browser is using `https://` but server is running HTTP. Change URL to `http://localhost:3000`, or install OpenSSL and restart (see Troubleshooting below) |
| Friends get "took too long to respond" | Port forwarding not set up, or firewall blocking |
| Friends get "connection refused" | Server isn't running — launch `Start Haven.bat` |
| Can't connect with `https://` | Make sure you're using port 3000, not 443 |
| Voice chat doesn't work | Must use `https://` — voice requires a secure connection |
| "Certificate error" in browser | Normal — click Advanced → Proceed |

---

## 🎨 Themes

Haven comes with 6 themes. Switch between them using the theme buttons at the bottom of the left sidebar:

| Button | Theme | Style |
|--------|-------|-------|
| ⬡ | **Haven** | Deep blue/purple (default) |
| 🎮 | **Discord** | Dark gray with blue accents |
| Ⅿ | **Matrix** | Black and green, scanline overlay |
| ◈ | **Tron** | Black with neon cyan glow |
| ⌁ | **HALO** | Military green with Mjolnir vibes |
| ⚜ | **LoTR** | Parchment gold and deep brown |
| 🌆 | **Cyberpunk** | Neon pink and electric yellow |
| ❄ | **Nord** | Arctic blue and frost |
| 🧛 | **Dracula** | Deep purple and blood red |
| ⚔ | **Bloodborne** | Gothic crimson and ash |
| ⬚ | **Ice** | Pale blue and white |
| 🌊 | **Abyss** | Deep ocean darkness |

Your theme choice is saved per browser.

---

## 🎤 Voice Chat

1. Join a text channel first
2. Click **🎤 Join Voice** in the channel header
3. Allow microphone access when your browser asks
4. Click **🔇 Mute** to toggle your mic
5. Click **📞 Leave** to disconnect from voice

Voice chat is **peer-to-peer** — audio goes directly between you and other users, not through the server.

> Voice requires HTTPS. If you're running locally, use `https://localhost:3000`. For remote connections, use `https://YOUR_IP:3000`.

### TURN Server (Voice Over the Internet)

By default, voice/screen sharing uses STUN servers, which work when both users are on the same network or behind simple NATs. For connections across different networks (especially mobile data / 5G), you need a **TURN server** to relay traffic.

**Quick setup with coturn (free, open-source):**

```bash
# Ubuntu/Debian
sudo apt install coturn

# /etc/turnserver.conf:
listening-port=3478
tls-listening-port=5349
realm=your-domain.com
use-auth-secret
static-auth-secret=YOUR_RANDOM_SECRET_HERE
```

Then add to your Haven `.env`:

```env
TURN_URL=turn:your-server.com:3478
TURN_SECRET=YOUR_RANDOM_SECRET_HERE
```

Restart Haven, and voice/screen sharing will work across any network.

> **Docker users:** Add `TURN_URL` and `TURN_SECRET` as environment variables in your `docker-compose.yml`. See the commented example in the default compose file.

> **Oracle Cloud / cloud VMs:** Make sure ports 3478 (UDP+TCP) and 49152–65535 (UDP) are open in your security group / firewall rules. These are needed for TURN relay traffic.

---

## 🔔 Push Notifications

Push notifications let you receive alerts when someone messages a channel you're in, even when the Haven tab is in the background or closed.

### Requirements

- **HTTPS is required.** Push notifications use Service Workers, which only work over `https://` or `localhost`. If you're accessing Haven via a LAN IP like `http://192.168.1.x:3000`, push will **not** work.
- A modern browser (Chrome, Edge, Firefox, or Safari 16+)
- Haven must be running with SSL certificates (the default if OpenSSL is installed)

### How to Enable

1. Open Haven in your browser via `https://` (e.g., `https://localhost:3000` or `https://your-domain:3000`)
2. Click the **⚙️ Settings** button (bottom of the right sidebar)
3. Scroll to **Push Notifications** and flip the toggle **on**
4. Your browser will ask for notification permission — click **Allow**
5. The status should change to **Enabled**

### Setting Up on Your Devices

**Desktop (Windows / macOS / Linux):**
- Works in Chrome, Edge, and Firefox out of the box
- Make sure you access Haven via `https://` (not `http://`)
- If you see "Service worker failed" or "Requires HTTPS", you're on an insecure connection

**Mobile (Android):**
- Open Haven in **Chrome** or **Edge** via `https://`
- Enable push in Settings (same steps as above)
- Notifications appear even when Chrome is closed

**Mobile (iOS / iPadOS):**
- Requires **Safari 16.4+** (iOS 16.4 or later)
- First, **Add to Home Screen**: tap Share → "Add to Home Screen"
- Open Haven from the home screen icon (it runs as a web app)
- Enable push in Settings — Safari will ask for permission

### Troubleshooting Push

| Problem | Solution |
|---------|----------|
| "Service worker failed" | You're not on HTTPS. Use `https://localhost:3000` or set up SSL certs (see Troubleshooting below) |
| "Requires HTTPS" | Access Haven via `https://` instead of `http://` |
| "Permission denied" | You blocked notifications. Reset in browser settings: Settings → Site Settings → Notifications → find Haven → Allow |
| Toggle is grayed out | Your browser doesn't support push, or you're in incognito/private mode |
| Notifications not appearing | Check your OS notification settings — Haven notifications may be muted at the system level |
| Only works on localhost | For LAN/remote access, you need valid SSL. Haven auto-generates self-signed certs if OpenSSL is installed |

---

## ⚙️ Configuration

All settings are in the `.env` file in your **data directory**:

| OS | Data Directory |
|----|---------------|
| Windows | `%APPDATA%\Haven\` |
| Linux / macOS | `~/.haven/` |

| Setting | What it does |
|---------|-------------|
| `PORT` | Server port (default: 3000) |
| `ADMIN_USERNAME` | Which username gets admin powers |
| `JWT_SECRET` | Auto-generated security key — don't share this |
| `HAVEN_DATA_DIR` | Override where data is stored |

> `.env` is created automatically on first launch. If you change it, restart the server.

---

## 💡 Tips

- **Bookmark the URL** — so you don't have to type the IP every time
- **Keep the bat window open** — closing it stops the server
- **Your data is stored separately** — all messages, config, and uploads are in your data directory (`%APPDATA%\Haven` on Windows, `~/.haven` on Linux/macOS), not in the Haven code folder
- **Back up your data directory** — copy it somewhere safe to preserve your chat history
- **Channel codes are secrets** — treat them like passwords. Anyone with the code can join.

---

## 🔐 End-to-End Encryption (E2E)

All direct messages in Haven are **end-to-end encrypted**. The server never has access to the plaintext of your DMs or the keys needed to decrypt them.

### How It Works

- When you first log in, your browser generates an **ECDH P-256 key pair**.
- The private key is encrypted (wrapped) with a key **derived from your password** using PBKDF2, and the encrypted blob is stored on the server for cross-device sync.
- The server **never sees** your password-derived wrapping key — it's computed in your browser and never transmitted.
- When you message someone, both users' public keys are combined via ECDH + HKDF to produce a shared AES-256-GCM encryption key. Messages are encrypted before leaving your browser.

### When Keys Are Preserved (Old Messages Readable)

| Scenario | Why it works |
|---|---|
| Close the tab and reopen it | IndexedDB still has your keys — no password needed |
| Refresh the page | Same — IndexedDB survives refreshes |
| JWT auto-login (return visit) | IndexedDB has the keys cached |
| Log in on a new device/browser | You type your password → wrapping key is derived → server backup is downloaded and unwrapped |
| Clear cookies (but NOT site data) | IndexedDB is site data, not cookies — keys survive |
| Change your password | Private key is re-wrapped with the new password and re-uploaded — the ECDH key pair itself doesn't change |

### When Keys Are Lost (Old Messages Permanently Unreadable)

| Scenario | Why keys are lost |
|---|---|
| Clear all browser/site data when that's your only device | IndexedDB is wiped — on re-login the server backup may still unwrap if password hasn't changed |
| Clear browser data **after** changing your password | Server backup was wrapped with the old password — new password can't unwrap it → new keys generated |
| Manually reset encryption keys (🔄 button in DM header) | Intentional wipe — new key pair, old messages unreadable |
| Admin deletes your account or resets the database | Server backup gone — if IndexedDB is also empty, fresh keys are generated |

**Short version:** Same password + at least one of (IndexedDB **or** server backup) = keys survive. Lost both = old messages gone forever.

### Can Anyone Intercept Messages?

| Attack vector | Can they read messages? | Why |
|---|---|---|
| Server admin reading the database | **No** | Encrypted private key is wrapped with a key derived from YOUR password — admin has the blob but not the key |
| Someone with physical server access | **No** | Same reason — the blob is useless without your password |
| Man-in-the-middle on the network | **No** | Messages are encrypted client-side before transmission |
| Stolen JWT token | **No** | JWT authenticates you, but E2E keys live in your browser's IndexedDB — attacker can't unwrap the server backup without your password |
| Someone who knows your password + has your JWT | **Yes** | Equivalent to using your login — they can derive the wrapping key and decrypt everything |
| Modified server JavaScript | **Yes** | If the admin pushes tampered JS that exfiltrates keys, all bets are off — this is true of every web-based E2E system |

### Resetting Encryption Keys

In any DM conversation, click the **🔄** button in the channel header to reset your encryption keys. This:
- Generates a brand new key pair
- Makes **all** previous encrypted messages **permanently unreadable** for both parties
- Posts a timestamped notice in the chat so both users know when/why old messages became unreadable
- Requires you to type **RESET** to confirm (there is no undo)

### Verifying Encryption

Click the **🔐** button in the DM header to view your **safety number** — a 60-digit code derived from both users' public keys. Compare it with your conversation partner through a separate channel (phone, in person, etc.). If they match, no one is intercepting your conversation.

---

## 🆘 Troubleshooting

**"SSL_ERROR_RX_RECORD_TOO_LONG" or "ERR_SSL_PROTOCOL_ERROR" in browser**
→ Your browser is trying to connect via `https://` but the server is actually running in HTTP mode. This happens when SSL certificates weren't generated (usually because OpenSSL isn't installed).
**Quick fix:** Change the URL in your browser from `https://localhost:3000` to `http://localhost:3000`.
**Permanent fix:** Install OpenSSL so Haven can generate certificates:
1. Download from [slproweb.com/products/Win32OpenSSL.html](https://slproweb.com/products/Win32OpenSSL.html) (the "Light" version is fine)
2. During install, choose **"Copy OpenSSL DLLs to the Windows system directory"**
3. **Restart your PC** (so OpenSSL is added to PATH)
4. Delete the `certs` folder in your data directory (`%APPDATA%\Haven\certs`)
5. Re-launch `Start Haven.bat` — it will regenerate certificates and start in HTTPS mode

**How to tell if you're running HTTP or HTTPS:**
Check the server's startup banner in the terminal. If it says `http://localhost:3000` — you're on HTTP. If it says `https://localhost:3000` — you're on HTTPS. The protocol in the URL you use must match.

**"Node.js is not installed"**
→ Download and install from [nodejs.org](https://nodejs.org/). Restart your PC after installing.

**Server starts but browser shows blank page**
→ Try clearing your browser cache, or open in an incognito/private window.

**Friends can connect locally but not remotely**
→ Port forwarding isn't configured correctly. Double-check the port, protocol, and internal IP.

**"Error: EADDRINUSE"**
→ Another program is using port 3000. Close it, or change the port in `.env`.

**Voice chat echoes**
→ Use headphones to prevent your speakers from feeding into your microphone.

---

<p align="center">
  <b>⬡ Haven</b> — Your server. Your rules.
</p>
