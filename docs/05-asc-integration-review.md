# ASC 통합 검토 — 기획안 §5·§6 vs 실제 프로토콜 동작

> 작성일 2026-08-30 · 검토자 Tech Lead (세션 A)
> 대상: [`03-product-plan.md`](03-product-plan.md) §5 아키텍처 · §6 데이터 모델
> 근거: [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md) (코드 정독) + `reference/attestcoin-protocol-examples` 실코드 확인 + 형제 세션 E2E 실측
>
> **결론 요약:** 기획안의 방향은 옳다. 다만 **`ASCBase`를 그대로 상속하면 구현 불가능한 요구사항이 3개** 있고,
> 그중 2개는 **보안 결함**으로 이어진다. `ASCBase`를 포크해야 한다.

---

> ✅ **2026-08-30 갱신 — 발견 1·2·3 은 이제 추정이 아니라 코드로 증명됐다.**
> `ASCBaseX` 포크와 `ProofmarkASC` 를 구현하고 로컬 모의 하네스(`vm.etch` 로 프리컴파일 주입)로
> **14개 테스트 전량 통과**. 특히:
> - `test_RejectsProofFromWrongChain` — 메인넷(chainKey 3) 증명이 거부되는 것을 증명 (§1)
> - `test_StaleIssueCannotResurrectRevokedMark` — 폐기 후 오래된 발급 증명이 마크를 되살리지 못함을 증명 (§2)
> - `test_BatchIssueProcessesAllLogs` — `verifyBatch` 없이 한 tx 3건 배치 반영 (§3)
>
> 구현 위치는 [`04-event-schema.md`](04-event-schema.md) §8 참조.

---

## 요약표

| # | 발견 | 심각도 | 기획안 영향 |
|---|---|---|---|
| **1** | `_processAndEmitEvent`에 **`chainKey`가 전달되지 않음** → 소스 체인 고정 불가 | 🔴 **높음** | §5 ASC 설계 수정 |
| **2** | `_processAndEmitEvent`에 **`blockHeight`가 전달되지 않음** → 순서 보장 불가 | 🔴 **높음** | §6.4 판정 규칙에 항목 추가 |
| **3** | **`verifyBatch` 진입점이 컨트랙트 측에 없음** (SDK에만 존재) | 🟡 중간 | §5.2 "폐기 다발 1 tx" 주장 수정 |
| **4** | `EvmV1Decoder`는 **라이브러리** — 별도 배포 + 링크 필요 | 🟡 중간 | §9.2 배포 단계 누락 |
| **5** | §7-7 재생 방지 키가 실제 `queryId`와 **입도 불일치** | 🟢 낮음 | §7-7 문구 조정 |
| **6** | §5.2 배치 논거가 **ATC 경제 가정에 의존** — 실측으로 흔들림 | 🟡 중간 | **논거 교체 권고 (§6에 대안 제시)** |
| 7 | 퍼미션리스 `materialize` 전제는 **정확함** | ✅ | 변경 불필요 |

---

## 1. 🔴 `chainKey`가 핸들러에 전달되지 않는다

### 사실 관계 (실코드 확인)

```solidity
// ASCBase.sol:18
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;
//                            ↑ chainKey 없음  ↑ blockHeight 없음
```

`execute()`는 `chainKey`를 받아 **증명 검증에만** 쓰고(`VERIFIER.verifyAndEmit`), 핸들러에는 넘기지 않는다.

```sh
$ grep -n "chainKey" contracts/sol/ASCLoanManager.sol
# → 결과 없음. 예제 ASC는 chainKey를 한 번도 검증하지 않는다.
```

### 왜 문제인가

CC3 Testnet은 **두 개의 소스 체인을 동시에 지원**한다 (실측 확인):

| chainKey | 체인 | chainId |
|---|---|---|
| 1 | Ethereum **Sepolia** | 11155111 |
| 3 | Ethereum **Mainnet** | 1 |

ASC가 검증하는 것은 `log.address_ == sourceContract` 하나뿐이다. **어느 체인에서 온 로그인지는 보지 않는다.**
→ 주소 `X`의 컨트랙트가 **메인넷에도** 존재하고 공격자가 그 컨트랙트를 통제하면, 메인넷에서 발행한 위조 이벤트가 **Sepolia 것으로 통과한다.**

### 실제 악용 가능성 — 배포 방식에 달렸다

| 배포 방식 | 악용 가능? |
|---|---|
| 일반 `CREATE` (우리 EOA + nonce) | **어려움** — 공격자가 우리 배포키를 가져야 같은 주소를 만든다 |
| **`CREATE2` 결정적 배포** (Foundry 기본 팩토리 `0x4e59…4956C` 등) | **가능** — 주소가 `(팩토리, salt, 바이트코드)`로만 결정된다. 공격자가 **동일 바이트코드를 메인넷에 먼저 배포하면 그 컨트랙트의 owner가 되어** 임의의 `MarkIssued`를 emit할 수 있다 |

멀티체인 동일 주소 배포는 흔한 관행이라 **CREATE2를 쓸 가능성이 높다.** 그 순간 이건 이론이 아니다.

### 조치

`ASCBase`를 포크해 `chainKey`를 핸들러에 노출하고, 첫 줄에서 고정한다.

```solidity
require(chainKey == expectedChainKey, "unexpected source chain");
```

> 한 줄이면 막힌다. **비용이 0이고 배포 방식과 무관하게 안전해진다** — 넣지 않을 이유가 없다.

---

## 2. 🔴 `blockHeight`가 없어 순서를 보장할 수 없다

### 시나리오

증명 제출은 **permissionless**이고 **순서가 강제되지 않는다.** 누구나 아무 때나 오래된 증명을 낼 수 있다.

```
Sepolia block 100 : MarkIssued(Alice)      ← 발급
Sepolia block 200 : MarkRevoked(Alice)     ← 폐기 (제재 적중)

제출 순서 (공격자 선택):
  1) block 200 증명 제출 → Alice 폐기됨 ✅
  2) block 100 증명 제출 → _onIssued 실행 → Alice ACTIVE 로 부활 ❌
```

`queryId`가 다르므로(`blockHeight`가 다름) **재생 방지에 걸리지 않는다.** 둘 다 정당한 증명이다.

### 기획안 §6.4와의 충돌

§6.4는 *"deny > allow. 툼스톤은 어떤 에폭 루트보다 우선한다"* 고 규정한다. 툼스톤 우선순위는 이 공격을 **부분적으로만** 막는다:
- `MarkRevoked` → `tombstone[W] = 1` 로 구현하면 이후 `MarkIssued`가 `status`를 바꿔도 `isVerified`가 툼스톤에서 걸린다 ✅
- 그러나 **툼스톤을 해제할 수 있는 경로**(오탐 해소, §7-10)가 생기는 순간, 또는 `SUSPENDED → ACTIVE` 전이가 생기는 순간 순서 역전이 실제 위험이 된다
- `expiry` 연장 같은 **필드 갱신**도 오래된 발급으로 되돌릴 수 있다

### 조치

subject별 **단조 증가 커서**를 둔다. 이를 위해 `blockHeight`가 핸들러에 필요하다.

```solidity
mapping(address => uint64) public lastAppliedHeight;
// 핸들러 안에서
if (blockHeight <= lastAppliedHeight[subject]) continue;   // 오래된 증명은 무시
lastAppliedHeight[subject] = blockHeight;
```

> ⚠️ **동일 블록 내 순서는 여전히 미해결.** 같은 블록에 발급과 폐기가 함께 있으면 `<=` 로는 구분 못 한다.
> **완화**: `ComplianceSource`가 같은 블록에서 한 subject에 대해 상반된 이벤트를 내지 않도록 오프체인에서 직렬화한다.
> (C1 룰 — 한 tx 한 종류 — 과 결합하면 실무상 충분하다)

---

## 3. 🟡 `verifyBatch` 진입점이 컨트랙트에 없다

### 사실 관계

```sh
$ grep -rn "verifyBatch" contracts/sol/ node_modules/@gluwa/usc-contracts/contracts/
# → 결과 없음

$ grep -rn "verifyBatch" node_modules/@gluwa/usc-sdk/dist/block-prover/index.js
# → 205: verifyBatch(chainKey, heights, encodedTransaction, merkleProofs, sharedProof)
```

`verifyBatch`는 **SDK(오프체인)와 프리컴파일에는 있지만 `ASCBase`에는 없다.**
`ASCBase.execute()`는 단일 증명만 받는다 — `INativeQueryVerifier` 인터페이스에도 `verifyAndEmit`(단건)만 선언돼 있다.

### 기획안 §5.2 영향

> §5.2: *"`verifyBatch`(연속성 증명 1개 공유, 최대 10쿼리)를 폐기 다발 처리에 쓴다. 긴급 폐기가 몰릴 때 쓰기 1건으로 10건을 처리한다."*

이건 **자동으로 얻어지지 않는다.** 직접 구현해야 하고, 프리컴파일의 배치 인터페이스 시그니처를 우리가 Solidity로 다시 선언해야 한다.

### 권고 — 더 싼 길이 있다

**배치는 `verifyBatch` 없이도 얻어진다.** ([`02` §8.1](02-loan-flow-analysis.md))

| 방법 | 대상 | 필요 작업 |
|---|---|---|
| **한 tx에 동종 이벤트 N개 → 로그 순회** | 같은 소스 tx 안의 N건 | `getLogsByEventSignature` 결과를 **전부 순회**하면 끝. `ASCBase` 그대로 사용 가능 ✅ |
| `verifyBatch` | **서로 다른 tx 10건** | 프리컴파일 배치 인터페이스 직접 구현 필요 ⚠️ |

우리는 `revokeBatch()`로 **한 tx에 N개 이벤트**를 낼 수 있으므로 **첫 번째 방법으로 충분하다.**
`verifyBatch`는 P1 이하로 내리거나 스코프에서 빼는 것을 권고한다 — 구현 비용 대비 이득이 작다.

---

## 4. 🟡 `EvmV1Decoder` 라이브러리 배포 단계 누락

기획안 §9.2 배포 일정에 이 단계가 없다. 빼먹으면 `ProofmarkASC` 배포가 **실패한다.**

```sh
# 1) 라이브러리 먼저 배포
forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
  node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder

# 2) 그 주소를 링크해서 ASC 배포
forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
  --libraries node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder:<주소> \
  src/ProofmarkASC.sol:ProofmarkASC
```

→ §9.2 **D-9~D-8** 항목에 "EvmV1Decoder 배포 + 링크"를 선행 단계로 명시할 것.

> ⚠️ **기배포 주소 재사용은 보류 권고.** 문서상 CC3 Testnet "Decoder Contract"
> `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` 를 링크 대상으로 쓰자는 제안이 있었으나,
> **우리 컴파일 산출물과 바이트코드 크기가 다르다** — 배포본 19,199 hex chars vs 로컬 26,524 hex chars.
> 컴파일러/최적화 설정 차이일 수도 있고 다른 버전일 수도 있다.
> 링크 불일치는 **조용히 실패하고 8분 사이클을 태운다.** 절감액은 0.0002 CTC 수준이므로,
> 동일성이 검증되기 전에는 **직접 배포**한다.

---

## 5. 🟢 재생 방지 키 입도 불일치 (문구 조정)

| | 키 |
|---|---|
| 기획안 §7-7 | `(chainKey, srcContract, srcTxHash, logIndex)` |
| **실제 `ASCBase`** | `(chainKey, blockHeight, txIndex)` |

`(blockHeight, txIndex)`는 `srcTxHash`와 **동등한 식별력**을 가지므로 문제없다.
다만 `logIndex`는 **포함되지 않는다** — 대신 한 `execute()`가 그 tx의 모든 로그를 **원자적으로** 처리하므로 로그 단위 중복이 발생하지 않는다.
`srcContract`도 키에 없지만 `log.address_` 검증이 그 역할을 한다.

→ §7-7을 실제 키로 고쳐 쓰고, "로그 단위 멱등성은 원자적 순회로 보장"이라고 적을 것. **기능적 변경은 없다.**

---

## 6. 🟡 §5.2 배치 논거 — 전제를 바꿔야 한다

### 무엇이 흔들렸나

§5.2는 배치의 근거를 **"프로토콜 경제 — 읽기 무료·쓰기 유료"** 로 잡았다.
그런데 형제 세션 E2E 실측에서:

| 항목 | 실측 |
|---|---|
| CC3 `execute()` 가스 | 394,982 |
| 가스가격 | 0.5 gwei |
| **차감액** | **0.0002 CTC — 가스비와 정확히 일치** |
| 별도 오라클 수수료 | **없음** |

**Readability 경로에는 ATC 수수료가 붙지 않는다.** 유료인 것은 Writability(개발 중)로 보인다.
→ "우리 제품이 ATC 수요를 창출한다"와 "쓰기 원가 때문에 배치해야 한다"는 **둘 다 근거를 잃었다.**

### 그런데 결론은 살아남는다 — 전제만 바꾸면 된다

배치의 진짜 비용 중심은 **Creditcoin이 아니라 Ethereum(소스 체인)** 이다.

| 비용 | 사용자 10만 명 | 판단 |
|---|---|---|
| Creditcoin `execute()` | 0.0002 CTC × N | **무시 가능** — 배치 근거 안 됨 |
| **Ethereum L1 발급 tx** | **10만 건의 L1 가스** | 🔴 **여기가 진짜 원가** |
| 크로스체인 왕복 시간 | 8~10분 × N (병렬 가능) | 중간 |

**교체할 논거:**

> 에폭 명부의 근거는 Creditcoin 쓰기 비용이 아니라 **이더리움 L1 발급 비용**이다.
> 사용자 1명당 L1 트랜잭션 1건은 어떤 규모에서도 성립하지 않는다.
> 에폭 루트는 **L1 쓰기를 사용자 수와 무관하게 고정**시킨다 — 발급 10만 건이 L1 tx 1건이 된다.
> 부수적으로 Creditcoin 왕복도 N회에서 1회로 줄어든다.

이 논거는 **실측에 기반하고, 미확인 ATC 가정에 의존하지 않으며, 오히려 더 설득력이 있다.**
(폐기의 "루트에서 빠지면 끝" 이라는 표현력 이점은 그대로 유효하다)

### 확정 — READ 는 무료다 (2026-08-30 종결)

테스트넷 관측 1건이 아니라 **근거 두 개가 일치**하므로 열린 질문에서 내린다.

1. **프로토콜 공식 설계** — attestcoin.org: *"Free reads, paid writes. Apps can read other chains at no cost; cross-chain actions require ATC token payment."*
2. **본 실측** — `execute()` 차감액 = 가스비(394,982 × 0.5 gwei = 0.0002 CTC). 별도 수수료 0.

→ **"우리 제품이 ATC 수요·소각을 창출한다"는 주장은 폐기한다.** 우리 제품 전체가 무료 경로 위에 있다.
   (Writability 가 출시되면 스포크 전파가 유료 쓰기가 되지만, 그건 **로드맵이지 현재 사실이 아니다.**)

### 그럼 CEIP 논거는 무엇으로 세우는가

**토큰 경제가 아니라 생태계 논거로 간다.** CEIP 자체가 *"Creditcoin 생태계를 강화·확장하고 장기 성장을 견인하는 제품"* 을 지원하는 프로그램이지 ATC 소각량을 묻는 프로그램이 아니다.

| 폐기할 논거 | 대체 논거 |
|---|---|
| ~~"에폭마다 크로스체인 쓰기를 발생시켜 ATC 수요를 만든다"~~ | **"Creditcoin 을 컴플라이언스의 정본 체인으로 만든다."** 보유자 자격 심사가 법적 요건인 RWA·스테이블 발행사가 Creditcoin 을 읽을 이유가 생긴다 |
| ~~쓰기 원가 때문에 배치가 필요하다~~ | **이더리움 L1 발급 가스**가 진짜 원가다 (§6 위) |
| — | **이 해커톤의 나머지 4개 트랙 참가작 전부가 우리의 잠재 고객이다.** 게이팅이 필요한 dApp 은 SDK 한 줄로 붙는다 |
| — | 읽기가 무료라는 사실 자체가 **채택 장벽이 낮다**는 뜻이다 — dApp 이 조회 비용 없이 통합할 수 있다 |

> **정직성 원칙(§15-7) 적용:** 읽기가 무료라는 건 우리에게 불리한 사실이 아니라 **통합 장벽이 없다는 사실**이다.
> 없는 토큰 수요를 지어내는 것보다, 채택 논거로 정직하게 쓰는 편이 실사에서 강하다.

---

## 7. ✅ 정확했던 부분

| 기획안 | 확인 |
|---|---|
| §6.5 "누구나 `materialize` 가능 (퍼미션리스)" | `ASCBase.execute()`가 `external` + 접근제어 없음 → **정확함.** 발급사가 게을러도 제3자가 반영 가능 |
| §5 "소스 컨트랙트 1개 + 전용 이벤트" | 공식 문서 모범사례와 정확히 일치 |
| §6.4 fail-closed 4원칙 | ASC 패턴과 충돌 없음 |
| §7-3 "지연을 숨기지 않고 제품 파라미터로 공개" | 실측 9분 43초(burn→반영). 정직한 서술 유지 권고 |
| §5.2 Mode A/B 이원화 | 구조적으로 타당. 근거만 §6대로 교체 |

---

## 8. 요청 사항 (기획안 소유자)

| # | 수정 위치 | 내용 |
|---|---|---|
| 1 | §5 | `ProofmarkASC`가 `ASCBase`를 **포크**함을 명시 (`chainKey`·`blockHeight` 노출) |
| 2 | §6.4 | 판정 규칙에 **`blockHeight > lastAppliedHeight[subject]`** 추가 |
| 3 | §5.2 | `verifyBatch` → **"한 tx 다중 로그 순회"** 로 교체, `verifyBatch`는 P1 이하 |
| 4 | §9.2 D-9 | **`EvmV1Decoder` 배포 + 링크** 선행 단계 추가 |
| 5 | §7-7 | 재생 방지 키를 `(chainKey, blockHeight, txIndex)`로 정정 |
| 6 | §5.2 · §14 | 배치 논거를 **이더리움 L1 발급 비용**으로 교체. ATC 수요 서술은 확인 전까지 보류 |
| 7 | §5 | **한 tx = 한 종류 이벤트** 하드 룰 명시 ([`04`](04-event-schema.md) §0 C1) |

---

## 부록: 포크할 `ASCBase` 시그니처

```solidity
// 변경 전
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;

// 변경 후 — chainKey / blockHeight 노출
function _processAndEmitEvent(
    uint8   action,
    uint64  chainKey,        // ★ 소스 체인 고정용 (§1)
    uint64  blockHeight,     // ★ 순서 보장용 (§2)
    bytes32 queryId,
    bytes memory encodedTransaction
) internal virtual;
```

`execute()` 본문에서 호출부만 바꾸면 된다 (`ASCBase.sol:43`). 나머지 로직은 그대로 쓴다.
증명 검증·`queryId` 계산·재생 방지는 **원본을 신뢰하고 손대지 않는다.**
