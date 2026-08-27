# BUIDL CTC 2026 Fall — 해커톤 브리프

> 작성일: 2026-08-30 · 문서 소유자: Tech Lead / PO
> 원문 출처: 해커톤 공고문(전문 반영) + https://attestcoin.org · https://docs.attestcoin.org

---

## 1. TL;DR

| 항목 | 내용 |
|---|---|
| 대회명 | **BUIDL CTC 2026 Fall — "BUIDL For The Real World"** |
| 주최 | Creditcoin & Credit Labs |
| 필수 테마 | **Attestcoin Protocol** (구 명칭: Universal Smart Contracts, USC) 통합 — 예외 없음 |
| 트랙 | DeFi / RWA / DePIN / Gaming / AI (5개 중 택1) |
| 총 상금 | **$15,000** (1위 $10,000 / 2위 $3,000 / 3위 $2,000) |
| 부가 혜택 | 상위 3팀 **CEIP 패스트트랙**(초기 스크리닝 생략 → 실사 단계 직행) + CertiK 감사 크레딧 |
| 제출 마감 | **2026-09-13 (일) 23:59 ET** = **2026-09-14 (월) 12:59 KST** |
| 남은 기간 | **D-14** (오늘 2026-08-30 기준) |
| 최소 팀 규모 | 1명 |
| 배포 요건 | **테스트넷 배포 필수** (CC3 Testnet + Ethereum Sepolia) |

**핵심 판단:** 상금($15k)보다 **CEIP 패스트트랙**이 실질 가치다. 즉 심사위원은 "해커톤 데모"가 아니라 **"투자 가능한 제품의 씨앗"** 을 본다. 스코프를 데모용 장난감이 아니라 *작동하는 최소 제품 + 명확한 시장 논리*로 잡아야 한다.

**관련 문서:** [01-env-verification.md](./01-env-verification.md) — 개발 환경 검증 리포트 (2026-08-30, 정상 확인)

---

## 2. 테마: Attestcoin Protocol (필수)

> "Every submission this season must leverage the Attestcoin Protocol."

Attestcoin Protocol은 Creditcoin을 **검증된 크로스체인 데이터/메시징 인프라**로 확장한다.
중앙화된 오라클 운영자에 의존하지 않고, Creditcoin 위의 앱이 **다른 체인에서 어태스트된(attested) 데이터**를 사용하고 크로스체인 비즈니스 로직을 실행할 수 있게 한다.

주최측이 명시한 기대 형태:
- 무신뢰(trustless) 크로스체인 DeFi
- 토큰화된 실물자산(RWA)
- 게임 경제
- 검증 가능한 거버넌스

---

## 3. 타임라인

| 날짜 | 이벤트 | 상태 |
|---|---|---|
| 2026-08-13 | 제출 오픈 | 완료 |
| 2026-08-18 | 온라인 AMA — [녹화본](https://youtu.be/HPL6LjTqQm4) | 완료 (**시청 필수**) |
| **2026-09-13 23:59 ET** | **제출 마감 (연장된 일정)** | **D-14** |
| 2026-09-20 | 수상자 발표 | — |

### 역산 일정 제안 (D-14)

| 기간 | 목표 | 산출물 |
|---|---|---|
| 8/30 – 9/01 (D-14~D-12) | 아이디어 확정 · 트랙 결정 · Attestcoin 통합 지점 설계 · 튜토리얼 `Hello Bridge` 완주 | 아키텍처 문서, 통합 스펙 |
| 9/02 – 9/07 (D-11~D-6) | 코어 구현 (Source Chain 컨트랙트 → Offchain Worker → ASC) | Sepolia + CC3 Testnet 배포, E2E 1회 성공 |
| 9/08 – 9/10 (D-5~D-3) | 프론트엔드 · 통합 테스트 · README/기술문서 | 데모 가능한 앱 |
| 9/11 – 9/12 (D-2~D-1) | 데모 영상 · 덱/백서 PDF · 제출 폼 작성 | 제출물 일체 |
| 9/13 (D-Day) | **최소 12시간 전 제출** (KST 9/14 01:00 목표) | 제출 완료 |

> ⚠️ 마감이 한국시간 월요일 낮 12:59다. 주말에 최종 마무리가 끝나야 한다. 일요일 밤을 버퍼로 두지 말 것.

---

## 4. 상금 및 혜택

- **총상금 $15,000**
  - 1위 $10,000 / 2위 $3,000 / 3위 $2,000
- **CertiK 혜택 (모든 수상팀)**
  - 레포지토리 감사에 사용 가능한 **8K 크레딧**
  - **Skynet Boost 3개월**
  - ※ CMC 상장 지원은 **미포함**
- **CEIP 패스트트랙 (상위 3팀)**

### CEIP (Creditcoin Ecosystem Investment Program)

- Credit Labs가 주도하는 **투자 프로그램**. Creditcoin 생태계를 강화·확장하는 제품을 만드는 회사/개인 지원.
- 혜택: **초기 투자 + 후속 펀딩/그랜트 가능성**, Creditcoin 팀의 엔지니어링·프로덕트 자문, **Creditcoin 파트너 네트워크(생태계 파트너 및 VC) 접근**
- 패스트트랙: 초기 스크리닝 단계를 건너뛰고 **바로 실사(due diligence) 단계로 진입** → 투자 결정 가속

---

## 5. 트랙 (5개)

| # | 트랙 | 주최측 정의 | 비고 |
|---|---|---|---|
| 1 | **DeFi** | Creditcoin 위에 대출·거래·유동성·수익 애플리케이션 구축. 네트워크가 실용적이고 투명한 온체인 금융을 구동함을 증명 | 가장 경쟁 치열 예상 |
| 2 | **RWA** | 실물자산을 토큰화·관리·금융화하여 오프체인 가치와 온체인 투명성을 연결 | Creditcoin의 본진(신용/대출) — 주최측 서사와 정합 |
| 3 | **DePIN** | 크로스체인 데이터를 활용해 하드웨어·센서 네트워크의 인센티브·정산·조정을 구동 | 하드웨어 없이 데모하기 어려움 |
| 4 | **Gaming** | 인게임 경제, 자산 소유권, 플레이어 주도 마켓플레이스를 갖춘 게임/게임 인프라 | 14일 내 완성도 확보 난이도 높음 |
| 5 | **AI** | 암호학적으로 검증된 크로스체인 데이터를 처리해 자율적으로 판단하고 중앙화 오라클 없이 온체인 트랜잭션을 트리거하는 AI 앱 | 서사 강력, 단 "AI 껍데기" 리스크 |

**트랙 선택 관점:** Attestcoin의 현재 실제 능력은 *"Ethereum에서 일어난 일을 Creditcoin에서 무신뢰로 읽기(Readability)"* 다. 이 능력이 **없으면 성립하지 않는** 제품일수록 점수가 높다. 반대로 "그냥 오라클 하나 붙인 앱"은 통합 깊이 점수에서 죽는다.

---

## 6. 필수 요건

### 6.1 참가 자격 (팀원 전원 충족)
- 범죄 기록 없음
- 계류 중인 형사 사건 없음
- 제재 대상 국가 거주자가 아닐 것
- 제재 대상 개인이 아닐 것
- 현지 법률상 참가가 허용될 것

### 6.2 Attestcoin Protocol 통합 요건 (**핵심 채점 항목**)
> "Projects must demonstrate a meaningful and functional integration with the Attestcoin Protocol."

완결된 제출을 위한 요구사항:
1. **프로젝트 내에서 실제로 동작하는 Attestcoin Protocol 통합 코드**
2. **셋업 방법과 프로토콜 사용 방식을 설명하는 기술 문서**
3. **Attestcoin Protocol 활용의 깊이(Depth)가 핵심 채점 기준 중 하나로 평가됨**

### 6.3 프로젝트 요건
- **해커톤 기간 중 만들어진 오리지널 작업물**일 것
- **테스트넷에 배포**되어 있을 것
- **Attestcoin Protocol을 핵심 기능(core feature)으로 통합**할 것
- 제3자 IP를 침해하지 않을 것

### 6.4 약관
- 제출한 모든 정보는 정확하고 진실할 것
- 제출한 코드·콘텐츠·자료 일체에 대한 완전한 권리와 소유권을 보유할 것

---

## 7. 제출물 체크리스트

### 프로젝트 정보
- [ ] Project Name
- [ ] Project Logo — 이미지 URL (PNG / SVG / AI) *(선택)*
- [ ] Project Sector — DeFi / RWA / DePIN / Gaming / AI
- [ ] Project Description
- [ ] **Attestcoin Protocol Integration Summary** — 프로토콜을 어떻게 사용하는지 설명 *(가장 중요한 서술)*
- [ ] **GitHub Repository URL** — README 필수 포함
- [ ] **Project Deck 또는 Whitepaper** — PDF URL
- [ ] **Prototype Demo Video URL**

### 팀 정보 (팀원 1인당)
- [ ] First & Last Name
- [ ] Email
- [ ] Telegram ID *(선택)*
- [ ] X / Twitter *(선택)*
- [ ] LinkedIn *(선택)*
- [ ] Resume PDF URL *(선택)*
- [ ] Short Bio
- [ ] Role within the team
- [ ] Country of Residence
- [ ] Country of Citizenship

### 팀 규모
- 최소 1명

> 📌 **호스팅 준비물:** 로고 이미지, 덱/백서 PDF, 데모 영상 모두 **공개 URL** 이 필요하다. (GitHub Pages / Google Drive 공개 링크 / YouTube 미등록 링크 등을 미리 확보해 둘 것.)

---

## 8. Attestcoin Protocol 기술 요약

### 8.1 한 줄 정의
Creditcoin 위 스마트컨트랙트가 **지원되는 다른 체인을 읽고(read), 나아가 쓸 수(write) 있게** 하는 크로스체인 상호운용 허브. 브릿지처럼 자산을 락업하지 않으며 **자금을 수탁하지 않고 검증된 정보만 전달**한다.

### 8.2 신뢰 모델
- 중앙 오라클 운영자 대신 **독립적인 Attestor(검증자) 네트워크**가 실제 가치를 스테이킹하고 각 체인의 데이터를 직접 확인
- "proof, not a promise" — 중개자 신뢰가 아닌 수학적 검증
- 단일 실패 지점 없음

### 8.3 핵심 컴포넌트

| 컴포넌트 | 역할 |
|---|---|
| **Attestors** | 소스 체인 블록 헤더를 어태스트하는 독립 검증자 집합 |
| **ASC (Attestcoin Smart Contract)** | Creditcoin에 배포되어 증명을 검증하고 비즈니스 로직을 실행하는 컨트랙트 |
| **BlockProver Precompile** | Creditcoin **한 블록 안에서 동기적으로** 트랜잭션 증명을 검증 (`0x...0FD2`) |
| **ChainInfo Precompile** | 지원 체인 / 어태스트 상태 조회 (`0x...0fd3`) |
| **Proof Builder Service** | Merkle proof + Continuity proof 생성 (호스팅 API 제공) |
| **Offchain Worker** | 소스 체인 이벤트 감시 → 어태스트 대기 → 증명 획득 → ASC 호출 |

### 8.4 검증 파이프라인 (Readability)
1. **Step 1 — Attestation**: Attestor들이 소스 체인 블록을 Creditcoin에 어태스트 (+ Continuity Proving)
2. **Step 2 — Transaction Proving**: Merkle 증명으로 트랜잭션 포함(inclusion)을 증명 (+ 쿼리용 Continuity Proving)

- **속도**: 소스 체인 파이널리티 이후 **약 1블록(~15초)** 내 검증 완료
- **배치**: 하나의 continuity proof를 공유하여 **최대 10개 쿼리** 배치 처리 (1000블록 범위 내)
- **Writability**(크로스체인 실행)는 개발 진행 중 — **현재 안정적으로 쓸 수 있는 축은 Readability**

### 8.5 권장 dApp 설계 패턴 (Readability)

```
[User] → Source Chain Contract (Ethereum Sepolia)
             │  optional onchain logic (e.g. burn)
             └─ emit Event
                    ↓ (watch)
             Offchain Worker
                    ├─ waitUntilHeightAttested()
                    ├─ ProofBuilder.getProof(txHash)  → merkleProof + continuityProof
                    └─ call ASC(proof, txData)
                              ↓
             ASC on Creditcoin
                    ├─ BlockProver Precompile 로 동기 검증
                    └─ 비즈니스 로직 실행 (ASC 내부 또는 dApp 컨트랙트 호출)
```

**모범 사례 (문서 명시)**
- dApp당 **소스 컨트랙트 1개**로 유지하고, 프로토콜 관련 이벤트를 전부 여기서 emit
- **모호하지 않은 이벤트**: 쿼리마다 별도 이벤트 타입 (`LoanInitiated` vs `LoanRepaid`)
- **의도가 드러나는 이름**: `TokensBurnedForBridging`
- **표준 이벤트 회피**: 범용 `Transfer` 대신 `TokensBurned` 같은 전용 이벤트
- **완결된 데이터**: ASC가 처리에 필요한 모든 필드를 이벤트에 포함

### 8.6 SDK

```sh
npm install @gluwa/usc-sdk    # peer dep: ethers v6
```

| API | 용도 |
|---|---|
| `PrecompileChainInfoProvider.getSupportedChains()` | 지원 체인 및 `chainKey` 조회 |
| `proofBuilder.waitUntilHeightAttested()` | 대상 블록이 어태스트될 때까지 대기 |
| `proofBuilder.getProof(txHash)` | `merkleProof` + `continuityProof` 획득 |
| `PrecompileBlockProver.verifySingle()` / `verifyBatch()` | 온체인 증명 검증 제출 |
| `RawProofBuilder` | 호스팅 API 대신 로컬 계산 (동일 인터페이스) |

### 8.7 환경 / 주소

**CC3 Testnet (← 우리가 쓸 환경)**
| 항목 | 값 |
|---|---|
| 지원 소스 체인 | Ethereum **Sepolia** (chainKey `1`), Ethereum Mainnet (chainKey `3`) |
| ASC 대시보드 | https://dashboard.cc3-testnet.creditcoin.network/ |
| Proof Builder API | https://proof-gen-api.cc3-testnet.creditcoin.network/ |
| Decoder Contract | `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` |
| ChainInfo Precompile | `0x0000000000000000000000000000000000000fd3` |
| BlockProver Precompile | `0x0000000000000000000000000000000000000FD2` |

**CC3 Mainnet (참고)**
| 항목 | 값 |
|---|---|
| 지원 소스 체인 | Ethereum Mainnet (chainKey `1`) |
| ASC 대시보드 | https://dashboard.cc3-mainnet-usc.creditcoin.network/ |
| Proof Builder API | https://proofbuilder.cc3-mainnet-usc.creditcoin.network/ |
| Decoder Contract | `0x9D094C9f22B10FCf842c2fC6A0981630A4F94B5C` |

> ⚠️ **주의:** Testnet에서 Sepolia의 chainKey가 `1`, Mainnet의 chainKey가 `3`이다. EVM chainId와 혼동 금지. 항상 `getSupportedChains()`로 런타임 확인할 것.

### 8.8 가이드 튜토리얼 (순서대로 진행 권장)
1. **Hello Bridge** — 첫 크로스체인 트랜잭션
2. **Custom Contract Bridging** — 커스텀 컨트랙트 브리징
3. **Bridge Off-chain Worker** — 오프체인 워커 운영
4. **Cross-Chain Loan dApp** — 캡스톤: 완전한 크로스체인 dApp

예제 레포: https://github.com/gluwa/attestcoin-protocol-examples
※ 문서상 "교육 목적, 프로덕션 직접 배포 금지" 명시. 영상 자료는 구명칭(USC)을 사용.

### 8.9 ATC 토큰 (참고)
- 고정 공급 **1,000만 ATC**, 인플레이션 없음
- **읽기 무료 / 쓰기 유료** — 크로스체인 액션에 ATC 지불
- 수수료 소각 → 디플레이션 설계, Attestor 보상 재원

---

## 9. PO 관점 전략 노트

1. **채점의 무게중심은 "통합 깊이"다.** 공고문이 명시적으로 `Depth of Attestcoin Protocol utilization will be evaluated as one of the core scoring criteria`라고 썼다. → *Attestcoin이 빠지면 제품이 성립하지 않는* 설계여야 한다. 단순 데이터 조회 1회는 약하다.
2. **Readability에 베팅하라.** Writability는 개발 중이다. 마감 14일 안에 안정적으로 데모하려면 "Ethereum(Sepolia)의 사실 → Creditcoin에서 무신뢰 검증 → 온체인 액션" 축으로 간다.
3. **CEIP를 노린다면 서사가 절반이다.** 심사 이후가 실사 단계다. 덱에 시장/사용자/수익모델/왜 Creditcoin인가가 없으면 상위 3위가 어렵다.
4. **테스트넷 배포 + 공개 검증 경로는 협상 불가.** 컨트랙트 주소, 예시 트랜잭션 해시, 대시보드 링크를 README에 박아 심사위원이 5분 안에 재현하게 만든다.
5. **데모 영상은 3분 이내, "증명" 장면을 클로즈업.** Sepolia 트랜잭션 → 어태스트 대기 → Creditcoin에서 검증 성공하는 흐름이 화면에 보여야 한다.
6. **README = 기술 문서 요건 충족 수단.** 셋업 절차와 프로토콜 사용 방식을 문서화하는 것이 명시적 제출 요건이다.

---

## 10. 미해결 사항 / 확인 필요

> 환경 관련 항목은 2026-08-30 검증 완료 → **[docs/01-env-verification.md](./01-env-verification.md)** 참조

**해소됨 ✅**
- [x] ~~CC3 Testnet 가스 토큰 및 Sepolia RPC 수급 경로~~ → 공용 Sepolia RPC로 Infura 가입 불필요. 파우셋 경로 확인 완료
- [x] ~~Proof Builder API 레이트리밋 / 어테스트 지연 실측값~~ → **어테스트 지연 실측 ≈ 8.2분**, API 정상 (응답 ~0.6s)
- [x] ~~개발 환경 동작 여부~~ → 툴체인·빌드·RPC·프리컴파일·오라클 전부 정상

**남은 항목**
- [ ] AMA 녹화본 시청 후, 공고문에 없는 심사 세부 기준·주최측 선호 방향 반영
- [ ] 상세 채점 루브릭(항목별 배점) 공개 여부 — Discord `#buidl-ctc-qna`에 문의
- [x] ~~Readability 수수료 정책~~ → **READ 무료 확정** (공식 문서 + 실측 일치, [`05`](05-asc-integration-review.md) §6)
- [ ] "originality: 해커톤 기간 중 제작" 판정 기준 — 사전 작업물/기존 레포 재사용 허용 범위
- [ ] 제출 폼 실제 URL 및 필드 확인 (제출 30분 전 처음 열지 말 것)
- [ ] **파우셋 자금 수령** (사람 필요) — 유일한 실행 블로커
- [ ] 팀 구성 확정 및 팀원별 거주국·시민권 정보 수집

---

## 11. 설계에 반영해야 할 실측 제약 ⚠️

환경 검증에서 드러난, **제품 설계를 바꿀 수 있는** 두 가지 사실:

### 11.1 크로스체인 확인에 ~8~10분 지연
Attestor가 소스 체인 블록을 어테스트하기까지 실측 **6.5–8.5분**이 걸린다 (관측 2회) (리버전 대비 안전 마진).
→ 실시간 응답이 필요한 기능을 이 축에 올리면 안 된다. **낙관적 UI / 비동기 워커 / 명시적 대기 상태**를 전제로 설계할 것.
→ 데모 영상도 이 지연을 감안해 편집(컷 또는 배속)해야 한다.

### 11.2 ~~테스트넷 오라클 쿼리 하루 9회 제한~~ → 해소됨 (8/30 정정)

> README의 "24시간당 100 CTC = 쿼리 9회" 서술을 근거로 심각한 제약이라 적었으나,
> **실수령액은 10,000 CTC였다(실측).** 이 제약은 우리 상황에 해당하지 않는다.

다만 **로컬 모의 하네스 우선 원칙은 유지한다.** 근거가 바뀔 뿐이다 —
아껴야 하는 것이 *쿼리 예산*이 아니라 ***어테스트 8분 대기 사이클*** 이다.
E2E 시도 1회 실패 = 8분 손실이고, 이건 돈으로 해결되지 않는다.

---

## 12. 다음 액션 (즉시)

1. ~~`Hello Bridge` 환경 검증~~ ✅ 완료 — 자금만 있으면 즉시 실행 가능
2. **파우셋 2곳에서 자금 수령** (Google Sepolia + Creditcoin Discord) ← 지금 병목
3. AMA 녹화본 시청 → 본 문서 9~10장 업데이트
4. Discord 가입 + 미해결 질문 게시
5. Tutorial 4 `Loan Flow` 정독 — 우리 제품 구조에 가장 가까운 레퍼런스

---

## 13. 링크 모음

| 구분 | URL |
|---|---|
| Attestcoin 공식 | https://attestcoin.org/ |
| 개발자 문서 | https://docs.attestcoin.org/ |
| 문서 인덱스(LLM용) | https://docs.attestcoin.org/llms.txt |
| Chains & Environments | https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments |
| Guided Tutorials | https://docs.attestcoin.org/attestcoin-protocol/guided-tutorials |
| SDK 문서 | https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk |
| SDK npm | https://www.npmjs.com/package/@gluwa/usc-sdk |
| 예제 레포 | https://github.com/gluwa/attestcoin-protocol-examples |
| AMA 녹화본 | https://youtu.be/HPL6LjTqQm4 |
| Creditcoin Discord | https://discord.gg/Gu43zTfmtc |
| 문의 이메일 | team@creditcoin.org (Discord `#buidl-ctc-qna`) |
