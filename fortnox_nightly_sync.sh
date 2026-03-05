#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-05_nightly_kickoff_days_v1"
echo "=== Fortnox nightly sync START ==="
echo "[nightly] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"

# NYTT: Kör max X dagar bakåt (default 7)
DAYS_BACK="${NIGHTLY_DAYS_BACK:-7}"

# Fallback om du vill kunna köra månader ibland
MONTHS_BACK="${NIGHTLY_MONTHS_BACK:-1}"

STUCK_MINUTES="${NIGHTLY_STUCK_MINUTES:-90}"

if [[ -z "$API_KEY" ]]; then
  echo "[nightly] ERROR: Missing env MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[nightly] HOST=$HOST DAYS_BACK=$DAYS_BACK (fallback MONTHS_BACK=$MONTHS_BACK) STUCK_MINUTES=$STUCK_MINUTES"

# 1) Status
STATUS_JSON="$(curl -sS --max-time 20 "$HOST/fortnox/nightly/status" -H "x-api-key: $API_KEY" || true)"
echo "[nightly] status: $STATUS_JSON"

# 2) Stuck unlock (samma som du hade)
if echo "$STATUS_JSON" | grep -q '"running":true'; then
  AGE_MS="$(echo "$STATUS_JSON" | sed -n 's/.*"age_ms":[[:space:]]*\([0-9]\+\).*/\1/p' | head -n 1 || true)"
  if [[ -n "${AGE_MS:-}" ]]; then
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
    echo "[nightly] Already running but no age_ms present. Exiting (no unlock)."
    echo "=== Fortnox nightly sync END ==="
    exit 0
  fi
fi

# 3) Kickoff
# Försök med days_back först (kräver minimal kodpatch i index.js, se nedan).
# Om backend inte stödjer days_back än, kan du temporärt byta BODY till months_back.
BODY="{\"days_back\":$DAYS_BACK,\"months_back\":$MONTHS_BACK}"
echo "[nightly] kickoff body: $BODY"

curl -sS --max-time 30 -X POST "$HOST/fortnox/nightly/kickoff" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY"

echo
echo "=== Fortnox nightly sync END ==="
