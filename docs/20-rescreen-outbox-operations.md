# Rescreen outbox: single-host pilot operations

Implementation status: 2026-09-07, local tests and isolated local-chain integration only. No operational vault, identity record, private key or public-chain transaction was used. T-03 addresses lost decisions; T-20/T-21/T-23 still cover the institutional lifecycle, managed storage and key management.

## Preview and commit are separate

`npm run rescreen` is a read-only preview. It does not update screening timestamps or states, queue revocations, purge records, create a vault directory or load a signing key. It reports previously queued work and legacy blocked records as well as new decisions. A preview is not an immutable approved batch: `--publish` re-screens with the then-current lists. A signed, reviewed batch-approval workflow remains necessary for an institutional deployment.

`npm run rescreen -- --publish` first recovers and delivers existing pending work, then screens due active/review records and pending records with a retained successful source-issuance observation. A changed exact AML list-version set is also a due trigger even while the ordinary interval is open; the engine's result must still match the version snapshot selected for that run. A BLOCK decision and its revocation job are saved in the same encrypted file replacement. BLOCK records no longer need to be in the due screening set to have their revocation retried. Records blocked by the old CLI without an outbox entry are recovered once. Review decisions that block a record also create a job; clearance cannot silently erase pending revocation work. Clearance after source confirmation does not reissue a mark or clear an ASC denial. See [source-confirmed coverage and rollout](54-source-confirmed-rescreen.md); unconfirmed pending records and legacy records without a recovered observation do not gain that coverage automatically.

The outbox progression is:

```text
BLOCK + pending (one durable write)
  -> sign locally
  -> prepared: encrypted signed bytes + exact hash saved before broadcast
  -> broadcast or re-broadcast identical bytes
  -> reconcile receipt by hash
  -> source confirmed (signed bytes removed; hash retained)
```

A timeout, RPC error or lost response preserves the same signed transaction and nonce. A new signature is allowed only before preparation or after a confirmed revert. Unknown pending work stops preparation of later jobs. Crashing after a successful broadcast but before saving confirmation therefore does not authorize a second logical transaction. One source transaction is used per outbox item to keep the recovery boundary unambiguous.

Source confirmation defaults to six confirmations (`RESCREEN_CONFIRMATIONS`). This is a configured depth, not an absolute finality guarantee. **It is not CC3 enforcement confirmation.** The [read-only per-case reconciliation command](55-revocation-reconciliation.md) now checks the exact receipt/cursor, current tombstone and selected Registry rejection at rechecked blocks. It does not update the outbox, prove consumer bindings or schedule alerts; those operational steps and deep reorg/replacement recovery remain release gates.

## Required configuration and key boundary

Use persistent local encrypted storage, `EVIDENCE_VAULT_PATH`, `EVIDENCE_VAULT_KEY`, `EVIDENCE_HMAC_KEY`, a matching `SOURCE_CHAIN_RPC_URL`, `SOURCE_CHAIN_ID` (default Sepolia 11155111) and `SOURCE_CONTRACT_ADDRESS`. `RESCREEN_PRIVATE_KEY` must belong to an authorized source issuer and must derive to the explicit `RESCREEN_SIGNER_ADDRESS` before RPC use. There is deliberately no fallback to the deployer key. Provision the role through the approved operational process; the CLI does not grant itself roles.

Do not share this signer with issuance, deployment or another nonce-producing process. The runner lock protects this CLI, not other programs using the same key. Changing source or chain configuration while signed jobs remain pending makes the transport refuse those jobs; reconcile the original deployment first. Production should replace local signing with an audited key service and a durable nonce coordinator.

No key or raw signed transaction is printed by the outbox inspection command:

```sh
npm run vault:admin -- outbox
```

The encrypted outbox still contains sensitive transaction capability until confirmation. Restrict the key, file and backups to authorized operators.

## File locking and crash recovery

Every vault mutation takes `<vault-path>.lock`, reloads the latest encrypted state under that exclusive lock, writes a random exclusive temporary file, fsyncs it, renames it atomically and fsyncs the directory. This prevents two long-lived instances from overwriting one another's unrelated updates. Readers observe an atomic old or new snapshot. Lock contention fails the operation; callers must retry rather than assume it committed.

The publication runner additionally holds `<vault-path>.rescreen.lock` across asynchronous screening and delivery, so two instances cannot prepare competing nonces for the same outbox. Lock files record PID and creation time. A killed process may leave a lock; the program never steals it on a timer. Before recovery, stop dependent jobs, verify the PID is not an active owner on that host, preserve an encrypted backup, reconcile any stored transaction hash, and have the operator remove only the exact stale lock. Never delete the vault or its outbox to clear an error.

This is a **single-host pilot constraint**, not distributed database transactions. Do not use it on ephemeral serverless storage or assume a shared network filesystem provides the same lock/rename/fsync guarantees. Managed transactional storage, KMS, backup restoration tests, access audit and multi-instance execution remain T-21.

## Scheduled one-shot evidence and local alert boundary

An external scheduler may invoke the exact one-shot command below. `--scheduled` is rejected without `--publish`, unknown/duplicate arguments are rejected before any run-state write, and the run-state path must differ from the vault and its locks.

```sh
npm run rescreen -- --publish --scheduled
npm run monitor:rescreen
```

Scheduled mode requires `RESCREEN_RUN_STATE_PATH`, an opaque deployment/run-scope-specific `RESCREEN_SCHEDULE_ID`, and a positive whole-second `RESCREEN_SCHEDULE_INTERVAL_SECONDS`. After acquiring the existing rescreen lease, it durably writes `running` before transport/list work. Completion atomically replaces that with a redacted `succeeded` record containing only due/BLOCK/source-confirmed/pending counts; a caught failure writes `failed` without provider text, case identifiers, addresses, paths, keys or signed bytes. A kill or host failure between those writes leaves `running`, so it cannot look like a completed pass. Status file fsync/rename failure makes the run fail rather than silently losing its execution evidence.

`monitor:rescreen` additionally requires `MONITOR_RESCREEN_RUN_SECONDS`. It validates the schedule ID and exact configured cadence, then reports `RUN_STALLED`, `LAST_RUN_FAILED`, `LAST_RUN_PENDING`, or `RUN_MISSED` at inclusive thresholds. Missed cadence is measured from the last start, not delayed by a long completion. Exit 0 means only a fresh local run record, exit 1 means attention, and exit 2 means unavailable/missing/invalid evidence. Every report states `alertDelivery: NOT_CONFIGURED`, `currentEnforcement: NOT_CHECKED`, and `vaultBacklog: NOT_CHECKED`. It does not decrypt the vault, query either chain, run screening, sign, recover a transaction, or deliver/acknowledge an alert. Run it alongside the separate vault and worker monitors.

This supplies a scheduler-compatible command contract and run-missed alert payload, not an installed cron/service, pager integration, deduplication, authenticated recipient, escalation owner or uptime proof. Those require an approved deployment and actual alert receipt exercise. A successful zero-case pass is now distinguishable from no pass at all, but only while this state path is durable and the monitor itself is scheduled independently.

## Retention boundary

As of 2026-09-07, neither preview nor `rescreen --publish` deletes records. The separate [approved deletion workflow](42-vault-deletion-controls.md) blocks evidence erasure while revocation is pending/prepared or a legacy BLOCK lacks source confirmation, and additionally checks retention, holds and current approval. The encrypted outbox retains request identifiers, wallet, timestamps, transaction metadata and operational status; it is not anonymous. Finished entries still retain hash/status metadata without signed bytes. Outbox diagnostic errors also require separate log/PII review. A legally approved retention duration, hold propagation and scheduled disposal for this operational metadata remain T-33; deleting an evidence record is not complete personal-data erasure.

## Tests and unresolved boundaries

`npx tsx --test pipeline/rescreen.test.ts pipeline/rescreen-schedule.test.ts pipeline/vault.test.ts pipeline/vault-retention.test.ts` covers the exact appendix-B dry→publish sequence, `PM-T20-01` edition-change trigger, byte-identical/missing-path preview, restart recovery, ambiguous broadcast, signer failure, mined revert, confirmation-persistence failure, legacy recovery, deletion blocked by unfinished work, stale-instance writes, lock contention, rollback on mutation errors, pending-review protection, schedule-state validation/atomicity/redaction, monitor exit 0/1/2 and the deletion controls described in the linked runbook. The schedule regression specifically proves that an empty due set cannot substitute for evidence that a scheduled pass ran. These unit cases use synthetic records and an injected transport, not a live vendor or public chain.

The [connected local enforcement case](56-local-rescreen-enforcement.md) now interrupts delivery after a real local source node accepts the signed revocation and before receipt recovery. A newly opened vault instance finds the encrypted original bytes/hash, confirms that exact transaction without signing or broadcasting again, then follows the exact receipt through local ASC enforcement and a rejected asset transfer. This is the local original-transaction recovery drill; it is not an approved operational drill.

The [stale-result snapshot fence](53-rescreen-decision-fencing.md) rejects a rescreen result if its retained record changed during screening. New outbox jobs with a source observation also pin their issuance deployment and reject signing for another configured source. Open gates include reviewed batch approval, concurrent human-review authorization, reissue/appeal state coordination, public-chain finality/reorg evidence, durable CC3 propagation acknowledgements, legacy unbound job reconciliation, dedicated signer deployment, durable database/KMS, installed scheduler/alert delivery and approved live failure drills. Unit/local-chain tests must not be presented as having completed these gates.
