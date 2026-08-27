# Tutorial 4 `Loan Flow` 코드 분석

> 분석일: 2026-08-30 · 대상: `reference/attestcoin-protocol-examples/loan-flow/` + `contracts/sol/`
> 목적: 우리 제품이 그대로 차용할 **ASC 확장 패턴**과 **보안 모델**을 확보하고, 예제의 한계를 미리 파악

---

## 1. 왜 이 예제가 중요한가

4개 튜토리얼 중 유일하게 **크로스체인 상태 머신**을 다룬다.
Hello Bridge가 "1회성 증명 → 민팅"이라면, Loan Flow는 **여러 번의 크로스체인 확인이 상태 전이를 순차적으로 유발**하는 구조다.

```
Created → Funded → PartlyRepaid → Repaid
                 ↘ Expired
```

우리가 만들 제품이 "어떤 사실을 검증하고, 그 결과로 온체인 상태를 바꾸는" 형태라면 **이 골격을 거의 그대로 쓴다.**

---

## 2. 시스템 구성

### 2.1 컴포넌트 3+1

| 위치 | 컨트랙트 | 역할 |
|---|---|---|
| Sepolia (소스) | `TestERC20` | 대출에 쓰이는 ERC20 |
| Sepolia (소스) | **`AuxiliaryLoanContract`** | 실제 토큰 이동 + **`LoanFunded` / `LoanRepaid` 이벤트 발행** |
| Creditcoin | **`ASCLoanManager`** (← `ASCBase`) | 증명 검증 + 대출 상태 관리 (권위 있는 원장) |
| Creditcoin | `EvmV1Decoder` | **라이브러리 — 별도 배포 후 링크 필요** |
| 오프체인 | `worker.ts` | 양방향 이벤트 감시 + 증명 생성 + 제출 |

### 2.2 배포 순서 (의존성 있음)

```
1. TestERC20              → Sepolia
2. EvmV1Decoder           → Creditcoin   ※ 라이브러리
3. ASCLoanManager         → Creditcoin   ※ --libraries 로 2번 주소 링크
4. AuxiliaryLoanContract  → Sepolia
5. authorize_token           (Aux 에 ERC20 화이트리스트 등록)
6. register_source_contract  (Manager 에 Aux 주소 등록)  ← 보안상 필수
```

> ⚠️ **함정**: `EvmV1Decoder`는 `library`라 별도 배포 + `--libraries ...:EvmV1Decoder:<주소>` 링크가 필요하다.
> 이 단계를 빼먹으면 `ASCLoanManager` 배포가 실패한다. 우리 배포 스크립트에 반드시 반영할 것.

---

## 3. 핵심: `ASCBase` — 우리가 상속할 골격

**이것이 Attestcoin dApp의 재사용 가능한 심장부다.** (`contracts/sol/ASCBase.sol`)

```solidity
function execute(
    uint8 action,                                   // 우리가 정의하는 액션 코드
    uint64 chainKey, uint64 blockHeight,            // 소스 체인 좌표
    bytes calldata encodedTransaction,              // RLP 인코딩된 트랜잭션+영수증
    bytes32 merkleRoot,
    INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
    bytes32 lowerEndpointDigest,
    bytes32[] calldata continuityRoots
) external returns (bool) {
    bytes32 queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
    require(!processedQueries[queryId], "Query already processed");   // ② 재사용 방지
    bool verified = _verifyProof(...);                                 // ① 프리컴파일 검증
    require(verified, "Proof of inclusion verification failed");
    processedQueries[queryId] = true;
    _processAndEmitEvent(action, queryId, encodedTransaction);         // ★ 우리가 구현
    return true;
}
```

### 확장 지점은 단 하나

```solidity
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;
```

**우리 ASC 만들기 = `ASCBase` 상속 + `_processAndEmitEvent` 구현.** 증명 검증·재사용 방지는 공짜로 얻는다.

### `queryId` 계산 — 설계 제약이 숨어있다

```solidity
queryId = keccak256(abi.encodePacked(chainKey, blockHeight(8B), txIndex(32B)))  // 총 72 bytes
```

`txIndex`는 `VERIFIER.calculateTxIndex(merkleProof)`로 머클 증명에서 역산한다.

> 🔑 **중요한 함의**: `queryId`는 **트랜잭션 1건을 식별**한다. 액션 종류나 이벤트 인덱스가 포함되지 않는다.
> → **소스 체인 트랜잭션 1건 = ASC 액션 1회.**
> → 한 트랜잭션이 여러 이벤트를 emit해도 **첫 번째 하나만 처리 가능**하다 (`_processFundLogs`도 `logs[0]`만 씀).
> → 우리 설계에서 "한 tx에 여러 사실을 담아 한 번에 처리" 하는 최적화는 **불가능**하다. 사실 하나당 tx 하나로 쪼개야 한다.
> → 쿼리 비용/지연이 **사실 개수에 비례**한다는 뜻. 배치하려면 소스 체인에서 한 tx에 여러 로그를 담고 ASC가 로그를 순회해야 한다 (§8 참조).

---

## 4. 보안 모델 — 4중 방어 (그대로 베낄 것)

예제가 잘 만들어진 부분이다. 하나라도 빠지면 자산 탈취가 가능하다.

| # | 방어 | 구현 | 없으면 생기는 공격 |
|---|---|---|---|
| ① | **포함 증명** | `VERIFIER.verifyAndEmit()` (프리컴파일 `0x…0FD2`) | 일어나지도 않은 트랜잭션을 주장 |
| ② | **재사용 방지** | `processedQueries[queryId]` | 같은 증명을 반복 제출해 중복 상환 처리 |
| ③ | **발행자 검증** | `log.address_ == sourceLoanContract` | **← 가장 중요** |
| ④ | **영수증/타입 검증** | `receipt.receiptStatus == 1`, `isValidTransactionType` | 실패한 tx를 성공으로 위장 |

### ③번을 반드시 이해할 것

README가 직접 설명하는 공격 시나리오:

> 누구나 자기 컨트랙트를 배포해서 임의의 `loanId`로 `LoanFunded` 이벤트를 emit하고,
> 그 트랜잭션의 포함 증명을 만들어 제출하면 — **증명 자체는 완벽하게 유효하다.**
> 실제로 그 트랜잭션은 소스 체인에서 일어났으니까.

즉 **"트랜잭션이 존재한다"와 "그 트랜잭션이 우리 시스템에서 의미가 있다"는 전혀 다른 문제다.**
오라클은 전자만 보증한다. 후자는 **우리가 컨트랙트에서 직접 검증해야 한다.**

```solidity
require(sourceLoanContract != address(0), "Source loan contract not registered!");
require(log.address_ == sourceLoanContract, "... not emitted by registered source loan contract!");
require(log.topics[0] == FUND_EVENT_SIGNATURE, "Not LoanFunded event");
```

> 🚨 **우리 제품의 체크리스트**: 어떤 사실을 크로스체인으로 읽든, 반드시
> `(발행 컨트랙트 주소 allowlist) + (이벤트 시그니처) + (topics 개수/형태)` 3가지를 검증한다.
> 이걸 빼면 CertiK 감사에서 즉시 지적당하고, 심사위원이 알아채면 치명적이다.

---

## 5. 이벤트 디코딩 방식

`EvmV1Decoder`가 RLP 인코딩된 트랜잭션/영수증을 파싱한다.

```solidity
uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
require(EvmV1Decoder.isValidTransactionType(txType));

EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
require(receipt.receiptStatus == 1, "Transaction did not succeed");

EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, EVENT_SIG);
require(logs.length > 0);
```

`LogEntry` 구조: `address_`(발행자), `topics[]`(indexed), `data`(non-indexed)

이벤트 시그니처는 **상수로 하드코딩**한다:

```solidity
// keccak256("LoanFunded(uint256)")
bytes32 public constant FUND_EVENT_SIGNATURE = 0x9e71d2fb732e...;
// keccak256("LoanRepaid(uint256,uint256)")
bytes32 public constant REPAY_EVENT_SIGNATURE = 0x040cee90ee47...;
```

파라미터 추출:
```solidity
loanId = uint256(log.topics[1]);        // indexed → topics
amount = abi.decode(log.data, (uint256)); // non-indexed → data
```

> 💡 **설계 팁**: 문서의 "모호하지 않은 이벤트" 원칙이 여기서 이유가 드러난다.
> 시그니처로만 필터링하므로, 범용 `Transfer` 같은 걸 쓰면 다른 컨트랙트의 이벤트와 구분이 어려워지고
> indexed 배치를 잘못 잡으면 파싱이 깨진다. **전용 이벤트 + 필요한 필드 전부 포함**이 정답이다.

---

## 6. ⚠️ 신뢰 비대칭 — 반드시 인지할 구조적 한계

**Loan Flow는 절반만 무신뢰다.**

```
Sepolia ──── 오라클 증명 (무신뢰) ────▶ Creditcoin     ✅ 암호학적 보증
Creditcoin ── 워커의 owner 권한 호출 ──▶ Sepolia       ⚠️ 신뢰 필요
```

- `AuxiliaryLoanContract.registerLoanFund()` 는 **`onlyOwner`** → 워커(owner)가 그냥 호출한다. 증명 없음.
- `markLoanAsExpired()` 도 양쪽 다 `onlyOwner`.
- `ASCLoanManager.registerLoan()` 도 **`onlyOwner`** → 대출 등록 자체가 운영자 권한.

**이유**: Attestcoin의 **Writability(크로스체인 실행)가 아직 개발 중**이기 때문. 현재는 Readability만 무신뢰다.

### 이게 우리에게 주는 의미

1. **정직하게 말해야 한다.** 심사위원/감사자가 "이거 반쪽 아니냐"고 물으면, 프로토콜의 현재 한계와 우리가 신뢰 가정을 어디에 두었는지 명확히 답할 수 있어야 한다. 얼버무리면 감점이다.
2. **차별화 기회다.** 신뢰가 필요한 방향을 최소화하는 설계(예: 권위 있는 상태를 Creditcoin에만 두고, 소스 체인은 순수 이벤트 발행자로만 사용)를 하면 예제보다 나은 아키텍처가 된다.
3. **"어느 방향이 무신뢰여야 하는가"가 제품 설계의 첫 질문이다.** 무신뢰가 필요한 방향을 Sepolia→Creditcoin으로 잡아야 한다.

### 서명 검증의 빈틈 (교육용 코드의 한계)

`registerLoan`은 lender/borrower 양자 서명을 EIP-191로 검증하지만:

```solidity
bytes32 messageHash = keccak256(abi.encodePacked(
    fundFlow.from, ..., loanTerms.deadlineBlockNumber
));
```

**nonce도, chainId도, 컨트랙트 주소도 포함되지 않는다.**
→ 동일 조건의 서명을 **재사용**할 수 있고, 다른 체인/다른 배포본에 **리플레이** 가능하다.
→ 우리 제품에서 서명을 쓴다면 **EIP-712 + nonce + chainId + verifyingContract** 로 가야 한다. 이건 감사에서 100% 지적된다.

---

## 7. 오프체인 워커 분석 (`worker.ts`)

### 동작 구조

5초 폴링 루프 안에서 6종 이벤트를 병렬 감시:

| 감시 대상 | 체인 | 반응 |
|---|---|---|
| `LoanRegistered` | Creditcoin | → 소스 체인에 `registerLoanFund` 호출 |
| `LoanFunded` | Sepolia | → **증명 생성 → `execute(action=0)`** |
| `LoanRepaid` | Sepolia | → **증명 생성 → `execute(action=1)`** |
| `LoanFunded`/`LoanExpired`/`LoanPartiallyRepaid`/`LoanRepaid` | Creditcoin | → 로깅만 |

추가로 `ccProvider.on('block')` 으로 만기 블록을 감시해 `markLoanAsExpired` 호출.

`queryFilter` 기반 폴링을 쓴다 — 이유는 코드 주석에 있다: **RPC 노드의 필터 만료(`Filter id does not exist`) 회피.**

### 🔴 프로덕션 갭 — 우리는 이대로 쓰면 안 된다

예제는 교육용이라 명시되어 있고, 실제로 다음 문제가 있다:

| 문제 | 코드 위치 | 결과 |
|---|---|---|
| **상태가 전부 in-memory** | `loanTracker`, `loanExpiriesAt` | 워커 재시작 시 전부 소실 → `Loan X not found in tracker`로 이벤트 **영구 무시** |
| **시작 블록이 "지금"** | `sourceFromBlock = await getBlockNumber()` | 다운타임 중 발생한 이벤트를 **영원히 놓침** |
| **중복 캐시 통째 삭제** | `if (processedTxs.size > 1000) clear()` | 이후 이벤트 **중복 처리** 가능 |
| **tx 단위 dedup** | `processedTxs.has(txHash)` | 한 tx의 여러 이벤트 중 **첫 개만** 처리 |
| **재시도 없음** | `catch { console.error }` | 증명 실패/가스 부족 시 **조용히 유실** |
| **단일 시퀀스** | 순차 await | 대출 1건이 8분 대기하는 동안 **다른 건도 블로킹** |

**우리가 만들 워커의 최소 요건:**
- [ ] 블록 커서를 **영속 저장** (파일/DB) 하고 재시작 시 이어받기
- [ ] 처리 이력을 **영속 저장** + `(txHash, logIndex)` 단위 멱등 키
- [ ] 실패 시 **지수 백오프 재시도** + 데드레터
- [ ] 대출 상태를 온체인에서 **재조회**해 복구 가능하게 (in-memory 신뢰 금지)
- [ ] 건별 **독립 처리**(큐/워커풀) — 8분 대기가 서로를 막지 않도록

> 데모에서는 예제 수준으로도 돌아가지만, **심사위원이 코드를 볼 수 있다.** 위 항목 중 몇 개만 잡아도 "프로덕션을 생각한 팀"으로 보인다.

---

## 8. 비용·지연 실측 계산

`Loan Flow` 전체 사이클의 **오라클 쿼리 소모량**:

| 단계 | 오라클 쿼리 | 지연 |
|---|---|---|
| `register_loan` | 0 (Creditcoin 로컬) | 즉시 |
| `fund_loan` (완납) | **1** | ~8분 |
| `repay_loan` (원금) | **1** | ~8분 |
| `repay_loan` (이자) | **1** | ~8분 |
| **합계** | **3 쿼리** | **~24분** |

> **정정 (8/30):** 초판에서 "파우셋 100 CTC = 9쿼리 → 하루 3사이클"이라 적었으나,
> **실수령액은 10,000 CTC**였다(실측). 쿼리 예산 제약은 해소됐다.

**진짜 병목은 돈이 아니라 시간이다.** 사이클당 **~24분**이고, 실패하면 그만큼 다시 기다린다.

| 완화책 | 효과 |
|---|---|
| **로컬 모의 BlockProver 하네스** (anvil) | 증명 없이 ASC 로직 전량 검증 → 8분 왕복을 0초로 |
| 부분 상환 대신 **1회 완납** 설계 | 쿼리 1개·8분 절약 |
| **한 tx에 여러 로그** → ASC가 순회 | 사실 N개를 왕복 1회로 (§8.1) |

### 8.1 ★ 배치의 실제 방법 — `getLogsByEventSignature`는 전부 돌려준다

예제는 `logs[0]`만 쓰지만, 이건 **단순화일 뿐 프로토콜 제약이 아니다.**

```solidity
EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, SIG);
// 예제: EvmV1Decoder.LogEntry memory log = logs[0];   ← 첫 개만
for (uint i = 0; i < logs.length; i++) { ... }         ← 전부 순회 가능
```

`queryId`가 tx 단위라 **`execute()` 호출은 tx당 1회**로 묶이지만,
그 1회 안에서 **그 tx의 모든 로그를 처리할 수 있다.**

> 🔑 **설계 결론**: "소스 체인에서 N건을 **한 트랜잭션으로 묶어 emit** → ASC가 `execute()` 1회로 N건 전부 반영".
> 크로스체인 왕복 1회(8분·쿼리 1개)로 N건을 처리한다. 이것이 이 프로토콜에서 배치를 얻는 정공법이다.
>
> `verifyBatch`(최대 10쿼리·연속성 증명 공유)는 **서로 다른 tx 10건**을 묶는 별개 수단이다.
> 단, **`ASCBase`에는 배치 진입점이 없다** — `execute()`는 단일 증명만 받는다. 배치를 쓰려면 우리가 직접 구현해야 한다.

## 9. 우리 제품에 재사용할 스켈레톤

```solidity
contract OurASC is Ownable, ASCBase {
    enum Actions { FactA, FactB }

    // 1) 신뢰하는 소스 체인 컨트랙트 (③번 방어)
    address public sourceContract;

    // 2) 이벤트 시그니처 상수
    bytes32 public constant FACT_A_SIG = keccak256("FactAttested(bytes32,address)");

    function registerSourceContract(address c) external onlyOwner { sourceContract = c; }

    function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTx)
        internal override
    {
        if (action == uint8(Actions.FactA)) _handleFactA(encodedTx);
        else revert InvalidAction(action);
    }

    function _handleFactA(bytes memory encodedTx) internal {
        // ④ 영수증/타입 검증
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        require(r.receiptStatus == 1, "tx failed");

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(r, FACT_A_SIG);
        require(logs.length > 0, "no event");
        EvmV1Decoder.LogEntry memory log = logs[0];

        // ③ 발행자 검증 — 절대 빼지 말 것
        require(sourceContract != address(0), "source not registered");
        require(log.address_ == sourceContract, "untrusted emitter");
        require(log.topics[0] == FACT_A_SIG, "wrong event");
        require(log.topics.length == 3, "bad topics");

        // 파라미터 추출 후 비즈니스 로직
        bytes32 factId = log.topics[1];
        address subject = address(uint160(uint256(log.topics[2])));
        // ... 상태 전이 ...
    }
}
```

**재사용 체크리스트**
- [x] `ASCBase` 상속 → 증명 검증 + 재사용 방지 무료
- [ ] `_processAndEmitEvent` 에 액션 라우팅
- [ ] 소스 컨트랙트 allowlist (`registerSourceContract`)
- [ ] 이벤트 시그니처 상수 + topics 형태 검증
- [ ] 영수증 성공 여부 검증
- [ ] `EvmV1Decoder` 별도 배포 + 링크 (배포 스크립트에 반영)
- [ ] 소스 체인 컨트랙트는 **전용 이벤트**만 emit, 필요한 필드 전부 포함

---

## 10. 사소한 관찰

- `ASCLoanManager` 생성자가 `VERIFIER`를 재대입한다 (`ASCBase` 생성자에서 이미 대입됨).
  solc 0.8.30에서 파생 컨트랙트 생성자의 immutable 재대입이 허용됨을 **별도 최소 예제로 컴파일 검증함** — 오류는 아니고 **중복일 뿐**이다. 같은 값이라 동작에 영향 없음. 우리 코드에서는 지우면 된다.
- `AuxiliaryLoanContract.addAuthorizedToken`에 `// TODO: Need to check if the address is a valid ERC20` 주석이 남아있다. 예제 수준임을 보여주는 흔적.
- `fund_loan.ts`의 `await tx.wait()` 주석은 실제로 겪은 버그의 기록으로 보인다 — 대기 없이 두 번 펀딩하면 stale allowance로 충돌. 우리 워커도 같은 함정에 빠질 수 있다.

---

## 11. 파일 맵 (빠른 참조)

| 파일 | 내용 |
|---|---|
| `contracts/sol/ASCBase.sol` | **★ 확장 골격** — execute / 증명검증 / queryId / 재사용방지 |
| `contracts/sol/VerifierInterface.sol` | 프리컴파일 인터페이스 + `0x…0FD2` 상수 |
| `contracts/sol/ASCLoanManager.sol` | ASC 구현 예시 — 액션 라우팅, 로그 검증, 상태 전이 |
| `contracts/sol/AuxiliaryLoanContract.sol` | 소스 체인 이벤트 발행자 + 토큰 이동 |
| `contracts/sol/LoanTypes.sol` | 구조체/enum 정의 |
| `loan-flow/worker.ts` | **★ 오프체인 워커 전체 구조** |
| `utils/index.ts` | `generateProofFor`, 가스 추정, 제출 헬퍼 |
| `loan-flow/register.ts` | 서명 생성/제출 패턴 (EIP-191) |
| `loan-flow/fund_loan.ts` | approve → fundLoan 패턴 |

---

## 12. 다음 액션

- [ ] 파우셋 수령 후 **Hello Bridge 먼저 완주** (환경 E2E 1회 성공 확인)
- [ ] Loan Flow는 컨트랙트 4개 배포가 필요하므로 **자금 여유 확인 후** 진행 판단
      → 학습 목적이면 코드 정독(이 문서)으로 충분할 수 있음. 쿼리 예산이 아깝다.
- [ ] 제품 컨셉 확정되면 §9 스켈레톤으로 **우리 ASC 초안** 작성
- [ ] 워커는 예제를 복사하지 말고 §7 요건을 반영해 **처음부터 영속 상태로** 설계
