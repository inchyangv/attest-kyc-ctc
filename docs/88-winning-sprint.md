# Proofmark — winning sprint

기준일: 2026-09-10 KST. 사용자가 승인한 목표는 해커톤 경쟁력을 높이는 제품 구현과 병렬 작업이다. 수상은 보장할 수 없으며, 기능 수보다 **심사위원이 직접 확인하는 차별성과 재현 가능한 증거**를 최적화한다. 이 문서가 이번 실행의 우선순위·완료 기록이다. 기존 [TICKET.md](../TICKET.md)의 진단과 배포 기록은 보존한다.

## 1. 승부를 걸 제품

**한 번 확인한 신원을, 개인정보를 다시 제출하지 않고, 자산별 최신 규칙에 맞게 증명한다. 규칙을 더 이상 충족하지 않으면 자산이 거부한다.**

이번 구현의 세 축은 실제 외부 인증 연결, 지속적인 AML 상태, 최소 공개 자격 증명이다. 심사 화면에서는 하나의 자격이 두 정책에서 다른 결과를 내는 이유와 취소·만료 이후 거부를 보여준다. 인증 화면, AML 엔진, ZK 데모를 나란히 놓는 것만으로 하나의 완성된 발급 시스템이라고 부르지 않는다.

| 보여줄 경험 | 제품상 가치 | 입증해야 하는 경계 |
|---|---|---|
| 지갑에 묶인 hosted verification | 방문자가 실제 벤더 플로우를 시작 | 클라이언트 성공 콜백이 아닌 서버 확인, sandbox 구분 |
| 같은 credential, 다른 policy | 재사용과 관할권별 판단을 동시에 설명 | 동일 블록의 실제 policy 결과와 실패 이유 |
| AML 상태 변경 후 접근 거부 | 최초 KYC로 끝나지 않는 자격 | 목록/검사 시점, 재심사, 현재 epoch, 실제 자산 gate |
| 원문 없는 country/age 자격 증명 | 개인정보 전달을 줄이는 소비 경로 | 실제 회로·proof·Solidity verifier, 승인된 root |
| 60초 wallet-free 데모 | 심사위원의 첫 성공을 빠르게 | synthetic/live/historical/local을 명시 |

## 2. 이번 작업의 약속과 비약속

- 구현과 로컬 테스트는 진행한다. 기존 사용자 변경을 덮어쓰지 않는다.
- 실제 벤더 API를 호출할 수 있는 코드와 실제 고객 검증 완료는 다르다. 현재 로컬 설정에서 Sumsub credential은 확인되지 않았다. 비밀값을 채팅이나 로그에 요구하지 않는다.
- production 개인정보 처리, provider 계약/재사용 권리, 승인된 processing·retention·identity policy는 코드만으로 확보되지 않는다.
- 공개 체인 배포, live 고객 발급, 기존 계약 교체, 제출 폼 수정은 이번 로컬 구현과 별도 실행 단계다. 비용·정확한 환경·키·대상을 확인하고 진행한다.
- 기존 `claimsRoot`는 salted Keccak commitment다. 선택적 claim 공개와 Merkle proof는 ZK가 아니다. 새 ZK slice를 기존 공개 계약에 이미 연결됐다고 설명하지 않는다.
- 승인된 인증 결과라도 모든 AML 검사를 수행했다는 뜻은 아니다. PEP/미디어/KYT/Travel Rule은 수행·증거가 있는 범위만 표시한다.
- 이전 공개 v1 주소는 최신 로컬 계약의 보안·스키마 보장을 상속하지 않는다. 독립 issuer 격리 T-06도 별도 미해결이다.

## 3. 병렬 작업과 티켓

오케스트레이터가 공통 계약·문서·구성·통합 검증을 관리한다. 요청한 모델 중 도구에서 지원하는 **GPT-5.6 Sol / high**를 세 작업에 배정했다. 서로 다른 파일을 소유하며, 공통 파일은 오케스트레이터를 통해 수정한다.

상태: `IN_PROGRESS` 작업 중, `PARTIAL` 구현/부분 검증 완료이나 미해결 acceptance 존재, `READY` 선행 구현 후 실행 가능, `GATED` 실제 환경/승인/연결 필요, `VERIFIED_LOCAL` 명시한 로컬 범위 검증 완료. `VERIFIED_LOCAL`은 배포 완료가 아니다.

| ID | P | 작업 / 담당 | 상태 | 완료 기준 / 의존성 |
|---|---|---|---|---|
| WIN-01 | P0 | Sumsub 실제 온보딩 / provider_onboarding + root UI | VERIFIED_LOCAL | 서명 REST·WebSDK 화면·지갑/세션 binding·강한 webhook·CAS/원자적 callback. Provider unit 7/7, 실제 Redis 4/4, browser는 SDK/API fixture. 실제 벤더 계정 검증은 미실행 |
| WIN-02 | P0 | 인증 → 발급 연결 / orchestrator | GATED | 실제 수행 검사만 credential로 변환, 재조회·idempotent journal·현재 AML·vault·source outbox 통합. WIN-01 및 global regime/schema 결정 |
| WIN-03 | P0 | 지속 AML → 거부 / orchestrator | PARTIAL | provider 승인→review/reject·음성 callback fence·오래된 GREEN 덮어쓰기 방지는 로컬 검증. 기존 rescreen/case/outbox→epoch→자산 연결은 남음 |
| WIN-04 | P0 | 실제 ZK eligibility slice / zk_eligibility | VERIFIED_LOCAL | 실제 새 Groth16 proof/생성 verifier 실행, 회로 부정 사례 4개, gate 15/15 통과. Root→Attestcoin/자산 연결은 WIN-07/08 |
| WIN-05 | P0 | 심사위원 60초 데모 / judge_experience | VERIFIED_LOCAL | `/demo`·home 구현, unit 3/3, production browser fixture 검증. 라이브 체인 결과/자산 전송을 fixture 통과로 대체하지 않음 |
| WIN-06 | P0 | 회귀·증거·release gate / orchestrator | PARTIAL | 핵심 회귀·API·새 UI·ZK 검증 통과. 기존 전체 issuance E2E 실패를 해결하고 새 provider→발급 통합 증거를 별도로 확보해야 release gate 완료 |
| WIN-07 | P0 | 최소 공개 새 schema / orchestrator | READY | issuer 승인 credential commitment와 current root/epoch를 source→Attestcoin→CC에 연결; 공개 metadata 최소화; 기존 v1 migration 별도 |
| WIN-08 | P0 | 새 안전한 testnet 릴리스 | GATED | source/hub/consumer runtime hash pin, 소유권·키·비용 확인, rollback/주소 변경, issue→revoke 증거. WIN-06/07 및 배포 승인 |
| WIN-09 | P0 | 최종 2분 영상·데크·제출 설명 | READY | 확인한 동작만 촬영, propagated 시간 표시, 제품/증거/코드 링크 일치. WIN-05/06; live 주장은 WIN-08 |
| WIN-10 | P1 | 개발자 통합 패키지 | READY | 기존 consumer client 재사용, install 가능한 typed SDK, 예제·오류 계약·외부 개발자 재현. 새 체인 universal 지원 주장 금지 |
| WIN-11 | P1 | RWA 청약·상환 UX | READY | 원금/수익률 mock 표기, 전송·청약·상환 gate와 적법한 recovery 구분; compliance block이 재산권 소멸을 뜻하지 않음 |
| WIN-12 | P1 | 기관 AML 운영 확장 | GATED | PEP/미디어/KYT 벤더 coverage·case review·재심사 SLA·감사 export. 실제 데이터 계약과 평가 필요 |
| WIN-13 | P1 | 다중 issuer 독립성 | READY | T-06 세 실패를 해결한 issuer-scoped mark/tombstone/cursor/roster/policy migration. 단일 issuer preflight를 온체인 격리로 부르지 않음 |
| WIN-14 | P2 | Travel Rule 상호운용 | GATED | 상대 VASP discovery, 암호화 전달·수신확인·관할별 적용·보존 정책; 폼+hash 저장만으로 완료 금지 |

우선 WIN-01/04/05를 독립 구현하고 WIN-06에서 실제 결과를 확인한다. 그 결과 없이 WIN-02/07을 급히 이어 붙이지 않는다. 최종적으로 차별성을 만드는 것은 WIN-02→03→07→08의 연결된 흐름이며, 첫 병렬 라운드가 전체 제품 완료는 아니다.

## 4. 인증과 AML 설계

### 실제 인증

서버가 wallet/flow/environment에 binding된 외부 ID를 만들고 짧은 SDK token을 발급한다. 사용자는 벤더 hosted SDK에서 원문을 제출한다. 브라우저 콜백은 진행 표시일 뿐, 자격 발급 권한이 없다. 서버는 서명된 webhook을 검증하고 현재 applicant/review 정보를 다시 가져온다. 클라이언트가 applicant ID나 approved boolean을 골라 보낼 수 없어야 한다.

provider 상태와 Proofmark eligibility를 분리한다. `completed/GREEN`은 configured level의 결과이지 문서 진위·얼굴·liveness·제재가 모두 실행됐다는 증거가 아니다. level 구성과 개별 검사 evidence를 인증하고 허용된 identity policy에 매핑한다. document country와 거주지·국적도 서로 대체하지 않는다.

실패 기준: webhook signature 미존재/변조/알고리즘 불일치, 다른 환경, 다른 flow/subject, 만료 token, review 진행 중, 정보 불충분, provider 장애, 이전 승인 후 reject. 외부 장애를 sandbox 성공으로 fallback하지 않는다.

### AML을 “다 한다”는 주장을 분해하기

| 영역 | 현재 활용할 것 | 추가해야 할 것 | 성공으로 오인하면 안 되는 것 |
|---|---|---|---|
| Sanctions | OFAC/UN/EU 파서·엔진·snapshot provenance | provider 검증 신원과 연결, 오탐 case, 최신성 SLA | 이름 하나의 hit만으로 확정 범죄 판단 |
| PEP | method bit와 evidence 구조 | licensed source·related person coverage·EDD review | PEP면 자동 제재/불법이라는 판단 |
| Adverse media | 구분된 검사 상태 | 출처·시점·신뢰도·동명이인 review | 검색 결과 존재를 법적 확정 사실로 취급 |
| Wallet/KYT | 제재 주소 exact match | 거래노출 분석 벤더·기간/체인 coverage·threshold | exact wallet match를 exposure analysis로 부르기 |
| Ongoing monitoring | rescreen·case·outbox·fresh roster | provider webhook/current read와 통합, 장애 시 freshness 제한 | 한번 GREEN이면 무기한 승인 |
| Audit/Travel Rule | encrypted vault·audit export | 적용 판단·counterparty exchange·receipt | 원문 onchain, 또는 hash만으로 의무 완료 |

중요한 경계는 `approved → review/rejected/expired` 시 기존 credential을 계속 소비할 수 없게 하는 것이다. async relay 동안 “즉시 전 체인 취소”는 불가능하므로 정책의 최대 freshness와 실제 전파시간을 공개한다. 임시 REVIEW, 일반 revoke, 영구 denial, 정정 절차를 구분한다.

규제 해석은 구현 가이드가 아니라 관할·기관별 검토 사항이다. [FATF virtual assets](https://www.fatf-gafi.org/en/topics/virtual-assets.html), [Sumsub AML screening](https://docs.sumsub.com/docs/aml-screening), [verification webhooks](https://docs.sumsub.com/docs/user-verification-webhooks)를 출발점으로 적용 범위를 확인한다.

## 5. ZK: 무엇을 숨기고 무엇을 믿는가

**원문을 ZK로 바꿔 올리는 것이 아니라, 승인된 원문에서 도출한 조건이 참임을 증명한다.**

| 위치 | 데이터 | 신뢰/프라이버시 한계 |
|---|---|---|
| provider / encrypted vault | 문서·실사 결과·AML case | 적법한 접근·보존·삭제, provider 자체는 원문을 봄 |
| holder private witness | credential opening, salt/secret, membership path | holder 보관·복구·탈취 대응 필요 |
| source / CC state | 승인 credential root, epoch, expiry, policy version | root publisher가 검사 진실을 책임짐; chain proof는 출처를 인증 |
| consumer transaction | proof + root/epoch/policy/holder/app/deadline/nullifier | 지갑과 시점은 공개·연결 가능; 익명/완전 비연결 주장 금지 |

첫 slice는 승인 leaf membership과 country/age 조건이다. AML 텍스트 분석이나 제재 목록 fuzzy matching을 전부 회로에 넣지 않는다. 이후 검증된 검사 bit/status/시점에 대한 predicate를 추가한다. “ZK KYC/AML 완료”가 아닌 **local eligibility proof prototype**이 최초 합격 표현이다.

회로 외부에서도 verifier code 존재, 허용 verifier, field 범위, 현재 root/epoch, root freshness, holder와 caller, application/chain, proof deadline, nullifier reuse를 검사한다. private witness의 holder secret을 issuer-approved leaf와 묶지 않으면 타인의 credential을 가져다 쓸 수 있다. root fixture가 manager 권한으로 삽입됐다면 Attestcoin으로 인증됐다고 말하지 않는다.

테스트용 proving setup은 production 보안 setup이 아니다. trusted setup·키 생성 출처·회로 감사·proof 생성 시간/크기·가스·CC3 verifier 호환성을 별도로 평가한다. proof 한 번 통과 후 무기한 allow cache를 두지 않는다. 각 자산 동작에서 현재 epoch를 확인한다.

## 6. 심사 데모와 제출 서사

첫 60초: `/demo`에서 합성 sanctions 훈련과 실제 onchain policy 결과를 구분해서 보고, 한 credential이 production/sandbox에서 왜 다르게 판정되는지 이해한다. API가 unavailable이면 빨간 오류와 다음 행동을 보여준다. 증거 없는 PASS 카드로 대체하지 않는다.

2분 발표안:

1. 0–20초: “검증을 재사용하되, 자산의 규칙은 재사용하지 않습니다.” 지갑 없는 데모 진입.
2. 20–50초: 한 credential·두 policy·거부 이유. real/sandbox 경계 표시.
3. 50–80초: 취소나 오래된 screening 때문에 자산 gate가 거부하는 검증된 시퀀스. 편집 시 실제 전파시간 명시.
4. 80–105초: 현재 구현 범위에 맞는 provider flow와 실제 local ZK proof. provider 미설정이면 녹화 합성 fixture/개발 상태를 그대로 표시.
5. 105–120초: 소비자 통합과 다음 milestone. 기관 고객·자산 AUM·규제 승인·수상 확률을 만들어내지 않음.

경쟁사의 보안 결함이나 팀을 공개 서사의 중심으로 삼지 않는다. 우리의 부정 사례 테스트와 사용자 경험으로 차이를 입증한다. 기존 제출 마감은 저장소의 계획 기록이며, 제출 직전에 공식 페이지의 최신 마감·시간대를 다시 확인한다.

## 7. 통합 검증 장부

아래는 이번 라운드에서 실제 실행한 결과만 기록한다. 과거 118/593 같은 숫자를 새 코드의 통과 증거로 재사용하지 않는다.

| 검증 | 결과 | 범위/제약 |
|---|---|---|
| Provider unit / HTTP negative cases | `npm run test:providers` 7/7, `npm run test:providers-redis` 4/4 | 실제 signed HTTP client + 격리 Redis Lua/CAS/재시도 테스트. 실제 vendor 계정과 고객 심사 완료 증거 아님 |
| ZK generation + Solidity verifier | `npm run test:zk` 통과: 새 proof/검증기 실행, 회로 부정 사례 4개, gate 15/15 | local setup/root fixture; CC3 미배포. [재현 방법](../zk/README.md), [남은 low advisory 15개](../zk/SECURITY.md) |
| Judge UX lint/build/API states | 웹 lint/build 통과(20 routes), API 74/74, judge unit 3/3, production browser fixture 1/1, 기존 onchain·synthetic·training UI 각 1/1 | 데모 실패/잘못된 응답/두 정책/모바일, provider consent·SDK·계정 변경. 새 UI의 API 응답과 SDK는 interception fixture. Training UI는 실제 built 교육용 API/AML 엔진 실행 |
| Root typecheck / regression | 최종 typecheck 통과, Solidity 133/133, TS 591/591 | 실패/skip 0. 새로운 provider 단위 테스트 포함; 전체 browser 발급 E2E와는 별도 |
| Real provider→AML→source→CC→asset | 미완료 | 환경·schema·relay·새 배포 연결 필요 |
| 기존 전체 synthetic issuance browser/API/Redis/두-EVM E2E | 첫 실행 약 112초, 독립 재현 약 102초 후 file-level 실패. isolation 해제 재현도 약 93초 후 exit 1 | 명명된 assertion 없이 프로세스 종료; 명시된 120초 timeout 미도달. 환경/harness 가능성은 있으나 원인·실패 단계 미확정. 전체 발급 E2E 통과를 주장하지 않음 |
| Production readiness / external audit | 미확인 | 해커톤 코드 구현으로 자동 충족되지 않음 |

이번 통합에서 기존 스크리닝 홈의 미커밋 변경은 `/screening`으로 그대로 보존했다. 새 landing/demo/provider와 KR `/verify`, `/onchain`을 메뉴에서 구분한다. `SANCTIONS_TRAINING_ENABLED=1`은 실 provider 환경에서도 고정 합성 학습만 허용하며, demo 발급을 켜지 않는다. 네이티브 provider 상태, 교육용 screening, onchain 자격은 서로 다른 데이터다.

기존 synthetic/training browser 테스트에서 `/verify` 렌더링 실패를 발견했다. 두 테스트의 status fixture에 기존 화면이 요구하는 `processingPolicy`가 없었던 것이 원인이다. 실제 status API와 인증 보호 조건은 바꾸지 않고 합성 fixture 스키마만 보완해 각각 재통과했다. 전체 issuance E2E는 실제 status API를 쓰므로 이 수정으로 해결됐다고 간주하지 않는다.

CI에는 실제 ZK 재생성/검증과 Redis provider CAS, production browser 테스트를 추가했다. source-bound evidence 수집은 중첩 provider 테스트와 `.circom` 소스를 포함한다. 로컬 실행 기록은 외부 CI/push/배포/심사 제출을 대신하지 않는다.

### 다음 실행 순서

1. **WIN-06-R1:** 기존 전체 issuance E2E 실패 원인 확인과 재현. 신선도/시간 제한/브라우저·Redis·두 체인 중 어느 단계인지 증거를 확보하고, 테스트를 끄거나 단순 fixture로 바꾸지 않는다.
2. **WIN-02:** 실제 Sumsub sandbox 계정과 승인된 처리 정책으로 hosted session을 검증하고, 인증된 step 결과를 mapping. 원문과 verified fields만 기존 AML에 전달; 성공한 검사 bit만 발급.
3. **WIN-03/07:** provider negative event→durable revoke outbox→현재 root→Attestcoin→CC→자산 거부를 하나의 연결된 로컬 테스트로 만든다. 소스 provenance와 신원 진실의 차이는 유지한다.
4. **WIN-08/09:** 정확한 새 testnet 릴리스·역할·배포 범위를 승인받아 배포하고, 측정한 결과만 영상/제출 문서에 반영한다.

## 8. 공식 구현 참고

- [Sumsub WebSDK](https://docs.sumsub.com/docs/get-started-with-web-sdk): hosted verification UX. 승인 권한은 서버에 둔다.
- [Sumsub webhooks](https://docs.sumsub.com/docs/webhooks): 알림의 인증과 재전송 처리. 현재 상태 재조회와 별개다.
- [Privado circuits](https://docs.privado.id/docs/verifier/circuits/): 향후 credential circuit 선택의 참고. 이 제품에 이미 통합됐다는 뜻은 아니다.
- [ERC-3643](https://eips.ethereum.org/EIPS/eip-3643): 향후 자산 lifecycle 통합의 참고. 현재 KPCN의 표준 준수 선언이 아니다.
