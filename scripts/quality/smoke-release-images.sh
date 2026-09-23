#!/usr/bin/env bash
set -euo pipefail

active_container=''
cleanup() {
  if [[ -n "$active_container" ]]; then
    docker rm --force "$active_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

probe() {
  local service="$1"
  local host_port="$2"
  local container_port="$3"
  local path="$4"
  local memory="$5"
  local status='000'
  active_container="h5cs-${service}-smoke"

  docker run --detach \
    --name "$active_container" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --memory "$memory" \
    --publish "127.0.0.1:${host_port}:${container_port}" \
    "h5cs-${service}:ci" >/dev/null

  for _ in $(seq 1 45); do
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --max-time 2 "http://127.0.0.1:${host_port}${path}" 2>/dev/null || true)"
    if [[ "$status" == '200' ]]; then
      printf '%s runtime smoke: HTTP 200 on %s\n' "$service" "$path"
      docker rm --force "$active_container" >/dev/null
      active_container=''
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$active_container" 2>/dev/null || true)" != 'true' ]]; then
      break
    fi
    sleep 1
  done

  printf '%s runtime smoke failed: last HTTP status %s\n' "$service" "$status" >&2
  docker logs --tail 80 "$active_container" >&2 || true
  return 1
}

probe api 14100 4000 /livez 1280m
probe worker 13111 3011 /livez 1536m
probe merchant-web 13100 3000 /account/login 512m
probe consumer-h5 13101 3000 / 512m
probe ops-web 13102 3000 /login 512m
