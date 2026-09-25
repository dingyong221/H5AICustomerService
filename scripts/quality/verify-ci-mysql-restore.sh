#!/usr/bin/env bash
set -euo pipefail
umask 077

# This drill intentionally accepts only the disposable GitHub Actions database.
if [[ ${GITHUB_ACTIONS:-} != true || ${CI:-} != true ||
      ${H5CS_MYSQL_DATABASE:-} != h5cs_integration_ci ]]; then
  echo 'Refusing to run outside the disposable CI MySQL environment.' >&2
  exit 1
fi

source_container=$(docker compose --env-file .env.example \
  --file infra/compose/docker-compose.dev.yml ps -q mysql)
if [[ -z $source_container ||
      $(docker inspect "$source_container" --format '{{ index .Config.Labels "com.docker.compose.project" }}') != h5-ai-customer-service-dev ||
      $(docker inspect "$source_container" --format '{{ index .Config.Labels "com.docker.compose.service" }}') != mysql ]]; then
  echo 'The expected disposable Compose MySQL container is unavailable.' >&2
  exit 1
fi

scratch=$(mktemp -d "${RUNNER_TEMP:-/tmp}/h5cs-restore-drill.XXXXXXXX")
backup="$scratch/integration.sql.gz"
restore_container="h5cs-ci-restore-$$"
if docker container inspect "$restore_container" >/dev/null 2>&1; then
  echo 'The isolated restore container name is already in use; refusing to stop it.' >&2
  rmdir -- "$scratch"
  exit 1
fi
cleanup() {
  docker stop --time 30 "$restore_container" >/dev/null 2>&1 || true
  rm -f -- "$backup"
  rmdir -- "$scratch" 2>/dev/null || true
}
trap cleanup EXIT

readback_sql="SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='h5cs_integration_ci'),
  (SELECT COUNT(*) FROM h5cs_integration_ci.merchant),
  (SELECT COUNT(*) FROM h5cs_integration_ci.assistant),
  (SELECT COUNT(*) FROM h5cs_integration_ci.conversation_session),
  (SELECT COUNT(*) FROM h5cs_integration_ci.message),
  (SELECT SHA2(GROUP_CONCAT(CONCAT(HEX(id), ':', SHA2(content, 256)) ORDER BY id SEPARATOR '|'), 256)
     FROM h5cs_integration_ci.message),
  (SELECT COUNT(*) FROM h5cs_integration_ci.audit_log),
  (SELECT COUNT(*) FROM h5cs_integration_ci.job);"

mysql_readback() {
  local container=$1
  docker exec -i "$container" sh -ec \
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --skip-column-names' \
    <<< "$readback_sql"
}

before=$(mysql_readback "$source_container")
IFS=$'\t' read -r table_count merchant_count assistant_count session_count \
  message_count content_digest audit_count job_count <<< "$before"
if [[ ! $table_count =~ ^[0-9]+$ || $table_count -lt 20 ||
      ! $merchant_count =~ ^[0-9]+$ || $merchant_count -lt 1 ||
      ! $assistant_count =~ ^[0-9]+$ || $assistant_count -lt 1 ||
      ! $session_count =~ ^[0-9]+$ || $session_count -lt 1 ||
      ! $message_count =~ ^[0-9]+$ || $message_count -lt 2 ||
      ! $content_digest =~ ^[0-9a-f]{64}$ ||
      ! $audit_count =~ ^[0-9]+$ || $audit_count -lt 1 ||
      ! $job_count =~ ^[0-9]+$ || $job_count -lt 1 ]]; then
  echo 'Integration data is not sufficiently populated for a restore drill.' >&2
  exit 1
fi

docker exec "$source_container" sh -ec \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD; exec mysqldump --protocol=socket -uroot --single-transaction --set-gtid-purged=OFF --no-tablespaces --routines --events --triggers --hex-blob --databases h5cs_integration_ci' \
  | gzip -9 > "$backup"
gzip -t "$backup"
test -s "$backup"

image_id=$(docker inspect "$source_container" --format '{{.Image}}')
docker run --detach --rm --pull=never --name "$restore_container" --network none \
  --tmpfs /var/lib/mysql:rw,size=1g,mode=0700 \
  --env MYSQL_ROOT_PASSWORD=h5cs-ci-restore-only \
  "$image_id" --skip-networking --skip-log-bin --mysqlx=OFF >/dev/null

ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if docker exec "$restore_container" sh -ec \
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD; exec mysqladmin ping --protocol=socket -uroot --silent' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ $ready -ne 1 ]]; then
  echo 'Isolated restore MySQL did not become ready.' >&2
  exit 1
fi

gzip -cd -- "$backup" | docker exec -i "$restore_container" sh -ec \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --silent'
after=$(mysql_readback "$restore_container")
if [[ $after != "$before" ]]; then
  echo 'Restored schema/data counts or message-content digest differ from the source.' >&2
  exit 1
fi

printf 'Isolated non-empty MySQL restore passed: tables=%s merchants=%s assistants=%s sessions=%s messages=%s audits=%s jobs=%s\n' \
  "$table_count" "$merchant_count" "$assistant_count" "$session_count" \
  "$message_count" "$audit_count" "$job_count"
