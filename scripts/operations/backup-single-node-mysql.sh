#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run with sudo.' >&2
  exit 1
fi

destination=/var/backups/h5-ai-customer-service/mysql
install -d -o root -g root -m 0700 "$destination"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$destination/h5cs-prod-$stamp.sql.gz"
if [[ -e $final ]]; then
  echo 'Backup filename already exists; refusing to overwrite.' >&2
  exit 1
fi
temporary=$(mktemp "$destination/.h5cs-prod.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT

docker exec h5cs-prod-mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/root-password)"; export MYSQL_PWD; exec mysqldump --protocol=socket -uroot --single-transaction --set-gtid-purged=OFF --no-tablespaces --routines --events --triggers --databases h5_ai_customer_service_prod' \
  | gzip -9 > "$temporary"
gzip -t "$temporary"
test -s "$temporary"
chmod 0600 "$temporary"
mv -- "$temporary" "$final"
trap - EXIT
sha256sum "$final" > "$final.sha256"
chmod 0600 "$final.sha256"
echo "Local-only backup created: $final"
