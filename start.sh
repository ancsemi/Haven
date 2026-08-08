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

if [ "$NODE_VER" -ge 25 ]; then
    echo -e "${YELLOW}  [!] Node.js v${NODE_VER} is newer than Haven has been tested with.${NC}"
    echo "  Continuing — native modules are verified functionally below."
elif [ "$NODE_VER" -ge 24 ]; then
    echo "  [*] Node.js v${NODE_VER} — verifying native modules load (below)."
fi

# ── Install dependencies ───────────────────────────────────
if [ ! -d "node_modules" ]; then
    echo "  [*] First run — installing dependencies..."
    npm install
    echo ""
fi

# ── Functional gate: the version number matters less than whether the
#    native module actually loads on THIS node. Same check the Windows
#    launcher uses. A load failure gets one rebuild attempt first.
if ! node -e "require('better-sqlite3')" &> /dev/null; then
    echo -e "${YELLOW}  [!] better-sqlite3 failed to load on Node $(node -v) — rebuilding...${NC}"
    npm rebuild better-sqlite3 || true
    if ! node -e "require('better-sqlite3')" &> /dev/null; then
        echo -e "${RED}  [ERROR] better-sqlite3 cannot load on Node $(node -v).${NC}"
        echo "  Fix options:"
        echo "    - Install Node 22 LTS (https://nodejs.org/), or"
        echo "    - Install C++ build tools and re-run:"
        echo "        Ubuntu/Debian:  sudo apt install build-essential python3"
        echo "        Fedora:         sudo dnf group install 'Development Tools'"
        echo "      then: npm rebuild better-sqlite3"
        exit 1
    fi
    echo "  [✓] Native modules rebuilt successfully"
fi
echo "  [✓] Native modules OK"

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
        -addext "subjectAltName=IP:127.0.0.1,IP:${LOCAL_IP},DNS:localhost"

    if [ -f "$HAVEN_DATA/certs/cert.pem" ]; then
        echo "  [✓] SSL cert generated (covers ${LOCAL_IP})"
    else
        echo -e "${RED}  [!] SSL certificate generation failed. Check OpenSSL output above.${NC}"
        echo "      Haven will run in HTTP mode."
    fi
    echo ""
fi

# ── Read PORT from .env (default 3000) ─────────────────────
HAVEN_PORT="${PORT:-3000}"
if [ -f "$HAVEN_DATA/.env" ]; then
    ENV_PORT=$(grep -E '^PORT=' "$HAVEN_DATA/.env" 2>/dev/null | head -1 | cut -d= -f2)
    if [ -n "$ENV_PORT" ]; then
        HAVEN_PORT="$ENV_PORT"
    fi
fi

echo "  [*] Data directory: $HAVEN_DATA"
echo "  [*] Starting Haven server..."
echo ""

# ── Start server ───────────────────────────────────────────
node server.js &
SERVER_PID=$!

# ── Wait for readiness ─────────────────────────────────────
# The probe runs on node itself — it is guaranteed present (it runs the
# server), unlike curl/wget which minimal server images often lack. The
# old curl-only probe silently failed on such systems every second for
# 15s and then KILLED a perfectly healthy server (the frontend was
# already serving) with a misleading "failed to start".
#
# Two rules now:
#   1. A dead server process is the only real startup failure — detected
#      immediately, with a pointer at the real log.
#   2. A probe failure alone NEVER kills a live server. If readiness
#      can't be confirmed after the window, we say so and leave it up.
probe_url() {
    node -e 'const u=process.argv[1];const m=u.indexOf("https")===0?require("https"):require("http");const q=m.get(u,{rejectUnauthorized:false,timeout:1500},r=>{r.resume();process.exit(0)});q.on("error",()=>process.exit(1));q.on("timeout",()=>{q.destroy();process.exit(1)});' "$1" 2>/dev/null
}

PROBE_OK=0
for i in $(seq 1 30); do
    sleep 1
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo ""
        echo -e "${RED}  [ERROR] The server process exited during startup.${NC}"
        echo "  The real reason is printed above, or in: $HAVEN_DATA/crash.log"
        echo "  Common causes: port ${HAVEN_PORT} already in use (another Haven still"
        echo "  running?), a broken install, or a bad .env value."
        exit 1
    fi
    if probe_url "https://localhost:${HAVEN_PORT}/api/health" || \
       probe_url "http://localhost:${HAVEN_PORT}/api/health"; then
        PROBE_OK=1
        break
    fi
done

if [ "$PROBE_OK" -ne 1 ]; then
    echo -e "${YELLOW}  [!] Could not confirm readiness on port ${HAVEN_PORT} after 30s,${NC}"
    echo -e "${YELLOW}      but the server process is running — leaving it up.${NC}"
    echo "      If it never becomes reachable, check $HAVEN_DATA/crash.log,"
    echo "      the PORT in $HAVEN_DATA/.env, and any firewall on ${HAVEN_PORT}."
fi

PORT=${HAVEN_PORT}

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
