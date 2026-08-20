#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# intelliplan_cron.sh — nattlig synk av Intelliplan-rapporterna → Bubble.
#
#   1081  intäkt per dag och kontor   → IntelliplanRevenueDay
#   1058  intäkt per kund och order   → IntelliplanOrderMonth + IntelliplanAccount
#
# ⚠️ SCOPE: Intelliplan är BARA Carotte Staff (Service & People). Talen här är
# INTE koncernens. Housekeeping ligger i FortnoxOrder(TENGELLA), Food & Event i
# FortnoxOrder(FE) + MiraOrder. Se bokningslage.js.
#
# ⚠️ VARFÖR HELA PERIODER OCH INTE DELTA: en månad VÄXER efter månadsskiftet —
# arbete utfört i juni faktureras/rapporteras in i juli. Juli mitt i månaden
# hade 1 024 rader mot junis 2 315. En engångsläsning skulle frysa fel siffror.
# Därför läses de senaste MONTHS hela månaderna om varje natt. Upserten är
# idempotent (ip_key), och patchar bara när ett MÄTVÄRDE ändrats — en oförändrad
# månad kostar alltså läsning men skriver ingenting.
#
# WU-kostnad: befintliga rader läses constraintat på period/datum, aldrig som
# helsvep. 3 månader ≈ 3 × (1 period-query + ändrade rader). Höj inte MONTHS
# "för säkerhets skull" — backfill görs som en engångskörning, inte varje natt.
#
# Användning:
#   ./intelliplan_cron.sh              # skarpt, senaste 3 hela månaderna
#   MONTHS=12 ./intelliplan_cron.sh    # engångs-backfill
#   DRY=1 ./intelliplan_cron.sh        # torrkörning, skriver inget
#
# Env (Render Cron Job): HOST, API_KEY (eller MIRA_RENDER_API_KEY). MONTHS=3.
#   Intelliplan-hemligheterna (INTELLIPLAN_CLIENT_ID/SECRET/TENANT) bor på
#   web-tjänsten, inte här — cron pratar bara med Mira-Exchange.
#
# Schemaläggning: efter midnatt svensk tid, och EFTER fortnox/tengella-jobben
# så att ClientCompany-mappningen är färsk när kontona matchas.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-https://mira-exchange.onrender.com}"
API_KEY="${API_KEY:-${MIRA_RENDER_API_KEY:-}}"
: "${API_KEY:?API_KEY (eller MIRA_RENDER_API_KEY) saknas}"
MONTHS="${MONTHS:-3}"

echo "=== Intelliplan nightly sync START @ $(date -u +%FT%TZ) ==="
echo "HOST=$HOST MONTHS=$MONTHS DRY=${DRY:-0}"

# ── Preflight 1: vilken kod är live? ─────────────────────────────────────────
# 2026-08-20 tolkades ett svar från en deploy som aldrig landat som ett
# datafaktum. Cron-loggen ska alltid säga vilken commit som körde.
echo "--- /version ---"
curl -sS --max-time 30 "$HOST/version" | python3 -m json.tool 2>/dev/null || echo "  (kunde inte läsa /version)"

# ── Preflight 2: token mot Intelliplan ───────────────────────────────────────
# Utan detta blir ett utgånget client_secret till "0 rader synkade" långt ner i
# loggen i stället för ett tydligt auth-fel överst.
# Manuell statuskoll i st.f. --fail-with-body: den flaggan kräver curl ≥ 7.76 och
# Renders image är inte verifierad. En okänd flagga hade gett "auth misslyckades"
# fast auth var frisk — fel diagnos är värre än ingen.
echo "--- /admin/intelliplan/auth/test?force=1 ---"
auth_rc=0
auth_body=$(curl -sS --max-time 60 -w $'\n%{http_code}' \
  "$HOST/admin/intelliplan/auth/test?force=1" -H "x-api-key: $API_KEY") || auth_rc=$?
auth_http="${auth_body##*$'\n'}"
printf '%s\n' "${auth_body%$'\n'*}" | python3 -m json.tool 2>/dev/null || printf '%s\n' "${auth_body%$'\n'*}"
if [ "$auth_rc" -ne 0 ] || [ "$auth_http" != "200" ]; then
  echo "❌ Auth mot Intelliplan misslyckades (curl exit $auth_rc, HTTP $auth_http) — avbryter innan synken."
  echo "=== Intelliplan nightly sync ABORT @ $(date -u +%FT%TZ) ==="
  exit 1
fi
echo

# ── Synken ───────────────────────────────────────────────────────────────────
# intelliplan_sync.sh äger periodlogiken och exitkoden: den räknar misslyckade
# perioder och avslutar 1 om någon failade. Vi lägger inget eget `|| true` här —
# ett tyst grönt cron-jobb är värre än inget cron-jobb.
APPLY=(--apply)
[ "${DRY:-0}" = "1" ] && APPLY=()

rc=0
MONTHS="$MONTHS" HOST="$HOST" API_KEY="$API_KEY" ./intelliplan_sync.sh "${APPLY[@]}" || rc=$?

if [ "$rc" -ne 0 ]; then
  echo "=== Intelliplan nightly sync FAILED (exit $rc) @ $(date -u +%FT%TZ) ==="
  exit "$rc"
fi
echo "=== Intelliplan nightly sync END @ $(date -u +%FT%TZ) ==="
