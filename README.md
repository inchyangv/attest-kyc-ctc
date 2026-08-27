# Proofmark — 국제 KYC·AML 증명 레이어 (Creditcoin × Attestcoin)

> **BUIDL CTC 2026 Fall** 제출작 · Track: **RWA**
> 이더리움에서 발급된 신원확인 결과를 **중앙 오라클 없이** Creditcoin에서 수학적으로 검증하고, 모든 체인이 읽게 만든다.

---

## 1. 무엇을 푸는가

온체인 금융이 규제권에 들어오면 모든 서비스가 같은 질문을 한다 — **"이 지갑과 거래해도 되는가."**

지금 답을 얻는 방법은 셋뿐이고 전부 나쁘다. ① 체인마다 KYC를 다시 짓는다(개인정보 처리자 지위가 체인 수만큼 곱해진다) ② 중앙 서명 서버를 믿는다(키 하나가 단일 실패점) ③ 릴레이어를 믿는다(신뢰를 옮겼을 뿐 없애지 못했다).

그리고 국경을 넘으면 문제가 하나 더 있다 — **"KYC 완료"는 나라마다 다른 확인 행위를 가리킨다.** 한국의 비대면 실명확인, EU의 eIDAS, 미국의 CIP가 요구하는 것이 서로 다르다.

**Proofmark의 답:**

- 마크에 **결론이 아니라 수행한 확인 행위**(`methods` 비트맵)를 싣는다. 등가성 판정은 우리가 아니라 **소비자 dApp이 자기 관할 정책으로** 한다.
- 그 마크가 이더리움에서 실제로 발급됐다는 것을 **Attestcoin이 증명**한다. 우리를 믿을 필요가 없다.
- 개인정보는 온체인에 **0바이트**. 커밋먼트와 해시만 올라간다.

---

## 2. Attestcoin Protocol Integration Summary

**Attestcoin은 부가 기능이 아니라 이 제품의 신뢰 모델 그 자체다.** 제거 테스트로 보인다.

| Attestcoin을 빼면 | 남는 것 |
|---|---|
| Creditcoin은 이더리움의 발급 사실을 알 방법이 없다 | 우리가 운영하는 **중앙 릴레이어** — 제품의 존재 이유가 사라진다 |
| 에폭 명부 루트의 진위를 검증할 수 없다 | 발급사 서명 신뢰 = 위 ②번으로 회귀 |
| 스포크 체인 미러의 위조를 반증할 수 없다 | 미러 운영자 신뢰 = 위 ③번으로 회귀 |

### 사용 지점

| # | 어디서 | 무엇을 |
|---|---|---|
| 1 | `worker/` | `attested-height` 폴링 → `proof-by-tx` 증명 획득 → ASC 제출 |
| 2 | `src/ASCBaseX.sol` | **`ASCBase` 포크** — `chainKey`·`blockHeight`를 핸들러에 전달 (§4 보안) |
| 3 | `src/ProofmarkASC.sol` | BlockProver 프리컴파일(`0x…0FD2`)로 **한 블록 안에서 동기 검증** |
| 4 | `src/ComplianceSource.sol` | `issueBatch`/`revokeBatch` — 한 tx에 N개 이벤트 → `execute()` 1회로 N건 반영 |
| 5 | `script/check_chains.ts` | ChainInfo 프리컴파일(`0x…0fd3`)로 `chainKey` **런타임 확인** (하드코딩 금지) |

### 왜 배치하는가 — 프로토콜 경제를 읽은 설계

Attestcoin은 **읽기가 무료**다([공식](https://attestcoin.org): *"Reading other chains stays free"*). 우리 실측에서도 `execute()` 차감액은 가스비와 정확히 일치했고 별도 수수료가 없었다. 그래서 "ATC 수요를 창출한다"는 주장은 **하지 않는다.**

배치의 진짜 근거는 **이더리움 L1 발급 비용**이다. 사용자 10만 명이면 L1 트랜잭션 10만 건이고 그 가스는 발급사가 문다. **에폭 명부 루트는 L1 쓰기를 사용자 수와 무관하게 고정**시킨다.

---

## 3. 5분 재현

### 배포 주소

| 컨트랙트 | 체인 | 주소 |
|---|---|---|
| `EvmV1Decoder` | CC3 Testnet (102031) | `0xff3558704c75ed69e1D657474210365b24d31938` |
| `ProofmarkASC` | CC3 Testnet | `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` |
| `ProofmarkRegistry` | CC3 Testnet | `0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc` |
| `ComplianceSource` | **Sepolia** (11155111) | `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` |
| `GatedRwaNote` | CC3 Testnet | `0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625` |

> **ASC(CC3)와 ComplianceSource(Sepolia) 주소가 같다.** 같은 배포자·같은 nonce면 체인이 달라도 CREATE 주소가 같아지는 산술적 결과다. 바이트코드가 다르고(18,120 vs 7,478자) 각자 자기 인터페이스에만 응답한다 — 아래 명령으로 직접 확인할 수 있다.

### 실행 기록

| 무엇 | tx |
|---|---|
| Sepolia 마크 발급 | [`0x93e4f981…9a01`](https://sepolia.etherscan.io/tx/0x93e4f981d209a618ac32e20128c95fd45d95b2a31b83f5d1d118eeba50269a01) · block 11,597,799 |
| CC3 증명 제출 (BlockProver 검증) | `0xe0f8f6d4…` · gas 386,008 |
| 게이트 통과 mint | `0x8f6789cf…c138` |

### 명령

```sh
CC3=https://rpc.cc3-testnet.creditcoin.network
SEP=https://ethereum-sepolia-rpc.publicnode.com
ASC=0x93C62D3016123Da0aBdB4AC1857564c30CbE5629
REG=0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc
NOTE=0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625
SUB=0xFD1222e35a536A62f180aA44826656940e86bD5E

# ① 같은 주소, 다른 컨트랙트임을 확인
cast code $ASC --rpc-url $CC3 | wc -c      # 18121  (ProofmarkASC)
cast code $ASC --rpc-url $SEP | wc -c      #  7479  (ComplianceSource — 다른 컨트랙트다)

# ② ASC 가 소스 체인을 고정하고 있다 (위조 chainKey 방어)
cast call $ASC "expectedChainKey()(uint64)" --rpc-url $CC3     # → 1 (Sepolia)
cast call $ASC "sourceContract()(address)"  --rpc-url $CC3

# ③ 크로스체인으로 넘어온 마크 — 필드 순서 주의 (origin 이 2번째다)
cast call $ASC "getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))" $SUB --rpc-url $CC3
#   status=1(ACTIVE) origin=1(Direct) kind=1 assurance=2 regime=1 jurisdiction=410(KR)
#   methods=0x19003f  claimsRoot / evidenceHash / issuer

# ④ 게이트
cast call $ASC  "tombstone(address)(bool)" $SUB --rpc-url $CC3               # → true  (폐기됨)
cast call $REG  "isVerified(address,uint256)(bool)" $SUB 1 --rpc-url $CC3   # → false
cast call $REG  "isVerified(address,uint256)(bool)" $SUB 2 --rpc-url $CC3   # → false
cast call $NOTE "mint(address,uint256)" $SUB 1000000000000000000 --from $SUB --rpc-url $CC3
#   → revert 0x17887111 = RecipientNotVerified  ← 게이트가 닫혀 있다
```

> ℹ️ **왜 전부 `false`인가 — 이게 이 저장소의 성격을 보여주는 기록이다.**
> 이 주체에게는 원래 마크가 있었다. 그런데 그 마크의 `methods`는 파이프라인 검증용으로 **손으로 만들어 넣은 값**이라, 우리가 하지 않은 확인(`ID_DOC_AUTHENTICITY`·`BANK_ACCOUNT`)을 주장하고 있었다.
> **우리 제품이 막으려는 것이 바로 그런 마크이므로 온체인에서 폐기했다** (사유 `ISSUER_ERROR`). 전파에 8분 43초가 걸렸고, 그 순간 게이트가 다시 닫혔다.
> 폐기가 **deny > allow** 로 정책 1·2를 모두 막는 것도 확인된다 — 툼스톤은 어떤 정책보다 우선한다.

> 🔴 **`--from` 을 빼지 마세요.** `cast call` 은 msg.sender 를 0으로 두므로 `onlyOwner` 가 **먼저** 걸려 `OwnableUnauthorizedAccount`(`0x118cdaa7`)가 납니다. 게이트가 아니라 소유권 검사입니다. 진짜 게이트 거절은 `RecipientNotVerified`(`0x17887111`)입니다. **우리가 먼저 이 함정에 걸렸습니다.**

> ℹ️ CC3에서 `forge`/`cast` 가 `missing field mixHash` 에러를 뱉는 것은 정상입니다. CC3가 Substrate 기반이라 블록 포맷이 달라서 나는 로그이고 동작에는 영향이 없습니다.

---

## 4. 아키텍처

```
Ethereum Sepolia (chainKey 1)            발급의 원본
  ComplianceSource.sol
    MarkIssued / MarkRevoked / SanctionDenied / RosterEpochPublished
            │
            │ (watch)
  Offchain  ├─ KR 어댑터: 신분증 인증 → 계좌 인증 → 3축 맵핑 대사
            ├─ AML 엔진:  OFAC·UN·EU 26,566 엔트리 실심사
            ├─ 증적:      단계별 해시체인 → evidenceHash
            └─ 워커:      어테스트 대기(재시도) → 증명 → ASC 제출(멱등)
            │
            │ merkleProof + continuityProof
Creditcoin CC3                            기록의 정본
  ProofmarkASC  ── BlockProver(0x…0FD2) 동기 검증
                ├─ chainKey 고정 · 재생 방지 · 순서 커서
                └─ marks / tombstone / epochRoots
  ProofmarkRegistry  isVerified(subject, policyId)
  GatedRwaNote       정책 통과자끼리만 이전되는 RWA 데모 토큰
```

### 보안 — `ASCBase`를 포크한 이유

예제 `ASCBase.execute()`는 `chainKey`·`blockHeight`를 **받고도 핸들러에 넘기지 않는다.** 그대로 상속하면 두 가지가 막히지 않는다.

| 결함 | 무엇이 뚫리나 | 방어 |
|---|---|---|
| **chainKey 위조** | CC3는 Sepolia(1)와 이더리움 메인넷(3)을 동시 지원한다. 핸들러가 `log.address_`만 보므로, `CREATE2`로 메인넷에 같은 주소를 먼저 점유하면 거기서 발행한 이벤트가 통과한다 | `require(chainKey == expectedChainKey)` |
| **순서 역전** | 제출이 permissionless이고 순서 강제가 없다. `MarkIssued`(block 100)를 `MarkRevoked`(block 200) **뒤에** 제출하면 폐기된 마크가 되살아난다. `queryId`가 달라 재생 방지에 안 걸리고 둘 다 정당한 증명이다 | `lastAppliedHeight` 커서 |

두 방어 모두 **뮤테이션 테스트로 검증**했다 — 가드를 제거하면 정확히 해당 테스트만 깨진다.

---

## 5. 실측

### 크로스체인 전파

| 구간 | 값 |
|---|---|
| Sepolia 발급 | gas 27,933 |
| 워커 감지 | 발급 후 86초 |
| 어테스트 완료 | **6.5–8.5분** (관측 2회) |
| CC3 증명 검증 | gas **386,008** |
| **발급 → `isVerified` true** | **7분 55초** |

> **"즉시"라고 쓰지 않는다.** 전파 지연은 소스 체인 파이널리티가 결정하는 물리적 하한이고, 이 숫자를 제품 파라미터로 공개한다. 실시간 차단이 필요한 유스케이스는 소스 체인에서 직접 게이트해야 한다.

### AML 심사 엔진

모의 데이터를 쓰지 않는다. 원본 XML 57MB를 직접 적재한다(`bash aml/fetch-lists.sh`).

| | |
|---|---|
| 적재 | OFAC SDN 19,321 · UN 1,011 · EU FSF 6,234 = **26,566** · 이름/별칭 78,365 · **EVM 제재주소 124** |
| **재현율** | **100%** — 명단 개인 200명을 자기 이름·생년월일·국가로 조회 → 전원 적발 |
| **특이도** | **100%** — 평범한 한국 이름 600명 + 서구 10명 → 오탐 0 |
| **회피 저항** | **7/7** — 보이지 않는 문자 · 키릴 동형문자 · 발음기호 · 전각 · 어순 뒤집기 · 구두점 |
| 제재 지갑 | 이름과 무관하게 차단 (OFAC `idList` 유래) |

**한글 로마자 전개는 추론이지 사실이 아니다.**

```
김정은 (KP, 생년월일 일치) → BLOCK 밴드5    전개 적중 + 뒷받침 있음
최영호 (KR)                → ALLOW 밴드2    전개 적중 있으나 뒷받침 없음
```

`최영호`는 발음기호를 뗀 표기에서 명단의 `최용호`와 100점 일치한다(테스트로 재현). 전개를 판정에 쓰면 오탐 33%, 안 쓰면 0%인데 **김정은은 여전히 잡힌다.** 그래서 뒷받침(생년월일·국가·지갑) 없는 전개 적중은 판정을 움직이지 않되 **증적에는 남긴다.**

---

## 6. 셋업

```sh
# 컨트랙트
forge build && forge test                       # 37 passed

# 오프체인
npm install
bash aml/fetch-lists.sh                         # 제재 명단 원본 (커밋하지 않는다, 57MB)
npx tsx --test "worker/*.test.ts" "pipeline/*.test.ts" "aml/*.test.ts"   # 74 passed
npx tsx aml/eval.ts                             # AML 성능 실측

# 배포
cp .env.example .env                            # 키 채우기
./script/deploy.sh preflight                    # tx 없음 — chainKey·잔고·nonce 확인
./script/deploy.sh deploy

# 워커 (⚠️ 발급보다 먼저 띄운다 — 커서가 현재 헤드에서 시작한다)
npm run worker
```

> **`EVIDENCE_HMAC_KEY` 는 필수다.** 없으면 엔진이 기동하지 않는다. `openssl rand -hex 32` 로 만든다. 기본값을 두지 않는 이유는 기본값이 있으면 누군가 그대로 배포하기 때문이다.

---

## 7. 되는 것과 안 되는 것

이 절을 빼지 않는다. 무엇을 하지 않았는지 밝히는 것이 이 제품의 성격이다.

### 지금 정직하게 세울 수 있는 비트

| 비트 | 상태 | 근거 |
|---|---|---|
| `WALLET_CONTROL` | ✅ | EIP-4361 소유권 서명을 서버가 검증 |
| `SANCTIONS_SCREENED` | ✅ | 실명단 3종 26,566 엔트리 실심사 |
| `JURISDICTION_CHECK` | ✅ | FATF 관할 표 (⚠️ 원문 대조 전 — 증적에 '미검증'으로 기록됨) |
| `ONCHAIN_EXPOSURE` | ✅ | OFAC 제재 지갑 124건 대조 |
| `ID_DOC_AUTHENTICITY` | ❌ | 발급기관 진위확인 API — **기관 계약 필요** |
| `FACE_MATCH` · `LIVENESS` | ❌ | 벤더 미연동 |
| `BANK_ACCOUNT` | ❌ | 1원 송금 — **오픈뱅킹 제휴 필요** |
| `PEP_SCREENED` · `ADVERSE_MEDIA` | ❌ | 상용 데이터 미계약 |

### 배포된 두 정책

| policyId | 이름 | requireAll | 우리 마크 |
|---|---|---|---|
| **1** | KR VASP 실운영 | `0x10024` — 진위확인 + 계좌실명 + 제재대사 | ❌ 통과 못 함 |
| **2** | KR 파일럿 | `0x190001` — 지갑소유권 + 제재대사 + 관할확인 + 온체인노출 | ✅ 통과 |

정책 1의 기준을 낮추지 않았다. 통과하지 못한다고 기준을 낮추면 제품이 무의미해진다.

### 그래서 이런 일이 생긴다

> **우리가 발급한 마크는 우리가 정의한 KR VASP 실운영 정책(policyId 1)을 통과하지 못한다.**
>
> 그 정책은 신분증 진위확인과 계좌 실명확인을 요구하는데 우리는 그 확인을 하지 않았고, **하지 않았으므로 비트를 세우지 않았다.** 시스템이 그것을 그대로 드러낸다.
>
> 이것은 버그가 아니라 설계다. 연동 안 된 확인은 비트가 0이고 소비자 정책이 자동으로 거른다. **우리는 우리 자신에 대해서도 거짓말할 수 없다.**

벤더를 연동하면 실운영 정책도 통과한다는 것 역시 테스트로 증명돼 있다(`pipeline/integration.test.ts`) — 구조가 막힌 게 아니라 아직 연결하지 않은 것이다.

### 그 외 한계

- **Writability 미사용** — Attestcoin의 크로스체인 쓰기는 개발 중이다. 스포크 체인 전파는 로드맵이고 현재 사실이 아니다.
- **에폭 명부(Mode B)** — 구현 중. 현재 마크는 전부 `origin = Direct`이고, 그것은 "발급됐다"는 증명이지 "폐기되지 않았다"는 증명이 아니다. `Policy.requireRoster`가 그 차이를 정책으로 드러낸다.
- **FATF 관할 표 미검증** — `jurisdiction.ts`에 `verified: false`로 표시돼 있고 증적에 그대로 기록된다.
- ~~온체인 마크 1건이 합성 `methods`를 담고 있다~~ → **폐기 완료** (2026-08-30, 사유 `ISSUER_ERROR`, tx `0x6d630831…050f`). 경위는 `docs/03-product-plan.md` §9.6.
- **현재 어떤 정책도 통과하는 마크가 온체인에 없다.** 합성 마크를 폐기했고 정직한 발급은 아직 온체인에 올리지 않았다. 정직한 파이프라인이 무엇을 만드는지는 `npx tsx --test "pipeline/*.test.ts"` 로 확인할 수 있다 — `methods = 0x190001` 이 나오고, 그것은 **정책 2를 통과하고 정책 1을 통과하지 못한다.**

---

## 8. 테스트

```
Solidity    37 passed   (ASC 14 · Registry 13 · GatedRwaNote 7 · 기타 3)
TypeScript  74 passed   (워커 11 · 파이프라인 · AML 17)
타입체크    클린
```

특히 봐야 할 것:

| 테스트 | 무엇을 지키나 |
|---|---|
| `test_RejectsProofFromWrongChain` | chainKey 위조 방어 (뮤테이션 검증) |
| `test_StaleIssueCannotResurrectRevokedMark` | 순서 역전 방어 (뮤테이션 검증) |
| `test_SameMarkDifferentJurisdictionPolicies` | 같은 마크가 KR은 통과, EU는 거절 — 국제화 설계 |
| `★ 우리 마크는 KR VASP 실운영 정책을 통과하지 못한다` | 정직성 |
| `★ 하지 않은 심사는 비트를 세우지 않는다` | 정직성 |
| `★ 증적에 이름 원문이 없다 — NFC/NFD 가로질러 확인` | PII 경계 |
| `★ 탐지기 자체 검증 — 순진한 includes 는 NFD 를 놓친다` | 탐지기가 무의미해지지 않게 |

---

## 9. 문서

| | |
|---|---|
| `docs/00-hackathon-brief.md` | 대회 요건 |
| `docs/01-env-verification.md` | Attestcoin 환경 검증 |
| `docs/02-loan-flow-analysis.md` | Tutorial 4 분석 |
| **`docs/03-product-plan.md`** | **기획안 정본** — 제품·아키텍처·데이터 모델·스코프·실측 |
| `docs/04-event-schema.md` | 소스 이벤트 4종 |
| `docs/05-asc-integration-review.md` | `ASCBase` 통합 검토 |
| `docs/06-worker-design.md` | 워커 설계 |

## 라이선스 / 선행 작업

이 저장소의 코드는 해커톤 기간 중 새로 작성했다. 팀은 이전에 GIWA 체인에서 EAS 기반 컴플라이언스 어테스테이션(호패)을 만든 적이 있으며, **이관한 것은 도메인 지식(AML 정규화 규칙 설계·fail-closed 원칙)이지 코드가 아니다.**
