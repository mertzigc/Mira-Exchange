#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-https://mira-exchange.onrender.com}"
CID="${FORTNOX_CONNECTION_ID:?Missing FORTNOX_CONNECTION_ID}"
APIKEY="${MIRA_RENDER_API_KEY:?Missing MIRA_RENDER_API_KEY}"

echo "[offers-10min] host=$HOST cid=$CID"

post_json () {
  local path="$1"
  local payload="$2"
  local attempts="${3:-5}"
  local sleep_s="${4:-4}"

  local i resp body code
  for i in $(seq 1 "$attempts"); do
    resp="$(curl -sS -X POST "$HOST$path" \
      -H "Content-Type: application/json" \
      -H "x-api-key: $APIKEY" \
      -d "$payload" \
      -w $'\n%{http_code}\n' || true)"

    body="$(printf "%s" "$resp" | sed '$d' | sed '$d')"
    code="$(printf "%s" "$resp" | tail -n 1)"

    # Normalize body check (empty or whitespace only)
    if [[ -z "${body//[[:space:]]/}" ]]; then
      echo "⚠️  [$path] attempt $i/$attempts: empty body (http=$code)"
    elif [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
      echo "⚠️  [$path] attempt $i/$attempts: http=$code body:"
      echo "$body"
    else
      printf "%s" "$body"
      return 0
    fi

    # Retry if not last attempt
    if [[ "$i" -lt "$attempts" ]]; then
      sleep "$sleep_s"
    fi
  done

  echo "❌ [$path] failed after $attempts attempts"
  exit 1
}

# 1) Hämta TotalResources (limit=1)
offers_list_json="$(post_json "/fortnox/sync/offers" "{\"connection_id\":\"$CID\",\"page\":1,\"limit\":1}" 6 5)"

TOTAL_RESOURCES="$(
  python3 - <<'PY' "$offers_list_json"
import sys, json
raw = sys.argv[1]
j = json.loads(raw)
if not j.get("ok", False):
    raise SystemExit(f"API ok=false: {j}")
meta = j.get("meta") or {}
total = meta.get("@TotalResources") or meta.get("TotalResources") or meta.get("total_resources")
if total is None:
    raise SystemExit(f"Missing meta total resources. meta={meta}")
print(int(total))
PY
)"

LAST_PAGE="$(
  python3 - <<PY "$TOTAL_RESOURCES"
import sys, math
total = int(sys.argv[1])
print(max(1, math.ceil(total / 100)))
PY
)"

echo "[offers-10min] total_resources=$TOTAL_RESOURCES last_page=$LAST_PAGE"

# 2) Upsert senaste sidan (och ev pdf)
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

upsert_json="$(post_json "/fortnox/upsert/offers" "$upsert_payload" 6 5)"
echo "$upsert_json"
echo "[offers-10min] done"
