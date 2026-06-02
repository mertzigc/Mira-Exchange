#!/bin/bash
# Loopar /fortnox/enrich/invoices/zero-net tills found < 100 för en connection
# Användning: ./enrich_zero_net.sh <connection_id>

CONN="${1:?Ange connection_id som första argument}"
i=0
total=0

while true; do
  i=$((i+1))
  result=$(curl -s -X POST "$HOST/fortnox/enrich/invoices/zero-net" \
    -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d "{\"connection_id\":\"$CONN\",\"limit\":200}")

  found=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["found"])')
  enriched=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["counts"]["enriched"])')
  errors=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["counts"]["errors"])')

  total=$((total + enriched))
  echo "Round $i: found=$found enriched=$enriched errors=$errors total_so_far=$total"

  if [ "$found" -lt 100 ]; then
    echo "DONE: $total fakturor enrichade totalt över $i rundor"
    break
  fi

  # Skydd mot oändlig loop (max 200 rundor = 20 000 fakturor)
  if [ "$i" -gt 200 ]; then
    echo "STOP: max rundor uppnådda. Total: $total"
    break
  fi

  sleep 1
done
