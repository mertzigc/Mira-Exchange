#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"

# Första natten: 12. Efter första natten: ändra i Render env till t.ex. 2 (eller 1).
MONTHS_BACK="${MONTHS_BACK:-12}"

# Tempo – invoices i portioner
INVOICE_LIMIT="${INVOICE_LIMIT:-200}"
INVOICE_PAGES_PER_CALL="${INVOICE_PAGES_PER_CALL:-5}"
INVOICE_PAUSE_MS="${INVOICE_PAUSE_MS:-150}"

# Customers – masterdata
CUSTOMER_LIMIT="${CUSTOMER_LIMIT:-500}"
CUSTOMER_MAX_PAGES="${CUSTOMER_MAX_PAGES:-30}"
CUSTOMER_PAUSE_MS="${CUSTOMER_PAUSE_MS:-50}"

# Orders
ORDER_LIMIT="${ORDER_LIMIT:-200}"
ORDER_PAGES_PER_CALL="${ORDER_PAGES_PER_CALL:-5}"
ORDER_PAUSE_MS="${ORDER_PAUSE_MS:-150}"

# Offers
OFFER_LIMIT="${OFFER_LIMIT:-200}"
OFFER_PAGES_PER_CALL="${OFFER_PAGES_PER_CALL:-5}"
OFFER_PAUSE_MS="${OFFER_PAUSE_MS:-150}"

# Rows (flagged)
ROWS_LIMIT="${ROWS_LIMIT:-30}"
ROWS_PASSES="${ROWS_PASSES:-20}"
ROWS_PAUSE_MS="${ROWS_PAUSE_MS:-250}"

echo "=== Fortnox nightly sync START ==="
echo "HOST=$HOST MONTHS_BACK=$MONTHS_BACK"

curl -sS --max-time 43200 \
  "$HOST/fortnox/nightly/run" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"months_back\": $MONTHS_BACK,

    \"customers\": {\"limit\": $CUSTOMER_LIMIT, \"max_pages\": $CUSTOMER_MAX_PAGES, \"pause_ms\": $CUSTOMER_PAUSE_MS},

    \"orders\": {\"limit\": $ORDER_LIMIT, \"max_pages\": $ORDER_PAGES_PER_CALL, \"pause_ms\": $ORDER_PAUSE_MS},
    \"offers\": {\"limit\": $OFFER_LIMIT, \"max_pages\": $OFFER_PAGES_PER_CALL, \"pause_ms\": $OFFER_PAUSE_MS},

    \"invoices\": {\"limit\": $INVOICE_LIMIT, \"max_pages\": $INVOICE_PAGES_PER_CALL, \"pause_ms\": $INVOICE_PAUSE_MS},

    \"rows\": {\"limit\": $ROWS_LIMIT, \"passes\": $ROWS_PASSES, \"pause_ms\": $ROWS_PAUSE_MS}
  }" | cat

echo
echo "=== Fortnox nightly sync END ==="
