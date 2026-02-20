#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
CID="${FORTNOX_CONNECTION_ID:?Missing FORTNOX_CONNECTION_ID}"
APIKEY="${MIRA_RENDER_API_KEY:?Missing MIRA_RENDER_API_KEY}"

echo "[offers-10min] host=$HOST cid=$CID"

post_json () {
  local path="$1"
  local payload="$2"

  # Capture body + status code safely
  local resp body code
  resp="$(curl -sS -X POST "$HOST$path" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $APIKEY" \
    -d "$payload" \
    -w $'\n%{http_code}\n' || true)"

  body="$(printf "%s" "$resp" | sed '$d' | sed '$d')"   # all but last 2 lines
  code="$(printf "%s" "$resp" | tail -n 1)"

  # If body is empty, show a clear error
  if [[ -z "${body//[[:space:]]/}" ]]; then
    echo "❌ [$path] empty response body (http=$code)"
    exit 1
  fi

  # Non-2xx => print body and fail
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "❌ [$path] http=$code"
    echo "$body"
    exit 1
  fi

  printf "%s" "$body"
}

# 1) Hämta TotalResources (med limit=1)
offers_list_json="$(post_json "/fortnox/sync/offers" "{\"connection_id\":\"$CID\",\"page\":1,\"limit\":1}")"

TOTAL_RESOURCES="$(
  python3 - <<'PY' "$offers_list_json"
import sys, json
raw = sys.argv[1]
j = json.loads(raw)

# Förvänta ok:true
if not j.get("ok", False):
    raise SystemExit(f"API returned ok=false: {j}")

meta = j.get("meta") or {}
# Fortnox brukar ge @TotalResources, men vi tolererar flera varianter
total = meta.get("@TotalResources") or meta.get("TotalResources") or meta.get("total_resources")
if total is None:
    raise SystemExit(f"Missing meta total resources. meta={meta}")
print(int(total))
PY
)"

# 2) Räkna ut sista sidan för limit=100
LAST_PAGE="$(
  python3 - <<PY "$TOTAL_RESOURCES"
import sys, math
total = int(sys.argv[1])
print(max(1, math.ceil(total / 100)))
PY
)"

echo "[offers-10min] total_resources=$TOTAL_RESOURCES last_page=$LAST_PAGE"

# 3) Upsert sista sidan (senaste) + hämta PDF för max 20 saknade
upsert_payload="$(cat <<JSON
{
  "connection_id": "$CID",
  "page": $LAST_PAGE,
  "limit": 100,
  "fetch_pdf": true,
  "pdf_missing_only": true,
  "pdf_max_per_page": 20,
  "pdf_pause_ms": 500
}
JSON
)"

upsert_json="$(post_json "/fortnox/upsert/offers" "$upsert_payload")"
echo "$upsert_json"
echo
echo "[offers-10min] done"
