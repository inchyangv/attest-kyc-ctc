# 내결함성 워커 설계

> 작성일 2026-08-30 · 소유자 Tech Lead
> 근거: [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md) §7 (예제 워커의 프로덕션 갭) · [`01-env-verification.md`](01-env-verification.md) §5 (SDK 취약성 실측)

---

## 1. 왜 예제를 복사하지 않았는가

예제 워커(`loan-flow/worker.ts`)는 교육용으로 명시돼 있고, 실제로 다음 문제가 있다.

| 예제의 문제 | 결과 | 본 워커의 대응 |
|---|---|---|
| 상태가 전부 in-memory | 재시작 시 이벤트 **영구 무시** | `Store` — 파일 영속, 원자적 쓰기 |
| 시작 블록이 `getBlockNumber()` | 다운타임 중 이벤트 **영구 유실** | 커서 영속 + 재시작 이어받기 |
| 중복 캐시 1000건 넘으면 통째 clear | 중복 처리 | 작업별 상태를 영구 보관 |
| 재시도 없음 (`catch { console.error }`) | 조용한 유실 | 지수 백오프 + 데드레터 |
| 순차 await | 8분 대기가 서로를 블로킹 | 작업별 독립 처리 (동시성 8) |
| **SDK `waitUntilHeightAttested`** | **8분 대기 후 타임아웃 1회에 전량 손실** | 폴링 호출 자체를 재시도로 감쌈 |

### 마지막 항목이 가장 중요하다 — 실측된 실패

```
Waiting for block 11597452 attestation on Creditcoin...
Error: Failed to fetch attested height: AxiosError: timeout of 10000ms exceeded
  at ApiClient.<anonymous> (@gluwa/usc-sdk/dist/proof-provider/service/index.js:90:27)
```

`waitUntilHeightAttested()`는 15초 간격 폴링 루프를 돌지만 **그 안의 HTTP 호출(10초 타임아웃)이 실패하면
예외가 루프 밖으로 튀어나온다.** 폴링 자체에는 재시도가 없다.

> 🔑 **핵심 통찰: 어테스트는 체인의 성질이지 프로세스의 성질이 아니다.**
> 소스 tx 는 계속 유효하므로 재시도는 **언제나 안전하다.** 포기할 이유가 없다.
> `AttestationWatcher.waitFor()` 는 개별 폴링 실패를 흡수하고 무한히 기다린다.

---

## 2. 구조

```
worker/
  config.ts       환경변수 로딩·검증
  log.ts          타임스탬프 로거
  retry.ts        Backoff · withRetry  ← SDK 취약성 대응의 핵심
  store.ts        파일 영속 상태 (원자적 쓰기)
  attestation.ts  어테스트 대기 (SDK 대체)
  proof.ts        증명 획득 + queryId 계산
  abi.ts          forge 산출물에서 ABI 로딩 (단일 정본)
  worker.ts       스캔 + 처리 루프
  index.ts        엔트리 + 그레이스풀 셧다운
```

## 3. 작업 수명주기

```
discovered ──(어테스트 대기)──▶ attested ──(증명)──▶ submitted ──▶ done
     │                                                   │
     └──────────── skipped (이미 처리된 쿼리) ◀───────────┘
     └──────────── dead (maxAttempts 초과 · C1 위반)
```

**작업 단위 = 소스 트랜잭션 1건.** `queryId`가 tx 단위이므로 `execute()`도 tx 당 1회다.
한 tx 의 로그 N개는 ASC 가 한 번에 순회 처리한다.

## 4. 핵심 방어

### 4.1 커서 전진 순서
```ts
const found = await this.scanRange(from, to);
this.store.setCursor(to);   // ★ 작업이 전부 영속화된 뒤에만 전진
```
먼저 전진시키면 크래시 시 그 구간을 영원히 놓친다. 커서는 되돌아가지도 않는다.

### 4.2 멱등 — 가스를 태우지 않는다
ASC 가 `processedQueries` 로 이미 막지만, 워커도 **제출 전에 조회**해 실패할 tx 를 아예 보내지 않는다.

```ts
const txIndex = txIndexFromProof(proof.merkleProof.siblings);
const queryId = computeQueryId(proof.chainKey, proof.headerNumber, txIndex);
if (await this.asc.processedQueries(queryId)) { /* skipped */ }
```

`computeQueryId` 는 `ASCBaseX._computeQueryId` 와 **바이트 단위로 동일**해야 한다.
레이아웃(총 72바이트)을 양쪽에서 검증한다:

| 범위 | 내용 |
|---|---|
| `[0..32)` | `uint256(chainKey)` |
| `[32..40)` | `uint64 blockHeight` (big-endian) |
| `[40..72)` | `uint256(txIndex)` |

- Solidity: `test/QueryId.t.sol` — 퍼즈 256런 + 고정 벡터
- TypeScript: `worker/worker.test.ts` — **같은 고정 벡터**로 대조
  `0x6ca17d0e6939c57d0d71f9b17302db50a70d50e09c6144c362cadd1850a36159`

### 4.3 기동 시 설정 정합성 검사
```ts
if (Number(expectedKey) !== cfg.chainKey) throw …
if (srcAddr.toLowerCase() !== cfg.sourceAddress.toLowerCase()) throw …
```
ASC 가 신뢰하는 소스와 워커가 감시하는 소스가 다르면 **증명을 아무리 제출해도 전부 revert 된다.**
8분씩 태우기 전에 기동 시점에 죽는 편이 낫다.

### 4.4 리오그 여유
헤드에서 `WORKER_CONFIRMATIONS`(기본 4) 블록 뒤까지만 확정으로 본다.
어테스트 자체가 파이널리티를 요구하므로 큰 값은 불필요하다.

### 4.5 C1 위반 탐지
한 tx 에 서로 다른 종류의 ASC 이벤트가 섞이면 하나만 처리되고 나머지는 **영구 봉인**된다
([`04-event-schema.md`](04-event-schema.md) §0). 우리 `ComplianceSource` 는 그런 tx 를 만들지 않으므로,
발견되면 **설계 위반**이다 — 조용히 넘기지 않고 `dead` 로 표시하고 에러 로그를 남긴다.

### 4.6 실패 격리
작업 하나가 죽어도 큐의 나머지는 계속 돈다. `maxAttempts` 초과 시 `dead` 로 격리하고 사람이 보게 한다.

---

## 5. 실행

```sh
forge build                 # ABI 산출 (워커가 out/ 에서 읽는다)
npm run worker              # 기동
npm run worker:test         # 유닛테스트 11건
npm run typecheck
```

필요한 환경변수는 `.env.example` 참조. 배포 후 `SOURCE_CONTRACT_ADDRESS` / `ASC_CONTRACT_ADDRESS` 를 채운다.

## 6. 실전 검증 — 실발급 E2E 성공 (2026-08-30)

배포된 컨트랙트에 대해 워커가 전 구간을 자동 처리했다.

| 단계 | 값 |
|---|---|
| Sepolia `issue()` | tx `0x93e4f981…9a01` · block 11,597,799 · gas **27,933** |
| **워커 감지** | 발급 후 **86초** |
| 어테스트 완료 | 발급 후 **6분 30초** (39블록) |
| CC3 `execute()` 제출 | tx `0xe0f8f6d4…` · gas **386,008** |
| `isVerified` → true | 발급 후 **7분 55초** |
| `note.mint` 성공 | tx `0x8f6789cf…c138` · 잔고 1.0 KRCN |

```
✓ ASC 설정 일치 확인
발견 MarkIssued ×1 — tx 0x93e4f981… (블록 11597799)
블록 11597799 어테스트 대기 — 현재 11597760, 39블록 뒤 (약 7.8분)
✓ 블록 11597799 어테스트 완료 (최신 11597800)
✓ 반영 완료 MarkIssued ×1 — gas 386008
```

**설계대로 동작한 것:** 기동 시 `expectedChainKey`/`sourceContract` 선검사 · 어테스트 폴링 실패 흡수 ·
제출 전 멱등 확인 · 커서 영속.

### ⚠️ 이 E2E 가 증명한 것과 증명하지 않은 것

> **이 마크의 `methods` 는 손으로 만든 값이다.** 파이프라인이 실제 심사를 거쳐 산출한 값이 아니다.
> `0x19003f` 에는 `ID_DOC_AUTHENTICITY` · `FACE_MATCH` · `LIVENESS` · `BANK_ACCOUNT` 가 들어 있지만
> **그 확인들은 실제로 수행되지 않았다.**

| 증명한 것 | 증명하지 않은 것 |
|---|---|
| 크로스체인 무결성 (전 필드 온전 전달) | 실제 신원 심사가 있었다는 것 |
| 워커 내결함성 (감지·대기·제출 자동화) | `methods` 비트의 진실성 |
| 게이트 반응 (`isVerified` → `note.mint`) | 파이프라인 정직성 (§ [`04`](04-event-schema.md) 아님 — `pipeline/` 이 담당) |
| 전파 지연 7분 55초 | |

→ 이 마크는 **폐기(`revoke`)** 한다. 우리 제품이 존재하는 이유가 "하지 않은 확인을 주장하는 마크"를 막는 것인데,
   그런 마크를 우리 테스트넷에 남겨둘 수는 없다 (§15-4 · §15-7).
   부수효과로 §10 대본 8번(폐기 → 게이트 재차단)이 온체인으로 증명된다.

### 크로스체인 무결성 — 전 필드 일치
```
status 1(ACTIVE) · origin 1(Direct) · kind 1 · assurance 2 · regime 1 · jurisdiction 410
methods 0x19003f · epoch 0 · issuer 0xFD12…bD5E
claimsRoot   0xd78af317…bca97  ✓ 발급 원본과 일치
evidenceHash 0xfab21992…297a  ✓ 발급 원본과 일치
```

> `origin = 1(Direct)` 는 소스 이벤트가 아니라 **ASC 가 쓴 값**이다(`ProofmarkASC.sol:149`).
> 팩킹에 넣지 않은 판단이 온체인으로 증명됐다 — 발급사가 출처를 위조 주장할 수 없다.

### ⏱ 어테스트 지연은 고정값이 아니다

| 관측 | 지연 |
|---|---|
| Hello Bridge (8/30) | **8.5분** (42블록) |
| 실발급 E2E (8/30) | **6.5분** (39블록) |

**관측 범위 6.5–8.5분.** 문서·덱에 단일 값을 쓰지 말고 **범위로** 적는다.
데모 영상 편집 시에도 최악값(8.5분+)을 기준으로 잡는다.

---

## 7. ⚠️ 운영 함정 두 가지

### 7.1 커서 — 워커를 먼저 띄워야 한다
`WORKER_START_BLOCK=0` 이면 커서가 **현재 헤드**에서 시작한다.
`issue()` 를 먼저 보내면 워커가 그 이벤트를 보지 못한다.

- (권장) **워커 기동 → 그다음 발급**
- 이미 발급했다면 `WORKER_START_BLOCK=<발급 직전 블록>` 설정 후 `rm -f state/worker.json`

> 데모 리허설에서 가장 걸리기 쉬운 지점이다.

### 7.2 `getMark` 필드 순서 — `origin` 이 두 번째다

`Mark` 구조체는 `status, **origin**, kind, assurance, …` 순이다.
`origin` 을 빼먹고 읽으면 값이 한 칸씩 밀려서, `evidenceHash` 의 마지막 20바이트가
`address` 로 찍혀 **"issuer 가 이상한 값"처럼 보인다.** 실제로 한 번 걸렸다.

README·재현 절차에는 **정확한 ABI 시그니처를 함께** 적는다:
```sh
cast call $ASC \
  "getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))" \
  $SUBJECT --rpc-url $CREDITCOIN_RPC_URL
```

> 그리고 `cast call` 에는 **항상 `--from`** 을 붙인다. 없으면 `msg.sender=0` 이라
> `onlyOwner` 가 먼저 걸려 `OwnableUnauthorizedAccount(0x118cdaa7)` 가 나오는데,
> 이걸 게이트 동작으로 오해하기 쉽다 (진짜 게이트는 `RecipientNotVerified` = `0x17887111`).

---

## 8. 검증 상태

| | |
|---|---|
| 워커 유닛테스트 | **11 passed** (queryId 3 · txIndex 2 · Store 5 · Backoff 1) |
| 타입체크 | ✅ 오류 없음 |
| 컨트랙트 테스트 | **36 passed** (QueryId 2 포함) |

> 타입체크가 실제 버그를 하나 잡았다 — `this.src`(provider)와 `this.source`(contract) 혼동.
> 로그 스캔이 통째로 동작하지 않았을 코드였다.

## 9. 남은 것

- [x] ~~배포 후 실제 주소로 E2E 1회~~ ✅ 성공 (§6)
- [ ] 데드레터 재처리 CLI (`--retry-dead`)
- [ ] 메트릭 노출 (처리 지연 p50/p95 — 기획안 §14 KPI)
- [ ] Mode B(에폭) 경로는 `RosterEpochPublished` 액션 3으로 이미 지원. ASC 측 핸들러만 P1
