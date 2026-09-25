#!/usr/bin/env bash
set -euo pipefail

image='mirror.ccs.tencentyun.com/library/mysql@sha256:f015b98a954d6bb92c370d93f354b85f4bcea15642d9fb2975f841a00d400b65'
backup_directory=/var/backups/h5-ai-customer-service/mysql
container=h5cs-mysql-restore-test

if [[ $(id -u) -ne 0 || $# -ne 1 ]]; then
  echo 'Usage: sudo restore-test-single-node-mysql.sh <local-backup.sql.gz>' >&2
  exit 1
fi
backup=$(realpath -- "$1")
if [[ $backup != "$backup_directory/"*.sql.gz || ! -f $backup ]]; then
  echo 'Backup must be an existing project-local .sql.gz file.' >&2
  exit 1
fi
if docker container inspect "$container" >/dev/null 2>&1; then
  echo 'Isolated restore-test container already exists; inspect it manually.' >&2
  exit 1
fi
gzip -t "$backup"

docker run --detach --rm --pull=never --name "$container" --network none \
  --tmpfs /var/lib/mysql:rw,size=1g,mode=0700 \
  --mount type=bind,source=/etc/h5-ai-customer-service/mysql/root-password,target=/run/secrets/root-password,readonly \
  --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password \
  "$image" --skip-networking --skip-log-bin --mysqlx=OFF >/dev/null
trap 'docker stop --time 30 "$container" >/dev/null 2>&1 || true' EXIT

ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if docker exec "$container" sh -ec \
    'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysqladmin ping --protocol=socket -uroot --silent' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ $ready -ne 1 ]]; then
  echo 'Isolated restore-test MySQL did not become ready.' >&2
  exit 1
fi

gzip -cd -- "$backup" | docker exec -i "$container" sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --silent'

docker exec -i "$container" sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --database=h5_ai_customer_service_prod --batch --silent' <<'SQL'
SELECT DATABASE();
SELECT COUNT(*) AS restored_table_count FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'h5_ai_customer_service_prod';
SQL
echo 'Isolated logical restore completed; the disposable container will be removed.'
