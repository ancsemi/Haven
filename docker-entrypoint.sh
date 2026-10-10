#!/bin/sh
set -e

DATA="/data"
CERTS="$DATA/certs"

# Auto-generate self-signed SSL certs if none exist (skip if FORCE_HTTP=true)
# (HTTPS is needed for voice chat to work over the network)
if [ "${FORCE_HTTP:-false}" = "true" ]; then
  echo "⚡ FORCE_HTTP=true, skipping SSL certificate generation"
elif [ ! -f "$CERTS/cert.pem" ] || [ ! -f "$CERTS/key.pem" ]; then
  echo "🔐 Generating self-signed SSL certificate..."
  mkdir -p "$CERTS"
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$CERTS/key.pem" \
    -out "$CERTS/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=Haven" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    2>/dev/null
  chown node:node "$CERTS/cert.pem" "$CERTS/key.pem" 2>/dev/null || true
  echo "✅ SSL certificate created"
fi

# Fix ownership on bind-mounted volumes (Synology / NAS friendly).
# Haven runs as node (uid 1000). The folder alone is not enough to check:
# files copied in from another machine, or made by running Haven once
# outside the container, can belong to someone else inside a folder that is
# fine, and then the database or certificate cannot be opened. So the files
# Haven has to open are checked too, and everything is fixed in one pass.
NEEDS_CHOWN=false
for f in "$DATA" "$DATA/haven.db" "$DATA/haven.db-wal" "$DATA/haven.db-shm" "$DATA/.env" \
         "$CERTS" "$CERTS/cert.pem" "$CERTS/key.pem" "$DATA/uploads"; do
  if [ -e "$f" ] && [ "$(stat -c '%u' "$f" 2>/dev/null)" != "1000" ]; then
    NEEDS_CHOWN=true
    break
  fi
done
if [ "$NEEDS_CHOWN" = "true" ]; then
  if ! chown -R node:node "$DATA" 2>/dev/null; then
    echo "⚠️  Could not hand $DATA to the node user (uid 1000 in the container). If Haven"
    echo "   cannot open its database, fix the owner from the host: with Docker,"
    echo "   chown -R 1000:1000 <data folder>; with rootless Podman,"
    echo "   podman unshare chown -R 1000:1000 <data folder>."
  fi
fi

exec gosu node "$@"
