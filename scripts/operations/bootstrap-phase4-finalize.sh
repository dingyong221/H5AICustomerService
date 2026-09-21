#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

echo "[phase4] installing held kernel and network package updates"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
apt-get -y full-upgrade

echo "[phase4] configuring 2 GiB emergency swap"
if ! swapon --show=NAME --noheadings | grep -Fxq /swapfile; then
  if [[ -e /swapfile ]]; then
    echo "/swapfile exists but is not active; refusing to overwrite it" >&2
    exit 1
  fi
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
if ! grep -Eq '^/swapfile[[:space:]]' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi

cat >/etc/sysctl.d/60-h5-ai-customer-service.conf <<'EOF'
# Conservative defaults for the 2 vCPU / 8 GiB application host.
vm.swappiness = 10
fs.inotify.max_user_watches = 524288
net.core.somaxconn = 1024
EOF
chmod 0644 /etc/sysctl.d/60-h5-ai-customer-service.conf
sysctl --system >/dev/null

echo "[phase4] enabling automatic security updates without automatic reboot"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52h5-ai-unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF
chmod 0644 \
  /etc/apt/apt.conf.d/20auto-upgrades \
  /etc/apt/apt.conf.d/52h5-ai-unattended-upgrades-local
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer

echo "[phase4] final pre-reboot state"
swapon --show
free -h
uname -r
dpkg-query -W -f='installed_kernel=${Version}\n' linux-image-generic
apt-get -s upgrade | grep -E '^[0-9]+ upgraded' || true
if [[ -f /var/run/reboot-required ]]; then
  echo "reboot-required=yes"
  cat /var/run/reboot-required.pkgs 2>/dev/null || true
else
  echo "reboot-required=no"
fi
