# 공급망 증거와 유지보수 경계 — T-54 / T-52, 부분 구현

2026-09-07 KST. 로컬 작업 트리 기준. 이 문서는 독립 감사, 법률 의견, 배포 승인 또는 실제 담당자 배정 기록이 아니다. T-54와 T-52는 `IN_PROGRESS`다.

## 이번에 실행한 점검

`npm run supply-chain -- --write --audit`는 root/web lockfile v3에서 CycloneDX 1.5 SBOM과 전체 개발 의존성을 포함한 npm audit 응답을 생성한다. registry URL·SHA-512 integrity·license metadata·직접 의존성 해석 결과를 확인하고, 핵심 fork/decoder/interface의 SHA-256과 forge-std commit/clean 상태를 기준 파일과 비교한다. 설치·서명·공개 거래·환경 비밀값 로드는 하지 않는다. `--write`는 새 timestamp 디렉터리만 만들며 기존 증거를 덮어쓰지 않는다. audit 실패나 조회 장애는 통과/취약점 0으로 바뀌지 않는다.

최종 로컬 실행: `2026-09-06T17:54:32.645Z`, 즉 9월 7일 02:54:32 KST. HEAD `5b39beb0292b3b34d5fa86dbfd36b0e95244f515`에 미커밋 변경이 있는 상태다. Node 24.15.0 / npm 11.12.1.

| 대상 | 이번 결과 | 해석 한계 |
|---|---|---|
| root SBOM | 구성요소 76개, dependency node 77개, license metadata 누락 0 | root 제품 자체의 LICENSE 권리를 확인한 것이 아님 |
| web SBOM | 구성요소 462개, license metadata 누락 0 | 여러 플랫폼의 optional/dev 패키지를 포함. 실제 배포 파일 수가 아님 |
| root/web npm audit | 각각 전체 의존성 알려진 취약점 0 | 조회 시점 registry 응답. 미공개 취약점·자체 코드·사용권·호환성 보증 아님 |
| fork/decoder/interface | 기준 파일의 SHA-256 4개 일치 | 현 로컬 상태를 변화 감지 기준으로 고정했을 뿐 독립 안전성 승인 아님 |
| forge-std | `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`, clean | 테스트 라이브러리이며 운영 bytecode provenance가 아님 |
| CI | checkout/setup-node/toolchain/upload-artifact full commit 고정; Node 24.15.0, Foundry v1.7.1 | Ubuntu runner image·npm 자체·toolchain 다운로드 전체의 재현 가능한 빌드를 보장하지 않음 |

생성물은 저장소 루트의 `artifacts/supply-chain/2026-09-06T17-54-32-645Z/`에 있다. 이 디렉터리는 gitignore 대상이므로 다른 checkout에는 없으며 위 명령으로 재생성한다. [로컬 report.json](../artifacts/supply-chain/2026-09-06T17-54-32-645Z/report.json)은 입력·출력 hash, tool version, 실제 audit 시각, 직접 의존성/범위·install script·검토할 license 표현식을 담는다. CI는 성공한 생성물을 `supply-chain-<commit>` artifact로 14일 보관하도록 설정했다. 이번 작업에서 CI 실행·push·artifact 공개 업로드는 하지 않았다.

고정 입력 SHA-256:

```text
package-lock.json       18a4be649c3bd1ab7a571ba43bfef27fcfce1fa4153e0cb0c2b224d605d11e77
web/package-lock.json   627746ab90c9b5dd0c0ce36e5bd4d229ef8804f21d76d4bfcc8073f79ecf3049
foundry.toml            76ab8e10237b51ec4896248d7c279daa539ba75ae492037383e41240964c67ab
.github/workflows/ci.yml 713f89347d76fec3c808732f2f5c72e195995efe348fed86c24e582cbf2e84e4
root.cdx.json           6b3ad0eff8889b39d3668a5dea247d2b1a2e9c849a105c2d9f4ab2077b8eabb9
web.cdx.json            84a4700e1699c5e62fee496aeb857dc70e5458344fc6edecec3f2d2542a0309f
```

SBOM에는 생성 시각/식별자가 있어 재실행 출력 hash는 달라질 수 있다. 이 hash들은 해당 파일의 식별자이지 서명된 공급자 증명이나 배포 bytecode와의 동일성 증명이 아니다. `--package-lock-only`는 설치된 node_modules가 아니라 lockfile을 사용한다. 별도의 runtime/container/Next 배포 추적 SBOM이 필요하다. [npm 공식 SBOM 문서](https://docs.npmjs.com/cli/commands/npm-sbom/)

## 실제 발견과 수정

기존 web lockfile에서 `@tailwindcss/oxide-wasm32-wasi@4.3.3`가 요구하는 `@emnapi/core ^1.11.1`과 `@emnapi/wasi-threads ^1.2.2`를 상위 1.10.0/1.2.1로 해석해 npm SBOM이 `ESBOMPROBLEMS`로 실패했다. audit 0과 별개의 구조 문제다.

web에서 `npm update @emnapi/core @emnapi/wasi-threads --package-lock-only --ignore-scripts`로 누락된 bundled 의존성 6개를 lockfile에 추가했다. 최상위 패키지 버전은 올리지 않았다. 해당 패키지는 부모 tarball의 integrity에 묶이므로 개별 integrity를 만들어 넣지 않았다. 이어 `npm ci --ignore-scripts`, API 24개, lint/build, Chromium 상태 화면 1개가 통과했다. WASI 실제 실행 검증은 하지 않았다.

CI action은 upstream tag가 가리키는 commit을 `git ls-remote`로 확인해 고정했다. `assertActionPins`는 현재 CI 파일의 알려진 `uses:` 표기와 승인 목록을 확인하며, 모든 YAML 문법·모든 외부 workflow를 해석하는 범용 보안 스캐너는 아니다. full SHA 고정의 취지는 이동 가능한 tag에 대한 의존을 줄이는 것이다. [GitHub 공식 보안 안내](https://docs.github.com/en/actions/reference/security/secure-use)

## fork 출처와 검토해야 할 차이

[baseline.json](supply-chain/baseline.json)의 출처는 `gluwa/attestcoin-protocol-examples` commit `2332f577c754f4e7f1289dc540889f1eff405778`의 `contracts/sol/ASCBase.sol`이다. 로컬 reference clone에서 이 파일과 LICENSE의 HEAD 대비 변경이 없음을 확인했다. 설치된 `@gluwa/usc-contracts@0.1.2`의 decoder/interface와 fork의 원본 예제는 다른 출처 항목이므로 하나의 npm 패키지 출처라고 합치지 않는다. CI에서 reference clone을 자동 확보하거나 그 파일을 재검증하는 기능은 없다. 이번 원본 비교와 기록을 기준으로 후속 검토자가 exact commit을 다시 확인해야 한다.

| 원본 대비 local `src/ASCBaseX.sol` | 검토 책임과 검증 경계 |
|---|---|
| handler의 queryId 인자를 chainKey/blockHeight/txIndex로 바꿈 | source binding·같은 블록 순서·역순 receipt 소비를 계약 회귀로 검증. upstream handler 호환 아님 |
| `_queryCoordinates`로 queryId 계산 분리 | 72-byte hash layout의 TS/Solidity 고정 벡터 유지. 주석의 동일성 주장만으로 승인하지 않음 |
| `_txIndex`에서 verifier `calculateTxIndex` 추가 호출 | 원본보다 precompile 조회가 한 번 더 있음. native 구현 변경·가스·반환 의미를 독립 검토해야 함 |
| pragma 0.8.23 → 0.8.30, local interface import | 현재 Shanghai EVM·optimizer 200 조합 사용. compiler/EVM 업그레이드는 새 bytecode·ABI·가스 및 실제 체인 지원 검증 필요 |
| verify → processedQueries → handler 흐름 유지 | handler revert의 전체 rollback과 trusted receipt 해석은 로컬 회귀로 확인. 실제 native verifier 자체의 검증 정당성 감사 아님 |

## 사용권 미확인 사항 — 자동 해결하지 않음

root README/package metadata의 MIT 표기와 달리 root `LICENSE` 파일이 없다. 권리자·법인·기여자 IP 양도 확인 없이 임의의 copyright나 license grant를 만들지 않았다.

고정 upstream commit의 [ASCBase.sol 헤더](https://github.com/gluwa/attestcoin-protocol-examples/blob/2332f577c754f4e7f1289dc540889f1eff405778/contracts/sol/ASCBase.sol)는 MIT이고, 같은 commit의 [저장소 LICENSE](https://github.com/gluwa/attestcoin-protocol-examples/blob/2332f577c754f4e7f1289dc540889f1eff405778/LICENSE)는 Apache-2.0이다. 두 표기가 존재한다는 사실만 기록한다. 어느 것이 우선인지, 이중 라이선스인지, 현재 fork의 배포 권리가 충분한지는 권리자 확인 및 법무 검토 전 미확정이다. LICENSE나 SPDX를 임의로 바꾸지 않았다.

web inventory에는 sharp/libvips 플랫폼 패키지의 LGPL-3.0-or-later 또는 복합 표현식, lightningcss·axe-core의 MPL-2.0, caniuse-lite의 CC-BY-4.0, minimatch의 BlueOak-1.0.0, argparse의 Python-2.0 등이 있다. optional/dev 표시만으로 실제 배포에서 제외됐다고 가정할 수 없다. 배포 형태별 실제 포함 파일·notice·제공해야 할 자료를 법무/릴리스 담당자가 확인해야 한다. `licenseReview` 목록에 없다는 것도 법적 승인 표시가 아니다.

saxes의 유지보수 상태는 [목록 파서 문서](31-sanctions-snapshots.md)의 잔여 위험을 유지한다. 이번 web 설치에서도 eslint 9.39.5의 지원 종료 deprecation 경고가 나왔다. 버전을 무조건 올리거나 보안 문제라고 단정하지 않고 대체/업그레이드 적합성과 담당자 지정을 남은 조건으로 기록한다.

## 지원 matrix와 변경 규칙

아래는 **현재 로컬 구현의 호환 조건**이다. 공개 계약이 이미 이 버전을 사용한다는 뜻은 아니다. upstream와 협의된 표준이나 장기 지원 약속도 아니다.

| 표면 | 현재 지원값 | 다른 버전 처리/검증 근거 |
|---|---|---|
| attrs / 정책 | attrs schema 0, policy schema 2 | reserved/kind/시간 검증, TS/Solidity negative vectors 및 ABI 대조 |
| ASC receipt | TRANSACTION_PROCESSING_VERSION 2 | worker 시작 guard; 구 ASC 자동 fallback 없음 |
| Merkle roster | ROSTER_FORMAT_VERSION 2 | leaf/node/root domain·count 결합. v1 proof 재해석 금지 |
| epoch | EPOCH_SCHEMA_VERSION 2 | cutoff/publishedAt/snapshotId 필수. v1 record·장기 과거 root 거부 |
| issuer root 승인 | ROSTER_AUTH_VERSION 1, EIP-712 domain version 1 | chain/source/publisher/exact root 서명 결합. unsigned receipt 거부 |
| roster 소비자 | ROSTER_WITNESS_VERSION 1 | 새 RWA token은 frozen requireRoster 정책 필수. Direct fallback 없음 |
| 제재 데이터 | index v3, provenance v1, parser proofmark-lists-2 | legacy/mixed/stale artifact는 503. 구 데이터 시각을 바꿔 통과시키지 않음 |
| USC contracts / SDK | lock상 0.1.2 / 0.18.0 | decoder/interface source hash와 compile ABI 회귀. 새 버전 허용을 추정하지 않음 |

수동 ABI 조각에는 현재 컴파일 ABI 대조 6개가 있지만 완전한 자동 생성/배포 패키지 버전 관리로 대체한 것은 아니다. package 0.1.0을 protocol schema 1로 해석해서도 안 된다. 이후 breaking tuple/encoding/event 변경은 protocol version 증가, source·ASC·Registry·SDK·worker·consumer matrix 갱신, 새 환경에서의 migration 검증을 한 묶음으로 처리해야 한다. 이 규칙은 제안된 릴리스 절차이며 정식 지원 기간/보안 SLA 승인은 미정이다.

## 다음 업그레이드와 issuer 종료의 승인 절차

1. 변경 책임자가 exact upstream commit/tarball·license·변경 이유·수동 ABI/decoder/native semantics 차이를 제출한다. baseline hash만 새 값으로 갈아 끼우는 것은 검토가 아니다.
2. fixture에서 구버전/알 수 없는 provider 결과·schema를 주입해 positive credential이나 asset PASS가 나오지 않는지 확인한다. 실제 credential provider 업그레이드 conformance는 T-30과 함께 수행한다. 현재의 source hash mismatch 테스트는 이 전체 시험을 대신하지 않는다.
3. candidate source/ASC/Registry/SDK/consumer를 로컬로 구성하고 이전 발급·영구 denial·mixed receipt·freshness·현재 witness를 재생한다. 고객별 이관과 중단 허용 시간을 승인받기 전 공개 계약/기존 자산을 바꾸지 않는다. [기존 migration runbook](19-security-migration.md)을 따른다.
4. issuer 종료는 역할 회수 하나로 끝나지 않는다. 이미 저장한 credential·root 승인·witness의 수명, 새 issuer 정책, 기존 issuer 재승인 위험(T-12), 영구 denial 이관, 증거 보존/삭제, 미확정 발급 journal·철회 outbox를 함께 검토한다. 기존 mark의 issuer를 바꿔 재서명한 것처럼 만들지 않는다.
5. 새 issuer의 검증·서명과 consumer 전환이 확인되지 않으면 제한 상태를 유지한다. 롤백은 위험한 구 Direct/v1 proof로 돌아가는 것이 아니라 이관 중단·장애 공지·승인된 복구다. 실제 기관 종료/이관 훈련 결과는 아직 없다.

VC/ZK 등 source EVM 밖 증거는 provider의 서명 검증·원본 식별자·권리·revocation/freshness를 검증한 adapter 사양이 선행되어야 한다. normalization issuer의 서명이 원 기관의 서명이나 법적 reliance 권리를 대신한다는 주장을 하지 않는다. [외부 credential adapter](17-external-credential-adapter.md)는 실제 연동 완료 증거가 아니다.

## 유지 책임과 제품 경계 — 승인 전 제안

| 영역 | 제안 책임 역할 | 릴리스 전 필요한 실제 증거 |
|---|---|---|
| 공개 core: schema/ABI·verifier/Registry·proof encoding·test vectors | CTO/계약·SDK maintainer | 실명 owner/대체자, IP/license 승인, 지원 matrix, 변경 review와 보안 공지 경로 |
| 유료 운영 후보: provider 연결·queue/relay·KMS·증거 vault·모니터링/지원 | 운영/SRE·준법·BD | 고객별 범위·권한·가격/SLA·책임 승인. 공개 검증 경로를 유료 API로 대체한다는 뜻 아님 |
| 긴급 취약점 대응·배포 | 보안/릴리스 책임자 및 고객 계약 담당 | 신고 접수/분류, affected version/consumer 확인, 서명된 release 자료, 고객 통지·중단 권한 |
| license·공급자 종료·데이터 사용권 | 계약 법인/법무·vendor owner | 권리자 확인, notice/배포 자료, 종료 이관·삭제/보존 승인 |

표의 역할은 실제 배정이 아니다. 현재 서명된 build provenance, runtime/container SBOM, 독립 release review, 정식 보안 SLA, provider upgrade와 issuer 종료의 실제 소비 앱 이관 증거는 없다. 그래서 자동 점검이 통과해도 T-54 전체를 완료하지 않는다.

## 검증 재현

```sh
npm run supply-chain -- --write --audit
npx tsx --test pipeline/supply-chain.test.ts
npm run test:all
npm run typecheck
npm --prefix web run lint
npm --prefix web run test:api
npm --prefix web run build
npm run test:onchain-ui
git diff --check
```

추가 공급망 단위 테스트 5개는 registry/integrity/metadata 오류, bundled integrity 관계, source 변경·누락, SBOM license/scope, moving tag/미검토 action commit 거부를 다룬다. 전체 로컬 Solidity 99개·TypeScript 261개·API 24개·Chromium 1개, 타입/lint/build가 통과했다. 기존 Redis/Anvil 통합은 이번 의존성 문서 변경 후 재실행하지 않았으며 앞선 해당 구현 시점의 증거로 남긴다.
