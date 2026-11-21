#!/usr/bin/env bash
# Points the Komodo deployment at the freshly built image tag, applies the non-secret
# environment from deploy/env, then redeploys. Runs inside GitHub Actions on the tailnet.
set -euo pipefail
: "${KOMODO_URL:?}" "${KOMODO_API_KEY:?}" "${KOMODO_API_SECRET:?}" "${KOMODO_DEPLOYMENT:?}" "${IMAGE_TAG:?}"
URL="${KOMODO_URL%/}"

komodo() { # komodo <read|write|execute> <json>
  local out code
  out=$(curl -sS -w '\n%{http_code}' -X POST "$URL/$1" \
    -H 'Content-Type: application/json' \
    -H "X-Api-Key: $KOMODO_API_KEY" -H "X-Api-Secret: $KOMODO_API_SECRET" \
    --data "$2")
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ "$code" == 401 || "$code" == 403 ]]; then
    # Never retry on auth failures: Komodo locks the user out after a few bad attempts.
    echo "::error::Komodo rejected the API credentials ($code): $out" >&2
    exit 2
  fi
  if [[ "$code" != 2* ]]; then
    echo "Komodo $1 failed ($code): $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

ENV_BLOCK=$(grep -vE '^\s*(#|$)' deploy/env | sed "s|__IMAGE_TAG__|$IMAGE_TAG|")
CONFIG=$(jq -n --arg image "ghcr.io/copokbl/hexstake:$IMAGE_TAG" --arg env "$ENV_BLOCK" \
  '{image: {type: "Image", params: {image: $image}}, environment: $env}')

echo "Updating deployment $KOMODO_DEPLOYMENT -> $IMAGE_TAG"
komodo write "$(jq -n --arg id "$KOMODO_DEPLOYMENT" --argjson config "$CONFIG" \
  '{type: "UpdateDeployment", params: {id: $id, config: $config}}')" > /dev/null \
  || echo "::warning::UpdateDeployment failed; deploying with existing config"

echo "Deploying"
UPDATE=$(komodo execute "$(jq -n --arg d "$KOMODO_DEPLOYMENT" '{type: "Deploy", params: {deployment: $d}}')") || exit 1
UPDATE_ID=$(jq -r '._id["$oid"] // ._id // empty' <<<"$UPDATE")
echo "Komodo update $UPDATE_ID queued"

# Execute returns as soon as the job is queued; wait for it to finish and show what happened.
for i in $(seq 1 60); do
  U=$(komodo read "$(jq -n --arg id "$UPDATE_ID" '{type: "GetUpdate", params: {id: $id}}')") || break
  STATUS=$(jq -r '.status' <<<"$U")
  if [[ "$STATUS" == "Complete" ]]; then
    jq -r '.logs[]? | "--- \(.stage) (success=\(.success))\n\(.stdout // "")\(.stderr // "")"' <<<"$U" | cut -c1-400 | tail -60
    if [[ "$(jq -r '.success' <<<"$U")" != "true" ]]; then
      echo "::error::Komodo deploy failed (see stages above)"
      exit 1
    fi
    echo "Komodo deploy complete"
    exit 0
  fi
  sleep 3
done
echo "::warning::Komodo update still $STATUS after 3 minutes"
