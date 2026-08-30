#!/bin/bash
# kolla_nycklar.sh — verifierar att sessionens nycklar faktiskt fungerar.
# Skriver ALDRIG ut nyckelvarden, bara OK/FEL och hur manga tecken de ar.
#
#   bash kolla_nycklar.sh
#
# Kor den forst i varje session. Den svarar pa fragan "ar jag inloggad mot ratt
# sak med ratt nyckel" innan du hinner tolka ett 401 som nagot annat.

mask () { if [ -z "$1" ]; then echo "TOM"; else echo "satt (${#1} tecken)"; fi; }
ok ()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
fel ()  { printf '  \033[31mFEL\033[0m   %s\n' "$1"; }

echo "== Variabler i den har shellen =="
echo "  HOST                 = ${HOST:-TOM}"
echo "  KEY                  = $(mask "$KEY")"
echo "  MIRA_RENDER_API_KEY  = $(mask "$MIRA_RENDER_API_KEY")"
echo "  BUBBLE_API_KEY       = $(mask "$BUBBLE_API_KEY")"
echo "  SYNC_SECRET          = $(mask "$SYNC_SECRET")"
echo "  PLANNING_ADMIN_TOKEN = $(mask "$PLANNING_ADMIN_TOKEN")"

case "$HOST" in
  http*) ;;
  *) echo; fel "HOST ar inte en URL. Ska vara https://mira-exchange.onrender.com"; exit 1 ;;
esac

echo
echo "== Render =="
ver=$(curl -sS --max-time 30 "$HOST/version" 2>/dev/null)
if [ -n "$ver" ]; then ok "/version svarar: $(echo "$ver" | tr -d '\n' | cut -c1-120)"
else fel "/version svarar inte — sover tjansten? Vanta 30 s och prova igen."; fi

for namn in KEY MIRA_RENDER_API_KEY; do
  eval "v=\$$namn"
  [ -z "$v" ] && { fel "$namn ar tom"; continue; }
  kod=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 40 \
        -H "x-api-key: $v" "$HOST/admin/invite/list?kind=news" 2>/dev/null)
  case "$kod" in
    200) ok  "$namn accepteras som x-api-key" ;;
    401) fel "$namn ger 401 — fel nyckel for den har tjansten" ;;
    *)   fel "$namn gav HTTP $kod (oklart — kolla att tjansten ar vaken)" ;;
  esac
done

echo
echo "== Bubble =="
if [ -z "$BUBBLE_API_KEY" ]; then
  fel "BUBBLE_API_KEY ar tom"
else
  kod=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 40 \
        -H "Authorization: Bearer $BUBBLE_API_KEY" \
        "https://mira-fm.com/api/1.1/obj/ClientCompany?limit=1" 2>/dev/null)
  case "$kod" in
    200) ok  "BUBBLE_API_KEY laser Data API" ;;
    401|403) fel "BUBBLE_API_KEY ger $kod — fel nyckel eller saknar rattigheter" ;;
    *)   fel "BUBBLE_API_KEY gav HTTP $kod" ;;
  esac
fi

echo
echo "Anvand den variabel som star OK ovan. Star bada OK racker KEY."
