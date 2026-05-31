#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────
# fortnox_enrich.sh (v2 — loopar alla 3 Fortnox-connections)
#
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
#   ENRICH_CONNECTIONS    Komma-separerade connection-IDs (default: F&E, Staff, Group)
#   ENRICH_LIMIT          Antal per batch (default: 50)
#   ENRICH_INVOICE_PAUSE  ms paus mellan invoice-anrop (default: 300)
#   ENRICH_OFFER_PAUSE    ms paus mellan offer-anrop (default: 400)
#   ENRICH_MAX_ROUNDS     Max antal rundor per typ och connection (default: 200)
# ────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_FINGERPRINT="2026-05-31_fortnox_enrich_v2_all_connections"
echo "=== FortnoxEnrich v2 START ==="
echo "[enrich] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"

# Default = alla 3 Fortnox-native connections (F&E, Staff, Carotte Group)
# Housekeeping ingår EJ (Tengella-import, ingen Fortnox-detail).
CONNECTIONS="${ENRICH_CONNECTIONS:-1771579463578x385222043661358460,1771579472595x998707043537409700,1771579485842x995491391876972200}"

LIMIT="${ENRICH_LIMIT:-50}"
INVOICE_PAUSE="${ENRICH_INVOICE_PAUSE:-300}"
OFFER_PAUSE="${ENRICH_OFFER_PAUSE:-400}"
MAX_ROUNDS="${ENRICH_MAX_ROUNDS:-200}"

if [[ -z "$API_KEY" ]]; then
  echo "[enrich] ERROR: Missing MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[enrich] HOST=$HOST LIMIT=$LIMIT MAX_ROUNDS=$MAX_ROUNDS"
echo "[enrich] CONNECTIONS=$CONNECTIONS"

# ── Hjälpfunktioner: extrahera fält ur JSON ──────────────────
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

# ── Loopa varje connection ───────────────────────────────────
IFS=',' read -ra CONN_ARRAY <<< "$CONNECTIONS"

GRAND_INVOICE_ENRICHED=0
GRAND_INVOICE_ERRORS=0
GRAND_OFFER_ENRICHED=0
GRAND_OFFER_ERRORS=0

for CONN in "${CONN_ARRAY[@]}"; do
  CONN="$(echo "$CONN" | tr -d '[:space:]')"
  [[ -z "$CONN" ]] && continue

  echo ""
  echo "=============================================="
  echo "[enrich] Connection: $CONN"
  echo "=============================================="

  # ── A) INVOICES – berika ft_your_reference ────────────────
  echo ""
  echo "[enrich] A) Invoices (ft_your_reference)"

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
    READ_VALS=$(get_enriched "$RESULT")
    ENRICHED=$(echo "$READ_VALS" | awk '{print $1}')
    ERRORS=$(echo "$READ_VALS" | awk '{print $2}')

    INVOICE_TOTAL_ENRICHED=$(( INVOICE_TOTAL_ENRICHED + ENRICHED ))
    INVOICE_TOTAL_ERRORS=$(( INVOICE_TOTAL_ERRORS + ERRORS ))

    echo "[enrich]   invoices round=$INVOICE_ROUNDS found=$FOUND enriched=$ENRICHED errors=$ERRORS"

    if [[ "$FOUND" == "0" ]] || [[ "$FOUND" == "-1" ]]; then
      echo "[enrich]   invoices done (found=$FOUND)"
      break
    fi
    sleep 1
  done

  echo "[enrich]   invoices TOTAL för $CONN: enriched=$INVOICE_TOTAL_ENRICHED errors=$INVOICE_TOTAL_ERRORS rounds=$INVOICE_ROUNDS"
  GRAND_INVOICE_ENRICHED=$(( GRAND_INVOICE_ENRICHED + INVOICE_TOTAL_ENRICHED ))
  GRAND_INVOICE_ERRORS=$(( GRAND_INVOICE_ERRORS + INVOICE_TOTAL_ERRORS ))

  # ── B) OFFERS – berika ft_delivery_date + ft_valid_until ──
  echo ""
  echo "[enrich] B) Offers (ft_delivery_date + ft_valid_until)"

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
    READ_VALS=$(get_enriched "$RESULT")
    ENRICHED=$(echo "$READ_VALS" | awk '{print $1}')
    ERRORS=$(echo "$READ_VALS" | awk '{print $2}')

    OFFER_TOTAL_ENRICHED=$(( OFFER_TOTAL_ENRICHED + ENRICHED ))
    OFFER_TOTAL_ERRORS=$(( OFFER_TOTAL_ERRORS + ERRORS ))

    echo "[enrich]   offers round=$OFFER_ROUNDS found=$FOUND enriched=$ENRICHED errors=$ERRORS"

    if [[ "$FOUND" == "0" ]] || [[ "$FOUND" == "-1" ]]; then
      echo "[enrich]   offers done (found=$FOUND)"
      break
    fi
    sleep 1
  done

  echo "[enrich]   offers TOTAL för $CONN: enriched=$OFFER_TOTAL_ENRICHED errors=$OFFER_TOTAL_ERRORS rounds=$OFFER_ROUNDS"
  GRAND_OFFER_ENRICHED=$(( GRAND_OFFER_ENRICHED + OFFER_TOTAL_ENRICHED ))
  GRAND_OFFER_ERRORS=$(( GRAND_OFFER_ERRORS + OFFER_TOTAL_ERRORS ))
done

# ────────────────────────────────────────────────────────────
echo ""
echo "=== FortnoxEnrich v2 END ==="
echo "[enrich] GRAND TOTAL invoices: enriched=$GRAND_INVOICE_ENRICHED errors=$GRAND_INVOICE_ERRORS"
echo "[enrich] GRAND TOTAL offers:   enriched=$GRAND_OFFER_ENRICHED errors=$GRAND_OFFER_ERRORS"
