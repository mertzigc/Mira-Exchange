#!/usr/bin/env bash
# Kolumnprofilera SPECIFIKA rapport-id med ett brett datumfönster.
# För mallar som svarade utan rubrikrad i scan (= ingen data på sonderingsdagen).
#
#   API_KEY=... ./intelliplan_probe_ids.sh 1022,1026,1036
#   API_KEY=... ./intelliplan_probe_ids.sh 1022,1026 2026-01-01 2026-08-20
set -euo pipefail
HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"
IDS="${1:?Ange id:n kommaseparerat}"
FROM="${2:-$(date -u -d '6 months ago' +%F 2>/dev/null || date -u -v-6m +%F)}"
TO="${3:-$(date -u +%F)}"

echo "=== Kolumnprofilering: ${IDS}"
echo "    fonster ${FROM} .. ${TO} (brett - dessa gav ingen rubrikrad pa en dag)"
echo
curl -sS --max-time 900 \
  "$HOST/admin/intelliplan/probe?ids=${IDS}&from=${FROM}&to=${TO}" \
  -H "x-api-key: $API_KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('results',[]):
    if not r.get('ok'):
        print(f\"  {r['id']}: {'mall saknas' if r.get('finns_inte') else r.get('error')}\"); continue
    cols=r.get('columns') or []
    if not cols:
        print(f\"  {r['id']}: ⚠️  fortfarande ingen rubrikrad aven med brett fonster\"); continue
    flagga='*' if r.get('schema_kandidat') else ' '
    print(f\"{flagga} {r['id']}  score {r.get('schema_score',0)}/4  {len(cols)} kol  {r.get('rows')} rader\")
    print(f\"      {', '.join(cols)}\")
    print(f\"      -> {r.get('schema_varfor','')}\")
print()
print(d.get('sammanfattning',{}).get('slutsats',''))
"
