#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Haven — Cross-Platform Launcher (Linux / macOS)
# Usage: chmod +x start.sh && ./start.sh
# ═══════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── Data directory (~/.haven) ──────────────────────────────
HAVEN_DATA="${HAVEN_DATA_DIR:-$HOME/.haven}"
mkdir -p "$HAVEN_DATA"

echo ""
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo -e "${GREEN}${BOLD}       HAVEN — Private Chat Server${NC}"
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo ""

# ── Check Node.js ──────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo -e "${RED}  [ERROR] Node.js is not installed.${NC}"
    echo "  Install it from https://nodejs.org or:"
    echo "    Ubuntu/Debian:  sudo apt install nodejs npm"
    echo "    macOS (brew):   brew install node"
    echo "    Fedora:         sudo dnf install nodejs"
    echo "    Arch:           sudo pacman -S nodejs npm"
    exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
echo "  [✓] Node.js $(node -v) detected"

if [ "$NODE_VER" -lt 18 ]; then
    echo -e "${YELLOW}  [!] Node.js 18+ recommended. You have v${NODE_VER}.${NC}"
fi

# ── Install dependencies ───────────────────────────────────
if [ ! -d "node_modules" ]; then
    echo "  [*] First run — installing dependencies..."
    npm install
    echo ""
fi

# ── Create .env in data directory if missing ───────────────
if [ ! -f "$HAVEN_DATA/.env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example "$HAVEN_DATA/.env"
        echo -e "${YELLOW}  [!] Created .env in $HAVEN_DATA — edit it before going live!${NC}"
    else
        echo -e "${YELLOW}  [!] No .env file found. Server will use defaults.${NC}"
    fi
fi

# ── Generate SSL certs in data directory if missing ────────
if [ ! -f "$HAVEN_DATA/certs/cert.pem" ]; then
    echo "  [*] Generating self-signed SSL certificate..."
    mkdir -p "$HAVEN_DATA/certs"

    # Detect local IP (Linux vs macOS)
    if command -v hostname &> /dev/null && hostname -I &> /dev/null; then
        LOCAL_IP=$(hostname -I | awk '{print $1}')
    elif command -v ipconfig &> /dev/null; then
        LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
    else
        LOCAL_IP="127.0.0.1"
    fi

    openssl req -x509 -newkey rsa:2048 \
        -keyout "$HAVEN_DATA/certs/key.pem" -out "$HAVEN_DATA/certs/cert.pem" \
        -days 3650 -nodes -subj "/CN=Haven" \
        -addext "subjectAltName=IP:127.0.0.1,IP:${LOCAL_IP},DNS:localhost" \
        2>/dev/null

    echo "  [✓] SSL cert generated (covers ${LOCAL_IP})"
    echo ""
fi

# ── Kill existing server on port 3000 ──────────────────────
if command -v lsof &> /dev/null && lsof -ti:3000 &> /dev/null; then
    echo "  [!] Killing existing process on port 3000..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

echo "  [*] Data directory: $HAVEN_DATA"

# ── First-run tunnel setup ─────────────────────────────────
if [ ! -f "$HAVEN_DATA/.tunnel_configured" ]; then
    echo ""
    echo -e "${GREEN}${BOLD}  ========================================${NC}"
    echo -e "${GREEN}${BOLD}   How should friends connect to you?${NC}"
    echo -e "${GREEN}${BOLD}  ========================================${NC}"
    echo ""
    echo "    1) Cloudflare Tunnel  (recommended, free, auto-downloads)"
    echo "    2) LocalTunnel        (free, npm-based)"
    echo "    3) Port-Forward       (manual router config, see instructions)"
    echo "    4) Local Only         (same WiFi / network only)"
    echo ""
    read -rp "  Choose [1-4]: " TUNNEL_CHOICE

    case "$TUNNEL_CHOICE" in
        1)
            echo "  [*] Setting up Cloudflare tunnel..."
            node -e "const db=require('./src/database');db.prepare(\"INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled','true')\").run();db.prepare(\"INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_provider','cloudflared')\").run();"
            echo -e "${GREEN}  [✓] Cloudflare tunnel will start with the server.${NC}"
            ;;
        2)
            echo "  [*] Setting up LocalTunnel..."
            npm install localtunnel --save 2>/dev/null
            node -e "const db=require('./src/database');db.prepare(\"INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled','true')\").run();db.prepare(\"INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_provider','localtunnel')\").run();"
            echo -e "${GREEN}  [✓] LocalTunnel will start with the server.${NC}"
            ;;
        3)
            echo ""
            echo -e "${BOLD}  ========================================${NC}"
            echo -e "${BOLD}    Port-Forwarding Instructions${NC}"
            echo -e "${BOLD}  ========================================${NC}"
            echo ""
            echo "    1. Open your router admin page"
            echo "       (usually http://192.168.1.1 or http://192.168.0.1)"
            echo "    2. Find 'Port Forwarding' or 'NAT' settings"
            echo "    3. Add a new rule:"
            echo "       - External port: 3000"
            echo "       - Internal port: 3000"
            echo "       - Internal IP:   YOUR PC's local IP"
            echo "       - Protocol:      TCP"
            echo "    4. Save and apply"
            echo "    5. Share your public IP with friends:"
            echo "       https://YOUR_PUBLIC_IP:3000"
            echo ""
            echo "    Tip: Search 'port forwarding [your router brand]'"
            echo ""
            node -e "const db=require('./src/database');db.prepare(\"INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled','false')\").run();"
            ;;
        *)
            echo -e "${GREEN}  [✓] Local-only mode. Connect via your local network.${NC}"
            node -e "const db=require('./src/database');db.prepare(\"INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled','false')\").run();"
            ;;
    esac
    echo "configured" > "$HAVEN_DATA/.tunnel_configured"
    echo ""
fi

echo "  [*] Starting Haven server..."
echo ""

# ── Start server ───────────────────────────────────────────
node server.js &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 15); do
    sleep 1
    if curl -sk "https://localhost:${PORT:-3000}/api/health" &> /dev/null || \
       curl -sk "http://localhost:${PORT:-3000}/api/health" &> /dev/null; then
        break
    fi
    if [ $i -eq 15 ]; then
        echo -e "${RED}  [ERROR] Server failed to start after 15 seconds.${NC}"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
done

PORT=${PORT:-3000}

echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo -e "${GREEN}${BOLD}    Haven is LIVE on port ${PORT}${NC}"
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo ""
echo "  Local:   https://localhost:${PORT}"
echo "  LAN:     https://YOUR_LOCAL_IP:${PORT}"
echo "  Remote:  https://YOUR_PUBLIC_IP:${PORT}"
echo ""
echo "  First time? Browser will show a certificate warning."
echo "  Click 'Advanced' → 'Proceed' (self-signed cert)."
echo ""

# ── Open browser (platform-specific) ──────────────────────
if command -v xdg-open &> /dev/null; then
    xdg-open "https://localhost:${PORT}" 2>/dev/null &
elif command -v open &> /dev/null; then
    open "https://localhost:${PORT}" 2>/dev/null &
fi

echo "  Press Ctrl+C to stop the server."
echo ""

# Keep alive — clean shutdown on Ctrl+C
trap "echo ''; echo '  Shutting down Haven...'; kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
