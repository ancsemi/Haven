# Haven Docker Deployment
- This setup runs Haven, Traefik (reverse proxy), and coturn (TURN relay) together in a single Docker Compose stack

## Requirements
- A Linux server with Docker installed (a VPS or any internet-facing machine where you can open ports)
- A domain name pointing to your server's public IP (e.g. `haven.example.com`)
- The following ports open/forwarded on your firewall:

| Port | Protocol | Purpose |
|------|----------|---------|
| 80 | TCP | HTTP → HTTPS redirect |
| 443 | TCP | HTTPS (Traefik) |
| 3478 | TCP/UDP | TURN relay |
| 5349 | TCP/UDP | TURN over TLS |
| 49152-65535 | UDP | TURN media relay range |

## Setup
- SSH to your server
- Ensure you have Docker installed (https://get.docker.com)
- Clone this repo and cd to this folder
```
git clone https://github.com/ancsemi/Haven
cd Haven/docs/examples/haven-traefik-coturn
```
- Copy `.env.example` to `.env` and adjust the values as you see fit
```
cp .env.example .env
```
- At a minimum set `DOMAIN` and `ACME_EMAIL` and generate the `TURN_SECRET` using this command
```
openssl rand -hex 32
```
- Create the external Docker network (one-time)
```
docker network create proxy
```
- Start the stack
```
docker compose up -d
```
- Once all images have pulled and started, your Haven server should be reachable
- You may need to wait for a few minutes for Traefik to get the SSL cert
- Try clearing cookies or trying the site again in an incognito window to load the new cert
- Once Haven loads, create your admin account and log in
- You will see the setup wizard and you will likely see `Port 3000 is not reachable from the internet`
- This is expected as we're using Traefik and this can safely be ignored

## How It Works
- Traefik sits in front of Haven and handles all incoming HTTP and HTTPS connections
- Traefik automatically obtains and renews a Let's Encrypt SSL certificate using a TLS challenge (so no manual cert management or DNS changes required)
- Users connecting to your Haven URL will get routed to your Haven container
- coturn provides a TURN relay server for voice chat and screen sharing
- WebRTC tries to connect clients peer-to-peer first
- If that fails (NAT, firewalls, etc.), traffic flows through coturn instead
- This is why coturn runs with `network_mode: host` as it needs direct access to the UDP port range for media relay

## Updating
- Note that specific versions of each container have been hard-coded for this example
- Please look up the latest version of each container and change the version tag accordingly if this guide is old
- You can then apply the changes using this command
```
docker compose up -d
```
- A tool like Renovate is recommended if you intend to store this config in a Git repo (as it submits PRs with updates for image versions)