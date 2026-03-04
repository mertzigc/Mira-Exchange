#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-04_lastmodified_nopage_v1"
echo "[offers-10min] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
CID="${FORTNOX_CONNECTION_ID:-${DOCS_ALLOWLIST:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "[offers-10min] ERROR: Missing env MIRA_RENDER_API_KEY" >&2
  exit 2
fi
if [[ -z "$CID" ]]; then
  echo "[offers-10min] ERROR: Missing env FORTNOX_CONNECTION_ID (or DOCS_ALLOWLIST)" >&2
  exit 2
fi

# Fortnox "lastmodified": kör senaste 15 minuterna (UTC), format: YYYY-MM-DD HH:MM
LASTMODIFIED="$(date -u -d '15 minutes ago' '+%Y-%m-%d %H:%M')"
echo "[offers-10min] host=$HOST cid=$CID lastmodified='$LASTMODIFIED'"

# En enda call. Ingen pagination-beräkning.
curl -sS --max-time 60 -X POST "$HOST/fortnox/upsert/offers" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"connection_id\":\"$CID\",
    \"page\": 1,
    \"limit\": 500,
    \"lastmodified\":\"$LASTMODIFIED\",
    \"fetch_pdf\": true,
    \"pdf_missing_only\": true,
    \"pdf_max_per_page\": 20,
    \"pdf_pause_ms\": 500
  }"

echo
echo "[offers-10min] done"
