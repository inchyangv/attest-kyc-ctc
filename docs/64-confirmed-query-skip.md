# T-16 — Confirmed, block-bound already-processed skip

2026-09-07. Local implementation and regression evidence. This concerns unsigned jobs seen as already processed by another relay, separate from finalizing this worker's own signed envelope.

## Previous gap and single decision path

Both `worker.process()` and `RelaySender.step()` previously used a latest-state `processedQueries(queryId)` boolean to mark a job permanently skipped. A third party's transaction could still be shallow or disappear while the worker awaited its source guard. Such a skip could strand a source event even though this worker had never reserved a relay nonce.

The worker-level direct skip is removed. The sender now owns the only new-job skip decision, using the configured hub confirmation depth and an exact observed block hash. Proof retrieval and query-coordinate validation still precede the sender; the change does not bypass source/proof identity checks. Gas estimation may run before a skip/wait, but estimation is read-only and no transaction is submitted for a shallow positive.

## Query observations

The EVM transport samples the latest head by number, reads its canonical block and query boolean at that number, samples head/depth again and re-reads the same block hash. Invalid/nonboolean/changed observations throw fixed diagnostic codes instead of being treated as an unprocessed query.

- A checked latest negative is `unprocessed`: the normal guarded preparation path may proceed. Another party can still race it later; this is not atomic exclusion between independent senders.
- A latest positive that is absent at `head - confirmations + 1`, or whose confirmation floor predates the ASC deployment, is `pending`. The sender returns without signing, skipping or consuming an attempt. The persisted job remains available to later polling.
- A positive at a checked confirmation-floor block is a `confirmed` candidate. After awaiting the source guard, the sender rechecks the **same** block number/hash, query value and sufficient current depth. It must still be confirmed. Stop/source-hold checks immediately precede synchronous persistence.

The job then receives `state: skipped`, its query ID and `skipObservation: {blockNumber, blockHash, confirmations, observedAt}`. Observation time is local milliseconds and confirmation count is the observed depth; this is not an inclusion transaction hash, proof of permanent finality or an operator approval. Block height/hash/status changes leave the unsigned job pending or fail with a retryable diagnostic, never trigger an immediate fallback signature on an uncertain positive.

Source readiness and signer reservation behavior are unchanged for an already-signed envelope. That path still reconciles its own original receipt and is not converted into this unsigned skip path. A third-party race after a checked negative, changed confirmation policy, unavailable historical state and malicious consistent RPC data remain separate risks. No cross-chain observation can atomically prevent a later chain change.

The T-16 recovery audit now rechecks every persisted skip's exact block/hash, depth and `processedQueries(queryId)` result before initial scan, each poll cycle and each new signature. A deep hub reorganization that invalidates the local skip installs `HUB_SKIP_OBSERVATION_NOT_CANONICAL`; it does not automatically requeue the source event or spend a nonce. Repair still requires approved reconciliation because another source/ASC outcome may already exist.

## Legacy state

Existing skipped jobs are not rewritten, silently granted a new observation or automatically requeued. `monitor:worker` flags `SKIP_WITHOUT_CONFIRMED_OBSERVATION`; malformed stored skip metadata is unavailable. A syntactically valid observation only removes that local metadata warning: the file monitor still says `chainState/processLiveness: NOT_CHECKED`. Operators must reconcile old skips against the correct source/query/hub history before approving any replay. This change supplies visibility, not an automatic migration or permission to spend another nonce.

## Verification

Four new root tests cover sender shallow/recheck/hash/stop/hold/stable decisions and retained skip evidence; latest versus confirmation-floor reads, not-yet-deployed floors and short chains; exact-block revalidation, forked/nonboolean/nonnumeric/insufficient-depth state; and legacy/malformed skip monitoring.

The existing Anvil relay test now submits a third-party transaction at one block depth with a two-block requirement. The worker sender neither skips nor allocates a nonce. After another block, an actual `evm_revert` during its source guard invalidates the confirmed candidate; the unsigned job remains. A new stable third-party transaction then produces a stored skip observation matching the actual canonical hash, still with relay nonce zero.

The actual worker crash integration also launches a separate fresh-state worker after each completed recovery. It sees the already-applied real source/ASC query, takes the new single skip path, persists a canonical observation and creates no additional broadcast or nonce. This extra fresh-state scan does request its own proof; the earlier crashed worker plus its recovery still make exactly one proof request together. Existing integration counts do not increase. Native proof/attestation responses in that integration remain explicit mocks.

Public proof/provider conformance, old-skip migration, post-persistence deep reorg state repair, operational deployment and staging SLA evidence remain open. Local deep-reorg detection and signing fence are covered by the recovery unit suite; the Anvil recovery integration covers released terminal receipts, stale backups and lost state.
