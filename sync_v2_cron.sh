#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# sync_v2_cron.sh — löpande fakturasync via /sync/v2 (NIR-kärnan, invoice_sync.js)
# Ersätter gammal invoice-sync + alla enrich-script (detail-hämtning ger komplett
# data direkt → ingen enrich behövs).
#
#   nightly (default): Fortnox lastmodified-sweep (fångar nya + saldo/betalnings-
#                      ändringar) + Tengella senaste ~2 mån.
#   full:              hela årets fakturor (resync/safety-net, kör t.ex. veckovis).
#
# Användning:  ./sync_v2_cron.sh            (nightly)
#              ./sync_v2_cron.sh full       (helårs-resync)
#
# Env (Render): HOST, MIRA_RENDER_API_KEY, SYNC_SECRET.
#   MODIFIED_DAYS_BACK (default 3), SYNC_YEAR (default innevarande år, för full).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
: "${MIRA_RENDER_API_KEY:?MIRA_RENDER_API_KEY saknas}"
: "${SYNC_SECRET:?SYNC_SECRET saknas}"

MODE="${1:-nightly}"

FE="1771579463578x385222043661358460"      # Food & Event
STAFF="1771579472595x998707043537409700"   # Staff
# HK/Tengella körs via source tengella-invoice (connection sätts i adaptern)

post() {  # $1=path  $2=json
  curl -sS --max-time 3600 -X POST "$HOST$1" \
    -H "x-api-key: $MIRA_RENDER_API_KEY" \
    -H "x-sync-secret: $SYNC_SECRET" \
    -H "Content-Type: application/json" \
    -d "$2"
  echo
}

if [ "$MODE" = "full" ]; then
  YEAR="${SYNC_YEAR:-$(date -u +%Y)}"
  echo "[sync_v2] FULL resync $YEAR @ $(date -u +%FT%TZ)"
  post /sync/v2/fortnox-invoice  "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"fromdate\":\"$YEAR-01-01\",\"todate\":\"$YEAR-12-31\",\"throttleMs\":300}"
  post /sync/v2/fortnox-invoice  "{\"mode\":\"write\",\"connection_id\":\"$STAFF\",\"fromdate\":\"$YEAR-01-01\",\"todate\":\"$YEAR-12-31\",\"throttleMs\":300}"
  post /sync/v2/tengella-invoice "{\"mode\":\"write\",\"sinceYM\":\"$YEAR-01\"}"
else
  DB="${MODIFIED_DAYS_BACK:-3}"
  # Tengella saknar modified-filter → synka senaste ~2 mån (Linux date; macOS-fallback).
  TSINCE="$(date -u -d '40 days ago' +%Y-%m 2>/dev/null || date -u -v-40d +%Y-%m)"
  echo "[sync_v2] NIGHTLY modified=${DB}d tengella_since=${TSINCE} @ $(date -u +%FT%TZ)"
  post /sync/v2/fortnox-invoice  "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"modifiedDaysBack\":$DB,\"throttleMs\":250}"
  post /sync/v2/fortnox-invoice  "{\"mode\":\"write\",\"connection_id\":\"$STAFF\",\"modifiedDaysBack\":$DB,\"throttleMs\":250}"
  post /sync/v2/tengella-invoice "{\"mode\":\"write\",\"sinceYM\":\"$TSINCE\"}"
fi

echo "[sync_v2] klart @ $(date -u +%FT%TZ)"
