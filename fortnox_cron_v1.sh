#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-08_fortnox_cron_v1_1_multi"
echo "=== FortnoxCron v1.1 multi START ==="
echo "[fortnox-cron-v1.1-multi] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
DAYS_BACK="${FORTNOX_DAYS_BACK:-7}"

if [[ -z "$API_KEY" ]]; then
  echo "[fortnox-cron-v1.1-multi] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[fortnox-cron-v1.1-multi] HOST=$HOST DAYS_BACK=$DAYS_BACK"

curl -sS --max-time 1800 -X POST "$HOST/fortnox/cron/v1" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"days_back\":14,\"customers_pages\":2,\"orders_pages\":3,\"offers_pages\":3,\"invoices_pages\":5,\"order_rows_limit\":20,\"offer_rows_limit\":20}"

echo
echo "=== FortnoxCron v1.1 multi END ==="
