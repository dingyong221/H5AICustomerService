#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

domain="h5cs.1rying.com"
site_path="/etc/nginx/sites-available/h5-ai-customer-service"
backup_path="${site_path}.pre-domain-20260921"

if [[ -f "${site_path}" && ! -e "${backup_path}" ]]; then
  cp -a -- "${site_path}" "${backup_path}"
fi

install -d -o root -g www-data -m 0755 /var/www/letsencrypt/.well-known/acme-challenge

cat >"${site_path}" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

server {
    listen 80;
    listen [::]:80;

    server_name ${domain};
    server_tokens off;

    access_log /var/log/nginx/h5-ai-customer-service.access.log;
    error_log /var/log/nginx/h5-ai-customer-service.error.log warn;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \$uri =404;
    }

    location = /gateway-health {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        return 200 '{"status":"ok","service":"gateway","application":"not_deployed","domain":"${domain}"}\n';
    }

    location / {
        default_type application/json;
        add_header Retry-After "300" always;
        return 503 '{"status":"maintenance","message":"application_not_deployed"}\n';
    }
}
EOF

chmod 0644 "${site_path}"
nginx -t
systemctl reload nginx

curl --fail --silent --show-error \
  --header "Host: ${domain}" \
  http://127.0.0.1/gateway-health
echo

echo "domain=${domain}"
echo "nginx=valid_and_reloaded"
