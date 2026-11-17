#!/usr/bin/env bash
# Copyright (c) 2021-2026 Haven Contributors
# License: AGPL-3.0-or-later
# Source: https://github.com/ancsemi/Haven

set -euo pipefail

# ------------------------------------------------------------------------------
# Configurable Defaults
# ------------------------------------------------------------------------------
APP="Haven"
CTID="${CTID:-}"
# Avoid collision with Bash's built-in HOSTNAME variable
CT_HOSTNAME="${CT_HOSTNAME:-haven}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"
SWAP="${SWAP:-512}"
DISK_SIZE="${DISK_SIZE:-16}"
DISK_SIZE="${DISK_SIZE%G}" # Strip G/g if provided
DISK_SIZE="${DISK_SIZE%g}"
STORAGE="${STORAGE:-}"
BRIDGE="${BRIDGE:-vmbr0}"
ACCESS_MODE="${ACCESS_MODE:-}"
DOMAIN="${DOMAIN:-}"
STATIC_IP="${STATIC_IP:-}"
GATEWAY="${GATEWAY:-}"
AUTO_BACKUP="${AUTO_BACKUP:-}"
ADMIN_USER="${ADMIN_USER:-}"

# Colors
RD="\033[01;31m"
GN="\033[1;92m"
YW="\033[33m"
BL="\033[36m"
CL="\033[m"

echo -e "${BL}------------------------------------------------------------------------${CL}"
echo -e "${GN}            Haven (Private Discord Alternative) Proxmox LXC             ${CL}"
echo -e "${BL}------------------------------------------------------------------------${CL}"

# Check for root/Proxmox environment
if ! command -v pct &>/dev/null; then
    echo -e "${RD}[ERROR] This script must be run directly on the Proxmox VE host.${CL}"
    exit 1
fi

# Detect defaults from host environment
NEXT_CTID=$(pvesh get /cluster/nextid)
DETECTED_STORAGE=$(pvesm status -content rootdir | awk 'NR>1 {print $1}' | head -n1)
DETECTED_STORAGE="${DETECTED_STORAGE:-local-lvm}"
DETECTED_GW=$(ip route | awk '/default/ {print $3}' | head -n1 || true)

# ------------------------------------------------------------------------------
# Interactive Wizard
# ------------------------------------------------------------------------------
if [ -t 0 ]; then
    echo -e "${YW}[?] Container Name / Hostname:${CL}"
    read -r -p "    Enter container name [default: ${CT_HOSTNAME}]: " input_hn
    CT_HOSTNAME="${input_hn:-$CT_HOSTNAME}"

    echo -e "\n${YW}[?] Select Installation Profile:${CL}"
    echo -e "  ${GN}1)${CL} Quick Setup (Default resources: 2 vCPU, 2GB RAM, 16GB Disk on ${DETECTED_STORAGE})"
    echo -e "  ${GN}2)${CL} Advanced Setup (Customize CT ID, CPU, RAM, Disk, Storage, Bridge)"
    read -r -p "  Enter choice [1-2, default: 1]: " profile_choice

    if [ "${profile_choice:-1}" == "2" ]; then
        echo -e "\n${BL}--- Container Resources & Hardware Configuration ---${CL}"
        echo -e "${YW}(Press Enter to accept the default value in brackets)${CL}\n"

        read -r -p "  Container ID [default: ${CTID:-$NEXT_CTID}]: " input_ctid
        CTID="${input_ctid:-${CTID:-$NEXT_CTID}}"

        read -r -p "  Container Name / Hostname [default: ${CT_HOSTNAME}]: " input_hn
        CT_HOSTNAME="${input_hn:-$CT_HOSTNAME}"

        read -r -p "  CPU Cores [default: ${CORES}]: " input_cores
        CORES="${input_cores:-$CORES}"

        read -r -p "  Memory in MB [default: ${MEMORY}]: " input_mem
        MEMORY="${input_mem:-$MEMORY}"

        read -r -p "  Swap in MB [default: ${SWAP}]: " input_swap
        SWAP="${input_swap:-$SWAP}"

        read -r -p "  Root Disk Size in GB [default: ${DISK_SIZE}]: " input_disk
        DISK_SIZE="${input_disk:-$DISK_SIZE}"
        DISK_SIZE="${DISK_SIZE%G}"
        DISK_SIZE="${DISK_SIZE%g}"

        read -r -p "  Storage Pool [default: ${STORAGE:-$DETECTED_STORAGE}]: " input_storage
        STORAGE="${input_storage:-${STORAGE:-$DETECTED_STORAGE}}"

        read -r -p "  Network Bridge [default: ${BRIDGE}]: " input_bridge
        BRIDGE="${input_bridge:-$BRIDGE}"
    fi

    echo -e "\n${BL}--- Remote Access & Network Configuration ---${CL}"
    if [ -z "$ACCESS_MODE" ]; then
        echo -e "${YW}[?] Select Access Mode:${CL}"
        echo -e "  ${GN}1)${CL} Public Domain with Caddy Reverse Proxy & Automated SSL (Recommended for remote friends)"
        echo -e "  ${GN}2)${CL} Tailscale / Mesh VPN (Safe remote access without open ports or custom domain)"
        echo -e "  ${GN}3)${CL} LAN / Direct IP (Local network only, uses Haven internal self-signed TLS)"
        read -r -p "  Enter choice [1-3, default: 1]: " mode_choice
        case "${mode_choice:-1}" in
            1) ACCESS_MODE="caddy" ;;
            2) ACCESS_MODE="tailscale" ;;
            3) ACCESS_MODE="standalone" ;;
            *) ACCESS_MODE="caddy" ;;
        esac
    fi

    if [ "$ACCESS_MODE" == "caddy" ] && [ -z "$DOMAIN" ]; then
        echo -e "\n${YW}[?] Enter custom domain (FQDN) for automated SSL via Caddy:${CL}"
        read -r -p "    Domain [e.g. haven.example.com]: " input_domain
        DOMAIN="${input_domain:-}"
        if [ -z "$DOMAIN" ]; then
            echo -e "${RD}[WARN] No domain entered. Falling back to LAN / Direct IP mode.${CL}"
            ACCESS_MODE="standalone"
        fi
    fi

    if [ -z "$STATIC_IP" ]; then
        echo -e "\n${YW}[?] IP Assignment Strategy:${CL}"
        echo -e "    Press Enter to use dynamic DHCP, or enter a Static CIDR."
        read -r -p "    Static IP/CIDR [e.g. 192.168.0.95/24 or Enter for DHCP]: " input_ip
        STATIC_IP="${input_ip:-}"
        if [ -n "$STATIC_IP" ] && [ -z "$GATEWAY" ]; then
            read -r -p "    Gateway IP [default: ${DETECTED_GW:-none}]: " input_gw
            GATEWAY="${input_gw:-$DETECTED_GW}"
        fi
    fi

    if [ -z "$AUTO_BACKUP" ]; then
        echo -e "\n${YW}[?] Schedule Automated Daily Proxmox Backups? [y/N]:${CL}"
        read -r -p "    Enable daily snapshot backup at 03:00 AM [y/N, default: N]: " input_backup
        case "${input_backup:-n}" in
            [yY]|[yY][eE][sS]) AUTO_BACKUP="yes" ;;
            *) AUTO_BACKUP="no" ;;
        esac
    fi

    if [ -z "$ADMIN_USER" ]; then
        echo -e "\n${YW}[?] Initial Administrator Account:${CL}"
        echo -e "    Haven designates an admin username for initial setup (default: admin)."
        read -r -p "    Admin username [default: admin]: " input_admin
        ADMIN_USER="${input_admin:-admin}"
    fi
fi

# Apply fallbacks for non-interactive or unassigned variables
CTID="${CTID:-$NEXT_CTID}"
STORAGE="${STORAGE:-$DETECTED_STORAGE}"
ADMIN_USER="${ADMIN_USER:-admin}"
if [ -z "$ACCESS_MODE" ]; then
    if [ -n "$DOMAIN" ]; then
        ACCESS_MODE="caddy"
    else
        ACCESS_MODE="standalone"
    fi
fi

echo -e "\n${BL}[INFO] Deployment Configuration:${CL}"
echo -e "  Container ID : ${GN}${CTID}${CL}"
echo -e "  Hostname     : ${GN}${CT_HOSTNAME}${CL}"
echo -e "  Cores        : ${GN}${CORES}${CL}"
echo -e "  Memory       : ${GN}${MEMORY}MB (Swap: ${SWAP}MB)${CL}"
echo -e "  Disk         : ${GN}${DISK_SIZE}GB on ${GN}${STORAGE}${CL}"
echo -e "  Bridge       : ${GN}${BRIDGE}${CL}"
echo -e "  Access Mode  : ${GN}${ACCESS_MODE}${CL}"
echo -e "  Admin User   : ${GN}${ADMIN_USER}${CL}"
if [ "$ACCESS_MODE" == "caddy" ]; then
    echo -e "  Domain (TLS) : ${GN}${DOMAIN}${CL}"
fi
if [ -n "$STATIC_IP" ]; then
    echo -e "  Networking   : ${GN}${STATIC_IP}${CL} (GW: ${GATEWAY})"
else
    echo -e "  Networking   : ${YW}DHCP${CL}"
fi
echo ""

# ------------------------------------------------------------------------------
# 1. Download Debian 12 Template
# ------------------------------------------------------------------------------
TEMPLATE_STORAGE=$(pvesm status -content vztmpl | awk 'NR>1 {print $1}' | head -n1)
if [ -z "$TEMPLATE_STORAGE" ]; then
    TEMPLATE_STORAGE="local"
fi

echo -e "${BL}[1/4] Checking Proxmox LXC templates...${CL}"
DEBIAN_TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" | grep -oE 'debian-12-standard[^ ]*\.tar\.[a-z0-9]+' | head -n1 || true)

if [ -z "$DEBIAN_TEMPLATE" ]; then
    echo -e "${YW}Updating LXC template database and downloading Debian 12...${CL}"
    pveam update >/dev/null
    AVAILABLE_DEBIAN=$(pveam available -section system | grep 'debian-12-standard' | head -n1 | awk '{print $2}')
    if [ -n "$AVAILABLE_DEBIAN" ]; then
        pveam download "$TEMPLATE_STORAGE" "$AVAILABLE_DEBIAN"
    fi
    DEBIAN_TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" | grep -oE 'debian-12-standard[^ ]*\.tar\.[a-z0-9]+' | head -n1)
fi

# ------------------------------------------------------------------------------
# 2. Create the Unprivileged Container
# ------------------------------------------------------------------------------
echo -e "${BL}[2/4] Creating unprivileged LXC container (${CTID})...${CL}"
if [ -n "$STATIC_IP" ]; then
    NET_CONFIG="name=eth0,bridge=$BRIDGE,ip=$STATIC_IP,gw=$GATEWAY,type=veth"
else
    NET_CONFIG="name=eth0,bridge=$BRIDGE,ip=dhcp,type=veth"
fi

pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$DEBIAN_TEMPLATE" \
    --ostype debian \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --swap "$SWAP" \
    --rootfs "$STORAGE:$DISK_SIZE" \
    --net0 "$NET_CONFIG" \
    --features nesting=1 \
    --unprivileged 1 \
    --onboot 1

# If Tailscale mode is selected, configure TUN device passthrough for unprivileged container
if [ "$ACCESS_MODE" == "tailscale" ]; then
    echo -e "${BL}[INFO] Configuring /dev/net/tun passthrough for Tailscale...${CL}"
    cat << 'EOF' >> "/etc/pve/lxc/${CTID}.conf"
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
fi

echo -e "${BL}[INFO] Starting container...${CL}"
pct start "$CTID"

# Wait for container networking
for i in {1..20}; do
    if pct exec "$CTID" -- ip route get 1.1.1.1 &>/dev/null; then
        break
    fi
    sleep 1
done

# ------------------------------------------------------------------------------
# 3. Inside-LXC Provisioning (Node.js 22 LTS, Haven, and Tools)
# ------------------------------------------------------------------------------
echo -e "${BL}[3/4] Installing dependencies inside container...${CL}"

pct exec "$CTID" -- bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl git build-essential sqlite3 debian-keyring debian-archive-keyring apt-transport-https gpg

    # Install Node.js 22 LTS (Haven requirement)
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs

    # Create dedicated unprivileged service user
    id -u haven &>/dev/null || useradd -r -s /usr/sbin/nologin -d /var/lib/haven -m haven
    mkdir -p /opt/haven /var/lib/haven /var/log/haven

    # Clone Haven repository
    if [ ! -d /opt/haven/.git ]; then
        git clone https://github.com/ancsemi/Haven.git /opt/haven
    fi

    # Configure git safe directory for root and haven users
    git config --system --add safe.directory /opt/haven

    # Run the latest stable release, not the development branch (main holds
    # work that has not been through a release yet). Pre-release tags such
    # as v4.27.0-beta.1 carry a dash and are skipped.
    cd /opt/haven
    git fetch --tags --quiet
    LATEST=$(git tag -l "v*" --sort=-v:refname | grep -v -- "-" | head -n1)
    git checkout --quiet "$LATEST"

    # Install npm production dependencies, exactly as locked
    npm ci --omit=dev

    # Install in-container update helper script (/usr/local/bin/update-haven and symlink /usr/local/bin/update)
    cat << 'UPDATE_EOF' > /usr/local/bin/update-haven
#!/usr/bin/env bash
set -euo pipefail
echo "==> Stopping Haven service..."
systemctl stop haven

echo "==> Fetching the latest Haven release from GitHub..."
cd /opt/haven
git config --system --get-all safe.directory | grep -qx /opt/haven || git config --system --add safe.directory /opt/haven
git fetch --tags --quiet
LATEST=\$(git tag -l "v*" --sort=-v:refname | grep -v -- "-" | head -n1)
git checkout --quiet "\$LATEST"
echo "==> Now on \$LATEST"

echo "==> Updating dependencies..."
npm ci --omit=dev

echo "==> Restoring file permissions..."
chown -R haven:haven /opt/haven /var/lib/haven /var/log/haven

echo "==> Restarting Haven..."
systemctl start haven

echo "==> Haven successfully updated!"
systemctl status haven --no-pager
UPDATE_EOF
    chmod +x /usr/local/bin/update-haven
    ln -sf /usr/local/bin/update-haven /usr/local/bin/update
    ln -sf /usr/local/bin/update-haven /usr/bin/update
    ln -sf /usr/local/bin/update-haven /usr/bin/update-haven

    chown -R haven:haven /opt/haven /var/lib/haven /var/log/haven
'

# Additional components based on Access Mode
if [ "$ACCESS_MODE" == "caddy" ]; then
    echo -e "${BL}[INFO] Installing Caddy reverse proxy...${CL}"
    pct exec "$CTID" -- bash -c '
        set -euo pipefail
        curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
        apt-get update -qq
        apt-get install -y -qq caddy
    '
elif [ "$ACCESS_MODE" == "tailscale" ]; then
    echo -e "${BL}[INFO] Installing Tailscale mesh VPN client...${CL}"
    pct exec "$CTID" -- bash -c '
        set -euo pipefail
        curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
        curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list | tee /etc/apt/sources.list.d/tailscale.list >/dev/null
        apt-get update -qq
        apt-get install -y -qq tailscale
        systemctl enable --now tailscaled
    '
fi

# ------------------------------------------------------------------------------
# 4. Service Configuration (Systemd & Proxy)
# ------------------------------------------------------------------------------
echo -e "${BL}[4/4] Configuring system services...${CL}"

if [ "$ACCESS_MODE" == "caddy" ]; then
    # Behind reverse proxy on localhost
    FORCE_HTTP_SETTING="Environment=FORCE_HTTP=true"
    HOST_BIND="Environment=HOST=127.0.0.1"
else
    # Standalone or Tailscale: Haven serves on 0.0.0.0 with internal HTTPS
    FORCE_HTTP_SETTING="Environment=FORCE_HTTP=false"
    HOST_BIND="Environment=HOST=0.0.0.0"
fi

cat << EOF > /tmp/haven.service
[Unit]
Description=Haven Chat Server
After=network.target

[Service]
Type=simple
User=haven
Group=haven
WorkingDirectory=/opt/haven
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=ADMIN_USERNAME=${ADMIN_USER}
${HOST_BIND}
${FORCE_HTTP_SETTING}
Environment=HAVEN_DATA_DIR=/var/lib/haven
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/haven/haven.log
StandardError=append:/var/log/haven/haven.error.log

[Install]
WantedBy=multi-user.target
EOF

pct push "$CTID" /tmp/haven.service /etc/systemd/system/haven.service
rm /tmp/haven.service

# Configure Caddy if selected
if [ "$ACCESS_MODE" == "caddy" ]; then
cat << EOF > /tmp/Caddyfile
$DOMAIN {
    encode gzip zstd

    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
EOF
    pct push "$CTID" /tmp/Caddyfile /etc/caddy/Caddyfile
    rm /tmp/Caddyfile
    pct exec "$CTID" -- bash -c 'systemctl daemon-reload && systemctl enable --now caddy && systemctl restart caddy'
fi

# Start Haven service
pct exec "$CTID" -- bash -c 'systemctl daemon-reload && systemctl enable --now haven'

# ------------------------------------------------------------------------------
# 5. Automated Backup Scheduling (Optional)
# ------------------------------------------------------------------------------
if [ "$AUTO_BACKUP" == "yes" ]; then
    BACKUP_STORAGE=$(pvesm status -content backup | awk 'NR>1 {print $1}' | head -n1 || true)
    if [ -z "$BACKUP_STORAGE" ]; then
        BACKUP_STORAGE="$TEMPLATE_STORAGE"
    fi
    echo -e "${BL}[INFO] Scheduling daily automated backup for CT ${CTID} on storage ${BACKUP_STORAGE}...${CL}"
    pvesh create /cluster/backup \
        --id "backup-haven-${CTID}" \
        --schedule "03:00" \
        --storage "$BACKUP_STORAGE" \
        --vmid "$CTID" \
        --mode snapshot \
        --compress zstd 2>/dev/null || true
fi

CONTAINER_IP=$(pct exec "$CTID" -- ip -4 addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1 | head -n1)

echo -e "\n${GN}------------------------------------------------------------------------${CL}"
echo -e "${GN}  Haven LXC Container Provisioned Successfully!                         ${CL}"
echo -e "${GN}------------------------------------------------------------------------${CL}"
echo -e "  Container ID : ${BL}${CTID}${CL}"
echo -e "  Local IP     : ${BL}${CONTAINER_IP}${CL}"

if [ "$ACCESS_MODE" == "caddy" ]; then
    echo -e "  Public FQDN  : ${BL}https://${DOMAIN}${CL}"
    echo -e "\n${YW}Next steps for public domain access:${CL}"
    echo -e "  1. Point your domain's DNS 'A' record to your router's public IP address."
    echo -e "  2. Port forward ports 80 and 443 on your router to ${CONTAINER_IP}."
    echo -e "  3. Caddy will automatically issue the Let's Encrypt SSL certificate once DNS resolves."
elif [ "$ACCESS_MODE" == "tailscale" ]; then
    echo -e "  Access Mode  : ${BL}Tailscale Mesh VPN${CL}"
    echo -e "\n${YW}[?] Connect this container to your Tailscale network now? [Y/n]:${CL}"
    if [ -t 0 ]; then
        read -r -p "    Run 'tailscale up' now? [Y/n, default: Y]: " run_ts
        case "${run_ts:-y}" in
            [yY]|[yY][eE][sS])
                echo -e "${BL}[INFO] Running 'tailscale up'... Follow the authorization link below:${CL}\n"
                pct exec "$CTID" -- tailscale up || true
                ;;
            *)
                echo -e "${YW}[INFO] Skipped. You can authenticate later with: pct exec ${CTID} -- tailscale up${CL}"
                ;;
        esac
    fi
    TS_IP=$(pct exec "$CTID" -- tailscale ip -4 2>/dev/null || true)
    if [ -n "$TS_IP" ]; then
        echo -e "\n  ${GN}Connected to Tailscale!${CL}"
        echo -e "  Tailscale IP : ${BL}${TS_IP}${CL}"
        echo -e "  Tailnet URL  : ${BL}https://${TS_IP}:3000${CL}"
    else
        echo -e "\n${YW}Next steps for Tailscale:${CL}"
        echo -e "  1. Authenticate container: ${GN}pct exec ${CTID} -- tailscale up${CL}"
        echo -e "  2. Once joined, friends on your Tailnet can connect to: ${BL}https://<tailscale-ip>:3000${CL}"
    fi
else
    echo -e "  Access URL   : ${BL}https://${CONTAINER_IP}:3000${CL}"
    echo -e "\n${YW}Next steps for LAN access:${CL}"
    echo -e "  Connect via https://${CONTAINER_IP}:3000 (accept the self-signed certificate warning in your browser)."
fi

echo -e "\n${BL}Initial Administrator Setup:${CL}"
echo -e "  Designated Admin Username: ${GN}${ADMIN_USER}${CL}"
echo -e "  1. On first login, click Register and create an account named '${GN}${ADMIN_USER}${CL}'."
echo -e "  2. Registered under another name before any admin existed? Set ADMIN_USERNAME in"
echo -e "     /etc/systemd/system/haven.service to that name, then run:"
echo -e "     ${BL}pct exec ${CTID} -- bash -c 'systemctl daemon-reload && systemctl restart haven'${CL}"
echo -e "     and log in again. Haven makes that account the admin."

echo -e "\n${BL}Updating Haven in the Future:${CL}"
echo -e "  From Proxmox host shell: ${GN}pct exec ${CTID} -- update${CL}"
echo -e "  From inside container:   ${GN}update${CL}"
echo ""
