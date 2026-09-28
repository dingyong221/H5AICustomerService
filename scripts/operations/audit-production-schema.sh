#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 || $(hostname) != h5-ai-customer-service-prod ]]; then
  echo 'Run as root on the approved H5CS production host.' >&2
  exit 1
fi

docker exec -i h5cs-prod-mysql sh -ec '
  MYSQL_PWD="$(cat /run/secrets/root-password)"
  export MYSQL_PWD
  exec mysql --protocol=socket --user=root --batch --skip-column-names
' <<'SQL'
SELECT 'application_tables', COUNT(*)
  FROM information_schema.tables
 WHERE table_schema = 'h5_ai_customer_service_prod';
SELECT 'migration_tables', COUNT(*)
  FROM information_schema.tables
 WHERE table_schema = 'h5_ai_customer_service_prod'
   AND table_name LIKE '%migration%';
SQL

docker inspect h5cs-prod-mysql --format 'mysql_status={{.State.Status}} mysql_health={{.State.Health.Status}} ports={{json .NetworkSettings.Ports}}'
if ss -lnt | grep -q ':3306 '; then
  echo 'Unexpected host TCP 3306 listener.' >&2
  exit 1
fi
