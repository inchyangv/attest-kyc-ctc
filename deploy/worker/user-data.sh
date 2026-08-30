#!/bin/bash
# EC2 user-data for the Proofmark worker host. Amazon Linux 2023, arm64.
# Installs Node, creates the service user and the systemd unit. Source and .env
# are delivered afterwards by deploy/worker/sync.sh, so this script holds no secrets.
set -euxo pipefail

dnf install -y rsync
dnf install -y nodejs22 nodejs22-npm || dnf install -y nodejs20 nodejs20-npm
node -v && npm -v

id proofmark >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/proofmark --shell /sbin/nologin proofmark
install -d -o proofmark -g proofmark -m 750 /opt/proofmark

cat >/etc/systemd/system/proofmark-worker.service <<'UNIT'
[Unit]
Description=Proofmark worker (Sepolia events -> Creditcoin proof submission)
After=network-online.target
Wants=network-online.target

[Service]
User=proofmark
WorkingDirectory=/opt/proofmark
Environment=HOME=/opt/proofmark
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable proofmark-worker
# Not started here: the unit needs the source tree and .env first (sync.sh starts it).
