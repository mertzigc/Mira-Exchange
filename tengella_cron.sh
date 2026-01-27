#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://mira-exchange.onrender.com}"
ORGNO="${TENGELLA_ORGNO:-746-0509}"

if [[ -z "${API_KEY:-}" ]]; then
  echo "Missing env: API_KEY" >&2
  exit 1
fi

if [[ -z "${SYNC_SECRET:-}" ]]; then
  echo "Missing env: SYNC_SECRET" >&2
  exit 1
fi

curl -sS -X POST "${BASE_URL}/tengella/cron" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -H "X-Sync-Secret: ${SYNC_SECRET}" \
  --data "{\"orgNo\":\"${ORGNO}\"}"
echo
