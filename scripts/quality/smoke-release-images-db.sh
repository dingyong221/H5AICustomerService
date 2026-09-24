#!/usr/bin/env bash
set -euo pipefail

database_url="${H5CS_INTEGRATION_MYSQL_URL:-}"
if [[ "${CI:-}" != 'true' || ! "$database_url" =~ ^mysql://h5cs_ci:[^@]+@127[.]0[.]0[.]1:3306/h5cs_integration_ci$ ]]; then
  printf 'Database image smoke is restricted to the isolated CI MySQL instance.\n' >&2
  exit 64
fi

api_container='h5cs-api-db-smoke'
worker_container='h5cs-worker-db-smoke'
cleanup() {
  docker rm --force "$api_container" "$worker_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --rm \
  --name "$api_container" \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 1280m \
  --env NODE_ENV=test \
  --env "MYSQL_DATABASE_URL=$database_url" \
  --env OAUTH_ISSUER=https://smoke.invalid \
  --env PUBLIC_CONVERSATION_ENABLED=false \
  h5cs-api:ci >/dev/null

docker run --detach --rm \
  --name "$worker_container" \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 1536m \
  --env NODE_ENV=test \
  --env "MYSQL_DATABASE_URL=$database_url" \
  --env CONVERSATION_WORKER_ENABLED=false \
  h5cs-worker:ci >/dev/null

probe() {
  local service="$1"
  local port="$2"
  local expected_status="$3"
  local container="$4"
  local response=''
  local body=''
  local status='000'

  for _ in $(seq 1 45); do
    response="$(curl --silent --show-error --max-time 2 \
      --write-out '\n%{http_code}' "http://127.0.0.1:${port}/readyz" 2>/dev/null || true)"
    status="${response##*$'\n'}"
    body="${response%$'\n'*}"
    if [[ "$status" == "$expected_status" ]] && printf '%s' "$body" | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        try {
          const result = JSON.parse(input).data;
          if (result?.service !== process.argv[1] || result.checks?.database?.status !== "up") process.exitCode = 1;
        } catch {
          process.exitCode = 1;
        }
      });
    ' "$service"; then
      printf '%s packaged runtime: MySQL probe up; readiness HTTP %s\n' "$service" "$status"
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != 'true' ]]; then
      break
    fi
    sleep 1
  done

  printf '%s packaged runtime MySQL probe failed; last HTTP status %s\n' "$service" "$status" >&2
  docker logs --tail 60 "$container" >&2 || true
  return 1
}

probe api 4000 200 "$api_container"
# The worker deliberately has conversation dispatch disabled: DB must be up, while overall
# readiness remains 503 rather than claiming it can answer without a real model.
probe worker 3011 503 "$worker_container"
