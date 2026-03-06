#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-06_fortnox_cron_v1"
echo "=== FortnoxCron v1 START ==="
echo "[fortnox-cron-v1] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
CONNECTION_ID="${FORTNOX_CONNECTION_ID:-1771579463578x385222043661358460}"
DAYS_BACK="${FORTNOX_DAYS_BACK:-7}"

if [[ -z "$API_KEY" ]]; then
  echo "[fortnox-cron-v1] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[fortnox-cron-v1] HOST=$HOST CONNECTION_ID=$CONNECTION_ID DAYS_BACK=$DAYS_BACK"

curl -sS --max-time 600 -X POST "$HOST/fortnox/cron/v1" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"connection_id\":\"$CONNECTION_ID\",\"days_back\":$DAYS_BACK}"

echo
echo "=== FortnoxCron v1 END ==="
