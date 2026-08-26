#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# salj_anteckning_cron.sh — nattlig "du glömde mötesanteckningen"-todo.
#
# Ett Kundmöte vars mötesdatum har passerat, som INTE är avbockat och som saknar
# mötesanteckning, får en Todo tilldelad mötets ÄGARE (activitet_crm.writer).
# Todon syns i personens att-göra-lista och på kundkortets levande-panel.
#
# ⚠️ IDEMPOTENS hänger HELT på Bubble-fältet `anteckning_todo` (typ Todo) på
# activitet_crm. Saknas fältet avbryter endpointen med 500 och rullar tillbaka
# den todo den hann skapa — med flit. Utan markören hade samma todo skapats om
# igen VARJE natt, i allas listor.
#
# ⚠️ FÖNSTRET ÄR ETT BACKFILL-SKYDD, inte en optimering. DAYS=14 betyder att
# första körningen bara betar av de senaste två veckorna. Höj INTE "för
# säkerhets skull" — kör en engångskörning med DAYS=90 DRY=1 först och läs
# `skulle_skapas` innan du släpper på den skarpt.
#
# Användning:
#   ./salj_anteckning_cron.sh              # skarpt, senaste 14 dagarna
#   DRY=1 ./salj_anteckning_cron.sh        # torrkörning, skriver ingenting
#   DAYS=90 DRY=1 ./salj_anteckning_cron.sh   # se hur stor backloggen är
#
# Env (Render Cron Job): HOST, API_KEY (eller MIRA_RENDER_API_KEY).
#   DAYS=14 · GRACE=1 (dygn efter mötet innan vi tjatar) · LIMIT=50 (tak/körning).
#
# Schemaläggning: morgon svensk tid, så todon ligger där när dagen börjar.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:-${MIRA_RENDER_API_KEY:-}}"
: "${API_KEY:?API_KEY (eller MIRA_RENDER_API_KEY) saknas}"
DAYS="${DAYS:-14}"
GRACE="${GRACE:-1}"
LIMIT="${LIMIT:-50}"
DRY="${DRY:-0}"

echo "=== Mötesanteckning-todo START @ $(date -u +%FT%TZ) ==="
echo "HOST=$HOST DAYS=$DAYS GRACE=$GRACE LIMIT=$LIMIT DRY=$DRY"

# ── Preflight: vilken kod är live? ───────────────────────────────────────────
# 2026-08-20 tolkades ett svar från en deploy som aldrig landat som ett datafaktum.
echo "--- /version ---"
curl -sS --max-time 30 "$HOST/version" -H "x-api-key: $API_KEY" | python3 -m json.tool 2>/dev/null || echo "  (kunde inte läsa /version)"

Q="days=$DAYS&grace=$GRACE&limit=$LIMIT"
[ "$DRY" = "1" ] && Q="$Q&dry=1"

echo "--- POST /salj/anteckning-todo/cron?$Q ---"
rc=0
body=$(curl -sS --max-time 120 -X POST -w $'\n%{http_code}' \
  "$HOST/salj/anteckning-todo/cron?$Q" -H "x-api-key: $API_KEY") || rc=$?
http="${body##*$'\n'}"
printf '%s\n' "${body%$'\n'*}" | python3 -m json.tool 2>/dev/null || printf '%s\n' "${body%$'\n'*}"

# Inget `|| true` här — ett tyst grönt cron-jobb är värre än inget cron-jobb.
if [ "$rc" -ne 0 ] || [ "$http" != "200" ]; then
  echo "❌ Körningen misslyckades (curl exit $rc, HTTP $http)."
  echo "   Är felet anteckning_todo_markor_misslyckades saknas fältet \`anteckning_todo\` (typ Todo) på activitet_crm i Bubble."
  echo "=== Mötesanteckning-todo FAILED @ $(date -u +%FT%TZ) ==="
  exit 1
fi

# capped=true betyder att fler möten väntar än LIMIT — aldrig tyst avhugget.
if printf '%s' "${body%$'\n'*}" | grep -q '"capped": *true'; then
  echo "⚠️  Taket (LIMIT=$LIMIT) nåddes — se fältet \`kvar\` ovan. Nästa körning tar resten."
fi

echo "=== Mötesanteckning-todo END @ $(date -u +%FT%TZ) ==="
