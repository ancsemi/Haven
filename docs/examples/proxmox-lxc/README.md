# Proxmox VE Helper Script for Haven

An automated, unprivileged Proxmox VE LXC installation script for [Haven](https://github.com/ancsemi/Haven) supporting multiple deployment topologies.

---

## Features

- **Automated Provisioning**: Downloads official Debian 12 standard template, configures 2 vCPU, 2 GB RAM, 16 GB rootfs, and unprivileged user mappings (`nesting=1`).
- **Node.js 22 LTS**: Installs current LTS runtime required by Haven.
- **Latest stable release**: Installs the newest Haven release, not the development branch.
- **Three Access Topologies**:
  1. **Public Domain + Caddy Reverse Proxy**: Automatic Let's Encrypt TLS certificate generation, WebSocket upgrading, and reverse proxying to `127.0.0.1:3000` via router port forwarding (80/443).
  2. **Tailscale Mesh VPN**: Zero port forwarding, no public IP/domain needed; installs `tailscaled` directly inside the container for private mesh access.
  3. **LAN / Direct IP**: Standalone local deployment using Haven's internal HTTPS on `:3000`.
- **Static IP or DHCP**: Interactive CIDR and gateway configuration for router stability.
- **Systemd Management**: Runs under dedicated unprivileged system user `haven` (`UID/GID`) with auto-restarts.
- **Pre-installed `sqlite3`**: For easy administrative tasks and direct user management.

---

## Quick Start (Run on Proxmox VE Host Shell)

Download the script to review it first, then execute:

```bash
curl -fsSL https://raw.githubusercontent.com/ancsemi/Haven/main/docs/examples/proxmox-lxc/create-haven-lxc.sh -o create-haven-lxc.sh
bash create-haven-lxc.sh
```

### Installation Profiles

When run interactively, the script offers:
1. **Quick Setup**: Automatically detects the next free CTID, selects your active rootdir storage pool, and provisions with balanced defaults (2 vCPU, 2 GB RAM, 16 GB disk).
2. **Advanced Setup**: Steps through each resource parameter (CTID, Hostname, CPU cores, RAM, Swap, Disk size, Storage pool, and Network bridge) showing the default in brackets `[default: ...]`. Pressing **Enter** accepts the default, or you can type a custom value.

You can customize parameters via environment variables for unattended setup:

```bash
export CTID="300"
export CT_HOSTNAME="haven"
export CORES="2"
export MEMORY="2048"
export DISK_SIZE="16"
export STORAGE="local-lvm"
export ACCESS_MODE="caddy"       # Options: 'caddy', 'tailscale', or 'standalone'
export DOMAIN="haven.example.com" # Required if ACCESS_MODE=caddy
export STATIC_IP="192.168.1.50/24"
export GATEWAY="192.168.1.1"
export AUTO_BACKUP="yes"          # Options: 'yes' or 'no'
export ADMIN_USER="admin"         # Initial admin username to grant ownership

bash create-haven-lxc.sh
```

---

## Post-Install Admin Setup

The first account registered with the admin username you chose (`ADMIN_USER`, `admin` by default) becomes the admin.

If you registered under a different name before any admin existed, set `ADMIN_USERNAME` in `/etc/systemd/system/haven.service` inside the container to that name, then restart and log in again:

```bash
pct exec <CTID> -- bash -c 'systemctl daemon-reload && systemctl restart haven'
```

Haven's data, including its database, is in `/var/lib/haven` inside the container.

---

## Updating Haven

An in-container update shortcut (`update` / `update-haven`) is pre-installed. It stops the service, moves to the latest stable Haven release from GitHub, refreshes production dependencies, fixes permissions, and restarts the service.

From your Proxmox host shell:
```bash
pct exec <CTID> -- update
```

Or from inside the container console:
```bash
update
```
