#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${CI:-} != true || ${GITHUB_ACTIONS:-} != true ]]; then
  echo 'This disposable certificate syntax check runs only in CI.' >&2
  exit 1
fi
command -v nginx >/dev/null
command -v openssl >/dev/null

scratch=$(mktemp -d "${RUNNER_TEMP:-/tmp}/h5cs-nginx-check.XXXXXXXX")
cleanup() {
  rm -f -- "$scratch/nginx.conf" "$scratch/site.conf" "$scratch/cert.pem" \
    "$scratch/key.pem" "$scratch/access.log" "$scratch/error.log" "$scratch/nginx.pid"
  rmdir -- "$scratch/acme/.well-known/acme-challenge" \
    "$scratch/acme/.well-known" "$scratch/acme" "$scratch" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$scratch/acme/.well-known/acme-challenge"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=h5cs.1rying.com' \
  -keyout "$scratch/key.pem" -out "$scratch/cert.pem" >/dev/null 2>&1

sed \
  -e "s|/etc/letsencrypt/live/h5cs.1rying.com/fullchain.pem|$scratch/cert.pem|g" \
  -e "s|/etc/letsencrypt/live/h5cs.1rying.com/privkey.pem|$scratch/key.pem|g" \
  -e "s|/var/log/nginx/h5-ai-customer-service.access.log|$scratch/access.log|g" \
  -e "s|/var/log/nginx/h5-ai-customer-service.error.log|$scratch/error.log|g" \
  -e "s|/var/www/letsencrypt|$scratch/acme|g" \
  infra/nginx/h5cs-single-domain.conf.example > "$scratch/site.conf"

printf 'pid %s/nginx.pid;\nerror_log %s/error.log;\nevents {}\nhttp { access_log %s/access.log; include %s/site.conf; }\n' \
  "$scratch" "$scratch" "$scratch" "$scratch" > "$scratch/nginx.conf"
nginx -t -c "$scratch/nginx.conf" -p "$scratch/"
echo 'Candidate single-domain Nginx syntax passed with a disposable CI-only certificate.'
