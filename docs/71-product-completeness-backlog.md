# 제품 완성도 후속 티켓 초안 (T-57 ~ T-63)

작성 2026-09-07. T-01~T-56 실행 중 반복적으로 "미충족"으로 남은 공통 공백을 제품 완성도 관점에서 묶은 초안이다. 아직 승인·실행되지 않았다. 각 티켓은 codex `gpt-5.6-sol`/high 세션 하나가 로컬에서 끝낼 수 있는 범위로 잘랐고, 운영 키·배포·외부 연락은 포함하지 않는다. 승인되면 TICKET.md 실행 장부 규칙을 그대로 따른다.

공통 원칙: 문서만 추가하고 완료로 집계하지 않는다. 반례 회귀가 없으면 완료가 아니다. README·deck·영상 대본은 working-product 톤을 유지한다.

## T-57 — v2 스테이징 배포 리허설 (배포 승인 전 단계까지)

- 문제: T-01~T-19의 모든 계약 변경이 Anvil에서만 검증됐다. 라이브 Sepolia/CC3는 v1이다. 배포 결정이 나도 당일 실행할 스크립트·순서·롤백이 없다.
- 범위: `script/deploy.sh --dry-run`이 실제 Sepolia/CC3 RPC를 상대로 v2 preflight(issuer mode, denial approver·asset proposer/approver 주소, `worker:init-state` 요건, 잔액·chain id·precompile 주소)를 검사하고 실패 원인을 항목별로 출력한다. 배포 직후 실행 순서(`worker:init-state` → 정책 등록·동결 → 데모 발급 → relay 확인 → `verify:submission` → README/deck 주소 갱신 목록)를 하나의 runbook 스크립트로 만든다.
- 완료 조건: dry-run이 실제 RPC로 통과하되 트랜잭션은 0건. 같은 runbook을 두 로컬 Anvil에서 끝까지 실행해 E2E 통과. 주소 갱신 대상 파일 목록이 스크립트로 생성된다(README, deck, commands-v2.sh, deployments/*.json, verify pins).

## T-58 — 상시 worker와 freshness 자동화 (EC2)

- 문제: 로컬 worker(PID 90994)는 이 맥이 꺼지면 죽는다. 정책 2의 7일 maxAge 때문에 심사 기간 중 데모가 끊길 수 있다. `deploy/worker`가 있으나 systemd·백업·재발급 주기가 없다.
- 범위: `deploy/worker`에 systemd unit, 환경 검증, 상태 파일 백업(T-16 checkpoint 규칙 준수), T-17 monitor 기록 cron, 7일 주기 A/B 재발급 cron(`docs/demo-video/reissue-ab.sh` 기반, 승인 플래그 없으면 dry-run만) 추가.
- 완료 조건: unit 파일·env·cron 구문 검증 스크립트 통과. 승인 플래그 없는 cron이 fail-closed로 dry-run만 수행하는 회귀. runbook에 설치·확인·복구 명령이 복사해 실행 가능한 형태로 존재.

## T-59 — 경보 sink 실제 연결

- 문제: T-17 monitor는 상태를 기록하지만 아무도 받지 못한다.
- 범위: monitor 결과를 env로 선택한 채널(Slack webhook, Telegram bot, 이메일 중 하나 이상)로 전송. dedup·escalation·ack 규칙은 T-17 정의를 사용.
- 완료 조건: mock sink로 dedup/escalation/ack 회귀 통과. sink env 미설정 시 명시적 `skipped` 상태이며 성공으로 집계되지 않는다. 실제 전송은 사용자가 env를 넣은 뒤 1회 수동 확인.

## T-60 — clean-clone 재현 스크립트

- 문제: `docs/submission/reproduction-template.md`는 양식이고 실제로 새 환경에서 돌려본 기록이 없다. 심사위원 재현은 여기서 깨진다.
- 범위: 임시 디렉터리(또는 컨테이너)에서 `git clone → npm ci → forge build → forge test → npm run test:ts → web build`를 문서 순서대로 실행하고 단계별 결과를 출력하는 `scripts/reproduce-clean.sh`. CI workflow가 동일 단계를 실행하는지 대조.
- 완료 조건: 스크립트가 현재 트리에서 통과. 실패 시 단계명·명령·exit code를 출력. README quickstart의 명령이 스크립트와 글자 단위로 같다.

## T-61 — 계약 커버리지와 정적 분석

- 문제: 불변식·회귀는 많아졌지만 커버리지 수치와 정적 분석 결과가 없다.
- 범위: `forge coverage` 결과를 evidence에 포함, 설치 가능하면 slither 실행 후 high/medium triage 문서. README에 수치 한 줄.
- 완료 조건: coverage 리포트가 `artifacts/test-evidence`에 남고 수치가 기록됨. 새 high 이슈 0 또는 항목별 triage(수정/수용/오탐)가 문서화. 수치를 부풀리기 위한 테스트 삭제·skip 금지.

## T-62 — consumer SDK 패키징

- 문제: 소비 앱 개발자가 쓸 수 있는 단위가 `examples/consumer`와 pipeline 내부 코드에 흩어져 있다(T-37 범위 밖).
- 범위: typed policy·witness 조회·verdict 해석을 `packages/proofmark-sdk`로 분리, `npm pack`으로 tarball 생성, 빈 프로젝트에 설치해 10줄 예제로 `isVerified`·witness 조회.
- 완료 조건: pack된 tarball을 빈 임시 프로젝트에 설치한 예제가 두 로컬 Anvil에서 통과. 공개 API 표와 지원 범위(체인·정책 버전)가 README에 있음. 외부 레지스트리 publish는 하지 않는다.

## T-63 — 심사위원 60초 동선 점검

- 문제: README의 60초 read-only proof 블록은 cast 명령이다. 웹에서 지갑 없이 같은 결과를 보는 동선이 있는지 확인되지 않았다.
- 범위: 첫 화면에서 주소 입력만으로 정책별 verdict·block pin·explorer 링크를 보여주는 read-only 경로 점검. 없으면 구현. 기존 다크·mint·고정 컬럼 디자인 언어 유지.
- 완료 조건: built Chromium 테스트로 A·B·control 세 주소의 결과가 README 60초 블록의 cast 결과와 같은 block에서 일치. 모바일 폭에서 가로 스크롤 없음.
