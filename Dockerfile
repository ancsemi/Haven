# ── Haven Dockerfile ─────────────────────────────────────
# Lightweight Node.js image with SSL cert auto-generation.
# Data (database, .env, certs, uploads) is stored in /data
# so it survives container rebuilds.
#
# Build:   docker build -t haven .
# Run:     docker compose up -d
# ─────────────────────────────────────────────────────────

FROM node:20-alpine

# OpenSSL  → auto-generate self-signed HTTPS certs
# tini     → proper PID 1 signal handling (clean shutdown)
# su-exec  → drop root to 'node' user after entrypoint setup
# build-base, python3 → compile native modules (better-sqlite3)
RUN apk update && apk add --no-cache \
    openssl tini su-exec \
    build-base python3

WORKDIR /app

# Install dependencies first (layer caching — only re-runs when package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev && \
    # Remove build tools after native modules are compiled (saves ~150 MB)
    apk del build-base python3 && \
    rm -rf /root/.cache /tmp/*

# Copy entrypoint (auto-generates SSL certs, fixes volume permissions)
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

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
EXPOSE 3000 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --no-check-certificate https://127.0.0.1:${PORT:-3000}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server.js"]