#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Haven — Cross-Platform Installer (Linux / macOS)
# Usage: chmod +x install.sh && ./install.sh
# ═══════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo -e "${GREEN}${BOLD}       HAVEN — Installer${NC}"
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo ""
echo "  Welcome! This will set up your private"
echo "  chat server. Nothing complicated — just"
echo "  follow the steps in the browser window."
echo ""

# ── Check for Node.js ────────────────────────────────────
install_node() {
    echo ""
    echo -e "${CYAN}  Haven needs Node.js to run.${NC}"
    echo "  We'll help you install it now."
    echo ""

    # Detect package manager / distro
    if command -v apt-get &> /dev/null; then
        echo "  Detected: Debian / Ubuntu"
        echo ""
        echo -e "  We'll install Node.js 22 LTS via NodeSource."
        echo -e "  This requires ${BOLD}sudo${NC} (admin) access."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then
            echo ""
            echo "  No problem. Install Node.js 22 manually:"
            echo "    https://nodejs.org/en/download"
            echo "  Then run this installer again."
            exit 0
        fi
        echo ""
        echo -e "  ${CYAN}[*] Setting up NodeSource repository...${NC}"
        # Install prerequisites
        sudo apt-get update -qq
        sudo apt-get install -y -qq ca-certificates curl gnupg > /dev/null 2>&1
        # Add NodeSource GPG key and repo
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
        sudo apt-get update -qq
        echo -e "  ${CYAN}[*] Installing Node.js 22 LTS...${NC}"
        sudo apt-get install -y -qq nodejs > /dev/null 2>&1
        echo -e "  ${GREEN}[OK] Node.js installed!${NC}"

    elif command -v dnf &> /dev/null; then
        echo "  Detected: Fedora / RHEL"
        echo ""
        echo -e "  We'll install Node.js 22 via NodeSource."
        echo -e "  This requires ${BOLD}sudo${NC} (admin) access."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then
            echo "  Install Node.js manually: https://nodejs.org"
            exit 0
        fi
        echo ""
        echo -e "  ${CYAN}[*] Installing Node.js 22 LTS...${NC}"
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - > /dev/null 2>&1
        sudo dnf install -y nodejs > /dev/null 2>&1
        echo -e "  ${GREEN}[OK] Node.js installed!${NC}"

    elif command -v pacman &> /dev/null; then
        echo "  Detected: Arch Linux"
        echo ""
        echo -e "  We'll install Node.js via pacman."
        echo -e "  This requires ${BOLD}sudo${NC} (admin) access."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then
            echo "  Install Node.js manually: sudo pacman -S nodejs npm"
            exit 0
        fi
        echo ""
        echo -e "  ${CYAN}[*] Installing Node.js...${NC}"
        sudo pacman -S --noconfirm nodejs npm > /dev/null 2>&1
        echo -e "  ${GREEN}[OK] Node.js installed!${NC}"

    elif command -v brew &> /dev/null; then
        echo "  Detected: Homebrew (macOS)"
        echo ""
        read -rp "  Install Node.js via brew? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then
            echo "  Install Node.js manually: https://nodejs.org"
            exit 0
        fi
        echo ""
        echo -e "  ${CYAN}[*] Installing Node.js 22 LTS...${NC}"
        brew install node@22 2>/dev/null
        brew link --overwrite node@22 2>/dev/null || true
        echo -e "  ${GREEN}[OK] Node.js installed!${NC}"

    else
        echo -e "  ${YELLOW}Could not detect your package manager.${NC}"
        echo ""
        echo "  Please install Node.js 22 LTS manually:"
        echo ""
        echo "    https://nodejs.org/en/download"
        echo ""
        echo "  Then run this installer again."
        exit 1
    fi
    echo ""
}

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    install_node
fi

# Verify Node.js works
if ! command -v node &> /dev/null; then
    echo -e "  ${RED}[ERROR] Node.js is still not available.${NC}"
    echo "  You may need to open a new terminal, then"
    echo "  run this installer again."
    exit 1
fi

NODE_VER=$(node -v)
echo -e "  ${GREEN}[OK]${NC} Node.js ${NODE_VER} found"
echo ""
echo "  Opening installer in your browser..."
echo "  (Keep this terminal open until setup is done)"
echo ""

# ── Launch the web-based GUI installer ────────────────────
node "$DIR/installer/server.js"
