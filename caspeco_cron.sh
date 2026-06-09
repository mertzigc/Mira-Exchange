#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# caspeco_cron.sh — löpande bokningssync från Caspeco → Bubble (caspecobooking)
#
# Saknades tidigare helt: backend-endpoints fanns i index.js men ingen schemalagd
# körning. Integrationen drog därför bara de manuellt hämtade test-bokningarna
# i våras och stannade sedan. Det här skriptet fyller luckan — samma mönster som
# tengella_cron.sh / sync_v2_cron.sh, registreras som Render Cron Job.
#
# Flöde:  Caspeco /WebBooking/WebBookings (delta via changedFrom)
#         → detail-hämtning per bokning (customer.orgNr + articles)
#         → ensure ClientCompany (orgnr) → upsert Bubble caspecobooking
#
# Units styrs server-side av env CASPECO_UNIT_IDS (t.ex. 13,14,15,16,17).
# sync-all kör alla konfigurerade units parallellt → cron behöver inte skicka dem.
#
# Användning:  ./caspeco_cron.sh           (nightly delta, DAYS_BACK=7)
#              DAYS_BACK=180 ./caspeco_cron.sh   (bredare backfill/resync)
#
# Env (Render): HOST, API_KEY (eller MIRA_RENDER_API_KEY). DAYS_BACK (default 7).
#   OBS: /caspeco/bookings/sync-all skyddas av requireApiKey (x-api-key) — INGEN
#        sync-secret krävs, till skillnad från /tengella/cron.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:-${MIRA_RENDER_API_KEY:-}}"
: "${API_KEY:?API_KEY (eller MIRA_RENDER_API_KEY) saknas}"

DAYS_BACK="${DAYS_BACK:-7}"   # changedFrom-fönster (ändrade bokningar senaste N dygn)

echo "=== Caspeco bokningssync START @ $(date -u +%FT%TZ) ==="
echo "HOST=$HOST DAYS_BACK=$DAYS_BACK"

# ── Preflight: verifiera PAT + units (x-api-key only) ─────────────────────────
echo "--- Preflight: GET /caspeco/debug/test ---"
curl -sS --max-time 120 \
  "$HOST/caspeco/debug/test" \
  -H "x-api-key: $API_KEY" \
  | cat
echo
echo

# ── Kör delta-sync för ALLA units (parallellt server-side) ───────────────────
# Idempotent upsert på booking_guid → ev. överlapp mellan körningar är ofarligt.
echo "--- Run: POST /caspeco/bookings/sync-all ---"
curl -sS --max-time 1800 \
  -X POST "$HOST/caspeco/bookings/sync-all" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"days_back\": $DAYS_BACK}" \
  | cat
echo
echo "=== Caspeco bokningssync END @ $(date -u +%FT%TZ) ==="
