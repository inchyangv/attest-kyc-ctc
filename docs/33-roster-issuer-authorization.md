# Issuer authorization of roster roots (T-07)

2026-09-07 KST. Local implementation and regression evidence, not an independent audit or deployment record. Historical public contracts and epoch records were not changed.

## Security boundary

An epoch publisher's permission to submit a root no longer authenticates arbitrary issuer addresses inside that root. For an accepted roster membership, the leaf's issuer must have authorized that exact root and epoch at the source. This applies even to a policy with `trustedIssuer = address(0)`; wildcard selects any authenticated issuer, not an unsigned issuer.

`ComplianceSource`, `ProofmarkASC` and `ProofmarkRegistry` advertise `ROSTER_AUTH_VERSION() == 1`, distinct from roster format 2, epoch schema 2 and atomic receipt processing 2. Registry construction checks ASC compatibility. Worker startup checks source/ASC; shared SDK/publication/record guards reject missing or unknown authorization versions. Existing unsigned epochs cannot be relabelled into compliance.

## Source approval protocol

Two source entry points exist:

- `publishEpoch` retains the six epoch-v2 arguments, requires **both** publisher and issuer roles, and authorizes only `msg.sender`. The transaction is that issuer's approval. A root containing other issuer names may still be published, but those leaves cannot pass membership validation.
- `publishEpochForIssuers` adds `RootApproval[] { address issuer; bytes signature; }`. It requires the publisher role and 1..16 approvals in strictly increasing numeric issuer-address order. Each issuer must currently be authorized; duplicate/zero/unknown issuers, invalid signatures and signatures over 4,096 bytes revert the whole publication. The publisher does not need an issuer role on this path.

EIP-712 domain: `name = ProofmarkRoster`, `version = 1`, actual source chain ID, and the source contract address as `verifyingContract`. The type is exactly:

```text
RosterApproval(uint32 epoch,bytes32 root,uint32 listVersion,uint40 validUntil,uint40 sourceCutoff,bytes32 snapshotId,address publisher)
```

The issuer approves all seven fields, including the submitting publisher. Different root, epoch, list version, expiry, cutoff, snapshot, publisher, source or chain produces a different digest. The contract sets the actual publication timestamp and enforces epoch monotonicity and T-09 time bounds; a valid signature cannot override them. There is no separate arbitrary signing deadline: publication is limited to one hour after cutoff and must precede the signed expiry. Simultaneous plans for the same epoch compete; once one is published, another needs a new epoch and fresh approvals.

EOAs use OpenZeppelin 5.4 `ECDSA.tryRecover`, including low-S and signature-length validation. Contract issuers use ERC-1271 `isValidSignature` through a static call, requiring the ABI-encoded magic result. This implementation deliberately uses that Shanghai-compatible subset: the same package's general `SignatureChecker` pulls an ERC-7913 dependency using Cancun `MCOPY`, incompatible with this project's EVM target. No EVM version was silently changed and no ERC-7913 support is claimed. Contract issuers are trusted code; their execution/return-data resource use still needs operational constraints and independent review.

Each validated issuer emits `RosterIssuerAuthorized(epoch, root, issuer)` before `RosterEpochPublished` in the same source receipt. ASC accepts the root only if the complete proved receipt contains matching trusted-source authorizations: exact topic/data layout, matching epoch/root, nonzero 160-bit issuer, no duplicates, at most 16. A separately proved approval, foreign lookalike, or approval for another root cannot authenticate the epoch. Storage writes and all other lifecycle events in the receipt roll back together on invalid authorization.

The ASC retains `epochIssuerApproved(epoch, issuer)`. Registry roster-cache and membership paths require it, in addition to existing root, freshness, policy and tombstone checks. Previous epoch approval does not carry into the next epoch. ERC-1271 validity and issuer roles are checked at **source publication**, not re-queried from the hub later. Removing a role or disabling a contract wallet after publication does not retroactively erase that historical approval.

## Operator workflow — requires separately authorized deployment/publication

T-18 update: publication now requires a [receipt-cross-checked source snapshot](38-source-roster-snapshot.md). The verified deployment transaction anchors the full scan; the finalized cutoff and snapshot manifest are printed in the signing plan and rechecked on publication. Old approval plans lacking this manifest must be regenerated. Source replay no longer treats the delayed hub Active set as a completeness oracle.

1. Provision reviewed source/ASC/Registry contracts and dedicated roles as an explicit administrative operation. The publication script never grants a publisher role, even if the signer is owner. `EPOCH_PUBLISHER_PRIVATE_KEY` is the only accepted publisher key; there is no deployer fallback.
2. Obtain a valid T-27 v3 sanctions generation. Run `--dry-run` with explicit `EPOCH_PUBLISHER_ADDRESS` and destination variables exported in the shell. Dry-run does not load `.env`, read a key or write a transaction. It prints the roster and a JSON plan containing EIP-712 domain/types/value/digest, cutoff block/hash, required issuers and entries.
3. Each issuer independently reviews the roster, its own credentials and the referenced snapshot, then signs the typed data using its controlled signing system. Save only the JSON object from the output and add `approvals: [{issuer, signature}, ...]`. Shape-valid JSON alone is not authenticated approval. Keep signatures in the controlled operations channel; do not add real signing files to the repository.
4. Supply that file as `EPOCH_APPROVALS_FILE` to an authorized `--publish`. The CLI caps input at 256 KiB, checks source/chain/digest binding, rebuilds at the signed cutoff block, rechecks its hash/time, current snapshot and next epoch, and requires coverage of every rebuilt leaf issuer. Any drift requires a newly reviewed plan; signed fields must never be patched to make old approvals fit.
5. The CLI compares its digest to the source getter, performs `staticCall` for current role/signature validation, checks freshness again, then sends one publication transaction. On-chain validation still governs races after simulation. It records approved issuer identities, not raw signatures. A signer that is itself the sole issuer may use implicit approval without a file; other issuer leaves require the signed plan.
6. Wait for the independently running worker and verify the actual hub root and approvals. Records include `rosterAuthVersion: 1`; the read-only epoch verifier checks every entry issuer's approval at the same observation block as its other verdicts. Version labels and JSON `approvedIssuers` alone are never evidence of chain approval.

This work did not execute `--publish`, change a public role, use real issuer signatures or deploy contracts. The earlier EU HTTP 500 still prevents a successful real T-27 generation; the tool must not bypass that with stale historical XML.

## Local evidence and limits

Seven Solidity tests exercise publisher impersonation under issuer-specific and wildcard policies; a fresh current root with an independently valid Merkle inclusion whose named issuer did not approve; every signed field/domain binding; wrong signer, role removal, duplicate/empty/unsorted approvals and replay; ERC-1271 acceptance/rejection and historical validity; multisigner publication and no cross-epoch authorization; and missing/standalone/foreign/malformed/wrong-root receipt approvals. Positive tests relay logs actually emitted by `ComplianceSource`, through the receipt decoder with a **mocked proof precompile**, not real Attestcoin finality.

Three TypeScript tests cover typed-data binding, bounded/exact envelope validation, coverage/sorting and compatibility guards. A compiled-ABI test pins function/event layouts. The existing isolated Anvil issuance test now also compares the TypeScript digest with the real deployed source getter, signs it with a synthetic issuer, simulates and mines the publication, checks authorization/epoch events, and rejects replay. No external chain is involved.

The 2026-09-07 revalidation ran the Appendix B counterexample against an isolated repository HEAD: a publisher-created, fresh root and valid inclusion naming an unsigned trusted issuer produced **0/1 expected regression passes** because the old Registry returned true. The current causal regression produced **1/1**, the complete authorization contract suite **7/7**, TypeScript/compiled-ABI authorization tests **4/4**, isolated source-EVM issuance **1/1**, two-EVM gate **1/1**, and epoch publisher/worker integration **2/2**. The default suites passed Solidity **110/110** and TypeScript **489/489**, with root typecheck and Solidity formatting also passing. These are synthetic/local results only.

The remaining boundaries are important:

- **T-06 is not solved.** Global subject storage and lifecycle revocation/denial authority are unchanged. An issuer can still interfere with another issuer's shared subject slot. Choosing institution-isolated deployments versus a new multi-credential namespace remains a separate product/protocol decision.
- A signature approves the entire root, not a cryptographic proof that every leaf was previously issued or freshly rescreened. An issuer must review its own portion before signing. A compromised or dishonest trusted issuer can approve false attributes; signatures do not make due diligence correct.
- **Absence remains a publisher-set assertion.** Non-membership proves a gap in the current committed set, not issuer-specific revocation, legal sanction, completeness or consent from every omitted issuer. A publisher can publish a different validly authorized subset and disrupt availability. This patch prevents positive impersonation, not omission/negative cross-issuer denial of service (T-06/T-18).
- Role removal blocks future publication while removed, but role regrant can re-enable an unused, still-timely signature. There is no authority-generation nonce or emergency retroactive root cancellation. Key rotation/invalidation and compromise response remain T-12/T-23.
- Finalized source construction, signed-plan distribution, managed keys, issuer review workflow, transaction-envelope durability for this standalone CLI, public cross-chain propagation and independent cryptographic review remain to be implemented or authorized. Do not infer production readiness from local passes.
