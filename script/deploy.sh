#!/usr/bin/env bash
# Proofmark testnet deployment: CC3 Testnet (hub) and Ethereum Sepolia (source)
#
# This script sends on-chain transactions. Before running, check:
#    1) no other session is sending from this wallet (nonce collision)
#    2) both chains have balance
#
# Usage:
#    ./script/deploy.sh preflight   # checks only, no transactions
#    ./script/deploy.sh deploy      # deploy for real
#
# Order matters. ProofmarkASC needs the EvmV1Decoder library linked, and the ASC accepts
# no proof before configureSource runs (test_RejectsBeforeSourceConfigured).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/deployments/cc3-testnet.json"
DECODER_PATH="node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder"

# Shell variables read with `source .env` are not exported to a child process by default. Load and
# export the repository's testnet configuration here so the documented command works as written.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# Measured values, docs/01-env-verification.md section 3.3
SOURCE_CHAIN_KEY="${SOURCE_CHAIN_KEY:-1}"     # chainKey 1 is Sepolia. Not the same as chainId 11155111.

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

need() {
  local n="$1"
  if [ -z "${!n:-}" ]; then red "x $n is not set. Did you run 'source .env'?"; exit 1; fi
}

preflight() {
  echo "=== Preflight (no transactions) ==="
  need CREDITCOIN_RPC_URL
  need SOURCE_CHAIN_RPC_URL
  need DEPLOYER_PRIVATE_KEY

  local addr; addr=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
  echo "deployer: $addr"

  local ccid; ccid=$(cast chain-id --rpc-url "$CREDITCOIN_RPC_URL")
  local spid; spid=$(cast chain-id --rpc-url "$SOURCE_CHAIN_RPC_URL")
  echo "CC3 chainId    : $ccid   (expect 102031)"
  echo "Sepolia chainId: $spid   (expect 11155111)"
  [ "$ccid" = "102031" ]   || { red "x CC3 chainId mismatch"; exit 1; }
  [ "$spid" = "11155111" ] || { red "x Sepolia chainId mismatch"; exit 1; }

  local ccbal spbal
  ccbal=$(cast balance "$addr" --rpc-url "$CREDITCOIN_RPC_URL" --ether)
  spbal=$(cast balance "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL" --ether)
  echo "CC3 balance    : $ccbal CTC"
  echo "Sepolia balance: $spbal ETH"

  # Print nonces so concurrent use by another session is visible
  echo "CC3 nonce    : $(cast nonce "$addr" --rpc-url "$CREDITCOIN_RPC_URL")"
  echo "Sepolia nonce: $(cast nonce "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL")"

  echo
  echo "Reading supported chains to verify the chainKey for configureSource($SOURCE_CHAIN_KEY, ...):"
  # chainKey is not chainId. We look it up at runtime rather than hardcoding it.
  # (cast handles struct array returns awkwardly, so this goes through the SDK)
  if npx --no-install tsx "$ROOT/script/check_chains.ts" "$SOURCE_CHAIN_KEY" 11155111; then
    grn "  ok chainKey verified"
  else
    red "x chainKey check failed. configureSource would point at the wrong chain. Stopping."
    exit 1
  fi

  grn "ok preflight passed"
  ylw "If a nonce looks wrong, another session may be using this wallet. Check before continuing."
}

deploy() {
  preflight
  echo
  ylw "Sending real transactions now. Ctrl-C within 5 seconds to stop."
  sleep 5

  cd "$ROOT"
  local addr; addr=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")

  # 1. EvmV1Decoder library on CC3
  # The documented pre-deployed Decoder (0x731c34...F9f) has a different runtime size from
  # our build (19,199 vs 26,524 hex chars), so we deploy our own rather than assume.
  # A bad link fails quietly and costs an eight-minute attestation cycle to find.
  echo "── 1/8  EvmV1Decoder → CC3"
  local decoder
  decoder=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" "$DECODER_PATH" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$decoder" ] || { red "x decoder deployment failed"; exit 1; }
  grn "   EvmV1Decoder = $decoder"

  # 2. ProofmarkASC on CC3, library link required
  echo "-- 2/8  ProofmarkASC -> CC3  (--libraries)"
  local asc
  asc=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      --libraries "${DECODER_PATH}:${decoder}" \
      src/ProofmarkASC.sol:ProofmarkASC --constructor-args "$addr" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$asc" ] || { red "x ASC deployment failed. Check the library link."; exit 1; }
  grn "   ProofmarkASC = $asc"

  # ── 3. ProofmarkRegistry (CC3) ────────────────────────────────────
  echo "── 3/8  ProofmarkRegistry → CC3"
  local reg
  reg=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/ProofmarkRegistry.sol:ProofmarkRegistry --constructor-args "$asc" \
      | awk '/Deployed to:/{print $3}')
  grn "   ProofmarkRegistry = $reg"

  # ── 4. ComplianceSource (Sepolia) ─────────────────────────────────
  echo "── 4/8  ComplianceSource → Sepolia"
  local srcaddr
  srcaddr=$(forge create --broadcast --rpc-url "$SOURCE_CHAIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/ComplianceSource.sol:ComplianceSource --constructor-args "$addr" \
      | awk '/Deployed to:/{print $3}')
  grn "   ComplianceSource = $srcaddr"

  # 5. Cross-registration
  # The ASC rejects every proof until configureSource runs. Fail closed by design.
  echo "── 5/8  asc.configureSource(chainKey=$SOURCE_CHAIN_KEY, $srcaddr)"
  cast send "$asc" "configureSource(uint64,address)" "$SOURCE_CHAIN_KEY" "$srcaddr" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  grn "   configureSource done"

  echo "── 6/8  src.setIssuer($addr, true) / setEpochPublisher"
  cast send "$srcaddr" "setIssuer(address,bool)" "$addr" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  cast send "$srcaddr" "setEpochPublisher(address,bool)" "$addr" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  grn "   issuer and epoch publisher registered"

  # 7. Policies. Production pins live regime 1; pilot pins sandbox regime 2. Both pin KR
  # jurisdiction and this issuer, and are frozen before an asset can bind to them.
  # KR VASP methods: document authenticity | bank account | sanctions screening
  #   ID_DOC_AUTHENTICITY(1<<2) | BANK_ACCOUNT(1<<5) | SANCTIONS_SCREENED(1<<16) = 0x10024
  echo "-- 7/8  register and freeze KR production + pilot policies -> Registry"
  local krmask=$((1<<2 | 1<<5 | 1<<16))
  cast send "$reg" "registerPolicy((uint32,uint8,uint40,uint16,uint16,address,bool,bool))" \
      "($krmask,2,2592000,1,410,$addr,false,false)" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  local productionpolicy; productionpolicy=$(cast call "$reg" "nextPolicyId()(uint256)" --rpc-url "$CREDITCOIN_RPC_URL")
  productionpolicy=$(( ${productionpolicy%% *} - 1 ))
  cast send "$reg" "freezePolicy(uint256)" "$productionpolicy" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null

  cast send "$reg" "registerPolicy((uint32,uint8,uint40,uint16,uint16,address,bool,bool))" \
      "($krmask,2,604800,2,410,$addr,false,false)" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  local pilotpolicy; pilotpolicy=$(cast call "$reg" "nextPolicyId()(uint256)" --rpc-url "$CREDITCOIN_RPC_URL")
  pilotpolicy=$(( ${pilotpolicy%% *} - 1 ))
  cast send "$reg" "freezePolicy(uint256)" "$pilotpolicy" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  grn "   production policyId = $productionpolicy (regime 1, 30d)"
  grn "   pilot policyId      = $pilotpolicy (regime 2, 7d)"

  # 8. Demo token on CC3
  echo "── 8/8  GatedRwaNote → CC3"
  local note
  note=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/GatedRwaNote.sol:GatedRwaNote \
      --constructor-args "KR Pilot Credit Note" "KPCN" "$reg" "$pilotpolicy" "$addr" \
      | awk '/Deployed to:/{print $3}')
  grn "   GatedRwaNote = $note"

  # Record
  cat > "$OUT" <<JSON
{
  "network": { "hub": "cc3-testnet", "hubChainId": 102031, "source": "sepolia", "sourceChainId": 11155111 },
  "sourceChainKey": $SOURCE_CHAIN_KEY,
  "deployer": "$addr",
  "contracts": {
    "EvmV1Decoder":      "$decoder",
    "ProofmarkASC":      "$asc",
    "ProofmarkRegistry": "$reg",
    "ComplianceSource":  "$srcaddr",
    "GatedRwaNote":      "$note"
  },
  "demo": {
    "productionPolicyId": $productionpolicy,
    "pilotPolicyId": $pilotpolicy,
    "notePolicyId": $pilotpolicy
  }
}
JSON
  grn "ok deployed, written to $OUT"
  cat "$OUT"

  # Post-deployment checks
  echo
  echo "=== Post-deployment checks ==="
  echo -n "asc.expectedChainKey : "; cast call "$asc" "expectedChainKey()(uint64)"  --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "asc.sourceContract   : "; cast call "$asc" "sourceContract()(address)"   --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.ASC              : "; cast call "$reg" "ASC()(address)"              --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "note.POLICY_ID       : "; cast call "$note" "POLICY_ID()(uint256)"       --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.policyFrozen(1) : "; cast call "$reg" "policyFrozen(uint256)(bool)" 1 --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.policyFrozen(2) : "; cast call "$reg" "policyFrozen(uint256)(bool)" 2 --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "src.isIssuer(deployer): "; cast call "$srcaddr" "isIssuer(address)(bool)" "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL"

  # Same deployer and same nonce give the same CREATE address on different chains.
  # When that happens, passing the wrong address to configureSource looks identical,
  # so compare the bytecode on both chains to confirm they are different contracts.
  echo
  echo "=== Address collision check (ASC vs ComplianceSource) ==="
  if [ "$(echo "$asc" | tr 'A-Z' 'a-z')" = "$(echo "$srcaddr" | tr 'A-Z' 'a-z')" ]; then
    ylw "  addresses match. Comparing bytecode on each chain."
    local ccode scode
    ccode=$(cast code "$asc"     --rpc-url "$CREDITCOIN_RPC_URL"  | wc -c | tr -d ' ')
    scode=$(cast code "$srcaddr" --rpc-url "$SOURCE_CHAIN_RPC_URL" | wc -c | tr -d ' ')
    echo "  CC3     : $ccode chars"
    echo "  Sepolia : $scode chars"
    if [ "$ccode" = "$scode" ]; then
      red "x bytecode is identical on both chains. configureSource may point at the wrong contract."; exit 1
    fi
    grn "  ok different contracts confirmed"
  fi

  # Check the gate is closed rather than just saying so
  #
  # `cast call` leaves msg.sender at 0, so without --from the onlyOwner check fires first.
  # OwnableUnauthorizedAccount (0x118cdaa7) and RecipientNotVerified (0x17887111) both look
  # like a revert but mean different things, so compare the selector.
  echo
  echo "=== Gate closure check (nobody is verified yet) ==="
  local gateout
  gateout=$(cast call "$note" "mint(address,uint256)" "$addr" 1000000000000000000 \
              --from "$addr" --rpc-url "$CREDITCOIN_RPC_URL" 2>&1 || true)
  if echo "$gateout" | grep -q "17887111\|RecipientNotVerified"; then
    grn "  ok RecipientNotVerified. The gate is closed, as expected."
  elif echo "$gateout" | grep -q "118cdaa7\|OwnableUnauthorized"; then
    red "  x OwnableUnauthorizedAccount. --from is missing, so the gate was not verified."; exit 1
  else
    red "  x unexpected result: $gateout"; exit 1
  fi

  echo
  grn "Deployed and verified. Next: issue on Sepolia, let the worker submit the proof, then isVerified turns true and note.mint succeeds."
  ylw "When reproducing: always pass --from to cast call. Without it onlyOwner fires first and you draw the wrong conclusion."
  ylw "The 'missing field mixHash' errors from forge/cast on CC3 come from the Substrate block format and are harmless."
}

case "${1:-preflight}" in
  preflight) preflight ;;
  deploy) deploy ;;
  *) echo "usage: $0 [preflight|deploy]" >&2; exit 2 ;;
esac
