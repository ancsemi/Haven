# ── Haven Dockerfile ─────────────────────────────────────
# Lightweight Node.js image with SSL cert auto-generation.
# Data (database, .env, certs, uploads) is stored in /data
# so it survives container rebuilds.
#
# Build:   docker build -t haven .
# Run:     docker compose up -d
# ─────────────────────────────────────────────────────────

# Debian slim rather than Alpine: the voice relay (Large Server Setup) runs a
# media program that is only built for glibc systems, so on Alpine it could
# not be installed at all.
FROM node:22-bookworm-slim

# OpenSSL  → auto-generate self-signed HTTPS certs
# tini     → proper PID 1 signal handling (clean shutdown)
# gosu     → drop root to 'node' user after entrypoint setup
# wget     → the container health check
# make, g++, python3 → compile native modules (better-sqlite3) if no prebuilt fits
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl tini gosu wget ca-certificates \
    make g++ python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching: only re-runs when package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev && \
    # Remove build tools after native modules are compiled (saves ~150 MB)
    apt-get purge -y --auto-remove make g++ python3 && \
    rm -rf /root/.cache /tmp/* /var/lib/apt/lists/*

# Copy entrypoint (auto-generates SSL certs, fixes volume permissions)
COPY docker-entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Copy application source
COPY . .

# ── Environment defaults (override via docker-compose.yml or .env) ──
ENV PORT=3000 \
    HOST=0.0.0.0 \
    HAVEN_DATA_DIR=/data \
    NODE_ENV=production

# Create data directory; give ownership to non-root 'node' user
RUN mkdir -p /data/certs /data/uploads && chown -R node:node /app /data

USER root
# 40000 is the voice relay's default port (UDP and TCP), used only once the
# relay is switched on in Large Server Setup.
EXPOSE 3000 3001 40000/udp 40000/tcp
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'PROTO=https; [ "$FORCE_HTTP" = "true" ] && PROTO=http; wget -qO- --no-check-certificate "${PROTO}://127.0.0.1:${PORT:-3000}/api/health" || exit 1'

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server.js"]