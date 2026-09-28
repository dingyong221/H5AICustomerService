#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run as root only on the approved, initially empty H5CS server. Never print secrets.
compose=/opt/h5-ai-customer-service/mysql/docker-compose.mysql-single-node.yml
cert_ext=/opt/h5-ai-customer-service/mysql/single-node-server.ext
secrets=/etc/h5-ai-customer-service/mysql
image='mirror.ccs.tencentyun.com/library/mysql@sha256:f015b98a954d6bb92c370d93f354b85f4bcea15642d9fb2975f841a00d400b65'

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run with sudo.' >&2
  exit 1
fi
if [[ $(hostname) != h5-ai-customer-service-prod ]]; then
  echo 'Unexpected host; refusing to provision MySQL.' >&2
  exit 1
fi
if [[ ! -f $compose || ! -f $cert_ext ]]; then
  echo 'Reviewed Compose and certificate extension files are missing.' >&2
  exit 1
fi
if docker container inspect h5cs-prod-mysql >/dev/null 2>&1 || docker volume inspect h5cs_mysql_prod_data >/dev/null 2>&1; then
  echo 'MySQL container or data volume already exists; inspect manually, do not reinitialize.' >&2
  exit 1
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo 'Verified MySQL image digest is not present locally.' >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$secrets" "$secrets/ca-private" "$secrets/certs"
for role in root migrator api worker ops merchant readonly; do
  openssl rand -hex 32 > "$secrets/$role-password"
  chmod 0600 "$secrets/$role-password"
done
chown 999:999 "$secrets/root-password"
chmod 0400 "$secrets/root-password"

openssl genrsa -out "$secrets/ca-private/ca-key.pem" 3072 >/dev/null 2>&1
openssl req -x509 -new -key "$secrets/ca-private/ca-key.pem" -sha256 -days 3650 \
  -subj '/CN=H5CS local MySQL CA' -out "$secrets/certs/ca.pem" >/dev/null 2>&1
openssl genrsa -out "$secrets/certs/server-key.pem" 3072 >/dev/null 2>&1
openssl req -new -key "$secrets/certs/server-key.pem" -subj '/CN=mysql.h5cs.internal' \
  -out "$secrets/ca-private/server.csr" >/dev/null 2>&1
openssl x509 -req -in "$secrets/ca-private/server.csr" \
  -CA "$secrets/certs/ca.pem" -CAkey "$secrets/ca-private/ca-key.pem" \
  -CAcreateserial -days 825 -sha256 -extfile "$cert_ext" \
  -out "$secrets/certs/server.pem" >/dev/null 2>&1
chmod 0644 "$secrets/certs/ca.pem" "$secrets/certs/server.pem"
chown 999:999 "$secrets/certs/server-key.pem"
chmod 0400 "$secrets/certs/server-key.pem"
openssl verify -CAfile "$secrets/certs/ca.pem" "$secrets/certs/server.pem"
openssl x509 -in "$secrets/certs/server.pem" -checkhost mysql.h5cs.internal -noout

docker compose -f "$compose" config --quiet
docker compose -f "$compose" up -d --wait

migrator=$(<"$secrets/migrator-password")
api=$(<"$secrets/api-password")
worker=$(<"$secrets/worker-password")
ops=$(<"$secrets/ops-password")
merchant=$(<"$secrets/merchant-password")
readonly=$(<"$secrets/readonly-password")

# Passwords are generated as hex and sent only on stdin to the local container.
docker exec -i h5cs-prod-mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --silent' <<SQL
CREATE USER 'h5cs_migrator'@'%' IDENTIFIED BY '$migrator' REQUIRE SSL;
CREATE USER 'h5cs_api'@'%' IDENTIFIED BY '$api' REQUIRE SSL;
CREATE USER 'h5cs_worker'@'%' IDENTIFIED BY '$worker' REQUIRE SSL;
CREATE USER 'h5cs_ops_web'@'%' IDENTIFIED BY '$ops' REQUIRE SSL;
CREATE USER 'h5cs_merchant_web'@'%' IDENTIFIED BY '$merchant' REQUIRE SSL;
CREATE USER 'h5cs_readonly_ops'@'%' IDENTIFIED BY '$readonly' REQUIRE SSL;
GRANT ALL PRIVILEGES ON h5_ai_customer_service_prod.* TO 'h5cs_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON h5_ai_customer_service_prod.* TO 'h5cs_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON h5_ai_customer_service_prod.* TO 'h5cs_worker'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON h5_ai_customer_service_prod.* TO 'h5cs_ops_web'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON h5_ai_customer_service_prod.* TO 'h5cs_merchant_web'@'%';
GRANT SELECT ON h5_ai_customer_service_prod.* TO 'h5cs_readonly_ops'@'%';
SQL
unset migrator api worker ops merchant readonly

docker exec -i h5cs-prod-mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --silent' <<'SQL'
SELECT VERSION(), @@require_secure_transport, @@log_bin, @@character_set_server, @@collation_server;
SELECT user, host, ssl_type FROM mysql.user WHERE user LIKE 'h5cs_%' ORDER BY user;
SQL

echo 'Project MySQL service and dedicated users initialized; no host port published.'
