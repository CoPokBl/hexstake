#!/usr/bin/env bash
# Polls the public health endpoint until it reports the expected version.
set -uo pipefail
want="$1"
for i in $(seq 1 40); do
  out=$(curl -sS --max-time 8 -w '\n%{http_code}' https://hexstake.app/healthz 2>&1)
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  got=$(jq -r .version 2>/dev/null <<<"$body" || true)
  echo "attempt $i: http=$code version=${got:-?} ${body:0:160}"
  [[ "$got" == "$want" ]] && exit 0
  sleep 6
done
echo "::warning::new version not live after 4 minutes (wanted $want)"
exit 1
