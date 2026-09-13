#!/usr/bin/env bash
# One read-only path through every public claim a judge needs. Sends no transaction and reads no key.
#
# The chain checks are routed by what is actually deployed at deployments/cc3-testnet.json:
#   v1-live  the public build (tag v1-live). Runs the read-only recording kit, the Direct-mark
#            freshness gate and the roster-format-1 epoch verification.
#   v2       a redeployed roster-v2 build. Runs the strict pinned scene checks, which need the
#            reviewed runtime pins and issuer from docs/44-demo-verification.md.
# Neither route ever enters write mode.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
# An inherited write-mode flag must never reach any chain command in this path.
export RECORD=0

demo_url="${DEMO_URL:-https://attest-kyc.stabled.ai}"
cc3="${CC3:-${CREDITCOIN_RPC_URL:-https://rpc.cc3-testnet.creditcoin.network}}"
registry="$(node -p "require('./deployments/cc3-testnet.json').contracts.ProofmarkRegistry")"
deployer="$(node -p "require('./deployments/cc3-testnet.json').deployer")"
epoch_record="$(ls deployments/epoch-*.json | sort -V | tail -1)"

echo '1/4 static claim consistency'
npx tsx script/check-submission.ts

echo
echo '2/4 public product and API'
bash scripts/check-demo-urls.sh "$demo_url"

echo
echo '3/4 source pinning, policy split and gated transfer'
# The RPC must answer before a revert can be read as "v1": a dead endpoint is an error, not v1.
# The probe is pinned to one hub height like every other read-only chain read in this path.
[ "$(cast chain-id --rpc-url "$cc3")" = 102031 ] || { echo 'FAIL: hub RPC did not answer with chain 102031' >&2; exit 1; }
read -r hub_block _hub_hash <<< "$(cast block latest --json --rpc-url "$cc3" | node script/demo-block.mjs pin)"
if cast call "$registry" 'ROSTER_FORMAT_VERSION()(uint256)' --block "$hub_block" --rpc-url "$cc3" >/dev/null 2>&1; then
  generation=v2
else
  generation=v1-live
fi
echo "deployed registry generation: $generation ($registry)"
if [ "$generation" = v2 ]; then
  RECORD=0 DEMO_URL="$demo_url" SCENES="2 3 4 6 7 8" bash docs/demo-video/commands-v2.sh
  npx tsx script/check-demo-freshness.ts
else
  RECORD=0 DEMO_URL="$demo_url" SCENES="1 2 3 4 5 6 8" bash docs/demo-video/commands.sh
  # 24 hours is the documented pre-judging margin for the seven-day pilot policy; the issuer is the
  # committed deployment manifest's deployer, not a value learned from the chain under test.
  MIN_FRESH_HOURS="${MIN_FRESH_HOURS:-24}" DEMO_EXPECTED_ISSUER="${DEMO_EXPECTED_ISSUER:-$deployer}" \
    npx tsx script/check-demo-freshness.ts
fi

echo
echo "4/4 epoch inclusion and non-inclusion against the deployed registry ($epoch_record)"
npx tsx script/verify-epoch-record.ts "$epoch_record"

echo
echo "PASS  submission verification complete against the $generation deployment; no transaction was sent and no private key was read"
