#!/usr/bin/env bash
set -euo pipefail

# ============================
# Core
# ============================
HOST="${HOST:-https://mira-exchange.onrender.com}"
: "${API_KEY:?Missing API_KEY}"

# ============================
# Sync strategy
# ============================
# Första historiska körningen: 12
# Normal drift: 1
MONTHS_BACK="${MONTHS_BACK:-1}"

# Orders:
#   delta    = senaste ändringar (REKOMMENDERAD default)
#   backfill = betar av historik via orders_next_page
ORDER_MODE="${ORDER_MODE:-delta}"

# ============================
# Customers (masterdata)
# ============================
CUSTOMER_LIMIT="${CUSTOMER_LIMIT:-200}"
CUSTOMER_MAX_PAGES="${CUSTOMER_MAX_PAGES:-1}"     # 1 i nightly, inte full sync
CUSTOMER_PAUSE_MS="${CUSTOMER_PAUSE_MS:-50}"

# ============================
# Orders
# ============================
ORDER_LIMIT="${ORDER_LIMIT:-100}"
ORDER_PAGES_PER_CALL="${ORDER_PAGES_PER_CALL:-3}"
ORDER_PAUSE_MS="${ORDER_PAUSE_MS:-150}"

# ============================
# Offers
# ============================
OFFER_LIMIT="${OFFER_LIMIT:-100}"
OFFER_PAGES_PER_CALL="${OFFER_PAGES_PER_CALL:-1}"
OFFER_PAUSE_MS="${OFFER_PAUSE_MS:-150}"

# ============================
# Invoices
# ============================
INVOICE_LIMIT="${INVOICE_LIMIT:-100}"
INVOICE_PAGES_PER_CALL="${INVOICE_PAGES_PER_CALL:-1}"
INVOICE_PAUSE_MS="${INVOICE_PAUSE_MS:-150}"

# ============================
# Rows (flagged)
# ============================
ROWS_LIMIT="${ROWS_LIMIT:-30}"
ROWS_PASSES="${ROWS_PASSES:-10}"
ROWS_PAUSE_MS="${ROWS_PAUSE_MS:-250}"

echo "========================================"
echo " Fortnox nightly sync START"
echo " HOST=$HOST"
echo " MONTHS_BACK=$MONTHS_BACK"
echo " ORDER_MODE=$ORDER_MODE"
echo "========================================"

curl --no-progress-meter --max-time 43200 \
  "$HOST/fortnox/nightly/run" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"months_back\": ${MONTHS_BACK},

    \"customers\": {
      \"limit\": ${CUSTOMER_LIMIT},
      \"max_pages\": ${CUSTOMER_MAX_PAGES},
      \"pause_ms\": ${CUSTOMER_PAUSE_MS}
    },

    \"orders\": {
      \"mode\": \"${ORDER_MODE}\",
      \"limit\": ${ORDER_LIMIT},
      \"pages_per_call\": ${ORDER_PAGES_PER_CALL},
      \"pause_ms\": ${ORDER_PAUSE_MS}
    },

    \"offers\": {
      \"limit\": ${OFFER_LIMIT},
      \"pages_per_call\": ${OFFER_PAGES_PER_CALL},
      \"pause_ms\": ${OFFER_PAUSE_MS}
    },

    \"invoices\": {
      \"limit\": ${INVOICE_LIMIT},
      \"pages_per_call\": ${INVOICE_PAGES_PER_CALL},
      \"pause_ms\": ${INVOICE_PAUSE_MS}
    },

    \"rows\": {
      \"limit\": ${ROWS_LIMIT},
      \"passes\": ${ROWS_PASSES},
      \"pause_ms\": ${ROWS_PAUSE_MS}
    }
  }" | cat

echo
echo "========================================"
echo " Fortnox nightly sync END"
echo "========================================"
