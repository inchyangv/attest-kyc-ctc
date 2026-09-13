# Source finality, checkpoints and fork recovery

Working-tree implementation, 2026-09-07. T-16 local safety implementation, with additional T-15 relay guards. No public-chain transaction, deployment or production state migration was performed.

## Scan contract

Cold start requires the explicit source deployment/replay block and the scoped state described in [relay recovery](25-relay-recovery.md). The scanner pins the block immediately before that start as its initial hash anchor. Existing jobs/cursors without source checkpoints are refused; a new hash is not retroactively assigned to legacy observations.

The scan ceiling is `min(RPC finalized height, latest height - WORKER_CONFIRMATIONS)`. A confirmation count alone is not treated as finality. The source RPC must support `finalized` and the historical blocks/logs required by the configured replay range. Missing finality stops processing; it does not silently fall back to latest head.

Each bounded range verifies its previous checkpoint, reads its end block, and checks each returned log's source address, block hash, removal flag and transaction coordinates against canonical block reads. It rereads both range boundaries, finality and head after fetching logs. Only a consistent range is committed: jobs, cursor and end hash share one atomic Store mutation. Jobs retain source block hash and transaction index, not only transaction hash. Empty ranges also receive checkpoints.

The Store retains the initial anchor plus 128 recent range-end checkpoints. It is not an archive of every header. These checks trust the configured RPC's canonical answers; they do not independently prove ancestry, prevent a dishonest RPC response, or detect silently omitted logs (T-18).

## Recovery decisions

| Observation | Action |
|---|---|
| Checkpoint block missing / RPC failure / finality unavailable | Stop without deleting jobs or treating uncertainty as a confirmed fork; retry after the provider is healthy |
| Stored checkpoint hash differs from the canonical block, no active tasks | Find the newest retained common checkpoint and inspect every affected job |
| Affected jobs are unsigned and have no recorded query/relay outcome | Atomically rewind cursor/checkpoints and remove those orphaned jobs, retaining their tx hashes in a rewind audit; rescan canonical history |
| Same source transaction reappears in a different block/index | Recreate the unsigned job with its new hash/height/index; recompute its query from the new proof coordinates |
| A fork is detected while tasks are executing | Stop and drain first; restart with the same state before attempting the unsigned rewind |
| Any affected job has signed/submitted relay data, relay history, a query ID, or a done/skipped outcome | Persist `SOURCE_REORG_TOUCHES_RELAYED_JOB`; preserve all jobs and signed bytes; require operator reconciliation |
| No common retained anchor can be established | Persist `SOURCE_REORG_BEYOND_VERIFIED_ANCHOR`; do not guess a new start or erase history |
| State has no hub signer baseline | Persist `HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION`; the worker never treats an absent file as an authorized first start |
| Canonical signer nonce is ahead of retained terminal history, including an old backup | Persist `HUB_SIGNER_NONCE_DIVERGED`; do not sign or scan from the restored file |
| A released terminal receipt or its exact block/query result is no longer canonical | Persist `HUB_TERMINAL_HISTORY_NOT_CANONICAL` or `HUB_TERMINAL_QUERY_NOT_CANONICAL`; stop before another signature |
| A persisted already-processed skip loses its exact block/query observation | Persist `HUB_SKIP_OBSERVATION_NOT_CANONICAL`; do not silently requeue or continue |

The conservative query-ID rule also holds jobs whose query was recorded but whose broadcast is not established. Availability does not take priority over retaining a potentially consumed source coordinate.

The worker checks each job's source hash/finality before and after attestation. The proof-derived transaction index must equal the scanned index. Relay guards recheck source readiness around preparation, durable signature storage, broadcast and terminal receipt application. A known fork after signing preserves the envelope and blocks further sends.

Before initial scan, each poll cycle and each new signature, hub recovery walks every retained terminal relay receipt and confirmed skip at its recorded block/hash. It rechecks successful `processedQueries`, requires current confirmation depth, and compares the dedicated signer's latest/pending nonce with the contiguous retained nonce history. A terminal result removed after its nonce was released therefore blocks the next signature instead of letting a later nonce conceal the reorganization. These are point-in-time checks; a fork after the final read is still possible. ASC/native proof validation remains a separate trust boundary.

The long-running worker never auto-creates a signer baseline. `npm run worker:init-state` is the separate, one-time read-only bootstrap: it requires the configured Sepolia/CC3 IDs, ASC source/chain binding, an otherwise unused state, and both latest and pending nonce zero for the dedicated signer. It acquires the normal state/signer leases and sends no transaction. A missing baseline, restored pre-baseline state or nonzero signer requires reconciliation. This makes total state loss fail closed even when a previously signed transaction is not currently visible to the RPC.

## Operator procedure

1. Preserve the exact scoped state and lock metadata, with restricted permissions. Do not paste raw signed transactions into tickets or logs.
2. Confirm the previous process is stopped/fenced before recovering its lease. Follow [relay ownership recovery](25-relay-recovery.md); time elapsed is not proof that a process is dead.
3. For provider uncertainty, verify canonical history and finality with an approved healthy source. Restart with unchanged scope/state. Do not clear a cursor to bypass missing archive data.
4. For unsigned forks within retained history, restart the same state. The scanner performs its checks before dispatching restored jobs and records any authorized rewind itself. No hand-edited success flags are needed.
5. For a persistent source hold, keep relay disabled. Reconcile the original source block/tx/index, old query, exact signed hub transaction, receipt canonicality and `processedQueries` at explicit blocks. A source rescan alone cannot undo a CC3 mark, consumed query or cumulative denial. Determine whether an authorized new deployment/history replay is required before consumers resume.
6. For a genuinely new deployment with a zero-nonce dedicated signer, run `npm run worker:init-state` once under the deployment manifest, then remove initialization access before starting the service. Do not use this command to replace a lost or held file.
7. For lost/corrupt state or an unscoped/held legacy file, reconcile signer/KMS signing history and existing hub outcomes before creating any replacement state. There is no automatic state-loss restoration or hold-clear command. Restore from a verified backup only under a reviewed procedure that accounts for transactions signed after that backup; an old backup alone does not establish safe nonce ownership.

## Reproduction and limits

`npm run worker:test` includes eight source-scan cases over the real file store: finalized cold start, unsigned relocation, signed fork hold, processed-query preservation, drain-before-rewind, inconsistent range/finality responses, unavailable checkpoint and pre-anchor/legacy-state rejection. Relay tests additionally inject source failures after preparation and after durable signing to verify that neither path broadcasts unchecked bytes. Recovery tests cover missing baseline, stable exact receipt/skip replay, stale nonce history, removed terminal receipt, unresolved-envelope nonce allowance and unknown pending nonce use. `monitor:worker` reports missing baselines and persistent hub holds without exposing their raw reasons.

`npm run test:source-reorg` starts a private Anvil Sepolia-ID chain with test-only keys and the actual `ComplianceSource`. It scans a finalized revocation, reverts a local snapshot, and includes the **same signed transaction** in a different block. A reopened Store rewinds unsigned history and records the new canonical coordinates. CI runs this separately from the normal unit suite. This does not call Attestcoin or the native verifier and does not demonstrate CC3 rollback after a source finality violation.

`npm run test:t16-recovery` starts a private Anvil CC3-ID chain with test-only dedicated signers and the relay receipt fixture. It proves three restart boundaries against actual RPC state: a released receipt is removed by `evm_revert`, a pre-second-transaction state backup is restored while the signer remains at nonce two, and a state file is lost after its signer consumes nonce zero. Each case persists the corresponding hub hold and refuses readiness. It neither repairs ASC state nor authorizes a replacement signature.

T-16 remains `IN_PROGRESS`: local detection/fencing is implemented, but an authorized restoration after lost signing records, correction of an already-consumed source fork, and repair of ASC/consumer state after a deep hub reorg remain governance and deployment work. The repository cannot reconstruct unavailable signed bytes or reverse canonical contract state. T-17/T-21 still need managed ownership/fencing, independent KMS signing audit, off-host immutable backups, restore drills and operational alert delivery. A checkpoint/reconciliation implementation is not an HA or finality guarantee.
