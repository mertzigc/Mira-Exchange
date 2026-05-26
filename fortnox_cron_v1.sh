#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-05-26_fortnox_cron_v1_3_balance_pdf"
echo "=== FortnoxCron v1.3 (balance+pdf) START ==="
echo "[fortnox-cron-v1.3] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
DAYS_BACK="${FORTNOX_DAYS_BACK:-14}"
MODIFIED_DAYS_BACK="${FORTNOX_MODIFIED_DAYS_BACK:-120}"   # saldo-sveep: hur långt bak vi tittar på ÄNDRINGAR
PDF_LIMIT="${FORTNOX_PDF_LIMIT:-50}"                      # antal saknade PDF:er per connection och körning

if [[ -z "$API_KEY" ]]; then
  echo "[fortnox-cron-v1.3] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[fortnox-cron-v1.3] HOST=$HOST DAYS_BACK=$DAYS_BACK MODIFIED_DAYS_BACK=$MODIFIED_DAYS_BACK"

# ── Steg 1: orders/offers/invoices/customers (OFÖRÄNDRAT) ─────────────────────
echo ""
echo "[fortnox-cron-v1.3] Step 1: orders/offers/invoices/customers..."
curl -sS --max-time 1800 -X POST "$HOST/fortnox/cron/v1" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"days_back\":$DAYS_BACK,\"customers_pages\":2,\"orders_pages\":3,\"offers_pages\":3,\"invoices_pages\":5,\"order_rows_limit\":20,\"offer_rows_limit\":20}"
echo ""
echo "[fortnox-cron-v1.3] Step 1 done."

# ── Steg 1b: SALDO-SVEEP – fånga fakturor som ÄNDRATS (t.ex. betalats) ────────
# Detta uppdaterar ft_balance på äldre fakturor som faller utanför Steg 1:s
# fakturadatum-fönster. Utan detta blir "utestående saldo" inaktuellt.
echo ""
echo "[fortnox-cron-v1.3] Step 1b: invoices modified-sweep (balance freshness)..."
curl -sS --max-time 1800 -X POST "$HOST/fortnox/sync/invoices/modified" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"days_back\":$MODIFIED_DAYS_BACK,\"limit\":200,\"max_pages\":25}"
echo ""
echo "[fortnox-cron-v1.3] Step 1b done."

# ── Steg 1c: FAKTURA-PDF – hämta PDF för fakturor som saknar ft_pdf ───────────
# Bundet antal per körning; backfillar över tid. KRÄVER ft_pdf-fält på FortnoxInvoice.
echo ""
echo "[fortnox-cron-v1.3] Step 1c: invoice PDF enrich (limit=$PDF_LIMIT/connection)..."
curl -sS --max-time 1800 -X POST "$HOST/fortnox/enrich/invoice-pdfs" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"limit\":$PDF_LIMIT,\"pause_ms\":400,\"pdf_path\":\"preview\"}"
echo ""
echo "[fortnox-cron-v1.3] Step 1c done."

# ── Steg 2: artiklar – alla connections, alla sidor (OFÖRÄNDRAT) ──────────────
CONNECTIONS="${FORTNOX_CONNECTION_IDS:-1771579463578x385222043661358460}"
echo ""
echo "[fortnox-cron-v1.3] Step 2: articles sync for connections: $CONNECTIONS"
IFS=',' read -ra CONN_ARRAY <<< "$CONNECTIONS"
for CONN_ID in "${CONN_ARRAY[@]}"; do
  CONN_ID="$(echo "$CONN_ID" | tr -d '[:space:]')"
  echo "[fortnox-cron-v1.3] Syncing articles for connection: $CONN_ID"
  curl -sS --max-time 900 -X POST "$HOST/fortnox/upsert/articles/all" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN_ID\",\"fortnox_connection_bubble_id\":\"$CONN_ID\",\"filter\":\"active\",\"limit\":100,\"max_pages\":50,\"pause_ms\":500}"
  echo ""
  echo "[fortnox-cron-v1.3] Articles done for: $CONN_ID"
done

# ── Steg 3: analytics-cache för dashboard (OFÖRÄNDRAT) ────────────────────────
echo ""
echo "[fortnox-cron-v1.3] Step 3: analytics refresh..."
curl -sS --max-time 300 -X POST "$HOST/analytics/articles/refresh" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{}"
echo ""
echo "[fortnox-cron-v1.3] Analytics refresh done."
echo "=== FortnoxCron v1.3 (balance+pdf) END ==="
