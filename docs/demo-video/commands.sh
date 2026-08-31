#!/usr/bin/env bash
#
# Proofmark demo video — the command sequence, verified against the live testnets.
#
# Every block below is labelled with the SHOTLIST.md scene it belongs to. Run the whole file to
# confirm the chain still says what the narration claims:
#
#   bash docs/demo-video/commands.sh
#
# Run one scene's block on camera:
#
#   SCENES=6 bash docs/demo-video/commands.sh
#   SCENES="6 7 8" bash docs/demo-video/commands.sh
#
# Two modes:
#
#   default (RECORD unset)  read-only. No transaction is sent, no chain state changes, no secret is
#                           read, and no variable has to be exported. This is the mode to run before
#                           recording and the mode used to verify the "# ->" comments below.
#   RECORD=1                adds the record-time blocks: the two live GatedRwaNote transfers in
#                           scene 7, and the take-B verdict in scene 6 for the mark that only exists
#                           once the human has pre-issued it. These need exported variables; each
#                           one says which.
#
# Two cast gotchas, repeated as comments next to the commands they bite:
#   * pass --from on a gated call, or msg.sender is zero and onlyOwner fires before the gate
#   * "missing field mixHash" from cast on CC3 is harmless; Creditcoin runs a Substrate block format
#
# Expected outputs were captured from a live run on 2026-09-01 and are written as "# ->" comments.
# If a value has drifted, the narration is wrong, not the chain: fix the kit before recording.

set -euo pipefail

# --- what the video points at -------------------------------------------------------------------

CC3="${CC3:-https://rpc.cc3-testnet.creditcoin.network}"        # chainId 102031
SEP="${SEP:-https://ethereum-sepolia-rpc.publicnode.com}"       # chainId 11155111
DEMO_URL="${DEMO_URL:-https://attest-kyc.stabled.ai}"           # the hosted demo, a project domain
SEPOLIA_EXPLORER="https://sepolia.etherscan.io"
CC3_EXPLORER="https://creditcoin-testnet.blockscout.com"

ASC=0x93C62D3016123Da0aBdB4AC1857564c30CbE5629   # ProofmarkASC, CC3. tombstone() and getMark() live here
REG=0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc   # ProofmarkRegistry, CC3. isVerified() lives here
NOTE=0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625  # GatedRwaNote "KR Credit Note" / KRCN, POLICY_ID 1
SRC=0x93C62D3016123Da0aBdB4AC1857564c30CbE5629   # ComplianceSource, Sepolia. Same address, other bytecode

SUB=0xb8FEBEaB3705793474fA05b91Bf5D205855dD3c1        # honest-pipeline mark: methods 0x190001, assurance 1
REVOKED=0xFD1222e35a536A62f180aA44826656940e86bD5E    # revoked subject; also deployer, issuer EOA, note owner

# Scene 7 cast. All three were established on chain by the gate run recorded in README section 4.
RWA_HOLDER="${RWA_HOLDER:-0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2}"     # A, holds 60 KRCN, passes policy 1
RWA_RECIPIENT="${RWA_RECIPIENT:-0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee}" # B, passes policy 1
RWA_CONTROL="${RWA_CONTROL:-0x680Cc6e52d80F8f3759C7d7209f576CedCE7F2C5}"   # C, passes nothing

# Set at record time only: the subject of the mark pre-issued through /verify about 15 minutes
# before recording, whose attestation has crossed to CC3 by the time scene 6 is filmed. See PREFLIGHT.md.
TAKE_B_SUBJECT="${TAKE_B_SUBJECT:-}"

# Optional: the Sepolia tx hash the /verify issuance returned, so scene 4 can print its explorer URL.
SEPOLIA_TX="${SEPOLIA_TX:-}"

ONE=1000000000000000000   # 1 KRCN, 18 decimals

MARK_TUPLE='getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))'

SCENES="${SCENES:-all}"
RECORD="${RECORD:-0}"

want() { case " $SCENES " in *" all "*) return 0 ;; *" $1 "*) return 0 ;; *) return 1 ;; esac; }
banner() { printf '\n=== scene %s — %s\n' "$1" "$2"; }

# --- scene 2 — live sanctions screening ---------------------------------------------------------
# On camera this runs in the browser at $DEMO_URL/ (the page ships this exact preset). The terminal
# form is the same request, kept here so the claim can be checked without a browser.

if want 2; then
  banner 2 "live sanctions screening"
  curl -sS --max-time 30 -X POST "$DEMO_URL/api/screen" \
    -H 'content-type: application/json' \
    -d '{"fullName":"Kim Jong Un","dateOfBirth":"1984-01-08","nationality":"KP"}' \
    | tr ',' '\n' | grep -E '"decision"|"riskBand"|"listId"|"entryId"|"corroborated"'
  # -> "decision":"BLOCK"
  # -> "riskBand":5
  # -> "listId":"OFAC_SDN"   "entryId":"20157"   "corroborated":true
fi

# --- scene 3 — what this deployment is configured to run ----------------------------------------
# The disclosure the narration is required to speak: the id and bank vendors are labelled demo
# adapters, and the screening axis is real.

if want 3; then
  banner 3 "vendor configuration of the hosted deployment"
  status_json="$(curl -sS --max-time 30 "$DEMO_URL/api/kyc/status")"
  printf '%s\n' "$status_json" | tr ',' '\n' | grep -E '"demo"|"sandboxBits"|"vendor"|"live"|"configured"|"address"'
  # -> "demo":true          the deployment runs the labelled demo tier
  # -> "sandboxBits":true   so the mark carries regime KR_FSC_NONFACE_SANDBOX
  # -> "vendor":"demo:id"   "vendor":"demo:bank"   "live":false
  # -> "configured":true    for id, bank and issuer
  # -> "address":"0x93C62D3016123Da0aBdB4AC1857564c30CbE5629"
  #      NB this is ComplianceSource on Sepolia, the contract the issuer writes to — not the signing
  #      EOA. The signer appears as onchain.issuer in the /verify issuance response.
  printf '%s' "$status_json" | grep -q '"demo":true'         || { echo 'FAIL: demo mode is off'; exit 1; }
  printf '%s' "$status_json" | grep -q '"sandboxBits":true'  || { echo 'FAIL: sandbox bits are off'; exit 1; }
  printf '%s' "$status_json" | grep -q '"issuer":{"configured":true' || { echo 'FAIL: no issuer key'; exit 1; }
  echo 'ok: demo tier on, sandbox regime on, issuer key present'
fi

# --- scene 4 — the Sepolia issuance transaction -------------------------------------------------
# Copy onchain.txHash out of the /verify result panel and open it. Export SEPOLIA_TX to have the
# URL printed for you.

if want 4; then
  banner 4 "the Sepolia issuance transaction"
  echo "explorer: $SEPOLIA_EXPLORER/address/$SRC   (ComplianceSource, Sepolia)"
  if [ -n "$SEPOLIA_TX" ]; then
    echo "issuance: $SEPOLIA_EXPLORER/tx/$SEPOLIA_TX"
    cast receipt "$SEPOLIA_TX" --rpc-url "$SEP" 2>/dev/null | grep -E '^(status|gasUsed|blockNumber)' || true
    # -> status 1 (success); gasUsed near the 27,933 measured for ComplianceSource.issue()
  else
    echo 'SEPOLIA_TX not set — on camera this scene is the browser, not the terminal'
  fi
fi

# --- scene 6 — the verifier, and one mark under two policies ------------------------------------

if want 6; then
  banner 6 "Creditcoin verdicts"

  # One address, two different contracts. Same deployer, same nonce, two chains, so CREATE agreed.
  cast code $ASC --rpc-url "$CC3" | wc -c     # -> 18121   ProofmarkASC on Creditcoin
  cast code $SRC --rpc-url "$SEP" | wc -c     # ->  7479   ComplianceSource on Sepolia
  # (wc pads its count with leading spaces; the digits are what matters)

  # The ASC accepts a proof from one source chain and one source contract only.
  cast call $ASC 'expectedChainKey()(uint64)' --rpc-url "$CC3"   # -> 1   Sepolia
  cast call $ASC 'sourceContract()(address)'  --rpc-url "$CC3"   # -> 0x93C62D3016123Da0aBdB4AC1857564c30CbE5629

  # The same mark, two policies, two answers. This is the portability claim, on chain.
  cast call $REG 'isVerified(address,uint256)(bool)' $SUB 1 --rpc-url "$CC3"  # -> false  policy 1, KR VASP production
  cast call $REG 'isVerified(address,uint256)(bool)' $SUB 2 --rpc-url "$CC3"  # -> true   policy 2, KR pilot

  # Policy 1, re-read from chain. Nothing here was relaxed to make anything pass.
  cast call $REG 'policies(uint256)(uint32,uint8,uint40,bool,bool)' 1 --rpc-url "$CC3"
  # -> 65572 [6.557e4]   requireAll 0x10024 = ID_DOC_AUTHENTICITY|BANK_ACCOUNT|SANCTIONS_SCREENED
  # -> 2                 minAssurance
  # -> 0 / false / true   maxAge, requireRoster, enabled

  # Record-time only: the mark issued through /verify before the labelled cut has now crossed.
  if [ "${RECORD:-0}" = "1" ]; then
    : "${TAKE_B_SUBJECT:?export the subject address of the mark pre-issued through /verify — PREFLIGHT step (i)}"
    cast call $REG 'isVerified(address,uint256)(bool)' "$TAKE_B_SUBJECT" 1 --rpc-url "$CC3"  # -> true
    cast call $ASC "$MARK_TUPLE" "$TAKE_B_SUBJECT" --rpc-url "$CC3"
    # -> status 1 ACTIVE, origin 1 Direct, kind 1, assurance 3, regime 2 sandbox, jurisdiction 410 KR
  fi
fi

# --- scene 7 — GatedRwaNote refuses, then allows -------------------------------------------------

if want 7; then
  banner 7 "the gate"

  # The token's own preflight view, before anyone spends gas.
  cast call $NOTE 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_CONTROL"   --rpc-url "$CC3"  # -> false
  cast call $NOTE 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> true

  # The revert itself, reproduced as a call so it costs nothing. --from is what exercises the gate:
  # without it msg.sender is zero, onlyOwner fires first, and you get OwnableUnauthorizedAccount
  # (0x118cdaa7) instead of the gate's RecipientNotVerified (0x17887111).
  if out="$(cast call $NOTE 'transfer(address,uint256)' "$RWA_CONTROL" $ONE --from "$RWA_HOLDER" --rpc-url "$CC3" 2>&1)"; then
    echo "FAIL: the gate let an unverified recipient through: $out"; exit 1
  fi
  printf '%s\n' "$out" | grep -o '0x17887111[0-9a-f]*' | cut -c1-10
  # -> 0x17887111   RecipientNotVerified(0x680Cc6e5..., 1)   the gate, not onlyOwner

  # And the transfer the gate allows, also as a call, also free.
  cast call $NOTE 'transfer(address,uint256)(bool)' "$RWA_RECIPIENT" $ONE --from "$RWA_HOLDER" --rpc-url "$CC3"  # -> true

  # Balances before anything moves.
  cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_HOLDER"    --rpc-url "$CC3"  # -> 60000000000000000000 [6e19]
  cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> 40000000000000000000 [4e19]

  # Record-time only: the same two transfers as real transactions, so the revert and the success
  # both land on chain in front of the camera. A's key is testnet-only and lives in the gitignored
  # root .env as DEMO_SUBJECT_A_KEY. Estimation refuses the reverting one, so force the gas limit.
  if [ "${RECORD:-0}" = "1" ]; then
    : "${DEMO_SUBJECT_A_KEY:?export from the gitignored root .env — the testnet-only key for the holder A}"
    echo '--- the gate refuses, on chain'
    refused="$(cast send $NOTE 'transfer(address,uint256)' "$RWA_CONTROL" $ONE \
      --gas-limit 200000 --private-key "$DEMO_SUBJECT_A_KEY" --rpc-url "$CC3" 2>&1 || true)"
    printf '%s\n' "$refused" | grep -Ei 'status|transactionHash|revert' || printf '%s\n' "$refused"
    # -> status 0 (failed). Reverted on chain, gas spent, no tokens moved

    echo '--- the gate allows, on chain'
    cast send $NOTE 'transfer(address,uint256)' "$RWA_RECIPIENT" $ONE \
      --private-key "$DEMO_SUBJECT_A_KEY" --rpc-url "$CC3" | grep -Ei 'status|transactionHash|blockNumber'
    # -> status 1 (success)

    cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> 41000000000000000000 [4.1e19]
    echo "explorer: $CC3_EXPLORER/address/$NOTE"
  fi
fi

# --- scene 8 — a revoked subject, and what is actually stored ------------------------------------

if want 8; then
  banner 8 "revocation, and zero personal data"

  # tombstone() is a function of ProofmarkASC, not the registry — the registry consults it internally.
  cast call $ASC 'tombstone(address)(bool)' $REVOKED --rpc-url "$CC3"  # -> true
  cast call $REG 'isVerified(address,uint256)(bool)' $REVOKED 1 --rpc-url "$CC3"  # -> false
  cast call $REG 'isVerified(address,uint256)(bool)' $REVOKED 2 --rpc-url "$CC3"  # -> false, a tombstone outranks every policy

  # The whole mark. Field order matters: status, origin, kind, assurance, regime, jurisdiction, methods.
  cast call $ASC "$MARK_TUPLE" $SUB --rpc-url "$CC3"
  # -> (1, 1, 1, 1, 2, 410, 1638401, 1788144389, 1819680389, 0,
  #     0x6e7b9593fb19589c00d6c5416cb8606aadf69fb3f28acb73eee1a265aaaf05c9,
  #     0x3f976d2fa1edd537afada70ffad28e8a16a6af253115dcf578ea72eb7e4f47d7,
  #     0xFD1222e35a536A62f180aA44826656940e86bD5E)
  #    status 1 ACTIVE, origin 1 Direct, kind 1, assurance 1, regime 2 sandbox, jurisdiction 410 KR,
  #    methods 0x190001. Two 32-byte commitments and an issuer address. No name, no date of birth,
  #    no document number, no account number.
  echo "the /onchain page renders the same two subjects: $DEMO_URL/onchain"
fi

printf '\nread-only checks complete (SCENES=%s, RECORD=%s)\n' "$SCENES" "$RECORD"
