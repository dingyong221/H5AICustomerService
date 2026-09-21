#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

echo "[phase3] configuring host firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH restricted by Tencent security group'
ufw allow 80/tcp comment 'HTTP gateway'
ufw allow 443/tcp comment 'HTTPS gateway'
ufw logging low
ufw --force enable

echo "[phase3] enabling runtime services"
systemctl enable --now containerd
systemctl enable --now docker
systemctl enable --now nginx
systemctl enable --now fail2ban

echo "[phase3] validating services"
systemctl is-active containerd docker nginx fail2ban ssh
nginx -t
fail2ban_ready=0
for _ in $(seq 1 20); do
  if fail2ban-client ping >/dev/null 2>&1; then
    fail2ban_ready=1
    break
  fi
  sleep 1
done
if [[ "${fail2ban_ready}" -ne 1 ]]; then
  echo "Fail2ban did not become ready within 20 seconds" >&2
  exit 1
fi
fail2ban-client status sshd
docker info --format 'docker_server={{.ServerVersion}} containers={{.Containers}}'

echo "[phase3] validating local gateway"
curl --fail --silent --show-error http://127.0.0.1/gateway-health
root_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1/)"
if [[ "${root_status}" != "503" ]]; then
  echo "Unexpected root status: ${root_status}" >&2
  exit 1
fi
echo "root_status=${root_status}"

echo "[phase3] firewall status"
ufw status verbose

echo "[phase3] listeners"
ss -lntup

echo "[phase3] complete"
