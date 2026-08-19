#!/usr/bin/env bash
# Synkar Intelliplan-rapport 1081 (intäkt per dag och kontor) → Bubble.
#
#   API_KEY=... ./intelliplan_sync.sh                    # TORRKÖRNING, senaste 3 mån
#   API_KEY=... ./intelliplan_sync.sh --apply            # skarpt, senaste 3 mån
#   API_KEY=... ./intelliplan_sync.sh 2026-06-01 2026-06-30 --apply
#
# ⚠️ Läser om HELA perioder, inte bara nya rader. En månad växer efter
# månadsskiftet (juli hade halva juni-volymen mitt i månaden), så en
# engångsläsning skulle frysa fel siffror. Upserten är idempotent på
# ip_key = "<datum>|<kontor-id|none>" — kör om hur ofta som helst.
#
# Nattlig cron: kör utan datum + --apply. MONTHS styr hur långt bak.
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"
MONTHS="${MONTHS:-3}"
j() { python3 -m json.tool 2>/dev/null || cat; }

DRY=true
ARGS=()
for a in "$@"; do
  case "$a" in
    --apply) DRY=false ;;
    *) ARGS+=("$a") ;;
  esac
done

run_period() {
  local from="$1" to="$2"
  echo "── $from .. $to $([ "$DRY" = true ] && echo '(torrkörning)' || echo '(skarpt)') ──"
  curl -sS --max-time 300 -X POST "$HOST/admin/intelliplan/sync/revenue-day" \
    -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
    -d "{\"from\":\"$from\",\"to\":\"$to\",\"dry_run\":$DRY}" | j
  echo
}

if [ "${#ARGS[@]}" -ge 2 ]; then
  run_period "${ARGS[0]}" "${ARGS[1]}"
else
  # Senaste MONTHS hela månader, äldst först.
  for ((i = MONTHS - 1; i >= 0; i--)); do
    FROM=$(python3 -c "
import datetime
d = datetime.date.today().replace(day=1)
for _ in range($i): d = (d - datetime.timedelta(days=1)).replace(day=1)
print(d.isoformat())")
    TO=$(python3 -c "
import datetime, calendar
d = datetime.date.fromisoformat('$FROM')
print(d.replace(day=calendar.monthrange(d.year, d.month)[1]).isoformat())")
    run_period "$FROM" "$TO"
  done
fi
