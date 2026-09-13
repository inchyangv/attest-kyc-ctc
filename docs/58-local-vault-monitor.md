# T-17 / T-20 — Read-only local vault backlog monitor

2026-09-07. **IN_PROGRESS.** A single local diagnostic pass, not an installed scheduler, delivered alert, current-chain verdict, worker heartbeat or institutional SLA.

## Run

```sh
npm run monitor:vault
```

The command requires the existing encrypted vault path/key plus five explicit positive whole-second settings: `MONITOR_SCREENING_SECONDS`, `MONITOR_ISSUANCE_SECONDS`, `MONITOR_REVIEW_RECORD_SECONDS`, `MONITOR_REVOCATION_SECONDS`, and `MONITOR_OBSERVATION_SECONDS`. There are no guessed production thresholds. The operator must align screening monitoring with the actual rescreen interval/schedule and approve the other warning thresholds. The command does not change those schedules or create a policy agreement.

The command reads an existing encrypted file once and projects local lifecycle metadata. It does not create missing vault directories, take a writer lock, change timestamps, screen identities, purge evidence, sign, contact an RPC/provider or transmit an alert. Missing/unreadable/invalid state, missing thresholds and impossible future timestamps fail as unavailable; a missing file is not an empty healthy deployment.

Exit 0 means `NO_LOCAL_FINDINGS` against these thresholds. Exit 1 means `ATTENTION_REQUIRED`; exit 2 means `VAULT_MONITOR_UNAVAILABLE`. All reports include `currentEnforcement: NOT_CHECKED` and `processLiveness: NOT_CHECKED`. Neither a recent stored record nor a lock file is used to claim that a worker, issuer or monitor process is running.

## Findings

| Code | Local evidence and response |
| --- | --- |
| `SCREENING_DUE` | Retained active/review or source-observed pending record is due, or has no prior screening timestamp. Run the approved screening workflow; this monitor does not run it. |
| `ISSUANCE_UNRECONCILED` | Old pending record has no retained successful source observation. Inspect the original issuance journal/transaction; do not create a replacement automatically. |
| `HUB_MATERIALIZATION_PENDING` | Old pending record has source observation but no completed materialization state. Investigate original source-to-hub propagation. |
| `REVIEW_RECORD_AGE` | A review-state record is older than the selected threshold. This is **record age**, not time since entering REVIEW, reviewer assignment or a customer response deadline. |
| `RETAINED_RECORD_OUTSIDE_SCREENING` | An active/review/pending record is still retained but its effective retention deadline has elapsed, excluding it from the normal due set. Investigate legal retention and service/credential disposition; do not delete or extend retention automatically. It does not prove a live on-chain credential. |
| `BLOCK_WITHOUT_REVOCATION` | A blocked record has no outbox item. Investigate legacy recovery or missing delivery linkage. |
| `REVOCATION_OVERDUE` / `REVOCATION_ERROR` | Unconfirmed local outbox work is too old or carries a diagnostic. Reconcile its original transaction/nonce. No raw diagnostic payload is printed. |
| `HUB_OBSERVATION_MISSING` | Source-confirmed job has no retained full observation after the selected interval. Use the approved exact case checker. |
| `HUB_OBSERVATION_STALE` | Last stored observation is too old, even if it said ENFORCED. Recheck current chain state. |
| `LAST_OBSERVATION_AWAITING_HUB`, `...SUPERSEDED`, `...INCONSISTENT` | Last complete retained observation was not ENFORCED. Inspect that case; this report has not queried its current state. |

Threshold boundaries are inclusive. Effective retention includes existing extensions; a hold prevents deletion but does not automatically change the rescreen deadline. Source-confirmed outbox records are inspected even after their personal evidence record has been erased. A confirmed source job is not silently called hub-enforced, and a later negative observation does not disappear behind an older positive one.

Output contains state/code totals, ages and case digests, not raw record/job IDs, subjects, wallet addresses, evidence, signed bytes, vendor references, error text or operator labels. The digest convention matches the case checker's `ethers.id(job.id)` for revocation entries; record entries use their own record ID and are labeled separately. Digests are correlation identifiers, not anonymization. Detailed findings stop at 100 while full counts and a truncation flag remain available. The monitor still reads the entire file-backed vault; this is not a scalable database scanner or complete privacy audit.

## Verification

Six root tests cover lifecycle distinctions and exact thresholds, retention exclusions, revocation errors, missing/stale observations and supersession, invalid/future state, complete counts with bounded/redacted output, effective retention extensions, byte-identical real vault reads and no directory creation for missing files. An actual CLI subprocess verifies redacted exit-1 findings, explicit thresholds, exit-2 failures and no mutation.

The existing local two-chain rescreen case also monitors its real encrypted outbox: pending work crosses the selected synthetic warning threshold; after the recorded local ENFORCED observation there are no local findings but current enforcement remains NOT_CHECKED; advancing the monitor clock to the freshness boundary reports the old observation as stale. These test thresholds/timestamps are synthetic, not approved customer limits or measured public latency.

## Deployment work still required

This command has not been scheduled or connected to paging. The T-03 [rescreen outbox runbook](20-rescreen-outbox-operations.md#scheduled-one-shot-evidence-and-local-alert-boundary) now adds a separate durable one-shot run record and missed/stalled/failed rescreen-run monitor, including the zero-case boundary. It does not prove that this vault monitor, the worker monitor or either external scheduler ran. Worker/store/queue liveness, source/hub lag, signer balance and nonce coordination, current sanctions-generation health, durable deduplicated alert delivery, owner/escalation routing, authenticated access, 7-day staging metrics and approved restart drills remain T-17. Cross-store issuance-journal inspection and case review timing/authorization remain T-20. The vault snapshot cannot infer any of those.
