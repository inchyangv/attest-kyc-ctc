# Credential schema 0 and typed policy schema 2

Working-tree specification, 2026-09-06; T-11. Not a deployment, certification of KYC equivalence, or proof that the issuer performed the claimed checks.

## Attribute vocabulary

The original eight-field bytes32 layout and fixed Solidity/TypeScript vector are retained. `ATTRS_SCHEMA_VERSION() == 0` explicitly identifies that layout; all low 64 reserved bits must be zero. There is no fallback decoder for nonzero reserved bits or future versions.

| Field | Accepted positive credential values | Meaning/limit |
|---|---|---|
| kind | 1 individual, 2 entity | A sanction is not a positive credential kind; use denial lifecycle events |
| assurance | 1–5 | Issuer-assigned grade, not cross-regime equivalence |
| regime | 1 KR live-rail procedure, 2 KR sandbox procedure | Only these codes are implemented; country codes such as 410 are not regime IDs |
| jurisdiction | 1–999 | Numeric wire range only, **not** validation of membership in an ISO country list |
| methods | Subset of `0x001f07ff` | Defined identity bits 0–10 and screening bits 16–20; unknown bits fail |
| issuedAt | Positive uint40 | Source rejects future issuance; consumers reject it even with maxAge 0 |
| expiry | uint40 strictly greater than issuedAt | Source rejects expired issuance; consumers reject expiry at or before now |
| epoch | uint32 | No new interpretation of epoch/provenance; roster freshness is separately checked |
| reserved | Exactly zero | Unknown schema extensions cannot silently disappear during decoding |

`MarkAttrs.pack` and TypeScript `packAttrs` are representation utilities, not semantic approval. Solidity input types enforce widths; TypeScript checks safe integers and widths. `unpackAttrs` requires exactly bytes32 but remains a raw decoder. `validCredentialAttrs` and `MarkAttrs.validSchema` enforce the vocabulary; optional/current-time checks distinguish historical schema validity from validity for a new issuance. The pipeline checks its final packed attributes before returning an approved outcome.

The source applies both shape and current-time checks in `issue`, `issueOnce` and every `issueBatch` entry. Invalid `issueOnce` does not consume its request ID; a bad batch item reverts the whole source call. Adding a new regime/method/version needs explicit reviewed schema and deployment changes rather than a made-up code. Entity kind support is a protocol type, not an implemented KYB adapter or legal acceptance of an entity under an individual KYC procedure.

## Historical source receipts and fail-closed state

A previously deployed source may have emitted malformed attributes. ASC v2 advances the ordinary cursor and sets the subject to suspended/tombstoned for unsupported schema, preventing an older valid mark from continuing to pass. It does not revert other lifecycle events in that receipt: a denial sharing the transaction must still apply. A later valid ordinary issuance can cure suspension, but cannot clear denial without the separate T-13 governed correction receipt.

ASC decoding does not substitute the hub timestamp for a proven source timestamp. It can materialize a structurally valid historical future-dated mark, but Registry rejects future issuedAt at evaluation time. New source issuance forbids future timestamps at source execution. This is not retroactive proof that every old source respected source-time validity.

The new Registry constructor requires an ASC advertising attribute schema 0 and atomic receipt version 2. This avoids treating the historical ASC—which discarded reserved bits without schema checks—as a schema-enforcing cache. Advertised versions are compatibility checks, not bytecode auditing or authentication of the deployer.

## Policy binding and ABI

`POLICY_SCHEMA_VERSION() == 2`. The existing Policy tuple and `policies(id)` ABI remain unchanged; the immutable credential-kind binding lives at `policyKind(id)` and emits `PolicyKindBound` when registered.

- `registerPolicy(p)` retains the legacy call shape but always binds kind 1 (individual).
- `registerPolicyForKind(p, kind)` explicitly binds 1 or 2. Zero, sanction kind 3 and unknown kinds are rejected; no kind wildcard exists.
- `updatePolicy` can change non-frozen requirements but cannot change kind. Ownership transfer also cannot change kind. A different kind requires a new policy ID; consumer migration must be explicit.
- Registration and update reject unknown method bits, assurance minimum above 5, regime above 2 and jurisdiction above 999. Invalid registration does not consume a policy ID. Caller-supplied `exists` remains ignored.
- Direct and roster paths use the same packed-attribute policy predicate, including kind, shape, issuer, future time, expiry and age. Unknown mark origin is not treated as Direct.

The deployment script explicitly registers both production and sandbox policies for kind 1. It was syntax-checked, not executed. Existing frozen on-chain policies do not acquire a kind binding or these checks automatically.

Permissionless policy registration intentionally permits other wildcards. Zero `requireAll` requires no method, minAssurance 0 adds no grade floor, maxAge 0 removes the age ceiling but not expiry, regime 0 accepts both supported regimes **including sandbox**, jurisdiction 0 accepts any supported numeric jurisdiction, and zero trustedIssuer accepts any issuer admitted by the underlying path. Direct provenance does not establish continuing revocation freshness. These are explicit consumer choices, not schema errors or recommended production defaults.

`pipeline/policy.ts` exports the typed ABI, `validatePolicy`, `policyWarnings` and `requirePolicySchema`. An integration must check schema versions, read `policyKind` as well as the legacy tuple, display the kind and warnings, and verify immutable policy contents before binding an asset. The read-only consumer in `pipeline/consumer-verdict.ts`/`examples/consumer/check.ts` pins Registry and ASC runtime hashes, checks all supported schema versions, and reads `policyKind`, the frozen legacy tuple and the Registry verdict at one rechecked block. `pipeline/onchain-state.ts` and the on-chain page expose the typed kind and refuse to manufacture a current-schema explanation for legacy or inconsistent state. The local CLI, rendered page and two-EVM gate are examples, not evidence that an independent consumer accepted the policy or that the typed contracts are deployed publicly; those remain release gates under T-36.

## Compatibility table

| Producer/consumer | Supported meaning |
|---|---|
| Historical source/ASC/Registry | Historical permissive validation; version selectors may not exist. Do not infer schema enforcement |
| New source + schema-0 bytes | Supported vocabulary and source-time checks; original byte vector unchanged |
| New ASC + historical malformed receipt | Suspended positive credential; other receipt lifecycle events still processed |
| New Registry + old/unknown ASC | Construction fails; no silent cache fallback |
| New Registry + new ASC | Explicit individual/entity policies; both Direct and roster validate schema |
| Nonzero reserved bits / future attrs or policy version | Rejected or unconfirmed; requires explicit migration |

Roster format version 2, attribute schema 0, transaction processing version 2 and policy schema 2 are independent identifiers. A v2 roster proof alone does not establish typed-policy support. Preserve historical manifests and regenerate release evidence against the intended addresses. See [migration](19-security-migration.md).

## Evidence and remaining limits

Solidity and TypeScript retain the same known packed vector and test the same 16 invalid mutations: reserved low/high bits, unknown/sanction/zero kind, assurance limits, regime limits, jurisdiction bounds, unknown method bits, zero issuedAt and non-increasing expiry. Contract tests exercise source entry points, malformed receipt suspension, denial sharing that receipt, wildcard Direct rejection, **valid inclusion proofs of invalid roster attributes**, and positive entity/negative individual policy matching. Policy registration/update rollback and kind persistence are covered. SDK tests include future/expired time, unsafe numbers, wildcard warnings, schema gates and compiled ABI comparison.

The exact Appendix B counterexample (`now=1000`, `issuedAt=2000`, `expiry=3000`, `maxAge=0`) is a permanent Direct-consumer regression. With only that test added to the isolated committed baseline it failed **0/1** because the future check was conditional on `maxAge`; the current implementation passes **1/1** and first proves that the historical receipt reached the ASC as an active mark. Current focused results are schema/ASC/Registry Solidity **61/61**, typed-policy SDK/consumer/compiled ABI **13/13**, local two-EVM consumer/gate **1/1**, and rendered on-chain page **1/1**. Web lint and production build also pass. These are synthetic/local checks with a mocked native verifier, not deployment or native-proof evidence.

No claim is made about ISO membership, legal regime suitability, issuer honesty, publisher authenticity/completeness, real KYB, human assurance calibration or revocation SLA. Those remain separate tickets. Native proof-system E2E, independent review, approved release deployment and public live-state verification against those exact release addresses remain required before rollout.
