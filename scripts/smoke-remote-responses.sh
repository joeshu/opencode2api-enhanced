#!/bin/sh
set -e
[ -n "$ALI" ] || { echo 'ALI not set'; exit 1; }
[ -n "$API_KEY" ] || { echo 'API_KEY not set'; exit 1; }
sshpass -p "$ALI" ssh -o StrictHostKeyChecking=accept-new root@118.190.200.12 '
set -e
printf "== responses smoke ==\n"
curl -sS -m 90 http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer '$API_KEY'" \
  -H "Content-Type: application/json" \
  -d '\''{"model":"opencode/kimi-k2.5-free","input":"请回复 ok","stream":false}'\''
printf "\n"
'
