#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────
# fortnox_enrich.sh
# Berikar FortnoxInvoice (ft_your_reference) och FortnoxOffer
# (ft_delivery_date, ft_valid_until) med detail-anrop mot Fortnox.
#
# Kör EFTER fortnox_cron_v1.sh – hanterar bara poster som saknar värdet.
# Idempotent: om found=0 avslutas direkt utan API-anrop.
#
# Env-vars som krävs:
#   HOST                  (default: https://mira-exchange.onrender.com)
#   MIRA_RENDER_API_KEY   (required)
#
# Valfria env-vars:
#   ENRICH_INVOICE_CONN   FortnoxConnection-ID för Food & Event (default nedan)
#   ENRICH_LIMIT          Antal per batch (default: 50)
#   ENRICH_INVOICE_PAUSE  ms paus mellan invoice-anrop (default: 300)
#   ENRICH_OFFER_PAUSE    ms paus mellan offer-anrop (default: 400)
#   ENRICH_MAX_ROUNDS     Max antal rundor per typ (default: 200)
# ────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-24_fortnox_enrich_v1"
echo "=== FortnoxEnrich START ==="
echo "[enrich] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
CONN="${ENRICH_INVOICE_CONN:-1771579463578x385222043661358460}"
LIMIT="${ENRICH_LIMIT:-50}"
INVOICE_PAUSE="${ENRICH_INVOICE_PAUSE:-300}"
OFFER_PAUSE="${ENRICH_OFFER_PAUSE:-400}"
MAX_ROUNDS="${ENRICH_MAX_ROUNDS:-200}"

if [[ -z "$API_KEY" ]]; then
  echo "[enrich] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[enrich] HOST=$HOST CONN=$CONN LIMIT=$LIMIT MAX_ROUNDS=$MAX_ROUNDS"

# ── Hjälpfunktion: extrahera "found" ur JSON
get_found() {
  echo "$1" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('found', 0))
except:
    print(-1)
"
}

get_enriched() {
  echo "$1" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    c = d.get('counts', {})
    print(c.get('enriched', 0), c.get('errors', 0))
except:
    print(0, 0)
"
}

# ────────────────────────────────────────────────────────────
# A) INVOICES – berika ft_your_reference
# ────────────────────────────────────────────────────────────
echo ""
echo "[enrich] === A) Berika invoices (ft_your_reference) ==="

INVOICE_TOTAL_ENRICHED=0
INVOICE_TOTAL_ERRORS=0
INVOICE_ROUNDS=0

while (( INVOICE_ROUNDS < MAX_ROUNDS )); do
  INVOICE_ROUNDS=$(( INVOICE_ROUNDS + 1 ))

  RESULT=$(curl -sS --max-time 120 \
    -X POST "$HOST/fortnox/enrich/invoices" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN\",\"limit\":$LIMIT,\"pause_ms\":$INVOICE_PAUSE}" \
    || echo '{"ok":false,"found":-1}')

  FOUND=$(get_found "$RESULT")
  READ_ENRICHED_ERRORS=$(get_enriched "$RESULT")
  ENRICHED=$(echo "$READ_ENRICHED_ERRORS" | awk '{print $1}')
  ERRORS=$(echo "$READ_ENRICHED_ERRORS" | awk '{print $2}')

  INVOICE_TOTAL_ENRICHED=$(( INVOICE_TOTAL_ENRICHED + ENRICHED ))
  INVOICE_TOTAL_ERRORS=$(( INVOICE_TOTAL_ERRORS + ERRORS ))

  echo "[enrich] invoices round=$INVOICE_ROUNDS found=$FOUND enriched=$ENRICHED errors=$ERRORS"

  if [[ "$FOUND" == "0" ]] || [[ "$FOUND" == "-1" ]]; then
    echo "[enrich] invoices done (found=$FOUND)"
    break
  fi

  sleep 1
done

echo "[enrich] invoices TOTAL enriched=$INVOICE_TOTAL_ENRICHED errors=$INVOICE_TOTAL_ERRORS rounds=$INVOICE_ROUNDS"

# ────────────────────────────────────────────────────────────
# B) OFFERS – berika ft_delivery_date + ft_valid_until
# ────────────────────────────────────────────────────────────
echo ""
echo "[enrich] === B) Berika offers (ft_delivery_date + ft_valid_until) ==="

OFFER_TOTAL_ENRICHED=0
OFFER_TOTAL_ERRORS=0
OFFER_ROUNDS=0

while (( OFFER_ROUNDS < MAX_ROUNDS )); do
  OFFER_ROUNDS=$(( OFFER_ROUNDS + 1 ))

  RESULT=$(curl -sS --max-time 120 \
    -X POST "$HOST/fortnox/enrich/offers" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN\",\"limit\":$LIMIT,\"pause_ms\":$OFFER_PAUSE}" \
    || echo '{"ok":false,"found":-1}')

  FOUND=$(get_found "$RESULT")
  READ_ENRICHED_ERRORS=$(get_enriched "$RESULT")
  ENRICHED=$(echo "$READ_ENRICHED_ERRORS" | awk '{print $1}')
  ERRORS=$(echo "$READ_ENRICHED_ERRORS" | awk '{print $2}')

  OFFER_TOTAL_ENRICHED=$(( OFFER_TOTAL_ENRICHED + ENRICHED ))
  OFFER_TOTAL_ERRORS=$(( OFFER_TOTAL_ERRORS + ERRORS ))

  echo "[enrich] offers round=$OFFER_ROUNDS found=$FOUND enriched=$ENRICHED errors=$ERRORS"

  if [[ "$FOUND" == "0" ]] || [[ "$FOUND" == "-1" ]]; then
    echo "[enrich] offers done (found=$FOUND)"
    break
  fi

  sleep 1
done

echo "[enrich] offers TOTAL enriched=$OFFER_TOTAL_ENRICHED errors=$OFFER_TOTAL_ERRORS rounds=$OFFER_ROUNDS"

# ────────────────────────────────────────────────────────────
echo ""
echo "=== FortnoxEnrich END ==="
echo "[enrich] invoices_enriched=$INVOICE_TOTAL_ENRICHED invoices_errors=$INVOICE_TOTAL_ERRORS"
echo "[enrich] offers_enriched=$OFFER_TOTAL_ENRICHED offers_errors=$OFFER_TOTAL_ERRORS"
