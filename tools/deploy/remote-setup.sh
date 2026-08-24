#!/usr/bin/env bash
#
# Install/refresh ImagineCraft on the VPS. Runs as root via sudo.
#
# Everything here is idempotent: it is run on every deploy, not just the first. The one thing
# it deliberately never overwrites is .env — secrets are generated once and then left alone,
# so a redeploy cannot silently invalidate every live session cookie or rotate a key that the
# running mods are authenticated against.
#
# Usage: sudo bash remote-setup.sh <tarball> <db-password-file>
#
# The password arrives in a file rather than argv because argv is world-readable through
# /proc for as long as the process lives.
set -euo pipefail

TARBALL="$1"
DB_PASSWORD=$(cat "$2")

APP_DIR=/opt/imaginecraft
SERVICE=imaginecraft
PORT=3016
DB_PORT=54328
RUN_USER=imaginecraft

# --- user -------------------------------------------------------------------------------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  echo "created service user $RUN_USER"
fi

# --- code -------------------------------------------------------------------------------
mkdir -p "$APP_DIR"

# Replace the shipped trees wholesale rather than merging into them. tar would happily leave
# a file behind that the new build no longer emits, and a stale dist/ file that still parses
# is the kind of thing that only surfaces as a confusing runtime error days later.
rm -rf "$APP_DIR/apps/server/dist" "$APP_DIR/apps/web/dist" "$APP_DIR/packages/core/dist"
tar xzf "$TARBALL" -C "$APP_DIR"

# --- dependencies -----------------------------------------------------------------------
# `npm ci` against the shipped lockfile: reproducible, and it fetches the linux-x64 argon2
# prebuild rather than the win32 binary that would come from copying node_modules.
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

# --- configuration ----------------------------------------------------------------------
if [ ! -f "$APP_DIR/.env" ]; then
  SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=${PORT}
HOST=0.0.0.0
PUBLIC_ORIGIN=http://85.190.100.23:${PORT}
DATABASE_URL=postgres://imaginecraft:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/imaginecraft
SESSION_SECRET=${SESSION_SECRET}
ANTHROPIC_MONTHLY_BUDGET_USD=4
LOG_LEVEL=info
# ANTHROPIC_API_KEY is intentionally absent until the app requires a login. Without it the
# generate route returns 503 and the rest of the site works, so an open port cannot spend money.
EOF
  echo "wrote a fresh .env"
else
  echo "kept the existing .env"
fi
chmod 600 "$APP_DIR/.env"

# The spend ledger is the only thing the app writes, and systemd's ProtectSystem=strict makes
# everything else read-only, so this directory is the whole writable surface of the service.
mkdir -p "$APP_DIR/.spend"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# --- service ----------------------------------------------------------------------------
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=ImagineCraft — AI Minecraft structure builder
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/.spend
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# --- verify -----------------------------------------------------------------------------
echo "waiting for /api/health…"
for i in $(seq 1 45); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/tmp/ic-health.json 2>/dev/null; then
    echo "healthy after ${i}s:"
    cat /tmp/ic-health.json
    echo
    exit 0
  fi
  sleep 1
done

echo "did not become healthy — last 40 log lines:" >&2
journalctl -u "$SERVICE" -n 40 --no-pager >&2
exit 1
