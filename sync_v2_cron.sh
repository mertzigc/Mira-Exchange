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
#              ./sync_v2_cron.sh pdf        (drän needs_pdf_sync, kräver SYNC_V2_ORDERS=1)
#
# Env (Render): HOST, MIRA_RENDER_API_KEY, SYNC_SECRET.
#   MODIFIED_DAYS_BACK (default 3), SYNC_YEAR (default innevarande år, för full).
#   SYNC_V2_ORDERS (default 0): sätt =1 för att aktivera order/offer/workorder + PDF.
#     ⚠️ CUTOVER (9e): innan du sätter =1, STÄNG AV gamla order/offer/workorder-cron
#        (fortnox_cron_v1.sh, tengella_cron.sh, fortnox_offers_recent_10min.sh) så de
#        inte skriver samma dokument parallellt. Fakturadelen ovan är orörd.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
: "${MIRA_RENDER_API_KEY:?MIRA_RENDER_API_KEY saknas}"
: "${SYNC_SECRET:?SYNC_SECRET saknas}"

MODE="${1:-nightly}"
ORDERS_ENABLED="${SYNC_V2_ORDERS:-0}"   # 9e feature-flag (off by default)

FE="1771579463578x385222043661358460"      # Food & Event
STAFF="1771579472595x998707043537409700"   # Staff
GROUP="1771579485842x995491391876972200"   # Group (Fortnox-native; exkl i KPI men har fakturor)
# HK/Tengella körs via source tengella-invoice (connection sätts i adaptern).
# OBS: TENGELLA-connectionen får ALDRIG skickas till Fortnox-routerna (404 "Kan inte
# hitta fakturan") — HK-PDF hämtas via /tengella/enrich/invoice-pdfs.
FORTNOX_NATIVE="$FE $STAFF $GROUP"
TENGELLA_ORGNO="${TENGELLA_ORGNO:-746-0509}"   # Tengella-tenant (för kund-synk)
CUST_DAYS="${CUST_DAYS:-${MODIFIED_DAYS_BACK:-3}}"  # lastmodified-fönster för kund-synk
CUST_PAGES="${CUST_PAGES:-3}"                       # max sidor/kund-synk (inkrementell → litet)

post() {  # $1=path  $2=json
  # Resilient: ett hängt/trasigt anrop får INTE döda hela körningen (set -e). Logga och
  # fortsätt — nästa nattliga/veckosvep tar igen (idempotent). max-time 30 min/anrop.
  local rc=0
  curl -sS --max-time 1800 -X POST "$HOST$1" \
    -H "x-api-key: $MIRA_RENDER_API_KEY" \
    -H "x-sync-secret: $SYNC_SECRET" \
    -H "Content-Type: application/json" \
    -d "$2" || rc=$?
  if [ "$rc" -ne 0 ]; then echo "[sync_v2] WARN: POST $1 misslyckades (curl $rc) — fortsätter"; fi
  echo
}

# Veckovis order/offer-resync. Tunga F&E-månader (~500-600 ordrar, rad-tunga offerter)
# timeoutar som helårs- eller månadssvep → kör 7-dagarsfönster. $1=år. Kräver GNU date
# (Render Linux). Idempotent → ev. overlap i sista fönstret är ofarlig.
order_offer_weekly() {
  local Y="$1" d to END
  d="$Y-01-01"; END="$((Y + 1))-01-01"
  while [[ "$d" < "$END" ]]; do
    to="$(date -u -d "$d +6 days" +%F)"
    echo "[sync_v2] FULL order/offer $d..$to"
    post /sync/v2/fortnox-order "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"fromdate\":\"$d\",\"todate\":\"$to\",\"throttleMs\":250}"
    post /sync/v2/fortnox-offer "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"fromdate\":\"$d\",\"todate\":\"$to\",\"throttleMs\":250}"
    d="$(date -u -d "$d +7 days" +%F)"
  done
}

# ── KUND-SYNK (BILLIG, nattlig) — inkrementell: drar bara nya/ändrade kunder via
#    lastmodified → FortnoxCustomer/TengellaCustomer + ensure ClientCompany + sätter
#    linked_company/company PÅ KUNDPOSTEN vid upsert. Körs nattligt FÖRE dokumentsynken
#    så bryggan är färsk → nya dokument får sin linked_company redan vid create.
#    Bunden (days_back + max_pages) → liten WU. Ersätter gamla fortnox_cron_v1/
#    tengella_cron-kundsteget UTAN deras order/offer-synk (krockar med v2).
sync_customers() {
  echo "[sync_v2] CUSTOMERS (inkrementell) @ $(date -u +%FT%TZ)"
  post /fortnox/upsert/customers/all "{\"connection_id\":\"$FE\",\"days_back\":$CUST_DAYS,\"max_pages\":$CUST_PAGES,\"limit\":100,\"pause_ms\":150}"
  post /fortnox/upsert/customers/all "{\"connection_id\":\"$STAFF\",\"days_back\":$CUST_DAYS,\"max_pages\":$CUST_PAGES,\"limit\":100,\"pause_ms\":150}"
  post /tengella/customers/sync "{\"orgNo\":\"$TENGELLA_ORGNO\"}"
}

# ── LÄNK-RECONCILE (TUNG, VECKOVIS) — fyller customer→CC-bryggan för ALLA kunder med
#    orgnr men tom länk, och propagerar linked_company ut på ALLA dokument. Båda är
#    HELSKANNINGAR (linkcustomer läser ~7,7k kunder, linkcompany läser ~20k dokument
#    inkl ft_raw_json) → DYR i WU. Behövs INTE nattligt: nya dokument länkas vid create
#    (sync_customers håller bryggan färsk), ändrade på update. Reconcilen fångar bara
#    historiska noop-docs + docs vars kund städats i efterhand → veckovis räcker gott.
reconcile_links() {
  echo "[sync_v2] LÄNK-reconcile (helskanning) @ $(date -u +%FT%TZ)"
  post /sync/v2-linkcustomer "{\"mode\":\"write\",\"target\":\"both\"}"
  post /sync/v2-linkcompany/all "{\"mode\":\"write\"}"
}

if [ "$MODE" = "pdf" ]; then
  echo "[sync_v2] PDF-drän @ $(date -u +%FT%TZ)"
  # ── Invoice-PDF (KÄRNDATA för kundportalen) ──────────────────────────────────
  # sync_v2-fakturasynken hämtar INTE PDF (bara data) → fyll saknade ft_pdf via den
  # idempotenta enrich-routen (söker ft_pdf is_empty + ej makulerad). Körs ALLTID,
  # oberoende av SYNC_V2_ORDERS. Loopar för att beta av backlog; steady-state räcker
  # första varvet. all_connections = F&E + Staff (+ ev. fler native Fortnox-conn).
  # Per connection (EJ all_connections → undviker att TENGELLA-conn skickas till Fortnox → 404).
  for i in 1 2 3 4 5 6; do
    for CID in $FORTNOX_NATIVE; do
      post /fortnox/enrich/invoice-pdfs "{\"connection_id\":\"$CID\",\"limit\":40,\"pause_ms\":250,\"pdf_path\":\"preview\"}"
    done
  done
  # Tengella/HK invoice-PDF (egen route — Tengella-API, ej Fortnox).
  post /tengella/enrich/invoice-pdfs "{\"pause_ms\":150,\"max_enrich\":300}"

  # ── Order-PDF (9c) — bara om order/offer-cutover aktiv ───────────────────────
  if [ "$ORDERS_ENABLED" = "1" ]; then
    post /sync/v2-pdf/fortnox-order "{\"maxRecords\":50,\"throttleMs\":300}"
  fi
  echo "[sync_v2] pdf klart @ $(date -u +%FT%TZ)"
  exit 0
fi

# Kund-synk FÖRST (nattligt + full) — billig, håller bryggan färsk så att dokument
# som synkas nedan länkas redan vid create. (PDF-läget exitar ovan, rörs ej.)
sync_customers

if [ "$MODE" = "full" ]; then
  YEAR="${SYNC_YEAR:-$(date -u +%Y)}"
  echo "[sync_v2] FULL resync $YEAR @ $(date -u +%FT%TZ)"
  # Invoices kvartalsvis (helår i ETT anrop kan hänga >max-time). bash ordsplittar $Q.
  for Q in "01-01 03-31" "04-01 06-30" "07-01 09-30" "10-01 12-31"; do
    set -- $Q; QF="$1"; QT="$2"
    post /sync/v2/fortnox-invoice "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"fromdate\":\"$YEAR-$QF\",\"todate\":\"$YEAR-$QT\",\"throttleMs\":300}"
    post /sync/v2/fortnox-invoice "{\"mode\":\"write\",\"connection_id\":\"$STAFF\",\"fromdate\":\"$YEAR-$QF\",\"todate\":\"$YEAR-$QT\",\"throttleMs\":300}"
  done
  post /sync/v2/tengella-invoice "{\"mode\":\"write\",\"sinceYM\":\"$YEAR-01\"}"
  if [ "$ORDERS_ENABLED" = "1" ]; then
    echo "[sync_v2] FULL order/offer (F&E, veckovis) + workorder $YEAR"
    # OBS: order/offer BARA F&E. Staff har bara faktura i Fortnox; Staffs order/offert
    # skapas i Intelliplan (egen framtida källa) → /orders ger 400 på Staff-kontot.
    order_offer_weekly "$YEAR"
    # Workorder: global discovery (listar allt, billigt), window:ad write till året.
    post /sync/v2/tengella-workorder "{\"mode\":\"write\",\"sinceYM\":\"$YEAR-01\",\"untilYM\":\"$YEAR-12\",\"throttleMs\":300}"
  fi
  # TUNG länk-reconcile bara i full (veckovis) — helskanning av kunder + dokument.
  reconcile_links
else
  DB="${MODIFIED_DAYS_BACK:-3}"
  # Tengella saknar modified-filter → synka senaste ~2 mån (Linux date; macOS-fallback).
  TSINCE="$(date -u -d '40 days ago' +%Y-%m 2>/dev/null || date -u -v-40d +%Y-%m)"
  echo "[sync_v2] NIGHTLY modified=${DB}d tengella_since=${TSINCE} @ $(date -u +%FT%TZ)"
  post /sync/v2/fortnox-invoice  "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"modifiedDaysBack\":$DB,\"throttleMs\":250}"
  post /sync/v2/fortnox-invoice  "{\"mode\":\"write\",\"connection_id\":\"$STAFF\",\"modifiedDaysBack\":$DB,\"throttleMs\":250}"
  post /sync/v2/tengella-invoice "{\"mode\":\"write\",\"sinceYM\":\"$TSINCE\"}"
  if [ "$ORDERS_ENABLED" = "1" ]; then
    echo "[sync_v2] NIGHTLY order/offer F&E (modified=${DB}d) + workorder (since=${TSINCE})"
    # Order/offer BARA F&E (Staff = endast faktura; order/offert ligger i Intelliplan).
    post /sync/v2/fortnox-order      "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"modifiedDaysBack\":$DB,\"throttleMs\":250}"
    post /sync/v2/fortnox-offer      "{\"mode\":\"write\",\"connection_id\":\"$FE\",\"modifiedDaysBack\":$DB,\"throttleMs\":250}"
    # Workorder saknar modified-filter → window:a på OrderDate (skippar gamla; pagar dock globalt).
    post /sync/v2/tengella-workorder "{\"mode\":\"write\",\"sinceYM\":\"$TSINCE\",\"throttleMs\":250}"
  fi
fi

echo "[sync_v2] klart @ $(date -u +%FT%TZ)"
