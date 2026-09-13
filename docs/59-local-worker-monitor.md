# T-17 — Read-only local worker-state monitor

2026-09-07. **IN_PROGRESS.** One local diagnostic pass, not a worker heartbeat, chain reconciliation, installed scheduler or delivered alert.

## Run and interpretation

```sh
npm run monitor:worker
```

Required settings are `WORKER_STATE_PATH`, `SOURCE_CHAIN_ID`, `SOURCE_CHAIN_KEY`, `WORKER_START_BLOCK`, `SOURCE_CONTRACT_ADDRESS`, `ASC_CONTRACT_ADDRESS`, `MONITOR_WORKER_HUB_CHAIN_ID`, `MONITOR_WORKER_SIGNER_ADDRESS`, `MONITOR_WORKER_JOB_SECONDS` and `MONITOR_WORKER_ATTEMPTS`. The scope must describe the expected deployment and match the stored source/hub IDs, source/ASC/signer addresses, chain key and replay start block. Numeric settings must be positive safe integers. Warning thresholds are explicit operator choices, not an approved SLA or changes to worker retry settings.

The command does not import the worker's signing configuration, require private keys, query RPC/proof services, take or remove a lease, create a Store, rewrite state, rebroadcast, retry or transmit alerts. It reads one existing regular file with a 16 MiB byte ceiling and strict UTF-8/JSON parsing. An atomic worker rename can leave the reader with the previous complete snapshot; this is not a transactional live view. Symlinks follow normal read-only filesystem semantics. The monitor still parses and walks the entire bounded file; growing state needs an approved database/queue migration, not silent truncation.

Exit 0 means `NO_LOCAL_FINDINGS`; exit 1 means `ATTENTION_REQUIRED`; exit 2 reports only `WORKER_MONITOR_UNAVAILABLE`. Every successful report says `processLiveness: NOT_CHECKED` and `chainState: NOT_CHECKED`. Missing/unreadable/oversized/invalid files, wrong scope, uninitialized or inconsistent checkpoints and impossible job timestamps are unavailable, never an empty healthy deployment. A legitimate newly started worker that has not initialized its finalized source anchor is also unavailable until that anchor exists. A quiet old file does not prove a running worker or caught-up chains.

## Findings

| Code | Meaning and operator response |
| --- | --- |
| `SOURCE_SAFETY_HOLD` | Persistent source safety fence exists. Follow the source-reorganization runbook; do not clear it or replace relay state automatically. |
| `DEAD_LETTER` | Job requires operator review, regardless of age. Preserve its history and original transaction identity. |
| `SKIP_WITHOUT_CONFIRMED_OBSERVATION` | Legacy skipped job lacks the newer depth/hash-bound observation. Reconcile before any approved replay; the monitor does not requeue it. |
| `JOB_OVERDUE` | Nonterminal job has reached the selected discovery-age threshold. Retry updates do not reset this age. |
| `RETRY_THRESHOLD_REACHED` | Nonterminal attempts have reached the warning threshold. This does not change the worker's configured maximum. |
| `PENDING_JOB_ERROR` | Pending job retains a diagnostic. Raw provider/error text is withheld. |
| `SUBMITTED_WITHOUT_RELAY_ENVELOPE` | Submitted job lacks the matching unresolved local relay envelope. Reconcile the original job before any new transaction. |
| `RELAY_NONCE_UNRESOLVED` | Local relay reservation exists, even when young. This is a local reservation finding, not proof that the network nonce is stuck or unused. |

The monitor validates the source checkpoint anchor (`startBlock - 1`), increasing checkpoint heights, final cursor match, job coordinates/state/times and unresolved relay metadata linkage to its submitted job and expected hub/ASC/signer. It does not authenticate signed raw bytes, proof payloads, receipt history, canonical source/hub blocks, actual finality or current nonce ownership. The worker's delivery/reconciliation path remains responsible for those checks. `done` and `skipped` jobs do not become current-chain successes merely because they are locally terminal.

Thresholds are inclusive. Reports contain state/code totals, oldest pending discovery age, and up to 100 finding details while retaining complete counts and an explicit truncation flag. They also summarize the retained state lifetime: separate completed/skipped/failed latency and pending/overdue-pending age p50/p95/p99 with sample counts, terminal failure rate in parts per million, and attempts p50/p95/p99/total/retried-job count. These are not a time-windowed SLA: retention, restart/state replacement and the workload represented by the file still have to be established independently. Each job detail uses `ethers.id(sourceTransactionHash)` for correlation; raw transaction/query IDs, signed bytes, addresses, proof data, hold reasons and error strings are not projected. Digests are not anonymization. `observedAt` is monitor wall-clock time, not a stored heartbeat or source/hub timestamp.

## Verification and remaining work

Nine root regressions cover inclusive discovery-age/retry boundaries, terminal/dead distinctions, retained-state outcome/latency/attempt distributions, persistent holds and young relay reservations, scope/checkpoint/coordinate/clock rejection, bounded private output, actual Store reserve/finish/hold transitions, byte-identical reads, missing-directory preservation, nonregular/oversized/invalid UTF-8/JSON input, legacy/malformed skip observations and actual CLI exit 0/1/2 with no signing keys or RPC. Store fixtures are synthetic; these tests do not establish public-chain finality or measured operational latency. A retained skip observation is metadata, not a current-chain check; see [confirmed query skipping](64-confirmed-query-skip.md).

Together with [the vault monitor](58-local-vault-monitor.md), this supplies local backlog diagnostics. The separate [live self-report and bounded independent probe](60-live-worker-health.md#independent-bounded-read-only-probe) check local responsiveness/scan recency without relying on this file, and the [composite service observation](60-live-worker-health.md#composite-chainstate-observation) joins those results with configured source/hub RPC observations. An installed scheduler, authenticated/deduplicated alert delivery and acknowledged escalation, an independently trusted chain-head source, managed queue/distributed fencing, an operational recovery drill and genuine seven-day target-load evidence remain open. The existing file and any lease file must not be used as substitutes for these measurements.
