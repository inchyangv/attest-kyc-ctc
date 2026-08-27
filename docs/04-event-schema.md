# 이벤트 스키마 (동결 대상)

> 작성일 2026-08-30 · 소유자 Tech Lead
> 선행: [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md) (ASC 패턴) · [`03-product-plan.md`](03-product-plan.md) §5·§6 (제품 정의)
> 병행: [`05-asc-integration-review.md`](05-asc-integration-review.md) — **본 스키마의 근거가 되는 검토 결과. 먼저 읽을 것**
>
> **지위:** 이 문서가 동결되면 `ComplianceSource.sol`(Sepolia) · `ProofmarkASC.sol`(CC3) · 워커를 **동시에** 착수할 수 있다.
> 동결 목표 **D-12 (9/1)**. 이후 변경은 3곳 동시 수정 비용을 문다.

---

## 0. 이 스키마를 지배하는 4가지 제약

`ASCBase` 실제 코드에서 도출된 것들이다. 이벤트 설계의 자유도는 여기서 결정된다.

| # | 제약 | 출처 | 스키마에 미치는 영향 |
|---|---|---|---|
| C1 | **`queryId = f(chainKey, blockHeight, txIndex)`** — 액션·로그인덱스 미포함 | `ASCBase._computeQueryId` | **소스 tx 1건 = `execute()` 1회.** 한 tx에 서로 다른 종류의 ASC 이벤트를 섞으면 하나만 처리되고 나머지는 **영구 봉인** |
| C2 | **한 `execute()` 안에서 그 tx의 로그는 전부 순회 가능** | `getLogsByEventSignature`가 배열 반환 | 배치는 **"한 tx에 동종 이벤트 N개"** 로 얻는다 |
| C3 | **topics는 최대 4개** (시그니처 + indexed 3) | EVM | indexed 파라미터는 **3개까지**. 나머지는 `data` |
| C4 | **`log.address_` 검증이 유일한 진위 근거** | `ASCLoanManager._processFundLogs` | 이벤트는 **우리 소스 컨트랙트 1개**에서만 발행 |

### 🔴 C1에서 나오는 하드 룰

> **한 트랜잭션은 한 종류의 ASC 이벤트만 emit한다.**

섞으면 그리핑이 가능하다 — 공격자가 싼 액션으로 `execute()`를 먼저 성공시키면 `processedQueries[queryId]`가 소비되어
**같은 tx의 다른 이벤트는 영원히 반영되지 않는다.** (`execute()`는 permissionless이므로 누구나 할 수 있다)

`ComplianceSource`의 각 함수는 **단일 종류의 이벤트만** 내보내도록 작성한다. 복합 연산(발급+에폭게시)은 **tx를 나눈다.**

---

## 1. 액션 코드

```solidity
enum Action {
    MarkIssued,       // 0
    MarkRevoked,      // 1
    SanctionDenied,   // 2
    RosterEpoch       // 3
}
```

`execute(action, ...)`의 `action`은 **호출자가 넣는 값이지 증명에서 유도되지 않는다.**
잘못된 조합은 `getLogsByEventSignature`가 0건을 반환해 `require`에서 revert되므로 **안전하게 실패**한다.
(revert 시 `processedQueries`도 롤백되므로 영구 봉인은 발생하지 않는다 — 단 C1의 "섞인 tx" 경우는 예외)

---

## 2. 스칼라 팩킹 — `attrs` (bytes32)

마크의 스칼라 필드를 **정확히 192비트**로 묶어 `bytes32` 한 칸에 넣는다.

```
bit  255      248 247      240 239        224 223           208
     ┌──────────┬───────────┬──────────────┬─────────────────┐
     │ kind  u8 │assurance u8│  regime u16  │ jurisdiction u16│
     └──────────┴───────────┴──────────────┴─────────────────┘
bit  207            176 175            136 135          96 95        64 63    0
     ┌────────────────┬──────────────────┬───────────────┬────────────┬────────┐
     │  methods  u32  │  issuedAt   u40  │  expiry  u40  │ epoch  u32 │ 예약64 │
     └────────────────┴──────────────────┴───────────────┴────────────┴────────┘
```

| 필드 | 타입 | 시프트 | 마스크 |
|---|---|---|---|
| `kind` | uint8 | 248 | `0xFF` |
| `assurance` | uint8 | 240 | `0xFF` |
| `regime` | uint16 | 224 | `0xFFFF` |
| `jurisdiction` | uint16 | 208 | `0xFFFF` |
| `methods` | uint32 | 176 | `0xFFFFFFFF` |
| `issuedAt` | uint40 | 136 | `0xFFFFFFFFFF` |
| `expiry` | uint40 | 96 | `0xFFFFFFFFFF` |
| `epoch` | uint32 | 64 | `0xFFFFFFFF` |
| (예약) | 64bit | 0 | 향후 확장 |

**왜 팩킹하는가**
1. `encodedTransaction`(영수증 RLP)이 **calldata로 통째 전달**된다 → 로그가 작을수록 검증 가스가 싸다
2. `attrs`를 **indexed로 두면 `topics[2]`에서 바로 읽는다** — `abi.decode` 불필요
3. 예약 64비트로 필드 추가 시 이벤트 시그니처를 안 바꿔도 된다 (**시그니처 변경 = 3곳 동시 수정**)

```solidity
library MarkAttrs {
    function pack(
        uint8 kind, uint8 assurance, uint16 regime, uint16 jurisdiction,
        uint32 methods, uint40 issuedAt, uint40 expiry, uint32 epoch
    ) internal pure returns (bytes32) {
        return bytes32(
            (uint256(kind)         << 248) | (uint256(assurance) << 240) |
            (uint256(regime)       << 224) | (uint256(jurisdiction) << 208) |
            (uint256(methods)      << 176) | (uint256(issuedAt)  << 136) |
            (uint256(expiry)       <<  96) | (uint256(epoch)     <<  64)
        );
    }
    function kind(bytes32 a)         internal pure returns (uint8)  { return uint8(uint256(a) >> 248); }
    function assurance(bytes32 a)    internal pure returns (uint8)  { return uint8(uint256(a) >> 240); }
    function regime(bytes32 a)       internal pure returns (uint16) { return uint16(uint256(a) >> 224); }
    function jurisdiction(bytes32 a) internal pure returns (uint16) { return uint16(uint256(a) >> 208); }
    function methods(bytes32 a)      internal pure returns (uint32) { return uint32(uint256(a) >> 176); }
    function issuedAt(bytes32 a)     internal pure returns (uint40) { return uint40(uint256(a) >> 136); }
    function expiry(bytes32 a)       internal pure returns (uint40) { return uint40(uint256(a) >>  96); }
    function epoch(bytes32 a)        internal pure returns (uint32) { return uint32(uint256(a) >>  64); }
}
```

---

## 3. 이벤트 4종 (확정안)

### 3.1 `MarkIssued`

```solidity
/// @notice 컴플라이언스 마크 발급. 크로스체인으로 Creditcoin ASC가 소비한다.
event MarkIssued(
    address indexed subject,      // topics[1] 대상 지갑
    bytes32 indexed attrs,        // topics[2] §2 팩킹 스칼라
    address indexed issuer,       // topics[3] 발급사
    bytes32 claimsRoot,           // data[0]   클레임 커밋먼트 루트
    bytes32 evidenceHash          // data[1]   증적 해시체인 head
);
```

| | |
|---|---|
| 시그니처 | `MarkIssued(address,bytes32,address,bytes32,bytes32)` |
| topics | 4 (최대치) |
| data | 64 bytes |
| 액션 | `0` |

> `attrs`를 indexed로 둔 것이 핵심이다 — ASC가 `topics[2]`를 바로 읽어 8개 필드를 얻는다.
> `subject`·`issuer`는 워커의 `queryFilter` 필터링에도 쓰인다.

### 3.2 `MarkRevoked`

```solidity
/// @notice 마크 폐기. 툼스톤은 어떤 에폭 루트보다 우선한다.
event MarkRevoked(
    address indexed subject,      // topics[1]
    uint16  indexed reasonCode,   // topics[2]
    uint32  indexed epoch         // topics[3] 폐기 시점 에폭
);
```

| | |
|---|---|
| 시그니처 | `MarkRevoked(address,uint16,uint32)` |
| topics | 4 |
| data | **0 bytes** |
| 액션 | `1` |

> data가 0바이트라 **배치 폐기가 매우 싸다.** 한 tx에 N개 emit → `execute()` 1회로 N건 반영 (C2).

**`reasonCode`**

| 값 | 의미 |
|---|---|
| 1 | 사용자 요청 |
| 2 | 재대사 적중 (제재) |
| 3 | 문서 만료 |
| 4 | 발급사 오류 정정 |
| 5 | 위험등급 상향 |
| 6 | 이의제기 인용 (오탐 해소) |

### 3.3 `SanctionDenied`

```solidity
/// @notice 제재 판정. deny > allow — 어떤 마크보다 우선한다.
event SanctionDenied(
    address indexed subject,      // topics[1]
    uint32  indexed listVersion,  // topics[2] 적중 명단 버전
    uint32  indexed epoch         // topics[3]
);
```

| | |
|---|---|
| 시그니처 | `SanctionDenied(address,uint32,uint32)` |
| topics | 4 |
| data | 0 bytes |
| 액션 | `2` |

> `MarkRevoked`와 분리한 이유: 폐기는 되돌릴 수 있지만(오탐 해소) **제재는 별도 레인**이고,
> 소비자 정책에서 `isDenied()`로 따로 조회한다. 시그니처가 달라야 `getLogsByEventSignature`로 분리된다.

### 3.4 `RosterEpochPublished`

```solidity
/// @notice 에폭 명부 루트 게시. 사용자 수와 무관하게 쓰기 1건.
event RosterEpochPublished(
    uint32  indexed epoch,        // topics[1]
    bytes32 indexed root,         // topics[2] 정렬 머클 루트
    uint32  indexed listVersion,  // topics[3] AML 명단 버전
    uint40  validUntil            // data[0]   명부 신선도 만료
);
```

| | |
|---|---|
| 시그니처 | `RosterEpochPublished(uint32,bytes32,uint32,uint40)` |
| topics | 4 |
| data | 32 bytes |
| 액션 | `3` |

> **한 tx에 정확히 1개만 emit한다.** 에폭은 단조 증가여야 하므로 배치가 의미 없다.

---

## 4. 설계 규칙 체크 — 공식 문서 대조

Attestcoin 문서의 "Readability 모범사례" 5개 항목 전부 충족한다.

| 문서 권고 | 본 스키마 | |
|---|---|---|
| dApp당 소스 컨트랙트 1개 | `ComplianceSource.sol` 단일 | ✅ |
| 쿼리마다 별도 이벤트 타입 | 4종 시그니처 전부 상이 | ✅ |
| 크로스체인 의도가 드러나는 이름 | `MarkIssued` / `RosterEpochPublished` | ✅ |
| 표준 이벤트(`Transfer` 등) 회피 | 전용 이벤트만 | ✅ |
| ASC가 처리에 필요한 데이터 완비 | `attrs`에 8필드 + 루트 2종 | ✅ |

---

## 5. ASC 소비 측 — 참조 구현

```solidity
contract ProofmarkASC is Ownable, ASCBaseV2 {   // ← V2: 05번 문서 §2 참조 (chainKey/blockHeight 노출)
    using MarkAttrs for bytes32;

    bytes32 constant SIG_ISSUED  = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
    bytes32 constant SIG_REVOKED = keccak256("MarkRevoked(address,uint16,uint32)");
    bytes32 constant SIG_DENIED  = keccak256("SanctionDenied(address,uint32,uint32)");
    bytes32 constant SIG_EPOCH   = keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40)");

    uint64  public expectedChainKey;        // ★ 05번 §1 — 크로스체인 혼동 방어
    address public sourceContract;          // ★ C4
    mapping(address => uint64) public lastAppliedHeight;   // ★ 05번 §3 — 순서 역전 방어

    function _processAndEmitEvent(
        uint8 action, uint64 chainKey, uint64 blockHeight,
        bytes32, bytes memory encodedTx
    ) internal override {
        // ① 소스 체인 고정 — 이게 없으면 Ethereum 메인넷 증명이 통과한다
        require(chainKey == expectedChainKey, "unexpected source chain");

        if      (action == uint8(Action.MarkIssued))     _onIssued(blockHeight, _logs(encodedTx, SIG_ISSUED));
        else if (action == uint8(Action.MarkRevoked))    _onRevoked(blockHeight, _logs(encodedTx, SIG_REVOKED));
        else if (action == uint8(Action.SanctionDenied)) _onDenied(blockHeight, _logs(encodedTx, SIG_DENIED));
        else if (action == uint8(Action.RosterEpoch))    _onEpoch(_logs(encodedTx, SIG_EPOCH));
        else revert InvalidAction(action);
    }

    /// 영수증 검증 + 시그니처 필터 (ASCLoanManager._validateTransactionContents 패턴)
    function _logs(bytes memory encodedTx, bytes32 sig)
        private pure returns (EvmV1Decoder.LogEntry[] memory logs)
    {
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        require(r.receiptStatus == 1, "source tx failed");        // ② 실패한 tx 배제
        logs = EvmV1Decoder.getLogsByEventSignature(r, sig);
        require(logs.length > 0, "no matching event");
    }

    function _onIssued(uint64 blockHeight, EvmV1Decoder.LogEntry[] memory logs) private {
        for (uint256 i = 0; i < logs.length; i++) {               // ③ C2 — 배치
            EvmV1Decoder.LogEntry memory L = logs[i];
            require(L.address_ == sourceContract, "untrusted emitter");   // ④ C4
            require(L.topics.length == 4, "bad topics");

            address subject = address(uint160(uint256(L.topics[1])));
            bytes32 attrs   = L.topics[2];
            address issuer  = address(uint160(uint256(L.topics[3])));
            (bytes32 claimsRoot, bytes32 evidenceHash) = abi.decode(L.data, (bytes32, bytes32));

            // ⑤ 순서 역전 방어 — 오래된 발급이 최신 폐기를 덮어쓰지 못하게
            if (blockHeight <= lastAppliedHeight[subject]) continue;
            lastAppliedHeight[subject] = blockHeight;

            _applyMark(subject, attrs, issuer, claimsRoot, evidenceHash);
        }
    }
    // _onRevoked / _onDenied / _onEpoch 도 동일 5단계
}
```

**모든 핸들러가 지켜야 할 5단계** (하나라도 빠지면 취약):

| # | 검증 | 빠지면 |
|---|---|---|
| ① | `chainKey == expectedChainKey` | 다른 체인의 동일 주소 컨트랙트 증명이 통과 (**05번 §1**) |
| ② | `receiptStatus == 1` | 실패한 tx를 성공으로 반영 |
| ③ | 전체 로그 순회 | 배치 중 첫 건만 반영 |
| ④ | `log.address_ == sourceContract` | **누구나 위조 이벤트 발행 가능** |
| ⑤ | `blockHeight > lastAppliedHeight` | 폐기 후 옛 발급 재제출로 부활 (**05번 §3**) |

---

## 6. 소스 컨트랙트 계약 (Sepolia)

```solidity
contract ComplianceSource is Ownable {
    // C1: 각 함수는 단일 종류의 이벤트만 emit한다
    function issue(address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash) external onlyIssuer;
    function issueBatch(Issuance[] calldata items) external onlyIssuer;      // C2 배치
    function revoke(address subject, uint16 reasonCode) external onlyIssuer;
    function revokeBatch(address[] calldata subjects, uint16[] calldata reasons) external onlyIssuer;
    function deny(address subject, uint32 listVersion) external onlyIssuer;
    function publishEpoch(bytes32 root, uint32 listVersion, uint40 validUntil) external onlyEpochKey;
}
```

> ⚠️ **`issue`와 `publishEpoch`를 같은 tx에서 부르는 편의 함수를 만들지 않는다** (C1 위반).
> 에폭 게시는 항상 독립 tx다.

---

## 7. 미결정 사항 (동결 전 확정 필요)

| # | 항목 | 옵션 | 기한 |
|---|---|---|---|
| E1 | `regime` 코드 체계 | 자체 uint16 열거 / ISO 기반 | D-12 |
| E2 | `jurisdiction` — 발급 관할만 vs 거주 관할 병기 | 병기하려면 예약 64비트 사용 | D-12 |
| E3 | 배치 최대 건수 (가스 상한) | 로그 N개 순회 가스 실측 후 | D-11, 실측 의존 |
| E4 | `issuer`를 topics에 둘지 (다발급사 아니면 불필요) | 빼면 `claimsRoot`를 indexed로 승격 가능 | D-12 |
| E5 | 에폭 롤백 거버넌스 경로 | `03-product-plan.md` §6.4-4 | D-7 |

---

## 8. 구현 상태 — **스키마는 코드로 검증됨** ✅

본 스키마대로 컨트랙트를 작성하고 로컬 하네스로 검증을 마쳤다 (2026-08-30).

| 파일 | 내용 |
|---|---|
| `src/lib/ProofmarkTypes.sol` | `Action` · `MarkStatus` · `Methods` 비트맵 · `RevokeReason` · `Mark` · `Policy` |
| `src/lib/MarkAttrs.sol` | §2 팩킹/언팩 — **퍼즈 256런 왕복 통과** |
| `src/lib/VerifierInterface.sol` | BlockProver 프리컴파일 인터페이스 |
| `src/ASCBaseX.sol` | `ASCBase` 포크 (`chainKey`·`blockHeight` 노출) |
| `src/ComplianceSource.sol` | §6 소스 컨트랙트 — 이벤트 4종 + 배치 3종 |
| `src/ProofmarkASC.sol` | §5 ASC — 5단계 검증 전량 구현 |
| `test/mocks/MockBlockProver.sol` | **로컬 모의 프리컴파일** (`vm.etch` 주입) |
| `test/ReceiptFixture.sol` | 합성 `encodedTransaction` 빌더 |
| `test/ProofmarkASC.t.sol` | **14 테스트 전량 통과** |

`encodedTransaction` 실제 형식 (디코더 소스에서 확인):
```
abi.encode(uint8 txType, bytes[] chunks)          // chunks.length == 3 (type 0~2) / 4 (type 3~4)
chunks[last] = abi.encode(uint8 status, uint64 gasUsed, LogEntryTuple[] logs, bytes bloom)
LogEntryTuple = (address address_, bytes32[] topics, bytes data)
```
→ RLP 가 아니라 **ABI 인코딩**이라 합성 픽스처를 만들 수 있다. 어테스트 8분 대기 없이 전 로직 검증이 가능하다.

```sh
forge test    # 14 passed
```

### 시그니처 상수 오타 방지
`test_EventSignatureConstantsAreCorrect` 가 하드코딩 상수 4개를 실제 `keccak256` 과 대조한다.
**오타 1건 = 온체인 8분 낭비**이므로 CI 게이트로 둔다.

---

## 9. 동결 절차

1. ~~`keccak256` 시그니처 상수 하드코딩~~ ✅ 완료 + 테스트로 고정
2. ~~§3을 `ComplianceSource.sol` 주석에 반영~~ ✅ 완료
3. 형제 세션의 **E2E 실가스 실측** 반영 (E3 — 배치 최대 건수)
4. E1·E2·E4 결정

**산출 완료 (2026-08-30, `cast keccak` 실행값)** — 시그니처가 바뀌면 반드시 재계산할 것.

```solidity
// MarkIssued(address,bytes32,address,bytes32,bytes32)
bytes32 constant SIG_ISSUED  = 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3;
// MarkRevoked(address,uint16,uint32)
bytes32 constant SIG_REVOKED = 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09;
// SanctionDenied(address,uint32,uint32)
bytes32 constant SIG_DENIED  = 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae;
// RosterEpochPublished(uint32,bytes32,uint32,uint40)
bytes32 constant SIG_EPOCH   = 0x984d6a4d0b5705f143158aad863f7a4f77abd36d272098cda48adbcbd40b0dc3;
```

재산출:
```sh
cast keccak "MarkIssued(address,bytes32,address,bytes32,bytes32)"
cast keccak "MarkRevoked(address,uint16,uint32)"
cast keccak "SanctionDenied(address,uint32,uint32)"
cast keccak "RosterEpochPublished(uint32,bytes32,uint32,uint40)"
```
