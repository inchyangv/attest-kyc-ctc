# Atomic lifecycle receipts (T-10)

Working-tree specification, 2026-09-06. Not a deployment or independent audit. Historical ASC v1 and its worker do not implement these semantics.

## Why the old restriction failed

The source separates `issue`, `revoke`, `deny` and `publishEpoch` into functions, but an allow-listed issuer contract can call several functions inside one Ethereum transaction. That includes smart-account and multisig composition. The old ASC filtered logs by the caller-provided action and permanently consumed a transaction-scoped query ID. One permissionless execution could therefore omit another action forever. Repeated issuance to the same subject also chose the first log in the ASC but the last log in the roster builder.

## Version 2 contract

`ProofmarkASC.TRANSACTION_PROCESSING_VERSION()` returns `2`. The existing `execute(action, ...)` ABI, event signatures and query ID derivation are unchanged. The receipt must be successful and the proof must still match the configured chain/source. An action outside 0–3, or an action with no matching trusted source event, reverts.

An action actually present is only a hint. The ASC walks **all** recognized lifecycle logs emitted by the configured source in their original receipt order, applying them in one atomic execution. Foreign logs, including identical event signatures, confer no authority and are ignored. A malformed recognized trusted log rolls back every change and query consumption. Permissionless callers cannot select a harmless event to suppress a revoke or denial.

Ordinary subject state is ordered lexicographically by `(source block height, source transaction index, receipt-local log index)`. Each later transaction resets the log-position part of the cursor. Issuance/revocation duplicates within one transaction therefore use the final ordinary event. Permanent denial is independent and cumulative, so no subsequent issuance in the same or a later transaction clears it. Existing materialization event shapes remain unchanged; `lastAppliedLogIndex(subject)` exposes the added coordinate.

| Source receipt order | Result after any present action hint |
|---|---|
| issue → revoke | Revoked |
| revoke → issue | Active unless permanently denied |
| issue → deny → issue | Denied |
| issue A → issue B for the same subject | B's mark |
| epoch 1 → issue → epoch 2 | Both epoch roots visited, latest epoch 2, issuance applied |
| stale epoch → denial, proved after a newer epoch | Newer epoch retained, denial still applied |

Each epoch log is processed. Epochs not greater than the accepted latest epoch emit `StaleEpochSkipped` rather than reverting the whole receipt. The source still rejects non-increasing publication at issuance time. This distinction is necessary because valid source transactions can be proved out of order: an old epoch must not poison delivery of a denial sharing that receipt. Epoch root validity, snapshot completeness and publisher authority remain T-07/T-09/T-18 work.

## Worker and roster alignment

Worker preflight requires exactly processing version 2. Missing, unavailable or unknown versions fail closed before dispatch. The source scanner groups recognized source logs by transaction and queues one job, including mixed action kinds. It picks the first log's action as the hint, records all event names and log count, and no longer classifies mixed receipts as dead merely because they are mixed. The authoritative execution still uses the full proven receipt, not the scanner's event list.

The publisher's candidate selector is shared in `pipeline/source-order.ts`. Source RPC `logIndex` is block-global, so `(blockNumber, logIndex)` sorts ordinary events in the same order as the ASC triple. The last issuance is only a candidate: the publisher still checks CC3 status, tombstone and exact mark before including it. A later revoke/deny is not an active roster entry. This does not prove complete RPC history or freshness.

## Migration, not an in-place patch

1. Review this semantic change together with roster v2 and monotonic denial. Record the reviewed release hash and local/live test evidence separately.
2. Deploy an authorized new ASC, verify processing version 2, source pinning and bytecode, and pair it with the intended new Registry/policies. Existing contracts are not proxies.
3. Replay and reconcile source history from a verified deployment block, including all logs of formerly mixed transactions and all denials. Reconcile latest epoch and ordinary cursors at a finalized cutoff. Do not initialize only from active marks.
4. Use a separate worker state file scoped to the new ASC. Preserve old state and inventory `dead` jobs with action `-1`, mixed event names, and transactions whose old query was already consumed. A retry against v1 cannot recover omitted logs. Do not reset or delete old replay state to manufacture successful reconciliation.
5. Compare source receipt order, new ASC status/claims/coordinates, and generated roster candidate/inclusion or exclusion for mixed and duplicate cases. Exercise a real smart-account transaction and the actual proof service before enabling batching in a deployment.
6. Update consumers and monitoring only after the broader migration gates in [security migration](19-security-migration.md) are satisfied. The default publisher continues to send standalone publication transactions.

The source function ABI itself does not prohibit composition. Until the new ASC is deployed and reconciled, maintain the operational prohibition against mixed transactions on the historical sandbox. Updating only the worker makes it fail closed on v1; it is not a backwards-compatible worker rollout.

## Local evidence

`test/ProofmarkASC.t.sol` uses a real deployed local `ComplianceSource` and an allow-listed `ComposingIssuer` contract to generate logs from composed calls, encodes those receipts, and executes the ASC with the explicit mock BlockProver. It tests issue/revoke in both orders and with either action hint, denial precedence, repeated batch subjects plus repeated calls, multiple epochs, stale epoch with denial, foreign lookalikes, atomic rollback and replay protection. Existing out-of-order denial permutations remain in the suite. This tests processing logic, not the native proof verifier or production multisig integration.

`worker/source-events.test.ts` tests the production grouping function with encoded mixed logs, reversed RPC order, duplicate subjects, multiple epochs, foreign/operational logs and version-gate failures. `pipeline/source-order.test.ts` tests the actual publisher selector with duplicate and cross-block ordering.

`test/atomic-receipts.test.ts` deploys two isolated Anvil chains and a real allow-listed `T10ComposingIssuer`. The contract writes duplicate issuance, issue→revoke and two epoch transitions as three composed source transactions. A real worker child process finalized-scans and groups those receipts, fetches them through the production HTTP boundary, and relays them to ASC v2. The test then compares ASC methods/claims/status/log coordinates and epoch roots with a deployment-anchored roster cold replay of every source receipt. The proof response and native verifier are explicit local mocks; the fixture contract exercises smart-account-equivalent composition but is not a deployed Safe or production multisig.

The remaining release gate is a real Safe/multisig receipt through the actual proof service and native verifier on the approved public CC3 release, followed by roster reconciliation. It also requires a new authorized ASC/worker/Registry deployment and replay of historical mixed `dead` jobs and already-consumed v1 queries; local tests do not authorize or perform that migration.

No live transactions, contract deployments, role grants, worker processes or external service changes were performed for this change.
