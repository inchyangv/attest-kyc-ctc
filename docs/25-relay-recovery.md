# Relay nonce ownership and recovery

Working-tree implementation, 2026-09-07. T-15 local verification and partial T-16/T-17/T-23. No production worker was started or changed for this work.

## What changed

Proof preparation can run concurrently, but the relay sender has one unresolved hub nonce. A synchronous in-process reservation covers nonce lookup and signing. The exact signed bytes, hash, nonce, query ID, calldata, destination and signer are saved atomically with the source job's `submitted` state **before broadcasting**. No save success means no broadcast, even if a failed save response follows a committed rename.

The file store writes an exclusive random temporary file with mode 0600, fsyncs it, renames it, and fsyncs the parent directory. Mutations use snapshots; `get` and `pending` return detached copies. State-write failure causes the worker to stop rather than continue from a speculative memory state. This is a single-host persistent-filesystem design, not a managed queue, network-filesystem guarantee or proof of backup durability.

An unresolved relay envelope is a persistent signer gate. A different source job cannot sign until the original transaction has a checked canonical receipt at the configured confirmation depth. On restart, that job is prioritized and its original receipt is checked **before** waiting for attestation or fetching a new proof. Unknown outcomes rebroadcast the same signed bytes; they do not generate a new nonce or fee replacement.

| Observed outcome | Worker behavior |
|---|---|
| Signature-save failure | No broadcast; reload authoritative state on recovery |
| Broadcast response lost / RPC unavailable | Preserve signed envelope and `submitted`; retry same bytes |
| No receipt or insufficient confirmations | Hold nonce and source job; other jobs cannot sign |
| Successful canonical receipt and query processed at that receipt block | Atomically mark `done`, retain hash/nonce/block audit, release signer gate |
| Canonical confirmed revert | Mark original job `dead` for review, retain receipt audit, release consumed nonce |
| Different transaction consumed the nonce, original receipt missing | Do not infer success; retain original gate and require reconciliation |
| State/receipt/target mismatch | Fail closed, preserving the unresolved association |

Signed data is checked against chain 102031, the configured ASC, relay signer, nonce, hash, exact calldata and zero value. Receipt checks bind hash/from/to and canonical block hash; `processedQueries` is read at the receipt block before success. The default hub depth is six blocks, not a guarantee against deeper reorgs. Source-to-CC3 correctness still relies on ASC/native proof verification and source finality.

An unresolved nonce owner is not automatically moved to `dead` after generic retry exhaustion. A confirmed revert is not automatically retried with a fresh transaction. This favors safe reconciliation over availability; fee-bump/replacement/cancellation workflows and an operator dead-letter tool remain future operational work.

## Configuration and ownership

- `WORKER_PRIVATE_KEY` and its exact derived `WORKER_SIGNER_ADDRESS` are required and there is no `DEPLOYER_PRIVATE_KEY` fallback. Use a dedicated hub relay key, not a deployer/source issuer/rescreen key. No on-chain role is needed for permissionless `execute`, but the key needs authorized testnet gas funding.
- `WORKER_START_BLOCK` must be a positive, verified source deployment/replay start block. Zero/current-head fallback is removed.
- `WORKER_HUB_CONFIRMATIONS` defaults to 6. `WORKER_CONFIRMATIONS` remains the separate source scanning margin.
- State binds source chain 11155111, hub chain 102031, chainKey 1, source address, ASC address, signer and start block. Config drift fails closed. This release does not infer other chain mappings.
- An existing unscoped legacy state file containing jobs or a cursor is refused. It may contain a submitted transaction with no recoverable signed bytes; it must not be silently rebound or discarded.

The worker holds an exclusive state-file lease and a per-signer lease in the same state directory for its entire run. A second process using those paths cannot acquire ownership. These leases have no automatic expiry. Normal shutdown drains active work and releases them; a crashed process leaves a lock requiring verified recovery. A pending signed transaction remains in state regardless of lock lifetime.

**All instances sharing a relay key must use the same approved state/lease directory and persistent host.** Different directories, hosts, containers with isolated mounts or another program using that key are outside this lock's protection. Do not deploy replicas with the same key and independent files. Managed shared ownership/fencing or strictly separate keys is required before HA (T-17). Bounded job concurrency is not a fleet coordination mechanism.

## Recovery procedure for an authorized operator

1. Stop new issuance/relay scheduling for the affected signer as appropriate. Identify the exact state file, source/ASC addresses, chain IDs and signer. Preserve a restricted-access copy of state and lock metadata; raw signed bytes must not be pasted into public logs or tickets.
2. Check the lock PID against the actual process manager/host. Never remove a live owner's lock, and never assume elapsed time means an owner is dead. A surviving or partitioned worker must be stopped/fenced first.
3. Inspect only redacted envelope metadata: original source tx, query ID, hub hash, nonce, target, signer and job phase. Query the exact original hub receipt and canonical block, and compare latest/pending account nonce. A higher account nonce alone does not prove this query succeeded.
4. If the envelope and target scope are intact and the old process is conclusively stopped, an authorized operator may recover ownership and restart the same state/key/config. The worker checks the original receipt first and uses the original signed bytes. Do not clear the relay field or delete the state file to unblock the next job.
5. For unknown replacements, missing/corrupt state, unscoped legacy files or confirmed reverts, reconcile the account transaction history and `processedQueries` at explicit blocks. Keep the worker stopped until the original outcome and any replacement are accounted for. This repository does not yet provide an automated migration/fee replacement tool; use a reviewed operation with an audit trail, not hand-edited success flags.
6. For an authorized new deployment/migration, create a separately scoped state only after outstanding transactions on the old signer are reconciled or an isolated new signer is approved. Replay from a verified historical source block and reconcile all events/denials before enabling consumers. Retain the old state as evidence.

Never delete a state file merely to rescan history. It now contains a transaction journal, not only a replaceable cursor cache.

## Verification and limits

`worker/pool.test.ts` covers bounded synchronous reservations, repeat scans and a 120-job file backlog. Its permanent `PM-T15-01` regression holds concurrency 3 behind an unresolved RPC gate while scanning 1,000 jobs 100 times: only three reservations run, each once, and the pool reports zero memory waiters. The isolated pre-fix `inFlight`-after-wait scheduler produced 99,700 waiters under the same input. `worker/relay.test.ts` uses the actual file store with synthetic transport/failure boundaries: simultaneous submissions, pending signer ownership across reopened stores, save failure before/after commit, lost broadcast/confirmation-save response, revert, query skip, detached snapshots, target mismatch, cross-process exclusive file access and signed transaction tampering.

`test/relay-evm.integration.ts` starts isolated Anvil chain 102031 with test-only keys and a minimal receipt fixture, exercising actual signing/nonces/receipts, confirmation depth, restart, revert, pre-confirmation reorg and an unrelated same-nonce replacement. The fixture is explicitly **not** the ASC or native verifier. It tests the production relay transport, not proof-service correctness. CI runs this test after Foundry compilation.

The subsequent [actual worker crash drill](62-worker-crash-recovery.md) launches the production worker entry point against local source/ASC contracts and kills it before forwarding or after accepting its signed broadcast. It verifies lease refusal, exact-child-exit recovery and original transaction resumption. Native proof responses remain explicitly mocked; the test is not production takeover authorization.

[Final receipt reconciliation](63-relay-final-receipt.md) subsequently closes an observed read-to-finalization race: after source/query awaits, the sender must observe the same receipt status/block/hash again before releasing the nonce. A local Anvil reorg during this interval retains the original envelope until its replay has a new confirmed receipt. It does not guarantee finality after release.

[Confirmed-query skipping](64-confirmed-query-skip.md) separately replaces latest-boolean skip decisions for unsigned jobs with confirmation-floor/hash observations and a same-block recheck after the source guard. Shallow positives wait without signing; new skips retain their observation, while legacy skips require reconciliation.

The subsequent [source checkpoint implementation](26-source-checkpoints.md) adds finalized hash-pinned ranges, unsigned fork replay/transaction relocation, persistent holds for signed or consumed source forks, and source guards around relay signing/broadcast/finalization. It now also refuses implicit state bootstrap, reconciles contiguous signer nonces and retained terminal/skip observations, and detects/fences stale backups or deeper hub reorgs before another signature. It does not reconstruct lost signed bytes or undo CC3 state after a finality violation; authorized repair, managed HA, actual proof-service E2E, operator alerting and long-duration load/latency records remain T-16/T-17/T-21 gates. [Cooperative cancellation](61-worker-cancellation.md) now interrupts proof/attestation HTTP and polling/backoff while preserving the relay envelope. The sender does not wait indefinitely on `tx.wait`, and JSON-RPC requests have bounded request timeouts, but this is not a global shutdown or end-to-end processing deadline guarantee.
