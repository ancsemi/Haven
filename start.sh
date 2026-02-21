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

# ── Generate SSL certs in data directory if missing (skip if FORCE_HTTP=true) ──
if [ "${FORCE_HTTP:-false}" = "true" ]; then
    echo "  [*] FORCE_HTTP=true — skipping SSL certificate generation"
elif [ ! -f "$HAVEN_DATA/certs/cert.pem" ]; then
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
