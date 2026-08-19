#!/usr/bin/env bash
# Sätter ClientCompany.Region utifrån vem som är Kundansvarig.
#
#   ./region_bulk.sh region_map.json          # TORRKÖRNING — skriver ingenting
#   ./region_bulk.sh region_map.json --apply  # skarpt
#
# region_map.json = e-post → region, t.ex.
#   { "andriette@carotte.se": "Öst", "kalle@carotte.se": "Väst" }
#
# FYLLER BARA TOMMA regionfält. Bolag som redan har en region rörs aldrig — de
# rapporteras som "conflicts" så du kan titta på dem separat.
#
# Torrkörningen visar per person: antal bolag, hur många som skulle sättas, hur
# många som redan är rätt och hur många som avviker (med exempelnamn). Kör den
# först, läs siffrorna, kör sen med --apply.
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
TOKEN="${PLANNING_ADMIN_TOKEN:?Missing PLANNING_ADMIN_TOKEN}"

MAP_FILE="${1:?Ange en JSON-fil med e-post → region}"
[ -f "$MAP_FILE" ] || { echo "Hittar inte $MAP_FILE" >&2; exit 1; }

DRY=true
FORCE=false
for a in "${@:2}"; do
  case "$a" in
    --apply) DRY=false ;;
    --force) FORCE=true ;;   # tillåt regionvärden som inte redan förekommer i datan
    *) echo "Okänd flagga: $a" >&2; exit 1 ;;
  esac
done

MAPPING="$(cat "$MAP_FILE")"
BODY="$(printf '{"mapping":%s,"dry_run":%s,"force":%s}' "$MAPPING" "$DRY" "$FORCE")"

if [ "$DRY" = "true" ]; then
  echo "=== TORRKÖRNING (inget skrivs) ==="
else
  echo "=== SKARP KÖRNING — skriver Region på företag med tomt fält ==="
  read -r -p "Fortsätt? [ja/nej] " ans
  [ "$ans" = "ja" ] || { echo "Avbrutet."; exit 0; }
fi

curl -sS --max-time 300 -X POST "$HOST/admin/companies/region-bulk" \
  -H "x-admin-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -m json.tool
