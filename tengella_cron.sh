#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"

# Samma mönster som Fortnox
API_KEY="${API_KEY:?Missing API_KEY}"
SYNC_SECRET="${SYNC_SECRET:?Missing SYNC_SECRET}"

# En tenant => defaulta till env eller hårdkodad fallback
ORGNO="${TENGELLA_ORGNO:-746-0509}"

echo "=== Tengella nightly sync START ==="
echo "HOST=$HOST ORGNO=$ORGNO"

echo "--- Preflight: /tengella/debug-env (x-api-key only) ---"
curl -sS --max-time 60 \
  "$HOST/tengella/debug-env" \
  -H "x-api-key: $API_KEY" \
  | cat
echo
echo

echo "--- Preflight: /tengella/auth/test (x-api-key only) ---"
curl -sS --max-time 60 \
  -X POST "$HOST/tengella/auth/test" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  | cat
echo
echo

echo "--- Run: /tengella/cron (x-api-key + X-Sync-Secret) ---"
curl -sS --max-time 43200 \
  -X POST "$HOST/tengella/cron" \
  -H "x-api-key: $API_KEY" \
  -H "X-Sync-Secret: $SYNC_SECRET" \
  -H "Content-Type: application/json" \
  -d "{
    \"orgNo\": \"$ORGNO\"
  }" \
  | cat
echo
echo "=== Tengella nightly sync END ==="
