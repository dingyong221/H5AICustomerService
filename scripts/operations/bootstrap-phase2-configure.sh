#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

backup_once() {
  local source_path="$1"
  local backup_path="${source_path}.pre-h5-bootstrap"
  if [[ -e "${source_path}" && ! -e "${backup_path}" ]]; then
    cp -a -- "${source_path}" "${backup_path}"
  fi
}

echo "[phase2] configuring host identity"
old_hostname="$(hostnamectl --static)"
hostnamectl set-hostname h5-ai-customer-service-prod
backup_once /etc/hosts
if grep -Fq "${old_hostname}" /etc/hosts; then
  sed -i "s/${old_hostname}/h5-ai-customer-service-prod/g" /etc/hosts
fi

echo "[phase2] creating dedicated runtime account and paths"
if ! getent group h5ai >/dev/null; then
  groupadd --system h5ai
fi
if ! id h5ai >/dev/null 2>&1; then
  useradd --system --gid h5ai --home-dir /opt/h5-ai-customer-service \
    --no-create-home --shell /usr/sbin/nologin h5ai
fi
install -d -o root -g h5ai -m 0750 \
  /opt/h5-ai-customer-service \
  /opt/h5-ai-customer-service/releases \
  /opt/h5-ai-customer-service/shared \
  /etc/h5-ai-customer-service
install -d -o h5ai -g h5ai -m 0750 \
  /var/lib/h5-ai-customer-service \
  /var/log/h5-ai-customer-service

echo "[phase2] hardening SSH"
backup_once /etc/ssh/sshd_config.d/60-h5-ai-hardening.conf
cat >/etc/ssh/sshd_config.d/60-h5-ai-hardening.conf <<'EOF'
# Managed by H5 AI Customer Service server bootstrap.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
AllowUsers ubuntu
MaxAuthTries 4
MaxSessions 5
LoginGraceTime 30
AllowAgentForwarding no
X11Forwarding no
UseDNS no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
chmod 0644 /etc/ssh/sshd_config.d/60-h5-ai-hardening.conf
/usr/sbin/sshd -t
systemctl reload ssh

echo "[phase2] configuring Docker daemon"
backup_once /etc/docker/daemon.json
install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-level": "warn",
  "log-opts": {
    "max-file": "3",
    "max-size": "10m"
  },
  "userland-proxy": false
}
EOF
chmod 0644 /etc/docker/daemon.json
jq empty /etc/docker/daemon.json
dockerd --validate --config-file=/etc/docker/daemon.json

echo "[phase2] configuring Fail2ban"
backup_once /etc/fail2ban/jail.d/h5-ai-sshd.local
cat >/etc/fail2ban/jail.d/h5-ai-sshd.local <<'EOF'
[DEFAULT]
banaction = ufw
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
backend = systemd
port = 22
EOF
chmod 0644 /etc/fail2ban/jail.d/h5-ai-sshd.local
fail2ban-client -t

echo "[phase2] configuring maintenance gateway"
backup_once /etc/nginx/sites-available/h5-ai-customer-service
cat >/etc/nginx/sites-available/h5-ai-customer-service <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;
    server_tokens off;

    access_log /var/log/nginx/h5-ai-customer-service.access.log;
    error_log /var/log/nginx/h5-ai-customer-service.error.log warn;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    location = /gateway-health {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        return 200 '{"status":"ok","service":"gateway","application":"not_deployed"}\n';
    }

    location / {
        default_type application/json;
        add_header Retry-After "300" always;
        return 503 '{"status":"maintenance","message":"application_not_deployed"}\n';
    }
}
EOF
chmod 0644 /etc/nginx/sites-available/h5-ai-customer-service
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/h5-ai-customer-service \
  /etc/nginx/sites-enabled/h5-ai-customer-service
nginx -t

echo "[phase2] effective SSH policy"
/usr/sbin/sshd -T | grep -E \
  '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowusers|maxauthtries|x11forwarding|allowagentforwarding) '

echo "[phase2] configured; network-facing services remain stopped"
for unit in nginx docker containerd fail2ban; do
  printf '%s=' "${unit}"
  systemctl is-active "${unit}" 2>/dev/null || true
done
