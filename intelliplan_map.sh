#!/usr/bin/env bash
# Mappa Intelliplan-konton → ClientCompany. Tvåstegs, med en fil du redigerar.
#
#   API_KEY=... ./intelliplan_map.sh draft     # hämtar omappade → mapping.json
#   (redigera mapping.json)
#   API_KEY=... ./intelliplan_map.sh apply     # skickar in mappningarna
#
#   API_KEY=... ./intelliplan_map.sh confident # koppla bara ENTYDIGA automatiskt
#   API_KEY=... ./intelliplan_map.sh status    # hur många är mappade?
#
# ⚠️ Kontona är ANLÄGGNINGAR, inte bolag — Gothia Towers har fem konton. Flera
# konton SKA peka på samma ClientCompany. Det är förväntat, inte ett fel.
#
# ⚠️ Efter mappning: kör om berörda perioder med intelliplan_sync.sh, annars bär
# faktaraderna fortfarande ingen kundkoppling (den sätts vid synktillfället).
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:?Missing API_KEY}"
FILE="${FILE:-mapping.json}"
CMD="${1:-status}"
H=(-H "x-api-key: $API_KEY")

case "$CMD" in
  status)
    curl -sS --max-time 60 "${H[@]}" "$HOST/admin/intelliplan/accounts" \
      | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('ok'): print('✗', d.get('error'), d.get('hint') or ''); raise SystemExit(1)
print(f\"{d['count']} konton · {d['mapped']} mappade · {d['unmapped']} kvar · {d['confident_unmapped']} av dem entydiga\")
print(f\"({d['companies_in_cache']} ClientCompany i cachen att matcha mot)\")"
    ;;

  draft)
    # Toppförslaget förifylls. Poäng och 'via' följer med som stöd — prefixträff
    # (via=prefix) betyder att kontot hör till kundens grupp, inte att namnen
    # är identiska. Granska dem, ändra fritt, töm client_company_id för att hoppa över.
    curl -sS --max-time 60 "${H[@]}" "$HOST/admin/intelliplan/accounts?unmapped=1" \
      | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('ok'): print('✗', d.get('error'), d.get('hint') or '', file=sys.stderr); raise SystemExit(1)
out = []
for a in d['accounts']:
    s = (a.get('suggestions') or [{}])[0]
    out.append({
        'ip_account_id': a['ip_account_id'],
        '_konto': a['ip_account_name'],
        '_förslag': s.get('name'),
        '_poäng': s.get('score'),
        '_via': s.get('via'),
        'client_company_id': s.get('client_company_id') or '',
    })
out.sort(key=lambda x: (-(x['_poäng'] or 0), x['ip_account_id']))
json.dump(out, open('$FILE', 'w'), ensure_ascii=False, indent=2)
print(f\"Skrev {len(out)} omappade konton till $FILE\")
print('Redigera filen: ändra client_company_id, eller töm den för att hoppa över kontot.')
print('Kör sedan:  API_KEY=... ./intelliplan_map.sh apply')"
    ;;

  apply)
    [ -f "$FILE" ] || { echo "Hittar inte $FILE — kör 'draft' först." >&2; exit 1; }
    BODY=$(python3 -c "
import json
rows = json.load(open('$FILE'))
m = [{'ip_account_id': r['ip_account_id'], 'client_company_id': r['client_company_id']}
     for r in rows if str(r.get('client_company_id') or '').strip()]
print(json.dumps({'mappings': m}))")
    N=$(python3 -c "import json,sys; print(len(json.loads('''$BODY''')['mappings']))")
    echo "Skickar $N mappningar…"
    curl -sS --max-time 120 -X POST "$HOST/admin/intelliplan/accounts/map" \
      "${H[@]}" -H "Content-Type: application/json" -d "$BODY" | python3 -m json.tool
    ;;

  confident)
    # Bara EXAKTA helnamnsträffar. Prefixträffar ("Gothia Towers - Heaven 23")
    # rörs aldrig av den här — de kräver ett mänskligt ja.
    curl -sS --max-time 120 -X POST "$HOST/admin/intelliplan/accounts/map" \
      "${H[@]}" -H "Content-Type: application/json" \
      -d '{"apply_confident":true,"mappings":[]}' | python3 -m json.tool
    ;;

  *) echo "Okänt kommando: $CMD (status | draft | apply | confident)" >&2; exit 1 ;;
esac
