#!/usr/bin/env bash
set -euo pipefail

HOST="https://mira-exchange.onrender.com"
CID="${FORTNOX_CONNECTION_ID:?Missing FORTNOX_CONNECTION_ID}"
APIKEY="${MIRA_RENDER_API_KEY:?Missing MIRA_RENDER_API_KEY}"

# 1) Hämta TotalResources (med limit=1)
TOTAL_RESOURCES=$(
  curl -sS "$HOST/fortnox/sync/offers" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $APIKEY" \
    -d "{\"connection_id\":\"$CID\",\"page\":1,\"limit\":1}" \
  | python3 -c 'import sys, json; j=json.load(sys.stdin); print(j["meta"]["@TotalResources"])'
)

# 2) Räkna ut sista sidan för limit=100
LAST_PAGE=$(
  python3 -c "import math; print(math.ceil(int('$TOTAL_RESOURCES')/100))"
)

echo "[offers-10min] total_resources=$TOTAL_RESOURCES last_page=$LAST_PAGE"

# 3) Upsert sista sidan (senaste) + hämta PDF för max 20 saknade
curl -sS "$HOST/fortnox/upsert/offers" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $APIKEY" \
  -d "{
    \"connection_id\": \"$CID\",
    \"page\": $LAST_PAGE,
    \"limit\": 100,
    \"fetch_pdf\": true,
    \"pdf_missing_only\": true,
    \"pdf_max_per_page\": 20,
    \"pdf_pause_ms\": 500
  }"

echo
echo "[offers-10min] done"
