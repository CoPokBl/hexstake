#!/usr/bin/env bash
# Prints the Komodo deployment's container state and recent logs (for diagnosing deploys).
set -uo pipefail
: "${KOMODO_URL:?}" "${KOMODO_API_KEY:?}" "${KOMODO_API_SECRET:?}" "${KOMODO_DEPLOYMENT:?}"
URL="${KOMODO_URL%/}"
TAIL="${1:-80}"
k() {
  curl -sS -X POST "$URL/$1" -H 'Content-Type: application/json' \
    -H "X-Api-Key: $KOMODO_API_KEY" -H "X-Api-Secret: $KOMODO_API_SECRET" --data "$2"
}
echo "== deployment state"
k read "$(jq -n --arg d "$KOMODO_DEPLOYMENT" '{type: "GetDeploymentActionState", params: {deployment: $d}}')" | jq -c . 2>/dev/null || true
k read "$(jq -n --arg d "$KOMODO_DEPLOYMENT" '{type: "ListDeployments", params: {query: {names: [$d]}}}')" \
  | jq -c '.[]? | {name, state: .info.state, status: .info.status, image: .info.image}' 2>/dev/null || true
echo "== container log (last $TAIL lines)"
k read "$(jq -n --arg d "$KOMODO_DEPLOYMENT" --argjson t "$TAIL" '{type: "GetDeploymentLog", params: {deployment: $d, tail: $t}}')" \
  | jq -r '"stdout:\n" + (.stdout // "") + "\nstderr:\n" + (.stderr // "") + (if .error then "\nerror: " + (.error|tostring) else "" end)' 2>/dev/null || true
