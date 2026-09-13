# T-47 — 실행 가능한 파일럿 원가 모델

2026-09-07 · **IN_PROGRESS / 합성 계산만 검증**. 가격 추천·실제 견적·매출 전망·투자 승인 자료가 아니다. 기관 견적, 재사용 권리, 고객의 지불 의사, 실제 운영 시간은 아직 확보되지 않았다. 아래 숫자는 모두 계산기의 경계와 민감도를 확인하기 위한 입력이다.

## 하나의 과금 가설과 실행 방법

우선 계산 단위를 **청구 가능한 활성 지갑/월** 하나로 한정했다. 이는 확정 가격 정책이 아니다. 기관 고객 수는 `payingInstitutions`라는 별도 입력이고, 100/1,000/10,000은 기관 고객이나 매출 발생 실적이 아니라 **전체 활성 지갑 수**다. 같은 지갑을 여러 앱이 사용해도 자동으로 이중 과금하지 않는다. 실제 계약의 distinct wallet 정의·비활성/차단 계정 청구·재사용 요금은 T-44 인터뷰에서 확인해야 한다.

```sh
npm run economics -- docs/economics/synthetic-scenarios.json
npx tsx --test pipeline/unit-economics.test.ts
```

명령은 JSON 결과를 stdout에 출력하며 파일·계약·외부 서비스 상태를 변경하지 않는다. 예제는 `basis: synthetic`이다. 실제 입력을 수집한 후에도 `unverified-inputs`로만 표시할 수 있으며, 계산기는 증빙을 독립 검증하지 않으므로 `commercialEvidenceVerified: false`, `investmentDecision: not evaluated`를 항상 출력한다. 승인된 견적이 있다는 사실 자체도 계산기의 Boolean만 바꿔 증명할 수 없다.

base/downside의 모든 입력이 필수다. 누락·문자열 가격·NaN·음수·알 수 없는 필드는 거부한다. 조사/지원 시간당 단가는 0을 허용하지 않는다. 다른 비용의 0은 무료로 확인됐다는 뜻이 아니라 입력자의 명시적 가정이다. 증거 없는 0을 상용 모델에 승인하면 안 된다. 금융 원장이 아닌 부동소수점 계획 계산이며 세금·회계 인식·환율을 자동 적용하지 않는다.

## 산식과 비용 경계

| 입력 묶음 | 계산/포함 범위 | 반드시 확보할 교정 자료 |
|---|---|---|
| `pricePerBillableWalletUsd`, `billableWalletFraction`, `payingInstitutions` | 월 반복 매출 = 활성 지갑 × 청구 비율 × 단가. 기관 수는 지원 시간 계산에만 사용 | 고객 가격 피드백, 청구 대상/중복 제거/최소 약정 정의, 계약 기간·할인·세금 |
| `issuancesPerWallet`, `idCallsPerIssuance`, `bankCallsPerIssuance` | 최초/갱신 발급 빈도와 발급당 유료 API 시도 수. 실패·재시도 비용을 성공 횟수와 분리 가능 | 기관별 실제 billable event, 실패/timeout 청구, 원본 재사용 허용·요율 |
| `rescreensPerWallet`, `screeningCallUsd`, 각 `*MinimumUsd` | screening = 발급 + 재심사. ID/bank/screening 각각 `max(월 최소금액, 호출 수 × 단가)` | 동일 통화·유효기간의 견적, minimum이 usage에 상계되는지 별도 고정비인지, 초과/계층 요금 |
| 양 체인 `*WriteUsd`, `*BatchSize`, `witnessWritesPerWallet`, `epochPublicationsPerMonth` | source/hub 발급·철회 batch를 각각 올림, epoch 고정 쓰기, hub witness 쓰기를 별도 청구. 무료 읽기를 쓰기나 토큰 소각으로 세지 않음 | 실제 receipt의 gasUsed·effectiveGasPrice, 통화 전환 시점, 재시도/실패 거래 비용·proof 청구 기준 |
| `proofServicePerReceiptUsd` | source 발급/철회/epoch receipt 수 × 단가 | provider 실제 과금 단위·견적. ATC 소각량이나 공식 수수료가 아님 |
| `issuanceReviewFraction`, `rescreenReviewFraction`, `reviewMinutes`, `investigatorHourlyUsd` | 각 검사군의 review 수 × 조사 시간 × 시간당 원가 | 별도 라벨된 실제 발생률·중복 조사 제거·재심/appeal 시간·부대 인건비·고용 가능 인원 |
| `supportMinutesPerInstitution`, `supportContactsPerWallet`, `supportMinutesPerContact`, `supportHourlyUsd` | 기관당 고정 지원 + 지갑 규모에 따른 지원 시간 | 티켓 로그, 온보딩/장애 대응의 실제 투입, SLA 대기 인력 비용 |
| `retainedRecordsPerWallet`, `megabytesPerRetainedRecord`, `storageCopies`, storage/KMS 단가 | 과거·탈퇴 고객을 포함한 보관 record 비율, 복제본 포함 GB(1 GB=1,000 MB), record당 월 KMS 연산 | 승인 보존 정책, 전체 journal/vault/outbox/export/backup 실측 크기·KMS 청구·지역·복원 비용 |
| `infrastructureUsd`, `engineeringAndAdminUsd`, `complianceAndInsuranceUsd` | infra는 서비스 원가, 개발/관리·준법/보험은 운영비로 분리 | hosting/monitoring/egress, 실제 팀 투입과 fully loaded 급여, 법무·보험의 유효 견적 |
| `oneTimePilotCostsUsd`, `openingCashUsd`, `financingCashUsd` | 일회성 지출·기초 현금·외부 조달 현금. 조달액은 고객 매출이나 매출총이익에 포함하지 않음 | 감사/통합비 견적, 은행 잔액, 실제 서명/지급 일정. 합성 $100k는 선정/입금 증거가 아님 |

각 vendor minimum은 **하나의 공유 사용량 계약**을 가정한다. 기관별 별도 minimum이 있으면 전체 최소금액과 사용량을 단순 합산해 `max`를 한 번 적용해서는 안 된다. 기관별 모델을 따로 계산해 합산하거나 실제 계약별 tier를 구현해야 한다. 서로 다른 vendor/기관 사이의 pooling이나 재배포 권한은 현재 증명되지 않았다. 선불 credit, per-request minimum, 무료 구간, 계층 할인, 실패 건 별도 과금도 이 선형 요율 모델의 검증 범위 밖이다.

현재 예제의 issuance/revoke batch size는 모두 1이다. batch size를 크게 입력한다고 실제 pipeline이 그 batch를 구현하거나 그 비용을 달성한 것이 되지 않는다. 거래 수 상한·오류 재전송·활성 지갑의 실제 witness 갱신 빈도·source archive 재생비 등은 실측 후 해당 입력/추가 모델에 반영해야 한다. testnet의 무료 gas를 상용 gas로 사용하지 않았다. 제시한 gas USD 숫자도 실측값이 아닌 합성 가정이다.

## 합성 실행 결과 — 고객 실적이나 목표 가격이 아님

아래는 동봉 JSON을 실행한 값이며 USD/월, 표시만 소수점 둘째 자리로 반올림했다. 서비스 원가에는 기관/API·양 체인·proof·조사·지원·보관/KMS·infra가 포함된다. 영업손익에는 개발/관리·준법/보험까지 차감하며 일회성 파일럿 비용은 별도 현금흐름에 반영한다.

| 합성 case | 활성 지갑 | 반복 매출 | 서비스 원가 | 영업손익 |
|---|---:|---:|---:|---:|
| base | 100 | 760.00 | 1,899.36 | -15,139.36 |
| base | 1,000 | 7,600.00 | 2,550.93 | -8,950.93 |
| base | 10,000 | 76,000.00 | 14,514.63 | 47,485.37 |
| downside | 100 | 350.00 | 7,557.86 | -28,207.86 |
| downside | 1,000 | 3,500.00 | 32,299.60 | -49,799.60 |
| downside | 10,000 | 35,000.00 | 299,902.00 | -285,902.00 |

고정한 입력에서 base의 최초 영업손익 비음수 지점은 2,402 지갑이다. downside는 0~100,000 지갑의 전수 검색에서 찾지 못했다. **실제 손익분기 고객 수로 인용하지 않는다.** 이 계산은 기관 수·단가·인건비·보관 비율을 고정하며 규모에 따른 추가 채용/infra step-up을 추정하지 않는다. batch 올림 때문에 손익이 항상 단조 증가하지 않으므로 binary search가 아닌 제한된 전수 검색을 사용한다. 최초 비음수 지점 이후 모두 흑자라는 보장은 없다.

1,000 지갑에서 한 번에 변수군 하나만 바꾼 영업손익 변화:

| 합성 충격 | base 변화 | downside 변화 |
|---|---:|---:|
| 발급·재심사 review 비율 ×2 (최대 100%) | -400.00 | -19,800.00 |
| 양 체인 쓰기 gas 단가 ×10 | -819.00 | -30,690.00 |
| 발급 빈도 ×2 | -133.00 | -4,545.00 |

downside의 조사율·시간 가정에서는 거래량 증가가 손실을 키운다. 이를 고객 수 증가로 해결된다고 해석하면 안 된다. 실제 반복 조사량·오탐/appeal 비용을 확보해야 어떤 제품·과금 변경이 필요한지 판단할 수 있다.

## 12주 현금 점검의 한계

12주를 3개월로 반올림하지 않고 `12 × 12 / 52`개월의 고정 run rate로 계산한다. 기초 현금 + 시작 시 조달 현금 + 기간 영업현금 - 일회성 비용을 출력한다. 조달 현금은 한 번만 더한다. 합성 1,000 지갑에서는 base 종료 현금 $50,212.80, downside 부족 현금 $67,906.58이다. 이 숫자는 처음부터 합성 $100k 전액을 사용할 수 있고 매출/지출이 즉시 현금화된다는 가정이다.

실제 $25k/$35k/$40k의 분할 지급·조건부 승인·지급 지연·매출 채권·선결제 vendor 약정·세금·환율·고객 이탈은 모델링하지 않았다. T-51의 지급 심사에는 별도 주간 cash schedule과 확정/미확정 자금 구분이 필요하다. 이 계산으로 자금 충분성이나 지급 결정을 승인하지 않는다.

## 실제 데이터로 바꾸는 승인 절차

1. [discovery kit](18-design-partner-discovery.md)에서 첫 기관의 gated action·관할·최대 철회 지연·책임 주체를 합의한다. 이 합의 전에는 ‘활성 지갑/월’을 구매자가 수용한 모델로 부르지 않는다.
2. 위 표의 각 입력 묶음마다 증빙 ID, 발행자/견적일·만료일, 서비스 환경, 단위·통화·세금·최소 약정·적용 고객 범위를 기록한다. 공개 가능한 요약과 접근 통제된 원문을 분리한다. 이 저장소에 개인 문서·계약 비밀을 넣지 않는다.
3. 신규/갱신/거절/재시도·재심사·철회·witness의 실제 건수와 청구 내역을 동일 기간으로 대조한다. 단위가 다른 증거를 섞지 않는다. 합성 AML clean 표본의 hold 0을 실제 수동 조사율 0으로 가져오지 않는다.
4. 고객 가격 피드백과 provider 견적을 base/downside에 각각 연결하고 불확실 항목을 표시한다. minimum·tier 계약이 현 모델과 다르면 식부터 수정한다. 낮은 단가나 재사용률을 성립한다고 가정해 결과만 맞추지 않는다.
5. 실제 책임자·재무/준법 검토자·검토일을 받아 T-47에 증거를 연결한다. 명목 금액이 입력되거나 계산기가 통과한 것만으로 티켓을 완료하지 않는다.

이번 작업은 계산기·합성 fixture·부정/산술/실제 CLI 테스트 9개를 추가했다. 기관 견적 요청, 고객 접촉, 계약·투자·외부 전송은 실행하지 않았다. T-47은 외부 견적/가격 피드백이 없는 `IN_PROGRESS` 상태다.
