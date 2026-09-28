#!/usr/bin/env bash
set -euo pipefail

image='mirror.ccs.tencentyun.com/library/mysql@sha256:f015b98a954d6bb92c370d93f354b85f4bcea15642d9fb2975f841a00d400b65'
secrets=/etc/h5-ai-customer-service/mysql

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run with sudo.' >&2
  exit 1
fi

docker run --rm --network h5cs_prod_data_internal \
  --mount "type=bind,source=$secrets/api-password,target=/run/secrets/api-password,readonly" \
  --mount "type=bind,source=$secrets/certs/ca.pem,target=/etc/mysql/tls/ca.pem,readonly" \
  --entrypoint sh "$image" -ec '
    MYSQL_PWD="$(cat /run/secrets/api-password)"
    export MYSQL_PWD
    mysql --protocol=tcp --host=mysql.h5cs.internal --ssl-mode=VERIFY_IDENTITY \
      --ssl-ca=/etc/mysql/tls/ca.pem --user=h5cs_api \
      --database=h5_ai_customer_service_prod --batch --skip-column-names \
      -e "SELECT VERSION(), DATABASE(), @@require_secure_transport"
    mysql --protocol=tcp --host=mysql.h5cs.internal --ssl-mode=VERIFY_IDENTITY \
      --ssl-ca=/etc/mysql/tls/ca.pem --user=h5cs_api \
      --database=h5_ai_customer_service_prod --batch --skip-column-names \
      -e "SHOW SESSION STATUS LIKE '\''Ssl_cipher'\''"
  '

docker exec -i h5cs-prod-mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --silent' <<'SQL'
SHOW GRANTS FOR 'h5cs_api'@'%';
SHOW GRANTS FOR 'h5cs_migrator'@'%';
SELECT @@log_bin, @@binlog_expire_logs_seconds, @@max_connections, @@innodb_buffer_pool_size;
SQL

docker inspect h5cs-prod-mysql --format 'Ports={{json .NetworkSettings.Ports}} State={{.State.Status}} Health={{.State.Health.Status}}'
if ss -lnt | grep -q ':3306 '; then
  echo 'Unexpected host 3306 listener.' >&2
  exit 1
fi
