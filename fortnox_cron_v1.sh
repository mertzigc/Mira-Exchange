#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-04-21_fortnox_cron_v1_2_articles"
echo "=== FortnoxCron v1.2 articles START ==="
echo "[fortnox-cron-v1.2] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
DAYS_BACK="${FORTNOX_DAYS_BACK:-7}"

if [[ -z "$API_KEY" ]]; then
  echo "[fortnox-cron-v1.2] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[fortnox-cron-v1.2] HOST=$HOST DAYS_BACK=$DAYS_BACK"

# ── Steg 1: orders, offers, invoices, customers (oförändrat) ──────────────────
echo ""
echo "[fortnox-cron-v1.2] Step 1: orders/offers/invoices/customers..."
curl -sS --max-time 1800 -X POST "$HOST/fortnox/cron/v1" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"days_back\":14,\"customers_pages\":2,\"orders_pages\":3,\"offers_pages\":3,\"invoices_pages\":5,\"order_rows_limit\":20,\"offer_rows_limit\":20}"

echo ""
echo "[fortnox-cron-v1.2] Step 1 done."

# ── Steg 2: artiklar – alla connections, alla sidor ───────────────────────────
# connection_ids som ska synkas (komma-separerade, utan mellanslag)
# Läs från env FORTNOX_CONNECTION_IDS om satt, annars använd hårdkodad default
CONNECTIONS="${FORTNOX_CONNECTION_IDS:-1771579463578x385222043661358460}"

echo ""
echo "[fortnox-cron-v1.2] Step 2: articles sync for connections: $CONNECTIONS"

IFS=',' read -ra CONN_ARRAY <<< "$CONNECTIONS"
for CONN_ID in "${CONN_ARRAY[@]}"; do
  CONN_ID="$(echo "$CONN_ID" | tr -d '[:space:]')"
  echo "[fortnox-cron-v1.2] Syncing articles for connection: $CONN_ID"

  curl -sS --max-time 900 -X POST "$HOST/fortnox/upsert/articles/all" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN_ID\",\"fortnox_connection_bubble_id\":\"$CONN_ID\",\"limit\":100,\"max_pages\":50,\"pause_ms\":200}"

  echo ""
  echo "[fortnox-cron-v1.2] Articles done for: $CONN_ID"
done

echo ""
# Steg 3: Bygg analytics-cache för dashboard
echo ""
echo "[fortnox-cron-v1.2] Step 3: analytics refresh..."
curl -sS --max-time 300 -X POST "$HOST/analytics/articles/refresh" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{}"
echo ""
echo "[fortnox-cron-v1.2] Analytics refresh done."
echo "=== FortnoxCron v1.2 articles END ==="
