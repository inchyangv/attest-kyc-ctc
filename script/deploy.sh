#!/usr/bin/env bash
# Proofmark 테스트넷 배포 — CC3 Testnet(허브) + Ethereum Sepolia(소스)
#
# ⚠️ 이 스크립트는 **온체인 트랜잭션을 보낸다.** 실행 전 확인:
#    1) 다른 세션이 같은 지갑으로 tx 를 보내고 있지 않은가 (nonce 충돌)
#    2) 양쪽 체인에 잔고가 있는가
#
# 사용법:
#    source .env && ./script/deploy.sh preflight   # 검사만, tx 없음
#    source .env && ./script/deploy.sh deploy      # 실제 배포
#
# 배포 순서가 중요하다 — ProofmarkASC 는 EvmV1Decoder 라이브러리 링크가 필요하고,
# configureSource 전에는 어떤 증명도 받지 않는다(test_RejectsBeforeSourceConfigured).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/deployments/cc3-testnet.json"
DECODER_PATH="node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder"

# 실측 확인값 (docs/01-env-verification.md §3.3)
SOURCE_CHAIN_KEY="${SOURCE_CHAIN_KEY:-1}"     # chainKey 1 = Sepolia (chainId 11155111 과 다름!)

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

need() {
  local n="$1"
  if [ -z "${!n:-}" ]; then red "✗ 환경변수 $n 이 없습니다. 'source .env' 하셨나요?"; exit 1; fi
}

preflight() {
  echo "=== 사전 점검 (트랜잭션 없음) ==="
  need CREDITCOIN_RPC_URL
  need SOURCE_CHAIN_RPC_URL
  need DEPLOYER_PRIVATE_KEY

  local addr; addr=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
  echo "배포자: $addr"

  local ccid; ccid=$(cast chain-id --rpc-url "$CREDITCOIN_RPC_URL")
  local spid; spid=$(cast chain-id --rpc-url "$SOURCE_CHAIN_RPC_URL")
  echo "CC3 chainId    : $ccid   (기대값 102031)"
  echo "Sepolia chainId: $spid   (기대값 11155111)"
  [ "$ccid" = "102031" ]   || { red "✗ CC3 chainId 불일치"; exit 1; }
  [ "$spid" = "11155111" ] || { red "✗ Sepolia chainId 불일치"; exit 1; }

  local ccbal spbal
  ccbal=$(cast balance "$addr" --rpc-url "$CREDITCOIN_RPC_URL" --ether)
  spbal=$(cast balance "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL" --ether)
  echo "CC3 잔고    : $ccbal CTC"
  echo "Sepolia 잔고: $spbal ETH"

  # nonce 를 찍어 다른 세션의 동시 사용 여부를 눈으로 확인하게 한다
  echo "CC3 nonce    : $(cast nonce "$addr" --rpc-url "$CREDITCOIN_RPC_URL")"
  echo "Sepolia nonce: $(cast nonce "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL")"

  echo
  echo "지원 체인 조회 — configureSource($SOURCE_CHAIN_KEY, …) 의 chainKey 검증:"
  # chainKey 는 chainId 와 다르다. 하드코딩 대신 런타임 확인이 원칙이므로 SDK 로 실제 조회한다.
  # (cast 로는 구조체 배열 반환을 다루기 번거로워 SDK 경로를 쓴다)
  if npx --no-install tsx "$ROOT/script/check_chains.ts" "$SOURCE_CHAIN_KEY" 11155111; then
    grn "  ✓ chainKey 검증 통과"
  else
    red "✗ chainKey 검증 실패 — configureSource 가 잘못된 체인을 가리키게 됩니다. 중단합니다."
    exit 1
  fi

  grn "✓ 사전 점검 통과"
  ylw "⚠️ nonce 가 예상과 다르면 다른 세션이 이 지갑을 쓰고 있을 수 있습니다. 먼저 확인하세요."
}

deploy() {
  preflight
  echo
  ylw "이제 실제 트랜잭션을 보냅니다. 계속하려면 5초 내 Ctrl-C 로 중단하지 마세요..."
  sleep 5

  cd "$ROOT"
  local addr; addr=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")

  # ── 1. EvmV1Decoder 라이브러리 (CC3) ──────────────────────────────
  # ⚠️ 문서상 기배포 Decoder(0x731c34…F9f)는 우리 컴파일 산출물과 바이트코드 크기가
  #    다르다(19,199 vs 26,524). 동일성 미검증이므로 직접 배포한다.
  #    링크 불일치는 조용히 실패하고 어테스트 8분 사이클을 태운다.
  echo "── 1/8  EvmV1Decoder → CC3"
  local decoder
  decoder=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" "$DECODER_PATH" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$decoder" ] || { red "✗ 디코더 배포 실패"; exit 1; }
  grn "   EvmV1Decoder = $decoder"

  # ── 2. ProofmarkASC (CC3, 라이브러리 링크 필수) ────────────────────
  echo "── 2/8  ProofmarkASC → CC3  (--libraries 링크)"
  local asc
  asc=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      --libraries "${DECODER_PATH}:${decoder}" \
      src/ProofmarkASC.sol:ProofmarkASC --constructor-args "$addr" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$asc" ] || { red "✗ ASC 배포 실패 (라이브러리 링크를 확인하세요)"; exit 1; }
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

  # ── 5. 교차 등록 ──────────────────────────────────────────────────
  # ASC 는 configureSource 전까지 모든 증명을 거부한다 (설계된 fail-closed).
  echo "── 5/8  asc.configureSource(chainKey=$SOURCE_CHAIN_KEY, $srcaddr)"
  cast send "$asc" "configureSource(uint64,address)" "$SOURCE_CHAIN_KEY" "$srcaddr" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  grn "   configureSource 완료"

  echo "── 6/8  src.setIssuer($addr, true) / setEpochPublisher"
  cast send "$srcaddr" "setIssuer(address,bool)" "$addr" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  cast send "$srcaddr" "setEpochPublisher(address,bool)" "$addr" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  grn "   발급자/에폭게시자 등록 완료"

  # ── 7. 데모 정책 등록 (퍼미션리스 — dApp 이 직접 한다) ──────────────
  # KR VASP 정책: 신분증 진위확인 | 계좌 실명 | 제재 스크리닝
  #   ID_DOC_AUTHENTICITY(1<<2) | BANK_ACCOUNT(1<<5) | SANCTIONS_SCREENED(1<<16) = 0x10024
  echo "── 7/8  KR 정책 등록 → Registry"
  local krmask=$((1<<2 | 1<<5 | 1<<16))
  cast send "$reg" "registerPolicy((uint32,uint8,uint40,bool,bool))" \
      "($krmask,2,0,false,false)" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  local krpolicy; krpolicy=$(cast call "$reg" "nextPolicyId()(uint256)" --rpc-url "$CREDITCOIN_RPC_URL")
  krpolicy=$(( ${krpolicy%% *} - 1 ))
  grn "   KR policyId = $krpolicy  (methods mask 0x$(printf '%x' $krmask))"

  # ── 8. 데모 토큰 (CC3) ────────────────────────────────────────────
  echo "── 8/8  GatedRwaNote → CC3"
  local note
  note=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/GatedRwaNote.sol:GatedRwaNote \
      --constructor-args "KR Credit Note" "KRCN" "$reg" "$krpolicy" "$addr" \
      | awk '/Deployed to:/{print $3}')
  grn "   GatedRwaNote = $note"

  # ── 기록 ──────────────────────────────────────────────────────────
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
  "demo": { "krPolicyId": $krpolicy }
}
JSON
  grn "✓ 배포 완료 → $OUT"
  cat "$OUT"

  # ── 사후 검증 ─────────────────────────────────────────────────────
  echo
  echo "=== 사후 검증 ==="
  echo -n "asc.expectedChainKey : "; cast call "$asc" "expectedChainKey()(uint64)"  --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "asc.sourceContract   : "; cast call "$asc" "sourceContract()(address)"   --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.ASC              : "; cast call "$reg" "ASC()(address)"              --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "note.POLICY_ID       : "; cast call "$note" "POLICY_ID()(uint256)"       --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "src.isIssuer(deployer): "; cast call "$srcaddr" "isIssuer(address)(bool)" "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL"

  # ⚠️ 같은 배포자·같은 nonce 면 체인이 달라도 CREATE 주소가 같아진다.
  #    그 경우 configureSource 에 엉뚱한 주소를 넣어도 겉보기 결과가 똑같으므로,
  #    양쪽 바이트코드를 실제로 대조해 서로 다른 컨트랙트임을 확인한다.
  echo
  echo "=== 주소 충돌 검사 (ASC vs ComplianceSource) ==="
  if [ "${asc,,}" = "${srcaddr,,}" ] || [ "$(echo "$asc" | tr 'A-Z' 'a-z')" = "$(echo "$srcaddr" | tr 'A-Z' 'a-z')" ]; then
    ylw "  두 주소가 같습니다 — 체인별 바이트코드를 대조합니다"
    local ccode scode
    ccode=$(cast code "$asc"     --rpc-url "$CREDITCOIN_RPC_URL"  | wc -c | tr -d ' ')
    scode=$(cast code "$srcaddr" --rpc-url "$SOURCE_CHAIN_RPC_URL" | wc -c | tr -d ' ')
    echo "  CC3     : $ccode chars"
    echo "  Sepolia : $scode chars"
    if [ "$ccode" = "$scode" ]; then
      red "✗ 양쪽 바이트코드가 같습니다 — configureSource 가 잘못된 컨트랙트를 가리킬 수 있습니다"; exit 1
    fi
    grn "  ✓ 서로 다른 컨트랙트 확인"
  fi

  # ── 게이트가 실제로 닫혀 있는지 '확인'한다 (안내만 하지 않는다) ────
  #
  # ⚠️ `cast call` 은 msg.sender 를 0 으로 두므로 --from 없이는 onlyOwner 가 먼저 걸린다.
  #    OwnableUnauthorizedAccount(0x118cdaa7) 와 RecipientNotVerified(0x17887111) 는
  #    둘 다 "revert" 로 보이지만 의미가 전혀 다르다. 셀렉터까지 대조해야 한다.
  echo
  echo "=== 게이트 폐쇄 확인 (아직 아무도 인증되지 않은 상태) ==="
  local gateout
  gateout=$(cast call "$note" "mint(address,uint256)" "$addr" 1000000000000000000 \
              --from "$addr" --rpc-url "$CREDITCOIN_RPC_URL" 2>&1 || true)
  if echo "$gateout" | grep -q "17887111\|RecipientNotVerified"; then
    grn "  ✓ RecipientNotVerified — 게이트가 닫혀 있습니다 (기대한 동작)"
  elif echo "$gateout" | grep -q "118cdaa7\|OwnableUnauthorized"; then
    red "  ✗ OwnableUnauthorizedAccount — --from 이 누락됐습니다. 게이트를 검증하지 못했습니다"; exit 1
  else
    red "  ✗ 예상치 못한 결과: $gateout"; exit 1
  fi

  echo
  grn "배포·검증 완료. 다음: Sepolia 에서 실발급 → 워커가 증명 제출 → isVerified true → note.mint 성공"
  ylw "재현 시 주의: cast call 에는 반드시 --from 을 붙이세요. 없으면 onlyOwner 가 먼저 걸려 잘못된 결론이 납니다."
  ylw "CC3 에서 forge/cast 가 뱉는 'missing field mixHash' 에러는 Substrate 블록 포맷 차이로, 동작에는 영향이 없습니다."
}
