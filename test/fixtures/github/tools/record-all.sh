#!/usr/bin/env bash
# Owned by Mandaar. One command to record every GitHub fixture.
#
#   bash test/fixtures/github/tools/record-all.sh
#
# Reads GITHUB_TOKEN and REVIEWER_TOKEN from the environment or from .env (git-ignored).
# Uses a fresh smee channel unless WEBHOOK_URL is set.
set -euo pipefail
cd "$(dirname "$0")/../../../.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${GITHUB_TOKEN:?Set GITHUB_TOKEN (your account, admin on the test repo)}"
: "${REVIEWER_TOKEN:?Set REVIEWER_TOKEN (a teammate with access to the test repo)}"

if [ -z "${FIXTURE_WEBHOOK_URL:-}" ]; then
  FIXTURE_WEBHOOK_URL=$(curl -s -o /dev/null -w '%{redirect_url}' https://smee.io/new)
fi
echo "smee channel: $FIXTURE_WEBHOOK_URL"

LOG_DIR=$(mktemp -d)
npx tsx test/fixtures/github/tools/capture-webhooks.ts > "$LOG_DIR/capture.log" 2>&1 &
CAPTURE=$!
npx --yes smee-client --url "$FIXTURE_WEBHOOK_URL" --target "http://localhost:${CAPTURE_PORT:-3009}" > "$LOG_DIR/smee.log" 2>&1 &
SMEE=$!
trap 'kill $CAPTURE $SMEE 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  grep -q Forwarding "$LOG_DIR/smee.log" 2>/dev/null && grep -q Capturing "$LOG_DIR/capture.log" && break
  sleep 1
done

WEBHOOK_URL="$FIXTURE_WEBHOOK_URL" npx tsx test/fixtures/github/tools/trigger-events.ts
sleep 10 # last deliveries

echo "---- recorder log"
cat "$LOG_DIR/capture.log"
npx vitest run test/fixtures/github
