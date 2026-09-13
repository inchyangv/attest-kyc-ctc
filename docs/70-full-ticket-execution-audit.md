# T-56 — 56개 티켓 실행·완료 조건 감사

2026-09-07. 전체 목표를 축소하지 않는 실행 목록이다. **56개 모두 최종 완료는 입증되지 않았다.** `TICKET.md`의 LOCAL_VERIFIED는 해당 로컬 수정의 검증 상태이며, 원래 티켓의 배포·외부 검토·고객/법률 조건을 포함한 완료가 아니다. 아래 증거는 현재 작업물의 위치이지 독립 승인서가 아니다. 원래 완료 조건은 [TICKET.md](../TICKET.md)가 기준이다.

직전 T-06 진단은 제품 방향 결정을 요구한다. 답변 없이 독립 다기관으로 전환하거나 단일 issuer로 목표를 축소하지 않는다. 나머지 티켓도 문서·합성 테스트를 실제 계약/운영 성과로 승격하지 않는다.

## 책임·일정의 현재 상태

이 문서의 **모든 행**에 다음 필드가 적용된다. 실제 인물이 제공되지 않은 상태를 역할 이름으로 숨기지 않는다.

- 실제 실행 책임자: `UNASSIGNED`; 추천 직무는 원본 티켓의 담당 필드.
- 실제 검토/승인자: `UNASSIGNED`; 작성 AI는 독립 감사자·준법 승인자·재단 투자 승인자가 아니다.
- 확정 예정일: `UNSET`; 시작일·투입 인원·외부 창구가 없어 납기를 약속하지 않는다.
- 공수: 아래 범위는 **남은 로컬 설계/구현/준비 작업의 잠정 person-days**. S=1–3, M=4–10, L=11–20, XL=21–40. 외부 대기·감사/법률/벤더 비용·실제 고객 도입 기간은 제외한다. 겹치는 T-06/07/12/18 및 T-17/20/21 등의 공수는 합산하지 않는다. 승인된 방향/인력으로 재산정해야 한다.
- 외부 증거 상태: 별도 명시가 없으면 `NOT_VERIFIED`. 저장소에 증빙이 보이지 않는다는 것은 실제 세계에 상대나 계약이 없다는 단정이 아니다.

## 전체 실행 목록

`로컬`은 선택/권한 확보 없이 진행 가능한 범위가 남았음을, `결정`은 의미가 달라지는 사용자 선택을, `외부`는 승인된 환경·독립 상대·법률/운영 실증이 필요함을 뜻한다. 여러 표시가 있으면 첫 번째만 끝내고 티켓을 닫지 않는다.

| 티켓 | 현재 근거 위치 | 다음 실행과 최종 증거 공백 | 선행/필요 창구 | 공수 |
|---|---|---|---|---|
| T-01 | [denial 수정/로컬 fresh ASC 재생](19-security-migration.md) | 결정·외부: 승인된 release 주소의 finalized 전체 역사/native proof 재생·배포 대조, 해제 거버넌스와 독립 검토 | T-06/13/14; 배포 승인자 | M |
| T-02 | [Merkle v2·공개 반례 회귀](19-security-migration.md) | 외부: 독립 암호 검토, 승인된 신규 root/계약 전환 및 정확한 release 주소에서 역사적 위조 proof 거부 재확인 | T-14; 배포 승인자 | M |
| T-03 | [outbox·scheduled run monitor](20-rescreen-outbox-operations.md), [원본 거래 재시작·연결 검증](56-local-rescreen-enforcement.md) | 외부: 승인된 scheduler 설치·독립 경보 전달/ack·운영 vault/key 장애훈련·공개 CC3 enforcement 및 검토 승인 | T-17/20/21; 운영자/검토 승인자 | M |
| T-04 | [공유 bank 상태·원본 challenge/API/Redis 회귀](21-bank-challenge-state.md) | 외부: 승인된 Redis REST 공급자의 인증/TLS/timeout·failover conformance, 은행 rail의 timeout 결과 조회·재조정, failover 시 in-flight challenge 무효화와 운영 배포 | T-30; 은행/저장소/운영 창구 | M |
| T-05 | [발급 복구·activation-before-terminal](22-issuance-recovery.md), [vault fence](67-issuance-vault-fencing.md) | 로컬 완료: vault 활성화 실패가 terminal journal/pending 제거를 앞서는 반례를 단위·실제 Redis queue로 차단. 외부: 관리형 journal 백업 복원/RPO·runner 배포, 운영 signer로 실제 두 체인 원본 거래 재개, cross-store retention/삭제 승인 | T-06/21/30/33; 운영자·저장소/키 관리자 | L |
| T-06 | [결정안·red 진단·scope-v0 release guard](69-issuer-isolation-decision.md) | 로컬 부분 완료: 미결/unknown mode 및 현재 릴리스의 독립 다기관 표방을 배포 전 차단하고 명시적 single-issuer profile만 허용. 결정·로컬·외부: issuer 격리 방향, scoped 전체 구현 또는 on-chain 단일 issuer 강제, red 3개 해소·과거 제한 이관·독립 검토/배포 | 사용자 제품 결정; T-13/14 | XL |
| T-07 | [issuer root 승인·unsigned leaf 회귀](33-roster-issuer-authorization.md) | 로컬 완료: fresh root·유효 inclusion이어도 leaf issuer의 exact-root 승인이 없으면 trusted/wildcard/cache 경로를 모두 거부하고, source EIP-712/1271·동일 receipt·epoch별 승인을 로컬 EVM까지 재검증. 결정·외부: T-06 namespace 선택, T-12 승인 세대/compromise 무효화, 기관 키·실제 source/native proof·독립 감사·신규 배포 | T-06/12/14; 기관 키 관리자·독립 감사자·배포 승인자 | L |
| T-08 | [fresh roster gate·두 로컬 EVM 중단 경계](34-fresh-roster-consumers.md) | 로컬 완료: frozen roster policy/witness-only 자산 경로와 source revoke 미전달·issuer/publisher 무동작 시 cutoff+24h 정확 경계를 단위 및 두-EVM 회귀로 차단. 결정·외부: 고객 허용 차단 지연·Direct 사용 범위, 실제 source/native proof 중단 측정, 운영 witness 배포·지갑 UX·기존 자산 이관 | T-09/20/44; 고객 위험 책임자·운영/배포 승인자 | M |
| T-09 | [epoch freshness·누적 age 회귀](32-epoch-freshness.md), [finalized source 재생](38-source-roster-snapshot.md), [공식 목록 격리 관찰](83-official-snapshot-observation.md) | 로컬 완료: source cutoff·목록별 가장 오래된 checkedAt의 두 시계를 함께 적용해 둘 중 먼저 오는 +24h에서 만료; 23시간 목록→새 cutoff→추가 24시간 반례를 단위 및 실제 격리 publisher/worker/두 EVM에서 차단. membership/nonmembership·cache가 같은 current epoch 경계를 사용하고 finalized source replay/격리 공식 목록 관찰까지 연결. 외부: 승인된 공식 목록 activation·구성원별 재심사/완전성, 공개 v2 배포/지연 측정·위험별 고객 한도·독립 감사 | T-18/20/27; 고객 승인 한도·운영/배포 승인자 | L |
| T-10 | [atomic receipts·두 로컬 EVM worker/roster 연결](23-atomic-receipts.md) | 로컬 완료: 허가 계약 issuer의 중복 issuance·issue→revoke·복수 epoch 실제 receipt를 finalized worker scan→mock proof/native ASC→배포 기준 roster cold replay까지 대조. 외부: 실제 Safe/multisig·proof service/native verifier·공개 CC3, 신규 ASC/worker/Registry 배포와 mixed dead/소비 query 전체 역사 이관·독립 감사 | T-06/14; 배포 창구 | M |
| T-11 | [schema/정책·typed consumer](24-credential-policy-schema.md) | 로컬 완료: schema 0의 범위·시간 검증, immutable 개인/법인 kind, Direct/roster 공통 predicate와 exact 미래시각 반례, SDK/CLI·단일-block UI·두-EVM 소비 연결을 검증. 결정·외부: T-06 issuer 방향, 승인된 regime/KYB 의미·독립 소비자/보안 검토·새 정책/계약 배포 | T-06/14/31/36; 준법·독립 소비자·배포 승인자 | M |
| T-12 | [stable issuer rotation·세대/cutoff/transport 회귀](37-issuer-key-rotation.md) | 로컬 완료: stable issuer 2-step 회전, keyed 발급/root 승인, source-block compromise cutoff의 source→worker→ASC→Registry direct/roster 차단, cold replay 제외, journal/web recovery transport, 동결 정책 아래 재심사 후 정상 보유자 소각. 결정·외부: cutoff 승인·legacy generation-zero 취급, 법적 issuer mapping, 운영 KMS/multisig·실 proof/public 두 체인, 기존 EOA 자산 이관·제한 보유자 법적 상환/기관 종료 훈련 | T-06/13/14/18; 기관 키/법률/자산/배포 책임자 | XL |
| T-13 | [denial/자산 이중통제·이관 제한](84-denial-correction-recovery-governance.md), [보안 이관](19-security-migration.md) | 로컬 완료: 현재 denial revision에 묶인 issuer 제안→별도 approver→기술 지연→correction+정확한 대체 credential 단일 receipt, 역순 worker/ASC·cold roster replay, queryable 사유/승인 이력. owner-only force selector 제거, exact transfer/burn 제안→별도 승인→지연, 수취인 proposal/실행 재검사. 결정·외부: 법적 사유 taxonomy·실제 사람/조직 권한·jurisdiction/asset별 지연/통지/appeal·case hash 보관, historical denial/자산 이관, 상환·settlement, KMS/multisig·공개 배포/native proof·독립 법률/보안 검토 | T-06/12/14/20/31/33; 사용자·준법/법률·자산 운영·배포 승인자 | XL |
| T-14 | [생성형 stateful invariant·release runtime 경계](68-lifecycle-stateful-invariant.md) | 로컬 완료: correction 뒤 source-later revoke가 proof 역순에서 Suspended로 뭉개지는 반례를 수정하고 고정/생성형 모델 2개(고정 seed 합계 16,384 calls), exact pin+compiler/settings+linked decoder+artifact runtime의 Source/decoder/ASC/Registry/frozen-policy Note 실제 두-Anvil 대조를 검증. 결정·외부: T-06/13 확정, clean release commit·감사 범위 승인, 독립 보고서/critical·high 수정 재검증, 승인된 compiler/library/constructor manifest와 공개 두 체인 bytecode 대조 | T-06/13; 사용자·독립 감사자·배포 승인자 | L |
| T-15 | [bounded dispatch·relay 복구](25-relay-recovery.md), [실제 worker crash](62-worker-crash-recovery.md) | 로컬 완료: 1,000-job/100-scan/RPC-delay 반례에서 running 3·각 실행 1·waiter 0, 원본 signed envelope·nonce/revert/reorg/unknown replacement와 실제 worker crash 복구를 검증. 결정 후 로컬·외부: 승인된 fee replacement/cancel/dead-letter 재처리, 분산 signer shared fencing/키 소유권, 운영 takeover·proof service·배포 훈련 | T-17; 키/운영 책임자 | L |
| T-16 | [source checkpoints·hub recovery](26-source-checkpoints.md), [확정 skip](64-confirmed-query-skip.md) | 로컬 완료: implicit state bootstrap 금지, zero-nonce 전용 signer의 별도 1회 초기화, 전체 terminal receipt/skip·연속 nonce startup/poll/pre-sign 대조와 유실/nonzero state·오래된 backup·released receipt deep reorg 영속 hold를 단위/실제 Anvil로 검증. 결정·외부: signed/consumed source fork 및 deep hub fork의 ASC/consumer 정정, hold 해제 승인, KMS 서명 이력·off-host backup/복원·운영 배포 훈련 | T-17/21; 복구·키·배포 승인자 | XL |
| T-17 | [composite live/chain 관찰·run evidence](60-live-worker-health.md), [worker queue/state monitor](59-local-worker-monitor.md) | 로컬 완료: 최근 self-report만으로 source cursor 100-block lag를 정상 오판하는 반례를 차단하고, bounded source/hub head·nonce/balance/gas와 local queue/hold/relay·retained latency/failure/retry를 함께 관찰. 원자 redacted run 기록과 never/missed/gap/최소 7일/목표 job 감사까지 구현. 결정·외부: 운영 플랫폼·독립 head source·managed shared queue/분산 fencing, scheduler 설치, 인증 alert dedup/escalation/ack와 실제 수신자, 승인 목표 부하의 실제 7일·운영 노드 종료 복원훈련 | T-15/16/21; 운영 플랫폼/알림 수신자·키/복구 승인자 | XL |
| T-18 | [receipt-root source replay·증분 checkpoint](38-source-roster-snapshot.md) | 로컬 완료: finalized cutoff의 모든 block/receipt를 별도 header RPC와 대조하고 EIP-2718 receipt MPT를 `receiptsRoot`까지 재구성해 transaction/getLogs 동시 누락 반례를 거부. sourceSnapshot v2와 AES-GCM·scope-bound·원자 checkpoint가 cold replay와 같은 누적 root/digest를 재현하며 과거 v1은 자동 승격하지 않음. 결정·외부: 실제 독립 운영/authenticated header 공급자·초기 archive scan/복구본·고객 규모 latency/SLA, 구성원별 최신 재심사·누락 책임, T-06 namespace·공개 전환·독립 감사 | T-06/16/20/27; archive/header RPC·운영/준법/감사 승인자 | L |
| T-19 | [prepublication-bound immutable proof replicas·규모 측정](39-roster-proof-availability.md) | 로컬 완료: disclosure ack+서로 다른 2개 디렉터리의 canonical seed fsync와 hash/count journal 결합 뒤에만 서명, source receipt 후 exact bundle finalization, publisher 원본·한 replica 제거 뒤 offline CLI/HTTP proof 복구, 동일-block chain check·두-EVM holder witness/gate, 1천/1만 root/RSS/localhost concurrency/source batch gas·cold replay RPC 계측. 결정·외부: 고객 목표 규모/SLO, 승인된 wallet-linked roster 권리·독립 hosted replica/인증·보관·삭제, 실제 브라우저/외부 지갑 witness, public archive/native proof/Registry·CC3 fee와 운영 SLA·배포 | T-06/18/38; 고객·privacy/법률·스토리지/운영·지갑/배포 승인자 | L |
| T-20 | [enforcement·list-edition trigger](56-local-rescreen-enforcement.md), [review CAS](65-human-review-fencing.md) | 결정·외부: 로컬 version 불일치는 interval보다 먼저 재심사하고 미전송/미실행 상태는 진단함. IAM/실제 배정·이중 승인, watcher/scheduler·인증 alert 설치, REVIEW 즉시정지 기준, appeal/통지/재발급, live credential 보관·삭제와 운영 drill은 미확정 | T-06/13/17/21/27/33; 준법·법률·운영/배포 승인자 | XL |
| T-21 | [vault 동시성·복구·키 경계](66-vault-write-fencing.md) | 로컬 완료: bounded single-host lock wait+lock 안 재로딩으로 실제 API/rescreen/appeal/purge 4-process 보존, I/O 불확실성 fence, 인증 backup·빈 목적지 restore·외부 revision floor 입력·source receipt commitment 대조, 현재 파일 key rotation/구 키 거부, 합성 RPO/RTO 측정. 결정·외부: managed DB/row transaction·분산 coordination, KMS/HSM custody/구 키·과거 backup 폐기, off-host immutable backup/독립 high-water mark·전체 store/chain reconciliation, 인증 접근 감사, 승인 RPO/RTO와 운영 power-loss/failover drill·배포 | 운영 플랫폼/예산/키·복구·보안 승인자 | XL |
| T-22 | [API/자원·shared issuer gas](27-api-resource-limits.md), [vendor HTTP](40-vendor-http-boundaries.md) | 로컬 완료: body/image/vendor 경계와 bank 공유 budget에 더해 API/processor 공통 UTC-day issuer gas+tx Redis 예약, 미확정 유지·canonical receipt actual 조정, 2-instance/응답 유실/50회 status 무변경을 검증. 결정·외부: 승인 gateway/proxy·분산 vendor/RPC quota와 정상 사용자/비용 기준, managed Redis failover·stuck reservation pause/reconciliation/alert, 다른 signer·fiat budget, native OS/RSS 격리·실제 latency/카메라 | T-17/30; 운영 플랫폼·예산/키 책임자 | L |
| T-23 | [runtime 키 분리·bounded rotation](85-runtime-key-boundary.md), [공개 진단 경계](41-public-diagnostic-boundary.md) | 로컬 완료: publisher journal/nonce 복구에 더해 deployer·governance/issuer/rescreener/publisher/worker/asset/recovery principal 중복 preflight, publisher/rescreen/worker key-address pin, worker-only mode-0600 env와 host hardening, evidence와 분리된 key-ID token의 bounded 이전-key 검증·폐기, vault 원자 rotation, web 보안 헤더를 회귀/연결 검증. 결정·외부: source issuer role의 issue/revoke 세분화와 T-06 방향, 실제 KMS/HSM/multisig·계정/IAM/quorum, fleet rotation/rollback, 구 키·backup 파기와 독립 access-log 감사, 승인 키 ceremony·운영 배포/role event 대조 | T-06/12/17/21; 보안·키 custody·운영/배포 승인자 | L |
| T-24 | [브라우저/HTTP/Redis 복구·상태/판정 추적](51-local-api-issuance-integration.md#connected-browser-recovery) | 로컬 완료: 사전 request ID, 응답 유실/reload/새 서명 복구와 동일 tx·nonce 1회를 유지하고, wallet-auth read-only status가 source→CC3→current Registry policy를 분리해 witness 전 asset not-ready, witness 후 exact policy 2 PASS를 실제 built UI/route/Redis/vault/두 Anvil에서 검증. 5초 status polling과 승인값 기반 예상범위/timeout/HTTPS 지원 설정도 구현. 결정·외부: 실제 extension/모바일·Next production API hosting, proof 만료/서버 중단·기기/session/ID 유실, managed Redis, 공개 native proof/worker·공개 두 체인, 운영 timing/SLO·지원 책임자/경로 승인·배포 | T-05/38/39; 운영/지원·배포 승인자 | L |
| T-25 | [이름 후보 검색](29-aml-edit-retrieval.md) | 로컬 완료: 4–5자 1-edit·6–64자 2-edit verified retrieval, 두 토큰 동시 오타·한 name part 누락 REVIEW, alias/원문 우선순위, stop/high-frequency/후보 cutoff 제거, 고정 fail-closed index/query 상한. 합성 19행과 기록 목록 200 positive/610 clean, 26,566건 200-query 비용 측정. 결정·외부: 독립 라벨 holdout의 언어/길이/entity별 confusion matrix, 4자 미만·64자 초과/3-edit+/복수 누락·음성/전사 정책, 오탐·검토 비용과 threshold 승인, 고객 corpus 동시/adversarial 부하·provider 비교·운영 release/rescreen | T-29; 독립 라벨 평가자·준법/운영 승인자 | L |
| T-26 | [DOB/동명이인](28-aml-identity-comparison.md) | 로컬 완료: 이름 점수와 DOB/국적 상태를 분리하고 full-date exact/year-only/conflict/missing/invalid, 부분 지지+충돌, wallet 우선순위, 76개 동명이인 후보, 상태 결합 evidence digest/UI와 REVIEW/BLOCK 미발급을 검증. 같은 이름·다른 DOB/국적 `PM-T26-01`은 REVIEW. 결정·외부: 이름-only 법적 차단 여부·threshold/검토/escalation/appeal 준법 승인, 독립 라벨/실제 과거 오인 case 재평가, 과거 evidence/credential migration·T-13/T-20 운영 연결, 승인 목록·배포 검증 | T-13/20/29; 준법 책임자·운영/배포 승인자 | M |
| T-27 | [원자 목록 갱신](31-sanctions-snapshots.md), [공식 관찰](83-official-snapshot-observation.md) | 로컬 완료: 새 공식 3-source full GET→검증/eval→동일 CLI·baked v3 snapshot, 용도별 screen/issuance/rescreen/epoch age, warm cache·prepared issuance 변경 fence, 별도 FATF table ID/age, exact snapshot의 v2 rescreen state와 mixed-fleet/trigger 로컬 gate. 결정·외부: 법적 publication 시각·completeness/threshold·age 승인, 인증 receipt/host observation·cross-host rollback, 실제 fleet 배포/scheduler/rescreen·source/hub reconciliation, alert 전달/ack·독립 정확도 | T-17/20; 준법·운영/배포·알림 승인자 | L |
| T-28 | [실제 check capability](30-check-capabilities.md) | 로컬 완료: 미구현 PEP/adverse-media flag 시작 거부, no-data/skipped/unavailable false-success 제거, exact wallet lookup의 graph exposure bit 20 미부여와 SDK 경고, 자기신고 jurisdiction 표기, 실제 ID+bank 결과 기반 regime/packed attrs·설정 전환 승격 방지. `PM-T28-01` 수정 전 0/1·현재 1/1, 집중 57/57, 기본 Solidity 118/118·TypeScript 545/545, API 60/60, typecheck·web lint/build·두-EVM 발급 E2E 1/1. 결정·외부: 인증 provider run/receipt failure·timeout conformance, 과거 bit 20 migration, 고객 method/regime mapping 승인, 실제 fleet rollout | T-27/30/31; 고객 준법·provider·운영/배포 승인자 | M |
| T-29 | [AML gate·holdout 보고서](28-aml-identity-comparison.md#t-29-evaluation-paths), [검색 평가](29-aml-edit-retrieval.md) | 로컬 완료: 모든 AML test를 기본/source-bound suite와 CI에 포함하고, current manifest의 26,574건 내부 gate(positive 200 = 167 BLOCK/33 REVIEW/0 ALLOW, clean 610 hold 0, 회피 7/7, wallet BLOCK, unearned bit 0)를 비정상 exit에 연결. `PM-T29-01` all-ALLOW sabotage를 false negative 2건으로 거부하고, versioned holdout CLI가 country/script/list/entity confusion matrix·review/time coverage·Wilson interval·label/selection metadata·dataset/source/report fingerprint를 raw subject 없이 기록하며 threshold 실패 시 보고서를 쓰지 않음. 집중 4/4·AML 66/66·기본 TypeScript 548/548, fresh-manifest 내부 보고서 `artifacts/aml-evaluation/2026-09-07-t29-current/report.json` fingerprint `6ac6708b49938feee4817c95740a79e3c276d5d5c5aa4a4ac70236ccf7354f32`. 외부: 독립 평가자가 개발과 분리해 라벨한 실제 holdout, 언어/국가/list/entity별 충분한 표본과 오류 분석, 실제 REVIEW 조사 시간/비용, 고객 준법의 threshold·label basis 승인, 승인 데이터 보관/접근 및 운영 release/rescreen | 준법/독립 평가자·고객 데이터/운영 승인자 | L |
| T-30 | [외부 credential 경계·로컬 conformance](17-external-credential-adapter.md) | 로컬 완료: strict ES256K compact-JWS profile의 issuer/key ID/audience/wallet subject/time/environment·configured method/assurance/regime/jurisdiction, HMAC ID·동시 replay, status unknown/error·revocation을 검증. `PM-T30-01`은 구현 전 module-not-found로 0/1, 현재 집중 7/7; 합성 외부 signer→실제 두 Anvil Source/ASC→별도 consumer process의 exact policy accept, wrong issuer/regime/jurisdiction reject, Source revoke 후 reject 연결 1/1. 기본 Solidity 118/118·TypeScript 555/555와 typecheck 통과. 결정·외부·로컬: 첫 고객/provider·T-06 publication/issuer 방향, 비용/rate limit/재사용·체인 게시·보관·SLA/책임/지원 권리, provider-native credential/status·key rotation과 durable multi-host replay, 승인 환경의 실제 credential·public native proof/배포, 팀 외부 소비 앱 | T-06/32/44; 고객·벤더/파트너·법률/준법·배포 승인자 | XL |
| T-31 | [identity requirement·policy-local assurance·biometric admission](86-identity-assurance-boundary.md), [capability 경계](30-check-capabilities.md), [adapter mapping](17-external-credential-adapter.md) | 로컬 완료: required check별 pass/missing/not-required/unsupported, UBO/대표자 미지원, 임의 assurance 승격·무승인 생체 결과/호출을 발급 전 차단하고 production은 approved policy JSON 없이는 503. 결정·외부: 실제 고객군/gated action별 identity·대리인·대포계좌·UBO 요구와 assurance/freshness/review 승인, 생체 필요성·법적 근거/고지·동의·vendor/보관·삭제 승인, 허가 환경 실제 사람/법인 conformance | T-30/32/44; 고객 준법·법률/privacy·provider | M |
| T-32 | [processing-policy/consent/evidence 경계](87-processing-policy-boundary.md), [법률 검토 초안](08-regulatory-position.md) | 로컬 완료: production approved 고객 manifest 없이는 wallet challenge 전 503, first-party/institution-service/SDK 모델과 주체·항목·목적/basis·vendor/국가·보존·권리·RRN 권한·불가역 chain 공개를 versioned policy로 snapshot하고 표시/SIWE→vendor 전 guard→request/evidence/journal/vault에 fingerprint 결합, drift/미등재 recipient·data/SDK hosted 처리를 차단. 결정·외부: 실제 고객/모델, 권한 있는 법률 의견과 RRN·항목별 basis, 계약/DPA·vendor/subprocessor·국외 이전, notice/consent·권리/삭제/정정, chain 공개 승인, 실제 topology·배포/server 증적 | T-44; 고객 controller·권한 있는 법률/privacy·준법·vendor/운영 승인자 | M |
| T-33 | [삭제 controls·retention manifest](42-vault-deletion-controls.md) | 로컬 완료: production 무정책 wallet 전 503, 고객/관할/결과/기산일·8계층·자격 처분 policy snapshot/drift gate, 기존 hold/승인/exact-deadline purge, journal terminal+1d capability 제한, backup expiry·외부 erasure floor 복원 차단, `PM-T33-01` 전체 계층 완료 거부. 결정·외부: 실제 승인 기간/기산일·clock/IAM/hold authority, managed journal/backup/log/browser/vendor의 hold·삭제 receipt/복원·scheduler, 자격 유지/철회 승인·공개 체인 잔존 수용 | T-21/32; 고객·보관 정책/법률/privacy·운영/vendor 승인자 | XL |
| T-34 | [공개 오류·감사 export 경계](41-public-diagnostic-boundary.md) | 로컬 완료: exact 최소 claim grant와 customer authorizer pin, provider/product/environment/key별 receipt 서명·adapter axis digest, request/credential/source tx·commitment·동의 문구·processing/identity/retention/engine/list version, Merkle disclosure, exporter 서명과 별도 onchain observation을 fail closed로 재계산하고 redacted CLI observation만 출력; `PM-T34-01` unsigned ref 거부, 집중 4/4·API 64/64·기본 TS 575/575·관련 Redis/Anvil/browser 통합 통과. 결정·외부: 실제 기관-authorized receipt와 key/status conformance, 고객 승인 감사자/최소 공개·전달 채널, 승인 독립 RPC/finality에서 실제 export 재현, proxy/APM/platform/vendor PII 점검 | T-21/30/32; 고객·기관/vendor·감사/보안 운영자 | L |
| T-35 | [합성 UI·공식 AML 연결](47-synthetic-demo-experience.md), [제재 교육](48-synthetic-sanctions-training.md), [공식 snapshot 관찰](83-official-snapshot-observation.md) | 로컬 완료: 세 합성 preset·고정 PNG·demo-only routing과 별도 비발급 제재 교육, `PM-T35-01`의 shared fixture 계좌를 지갑별 capacity로 격리하면서 unmarked 계좌 제한 유지, `PM-T35-02`의 활성 공식 3-source artifact 26,574건 screening과 sandbox regime 2/production 거부. 연결 browser/API/Redis/vault/두-EVM test는 exact baked/raw artifact와 issuance/epoch snapshot을 묶도록 구현했으나 이번 실행은 Docker socket 부재·Chromium Mach bootstrap 실패로 green 결과 없음. 결정·외부: 독립 초행 심사위원 관찰, 실제 extension/mobile wallet, managed/distributed capacity·renewal/load, 공개 배포와 authorized native proof/public-chain E2E | T-27/38/39/41; 테스트 참가자·운영/배포 승인자 | M |
| T-36 | [같은 block 판정](35-single-block-verdicts.md) | 로컬·외부: source/hub 계보·전체 verify 동선·policy 탐색·실지갑 recovery | T-06/24/38; 배포 환경 | L |
| T-37 | [consumer proof 예제](39-roster-proof-availability.md) | 외부·로컬: 독립 개발자 staging·발급/철회/만료·통합 시간·패키지 지원 경계 | T-06/30/44; 소비 앱 개발자 | L |
| T-38 | [wallet session](52-wallet-session-boundary.md) | 결정·로컬·외부: 지원 지갑/모바일/접근성 표·ERC-1271/discovery·만료 갱신 검증 | 지원 범위/실기기/테스터 | L |
| T-39 | [API conformance](49-demo-driver-api-conformance.md), [브라우저 연결 통합](51-local-api-issuance-integration.md) | 로컬·외부: CLI/production API hosting·실제 지갑/worker/native proof/공식 AML/관리형 store 전체 E2E. built browser→실제 route 및 후속 로컬 gate는 연결 검증 | T-05/27/38/41; 승인 환경 | L |
| T-40 | [검증 범위](44-demo-verification.md), [source-bound test](45-source-bound-test-evidence.md) | 외부·로컬: 승인 pins/새 배포·block/event/balance 계보·독립 재현 | T-06/14/41; release 승인자 | M |
| T-41 | [freshness 운영](46-demo-freshness-operations.md) | 결정·외부·로컬: 심사 기간/lead time·새 배포/현재 목록·실제 scheduler/witness 갱신 | T-17/27; 운영자/배포 승인 | L |
| T-42 | [제출 checklist](submission/FINAL-CHECKLIST.md) | 외부·로컬: 최신 공식 요구 확인·최종 영상/공개 URL·외부 재현·접수 증명 | T-40/41/52/55; 업로드/제출 승인 | M |
| T-43 | [제품 계획](03-product-plan.md) | 결정·로컬·외부: 고객 행동/비용 중심 3분 동선 확정·test token/실자산 경계 검토 | T-44; 제품/자산 책임자 | S |
| T-44 | [discovery kit](18-design-partner-discovery.md) | 결정·외부: 첫 고객/gated action·접촉 허가·적격 인터뷰와 양측 staging owner | 사용자/실제 고객 창구 | M |
| T-45 | [외부 credential 경계](17-external-credential-adapter.md) | 외부: 독립 issuer/consumer의 source 필요성 확인·직접 발급 대안 대비 측정 | T-30/44; 실제 양측 파트너 | M |
| T-46 | [최초 경쟁 검토](../TICKET.md) | 외부: 동일 고객 시나리오의 실제 견적/통합 범위·won/lost 근거·차별점 선택 | T-44; 고객/벤더 창구 | M |
| T-47 | [합성 원가 모델](43-unit-economics.md) | 외부: provider 견적·고객 가격 피드백·실제 조사 시간/청구·현금 일정 | T-30/44; 재무/가격 승인자 | M |
| T-48 | [discovery 양식](18-design-partner-discovery.md) | 외부: 10개 적격 계정·예산/단계/다음 날짜·ACV와 현실적 도입 수 | T-44/47; BD owner | M |
| T-49 | [투자 제안의 가설](11-investment-memo.md) | 결정·로컬·외부: team/test 제외 KPI 정의·데이터 계보·독립 앱/issuer/유료 행동 dashboard | T-44/47; KPI 승인자/실데이터 | L |
| T-50 | [원래 확장 조건](../TICKET.md) | 결정·외부: 국내 시작 근거·고객이 요구하는 다음 국가·현지 책임/비용 | T-44/48; 실제 고객/현지 창구 | M |
| T-51 | [tranche 제안](../TICKET.md) | 외부: 실제 승인자/날짜/견적·중단/반납·금융 형태와 계약·downside cash | T-44/47/52; 투자/재무/법률 | M |
| T-52 | [권리/의존성 inventory](36-supply-chain-maintenance.md) | 외부: 법인/팀/cap table/IP 양도·상표·root LICENSE 및 upstream 불일치 승인 | 권리자/법률/팀 구성원 | M |
| T-53 | [법률 검토 초안](08-regulatory-position.md) | 외부: 재사용/게시/보관 권리·책임 분담·SLA/배상/보험·사고 통지 계약 | T-30/32/44; 양측 법률/준법 | M |
| T-54 | [supply-chain 관리](36-supply-chain-maintenance.md) | 로컬·외부: maintainer/종료 이관·서명 build/runtime provenance·업그레이드 훈련 | T-12/14/52; release owner | L |
| T-55 | [현 보안/이관 경계](19-security-migration.md) | 로컬·외부: 전체 deck/영상/문서 주장 정합화·실제 새 배포 근거/공개 범위 승인 | T-40/41/42/52; 공개 승인자 | M |
| T-56 | [원본 장부](../TICKET.md), 이 감사 | 결정·외부: 실제 owner/reviewer/납기·주간 실행/중단 결정·외부 증거 연결 | 사용자/CEO/PM | S |

## 다음 실행 묶음과 중단 지점

1. **제품 결정:** T-06 독립 issuer 격리 또는 강제 단일 issuer 제품. 격리를 선택하면 T-07/12/18/20/36/37/39의 schema 의존 작업을 같은 release로 묶는다. 승인 없는 신규 배포는 하지 않는다.
2. **운영 선택:** T-17/21의 호스팅·managed queue/DB/KMS·관할·복구 목표·알림 수신자·예산을 실제 담당자가 정한다. 로컬 파일/health 개선만 계속하면서 이 선택이 완료됐다고 보지 않는다.
3. **외부 서비스/고객:** 첫 고객 유형·관할·gated action 하나, 승인된 provider와 재사용/게시 권리, 연락 가능한 양측 담당자. credentials는 채팅/공개 문서에 붙이지 말고 승인된 secret 전달 수단으로 제공한다. API 키만 있는 것은 계약/처리 근거 증거가 아니다.
4. **준법/자산/권리:** T-13/31/32/33/52/53은 권한 있는 사람이 결정해야 한다. 현재 초안을 법률 승인으로 사용하거나 소급 clearance·강제 이동·LICENSE를 임의 생성하지 않는다.
5. **릴리스/제출:** 감사 범위·release commit·배포/거래/업로드/제출 권한·공식 기간이 필요하다. 역사적 주소·영상 대본·local green suite를 새 release 증거로 재사용하지 않는다.

위 항목은 각각 별개의 권한이다. T-06 방향 승인이 운영 키 사용·파트너 메시지 전송·실제 개인정보 처리·배포·투자 계약·해커톤 제출까지 승인하는 것은 아니다.

## 실제 owner가 채울 주간 실행 기록

반복 문서 작성을 실적처럼 집계하지 않는다. 다음 양식은 **빈 양식**이며 회의·배정·합의를 나타내지 않는다.

```text
주간 시작일 / 기록자:
티켓 ID / 변경 전 상태:
실제 owner / reviewer / 승인 근거:
이번 주 요구 결과 / 사용자 승인 범위:
범위 확정 후 공수 범위 / 확정 예정일:
선행 결정·외부 의존 / 담당 창구:
실행한 변경 / 실행 날짜 / 원본 증거 위치:
테스트·관찰이 증명하는 범위 / 여전히 미확인인 조건:
판단: 계속 / 수정 / 추가 승인 대기 / 범위 중단:
다음 행동 / 담당 / 날짜:
```

고객/provider/원가/허용 지연 가설의 8주 검토 시점은 실제 프로그램 시작일이 확정된 뒤 계산한다. 지금 날짜에서 임의로 계약 기간을 시작하지 않는다. 축소·중단은 사용자/투자 승인자의 결정이며, 본 목표를 임의로 작은 SDK 작업으로 바꾸지 않는다.

## 완료 감사 방법

- 56개 ID가 한 번씩 존재하는지, 근거 경로가 실제 존재하는지 점검한다. 이 구조 검사는 근거 내용의 진실성·현재 외부 상태를 증명하지 않는다.
- 티켓의 각 원래 완료 조건을 독립된 요구사항으로 읽고, 해당 범위를 실제로 검증한 원본 결과·상대 확인·승인·배포 기록을 붙인다. 보고서 링크만으로 미검증 항목을 닫지 않는다.
- 현재 T-06 red acceptance 3개, 독립 감사/외부 credential/고객 인터뷰·계약/운영 배포·최종 제출의 미확인은 전체 완료를 반증한다. 기본 suite의 108 Solidity/436 TypeScript 통과와 모순되지 않는다. 그 suite가 이 외부 조건이나 별도 red 진단까지 통과했다는 뜻이 아니기 때문이다.
- 이 감사는 목표 완료 선언이 아니다. 방향 결정 없이 진행할 수 있는 로컬 작업과, 사용자/외부 창구 없이는 넘어갈 수 없는 조건을 구분하기 위한 장부다.
