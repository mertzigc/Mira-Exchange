#!/usr/bin/env bash
# Seed:ar / uppdaterar Fas 5-mallar till Bubble.
#   • Om mall med samma namn finns → PATCH (skapar ny version, superseded_by på gamla)
#   • Annars POST (skapar version=1)
# Kör: bash contract_templates/seed.sh
# Kräver env-vars: HOST, PLANNING_ADMIN_TOKEN

set -euo pipefail
: "${HOST:?HOST saknas — sätt t.ex. https://mira-exchange.onrender.com}"
: "${PLANNING_ADMIN_TOKEN:?PLANNING_ADMIN_TOKEN saknas}"

cd "$(dirname "$0")"

echo "→ Hämtar existerande mallar (inkl. historik)..."
EXISTING_JSON=$(curl -s "$HOST/admin/contract-templates?include_superseded=1" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN")

find_id_by_name() {
  local name="$1"
  echo "$EXISTING_JSON" | python3 -c "
import json, sys
name = sys.argv[1]
d = json.load(sys.stdin)
# Hitta AKTIV (superseded_by tomt) mall med detta namn
for t in d.get('templates', []):
    if t.get('name') == name and not t.get('superseded_by'):
        print(t.get('_id',''))
        break
" "$name"
}

seed_file() {
  local file="$1"
  local name
  name=$(python3 -c "import json; print(json.load(open('$file'))['name'])")

  local existing_id
  existing_id=$(find_id_by_name "$name")

  local response method url
  if [[ -n "$existing_id" ]]; then
    method="PATCH"
    url="$HOST/admin/contract-templates/$existing_id"
    echo "  ↻ $name — PATCH:ar (ny version)..."
  else
    method="POST"
    url="$HOST/admin/contract-templates"
    echo "  ↑ $name — POST:ar (ny mall)..."
  fi

  response=$(curl -s -X "$method" "$url" \
    -H "x-admin-token: $PLANNING_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d @"$file")

  local id_or_err
  id_or_err=$(echo "$response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('ok'):
    t = d.get('template', {})
    v = t.get('version', 1)
    print(f'v{v} · {t.get(\"_id\",\"(no id)\")}')
else:
    print('ERROR: ' + str(d.get('error','unknown')))
")
  echo "     → $id_or_err"
}

echo ""
echo "→ Seedar/uppdaterar mallar från contract_templates/*.json:"
for f in *.json; do
  seed_file "$f"
done

echo ""
echo "→ Klar. Aktiva mallar i Bubble efter körning:"
curl -s "$HOST/admin/contract-templates" \
  -H "x-admin-token: $PLANNING_ADMIN_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  {d.get(\"count\", 0)} aktiva mallar:')
for t in d.get('templates', []):
    ds = t.get('default_spec_json', {})
    if isinstance(ds, str):
        try: ds = json.loads(ds)
        except: ds = {}
    fs = ds.get('form_schema', {}) if isinstance(ds, dict) else {}
    n_fields = sum(len(s.get('fields',[])) for s in fs.get('sections',[]))
    schema_note = f' · schema: {len(fs.get(\"sections\",[]))} sek/{n_fields} fält' if fs else ' · ⚠ inget schema'
    print(f'    • {t[\"name\"]} (v{t.get(\"version\",1)}){schema_note}')
"
