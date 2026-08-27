# 환경 검증 리포트 — Attestcoin / CC3 Testnet

> 실행일: 2026-08-30 · 목적: 해커톤 착수 전 최대 리스크(개발 환경 동작 여부) 해소
> 대상: `gluwa/attestcoin-protocol-examples` → Tutorial 1 `Hello Bridge`

---

## 1. 결론

**환경은 살아있고 정상 동작하며, 자금도 수령 완료됐다.** 오라클이 Sepolia를 실시간 어테스트 중이며, 문서에 적힌 지연 시간과 실측치가 일치한다.
코드·RPC·프루프 빌더·컨트랙트 모두 검증 완료. **블로커 없음.** 남은 제약은 자금이 아니라 어테스트 지연(~8분)이다.

| 항목 | 상태 |
|---|---|
| 툴체인 (node/yarn/foundry) | ✅ |
| 의존성 설치 | ✅ |
| 컨트랙트 컴파일 | ✅ |
| CC3 Testnet RPC | ✅ |
| Sepolia RPC (무료 공용) | ✅ |
| ChainInfo 프리컴파일 조회 | ✅ |
| 오라클 어테스트 진행 상태 | ✅ 정상 (지연 ~8분) |
| Proof Builder API | ✅ |
| 배포된 예제 컨트랙트 | ✅ |
| 지갑 생성/`.env` 구성 | ✅ |
| **테스트넷 자금** | ✅ 수령 완료 (Sepolia 0.05 ETH · CC3 **10,000 CTC**) |

---

## 2. 툴체인

| 도구 | 설치 버전 | 비고 |
|---|---|---|
| Node.js | v24.15.0 | OK |
| yarn | 1.22.22 | `corepack enable` 로 조달 (전역 설치 불필요) |
| foundry (forge/cast) | **1.7.1** | repo README는 `foundryup --version v1.2.3` 권장하나 **1.7.1에서 정상 빌드됨 → 다운그레이드 불필요** |
| solc | 0.8.30 | foundry.toml 지정 |

```
yarn install  → Done in 6.34s (exit 0)
yarn build    → Compiling 32 files with Solc 0.8.30 → Compiler run successful!
```

---

## 3. 네트워크 검증

### 3.1 체인 연결

| 체인 | RPC | chainId | 상태 |
|---|---|---|---|
| Creditcoin CC3 Testnet | `https://rpc.cc3-testnet.creditcoin.network` | **102031** | ✅ block 5,399,037 |
| Ethereum Sepolia | `https://ethereum-sepolia-rpc.publicnode.com` | **11155111** | ✅ block 11,597,291 |

- CC3 Testnet gas price: `500000000` (0.5 gwei)

### 3.2 Sepolia RPC — Infura 가입 불필요 ✨

튜토리얼은 Infura 가입을 요구하지만, **무료 공용 RPC로 대체 가능함을 실측 확인**했다.

| 후보 | 결과 |
|---|---|
| `https://ethereum-sepolia-rpc.publicnode.com` | ✅ **동작 (채택)** |
| `https://1rpc.io/sepolia` | ✅ 동작 (예비) |
| `https://rpc.sepolia.org` | ❌ 404 (죽음) |
| `https://sepolia.drpc.org` | ❌ 유료 플랜 요구 |

> 단, 프로덕션/데모 안정성이 필요하면 전용 키(Infura/Alchemy)를 쓰는 편이 낫다. 공용 RPC는 레이트리밋 가능성이 있다.

### 3.3 chainKey 매핑 — **런타임 실측 확인**

`PrecompileChainInfoProvider.getSupportedChains()` 결과:

```json
[
  { "chainKey": 3, "chainId": 1,        "chainName": "Ethereum",         "chainEncoding": 1 },
  { "chainKey": 1, "chainId": 11155111, "chainName": "Sepolia ethereum", "chainEncoding": 1 }
]
```

> ⚠️ **함정 확인됨**: `chainKey`(1) ≠ `chainId`(11155111). 문서/`.env`의 서술과 일치하며, 하드코딩하지 말고 항상 `getSupportedChains()`로 조회할 것.

### 3.4 오라클 어테스트 상태 — **살아있음**

```
chainKey 1 (Sepolia): height=11,597,250
                      hash=0x9d134405282de887dcb37add3b7581a8f61db10db2346356c11787fd08a10815
                      Sepolia head=11,597,291 → lag 41 blocks ≈ 8.2 분
chainKey 3 (Ethereum mainnet): height=25,866,490
```

**실측 어테스트 지연 6.5–8.5분** (관측 2회) — 문서의 "~8-10분" 및 튜토리얼 README 서술과 정확히 일치. 소스 체인 리버전 대비 안전 마진이며 정상이다.

> 📌 **설계 영향**: 크로스체인 확인에 **약 8~10분 지연**이 존재한다. 데모 UX와 아키텍처가 이 지연을 전제해야 한다 (낙관적 UI, 대기 상태 표시, 비동기 워커). 실시간 응답이 필요한 기능은 이 축에 올리면 안 된다.

### 3.5 Proof Builder API

| URL | `/api/v1/attested-height/1` | 비고 |
|---|---|---|
| `https://prover.cc3-testnet.creditcoin.network` | ✅ `{"attestedHeight":11597250}` | repo `.env` 기본값 |
| `https://proof-gen-api.cc3-testnet.creditcoin.network` | ✅ `{"attestedHeight":11597250}` | 공식 문서 표기값 |

**두 도메인 모두 동일하게 동작** (별칭으로 보임). 응답시간 ~0.58s.

발견된 API 경로 (SDK 소스에서 추출):
- `GET /api/v1/attested-height/{chainKey}` — 최신 어테스트 높이
- `GET /api/v1/proof-by-tx/{chainKey}/{transactionHash}` — 트랜잭션 증명

### 3.6 배포된 컨트랙트 (CC3 Testnet)

| 주소 | 종류 | 확인 |
|---|---|---|
| `0x...0fd3` | ChainInfo Precompile | ✅ 호출 성공 (code는 `0x` — Substrate 프리컴파일 정상) |
| `0x...0FD2` | BlockProver Precompile | ✅ 존재 |
| `0x2Be9B8640ED32815d3B9e8C92AbcD3F15F07396f` | ASC Minter | ✅ 바이트코드 존재 |
| `0x914Cf96BF28b7b4921db27b264ecEd71aC91134E` | Mintable Token | ✅ `Bridge Test Token` / `BTKT` / 18 decimals |
| `0x0F24FD9e0524BA53d3f0A4A40350Adf5370b4A53` | Sepolia ERC20 burner | (자금 확보 후 호출 예정) |

---

## 4. 로컬 구성 상태

- 클론 위치: `reference/attestcoin-protocol-examples/`
- 일회용 테스트 지갑 생성 완료 (`cast wallet new`)
  - **주소: `0xFD1222e35a536A62f180aA44826656940e86bD5E`**
  - 개인키는 `reference/attestcoin-protocol-examples/.env` 에만 존재. 개인키→주소 유도 검증 완료 ✅
- `.env` 설정: `SOURCE_CHAIN_RPC_URL` = publicnode Sepolia, `CREDITCOIN_WALLET_PRIVATE_KEY` 주입 완료

### 🔐 보안 이슈 발견 및 조치

> **원본 repo의 `.gitignore`에 `.env`가 없고, `.env`가 저장소에 커밋되어 있다.**
> 튜토리얼 지시대로 개인키를 `.env`에 넣고 fork/commit 하면 **개인키가 그대로 공개된다.**

조치 완료:
- `.gitignore`에 `.env`, `.env.local` 추가
- `git rm --cached .env` 로 인덱스에서 제거 (`git ls-files .env` → 0)

> ⚠️ **우리 실제 해커톤 레포를 만들 때 이 패턴을 복사하지 말 것.** `.env.example`만 커밋하고 `.env`는 반드시 ignore.
> 현재 지갑은 가치 없는 일회용이지만, 습관이 사고를 만든다.

---

## 5. 자금 수령 현황

**수령 완료 (2026-08-30 실측)** — Sepolia **0.05 ETH** · CC3 **10,000 CTC**.

> ⚠️ **이 지갑은 형제 세션(`attest-kyc-65`)이 E2E 실행에 사용 중이다.** 같은 키로 동시에 tx를 보내면 nonce 충돌로 양쪽 다 깨진다.
> 온체인 트랜잭션은 **한 세션만** 보낸다. 병렬 작업이 필요하면 별도 지갑을 만들고 파우셋을 따로 받는다.

**수령처 (리필 필요 시 참조)**

| # | 자금 | 수령처 | 필요 조건 |
|---|---|---|---|
| 1 | Sepolia ETH | https://cloud.google.com/application/web3/faucet/ethereum/sepolia | Google 계정 |
| 2 | CC3 Testnet CTC | Creditcoin Discord 파우셋 채널에서 `/faucet address: <주소>` | Discord 가입 |

**사용 중인 주소:** `0xFD1222e35a536A62f180aA44826656940e86bD5E`

Discord 파우셋 명령 예시:
```
/faucet address: 0xFD1222e35a536A62f180aA44826656940e86bD5E
```

### ✅ 실수령액 — README 서술과 다름 (2026-08-30 갱신)

> **정정.** 최초 작성 시 README의 *"파우셋은 24시간당 100 테스트 CTC를 지급하며 이는 오라클 쿼리 9회 분량"* 을 그대로 옮기고
> "하루 9회는 심각한 제약"이라며 대응책까지 붙였다. **실수령액은 10,000 CTC였다(실측).** 100배다.
> 따라서 **"쿼리 예산 부족"은 우리 상황에 해당하지 않는다.** 이 전제에 기대어 세운 논거는 모두 폐기한다.

| 항목 | README 서술 | 실측 |
|---|---|---|
| CC3 수령액 | 100 CTC / 24h | **10,000 CTC** |
| 환산 쿼리 수 | 9회 | **약 5천만 회** (단가 0.0002 CTC 실측) |
| Sepolia ETH | — | **0.05 ETH** |

**E2E 실측으로 확정 (2026-08-30, 형제 세션 `attest-kyc-65`)**

| 항목 | 실측값 |
|---|---|
| CC3 `execute()` 가스 | **394,982** (SDK 추정 421,105 — 6.6% 과대) |
| 가스가격 | 0.5 gwei |
| 잔고 차감 | 10000 → 9999.999802509 CTC |
| **쿼리 1건 실단가** | **0.0002 CTC** |
| 별도 오라클 수수료 | **없음 — 차감액이 가스비와 정확히 일치** |

> 🔎 **READ 무료는 프로토콜의 명시적 설계다 — 우리 관측과 일치한다.**
>
> | 근거 | 내용 |
> |---|---|
> | attestcoin.org (공식) | *"Free reads, paid writes — apps can read other chains at no cost; cross-chain actions require ATC token payment"* |
> | 본 실측 (2026-08-30) | `execute()` 차감액이 가스비와 **정확히 일치**. 별도 수수료 0 |
>
> 즉 유료인 것은 **Writability(크로스체인 실행, 개발 중)** 이고, **Readability 는 가스만 든다.**
> README 의 "100 CTC = 9 queries, DOS 방지 고가" 서술은 이 경로에 해당하지 않는다.
>
> ⚠️ **제품 서사에 미치는 영향**: 우리 제품 전체가 무료 경로(Readability) 위에 있다.
> 따라서 **"우리가 ATC 수요/소각을 창출한다"는 주장은 쓸 수 없다.** ([`05`](05-asc-integration-review.md) §6 참조)

### 📊 E2E 전 구간 실측 (Hello Bridge, 전 구간 성공)

| 구간 | 값 |
|---|---|
| Sepolia mint | 50,969 gas |
| Sepolia burn | 30,721 gas · block 11,597,452 |
| **어테스트 대기** | **~8.5분 (42블록)** |
| 증명 생성 + 제출 + 마이닝 | ~1분 |
| **burn → ASC 반영 총계** | **9분 43초** |
| 결과 | BTKT 50 수령 ✅ |

### ⚠️ 그래도 남는 진짜 제약 — 어테스트 8분

자금 제약은 사라졌지만 **물리적 지연은 그대로다.**

- 소스 체인 파이널리티 + 어테스트 = **실측 ~8.2분**
- E2E 시도 1회 실패 = **8분 손실**. 하루에 시도할 수 있는 횟수가 여전히 제한된다.

**따라서 "로컬 모의 하네스 우선" 원칙은 유지한다.** 근거만 바뀐다:
- ~~쿼리 예산을 아끼려고~~ → **8분 대기 사이클을 아끼려고**
- anvil + 모의 BlockProver로 ASC 로직을 전부 검증한 뒤, 실제 증명 제출은 확신이 설 때만 쏜다
- 이게 없으면 오타 하나에 8분씩 태운다

### 🔴 SDK 취약성 — 워커 설계에 직결 (실측 발견)

형제 세션의 **첫 시도가 8분을 기다린 뒤 마지막 순간에 죽었다:**

```
Waiting for block 11597452 attestation on Creditcoin...
Error: Failed to fetch attested height: AxiosError: timeout of 10000ms exceeded
  at ApiClient.<anonymous> (@gluwa/usc-sdk/dist/proof-provider/service/index.js:90:27)
```

`waitUntilHeightAttested()`는 15초 간격 재시도 루프를 돌지만, **그 안의 HTTP 호출(10초 타임아웃)이 실패하면
예외가 루프 밖으로 튀어나온다. 폴링 자체에 재시도가 없다.** API 딸꾹질 한 번에 8분이 날아간다.

> **설계 결론: 우리 워커는 SDK 대기 함수를 그대로 쓰지 않는다.**
> - 폴링 HTTP 호출에 **재시도 + 지수 백오프**를 우리가 감싼다
> - 진행 상태를 **디스크/DB에 영속화** → 프로세스가 죽어도 이어받는다
> - 어테스트는 **체인의 성질이지 프로세스의 성질이 아니다** — burn tx는 계속 유효하므로 재시도가 항상 안전하다

## 6. 다음 단계

- [ ] **(사람) 파우셋 2곳에서 자금 수령** ← 유일한 블로커
- [ ] `cast send ... "mint(uint256)" 50000000000000000000` — Sepolia에서 테스트 ERC20 민팅
- [ ] `cast send ... "burn(uint256)" 50000000000000000000` — 번 실행, txHash 확보
- [ ] `yarn hello_bridge:submit_query <txHash>` — 어테스트 대기(~8분) → 프루프 생성 → ASC 제출
- [ ] `yarn utils:check_balance $ASC_MINTABLE_TOKEN <주소>` — BTKT 50.0 확인
- [ ] Tutorial 2~4 진행 (특히 **Tutorial 4 Loan Flow** 가 우리 제품 구조에 가장 가까움)

---

## 부록: 재현용 검증 스크립트

`reference/attestcoin-protocol-examples/env_check.ts` — 언제든 환경 상태를 재확인할 수 있다.

```sh
cd reference/attestcoin-protocol-examples && npx tsx env_check.ts
```

출력: 양 체인 연결 상태, 지원 체인 목록, chainKey별 최신 어테스트 높이 및 Sepolia 대비 지연(분).
