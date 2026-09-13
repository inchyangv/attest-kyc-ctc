# T-14 — Stateful lifecycle invariant and release-runtime boundary

2026-09-07. Internal local verification only. This is not an independent security report, a frozen release commit, native-proof validation, or approval to deploy.

## Internal finding and permanent counterexample

`PM-T14-01` (medium, fixed locally) was found by extending the lifecycle reference model through governed denial correction. With source order `denial(100) → correction(200) → revoke(300)` and proof arrival `denial → revoke → correction`, the ASC remembered only whether the source-later ordinary event was an issuance. The correction therefore collapsed a real revocation into `Suspended` instead of the source-ordered `Revoked` state. Both states fail closed for policy checks, so this was not an allow bypass, but the lifecycle state and audit reason were wrong.

`test_CorrectionDeliveredAfterLaterRevocationPreservesSourceOrderedStatus` is the permanent regression. Before the fix it failed **0/1** with status `4 != 2`; after the fix it passes **1/1**. `ProofmarkASC.latestOrdinaryStatus` now retains `Active`, `Revoked`, or `Suspended` while an active denial masks the visible state. The old boolean remains for ABI compatibility. A source-later correction restores `Active` only for a valid later issuance, preserves `Revoked` for a later revocation, and otherwise stays `Suspended`.

## Stateful models

`test/LifecycleInvariant.t.sol` now contains two independent Foundry handlers plus the deterministic regression.

The original fixed-history handler uses 48 receipts across 12 source heights, four transaction indices per height, and four subjects. Every receipt contains two trusted issue/revoke/deny logs, sometimes for the same subject, separated by a foreign emitter's forged denial. It checks cumulative denial, latest ordinary status, maximum source cursor, receipt-log order, foreign-emitter isolation, active commitments, atomic rollback, wrong-chain rejection, exact-coordinate replay, and repair after a failed attempt.

The generated-content handler seals a receipt's content on its first attempted coordinate and then randomizes both delivery and content. Across 32 coordinates it generates:

- four subjects and three synthetic issuer identities inside the current shared issuer namespace;
- valid and reserved-bit-invalid schema-0 issuance, revocation, denial, and correction;
- same-subject and cross-subject mixed receipts, a forged foreign denial, duplicate delivery, wrong-chain failure, malformed trusted second-log rollback, and exact-coordinate repair;
- an independent source-order reference for visible status, permanent denial, lifecycle and denial-decision cursors, tombstones, and active issuer/claims/evidence commitments.

Foundry uses `fail-on-revert=true`; only explicitly expected replay, wrong-chain, and malformed-topic failures are consumed. Each invariant runs 128 times at depth 64. Thus a fixed-seed run performs 8,192 calls per invariant and 16,384 total handler calls; these are not 16,384 independent scenarios, proofs, or audits. The source receipts and identities are synthetic and the native verifier at `0xFD2` is still `MockBlockProver`.

Reproduce the focused lifecycle checks with:

```sh
forge test --match-contract 'ArbitraryLifecycleInvariantTest|LifecycleInvariantTest|LifecycleOrderingRegressionTest' --fuzz-seed 0x20260907 -vv
```

## Local release-runtime compatibility

`pipeline/release-runtime.ts` and `test/release-runtime.integration.ts` add a fail-closed release boundary. The integration starts isolated chain IDs 11155111 and 102031, deploys the current `ComplianceSource`, `EvmV1Decoder`, linked `ProofmarkASC`, `ProofmarkRegistry`, and frozen-policy `GatedRwaNote` artifacts, then checks at pinned blocks:

- exact nonzero runtime codehash pins supplied separately from the artifact comparison;
- Solidity `0.8.30+commit.73712a01`, optimizer enabled with 200 runs, Shanghai EVM, `viaIR=false`, and the exact compilation target;
- all non-immutable runtime bytes against the Foundry artifact;
- the Solidity library self-address guard and every `EvmV1Decoder` link offset against the reviewed library address;
- source/hub chain IDs, block number/hash stability, nonempty code, and full contract addresses.

Immutable positions are masked only for artifact-shape comparison because constructor values are embedded at deployment; the separately required exact codehash covers those bytes. A negative case deploys an ASC linked to a different decoder and supplies that runtime's own exact hash. It is still rejected with `RELEASE_RUNTIME_BUILD_MISMATCH`, proving a self-consistent codehash alone cannot silently redefine the reviewed library scope. Run it with `npm run test:t14-runtime`.

The integration's exact pins are derived from its own disposable Anvil deployments. This proves the checker and current build agree locally; it does not create approved public-chain pins or independent release provenance.

## Proposed independent-review scope, not a completed engagement

The external reviewer must freeze a clean release commit and its dependency revisions, then review at least these boundaries. Current uncommitted working-tree content and a local source fingerprint are not a substitute for that commit.

| Boundary | Required review object | Existing local evidence |
|---|---|---|
| Source authority and events | roles, keyed issuer generations, root approvals, denial correction, event schema | `ComplianceSource.sol`, docs 04/33/37/84 |
| Proof and decoding | native verifier authenticity/arithmetic, query coordinates, replay ID, receipt decoder and malformed inputs | `ASCBaseX.sol`, `VerifierInterface.sol`, `EvmV1Decoder`, docs 05/09/23/36 |
| Hub lifecycle | receipt atomicity, source ordering, denial/correction, key compromise, epochs | `ProofmarkASC.sol`, the two stateful models |
| Consumer policy and assets | schema/time predicates, roster authorization/freshness, frozen policy, recovery controls | `ProofmarkRegistry.sol`, `GatedRwaNote.sol`, docs 24/32/34/35/84 |
| Relay and recovery | finalized source scan, proof transport, durable state, nonce/lease/reorg/final receipt | `worker/`, docs 25/26/59–64 |
| API, vendors, and private state | request bounds, configured-vendor fail-closed behavior, demo labels, consent/session, vault durability/deletion/fencing | `web/app/api`, `pipeline/adapters`, vault modules, docs 27/40–42/51/52/58/66/67 |
| AML and roster construction | official-source provenance/freshness, identity matching, complete source replay, witness availability | `aml/`, roster modules, docs 28–32/38/39/83 |
| Build and deployment | compiler/settings/dependencies, linked libraries, constructor immutables, exact runtime hashes and migration | runtime checker, docs 19/36/45 |

## Current local verification

On 2026-09-07 the deterministic counterexample failed **0/1** before the contract change and passed **1/1** afterward. The focused fixed-seed lifecycle command passed **3/3**, including both invariants at 128 runs × 64 depth with **16,384** aggregate handler calls and no unexpected reverts. The default suites passed Solidity **118/118** and TypeScript **496/496**, and root typecheck passed. The T-13 compatibility suite passed Solidity **20/20** and TypeScript/ABI **18/18**. The T-14 two-Anvil runtime integration, real source/worker/mock-native atomic-receipt integration, and broader two-EVM gate each passed **1/1**. Solidity formatting and repository diff whitespace checks passed. Web sources were not changed, so web lint/build was not run.

## Remaining limits and external gates

The generated model does not validate native proof arithmetic/authenticity, arbitrary RLP/decoder bytes, epoch publisher completeness, roster tree construction, wall-clock expiry, deep source/hub reorgs, API/vendors/vault, or token economics in one monolithic state machine. Those boundaries remain covered by separate local suites rather than being claimed as one exhaustive formal model. Three issuer values test state separation only inside the current shared namespace; they do not resolve T-06 independent issuer isolation.

T-14 remains `IN_PROGRESS`. Still required are a user-approved audit scope and clean release commit, an independent auditor and report with findings/severity, remediation of every critical/high, auditor re-verification, reviewed production compiler/library/constructor manifest, and read-only comparison against the exact deployed bytecode on both approved public chains. T-06 product direction and T-13 legal/governance approvals remain prerequisites. No production key, public-chain write, deployment, real identity, or real asset was used here.
