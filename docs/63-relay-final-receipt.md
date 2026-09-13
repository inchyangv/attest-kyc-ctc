# T-15 / T-16 — Recheck relay receipt before releasing its nonce

2026-09-07. A reproduced local finalization race, fixed and covered by synthetic and actual Anvil regressions. This is not permanent finality; later T-16 work adds detection and a signing fence, not automatic state repair, after an already-released deep hub reorganization.

## Reproduced gap

The relay sender previously read a sufficiently deep canonical receipt, awaited an independent source guard and (for success) the ASC processed-query read, then marked the job done/dead and removed its signed envelope. It did not re-read the receipt after those intervening awaits. A hub reorganization in that interval could invalidate the old receipt while the sender still released the nonce. A reverted receipt was especially exposed because that path does not require `processedQueries=true`.

A new regression first failed on the old code: removing the synthetic hub receipt during the awaited source guard still produced `done` instead of retaining `submitted`. The same test covers success and revert after the fix.

## Corrected boundary

After the source guard and any successful-query read, the sender performs a fresh transport receipt check. It requires the same terminal status, block number and block hash as the earlier observation. Missing, shallow, relocated or changed receipts leave the original envelope/job/nonce reservation pending. A changed observation does not trigger a replacement signature, terminal history entry or automatic release for the next job.

The EVM transport validates safe nonnegative receipt heights and a full block hash; rejects invalid/decreased/shallow head samples; verifies canonical block number/hash and re-reads that canonical block after the depth sample. Thus an old block response paired with a later head response is not accepted without another block-hash check. The final sender check runs that transport validation again after the other asynchronous work.

Immediately before synchronous Store finalization, the sender also checks its worker stop signal and persistent source safety hold. A stop/hold arriving during the final hub read cannot free the reservation. These checks introduce no additional await between that final local fence and the Store write. The worker passes its existing abort signal; the sender's preparation/broadcast formats and original envelope are unchanged.

This adds RPC reads on terminal reconciliation paths. It does not make RPC responses trustworthy against a malicious provider, atomically lock a chain against reorganization, pin all source/hub reads to one shared instant or guarantee that the chain will not change after the last observation. Existing confirmation depth remains a risk margin. The later T-16 startup/poll/signing audit rechecks already-completed jobs and confirmed skips, and persistently holds on a deep fork. Actual correction after source-to-hub finality violations or canonical ASC rollback still needs approved policy/reconciliation.

## Verification

Three new root regressions cover receipt disappearance during source checks for success/revert; changed final status/height/hash, concurrent stop and persistent source hold; and EVM block-hash re-read plus invalid numeric/depth observations. They use the actual Store/sender/transport with synthetic chain responses and assert no terminal history or envelope release on uncertainty.

The existing real Anvil relay integration now also mines a reverted transaction to the configured two-block depth, then performs `evm_revert` and mines an alternate history while the sender awaits its source guard. The job remains submitted with its original hash; another job cannot acquire its nonce. Reopening the Store and replaying the same signed bytes obtains a new actual reverted receipt at a different block hash; only that new confirmed observation dead-letters the job and releases the consumed nonce. This extends one existing integration test, not another test count.

The actual worker SIGKILL/restart integration is rerun separately to check that both before-forwarding and accepted-but-unacknowledged recovery still work with the additional receipt reads. Native proof remains mocked in that separate worker drill. The subsequent [confirmed-query skip change](64-confirmed-query-skip.md) covers the distinct unsigned already-processed path. The later [hub recovery audit](26-source-checkpoints.md) detects released receipts removed by a real local Anvil reorg. Production latency, provider consistency and operational state repair remain open.
