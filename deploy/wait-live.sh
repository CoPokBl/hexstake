#!/usr/bin/env bash
# Polls the public health endpoint until it reports the expected version.
set -uo pipefail
want="$1"
for i in $(seq 1 40); do
  got=$(curl -fsS --max-time 5 https://hexstake.app/healthz 2>/dev/null | jq -r .version 2>/dev/null || true)
  echo "attempt $i: live version=${got:-unreachable}"
  [[ "$got" == "$want" ]] && exit 0
  sleep 6
done
echo "::warning::new version not live after 4 minutes (wanted $want, got ${got:-unreachable})"
exit 1
