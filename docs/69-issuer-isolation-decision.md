# T-06 — Issuer isolation decision and executable acceptance probes

2026-09-07. **Decision pending. Current implementation is not an isolated multi-issuer credential service.** This is a proposed migration scope and locally reproduced limitation, not an approved protocol, legal sanctions model or deployment.

## Current executable evidence

Run the separate acceptance diagnostic:

```sh
FOUNDRY_TEST=script/diagnostics forge test --match-contract IssuerIsolationDiagnostic -vv
```

Current result: exit 1, **0 passed / 3 failed / 0 skipped**. The failure messages are:

- `T06: B issuance displaced A`
- `T06: B revocation disabled A`
- `T06: B denial disabled A`

The fixture deploys the actual Source, ASC and Registry locally, authorizes A and B through the Source owner, and creates separate consumer-owned policies trusting A and B respectively. A's actual `source.issue` event is captured and delivered through the ASC decoder. Before each case, A's policy passes and B's fails. B then issues, revokes, or denies using its actual authorized source method; the resulting actual event is relayed. A's policy no longer passes in all three cases. In the issuance case B's policy passes, but A's credential has been displaced. In the revoke/deny cases B never issued a credential for that subject.

These diagnostics assert the **desired isolation**, so they remain red until the design is fixed. They are deliberately outside the default `test/` directory, not skipped tests or green tests asserting unsafe behavior. Default local suite success does not include them and must not be presented as T-06 completion. After implementing the approved design, port the cases into the normal regression suite and retain their intent; do not change the assertions to accept cross-issuer interference.

The source logs are real local contract emissions. The receipt envelope and native verifier are explicit fixtures; this is not a public source/proof-service/hub integration or exploitation of public assets. Policies represent two consumers, not independently deployed customer applications.

## Why a mapping-only change is insufficient

| Boundary | Current behavior | Required change for independent issuers |
|---|---|---|
| Source role and events | Any `isIssuer` may issue/revoke/deny any subject. Only issuance logs carry issuer. `processedRequest` is keyed only by request ID. | Authenticate stable issuer identity on every lifecycle action, bind all events to a credential scope, separate any global-denial authority, and scope request replay without weakening transaction nonce ownership. |
| ASC lifecycle | `marks`, tombstone, permanent denial and three-part cursor are address-keyed. | Scope mark and ordinary restriction/cursor to issuer/credential/subject. A cumulative restriction must have an explicit scope; no silent promotion of B's local denial to network-wide denial. |
| Source history reconstruction | `pipeline/roster-source.ts` reduces all source events into one state per subject. | Replay the new exact scoped events, preserve independent credentials and scoped denial, and reject ambiguous legacy attribution. |
| Roster keys | `subjectKey` hashes EVM namespace and address; duplicate subject keys reject even when issuers differ. Issuer is only in the mark value. | Version the key domain/schema and commit issuer and credential class with subject. Define scoped membership/non-membership and full-set completeness. Never wrap old roots as new-format roots. |
| Registry and witness cache | `rosterWitnesses[subject]`, global tombstone precheck and one `getMark(subject)`; `trustedIssuer` filters that one mark. | Resolve an explicit credential scope from policy and use scoped witness/storage. Define multi-credential AND/OR selection separately; do not combine A/B method bits or assurance by accident. |
| Stable issuer rotation | `RotatingIssuer` forwards under its stable source identity; operational key epoch is separate. | Preserve institutional identity across key rotation. Do not use the changing EOA as credential namespace. Compromise cutoffs and historical invalidation still require T-12 design. |
| Issuance journal, vault and outbox | Journal target has issuer, but retained source/outbox target binds only source chain/address; revocation transport signs subject-only `revokeBatch`. | Bind stable issuer/class/subject into immutable evidence target, outbox ID/intent, signed call validation and receipt reconciliation. A dedicated revoker must have issuer-scoped delegation; granting global `isIssuer` is not isolation. |
| Worker, SDK, API and consumer | Shared event ABI, source matching, projections and proof endpoints assume existing subject/event format. | Version gate before startup/signing, update all decoders/ABIs and scope inputs, and show the exact issuer/class in evidence and consumer outcomes. Preserve full-receipt atomicity and query replay semantics. |

The existing T-07 root approvals authenticate positive membership claims but do not isolate the global subject slot, prevent issuer B's current lifecycle calls, or prove completeness of an issuer's omitted roster entries.

## Decision-neutral release guard

The current contract family now exposes its limitation to the release path through a fail-closed local preflight. `pipeline/issuer-isolation.ts` fixes the current issuer-scope capability at version 0. `script/deploy.sh preflight` requires `PROOFMARK_ISSUER_MODE` before any transaction and calls `script/check-issuer-mode.ts` with the derived stable issuer address.

- An unset or unknown mode is rejected as `ISSUER_ISOLATION_DECISION_REQUIRED` or `INVALID_ISSUER_MODE`.
- `independent-issuer-scoped` is rejected as `SCOPED_ISSUER_PROTOCOL_NOT_IMPLEMENTED`; a caller cannot turn the current global subject storage into an isolated release by configuration.
- `single-issuer` is accepted only for one non-zero stable identity with every declared consumer policy pinned to that identity. The deployment manifest records the chosen mode.

This guard does not make the three acceptance diagnostics green, select the product direction, migrate a deployment, or constrain the owner from later granting another issuer directly on chain. It is a release-time stop for this repository's deployment path, not an on-chain enforcement mechanism or evidence of production controls. If the user chooses independent issuers, the incompatible scoped implementation and all gates below remain required. If the user chooses the single-issuer product, on-chain role cardinality/rotation enforcement, existing deployment reconciliation and public-claim narrowing still require approval and implementation.

## Product choice requiring confirmation

Recommended for the stated multi-institution objective: **independent issuer-scoped credentials in a new incompatible release**. The alternative is an explicitly single-issuer product with enforced deployment/role boundaries and correspondingly restricted public claims. An unrestricted source role list with single-issuer documentation is not an enforcement mechanism. Separate institutional deployments can isolate deployments, but do not create one shared multi-credential namespace and require a separately designed consumer aggregation layer.

Proposed technical baseline for the multi-issuer choice, subject to approval:

1. A credential key commits version/domain, source chain/source contract, stable issuer, explicit credential class, and subject. Kind remains an independently validated schema attribute, not a substitute for class. Published format and domain constants must be fixed with cross-language vectors before deployment.
2. Ordinary issuance/revocation/reissuance and issuer-local denial affect only that scope. A signer cannot supply a different issuer identity without explicit scoped delegation. Revokers cannot issue credentials merely because they can revoke.
3. Exact-issuer policies select one class and issuer. Any wildcard or AND/OR composition needs an explicit bounded policy design and negative tests; no implicit OR of method bits, maximum assurance across credentials, or acceptance of an arbitrary latest slot.
4. Network-wide sanctions, appeals and release are a separate T-13 authority decision. Do not introduce unilateral global-denial or clearance powers for every issuer during this migration. Disabling a new global path until authorized is not permission to erase existing historical denial state.
5. Legacy denial/revoke events lack an issuer field. Do not infer the institution from the last mark, transaction sender (which may be a forwarder), or the current issuer role list. Historical restrictions require an approved migration classification; ambiguous subjects remain unavailable on the new consumer path until reconciled. Never initialize empty restriction state and call that a migration.

This document does not choose legal authority, sanction scope, quorum/timelock, credential class taxonomy, or consumer risk policy on the user's behalf. The outstanding user decision is the product direction; these narrower governance/policy choices must also be resolved before production use.

## Implementation and evidence gates after approval

1. Freeze the scoped schema, identity/delegation rule and compatibility versions. Add source/ASC signatures and encoding vectors, including forwarding and unknown-version rejection.
2. Change source actions and scoped storage/cursors together. Port the three red cases into normal regression tests. Check stale/duplicate/mixed receipt order per scope and rollback across multiple issuers in one receipt.
3. Update source reconstruction, issuer authorizations, roster key/proof construction and witness selection together. Test the same subject under two issuers and two classes in one epoch, independent revocation, replayed approvals and scoped absence.
4. Wire policy/SDK/API/issuance/vault/outbox/worker to the same immutable scope. Preserve journal CAS, signed raw/nonce recovery and source-versus-hub acknowledgement. Reject old outbox jobs without approved scope mapping; never auto-relabel them.
5. Validate two issuer identities and two consumer policies/apps: independent issuance coexistence, B cannot overwrite/revoke/deny A, local B restriction does not block A, A cannot impersonate B, no cross-credential assurance/method composition, exact class binding, key rotation under stable identity, stale/mixed receipt delivery, source/hub recovery, and roster/direct parity where each policy permits it.
6. Approve migration disposition for every existing mark/restriction/root/policy/asset; record old/new addresses, replay cutoff, credential-scope mapping and unresolved holds. Immutable old assets/policies require explicit replacement/migration authority, not environment-variable changes.
7. Obtain independent review, exact-build/runtime comparison and authorized public two-chain reproduction before switching consumers. Keep historical deployment evidence separately labelled and disallow legacy fallback.

No contract/deployment/role/asset migration was performed in this decision-preparation work. T-06 remains incomplete; the three failing acceptance probes are the authoritative local evidence of the gap.
