#!/bin/sh
set -e
API_KEY=${API_KEY:-testkey}
BASE_URL=${BASE_URL:-http://127.0.0.1:18088}
MODEL=${MODEL:-opencode/kimi-k2.5-free}

printf '== chat streaming smoke ==\n'
curl -sN "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hello with reasoning\"}],\"stream\":true}" | sed -n '1,12p'

printf '\n== responses streaming smoke ==\n'
curl -sN "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"hello from responses\",\"stream\":true}" | sed -n '1,18p'
