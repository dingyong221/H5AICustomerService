#!/usr/bin/env bash
set -euo pipefail

manifest=${1:-}
database_url=${H5CS_INTEGRATION_MYSQL_URL:-}
if [[ ${CI:-} != true || ${H5CS_E2E_PATH_MODE:-} != single_domain || ! -f $manifest || ! $database_url =~ ^mysql://h5cs_ci:[^@]+@127[.]0[.]0[.]1:3306/h5cs_integration_ci$ ]]; then
  echo 'Candidate browser images require the isolated CI MySQL and same-domain path mode.' >&2
  exit 64
fi

declare -A images
for app in api worker merchant-web consumer-h5 ops-web; do
  mapfile -t matches < <(grep -E "^ghcr[.]io/[a-z0-9_-]+/[a-z0-9_-]+/${app}@sha256:[0-9a-f]{64}$" "$manifest")
  if [[ ${#matches[@]} -ne 1 ]]; then
    echo "Candidate manifest must contain exactly one immutable ${app} image." >&2
    exit 64
  fi
  images[$app]=${matches[0]}
done
if [[ $(wc -l < "$manifest") -ne 5 ]]; then
  echo 'Candidate manifest contains unexpected entries.' >&2
  exit 64
fi

names=(h5cs-artifact-e2e-api h5cs-artifact-e2e-worker h5cs-artifact-e2e-ops h5cs-artifact-e2e-merchant h5cs-artifact-e2e-consumer)
for name in "${names[@]}"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "Container ${name} already exists; inspect it instead of replacing it." >&2
    exit 1
  fi
done

operator_password=$(node -e 'const {createHash}=require("node:crypto");process.stdout.write(createHash("sha256").update("h5cs-isolated-browser-operator:").update(process.argv[1]).digest("base64url"))' "$database_url")
operator_hash=$(node -e 'const {randomBytes,scryptSync}=require("node:crypto");const salt=randomBytes(16);process.stdout.write(`scrypt:${salt.toString("base64url")}:${scryptSync(process.argv[1],salt,64).toString("base64url")}`)' "$operator_password")
model_key=$(node -e 'const {createHash}=require("node:crypto");process.stdout.write(createHash("sha256").update("h5cs-isolated-browser-model:").update(process.argv[1]).digest("base64url"))' "$database_url")
session_key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')
phone_key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')
visitor_key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')

started=false
cleanup_on_failure() {
  if [[ $started != true ]]; then
    docker rm --force "${names[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_failure EXIT

runtime=(--detach --rm --network host --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --cap-drop ALL --security-opt no-new-privileges)

docker run "${runtime[@]}" --name h5cs-artifact-e2e-api \
  --env NODE_ENV=test --env HOST=127.0.0.1 --env PORT=4000 \
  --env "MYSQL_DATABASE_URL=$database_url" --env OAUTH_ISSUER=https://smoke.invalid \
  --env PUBLIC_CONVERSATION_ENABLED=true --env CONSUMER_H5_ORIGIN=http://127.0.0.1:3001 \
  --env "VISITOR_CREDENTIAL_HMAC_KEY=$visitor_key" "${images[api]}" >/dev/null

docker run "${runtime[@]}" --name h5cs-artifact-e2e-worker \
  --env NODE_ENV=test --env WORKER_HEALTH_HOST=127.0.0.1 --env WORKER_POLL_INTERVAL_MS=1000 \
  --env "MYSQL_DATABASE_URL=$database_url" --env CONVERSATION_WORKER_ENABLED=true \
  --env MODEL_PROVIDER=chat_completions --env MODEL_NAME=browser-test-model \
  --env "MODEL_API_KEY=$model_key" --env MODEL_CHAT_COMPLETIONS_URL=http://127.0.0.1:9020/chat/completions \
  "${images[worker]}" >/dev/null

docker run "${runtime[@]}" --name h5cs-artifact-e2e-ops \
  --env NODE_ENV=test --env HOSTNAME=127.0.0.1 --env PORT=3002 \
  --env "MYSQL_DATABASE_URL=$database_url" --env OPS_ADMIN_USERNAME=browser_test_operator \
  --env "OPS_ADMIN_PASSWORD_HASH=$operator_hash" --env "OPS_SESSION_SIGNING_KEY=$session_key" \
  --env OPS_PUBLIC_ORIGIN=http://127.0.0.1:3001 \
  --env MANAGEMENT_CONSOLE_URL=http://127.0.0.1:3001/console \
  "${images[ops-web]}" >/dev/null

docker run "${runtime[@]}" --name h5cs-artifact-e2e-merchant \
  --env NODE_ENV=test --env HOSTNAME=127.0.0.1 --env PORT=3000 \
  --env "MYSQL_DATABASE_URL=$database_url" --env MERCHANT_PUBLIC_ORIGIN=http://127.0.0.1:3001 \
  --env "MERCHANT_PHONE_LOOKUP_KEY=$phone_key" --env CONSUMER_H5_ORIGIN=http://127.0.0.1:3001 \
  --env PUBLIC_CONVERSATION_ENABLED=true --env CONVERSATION_WORKER_ENABLED=true \
  --env MODEL_PROVIDER=chat_completions --env MODEL_NAME=browser-test-model \
  --env PUBLISH_PROMPT_TEMPLATE_VERSION=browser-v1 \
  --env PUBLISH_RETRIEVAL_POLICY_VERSION=browser-v1 \
  --env PUBLISH_MODEL_POLICY_VERSION=browser-v1 \
  --env API_READINESS_URL=http://127.0.0.1:4000/readyz \
  --env WORKER_READINESS_URL=http://127.0.0.1:3011/readyz \
  "${images[merchant-web]}" >/dev/null

docker run "${runtime[@]}" --name h5cs-artifact-e2e-consumer \
  --env NODE_ENV=production --env HOSTNAME=127.0.0.1 --env PORT=3003 \
  --env CONSUMER_H5_ORIGIN=http://127.0.0.1:3001 \
  "${images[consumer-h5]}" >/dev/null

for entry in api:4000:/readyz worker:3011:/readyz ops:3002:/ops/login merchant:3000:/console/account/login consumer:3003:/; do
  IFS=: read -r service port path <<< "$entry"
  ready=false
  for _ in $(seq 1 60); do
    if [[ $(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}${path}" || true) == 200 ]]; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ $ready != true ]]; then
    echo "Candidate ${service} did not become ready." >&2
    exit 1
  fi
  echo "Candidate ${service}: ready"
done

started=true
echo 'Five immutable candidate images are ready for the isolated browser workflow.'

