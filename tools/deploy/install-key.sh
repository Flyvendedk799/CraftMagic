#!/usr/bin/env bash
#
# Install the Anthropic key into the deployed .env and restart.
#
# Separate from remote-setup.sh because it is a one-off with a different risk profile: the
# deploy script must never carry a secret, so a redeploy can never accidentally rotate or
# clobber one. The key arrives in a file, never in argv, since argv is readable through /proc.
#
# Usage: sudo bash install-key.sh <key-file>
set -euo pipefail

KEY_FILE="$1"
APP_DIR=/opt/craftmagic
ENV_FILE="$APP_DIR/.env"

if [ ! -s "$KEY_FILE" ]; then
  echo "key file is empty or missing" >&2
  exit 1
fi

KEY_LINE=$(grep -m1 '^ANTHROPIC_API_KEY=' "$KEY_FILE" || true)
if [ -z "$KEY_LINE" ]; then
  echo "no ANTHROPIC_API_KEY= line in the key file" >&2
  exit 1
fi

cp "$ENV_FILE" "$ENV_FILE.bak"

# Drop the note explaining why the key was absent, and any previous key, so the file does not
# end up self-contradictory or with two competing values (the last one would silently win).
grep -v '^ANTHROPIC_API_KEY=' "$ENV_FILE" \
  | grep -v 'is intentionally absent until' \
  | grep -v 'generate route returns 503' > "$ENV_FILE.new"

printf '%s\n' "$KEY_LINE" >> "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"
chown craftmagic:craftmagic "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Confirm the shape without ever printing the value.
if grep -q '^ANTHROPIC_API_KEY=sk-ant-' "$ENV_FILE"; then
  echo "key installed (length $(grep -m1 '^ANTHROPIC_API_KEY=' "$ENV_FILE" | cut -d= -f2- | wc -c) chars)"
else
  echo "key line does not look like an Anthropic key — restoring backup" >&2
  mv "$ENV_FILE.bak" "$ENV_FILE"
  exit 1
fi
rm -f "$ENV_FILE.bak"

systemctl restart craftmagic

for i in $(seq 1 45); do
  if curl -fsS --max-time 3 http://127.0.0.1:3016/api/health >/dev/null 2>&1; then
    echo "healthy after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "did not become healthy:" >&2
journalctl -u craftmagic -n 30 --no-pager >&2
exit 1
