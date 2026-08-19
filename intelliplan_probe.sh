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

# Grinden (x-api-key) körs FÖRE routingen — en 401 säger alltså ingenting om
# Intelliplan-koden, bara att nyckeln inte matchar. Stanna direkt i stället för
# att köra vidare och ge tre likadana fel.
echo "═══ 0. Nyckelkoll ═══"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${H[@]}" "$HOST/tengella/debug-env" || echo 000)
if [ "$CODE" = "401" ]; then
  cat >&2 <<'MSG'
✗ x-api-key avvisad av Render (401).

  Felet kommer från den globala grinden, före routingen — det har inget med
  Intelliplan att göra. Servern läser nyckeln som:
      pick(MIRA_RENDER_API_KEY, MIRA_EXCHANGE_API_KEY)   ← första icke-tomma

  Kolla:
   1. Finns BÅDA i Render? Då gäller MIRA_RENDER_API_KEY.
   2. Följde ett osynligt tecken med vid kopieringen?
        printf %s "$API_KEY" | wc -c     och jämför med värdet i Render.
MSG
  exit 1
fi
if [ "$CODE" = "000" ]; then echo "✗ Fick inget svar från $HOST — nere eller fel URL?" >&2; exit 1; fi
echo "✓ nyckeln accepteras (HTTP $CODE)"
echo

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
  echo "═══ 4. Kolumnprofil (maskerad — inga riktiga värden) ═══"
  curl -sS --max-time 120 "${H[@]}" "$HOST/admin/intelliplan/report/$ID?$Q&profile=1" | j
  echo
  echo "(sample=1 ger en exempelrad, raw=1 hela svaret — båda innehåller persondata.)"
else
  # ⚠️ Rapport-id är FYRSIFFRIGA (1027–1081 hos Carotte) och står under
  # rapportikonen i vyn "Report templates". Siffran bredvid "Report" i
  # rapportvyn är ANTALET RADER — inte id:t. (Kostade en felsökning: 219.)
  echo "═══ Finns en endpoint som listar mallarna? ═══"
  curl -sS --max-time 120 "${H[@]}" "$HOST/admin/intelliplan/templates" | j
  echo
  echo "Kända rapport-id: 1039 (timmar+intäkt) · 1058 (intäkt per kund/order) · 1081 (intäkt per dag/kontor)"
  echo "  ./intelliplan_probe.sh 1058 2026-06-01 2026-06-30"
fi
