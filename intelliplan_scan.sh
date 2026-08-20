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
#   API_KEY=... ./intelliplan_scan.sh                    # 1020-1100 (brett svep)
#   API_KEY=... ./intelliplan_scan.sh 1000 1120          # bredare svep
#   API_KEY=... ./intelliplan_scan.sh 1027 1080 2026-07-15   # annan sonderingsdag
#
# ⚠️ INGA typografiska tecken (en dash, ellips) direkt efter en variabel.
# `$FROM_ID–$TO_ID` med en dash (U+2013) får skalet att läsa multibyte-tecknet
# som del av variabelnamnet → "unbound variable" under `set -u`. `bash -n`
# fångar det INTE (expansionsfel, inte syntaxfel). Använd ASCII i kod-rader och
# ${KLAMMER} när text möter variabel.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"
# ⚠️ SPANNET ÄR VIDARE ÄN "1027-1080". Den siffran kom från en avläsning av
# Reporting-vyn — men vi ANVÄNDER 1081 (IP_REVENUE_DAY_REPORT), som ligger
# utanför. Avlästa intervall är en indikation, inte en gräns. Default svepet är
# därför medvetet bredare; kostnaden är 300 ms per tomt id.
FROM_ID="${1:-1020}"
TO_ID="${2:-1100}"
DAG="${3:-$(date -u -d 'yesterday' +%F 2>/dev/null || date -u -v-1d +%F)}"

echo "=== Mall-spaning: id ${FROM_ID}-${TO_ID}, sonderingsdag ${DAG} ==="
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
  echo "-- knackar på ${id}-${slut} ..."
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

bedomda   = [r for r in funna if r.get("schema_bedombar")]
obedombara = [r for r in funna if not r.get("schema_bedombar")]
if bedomda:
    print("\n-- BEDOMDA MALLAR (kolumner, ingen data) --")
    for r in sorted(bedomda, key=lambda x: -x.get("schema_score", 0)):
        flagga = "*" if r.get("schema_kandidat") else " "
        cols = r.get("columns") or []
        print(f"{flagga} {r['id']}  score {r.get('schema_score',0)}/4  {len(cols)} kol  {r.get('rows')} rader")
        print(f"      {', '.join(cols[:14])}{' ...' if len(cols) > 14 else ''}")
        print(f"      -> {r.get('schema_varfor','')}")
if obedombara:
    # En mall som svarade utan rubrikrad har inte forkastats - den har inte lasts.
    print(f"\n⚠️  {len(obedombara)} MALLAR GICK INTE ATT BEDOMA (svarade utan rubrikrad):")
    print("     " + ", ".join(r["id"] for r in obedombara))
    print("     Troligen ingen data pa sonderingsdagen. Kor om dem med bredare fonster:")
    print(f"       API_KEY=$API_KEY ./intelliplan_probe_ids.sh {','.join(r['id'] for r in obedombara[:25])}")

kand = [r for r in bedomda if r.get("schema_kandidat")]
print("\n═══ SLUTSATS ═══")
if fel:
    print("⚠️  Ofullständig skanning — se ovan. Slutsatsen nedan kan sakna mallar.")
if kand:
    b = max(kand, key=lambda x: x.get("schema_score", 0))
    print(f"⭐ {len(kand)} mall(ar) med datum + tid + konsult. Börja med id {b['id']}.")
    print(f"   Nästa: REPORT-id {b['id']} → kolumnprofilera med ./intelliplan_probe.sh {b['id']} <från> <till>")
elif bedomda and obedombara:
    print(f"Ingen av de {len(bedomda)} BEDOMDA mallarna har datum + tid + konsult.")
    print(f"⚠️  Men {len(obedombara)} gick inte att bedoma - kor om dem forst.")
    print("   Slutsatsen 'mallen finns inte' haller inte forran de ar lasta.")
elif bedomda:
    print(f"Ingen av {len(bedomda)} mallar har datum + tid + konsult.")
    print("-> Pass-kornighet finns inte i nagon BEFINTLIG mall. Bygg en via")
    print('  "Add columns" i Reporting-vyn: datum, starttid, sluttid, konsult, kund.')
else:
    print("Inga mallar alls i spannet — kontrollera intervallet.")
PY
