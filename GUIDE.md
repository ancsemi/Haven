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

## 📥 Importing from Discord

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

## 🔑 Join Code Settings (Admin)

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

If your friends are **not** on your local WiFi, you need a way for them to reach
your machine. There are three routes here, least safe first:

1. **Port forwarding** (this section): simplest, but it puts your Haven login page
   in front of the whole internet.
2. **[Tailscale / WireGuard](#-tailscale--wireguard-no-port-forwarding-no-exposed-ip)**:
   the safest. Nothing is exposed publicly and you never touch your router.
3. **[Cloudflare Tunnel](#-cloudflare-tunnel-no-port-forwarding)**: a public URL
   without opening a port or revealing your home IP.

Haven can also run LocalTunnel or Cloudflared for you from **Settings, Server Admin
Settings, Tunnel** if you would rather not install anything by hand.

### Before you port forward, know what it costs

Opening a port means anybody on the internet can reach your Haven login page. Some
of that is not obvious up front:

- **Bot networks.** Automated scanners sweep the whole internet looking for
  misconfigured services. Within minutes of forwarding a port, your address starts
  getting probed. Almost all of it bounces off Haven and your firewall, but the risk
  is not zero, and it uses a little of your bandwidth around the clock.
- **DHCP drift.** Most home routers hand out addresses dynamically, so the machine
  running Haven can land on a different local IP after a reboot. Your port forward
  then points at whatever device took the old address, which means your friends
  cannot reach Haven and something else on your network is exposed instead. Assign
  the Haven machine a static IP to prevent this, see the DHCP reservation step below.
- **Password guessing.** Haven rate-limits sign-in attempts (20 per 15 minutes per
  IP address) and supports two-factor authentication, so it is not defenceless. But
  a login page on the open internet will be tried, so use a password you have not
  used anywhere else and turn on MFA.

If that is acceptable to you, carry on. If not, use Tailscale or a tunnel instead.

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

## 🔐 Tailscale / WireGuard (No Port Forwarding, No Exposed IP)

Port forwarding above opens your Haven login page to the entire internet.
Tailscale does not: it builds an encrypted tunnel straight between your
machine and your friend's, so nothing is exposed publicly and you never touch
your router or firewall. It is the safest of the three methods here.

> #### Voice chat over a *shared device*
> Text chat, uploads, and everything that flows **through** the Haven server work
> perfectly with the shared-device setup below. **Voice is the exception.** Haven
> voice is peer-to-peer: everyone in a call opens a direct connection to every
> *other* person in the call, not just to the host. Sharing a single device only
> puts the **host** machine on the shared path, so your friends can reach the host
> but not each other, and the return path from the host back to a friend isn't
> guaranteed either. The classic symptom is **one-directional audio**: everyone
> hears the host, but the host can't hear anyone. This isn't a bug in the
> shared-device config, it's that a single shared machine can't provide the full
> mesh of paths a peer-to-peer call needs.
>
> Two ways to get voice working, most recommended first:
> 1. **Add a TURN server** under **Settings, Admin, Voice & Connectivity
>    (STUN/TURN)**. TURN relays all voice media through one reachable point, so the
>    peer-to-peer paths are no longer required and the secure single-device sharing
>    below keeps working exactly as written. You can run your own
>    [coturn](https://github.com/coturn/coturn) or use a hosted TURN provider.
> 2. **Put everyone on the same tailnet** instead of sharing one device. Tailnet
>    members get direct connectivity to one another, so the mesh forms and voice
>    works both ways. This works, but it gives your friends **broader access than
>    device-sharing does**, so read **Step 4** below and only do this if you accept
>    that tradeoff.

- Unlike port forwarding, Tailscale does not require you to touch your router or your computer's firewall. Tailscale uses [Wireguard](https://en.wikipedia.org/wiki/WireGuard) under the hood, which is the same protocol many reputable VPN companies use. Wireguard creates an encrypted, end-to-end tunnel from your computer to your friend's computer. Most firewalls, like the one your router and computer use, allow outbound connections by default. Tailscale establishes a persistent, outbound connection to the Tailscale coordination server, which then allows your friends to connect. This is why configuring your firewall is not a requirement for this method. 
  
- Anyone who wants access to your Haven server will first need a **Share link** generated by you, the administrator, via your Tailscale admin dashboard. If you follow this guide correctly, your friend will **only** have access to Haven and strictly nothing else on your device.
- The obvious tradeoff with this approach is setup. Both you and your friends will need to connect to Tailscale anytime you want to access Haven. But the bright side of this approach is once setup is complete, and you're logged in, connecting to Tailscale is as simple as flipping a switch. Tailscale works on pretty much all devices you can think of, and it's seamless.
- To be clear, Tailscale does change your device's DNS settings. But unlike a traditional VPN, Tailscale **does not** route your internet traffic through some remote server. Tailscale is **purely** a connection between your computer, and your friend's computer. Your IP does not change and your internet speed doesn't slow down in any meaningful way.

### Step 1 - Make an account
- Visit https://tailscale.com and make an account. Tailscale will walk you through downloading Tailscale onto your device, you may proceed with that.

- Once Tailscale is running on your machine, it may ask you to add another device, click the "Skip" button at the bottom of the page.

 
### Step 2: Navigate to Tailscale admin page
Click [here](https://console.tailscale.com/admin/machines) to access the admin page. Here, you will see a list of all the devices on your Tailnet. 

### Step 3: Lock down access
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

### Step 4: Share, not invite
- This step is critical. There is a fundamental difference between inviting someone to your tailnet, and simply sharing one machine. The settings above DO NOT apply if you invite someone to your tailnet, and they will get access to your **whole tailnet**. If your Haven computer is running any other web server, or if you add more Tailscale devices down the road, your friends will have access to them. You do not want this. 
- To **SHARE** a device, go to your Tailscale admin page, click the 3 dot menu next to your device, and click **Share**. If you are sharing a link, make sure **Reusable link** is turned off. This way, each link you use only works once, and you maintain complete control over who can access your shared device.

### Step 5: Sharing the link
- Once you provide a share link to your friend, he will need to make an account on Tailscale, download the client and connect on his machine. Please note, your friend **does not** need to share anything from his end. Only the person hosting Haven will have to share.
- Once your friend accepts the link, his device will now be able to reach your shared device.

### Step 6: Usage
- Once everything is wired up, go to your Tailscale admin page, find your device, and notice the **IP Address** listed next to your device. This is your Tailnet IP address. It is not your actual IP address.
- Accessing Haven is as simple as going to https://TailscaleIPAddress:3000 (or whatever port you configured in ACL settings)
- Please note: If you are the one hosting Haven, you may also access Haven from your LAN IP that Haven is running on (typically 192.168.X.X), but your friends **need** to use your Tailscale IP.

---

## ☁️ Cloudflare Tunnel (No Port Forwarding)

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

## 🔁 Reverse Proxy (Caddy, nginx, Traefik)

If you already have a domain and want Haven to live behind a proper reverse proxy (so you get a real Let's Encrypt cert, no browser warnings, and the same `https://chat.example.com` URL every time), set `FORCE_HTTP=true` and let the proxy terminate TLS for you.

### Quick Recipe (Caddy)

1. **Stop Haven** if it's running.
2. Add the following line to your `.env` file (create one next to `package.json` if it doesn't exist):

   ```env
   FORCE_HTTP=true
   ```

   This tells Haven to skip its built-in self-signed cert generation and listen on plain HTTP on port 3000. Caddy will handle the HTTPS leg.

3. **Install Caddy** ([caddyserver.com/download](https://caddyserver.com/download)) and create a `Caddyfile`:

   ```caddy
   chat.example.com {
       reverse_proxy localhost:3000
   }
   ```

   Replace `chat.example.com` with your real domain. Caddy will auto-fetch a Let's Encrypt cert on first run. Make sure ports **80 and 443** are open / forwarded to the Caddy host.

4. **Start Caddy**, then **start Haven** (`Start Haven.bat` or `npm start`).
5. Open `https://chat.example.com` in a browser. You should see Haven with a clean padlock and no cert warnings.

### Using a Tunnel + Caddy

If you don't want to port-forward 80/443, point a tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok, etc.) at the Caddy host. The flow becomes:

```
Browser → Tunnel (HTTPS) → Caddy (HTTPS) → Haven (HTTP, FORCE_HTTP=true)
```

Caddy still terminates TLS for the LAN leg, and the tunnel terminates a second TLS layer for the public leg. That's the setup minecraft_bread used successfully (see the support thread for the full step-by-step).

### nginx Snippet

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

The `Upgrade` / `Connection` headers are required for Socket.io WebSocket traffic; without them voice chat and live messages will silently break.

### Common Gotchas

| Problem | Fix |
|---------|-----|
| Browser shows Haven's self-signed cert warning instead of the Let's Encrypt one | You forgot `FORCE_HTTP=true`. Haven is still serving its own HTTPS on 3000 and Caddy is just proxying that. Add the line, restart Haven. |
| Voice chat / live updates don't work behind nginx | Add the `Upgrade` and `Connection "upgrade"` headers shown above. Caddy handles WebSockets automatically. |
| Mixed-content errors in browser console | Make sure the proxy forwards `X-Forwarded-Proto $scheme` so Haven knows it's serving over HTTPS. |
| "502 Bad Gateway" from Caddy | Haven isn't running, or it's still bound to HTTPS on 3000. Double-check `FORCE_HTTP=true` is in `.env` and you restarted Haven after adding it. |

> 💡 A full Docker Compose example with Traefik + coturn lives in [`docs/examples/haven-traefik-coturn/`](docs/examples/haven-traefik-coturn/) if you'd rather run the whole stack containerised.

---

## 🔧 Router-Specific Tips

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

### Bundled optional themes and plugins

Haven also ships a couple of extras that are **installed but switched off by default**, so you will not see them until an admin turns them on. They are already on your server, including in the Docker image. There is nothing to download.

| File | What it is |
|------|-----------|
| `themes/braid.theme.css` | Braid, a dark mint theme |
| `themes/braid-light.theme.css` | Braid Light |
| `plugins/BraidLayout.plugin.js` | Braid's layout changes |
| `plugins/MessageTimestamps.plugin.js` | Adds timestamps to messages |

To make a bundled theme available to everyone, go to **Settings → Admin → 🏠 Branding → Custom Themes** and publish it. Publishing is what adds its button to the theme picker in the sidebar. Until then it stays hidden even though the file is present, which is the usual reason a theme "looks missing" after an update.

Custom themes work the same way. Drop a `<name>.theme.css` file into the `themes/` folder, restart, then publish it in the same place. A theme can also be set as the server **default** from that section, which applies to anyone who has not already picked a theme of their own. It is a default rather than a lock, so a user who chooses a different theme keeps their choice.

### Background images (wallpapers)

A theme is ordinary CSS, so it can set a background image and not just colours.
Put the image in `themes/` next to your `.theme.css` file, then point at it with
a plain relative path. Haven serves the whole `themes/` folder, so
`url("wallpaper.jpg")` resolves to `/themes/wallpaper.jpg` on its own.

```css
.main {
  background-image:
    linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)),
    url("wallpaper.jpg");
  background-size: cover;
  background-position: center;
}
```

`.main` is the chat area. The message list, the channel header and the messages
themselves have no background of their own, so the image shows through behind
all of them.

The `linear-gradient` on top is a dark scrim, and it is doing real work: over a
bright or busy photo, message text becomes unreadable without it. Raise `0.55`
towards `1` to dim the image further, lower it to let more through, or delete
that line entirely if your image is already dark. On a light theme, use white
(`rgba(255, 255, 255, 0.6)`) instead.

The sidebar keeps its own colour and is not covered. Add `.sidebar` to the same
rule if you want the image there too, or set it on `body` to cover everything.

Two things worth knowing before you plan around this:

- A theme is a file on the server, so **adding one needs access to the server
  itself**, and publishing it puts it in the theme picker for everyone. There is
  no per-user wallpaper setting. It is personal only in the sense that a theme
  applies to whoever picks it.
- Keep the file reasonably small. Every member downloads it when they select the
  theme, and a 12 MB photo is a 12 MB download.

> **Docker users:** `themes/` and `plugins/` live inside the image, not in the `/data` volume, so pulling a newer image is all you need to get new bundled files. Remember to recreate the container afterwards (`docker compose up -d`), since pulling alone leaves the old container running the old image. If you bind-mount over `/app`, your host folder wins and you will need to add the files there yourself.

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

# Only if coturn is behind a router (home server, NAT'd VM, Docker bridge).
# Leave this out when the machine holds its public IP directly.
external-ip=YOUR_PUBLIC_IP
```

Then add to your Haven `.env`:

```env
TURN_URL=turn:your-server.com:3478
TURN_SECRET=YOUR_RANDOM_SECRET_HERE
```

Restart Haven, and voice/screen sharing will work across any network.

> **You can set this in the app instead:** **Settings → Admin → 📡 Voice & Connectivity** configures the same STUN and TURN servers without touching `.env`, and it applies without restarting.

> **Which one wins:** a TURN server set in Settings takes precedence, and the `TURN_*` environment variables are ignored while it's filled in. The env vars only apply when the in-app TURN field is empty. If you set `TURN_URL` in `.env` and nothing seems to change, open Settings and clear the field there. `TURN_SECRET` (time-limited HMAC credentials) is environment-only, and is skipped entirely once a TURN server is configured in the app.

> **Docker users:** Add `TURN_URL` and `TURN_SECRET` as environment variables in your `docker-compose.yml`. See the commented example in the default compose file.

> **Oracle Cloud / cloud VMs:** Make sure ports 3478 (UDP+TCP) and 49152–65535 (UDP) are open in your security group / firewall rules. These are needed for TURN relay traffic.

> **Home server behind a router:** this is where TURN most often looks configured but silently does nothing, because coturn has no idea it is behind NAT and hands out its LAN address as the relay. Three things to get right:
>
> - Set `external-ip=YOUR_PUBLIC_IP` in `turnserver.conf`. Without it every relay candidate points at a private address that nobody outside your network can reach. It wants a literal IP, not a hostname, so if yours is dynamic you have to update the line and restart coturn when it changes.
> - Forward **UDP**, not just TCP. TURN media is UDP: port 3478 plus the whole `min-port` to `max-port` range. A TCP-only forward lets coturn start up, answer, and relay nothing.
> - Turn on NAT reflection (also called hairpin NAT) on your router, or people on your own LAN cannot reach `turn:your-domain.com`, because that name resolves to your public IP. pfSense and OPNsense call it NAT Reflection. Some routers do not support it at all, in which case split DNS pointing the name at the LAN address is the way round it.
>
> To check the relay by itself, put your TURN URL and credentials into the WebRTC project's Trickle ICE page (https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/). If it never produces a candidate of type `relay`, the problem is coturn or the firewall in front of it, not Haven.

> **coturn is not the only option.** [eturnal](https://eturnal.net/) does the same job and several people running Haven at home have found it easier to get working. The setting that matters is the same one under a different name: `relay_ipv4_addr` in `eturnal.yml` is coturn's `external-ip`, and its autodetection does not reliably find your public address behind NAT, so set it explicitly there too. Everything else on this page (UDP forwarding, the relay port range, NAT reflection) applies unchanged, and Haven does not care which one you point `TURN_URL` at.

---

## 🎮 Rich Presence (What You're Playing & Listening To)

Haven can show your current game or track next to your name in the member list,
and on your profile card. Games take priority in the member list so the sidebar
stays readable; your profile card shows both if you're doing both.

**This is off until you turn it on.** Nothing is shared until you link an
account.

### Linking your accounts

1. Click **⚙️ Settings** → **Connections**
2. Pick a source and follow the prompt:

| Source | What you do | What it covers |
|--------|-------------|----------------|
| **Haven's music player** | Nothing, it just works | Anything playing in a Haven voice channel |
| **Last.fm** ⭐ | Enter your username | Spotify, Apple Music, YouTube Music, Navidrome, Plex |
| **Steam** | Click Link and sign in | Games |
| **Spotify** | Click Link and sign in | Spotify only |

**Last.fm is the one to pick for music.** It's just a username, there's no
sign-in redirect and nothing gets stored, and because most music apps scrobble
to Last.fm, that single connection covers whatever you actually listen with.

> Scrobbling has to be turned on in Last.fm's own settings first. Haven's setup
> panel walks you through it for each app.

### Controlling what people see

- **Master switch** — turn presence off entirely
- **Per-category** — show games but not music, or the other way round
- **Invisible** — while your status is Invisible, nothing is shared, regardless
  of the settings above

None of it is written to the database. Presence lives in memory and disappears
when the server restarts.

### If nothing is showing up

- Give it a minute. Haven checks for updates on a timer rather than instantly.
- For music, confirm the track actually appears on your Last.fm profile. If it
  isn't scrobbling there, Haven has nothing to read.
- For Steam, your Steam profile's game details must be set to **Public**.
  Steam's API returns nothing for private profiles.
- Check that your status isn't set to Invisible.

**Admins:** each provider needs a free API key before anyone can link to it.
Settings → Connections has a **Set up** button per provider with a link to where
that key comes from, and keys are saved without a restart. To swap a key later,
use **Change key** on that row.

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

Haven creates a `.env` config file automatically on first launch. You do not need
to create or rename anything. It lives in your **data directory**:

| OS | Data Directory |
|----|---------------|
| Windows | `%APPDATA%\Haven\` |
| Linux / macOS | `~/.haven/` |

| Setting | Default | What it does |
|---------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SERVER_NAME` | `Haven` | Your server's display name |
| `ADMIN_USERNAME` | `admin` | Register with this name to get admin powers |
| `JWT_SECRET` | *(auto-generated)* | Security key. Do not share or edit this |
| `HAVEN_DATA_DIR` | *(see above)* | Override the data directory location |
| `HAVEN_DISK_RESERVE_MB` | `512` | Disk space Haven keeps free so a full server stays fixable |
| `SSL_CERT_PATH` | *(auto-detected)* | Path to SSL certificate. With Let's Encrypt, point at `fullchain.pem` rather than `cert.pem`: `cert.pem` leaves out the intermediate certificate, which browsers quietly work around but curl and many other clients reject |
| `SSL_KEY_PATH` | *(auto-detected)* | Path to SSL private key |
| `STEAM_API_KEY` | *(empty)* | Steam Web API key for rich presence. Get yours at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) (any domain works) |
| `OIDC_CLIENT_SECRET` | *(empty)* | Client secret for single sign-on. Kept out of the database on purpose, so backups never carry it |
| `PUBLIC_URL` | *(auto-detected)* | Your server's public address, including `https://`. Only needed if Haven cannot work it out itself, see below |
| `HAVEN_ALLOW_PRIVATE_CALLBACKS` | `false` | Let bot callback URLs point at private addresses (`10.x`, `192.168.x`, `localhost`, `.local`). Off by default so a webhook cannot be pointed at your internal network. Turn it on only if your bot really does run on the same LAN or in a sibling Docker container. Cloud metadata addresses (`169.254.x.x`) stay blocked regardless |

After editing `.env`, restart the server.

> **Running Haven as a systemd service?** systemd runs the unit as the user you set
> in `User=` (often `root`), so `~/.haven/` resolves to that user's home (e.g.
> `/root/.haven/`), *not* the directory you ran Haven from manually during testing.
> Set `HAVEN_DATA_DIR` to an absolute path in your `.env` or the unit's
> `Environment=` line so manual and service runs share the same data, certs, and
> `.env`. Example:
> ```
> Environment=HAVEN_DATA_DIR=/opt/haven-data
> ```

> **Steam or Spotify linking sending people to the wrong address?** If you run Haven
> behind Docker port mapping (say `8080:3000`), a reverse proxy that strips the port
> out of the Host header, or a Cloudflare Tunnel, the server cannot reliably guess
> its own public address, so those sign-in round-trips fail. Set it explicitly:
> ```
> PUBLIC_URL=https://haven.example.com:8443
> ```
> For security this one is `.env`-only and deliberately **not** editable from the
> admin panel. A callback address that could be changed from the web UI would be a
> way to hijack sign-in redirects.

### Running More Than One Server

You can run several Haven instances on the same machine. Each one needs its own
copy of Haven, its own port, and its own data directory so the databases do not
conflict.

1. Copy the Haven folder to a separate directory for each server.
2. In each copy, set a unique `PORT` in `.env` (e.g. `3000`, `3001`).
3. Set a unique `HAVEN_DATA_DIR` in each `.env` (e.g. `HAVEN_DATA_DIR=C:\HavenData\server1`).
4. Start each one independently with `Start Haven.bat` (or `start.sh`).

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

## 🛶 Ferry (Discord Bridge)

Ferry relays messages between your Haven channels and Discord channels. Haven users
appear on Discord under their own names, and Discord messages show up in Haven.

**Every Haven server needs its own Discord bot.** Haven cannot ship a shared one:
Discord caps unverified applications at 100 servers and verification requires a company
review. Setting one up takes a couple of minutes and is free.

### 1. Create the Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**
2. Open the **Bot** tab
3. Turn on **Message Content Intent**. Without it Discord sends every message with an
   empty body, so nothing reaches Haven
4. If you want the Discord DM feature, also turn on **Server Members Intent**
5. Click **Reset Token**, then copy the token. Treat it like a password

### 2. Connect it to Haven

1. In Haven, go to **Settings → Server Admin Settings → Ferry**
2. Click **Set up Ferry** and paste the token
3. Haven checks the token with Discord and then shows an invite link
4. Open the invite link and add the bot to your Discord server. Keep the
   **Manage Webhooks** permission checked: it is what lets relayed messages carry the
   Haven author's name and picture instead of all arriving as one anonymous bot
5. Back in Haven, turn on the **Ferry is on** switch

### 3. Pair some channels

A pairing joins one Haven channel to one Discord channel. Each pairing has two settings:

| Setting | Options |
|---|---|
| **Direction** | Two-way, Haven → Discord only, or Discord → Haven only |
| **Outgoing** | **On command** (only messages addressed with `=>`) or **Mirror everything** (every message in the channel) |

Pairings are also the boundary: members can only send to Discord channels paired with
the Haven channel they are in. They cannot reach other servers the bot happens to
belong to.

### 4. Grant the permission

Sending to Discord needs the **Send to Discord (Ferry)** role permission
(`use_ferry`), granted under **Settings → Roles**. Admins always have it. Without it a
member's messages stay in Haven even in a mirrored channel.

### Sending a message

In a **mirrored** channel, just talk. Everything crosses.

In an **on command** channel, start the message with `=>` and pick a destination from
the autocomplete:

```
=>My Server#general hey everyone
```

The `=>` prefix is stripped before the message is stored, and a small badge on the
message shows where it went. If the destination does not match a pairing, the prefix
stays visible so you can see it did not send.

To DM a Discord user (when the admin has enabled it), type `=>@` and search by name:

```
=>@Alice quick question
```

### Things worth knowing

- **DMs are one way.** A bot cannot impersonate in a DM, so the message arrives from the
  bot with your Haven name in the body. Replies stay in Discord and do not come back to
  Haven. Discord also flags bots that DM a lot of people, so use it sparingly
- **Pings are off by default.** Relayed messages do not ping anyone on Discord unless an
  admin turns on **Allow pings**. Even then `@everyone` and role pings stay blocked
- **Set `PUBLIC_URL`** in your `.env` if you want Haven avatars and uploaded images to
  appear on the Discord side. Discord has to be able to reach them over the internet.
  Without it names still come through, just without pictures
- **Discord attachments arrive as links**, and Discord's own links expire after about a
  day. The text of the message is permanent, the pictures are not
- **Other Discord bots are ignored** unless an admin turns on **Relay other bots**,
  which can flood a channel
- **Personas are off by default.** With them off, a relayed message always carries the
  sender's real Haven name so a Discord server cannot be addressed by an untraceable alias

### If it stops working

The Ferry panel shows the connection state and the last error on each pairing.

| Message | Fix |
|---|---|
| Discord refused the Message Content intent | Turn it on in the Developer Portal, Bot tab |
| Discord rejected the bot token | Reset the token in the portal and paste the new one |
| The bot needs "Manage Webhooks" | Give the bot that permission in the Discord channel |
| Discord refused the Server Members intent | Turn it on in the portal, or leave DMs off |

---

## ⌨️ Slash Commands & Shortcuts

Type `/` in the message box to see the full list with descriptions. A selection:

| Command | What it does |
|---------|-------------|
| `/gif <query>` | Search and send a GIF inline |
| `/play <name or url>` | Search and play music in the voice channel |
| `/poll [question]` | Open the poll creator |
| `/roll 2d20` | Roll dice (any NdN format) |
| `/flip` | Flip a coin |
| `/me does something` | Italic action text |
| `/spoiler secret text` | Hidden spoiler text |
| `/tts hello` | Text-to-speech (`/tts:stop` to stop playback) |
| `/nick NewName` | Change your username |
| `/hug @user` | Send someone a hug |
| `/shrug` `/tableflip` `/unflip` `/lenny` `/disapprove` | Text faces |
| `/afk` `/brb` `/bbs` | Away announcements |
| `/clear` | Clear your own chat view |

Bots can register their own slash commands too, see the developer guide below.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Shift+Enter` | New line |
| `Ctrl+F` | Search messages |
| `@` | Mention autocomplete |
| `:` | Emoji autocomplete (type 2+ characters) |
| `/` | Slash command autocomplete |
| `::` | Persona autocomplete (send as one of your personas) |
| `Tab` | Accept the highlighted suggestion |

---

## 🛡️ Admin & Moderation

Admin controls live in **Settings** (the gear icon in the sidebar). If you
registered with the admin username you have all of them; everything below can also
be handed to others through the role system, one permission at a time.

- **Members**: kick, timed mute, ban, unban, delete an account to free the username
- **Roles**: granular per-channel permissions, including a server-wide "see every
  channel" permission that only the owner can grant
- **Automod**: checks links in messages, edits, DMs, profiles and channel topics
  against a domain policy you control, and rejects them before they are saved. This
  matters more than it sounds: Haven renders linked images and previews from the
  other site, so a hostile link exposes the IP of everyone who scrolls past it
- **Audit log**: a record of channel changes, role updates, bans, kicks and server
  setting changes, with who did what
- **Guests**: an optional "Join as Guest" button on the login page. Guests pick a
  username, get a temporary account with no password, see only the channels you
  whitelist, cannot DM, and are deleted when they disconnect
- **Uploads & limits**: max upload size (25 MB by default, raise it as far as your
  disk allows), max message length, per-member storage usage
- **Auto-cleanup**: automatic deletion of messages past a chosen age
- **Server updates**: check for a new Haven release and apply it in place. Haven
  takes a pre-update backup and restarts itself

---

## 💾 Backing Up Your Data

All your data lives in a dedicated directory **outside** the Haven code folder:

| OS | Location |
|----|----------|
| Windows | `%APPDATA%\Haven\` |
| Linux / macOS | `~/.haven/` |

Inside you will find `haven.db` (messages, users, channels), `.env`, `certs/`, and
`uploads/`. Copying that whole folder somewhere safe backs up everything. The Haven
code directory holds no personal data.

### Built-in backups

You do not have to copy files by hand. **Settings → Server Admin Settings → Backup**
has:

- **One-click export**: download an archive, with checkboxes for what to include
  (channels and roles, users, server settings, messages, uploaded files, and
  optionally DMs)
- **Scheduled auto-backups**: on a daily or weekly schedule
- **Restore**: upload a backup to restore a server. The previous database and
  uploads are kept as `.pre-restore` copies for one cycle as a safety net

Backups stream to and from disk rather than being held in memory, so a large
uploads folder will not run the server out of RAM.

---

## 🎞️ GIF Search Setup

Haven's GIF picker needs a free API key from a provider. **Tenor** is the default
and the one to use: GIPHY stopped issuing keys to new servers, so the GIPHY option
is only useful if you already have one from before.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create or
   pick a project
2. Enable the **Tenor API**, then open **Credentials → Create credentials → API key**
3. Copy the key
4. In Haven, as an admin, click the GIF button (🎞️) in the message box and paste the
   key into the setup prompt

The key is stored server-side, so only admins can see or change it, and every user
can search GIFs once it is set. No payment is involved; the free tier is far more
than a private server will use.

---

## 🌐 Translations

Haven ships in 8 languages: English, French, German, Spanish, Polish, Russian,
Chinese and Brazilian Portuguese. Users pick one in **Settings → Language** or on
the login page, and the choice is saved per browser.

English is the reference. Polish, Russian and Brazilian Portuguese have been
reviewed by native speakers; the rest started as machine translations and still
need a pass, so corrections are genuinely welcome.

**Improving a language:** edit `public/locales/{code}.json` and open a PR.

**Adding one:**

1. Copy `public/locales/en.json` to `public/locales/{code}.json`
2. Translate the values, leaving the keys unchanged
3. Fill in the `_meta` block with the language name and flag
4. Add the code to the `SUPPORTED` array in `public/js/i18n.js`
5. Add an `<option>` to the language selectors in `public/index.html` and
   `public/app.html`

Missing keys fall back to English per phrase, so a partial translation never breaks
anything. If you would like to own a language and keep it current, say so in an
issue.

---

## 🤖 Bot & Webhook Developer Guide

Haven has a built-in bot API powered by webhooks. Bots can send messages, delete messages, play soundboard sounds, and register custom slash commands.

> **Looking for ready-made bots and webhooks?** The community library at [**ancsemi/haven-community**](https://github.com/ancsemi/haven-community) collects user-contributed integrations you can deploy as-is — a GitHub releases poster, etc. PRs welcome there if you've built one of your own. See its [`CONTRIBUTING.md`](https://github.com/ancsemi/haven-community/blob/main/CONTRIBUTING.md) for how to submit.

### Creating a Bot

1. Go to **Settings → Server Admin Settings → Bots** (or open a channel's settings and look for the webhook/bot option)
2. Create a new webhook — give it a name, optionally set an avatar URL and a callback URL
3. Copy the **Webhook Token** (64-character hex string) — this is your bot's API key

### Sending Messages

```
POST https://your-server.com/api/webhooks/<token>
Content-Type: application/json

{
  "content": "Hello from my bot!",
  "username": "MyBot",
  "avatar_url": "https://example.com/avatar.png"
}
```

- `content` (required) — message text, max 4000 characters
- `username` (optional) — override the bot's display name for this message
- `avatar_url` (optional) — override the bot's avatar for this message
- `ephemeral` (optional) — when `true`, deliver only to `recipient_id` and do not store in history
- `recipient_id` (required when `ephemeral` is `true`) — user id that should receive the private bot message

Ephemeral example:

```
POST https://your-server.com/api/webhooks/<token>
Content-Type: application/json

{
  "content": "Your dashboard token: abc123",
  "ephemeral": true,
  "recipient_id": 42
}
```

Response (regular): `{ "success": true, "message_id": 123 }`

Response (ephemeral): `{ "success": true, "ephemeral": true, "recipient_id": 42, "delivered": true }`

### Deleting Messages

```
DELETE https://your-server.com/api/webhooks/<token>/messages/<message_id>
```

Bots can delete any message in their assigned channel. Returns `{ "success": true }`.

Bots with moderation permission can delete up to 100 of the most recent messages
from their assigned channel in one request. Thread replies are removed with their
parent messages.

```
DELETE https://your-server.com/api/webhooks/<token>/messages?limit=25
```

Returns `{ "success": true, "deleted": 25 }`. The `deleted` count includes
thread replies removed with the selected messages.

### Playing Soundboard Sounds

```
POST https://your-server.com/api/webhooks/<token>/sounds
Content-Type: application/json

{
  "sound": "AOL - You've Got Mail"
}
```

Plays the named sound for all users currently viewing the bot's channel. Use `GET /api/sounds` (with a Bearer token) to list available sound names.

### Registering Slash Commands

Bots with a `callback_url` can register custom slash commands that users can invoke from chat:

**Register:**
```
POST https://your-server.com/api/webhooks/<token>/commands
Content-Type: application/json

{
  "command": "leaderboard",
  "description": "Show the current leaderboard"
}
```

Optional subcommands can be included to improve autocomplete discoverability:

```
POST https://your-server.com/api/webhooks/<token>/commands
Content-Type: application/json

{
  "command": "rss",
  "description": "Manage RSS feeds",
  "subcommands": [
    { "name": "add", "description": "Add an RSS feed" },
    { "name": "remove", "description": "Remove an RSS feed" },
    { "name": "list", "description": "List active feeds" }
  ]
}
```

The callback payload format is unchanged. Haven still sends `command` as the
base command (`rss`) and the full remaining text in `args` (for example
`"add https://example.com/feed.xml"`).

**List:**
```
GET https://your-server.com/api/webhooks/<token>/commands
```

**Unregister:**
```
DELETE https://your-server.com/api/webhooks/<token>/commands/leaderboard
```

When a user types `/leaderboard`, Haven sends a POST to your bot's callback URL with the command details, signed with HMAC so you can verify authenticity.

### Rate Limits

All webhook endpoints are rate-limited to **30 requests per minute** per IP.

### Callback Payloads

If your webhook has a `callback_url` and `callback_secret` configured, Haven will POST command invocations to your URL. The payload includes an HMAC signature in the `X-Haven-Signature` header that you should verify using your callback secret.

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
