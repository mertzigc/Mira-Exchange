#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-08_fortnox_cron_v1_1"
echo "=== FortnoxCron v1.1 START ==="
echo "[fortnox-cron-v1.1] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
CONNECTION_ID="${FORTNOX_CONNECTION_ID:-1771579463578x385222043661358460}"
DAYS_BACK="${FORTNOX_DAYS_BACK:-7}"

if [[ -z "$API_KEY" ]]; then
  echo "[fortnox-cron-v1.1] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[fortnox-cron-v1.1] HOST=$HOST CONNECTION_ID=$CONNECTION_ID DAYS_BACK=$DAYS_BACK"

curl -sS --max-time 1200 -X POST "$HOST/fortnox/cron/v1" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"connection_id\":\"$CONNECTION_ID\",\"days_back\":$DAYS_BACK,\"customers_pages\":3,\"orders_pages\":5,\"offers_pages\":5,\"invoices_pages\":5,\"order_rows_limit\":40,\"offer_rows_limit\":40}"

echo
echo "=== FortnoxCron v1.1 END ==="
