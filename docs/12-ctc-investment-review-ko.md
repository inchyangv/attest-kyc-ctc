# Proofmark CTC 생태계·해커톤·투자 실사 보고서

> 기준일: 2026-09-02<br>
> 관점: Creditcoin 생태계 BD, 해커톤 심사, 초기 투자 검토<br>
> 결론: **75/100 — 해커톤 수상권, USD 100,000 규모의 조건부 마일스톤 파일럿 투자 추천**<br>
> 주의: 본 문서는 제품·기술·사업 실사 의견이며 법률 자문이나 규제 적합성 인증이 아니다.

## 1. Executive summary

Proofmark는 외부 KYC/AML 결과를 Creditcoin에서 재사용하고, 각 애플리케이션이 자신의 동결된 정책으로 그 결과를 판정하도록 만드는 컴플라이언스 게이트웨이다.

이 프로젝트를 “한국형 KYC 제공사”로 보면 투자 매력은 낮다. 현재 독립된 규제 사업자 계약, 유료 고객, 라이선스 데이터, 외부 보안감사가 없기 때문이다. 반대로 다음과 같이 정의하면 Creditcoin 생태계 적합성이 높다.

> 기존 credential issuer가 확인한 사실을 Attestcoin으로 증명해 Creditcoin에 전달하고, RWA·대출·스테이블코인별 정책을 온체인에서 일관되게 집행하는 인프라

현재 제품은 단순 UI 목업을 넘어 다음을 실제로 증명했다.

- Sepolia 발급 이벤트를 Attestcoin 경로로 검증해 Creditcoin CC3에 materialize했다.
- 동결된 sandbox policy를 통과한 주소끼리만 `KPCN`을 전송했다.
- 미발급 주소 전송은 `RecipientNotVerified`로 거절했다.
- 정책 regime이 다른 production policy는 같은 mark를 거절했다.
- Epoch roster의 inclusion과 non-inclusion을 모두 실제 컨트랙트 호출로 확인했다.
- 공개 웹, 공개 저장소, 재현 가능한 CI, 투자 메모와 피치덱을 제공한다.

따라서 해커톤에서는 **실제 체인 통합, 보안 깊이, 데모 완결성 측면의 수상권 프로젝트**로 본다. 투자에서는 기술 리스크보다 상업·운영 리스크가 더 크므로 전체 로드맵을 한 번에 투자하지 않고 12주 동안 외부 credential과 실제 구매자를 검증해야 한다.

## 2. 최종 평가

### 2.1 투자 점수

| 평가 항목 | 배점 | 점수 | 판단 |
|---|---:|---:|---|
| Creditcoin·Attestcoin 필연성 | 20 | 19 | source transaction을 BlockProver로 검증하므로 별도 운영자 oracle을 신뢰할 필요가 없다 |
| 기술 완성도 | 20 | 18 | 컨트랙트, worker, 정책 게이트 자산, roster, 웹과 테스트넷 실증이 연결되어 있다 |
| 보안·정확성 | 20 | 16 | 순서·재생·제재 우선순위·정책 freeze·non-inclusion 공격을 방어한다. 외부 감사는 아직 없다 |
| 제품 명확성 | 15 | 12 | Verify → Prove → Enforce 흐름은 명확하다. 공개 데모가 sandbox라는 설명이 반드시 필요하다 |
| GTM 증거 | 15 | 5 | 구매자와 가격 가설은 있으나 LOI, 유료 파일럿, 매출이 없다 |
| 규제·운영 준비도 | 10 | 5 | 동의·보관·삭제·재심사 구조는 있으나 managed 운영과 법률 검토가 없다 |
| **합계** | **100** | **75** | **좁고 단계적인 파일럿 투자 추천** |

### 2.2 해커톤 심사 의견

**Shortlist 통과 및 수상 후보로 추천한다.** 다음 세 가지가 일반적인 해커톤 제출물과 구별된다.

1. Creditcoin을 단순 배포 네트워크로 쓰지 않고 Attestcoin의 source-proof 성질을 제품 핵심에 사용한다.
2. 성공 화면만 보여주는 것이 아니라 잘못된 정책, 미발급 수신자, stale state와 위조 non-inclusion이 실패하는 경로를 증명한다.
3. 실제 테스트넷 거래, 자산 전송, epoch 운영, 공개 웹과 재현 CI가 하나의 제출물로 연결된다.

다만 “규제 대응 제품이 이미 production-ready”라는 주장은 인정하면 안 된다. 현재 공개 플로우는 demo adapter가 만든 `regime = 2` sandbox mark이며 production policy #1은 이를 의도적으로 거절한다.

## 3. 제품 정의와 생태계 적합성

### 3.1 해결하는 문제

credential provider는 “무엇을 확인했는가”를 답한다. 그러나 Creditcoin 애플리케이션은 다시 다음을 판단해야 한다.

- 이 issuer를 신뢰하는가?
- 이 자산이 요구하는 검사 항목을 모두 수행했는가?
- production 결과인가, sandbox 결과인가?
- 관할국, 보증 수준, 발급 후 경과 시간이 정책과 맞는가?
- 제재 또는 revocation 이후에도 유효한가?
- 현재 roster에 포함되어 있는가?

Proofmark는 credential 발급 자체보다 이 **정규화·증명·정책 집행 계층**을 소유한다.

```text
외부 credential issuer
  ├─ KR reference issuer — 구현됨
  ├─ Sumsub / CCID adapter — 목표
  ├─ zkMe adapter — 목표
  └─ 규제 기관·금융사 adapter — 목표
          ↓
method + assurance + regime + jurisdiction + issuer 정규화
          ↓
Ethereum source event → Attestcoin proof → Creditcoin ASC
          ↓
frozen application policy
          ↓
RWA / lending / stablecoin mint·transfer gate
```

온체인 조회는 무료·permissionless로 두고, issuer SLA, 발급·재심사, evidence vault, adapter, 정책 운영에서 과금하는 편이 타당하다. 이는 [Attestcoin의 공개 read model](https://attestcoin.org/)과도 자연스럽게 맞는다.

### 3.2 경쟁 포지션

| 대안 | 강점 | Proofmark가 이길 수 있는 지점 | Proofmark의 현재 열위 |
|---|---|---|---|
| [Sumsub + Chainlink CCID/ACE](https://sumsub.com/newsroom/sumsub-partners-with-chainlink-to-power-cross-chain-identity-for-on-chain-compliance/) | 글로벌 검증 운영, enterprise distribution, reusable credential | Creditcoin·Attestcoin native provenance, 자산별 frozen policy와 roster semantics | 실제 vendor coverage, 고객, production credential |
| [zkMe zkKYC](https://www.zk.me/credentials/zkkyc/) | ZK credential, 선택적 공개, 다수 속성 제품 | Creditcoin source transaction 증명과 구체적인 자산 집행 경로 | ZK privacy, 지원 국가, adoption |
| 직접 KYC·은행 연동 | 권위 있는 원천 확인과 기존 계약 관계 | 여러 Creditcoin 앱이 하나의 정규화 계층을 재사용 | Proofmark도 결국 이 연동과 허가가 필요하다 |
| 앱별 allowlist | 단순하고 빠르다 | portability, freshness, issuer·regime, 취소와 감사성 | 작은 단일 앱에서는 복잡도가 더 높다 |

방어력은 method bitmap 자체에 있지 않다. 장기적으로는 **issuer normalization + proven provenance + policy semantics + lifecycle operations + Creditcoin app integration**의 결합이 moat가 되어야 한다.

## 4. 기술 실사

### 4.1 실제 배포

배포 source of truth는 [`deployments/cc3-testnet.json`](../deployments/cc3-testnet.json)이다.

| 컴포넌트 | 네트워크 | 주소 |
|---|---|---|
| `EvmV1Decoder` | Creditcoin CC3 | `0x5eE29aB8845A2AD4BBE1e01c5BD3bCc3AEee47Fd` |
| `ProofmarkASC` | Creditcoin CC3 | `0x3C6Fe016645CA52952E29C66E435bDa7F611b242` |
| `ProofmarkRegistry` | Creditcoin CC3 | `0x2F4E5e1270f90E51251651caf08547393e3C0572` |
| `ComplianceSource` | Ethereum Sepolia | `0xA9A34586303b9fD92e090F9bb1D332DC854c72B9` |
| `GatedRwaNote` (`KPCN`) | Creditcoin CC3 | `0xa74aB3De359a55A729f9185Fe4Afe90526E585CA` |

### 4.2 실제 cross-chain·asset-gate 증거

- [Sepolia 발급 트랜잭션](https://sepolia.etherscan.io/tx/0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1)에서 두 sandbox mark를 발행했다.
- worker가 proof를 제출한 [CC3 materialization 트랜잭션](https://creditcoin-testnet.blockscout.com/tx/0x50c30b315f74150fecf56b670a5d6c9cf7dc0bc76c815809dbc6af899de567d8)은 성공했다.
- 검증된 A에게 100 `KPCN`을 mint한 뒤 [검증된 B에게 40 `KPCN`을 전송](https://creditcoin-testnet.blockscout.com/tx/0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d)했다.
- 미발급 control address에 대한 전송 simulation은 `RecipientNotVerified` selector `0x17887111`로 revert했다.
- Epoch 1은 [Sepolia에 게시](https://sepolia.etherscan.io/tx/0x2adefae22bd29e7fc43b9f9161f6c722cc2deb4eae6bc720aca5a2b65e7816df)된 후 [CC3에서 수락](https://creditcoin-testnet.blockscout.com/tx/0xb011cd6e5a590b924858262cdfc832a6ef0d71cc4b78c3ac61efaf3d0c2f532f)됐다.
- source와 destination block timestamp 기준 propagation은 8분 00초였다.
- sandbox policy #2 membership은 `true`, production policy #1은 `false`, 미발급 주소 non-membership은 `true`였다.

Epoch root, 입력 mark, 유효기간과 판정 결과는 [`deployments/epoch-1.json`](../deployments/epoch-1.json)에 재현 가능한 형태로 남아 있다.

### 4.3 핵심 보안 속성

| 위험 | 적용된 방어 |
|---|---|
| 잘못된 source·emitter | source chain key와 source contract를 1회 설정하고 변경을 금지 |
| proof replay | query ID와 source request ID를 영구 소비 |
| 같은 블록 내 순서 역전 | `(source block height, transaction index)` cursor 사용 |
| 오래된 issuance의 부활 | subject별 source cursor보다 오래된 상태 적용 거부 |
| sanctions denial downgrade | 일반 issuance·revoke가 sanctions denial을 제거하지 못함 |
| 정상 revocation 후 복구 불가 | sanctions가 아닌 revoke는 더 새로운 full issuance만 재활성화 가능 |
| 정책 rug | production consumer가 frozen policy에만 bind 가능 |
| 잘못된 regime·관할·issuer | policy가 regime, jurisdiction, trusted issuer를 명시적으로 검사 |
| roster gap 위조 | boundary key와 mark를 함께 다시 hash하고 adjacency를 검증 |
| 미검증 주소로 recovery | `forceTransfer`도 verified recipient만 허용 |
| worker 재시작·실패 유실 | atomic store와 pending retry scheduling 적용 |

외부 감사 전까지 이를 production 자금 보호 보증으로 해석해서는 안 된다. 현재 같은 테스트넷 키가 deployer, issuer와 여러 운영 역할을 겸한다. production에서는 deployer, issuer, policy owner, epoch publisher, worker payer, asset recovery 역할을 managed key 또는 multisig로 분리해야 한다.

## 5. AML·개인정보·운영 실사

### 5.1 AML 데이터와 측정치

공식 OFAC, UN, EU 원본 26,566개 엔트리와 78,365개 이름을 사용한다. EU Commission은 consolidated financial sanctions list를 유지하며 해당 데이터셋의 갱신 주기를 daily로 명시한다. 출처와 공개 설명은 [EU Data Portal](https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en)에서 확인할 수 있다.

현재 회귀 평가 결과:

| 항목 | 결과 |
|---|---:|
| listed-person recall | 200/200 |
| clean-name specificity | 610/610, 오탐 0 |
| invisible character·homoglyph·diacritic 등 우회형 | 7/7 차단 |
| 공식 목록의 Ethereum wallet | 차단 |

이는 규제 인증이 아니라 engineering regression corpus다. licensed PEP 및 adverse-media source는 아직 연결되지 않았으므로 관련 method bit도 정직하게 unset 상태다.

FATF 관할국 테이블은 2026년 6월 공식 발표를 기준으로 검증했다: [Plenary 결과](https://www.fatf-gafi.org/en/publications/Fatfgeneral/outcomes-fatf-plenary-june-2026.html), [강화 모니터링 관할국](https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/increased-monitoring-june-2026.html), [조치 요구 관할국](https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/call-for-action-june-2026.html).

### 5.2 개인정보 경계

온체인에는 다음이 남는다.

- wallet과 issuer address
- status, assurance, regime, jurisdiction, method bitmap, timestamps, epoch
- `claimsRoot`와 `evidenceHash`

성명, 생년월일, 문서번호와 계좌번호는 온체인에 기록하지 않는다. 그러나 wallet과 metadata는 linkable한 pseudonymous data이며 anonymous data가 아니다.

오프체인 pilot vault는 AES-256-GCM 암호화, keyed pseudonymization, retention purge, erasure audit event, rescreen과 manual appeal 상태를 지원한다. Vercel의 ephemeral filesystem에서는 vault를 비활성화하며, non-demo issuance는 persistent vault가 없으면 fail closed한다.

production 전에는 managed database/KMS, backup·recovery, 접근통제, data-controller 계약, 보존정책과 한국 법률 검토가 필요하다. 세부 포지션은 [`docs/08-regulatory-position.md`](08-regulatory-position.md)를 참조한다.

## 6. 제품·데모 실사

### 6.1 공개 표면

- 제품: [attest-kyc.stabled.ai](https://attest-kyc.stabled.ai)
- 온체인 상태: [attest-kyc.stabled.ai/onchain](https://attest-kyc.stabled.ai/onchain)
- 검증 흐름: [attest-kyc.stabled.ai/verify](https://attest-kyc.stabled.ai/verify)
- 공개 코드: [github.com/inchyangv/attest-kyc-ctc](https://github.com/inchyangv/attest-kyc-ctc)
- CI 증거: [GitHub Actions run 33613331190](https://github.com/inchyangv/attest-kyc-ctc/actions/runs/33613331190)

프로덕션 웹 배포는 Ready 상태이며 API function은 Seoul `icn1`에서 관측됐다. Vercel 공식 문서도 `icn1`을 Seoul 리전으로 정의한다: [Vercel regions](https://vercel.com/docs/regions).

### 6.2 공개 데모의 정직한 한계

- ID와 bank adapter는 demo이며 기관에 접속하지 않는다.
- demo 결과는 `regime = 2`만 만들 수 있다.
- production policy #1은 `regime = 1`을 요구하므로 demo mark를 통과시키지 않는다.
- production issuance는 persistent evidence vault가 없으면 진행되지 않는다.
- 공개 화면의 성공은 UX와 protocol path의 증명이지 실제 고객 KYC 완료를 의미하지 않는다.

이 구분은 단점이면서 동시에 신뢰 요소다. 해커톤 데모를 과장하기보다 실제로 수행한 검사만 method와 regime에 기록하기 때문이다.

## 7. 검증 결과

본 실사의 기술 구현 기준점은 `c12db5eaf7b7c7db1a6cd65c6dc4ad1054c3e80c`이다.

| 검증 | 결과 |
|---|---:|
| Foundry Solidity tests | 57/57 |
| TypeScript worker·pipeline·AML·vault tests | 123/123, skip 0 |
| TypeScript typecheck | 통과 |
| Web lint·production build | 통과 |
| npm production vulnerability audit | 0 |
| URL smoke test | 12/12 |
| malicious cross-origin POST | HTTP 403 |
| Git history secret scan | 통과, leak 0 |
| clean clone + recursive submodule 재현 | 통과 |
| 공개 GitHub CI | Solidity·TypeScript/AML·Web 모두 통과 |

## 8. 사업모델과 GTM

### 8.1 과금 표면

| 상품 | 과금 단위 | 구매자 |
|---|---|---|
| Issuer platform·SLA | 연 계약 | 규제 issuer, RWA 플랫폼, lender |
| Credential issuance | 완료 건당, vendor cost pass-through | issuer 또는 application |
| Continuous compliance | active wallet/month 또는 rescreen event | issuer, asset operator |
| Evidence vault·audit export | 연간 tier + storage | 의무기관 |
| Provider·jurisdiction adapter | 구축비 + 유지보수 | provider, 생태계 프로젝트 |
| Policy integration·governance | 프로젝트 비용 + support | Creditcoin application |

첫 시장은 과장된 글로벌 TAM이 아니라 다음 두 통합으로 측정해야 한다.

1. policy를 소비하는 Creditcoin RWA·lending·stablecoin 애플리케이션
2. 외부에서 credential을 공급하는 독립 issuer 또는 provider

성공 기준은 live end-to-end pilot, 서명된 운영모델, SLA 측정치와 유료 갱신 제안이다.

### 8.2 BD 우선순위

1. Creditcoin 생태계에서 mint·transfer eligibility가 필요한 한 개 애플리케이션을 design partner로 확보한다.
2. Sumsub, CCID, zkKYC 또는 규제기관 중 한 곳의 외부 credential을 adapter로 연결한다.
3. issue → propagate → consume → rescreen → revoke/reactivate 전 과정을 partner staging에서 측정한다.
4. 온체인 read는 무료로 유지하고 운영·증거·SLA 계약을 유료화한다.

## 9. 투자 제안

제안은 **USD 100,000 / 12주 마일스톤 파일럿**이다. 이는 [CEIP가 공개한 USD 25,000–500,000 투자 범위](https://creditcoin.org/Fund) 안에 있다. 이는 신청 제안이며 선정되거나 이미 조달된 자금이 아니다.

| 트랜치 | 금액 | 지급 조건 |
|---|---:|---|
| 1. Productize | $25k | managed vault/KMS 설계, 역할 분리, adapter specification, threat model, 한 개 design-partner discovery memo |
| 2. Integrate | $35k | 외부 credential adapter, 분산 API control, rescreen·appeal runbook, partner sandbox integration |
| 3. Pilot | $40k | 외부 보안검토 수정, 두 design partner 또는 한 paid pilot, SLA 측정, production launch decision |

권장 자금 사용은 engineering 55%, security review 15%, compliance·legal·vendor 15%, partner integration 10%, operations·reporting 5%다. 이 단계에서 token liquidity나 광범위한 paid marketing에 자금을 쓰는 것은 반대한다.

## 10. 투자 게이트와 kill criteria

### 트랜치 게이트

- 트랜치 2는 신뢰 가능한 외부 issuer/provider 경로와 application design partner가 문서화된 뒤 집행한다.
- 트랜치 3은 Proofmark 자체 reference issuer가 아닌 외부 credential이 실제 testnet path를 통과한 뒤 집행한다.
- production launch는 외부 contract review의 critical/high finding이 모두 해소된 뒤 승인한다.

### 중단 또는 피벗 조건

다음 중 하나가 8주차까지 성립하면 후속 투자를 중단하거나 adapter SDK·통합사업으로 피벗한다.

- 지원 비용을 제공해도 Creditcoin 애플리케이션이 통합하지 않는다.
- credential provider가 credential reuse 또는 source-event publication을 허용하지 않는다.
- 법률 검토 결과 목표 고객이 받아들일 수 없는 운영·개인정보 의무가 발생한다.
- managed evidence 운영비가 직접 vendor 연동보다 구조적으로 비싸다.
- Attestcoin propagation 또는 freshness가 선택한 자산의 위험 허용시간을 만족하지 못한다.

## 11. 최종 투자위원회 의견

Proofmark는 기술적으로 강한 Creditcoin-native infrastructure experiment다. 현재 protocol risk는 상당 부분 코드와 실증으로 줄였지만, commercial proof는 아직 없다.

따라서 올바른 투자는 이미 존재하는 traction에 프리미엄을 지불하는 투자가 아니다. **독립 credential, 실제 구매자, managed operations와 외부 review라는 네 가지 미확인 가설을 사는 제한적 투자**다.

이 가설들이 12주 안에 검증되면 Proofmark는 Creditcoin 애플리케이션마다 반복되는 KYC integration과 allowlist 운영을 공통 인프라로 흡수할 수 있다. 검증되지 않으면 기술자산은 남더라도 독립적인 compliance company로서의 후속 투자는 보류해야 한다.

## 12. Due-diligence 자료

- 제품·배포 현황: [`README.md`](../README.md)
- 영문 투자 메모: [`docs/11-investment-memo.md`](11-investment-memo.md)
- 피치덱: [`docs/deck/proofmark-deck.pdf`](deck/proofmark-deck.pdf)
- 규제·개인정보 포지션: [`docs/08-regulatory-position.md`](08-regulatory-position.md)
- ASC 보안 검토: [`docs/09-ascbase-security-findings.md`](09-ascbase-security-findings.md)
- Epoch 운영 runbook: [`docs/10-epoch-roster-runbook.md`](10-epoch-roster-runbook.md)
- 현재 배포: [`deployments/cc3-testnet.json`](../deployments/cc3-testnet.json)
- Epoch 1 증거: [`deployments/epoch-1.json`](../deployments/epoch-1.json)
