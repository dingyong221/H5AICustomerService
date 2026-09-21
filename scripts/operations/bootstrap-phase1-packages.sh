#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

echo "[phase1] host=$(hostname) user=$(id -un)"
cloud-init status --wait

policy_created=0
cleanup() {
  if [[ "${policy_created}" -eq 1 ]]; then
    rm -f /usr/sbin/policy-rc.d
  fi
}
trap cleanup EXIT

# Keep newly installed network-facing services stopped until their configuration
# has been validated in a later phase.
if [[ ! -e /usr/sbin/policy-rc.d ]]; then
  cat >/usr/sbin/policy-rc.d <<'EOF'
#!/bin/sh
exit 101
EOF
  chmod 0755 /usr/sbin/policy-rc.d
  policy_created=1
else
  echo "[phase1] existing /usr/sbin/policy-rc.d preserved"
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

apt-get update
apt-get -y upgrade
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  fail2ban \
  git \
  jq \
  nginx \
  rsync \
  ufw \
  unzip

apt-get clean

echo "[phase1] installed versions"
nginx -v
docker --version
docker compose version
fail2ban-client --version
ufw version | head -n 1

echo "[phase1] service state before configuration"
for unit in nginx docker containerd fail2ban; do
  systemctl is-enabled "${unit}" 2>/dev/null || true
  systemctl is-active "${unit}" 2>/dev/null || true
done

if [[ -f /var/run/reboot-required ]]; then
  echo "[phase1] reboot-required=yes"
  cat /var/run/reboot-required.pkgs 2>/dev/null || true
else
  echo "[phase1] reboot-required=no"
fi
