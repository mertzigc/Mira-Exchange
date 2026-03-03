#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Kör via localhost (undvik Cloudflare 524)
# ─────────────────────────────────────────────
PORT_LOCAL="${PORT:-10000}"
HOST="${HOST:-http://127.0.0.1:${PORT_LOCAL}}"
: "${API_KEY:?Missing API_KEY}"

DOCS_ALLOWLIST="${DOCS_ALLOWLIST:-1771579463578x385222043661358460}"

echo "=== Fortnox MINI nightly START ==="
echo "HOST=$HOST (PORT=$PORT_LOCAL)"

curl -sS --max-time 30 \
  "$HOST/fortnox/nightly/kickoff" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"docs_allowlist\": \"${DOCS_ALLOWLIST}\",
    \"months_back\": 1,

    \"customers\": {
      \"limit\": 50,
      \"max_pages\": 1,
      \"pause_ms\": 0,
      \"skip_without_orgnr\": true,
      \"link_company\": true
    },

    \"orders\": {
      \"mode\": \"delta\",
      \"limit\": 50,
      \"pages_per_call\": 1,
      \"pause_ms\": 100
    },

    \"offers\": {
      \"limit\": 50,
      \"pages_per_call\": 1,
      \"pause_ms\": 0
    },

    \"invoices\": {
      \"limit\": 50,
      \"pages_per_call\": 1,
      \"pause_ms\": 0
    },

    \"rows\": {
      \"limit\": 50,
      \"passes\": 1,
      \"pause_ms\": 0
    }
  }"

echo
echo "=== Fortnox MINI nightly END ==="
