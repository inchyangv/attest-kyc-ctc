#!/usr/bin/env bash
# Push the worker source and the root .env to the instance, npm ci, restart the service.
# Re-run after any code change. Remote state/ and .env survive --delete (they are excluded).
#
#   deploy/worker/sync.sh <public-ip>
set -euo pipefail
IP=${1:?usage: sync.sh <public-ip>}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ec2-user@$IP"

for i in $(seq 1 30); do $SSH true 2>/dev/null && break; sleep 5; done
$SSH 'cloud-init status --wait >/dev/null; node -v'

rsync -az --delete --rsync-path='sudo rsync' \
  --exclude .git --exclude node_modules --exclude web --exclude out --exclude cache --exclude lib \
  --exclude reference --exclude data/raw --exclude state --exclude '.env*' --exclude .vercel \
  --exclude docs --exclude src --exclude test \
  "$ROOT/" "ec2-user@$IP:/opt/proofmark/"
# worker/abi.ts reads these two forge artifacts; out/ is otherwise build noise
tar -C "$ROOT" -cf - out/ComplianceSource.sol/ComplianceSource.json out/ProofmarkASC.sol/ProofmarkASC.json \
  | $SSH 'sudo tar -C /opt/proofmark -xf -'
$SSH 'sudo chown -R proofmark:proofmark /opt/proofmark'

scp -q "$ROOT/.env" "ec2-user@$IP:/tmp/proofmark.env"
$SSH 'sudo install -o proofmark -g proofmark -m 600 /tmp/proofmark.env /opt/proofmark/.env && rm -f /tmp/proofmark.env'

$SSH 'cd /opt/proofmark && sudo -u proofmark HOME=/opt/proofmark npm ci --no-audit --no-fund \
      && sudo systemctl restart proofmark-worker && sleep 4 \
      && sudo systemctl --no-pager --lines=15 status proofmark-worker'
