#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Haven: One-Click Installer Bootstrap (Linux / macOS)
# Run: curl -fsSL https://ancsemi.github.io/Haven/install.sh | bash
#  or: wget -qO- https://ancsemi.github.io/Haven/install.sh | bash
# ═══════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

INSTALL_DIR="$HOME/Haven"

echo ""
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo -e "${GREEN}${BOLD}    HAVEN: One-Click Installer${NC}"
echo -e "${GREEN}${BOLD}  ========================================${NC}"
echo ""
echo "  This will set up Haven, your private"
echo "  chat server. Everything is automatic."
echo ""
echo "  Install location: $INSTALL_DIR"
echo ""

# ── AppImage hint (Linux only, shown before we start) ────
if [ "$(uname -s)" = "Linux" ]; then
    _ARCH=$(uname -m)
    if [ "$_ARCH" = "x86_64" ] || [ "$_ARCH" = "aarch64" ]; then
        echo -e "  ${CYAN}Tip:${NC} Prefer a portable, no-root AppImage instead?"
        echo "  Download one file from the Releases page and run it:"
        echo "    https://github.com/ancsemi/Haven/releases/latest"
        echo "  (Works on any Linux distro, no Node.js needed)"
        echo ""
    fi
fi

# ── Step 1: Check / Install Node.js ──────────────────────
echo "  [1/3] Checking for Node.js..."

if ! command -v node &> /dev/null; then
    echo ""
    echo -e "  ${CYAN}Haven needs Node.js to run.${NC}"
    echo "  We'll help you install it now."
    echo ""

    if command -v apt-get &> /dev/null; then
        echo "  Detected: Debian / Ubuntu / Linux Mint / Pop!_OS"
        echo -e "  Installing Node.js 22 LTS (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then
            echo "  Install Node.js from https://nodejs.org then try again."
            exit 0
        fi
        sudo apt-get update -qq
        sudo apt-get install -y -qq ca-certificates curl gnupg > /dev/null 2>&1
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
        sudo apt-get update -qq
        sudo apt-get install -y -qq nodejs > /dev/null 2>&1

    elif command -v dnf &> /dev/null; then
        echo "  Detected: Fedora / RHEL 8+ / Rocky / AlmaLinux"
        echo -e "  Installing Node.js 22 LTS (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - > /dev/null 2>&1
        sudo dnf install -y nodejs > /dev/null 2>&1

    elif command -v yum &> /dev/null; then
        echo "  Detected: CentOS / RHEL 7"
        echo -e "  Installing Node.js 22 LTS (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - > /dev/null 2>&1
        sudo yum install -y nodejs > /dev/null 2>&1

    elif command -v pacman &> /dev/null; then
        echo "  Detected: Arch Linux / Manjaro / EndeavourOS / CachyOS / Garuda"
        echo -e "  Installing Node.js (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        sudo pacman -S --noconfirm nodejs npm > /dev/null 2>&1

    elif command -v zypper &> /dev/null; then
        echo "  Detected: openSUSE / SUSE Linux Enterprise"
        echo -e "  Installing Node.js (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        sudo zypper install -y nodejs22 npm22 > /dev/null 2>&1 || \
        sudo zypper install -y nodejs npm > /dev/null 2>&1

    elif command -v apk &> /dev/null; then
        echo "  Detected: Alpine Linux"
        echo -e "  Installing Node.js (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        sudo apk add --no-cache nodejs npm > /dev/null 2>&1

    elif command -v eopkg &> /dev/null; then
        echo "  Detected: Solus"
        echo -e "  Installing Node.js (requires ${BOLD}sudo${NC})."
        echo ""
        read -rp "  Proceed? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        sudo eopkg install -y nodejs > /dev/null 2>&1

    elif command -v brew &> /dev/null; then
        echo "  Detected: Homebrew (macOS)"
        read -rp "  Install Node.js via brew? [Y/n]: " CONFIRM
        if [[ "${CONFIRM,,}" == "n" ]]; then exit 0; fi
        brew install node@22 2>/dev/null
        brew link --overwrite node@22 2>/dev/null || true

    else
        # No known package manager: try nvm (no root required, works anywhere)
        echo -e "  ${YELLOW}No known package manager found.${NC}"
        echo "  Trying nvm (Node Version Manager). No root needed."
        echo ""
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        if [ ! -f "$NVM_DIR/nvm.sh" ]; then
            echo "  Installing nvm..."
            curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash > /dev/null 2>&1
        fi
        # shellcheck source=/dev/null
        if [ -s "$NVM_DIR/nvm.sh" ]; then
            \. "$NVM_DIR/nvm.sh"
            nvm install 22 > /dev/null 2>&1
            nvm use 22 > /dev/null 2>&1
        else
            echo -e "  ${RED}Could not install Node.js automatically.${NC}"
            echo "  Options:"
            echo "    1. Install Node.js 22 from https://nodejs.org and re-run"
            echo "    2. Download the Haven AppImage (no Node.js needed):"
            echo "         https://github.com/ancsemi/Haven/releases/latest"
            exit 1
        fi
    fi

    echo -e "  ${GREEN}[OK] Node.js installed!${NC}"
    echo ""
fi

if ! command -v node &> /dev/null; then
    echo -e "  ${RED}[ERROR] Node.js is still not available.${NC}"
    echo "  Open a new terminal and try again."
    exit 1
fi

echo -e "        Node.js $(node -v) ready"
echo ""

# ── Step 2: Download Haven ───────────────────────────────
echo "  [2/3] Downloading Haven..."

if [ -f "$INSTALL_DIR/package.json" ]; then
    # Updating is Haven's own job (Settings > Admin > Update Now), which moves
    # to the next release. This script leaves an existing install as it is.
    echo "        Haven is already downloaded."
else
    # The latest release, never the tip of main: main holds work that has not
    # been released yet.
    HAVEN_TAG=$(curl -fsSL "https://api.github.com/repos/ancsemi/Haven/releases/latest" 2>/dev/null | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    if ! printf '%s' "$HAVEN_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo -e "  ${RED}[!] Could not find the latest Haven release. Check your internet connection and try again.${NC}"
        exit 1
    fi
    echo "        Latest release: $HAVEN_TAG"
    # The release archive, not a git clone: Update Now in Settings then
    # moves this install from release to release.
    echo "        Downloading from GitHub..."
    TMP_OUT=$(mktemp -d /tmp/haven-XXXXXX)
    curl -fsSL "https://github.com/ancsemi/Haven/archive/refs/tags/$HAVEN_TAG.tar.gz" | tar -xz -C "$TMP_OUT"
    mv "$TMP_OUT"/Haven-* "$INSTALL_DIR"
    rm -rf "$TMP_OUT"
fi

if [ ! -f "$INSTALL_DIR/package.json" ]; then
    echo -e "  ${RED}[!] Download failed. Check your internet connection.${NC}"
    exit 1
fi

echo "        Haven ready at $INSTALL_DIR"
echo ""

# ── Step 3: Launch GUI installer ─────────────────────────
echo "  [3/3] Opening installer in your browser..."
echo "        (Keep this terminal open until setup is done)"
echo ""

chmod +x "$INSTALL_DIR/start.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null || true

node "$INSTALL_DIR/installer/server.js"
