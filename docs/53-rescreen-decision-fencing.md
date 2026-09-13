# T-20 — Stale rescreen decision fencing

2026-09-07. **IN_PROGRESS.** Local file-vault concurrency protection, not an institutional review workflow or proof of source/hub enforcement.

## Confirmed race

`screenDue` reads eligible records and then awaits the AML engine. The vault's existing exclusive writer lock reloads current data before a write, but previously applied the old screening result unconditionally. An operator could BLOCK a record and queue a revocation while the engine was pending; the delayed ALLOW could then replace the retained state with active. Two screening callers could also apply results based on the same old record. Reloading prevents lost file writes, but does not establish that an asynchronous decision still applies.

## Change

`recordRescreen(id, event, expected)` now requires the exact retained record snapshot from before screening. `screenDue` supplies its original snapshot, not a fresh read after the response. Inside the exclusive writer lock, the vault reloads disk and compares the complete record structurally. A changed or erased record, wrong record ID or missing snapshot produces the fixed `RESCREEN_RECORD_CHANGED` error before any mutation or flush. The error contains no subject, evidence or screening payload.

Comparing the full record detects an operator clearance that leaves state active, equal-time screening results and additional review history. Unrelated records can change without invalidating this one. No snapshot hash or personal record is published or added to API responses. Existing encrypted records need no schema migration; callers must adopt the new required argument. Old writer processes do not gain this check automatically and must not remain active during rollout.

Fresh snapshots are not authority to clear terminal blocked/rejected records by automatic screening. Those states now reject rescreen commits. An ALLOW on a pending record keeps it pending; screening alone cannot certify hub materialization. Decision timestamps must be safe nonnegative integers and must not precede creation, the previous screening or retained operator decisions; unknown decision values are rejected. Wall-clock rollback therefore fails closed instead of backdating a new decision.

A conflict stops the screening pass with an error. It does not automatically rerun the engine, adopt a fresh snapshot or claim that the rejected result was committed. The publishing CLI already delivers committed revocations in its screening `finally` block, so a later failure does not discard earlier BLOCK outbox entries. An operator should reconcile the retained decision and outbox before choosing a new run. The read-only preview remains a point-in-time assessment and never reserves or commits its result.

## Local verification

Five added root tests use synthetic identities, a mock engine, separate vault instances and controlled deferred responses:

- Delayed ALLOW and BLOCK each conflict with concurrent operator clearance or blocking, including identical timestamps and active-to-active transitions. Encrypted bytes and outbox remain unchanged by the rejected commit.
- Two asynchronous screenings of the same snapshot at the same timestamp cannot both commit, even when both would leave state active.
- An approved deletion while screening is pending is not undone; the stale BLOCK cannot resurrect personal data or create an outbox job.
- An unrelated record write does not conflict. A later record conflict preserves an earlier committed BLOCK and its deliverable outbox entry.
- Missing/wrong snapshots, invalid/backdated decisions, terminal states and pending ALLOW behavior are checked explicitly.

The fake revocation transport in these tests verifies the local outbox protocol, not a real receipt or hub update. Existing retention and materialization tests continue to use explicit snapshots for synchronous rescreen commits.

## Remaining boundaries

This is not a database migration, distributed fencing lease, authenticated reviewer identity or two-person approval. Concurrent human decisions still need case-level authorization/versioning. Retention controls and outbox delivery metadata are separate from the compared record; changes to them do not themselves invalidate a screening result. The whole encrypted vault still uses the existing single-host writer lock and requires operator recovery after a crashed owner.

The subsequent [human-review revision protocol](65-human-review-fencing.md) adds a separate case/outbox/retention-bound version check for human commits. It does not change the automatic rescreen snapshot scope above or supply reviewer authentication/two-person approval.

The subsequent [source-confirmed rescreen change](54-source-confirmed-rescreen.md) adds receipt-observed pending records to the due set and distinguishes clearance from historical hub acknowledgement. REVIEW can still leave an existing on-chain credential usable. Source receipt confirmation is not hub propagation, clearance does not reissue a credential, and no appeal notifications or institutional SLA are added. Closing those gaps requires the remaining T-20 workflow and deployment work. No current official list fetch, live vendor call, public transaction or production deployment was performed for this change.
