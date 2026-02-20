#!/usr/bin/env bash
set -euo pipefail

# Fingerprint so you can confirm the cron is running the correct script version
echo "[offers-10min] SCRIPT_FINGERPRINT=2026-02-20_v4_retry"

HOST="${HOST:-https://mira-exchange.onrender.com}"
CID="${FORTNOX_CONNECTION_ID:?Missing FORTNOX_CONNECTION_ID}"
APIKEY="${MIRA_RENDER_API_KEY:?Missing MIRA_RENDER_API_KEY}"

# Small buffer to avoid hitting the web service during cold start / deploy restart windows
sleep "${STARTUP_SLEEP_SECONDS:-5}"

echo "[offers-10min] host=$HOST cid=$CID"

post_json () {
  local path="$1"
  local payload="$2"
  local attempts="${3:-6}"
  local sleep_s="${4:-5}"

  local i resp body code
  for i in $(seq 1 "$attempts"); do
    # Capture body + HTTP code
    resp="$(curl -sS -X POST "$HOST$path" \
      -H "Content-Type: application/json" \
      -H "x-api-key: $APIKEY" \
      -d "$payload" \
      -w $'\n%{http_code}\n' || true)"

    # Safer split: last line = status code, everything before = body
    code="$(printf "%s" "$resp" | tail -n 1)"
    body="$(printf "%s" "$resp" | sed '$d')"

    # Empty body → retry
    if [[ -z "${body//[[:space:]]/}" ]]; then
      echo "⚠️  [$path] attempt $i/$attempts: empty body (http=$code)"
    # Non-2xx → print and retry/fail
    elif [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
      echo "⚠️  [$path] attempt $i/$attempts: http=$code body:"
      echo "$body"
    else
      # Ensure it's JSON (avoid HTML error pages breaking downstream parsing)
      if ! python3 - <<'PY' "$body" >/dev/null 2>&1
import sys, json
json.loads(sys.argv[1])
PY
      then
        echo "⚠️  [$path] attempt $i/$attempts: non-JSON body (http=$code), first 200 chars:"
        echo "${body:0:200}"
      else
        printf "%s" "$body"
        return 0
      fi
    fi

    if [[ "$i" -lt "$attempts" ]]; then
      sleep "$sleep_s"
    fi
  done

  echo "❌ [$path] failed after $attempts attempts"
  exit 1
}

# 1) Fetch TotalResources (limit=1)
offers_list_json="$(post_json "/fortnox/sync/offers" "{\"connection_id\":\"$CID\",\"page\":1,\"limit\":1}" "${ATTEMPTS_SYNC:-6}" "${SLEEP_SYNC:-5}")"

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

LIMIT_PER_PAGE="${LIMIT_PER_PAGE:-100}"

LAST_PAGE="$(
  python3 - <<PY "$TOTAL_RESOURCES" "$LIMIT_PER_PAGE"
import sys, math
total = int(sys.argv[1])
limit = int(sys.argv[2])
print(max(1, math.ceil(total / limit)))
PY
)"

echo "[offers-10min] total_resources=$TOTAL_RESOURCES limit=$LIMIT_PER_PAGE last_page=$LAST_PAGE"

# 2) Upsert last page (and optionally PDFs)
FETCH_PDF="${FETCH_PDF:-true}"
PDF_MISSING_ONLY="${PDF_MISSING_ONLY:-true}"
PDF_MAX_PER_PAGE="${PDF_MAX_PER_PAGE:-20}"
PDF_PAUSE_MS="${PDF_PAUSE_MS:-500}"

upsert_payload="$(cat <<JSON
{
  "connection_id": "$CID",
  "page": $LAST_PAGE,
  "limit": $LIMIT_PER_PAGE,
  "fetch_pdf": $FETCH_PDF,
  "pdf_missing_only": $PDF_MISSING_ONLY,
  "pdf_max_per_page": $PDF_MAX_PER_PAGE,
  "pdf_pause_ms": $PDF_PAUSE_MS
}
JSON
)"

upsert_json="$(post_json "/fortnox/upsert/offers" "$upsert_payload" "${ATTEMPTS_UPSERT:-6}" "${SLEEP_UPSERT:-5}")"
echo "$upsert_json"
echo "[offers-10min] done"
