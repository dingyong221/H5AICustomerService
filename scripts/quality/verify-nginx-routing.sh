#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${CI:-} != true || ${GITHUB_ACTIONS:-} != true ]]; then
  echo 'This isolated Nginx route check runs only in CI.' >&2
  exit 1
fi
for binary in nginx openssl curl node; do
  command -v "$binary" >/dev/null
done

scratch=$(mktemp -d "${RUNNER_TEMP:-/tmp}/h5cs-nginx-routing.XXXXXXXX")
mock_pid=''
nginx_started=false
cleanup() {
  if [[ $nginx_started == true ]]; then
    nginx -s stop -c "$scratch/nginx.conf" -p "$scratch/" >/dev/null 2>&1 || true
  fi
  if [[ -n $mock_pid ]]; then
    kill "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
  rm -f -- "$scratch/nginx.conf" "$scratch/site.conf" "$scratch/cert.pem" \
    "$scratch/key.pem" "$scratch/access.log" "$scratch/error.log" "$scratch/nginx.pid" \
    "$scratch/acme/.well-known/acme-challenge/ping"
  rmdir -- "$scratch/acme/.well-known/acme-challenge" \
    "$scratch/acme/.well-known" "$scratch/acme" "$scratch" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$scratch/acme/.well-known/acme-challenge"
printf 'acme-probe' > "$scratch/acme/.well-known/acme-challenge/ping"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=h5cs.1rying.com' \
  -keyout "$scratch/key.pem" -out "$scratch/cert.pem" >/dev/null 2>&1

sed \
  -e 's/listen 80 default_server;/listen 18080 default_server;/' \
  -e 's/listen 80;/listen 18080;/g' \
  -e 's/listen 443 ssl default_server;/listen 18443 ssl default_server;/' \
  -e 's/127.0.0.1:13000/127.0.0.1:23000/g' \
  -e 's/127.0.0.1:13001/127.0.0.1:23001/g' \
  -e 's/127.0.0.1:13002/127.0.0.1:23002/g' \
  -e 's/127.0.0.1:14000/127.0.0.1:24000/g' \
  -e "s|/etc/letsencrypt/live/h5cs.1rying.com/fullchain.pem|$scratch/cert.pem|g" \
  -e "s|/etc/letsencrypt/live/h5cs.1rying.com/privkey.pem|$scratch/key.pem|g" \
  -e "s|/var/log/nginx/h5-ai-customer-service.access.log|$scratch/access.log|g" \
  -e "s|/var/log/nginx/h5-ai-customer-service.error.log|$scratch/error.log|g" \
  -e "s|/var/www/letsencrypt|$scratch/acme|g" \
  infra/nginx/h5cs-single-domain.conf.example > "$scratch/site.conf"
if grep -Eq 'listen (80|443)([ ;]|$)' "$scratch/site.conf"; then
  echo 'The CI routing copy still contains a production listener.' >&2
  exit 1
fi

printf 'pid %s/nginx.pid;\nerror_log %s/error.log;\nevents {}\nhttp { access_log %s/access.log; include %s/site.conf; }\n' \
  "$scratch" "$scratch" "$scratch" "$scratch" > "$scratch/nginx.conf"

node scripts/quality/mock-nginx-upstreams.mjs &
mock_pid=$!
for port in 23000 23001 23002 24000; do
  ready=false
  for attempt in {1..20}; do
    if curl --noproxy '*' --silent --fail "http://127.0.0.1:$port/ready" >/dev/null; then
      ready=true
      break
    fi
    kill -0 "$mock_pid"
    sleep 1
  done
  test "$ready" = true
done
nginx -t -c "$scratch/nginx.conf" -p "$scratch/"
nginx -c "$scratch/nginx.conf" -p "$scratch/"
nginx_started=true

for attempt in {1..20}; do
  if curl --noproxy '*' --silent --output /dev/null \
    --resolve h5cs.1rying.com:18080:127.0.0.1 \
    http://h5cs.1rying.com:18080/gateway-health; then
    break
  fi
  sleep 1
done

http='http://h5cs.1rying.com:18080'
https='https://h5cs.1rying.com:18443'
resolve_http=(--noproxy '*' --silent --resolve h5cs.1rying.com:18080:127.0.0.1)
resolve_https=(--noproxy '*' --silent --insecure --resolve h5cs.1rying.com:18443:127.0.0.1)

test "$(curl "${resolve_http[@]}" "$http/.well-known/acme-challenge/ping")" = acme-probe
test "$(curl "${resolve_http[@]}" --output /dev/null --write-out '%{http_code}' "$http/gateway-health")" = 200
test "$(curl "${resolve_http[@]}" --output /dev/null --write-out '%{http_code}|%{redirect_url}' "$http/ops/login")" = '308|https://h5cs.1rying.com/ops/login'
test "$(curl "${resolve_https[@]}" "$https/ops/login")" = 'ops|/ops/login|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" "$https/console/account/login")" = 'merchant|/console/account/login|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" "$https/a/probe")" = 'consumer|/a/probe|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" "$https/api/v1/probe")" = 'api|/api/v1/probe|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" "$https/mcp")" = 'api|/mcp|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" "$https/oauth/probe")" = 'api|/oauth/probe|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" "$https/.well-known/oauth-authorization-server")" = 'api|/.well-known/oauth-authorization-server|h5cs.1rying.com|https'
test "$(curl "${resolve_https[@]}" --output /dev/null --write-out '%{http_code}' "$https/ops")" = 308
test "$(curl "${resolve_https[@]}" --output /dev/null --write-out '%{http_code}' "$https/console")" = 308
test "$(curl --noproxy '*' --silent --insecure --output /dev/null --write-out '%{http_code}' https://127.0.0.1:18443/a/probe || true)" = 000
test "$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:18080/ops/login || true)" = 000

echo 'Candidate single-domain Nginx route checks passed on isolated high ports with CI-only mocks.'
