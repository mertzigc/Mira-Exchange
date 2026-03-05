#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY}"

echo "Starting Fortnox nightly sync"

curl -sS -X POST "$HOST/fortnox/nightly/run" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'

echo "Nightly triggered"
