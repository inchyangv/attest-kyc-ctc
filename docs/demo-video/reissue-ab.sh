#!/bin/bash
# Re-issue the demo marks for holders A and B on the LIVE v1 deployment (Sepolia source -> CC3 hub),
# so policy 2 (7-day max age) keeps passing through the judging window.
#
# Why a worktree: the working tree's pipeline/worker are roster-v2 only and refuse the live v1 contracts.
# Issuance therefore runs from ../attest-kyc-live, a git worktree pinned at origin/main. The live worker
# (already running from the main checkout, `tsx worker/index.ts`) relays the Sepolia batch to CC3.
#
# Usage, from the main checkout:
#   bash docs/demo-video/reissue-ab.sh prep     # create/refresh the origin/main worktree, npm ci, .env + data/raw
#   bash docs/demo-video/reissue-ab.sh check    # read-only: chain ids, balances, worker liveness, current marks
#   bash docs/demo-video/reissue-ab.sh dry      # full pipeline incl. real sanctions screening, no transaction
#   bash docs/demo-video/reissue-ab.sh issue    # ONE issueBatch on Sepolia with the issuer key (asks to confirm; YES=1 skips)
#   bash docs/demo-video/reissue-ab.sh wait     # poll CC3 until both marks are the new ones and pass policy 2
#   bash docs/demo-video/reissue-ab.sh verify   # scene-5 read-only sequence + tombstone check + next expiry
#   bash docs/demo-video/reissue-ab.sh all      # prep check dry issue wait verify
set -euo pipefail
MAIN=/Users/mac-inch/Stabled/attest-kyc
LIVE=/Users/mac-inch/Stabled/attest-kyc-live
CC3="${CC3:-https://rpc.cc3-testnet.creditcoin.network}"
SEP="${SEP:-https://ethereum-sepolia-rpc.publicnode.com}"
ASC=0x3C6Fe016645CA52952E29C66E435bDa7F611b242   # ProofmarkASC, CC3
REG=0x2F4E5e1270f90E51251651caf08547393e3C0572   # ProofmarkRegistry, CC3
SRC=0xA9A34586303b9fD92e090F9bb1D332DC854c72B9   # ComplianceSource, Sepolia
ISSUER=0xFD1222e35a536A62f180aA44826656940e86bD5E # deployer / ComplianceSource issuer
A=0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2
B=0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee
MARK='getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))'
SNAP="$MAIN/state/reissue"; mkdir -p "$SNAP"
mark()     { cast call "$ASC" "$MARK" "$1" --rpc-url "$CC3"; }
verified() { cast call "$REG" 'isVerified(address,uint256)(bool)' "$1" "$2" --rpc-url "$CC3"; }
say()      { printf '\n== %s\n' "$*"; }

prep() {
  say "worktree at origin/main -> $LIVE"
  git -C "$MAIN" fetch origin main
  if [ ! -d "$LIVE/.git" ] && [ ! -f "$LIVE/.git" ]; then git -C "$MAIN" worktree add "$LIVE" origin/main; else git -C "$LIVE" checkout --detach origin/main; fi
  git -C "$LIVE" rev-parse --short HEAD
  say "npm ci in the worktree"; (cd "$LIVE" && npm ci --no-audit --no-fund >/dev/null) && echo ok
  say ".env (copied, mode 600, gitignored) and data/raw (symlink to the main checkout's sanctions lists)"
  cp "$MAIN/.env" "$LIVE/.env" && chmod 600 "$LIVE/.env"
  mkdir -p "$LIVE/data"; [ -e "$LIVE/data/raw" ] || ln -s "$MAIN/data/raw" "$LIVE/data/raw"
  ls "$LIVE/data/raw/" | grep -E 'ofac_sdn.xml|un_consolidated.xml|eu_fsf.xml' | tr '\n' ' '; echo
}
check() {
  say "chain ids (expect 102031 / 11155111)"; cast chain-id --rpc-url "$CC3"; cast chain-id --rpc-url "$SEP"
  say "issuer $ISSUER: Sepolia ETH (~28k gas per issuance), CC3 tCTC, isIssuer"
  cast balance "$ISSUER" --rpc-url "$SEP" --ether; cast balance "$ISSUER" --rpc-url "$CC3" --ether
  cast call "$SRC" 'isIssuer(address)(bool)' "$ISSUER" --rpc-url "$SEP"
  say "holder A tCTC (scene 6 only)"; cast balance "$A" --rpc-url "$CC3" --ether
  say "live worker (must be alive to relay Sepolia -> CC3)"
  if pgrep -f 'tsx worker/index.ts' >/dev/null; then echo "running: pid $(pgrep -f 'tsx worker/index.ts' | head -1)"; else echo "NOT RUNNING - see fallback in the script header of docs/demo-video/PREFLIGHT.md"; fi
  echo "state/worker.json last write: $(stat -f '%Sm' "$MAIN/state/worker.json") cursor=$(python3 -c "import json;print(json.load(open('$MAIN/state/worker.json'))['cursor'])")"
  say "current marks on CC3 and policy-2 verdicts"
  for h in $A $B; do echo "$h"; mark "$h"; echo "  isVerified(.,1)=$(verified "$h" 1)  isVerified(.,2)=$(verified "$h" 2)  tombstone=$(cast call "$ASC" 'tombstone(address)(bool)' "$h" --rpc-url "$CC3")"; done
}
dry()   { say "dry run (real screening, no tx)"; (cd "$LIVE" && npx tsx script/demo-gate-issue.ts --dry-run); }
issue() {
  mark "$A" > "$SNAP/before-A.txt"; mark "$B" > "$SNAP/before-B.txt"; date -u +%FT%TZ > "$SNAP/issued-at.txt"
  say "about to send ONE issueBatch on Sepolia from $ISSUER (real gas, issuer key from .env)"
  if [ "${YES:-0}" != 1 ]; then read -r -p "type ISSUE to continue: " ans; [ "$ans" = ISSUE ] || { echo aborted; exit 1; }; fi
  (cd "$LIVE" && npx tsx script/demo-gate-issue.ts) | tee "$SNAP/issue-$(date -u +%Y%m%dT%H%M%SZ).log"
}
wait_relay() {
  say "waiting for the worker to relay (last run ~9 min; polling 30s, cap 40 min)"
  local t=0
  until [ "$(mark "$A")" != "$(cat "$SNAP/before-A.txt")" ] && [ "$(mark "$B")" != "$(cat "$SNAP/before-B.txt")" ] \
     && [ "$(verified "$A" 2)" = true ] && [ "$(verified "$B" 2)" = true ]; do
    sleep 30; t=$((t+30)); printf '  %4ss  A:%s B:%s\n' "$t" "$(verified "$A" 2)" "$(verified "$B" 2)"
    [ $t -ge 2400 ] && { echo "TIMEOUT: relay not observed - check the worker and Sepolia tx"; exit 1; }
  done
  echo "both marks replaced and pass policy 2"
}
verify() {
  say "scene 5 read-only sequence (must print no FAIL line)"; (cd "$MAIN" && SCENES=5 bash docs/demo-video/commands.sh)
  say "tombstones (expect false/false) and new marks"; for h in $A $B; do echo "$h tombstone=$(cast call "$ASC" 'tombstone(address)(bool)' "$h" --rpc-url "$CC3")"; mark "$h"; done
  if [ -f "$SNAP/issued-at.txt" ]; then say "issued $(cat "$SNAP/issued-at.txt") -> policy 2 stops passing 7 days later:"; python3 -c "import datetime as d;t=d.datetime.strptime(open('$SNAP/issued-at.txt').read().strip(),'%Y-%m-%dT%H:%M:%SZ');e=t+d.timedelta(days=7);print(' ',e.strftime('%Y-%m-%d %H:%M UTC'),'=',(e+d.timedelta(hours=9)).strftime('%Y-%m-%d %H:%M KST'))"; fi
}
case "${1:-help}" in
  prep) prep ;; check) check ;; dry) dry ;; issue) issue ;; wait) wait_relay ;; verify) verify ;;
  all) prep; check; dry; issue; wait_relay; verify ;;
  *) sed -n 2,19p "$0" ;;
esac
