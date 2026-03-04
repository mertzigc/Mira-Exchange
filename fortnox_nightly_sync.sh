#!/usr/bin/env bash
set -euo pipefail

SCRIPT_FINGERPRINT="2026-03-05_nightly_kickoff_v1"
echo "=== Fortnox nightly sync START ==="
echo "[nightly] SCRIPT_FINGERPRINT=$SCRIPT_FINGERPRINT"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${MIRA_RENDER_API_KEY:-}"

# Hur långt bak nightly ska jobba (du ville inte 12 månader)
# Sätt i Render ENV: NIGHTLY_MONTHS_BACK=1 (rekommenderat)
MONTHS_BACK="${NIGHTLY_MONTHS_BACK:-1}"

# När vi ska våga unlocka om låset “fastnat”
# Sätt i Render ENV om du vill: NIGHTLY_STUCK_MINUTES=90
STUCK_MINUTES="${NIGHTLY_STUCK_MINUTES:-90}"

if [[ -z "$API_KEY" ]]; then
  echo "[nightly] ERROR: Missing env MIRA_RENDER_API_KEY" >&2
  exit 2
fi

echo "[nightly] HOST=$HOST MONTHS_BACK=$MONTHS_BACK STUCK_MINUTES=$STUCK_MINUTES"

# 1) Kolla status
STATUS_JSON="$(curl -sS --max-time 20 "$HOST/fortnox/nightly/status" -H "x-api-key: $API_KEY" || true)"
echo "[nightly] status: $STATUS_JSON"

# 2) Om nightly redan kör: avgör om den verkar “stuck” och unlocka försiktigt
if echo "$STATUS_JSON" | grep -q '"running":true'; then
  # Försök läsa age_ms (om finns). Om inte finns: avbryt utan unlock.
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

# 3) Kickoff (snabb 202 och sen sköter servern resten)
BODY="{\"months_back\":$MONTHS_BACK}"
echo "[nightly] kickoff body: $BODY"

curl -sS --max-time 30 -X POST "$HOST/fortnox/nightly/kickoff" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY"

echo
echo "=== Fortnox nightly sync END ==="
