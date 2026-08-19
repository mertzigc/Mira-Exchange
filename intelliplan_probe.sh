#!/usr/bin/env bash
# Steg 1–2: verifiera Intelliplan-kopplingen och rekognosera rapporterna.
# Skriver INGENTING till Bubble.
#
#   API_KEY=... ./intelliplan_probe.sh
#   API_KEY=... ./intelliplan_probe.sh 4                 # bara rapport 4
#   API_KEY=... ./intelliplan_probe.sh 4 2026-01-01 2026-01-31
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY (samma x-api-key som övriga Render-anrop)}"
H=(-H "x-api-key: $API_KEY")
j() { python3 -m json.tool 2>/dev/null || cat; }

echo "═══ 1. Env på Render (visar aldrig hemligheten) ═══"
curl -sS --max-time 30 "${H[@]}" "$HOST/admin/intelliplan/debug-env" | j
echo

echo "═══ 2. Token (bevisar tenant + client_credentials) ═══"
curl -sS --max-time 60 "${H[@]}" "$HOST/admin/intelliplan/auth/test" | j
echo

if [ $# -ge 1 ]; then
  ID="$1"; FROM="${2:-}"; TO="${3:-}"
  Q="lang=sv"
  [ -n "$FROM" ] && Q="$Q&from=$FROM"
  [ -n "$TO" ]   && Q="$Q&to=$TO"
  echo "═══ 3. Rapport $ID — form och kolumner ═══"
  curl -sS --max-time 120 "${H[@]}" "$HOST/admin/intelliplan/report/$ID?$Q" | j
  echo
  echo "(Lägg till &raw=1 på URL:en ovan för hela svaret.)"
else
  echo "═══ 3. Vilka rapport-id svarar? (1–8) ═══"
  curl -sS --max-time 180 "${H[@]}" "$HOST/admin/intelliplan/probe?ids=1,2,3,4,5,6,7,8" | j
  echo
  echo "Kör om med ett id för detaljer:  ./intelliplan_probe.sh 4 2026-01-01 2026-01-31"
fi
