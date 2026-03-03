#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Render cron: använd localhost för att undvika Cloudflare 524
# Om du vill köra utifrån (din Mac), kan du exporta HOST manuellt
# ─────────────────────────────────────────────────────────────
PORT_LOCAL="${PORT:-10000}"
HOST="${HOST:-http://127.0.0.1:${PORT_LOCAL}}"
: "${API_KEY:?Missing API_KEY}"

# Snäv nightly: senaste dygnet/månaden (du kan justera)
MONTHS_BACK="${MONTHS_BACK:-1}"

# Vilken connection som får köra orders/offers (Food & Event)
DOCS_ALLOWLIST="${DOCS_ALLOWLIST:-1771579463578x385222043661358460}"

# ─────────────────────────────────────────────────────────────
# SNÄV NIGHTLY DEFAULTS (för att bli snabb)
# - Customers: 0 sidor (skippa) eller 1 sida om du vill
# - Orders: delta, 1 page
# - Offers: 0 (skippa)
# - Invoices: 1 page (eller 0 om du vill skippa)
# - Rows: 0 passes (skippa)
# ─────────────────────────────────────────────────────────────

# Customers
CUSTOMER_LIMIT="${CUSTOMER_LIMIT:-200}"
CUSTOMER_MAX_PAGES="${CUSTOMER_MAX_PAGES:-0}"   # 0 = skippa customers nightly
CUSTOMER_PAUSE_MS="${CUSTOMER_PAUSE_MS:-0}"

# Orders
ORDER_LIMIT="${ORDER_LIMIT:-100}"
ORDER_PAGES_PER_CALL="${ORDER_PAGES_PER_CALL:-1}"
ORDER_PAUSE_MS="${ORDER_PAUSE_MS:-150}"
ORDER_MODE="${ORDER_MODE:-delta}"

# Offers
OFFER_LIMIT="${OFFER_LIMIT:-50}"
OFFER_PAGES_PER_CALL="${OFFER_PAGES_PER_CALL:-0}"  # 0 = skippa offers nightly
OFFER_PAUSE_MS="${OFFER_PAUSE_MS:-0}"

# Invoices
INVOICE_LIMIT="${INVOICE_LIMIT:-50}"
INVOICE_PAGES_PER_CALL="${INVOICE_PAGES_PER_CALL:-1}" # 1 sida nightly
INVOICE_PAUSE_MS="${INVOICE_PAUSE_MS:-0}"

# Rows (flagged)
ROWS_LIMIT="${ROWS_LIMIT:-30}"
ROWS_PASSES="${ROWS_PASSES:-0}"   # 0 = skippa rows nightly
ROWS_PAUSE_MS="${ROWS_PAUSE_MS:-0}"

echo "=== Fortnox nightly sync START ==="
echo "HOST=$HOST (PORT_LOCAL=$PORT_LOCAL) MONTHS_BACK=$MONTHS_BACK ORDER_MODE=$ORDER_MODE DOCS_ALLOWLIST=$DOCS_ALLOWLIST"

# Viktigt:
# - Om HOST är localhost behöver du INTE oroa dig för Cloudflare/524.
# - max-time kan vara högt utan att HTTP-klipps externt.
curl -sS --max-time 43200 \
  "$HOST/fortnox/nightly/run" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"docs_allowlist\": \"${DOCS_ALLOWLIST}\",
    \"months_back\": ${MONTHS_BACK},

    \"customers\": {\"limit\": ${CUSTOMER_LIMIT}, \"max_pages\": ${CUSTOMER_MAX_PAGES}, \"pause_ms\": ${CUSTOMER_PAUSE_MS}},
    \"orders\": {\"mode\": \"${ORDER_MODE}\", \"limit\": ${ORDER_LIMIT}, \"pages_per_call\": ${ORDER_PAGES_PER_CALL}, \"pause_ms\": ${ORDER_PAUSE_MS}},
    \"offers\": {\"limit\": ${OFFER_LIMIT}, \"pages_per_call\": ${OFFER_PAGES_PER_CALL}, \"pause_ms\": ${OFFER_PAUSE_MS}},
    \"invoices\": {\"limit\": ${INVOICE_LIMIT}, \"pages_per_call\": ${INVOICE_PAGES_PER_CALL}, \"pause_ms\": ${INVOICE_PAUSE_MS}},
    \"rows\": {\"limit\": ${ROWS_LIMIT}, \"passes\": ${ROWS_PASSES}, \"pause_ms\": ${ROWS_PAUSE_MS}}
  }" | cat

echo
echo "=== Fortnox nightly sync END ==="
