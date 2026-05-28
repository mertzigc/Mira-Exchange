#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-05-28_fortnox_cron_v1_4_pdf_split_tengella"
echo "=== FortnoxCron v1.4 (pdf-split + tengella) START ==="
echo "[cron-v1.4] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
DAYS_BACK="${FORTNOX_DAYS_BACK:-14}"
MODIFIED_DAYS_BACK="${FORTNOX_MODIFIED_DAYS_BACK:-30}"   # saldo-sveep, steady state (sänkt från 120)
PDF_LIMIT="${FORTNOX_PDF_LIMIT:-50}"                     # Fortnox-PDF per connection och natt

# Fortnox-native connections som HAR utskrivbar PDF i Fortnox (EJ Housekeeping).
# F&E, Staff, Carotte Group. Housekeeping (Tengella) hanteras i Steg 1d.
PDF_CONNECTION_IDS="${FORTNOX_PDF_CONNECTION_IDS:-1771579463578x385222043661358460,1771579472595x998707043537409700,1771579485842x995491391876972200}"

# Fönster för PDF-enrich (fakturadatum). Håller nattjobbet till NYA fakturor så
# äldre fakturor utan PDF inte retrias varje natt. GNU date (Render) + BSD-fallback.
PDF_SINCE="$(date -u -d '90 days ago' +%Y-%m-%dT00:00:00.000Z 2>/dev/null || date -u -v-90d +%Y-%m-%dT00:00:00.000Z)"

if [[ -z "$API_KEY" ]]; then
  echo "[cron-v1.4] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[cron-v1.4] HOST=$HOST DAYS_BACK=$DAYS_BACK MODIFIED_DAYS_BACK=$MODIFIED_DAYS_BACK PDF_SINCE=$PDF_SINCE"

# ── Steg 1: orders/offers/invoices/customers (OFÖRÄNDRAT) ─────────────────────
echo ""
echo "[cron-v1.4] Step 1: orders/offers/invoices/customers..."
curl -sS --max-time 1800 -X POST "$HOST/fortnox/cron/v1" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"days_back\":$DAYS_BACK,\"customers_pages\":2,\"orders_pages\":3,\"offers_pages\":3,\"invoices_pages\":5,\"order_rows_limit\":20,\"offer_rows_limit\":20}"
echo ""
echo "[cron-v1.4] Step 1 done."

# ── Steg 1b: SALDO-SVEEP – fakturor som ÄNDRATS (t.ex. betalats) ──────────────
echo ""
echo "[cron-v1.4] Step 1b: invoices modified-sweep (balance freshness)..."
curl -sS --max-time 1800 -X POST "$HOST/fortnox/sync/invoices/modified" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"all_connections\":true,\"days_back\":$MODIFIED_DAYS_BACK,\"limit\":200,\"max_pages\":25}"
echo ""
echo "[cron-v1.4] Step 1b done."

# ── Steg 1c: FORTNOX-PDF – per connection, EJ Housekeeping ────────────────────
# Housekeeping-fakturor saknar utskrivbar PDF i Fortnox (Tengella-importerade),
# så vi kör BARA de Fortnox-native connectionsna här. Annars 404 varje natt.
echo ""
echo "[cron-v1.4] Step 1c: Fortnox PDF-enrich (preview) – native connections, since=$PDF_SINCE"
IFS=',' read -ra PDF_CONN_ARRAY <<< "$PDF_CONNECTION_IDS"
for CID in "${PDF_CONN_ARRAY[@]}"; do
  CID="$(echo "$CID" | tr -d '[:space:]')"
  [[ -z "$CID" ]] && continue
  echo "[cron-v1.4]   PDF-enrich connection: $CID"
  curl -sS --max-time 1800 -X POST "$HOST/fortnox/enrich/invoice-pdfs" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CID\",\"limit\":$PDF_LIMIT,\"pause_ms\":400,\"pdf_path\":\"preview\",\"since_invoice_date\":\"$PDF_SINCE\"}"
  echo ""
done
echo "[cron-v1.4] Step 1c done."

# ── Steg 1d: TENGELLA-PDF – Housekeeping ─────────────────────────────────────
# Berikar ft_pdf för Housekeeping från Tengella (/v2/Invoices/{InvoiceId}.Url).
# Idempotent: redan ifyllda hoppas över. Rör BARA ft_pdf – aldrig belopp/saldo
# (Fortnox förblir källan för det). max_enrich bundet som skydd mot långkörning.
echo ""
echo "[cron-v1.4] Step 1d: Tengella PDF-enrich (Housekeeping)..."
curl -sS --max-time 1800 -X POST "$HOST/tengella/enrich/invoice-pdfs" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pause_ms\":150,\"max_enrich\":300}"
echo ""
echo "[cron-v1.4] Step 1d done."

# ── Steg 2: artiklar – alla connections, alla sidor (OFÖRÄNDRAT) ──────────────
CONNECTIONS="${FORTNOX_CONNECTION_IDS:-1771579463578x385222043661358460}"
echo ""
echo "[cron-v1.4] Step 2: articles sync for connections: $CONNECTIONS"
IFS=',' read -ra CONN_ARRAY <<< "$CONNECTIONS"
for CONN_ID in "${CONN_ARRAY[@]}"; do
  CONN_ID="$(echo "$CONN_ID" | tr -d '[:space:]')"
  echo "[cron-v1.4] Syncing articles for connection: $CONN_ID"
  curl -sS --max-time 900 -X POST "$HOST/fortnox/upsert/articles/all" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN_ID\",\"fortnox_connection_bubble_id\":\"$CONN_ID\",\"filter\":\"active\",\"limit\":100,\"max_pages\":50,\"pause_ms\":500}"
  echo ""
  echo "[cron-v1.4] Articles done for: $CONN_ID"
done

# ── Steg 3: analytics-cache för dashboard (OFÖRÄNDRAT) ────────────────────────
echo ""
echo "[cron-v1.4] Step 3: analytics refresh..."
curl -sS --max-time 300 -X POST "$HOST/analytics/articles/refresh" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{}"
echo ""
echo "[cron-v1.4] Analytics refresh done."
echo "=== FortnoxCron v1.4 (pdf-split + tengella) END ==="
