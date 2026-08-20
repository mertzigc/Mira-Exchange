#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# intelliplan_scan.sh — hitta rapportmallar genom att skanna id-intervallet.
#
# ⚠️ VARFÖR DET HÄR BEHÖVS: Intelliplan har INGEN endpoint som listar mallar
# (verifierat 2026-08-19: åtta kandidatvägar, alla 404 — inte 401/403, alltså
# finns vägarna inte), och id:n går inte att hitta i deras UI. Men intervallet
# är känt: Carotte har 23 mallar mellan 1027 och 1080. 54 kandidater går att
# knacka på. ("Blind skanning är meningslös" gällde hela heltalsrymden.)
#
# ⚠️ LÄSER BARA KOLUMNNAMN. Rapporterna bär konsultnamn och lönekostnader —
# skanningen begär aldrig exempelrader. Persondata-grinden är testtäckt.
#
# ⚠️ SMALT DATUMFÖNSTER. Vi behöver bara rubrikraden. En hel månad ur 23
# rapporter är megabyte i onödan och belastar Intelliplan.
#
#   API_KEY=... ./intelliplan_scan.sh                    # 1027–1080 (känt spann)
#   API_KEY=... ./intelliplan_scan.sh 1000 1120          # bredare svep
#   API_KEY=... ./intelliplan_scan.sh 1027 1080 2026-07-15   # annan sonderingsdag
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"
FROM_ID="${1:-1027}"
TO_ID="${2:-1080}"
DAG="${3:-$(date -u -d 'yesterday' +%F 2>/dev/null || date -u -v-1d +%F)}"

echo "═══ Mall-spaning: id $FROM_ID–$TO_ID, sonderingsdag $DAG ═══"
echo "(en dag räcker — vi läser bara rubrikraden)"
echo

# Taket i endpointen är 120 id per anrop → dela upp automatiskt.
CHUNK=60
id=$FROM_ID
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
: > "$tmp"

while [ "$id" -le "$TO_ID" ]; do
  slut=$(( id + CHUNK - 1 )); [ "$slut" -gt "$TO_ID" ] && slut=$TO_ID
  echo "── knackar på $id–$slut …"
  body=$(curl -sS --max-time 600 -w $'\n%{http_code}' \
    "$HOST/admin/intelliplan/probe?from_id=$id&to_id=$slut&from=$DAG&to=$DAG" \
    -H "x-api-key: $API_KEY") || { echo "  ❌ curl misslyckades"; exit 1; }
  http="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [ "$http" != "200" ]; then echo "  ❌ HTTP $http"; printf '%s\n' "$body" | head -5; exit 1; fi
  printf '%s\n' "$body" >> "$tmp"
  id=$(( slut + 1 ))
done

python3 - "$tmp" <<'PY'
import json, sys
funna, tomma, fel = [], 0, []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    for r in d.get("results", []):
        if r.get("ok"): funna.append(r)
        elif r.get("finns_inte"): tomma += 1
        else: fel.append(r)

print(f"\n═══ RESULTAT ═══")
print(f"  mallar funna:      {len(funna)}")
print(f"  id utan mall:      {tomma}")
print(f"  anrop som failade: {len(fel)}")
if fel:
    print("\n⚠️  SKANNINGEN ÄR OFULLSTÄNDIG — dessa failade av annan orsak än 'mall saknas':")
    for r in fel[:10]:
        print(f"     {r['id']}: HTTP {r.get('status')} {str(r.get('error'))[:90]}")
    print("   Kör om dem innan du drar slutsatser om vad som finns.")

if funna:
    print("\n── ALLA MALLAR (kolumner, ingen data) ──")
    for r in sorted(funna, key=lambda x: -x.get("schema_score", 0)):
        flagga = "⭐" if r.get("schema_kandidat") else "  "
        cols = r.get("columns") or []
        print(f"{flagga} {r['id']}  score {r.get('schema_score',0)}/4  {len(cols)} kol  {r.get('rows')} rader")
        print(f"      {', '.join(cols[:14])}{' …' if len(cols) > 14 else ''}")
        print(f"      → {r.get('schema_varfor','')}")

kand = [r for r in funna if r.get("schema_kandidat")]
print("\n═══ SLUTSATS ═══")
if fel:
    print("⚠️  Ofullständig skanning — se ovan. Slutsatsen nedan kan sakna mallar.")
if kand:
    b = max(kand, key=lambda x: x.get("schema_score", 0))
    print(f"⭐ {len(kand)} mall(ar) med datum + tid + konsult. Börja med id {b['id']}.")
    print(f"   Nästa: REPORT-id {b['id']} → kolumnprofilera med ./intelliplan_probe.sh {b['id']} <från> <till>")
elif funna:
    print("Ingen mall har datum + tid + konsult.")
    print("→ Pass-kornighet finns inte i någon BEFINTLIG mall. Bygg en via")
    print('  "Add columns" i Reporting-vyn: datum, starttid, sluttid, konsult, kund.')
else:
    print("Inga mallar alls i spannet — kontrollera intervallet.")
PY
