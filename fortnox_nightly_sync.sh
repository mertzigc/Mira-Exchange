#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"
CONN_ID="${CONN_ID:?Missing CONN_ID}"

# Första natten: 12 månader. Efter första natten: sätt MONTHS_BACK=2 (eller 1) i Cron-jobbets env.
MONTHS_BACK="${MONTHS_BACK:-12}"

# Tempo – invoices i portioner (undviker timeout)
INVOICE_LIMIT="${INVOICE_LIMIT:-200}"              # 200 fakturor per sida
INVOICE_PAGES_PER_CALL="${INVOICE_PAGES_PER_CALL:-5}"  # 5 sidor per request
INVOICE_PAUSE_MS="${INVOICE_PAUSE_MS:-150}"

# Tempo – orders i portioner (undviker timeout)
ORDER_LIMIT="${ORDER_LIMIT:-100}"                  # 100 orders per sida
ORDER_PAGES_PER_CALL="${ORDER_PAGES_PER_CALL:-5}"  # 5 sidor per request
ORDER_PAUSE_MS="${ORDER_PAUSE_MS:-150}"

# Tempo – offers i portioner (undviker timeout)
OFFER_LIMIT="${OFFER_LIMIT:-100}"                  # 100 offers per sida
OFFER_PAGES_PER_CALL="${OFFER_PAGES_PER_CALL:-5}"  # 5 sidor per request
OFFER_PAUSE_MS="${OFFER_PAUSE_MS:-150}"

# Customers – kör hela varje natt (med hög limit blir det få sidor)
CUSTOMER_LIMIT="${CUSTOMER_LIMIT:-500}"            # max 500
CUSTOMER_MAX_PAGES="${CUSTOMER_MAX_PAGES:-30}"
CUSTOMER_PAUSE_MS="${CUSTOMER_PAUSE_MS:-50}"

echo "=== Fortnox nightly sync START ==="
echo "HOST=$HOST CONN_ID=$CONN_ID MONTHS_BACK=$MONTHS_BACK"

# 1) Customers (hela listan varje natt)
echo "=== Customers/all ==="
curl -sS --max-time 1800 \
  "$HOST/fortnox/upsert/customers/all" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"connection_id\":\"$CONN_ID\",\"start_page\":1,\"limit\":$CUSTOMER_LIMIT,\"max_pages\":$CUSTOMER_MAX_PAGES,\"pause_ms\":$CUSTOMER_PAUSE_MS,\"skip_without_orgnr\":true,\"link_company\":true}" \
| tee /tmp/customers.json
echo

# 2) Orders (portioner)
curl -sS --max-time 1800 "$HOST/fortnox/upsert/orders/all" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"connection_id\":\"$CONN_ID\",\"start_page\":1,\"limit\":$ORDER_LIMIT,\"months_back\":$MONTHS_BACK,\"max_pages\":$ORDER_PAGES_PER_CALL,\"pause_ms\":$ORDER_PAUSE_MS}"

# 3) Offers (portioner)
curl -sS --max-time 1800 "$HOST/fortnox/upsert/offers/all" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"connection_id\":\"$CONN_ID\",\"start_page\":1,\"limit\":$OFFER_LIMIT,\"months_back\":$MONTHS_BACK,\"max_pages\":$OFFER_PAGES_PER_CALL,\"pause_ms\":$OFFER_PAUSE_MS}"
# 2) Invoices (loopa tills done=true)
echo "=== Invoices/all loop ==="
start_page=1
safety=0

while true; do
  resp="$(curl -sS --max-time 1800 \
    "$HOST/fortnox/upsert/invoices/all" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN_ID\",\"start_page\":$start_page,\"limit\":$INVOICE_LIMIT,\"months_back\":$MONTHS_BACK,\"max_pages\":$INVOICE_PAGES_PER_CALL,\"pause_ms\":$INVOICE_PAUSE_MS}")"

  echo "$resp" | tee /tmp/invoices_last.json
  echo

  doneFlag="$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(String(!!j.done));' "$resp")"
  if [ "$doneFlag" = "true" ]; then
    echo "✅ Invoices done."
    break
  fi

  nextPage="$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.next_page||0));' "$resp")"
  if [ "$nextPage" = "0" ]; then
    echo "⚠️ No next_page returned. Stopping."
    break
  fi

  start_page="$nextPage"
  safety=$((safety+1))
  if [ "$safety" -ge 500 ]; then
    echo "⚠️ Safety stop (too many loops)."
    break
  fi
done

echo "=== Fortnox nightly sync END ==="
