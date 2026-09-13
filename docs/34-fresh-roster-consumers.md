# Fresh-roster gating for storage-only assets (T-08, partial)

2026-09-07 KST. Local implementation and synthetic outage evidence only. T-08 remains `IN_PROGRESS`: no public migration, approved customer exposure limit or measured rescreen-to-hub operational SLA exists.

## Why this change is needed

An individual Direct proof authenticates past issuance, not the absence of a later undelivered revocation. With a stopped worker, Direct credential expiry and policy `maxAge` remain the only old cache deadlines. Separately, `requireRoster=true` existed but `isVerified` could not use a proved roster membership without a new Direct issuance or a hypothetical ASC materialization path. The asset only called `isVerified`, so the stricter policy did not provide a usable token workflow.

The Registry now exposes `ROSTER_WITNESS_VERSION() == 1` and `cacheRosterWitness(subject, mark, inclusion)`. This permissionless call checks the same current-root inclusion, issuer approval, root freshness and tombstone as proof mode. It stores the witnessed epoch and exact mark fields. It does **not** write the ASC's Direct mark, source cursor, origin, revocation or permanent denial state. An arbitrary caller cannot supply different attributes/issuer/subject under the same proof. Cache storage does not itself claim the mark passes any consumer policy.

For a policy requiring a roster, `isVerified` reads that witness and rejects missing/old epochs, expired roots, unapproved issuers and tombstones, then applies the common attribute/kind/issuer/credential-age predicate. There is no Direct fallback. A new epoch requires new proof delivery even if its root is identical; this avoids silently renewing previously cached assertions. A current proof can be submitted by the holder or another payer, without issuer signing keys. All decision reads inside a transaction share the same chain state.

For a policy **not** requiring a roster, the original Direct semantics remain. This is explicit lower-assurance behavior, not a global repair of Direct revocation freshness. Generic integrations must choose their policy accordingly.

## Asset and tool changes

New `GatedRwaNote` construction requires all of: existing frozen policy, `policyRequiresRoster(policyId) == true`, and Registry witness capability 1. Freezing prevents later substitution of a Direct policy under the same ID. Normal transfer, transferFrom, mint, holder burn and recipient checks use the existing `_update` gate. T-13 removed owner-only `forceTransfer`/`forceBurn`: new recovery requests seal the action and reason hash, require a distinct approver and delay, and recheck a transfer recipient at execution. This local mechanism is not legal recovery approval; see [governance limits](84-denial-correction-recovery-governance.md).

The deployment script's **new** production/pilot policies now set `requireRoster=true`. Their 30-day/7-day credential-age limits are unchanged and separate from the maximum 24-hour root lifetime. No existing frozen policy, deployment manifest, public token balance or contract was modified. Deployment and public proof delivery require their own authorization and migration review.

`pipeline/roster-witness.ts` provides capability checking and pure calldata encoding from a versioned epoch record. It rebuilds the root, checks the subject exists and creates the size-bound inclusion proof. A file is not authoritative chain state: simulation and execution on the intended Registry still check the actual current root. The SDK neither loads keys nor submits transactions. The [consumer example](../examples/consumer/README.md) separates encoding, simulation and explicit wallet submission. The web issuance UI does not yet automate this new phase; issuer source success must not be displayed as asset eligibility (T-24/T-36/T-39).

## Time guarantees and assumptions

T-09 already fixes `validUntil <= sourceCutoff + 24 hours`; source publication must occur within one hour of cutoff. Hub relay time and witness-cache time do not restart this clock. If publisher/issuer/worker cease advancing the accepted root at cutoff C, all normal gated asset actions fail at its expiry, no later than C + 24 hours, even when the credential itself lasts months. No caller can revive that expired root by delivering the same witness again.

This is a protocol ceiling for an outage, **not** an approved risk limit or a complete sanctions reaction measurement. If a publisher keeps issuing fresh roots without actually rescreening, the signature/time checks alone do not detect that dishonesty. Source snapshot completeness and per-member review remain T-18/T-20/T-27. Global issuer interference remains T-06. Proof/chain integrity and validator timestamps remain assumptions. Consumers can choose a shorter signed epoch lifetime, but this patch does not invent a customer-approved 24-hour SLA.

For normal operation, measure these timestamps separately: list publication/verified retrieval, next subject screening, review decision, source submission/confirmation, proof availability, hub canonical confirmation and witness delivery. The reaction budget includes screening interval + decision/submission delay + attestation/relay + consumer refresh. Publishing a smaller number in a dashboard is not evidence of this bound. A future live outage exercise must disable the real worker and publisher, retain source/hub receipts, and exercise the exact deployed asset at and beyond its deadline.

## Local evidence

The existing ten token tests now use authenticated source epoch publication, decoded receipts with a **mock proof precompile**, and real Registry inclusion verification/cache writes before asset operations. Five additional tests cover:

- frozen Direct policy rejected at new token construction;
- actual source `revoke` event deliberately not relayed, while no new epoch is published: Direct still passes at the old credential age, but token transfer/mint/force-transfer recipient fails at the exact 24-hour cutoff deadline;
- proof cached one second before expiry does not renew time or rewrite Direct origin/source height;
- new epoch, same-root renewal and empty-set publication invalidate old witnesses; altered issuer/subject cannot replace a valid witness;
- credential `maxAge` and subsequent tombstone are reevaluated at use time, independently of root freshness.

T-07's impersonation test additionally checks that the unsigned-issuer leaf cannot be cached, while the correctly approved leaf enables the storage consumer. Three TypeScript tests cover encoding/roundtrip, legacy/corrupt/absent-record rejection and capability mismatches; a compiled ABI test pins the SDK to Registry layout.

The connected two-EVM regression now snapshots both local chains after a real source epoch and witness delivery, mines an actual source revocation, then deliberately performs no relay or further issuer/publisher transaction. At the exact recorded `validUntil`, the long-lived Direct control policy remains true while the roster-only token's `isVerified`, preview and actual transfer fail; balances remain unchanged. Removing the roster branch and restoring Direct fallback in an isolated pre-fix copy makes the focused outage regression fail **0/1**; the current focused regression passes **1/1**. The full two-EVM integration passes **1/1**. The connected browser integration also reaches witness-gated transfers with synthetic users and local wallets **1/1**, but witness submission is test orchestration rather than a shipped end-user refresh flow. None of this is real Attestcoin native proof propagation, public-chain operation or a customer-approved outage SLA.

Remaining work: approved shorter risk profiles where required, real source-to-hub timing/outage measurement, production witness distribution/availability/cost, wallet UX and end-to-end asset workflow, independent review and explicit legacy asset migration. The historical public Direct-mode token remains unchanged and must not be advertised as bounded by this new path.
