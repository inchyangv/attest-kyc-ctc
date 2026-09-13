# T-23 / T-40 — An epoch counter is not a carry receipt

2026-09-07. The publisher previously treated `latestEpoch >= intendedEpoch` as acceptance. It then tried to find an acceptance log, but a missing log or lookup error fell back to the poll timestamp. Its final check could even load a different newer epoch's record. A superseded/skipped publication could therefore receive apparently successful propagation evidence without its own acceptance being established.

## Corrected behavior

`pipeline/epoch-carry.ts` scans for the exact intended `EpochAccepted` after the pre-publication hub height, in 500-block windows with a 20,000-block total bound. Exactly one matching event is required, with the intended root/expiry. Its actual successful receipt must target the configured ASC and contain the matching acceptance and `EpochProvenance` for cutoff/publication time/list version/snapshot. The fetched event and receipt agree on transaction/block/hash/log identity.

The hub transaction must be a direct ASC `execute` on the correct hub chain, with action 3, source chain key 1, the original source receipt's block height and transaction index derived from the supplied Merkle sibling directions. The corresponding processed query must be true at the acceptance block. Block hash/depth are checked again after that query. This reconciles RPC evidence and source coordinates; it does **not** independently validate the encoded native proof or authenticate dishonest RPCs. Wrapper/smart-account hub calls are not inferred as equivalent to the current worker's direct call.

`EPOCH_HUB_CONFIRMATIONS` defaults to 6, must be a positive safe integer and is validated before the fresh source send. No matching event or insufficient/currently changed confirmation remains unconfirmed. A higher epoch counter without this publication's confirmed carry raises `EPOCH_HUB_SUPERSEDED_UNCONFIRMED`; it does not authorize a new source signature. Lookup/malformed evidence errors do not produce a poll-time acceptance fallback. Source confirmation remains in the journal/derived source record.

Only an observed matching receipt yields `hubCarry` with its transaction/block/hash/timestamp/depth/query/source coordinates. Propagation is the source publication block timestamp to that exact hub receipt block timestamp, not the time polling happened. The final publication check must still inspect the same epoch; it refuses to substitute a newer epoch's record. Before final record/snippet output it also rechecks the carried receipt/block identity, then the existing common-block observation. Source-only projection strips old `hubCarry` with other hub observations.

These checks are point-in-time observations, not irreversible finality, production latency percentiles, per-member screening truth, complete issuer consent, or a permanent eligibility guarantee. A source publication that was once accepted may already be superseded; its historical carry and current eligibility are different results. Operational handling of a superseded publication, longer archive scans and independently authenticated proof ancestry remain separate work.

## Executed evidence

Three new root tests use controlled receipt/ABI fixtures: exact successful carry and same-block processed query; missing/shallow acceptance and final depth/hash regression without timestamp invention; duplicate/wrong acceptance, missing provenance, reverted receipt, wrong source coordinates, unprocessed query and invalid scan bounds. The current-epoch guard rejects switching from epoch 1 to 2. Record projection coverage now includes removal of old carry metadata.

The actual fresh publisher/worker integration verifies that `hubCarry.transactionHash` is the worker's persisted hub transaction, the query ID matches its job, and the source coordinates match the original accepted source receipt. Native verification and proof-service data remain synthetic as described in [the connected worker test](78-fresh-epoch-worker-integration.md).

An additional actual CLI branch restores only its owned synthetic list bytes after the existing tamper test, stops the worker, and publishes source epoch 2. A separate loopback proxy falsely reports `latestEpoch=3` while the real hub remains at epoch 1 and has no epoch-2 acceptance event. The CLI exits 1 with `EPOCH_HUB_SUPERSEDED_UNCONFIRMED`. The source epoch-2 record retains its source hash but has no carry, acceptance time, propagation or check result. The publisher has nonce 3 (fixture issuance plus two intentional epoch transactions); the worker stays at nonce 1 and never relays the second publication. This is an injected counter inconsistency, not a real public skipped-epoch claim.

The existing integration is extended, not counted as another suite. No public transaction, production journal/record, official list or operator-approved deployment was changed. The complete goal and external proof/operational approvals remain unresolved.

For delayed relay or an interrupted publisher, [read-only publication recovery](80-read-only-publication-recovery.md) now checks the original journal entry and carry without a private key or another source send. It requires an explicit bounded hub scan start and does not turn source-only recovery into an implicit full success.
