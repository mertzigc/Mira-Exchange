#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-05_nightly_run_v2"
echo "=== Fortnox nightly sync START ==="
echo "[nightly] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"
STUCK_MINUTES="${NIGHTLY_STUCK_MINUTES:-90}"

if [[ -z "$API_KEY" ]]; then
  echo "[nightly] ERROR: Missing env MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[nightly] HOST=$HOST STUCK_MINUTES=$STUCK_MINUTES"

# 1) Status (OBS: din route heter /fortnox//status i index-43.js)
STATUS_JSON="$(curl -sS --max-time 20 "$HOST/fortnox//status" -H "x-api-key: $API_KEY" || true)"
echo "[nightly] status: $STATUS_JSON"

# 2) Om running:true -> unlocka bara om stuck, annars avsluta
if echo "$STATUS_JSON" | grep -q '"running":true'; then
  STARTED_AT="$(echo "$STATUS_JSON" | sed -n 's/.*"started_at":[[:space:]]*\([0-9]\+\).*/\1/p' | head -n 1 || true)"
  NOW_MS="$(date +%s%3N)"

  if [[ -n "${STARTED_AT:-}" ]]; then
    AGE_MS=$((NOW_MS - STARTED_AT))
    STUCK_MS=$((STUCK_MINUTES * 60 * 1000))

    if (( AGE_MS > STUCK_MS )); then
      echo "[nightly] Detected stuck lock (age_ms=$AGE_MS > $STUCK_MS) -> unlocking..."
      curl -sS --max-time 20 -X POST "$HOST/fortnox/nightly/unlock" \
        -H "x-api-key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d '{}' || true
      echo
    else
      echo "[nightly] Already running and not stuck (age_ms=$AGE_MS). Exiting."
      echo "=== Fortnox nightly sync END ==="
      exit 0
    fi
  else
    echo "[nightly] Already running but could not parse started_at. Exiting (safe)."
    echo "=== Fortnox nightly sync END ==="
    exit 0
  fi
fi

# 3) Starta nightly (i index-43.js svarar den direkt och kör worker i bakgrunden)
echo "[nightly] Starting /fortnox/nightly/run ..."
curl -sS --max-time 30 -X POST "$HOST/fortnox/nightly/run" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'

echo
echo "=== Fortnox nightly sync END ==="
