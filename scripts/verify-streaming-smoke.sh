#!/bin/sh
set -e
API_KEY=${API_KEY:-testkey}
BASE_URL=${BASE_URL:-http://127.0.0.1:18088}
MODEL=${MODEL:-}
AUTH_HEADER="Authorization: Bearer $API_KEY"

if [ -z "$MODEL" ]; then
  MODEL=$(curl -sS "$BASE_URL/v1/models" -H "$AUTH_HEADER" | python3 -c 'import sys,json; data=json.load(sys.stdin); print((data.get("data") or [{}])[0].get("id","opencode/gpt-5-nano"))')
fi

printf '== model ==\n%s\n' "$MODEL"

printf '== chat streaming smoke ==\n'
curl -sN "$BASE_URL/v1/chat/completions" \
  -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hello with reasoning\"}],\"stream\":true}" | sed -n '1,12p'

printf '\n== responses streaming smoke ==\n'
curl -sN "$BASE_URL/v1/responses" \
  -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"hello from responses\",\"stream\":true}" | sed -n '1,18p'
