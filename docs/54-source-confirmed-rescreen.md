# T-20 — Rescreening while hub propagation is pending

2026-09-07. **IN_PROGRESS.** Local issuance/vault/outbox lifecycle integration. No production scheduler, current official list refresh or public-chain enforcement claim.

## Closed gap

Previously, an approved issuance stayed pending in the evidence vault until exact CC3 materialization was observed. The rescreen due set included only active/review records. Consequently, even a successfully confirmed source issuance could remain outside periodic screening while propagation was delayed.

The vault now retains a `sourceIssuance` observation containing the source chain ID, contract, transaction hash and first observation time. The production delivery path invokes this sink only after the existing EVM transport verifies a successful receipt, matching issuance event, consumed request, confirmation depth and block binding. Pending/reverted receipts do not invoke it. The observation is persisted before the journal transitions to source-confirmed. A missing required vault is an error, not a successful acknowledgement.

The original evidence hash binds the observation to the retained request. Malformed fields, a conflicting transaction/deployment and an observation before record creation are rejected. Replay of the same transaction preserves the first observation, screening history and compliance state. No raw transaction or new identity data is copied into this metadata. This is an internal trusted-sink method, not an independent RPC verifier or public attestation API.

Pending records with this observation now join the existing due set, subject to the configured interval and retention deadline. Unsigned or broadcast-unconfirmed pending records remain excluded. The observation does not reset the original screening timestamp, so overdue records remain due. A new observation changes the record snapshot and conflicts with an already-running stale rescreen; identical acknowledgement replay does not.

## Compliance state is not propagation state

Source confirmation does not activate the record. ALLOW preserves pending; REVIEW enters review; BLOCK enters blocked and atomically queues the existing durable revocation job. After REVIEW, either automated ALLOW or explicit operator clearance returns a source-observed record to pending until the separate materialization callback records `hubMaterialized: true`.

Materialization still checks matching evidence and preserves a newer REVIEW/BLOCK. Its acknowledgement is historical, not current eligibility. A delayed successful issue relay therefore cannot erase the rescreen BLOCK or its revocation job. Consumers must still evaluate the Registry; the system does not claim that a queued or source-confirmed revocation is already enforced on CC3.

New revocation jobs created from source-observed records carry that source chain/contract. The CLI checks this target before preparing a signature and refuses a different configured deployment. Legacy jobs, and jobs created before a source observation existed, remain unbound and require operator reconciliation. Existing prepared transaction validation remains in place. These additions do not grant signer roles or coordinate another process sharing the same nonce; the dedicated rescreen signer requirement remains unchanged.

## Recovery and rollout

If a source observation write fails, the delivery step cannot report a new source-confirmed phase. It preserves the original signed transaction and records the existing fixed dependency diagnostic. Resuming checks that transaction again and repairs the vault write; it does not sign a second issuance. A crash after the observation committed but before the journal save is also recoverable by idempotent replay. The two stores are still not one atomic database transaction.

Existing nonterminal source-confirmed journal entries can gain the observation through normal receipt-verified resume. Do not populate it from an old status response, caller assertion or a changed timestamp. A journal entry that is gone, a missing vault, a source reorg or a superseded mark can require operator investigation. The observation is a historical receipt observation, deliberately not a claim of permanent canonicality; it is not automatically erased after reorg, since that must not silently remove screening coverage.

The optional encrypted-record fields do not require a format migration. Old writer/runner versions ignore this coverage and must not remain active in a deployment claiming it. No operational backfill or deployment was performed. Retention controls still govern the due set: an elapsed retention deadline can exclude a record even if a credential remains live, and that separate policy/lifecycle gap remains open. A no-vault sandbox keeps only the issuance journal and does not gain the file-vault rescreen service.

## Verification scope

Seven added root tests cover source-observation write failure before/after simulated commit, same-transaction recovery, no observation for pending/reverted receipts, actual encrypted-vault source-pending → rescreen BLOCK → late materialization, required-vault failure, interval and REVIEW/clearance lifecycle, evidence/deployment binding, idempotent replay, stale snapshot conflicts and revocation target rejection. Journal, AML and chain/transport behavior in these unit tests is synthetic.

The existing connected HTTP/Redis/vault/two-Anvil integration now additionally verifies that the signed-save failure has no source observation and is outside the due set, the actual successful source transaction is retained with matching hash/chain/contract and becomes due while pending, and actual local relay/resume records hub acknowledgement. Its native proof verification remains mocked. Its final manual revoke is still not an outbox-driven revocation; that test does not certify the entire T-20 institutional workflow.

The later [local enforcement integration](56-local-rescreen-enforcement.md) makes an exact AML list-version change bypass the ordinary interval whenever the runner executes. Remaining work includes installation of an approved list watcher/scheduler and authenticated alerts, review ownership/deadlines and authenticated approvals, high-risk suspension policy, source-to-hub revocation operations, appeal/notification/reissue flow, retention-versus-live-credential policy and real operational drills.
