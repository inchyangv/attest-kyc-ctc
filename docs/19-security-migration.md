# Security status and roster v2 migration

Updated 2026-09-06. This is a local implementation and migration specification, not a deployment record or an independent audit. The execution ledger is [TICKET.md](../TICKET.md).

## What is and is not fixed

The historical deployment in `deployments/cc3-testnet.json` still uses the vulnerable ASC and roster v1 registry. The review reproduced a false non-membership answer with `eth_call`; no transaction or token transfer was needed. Separately, a local regression demonstrated a late-arriving permanent denial being skipped behind a newer issuance cursor.

The working tree separates denial decisions from the ordinary issuance/revocation cursor. All 24 delivery orders of issue → deny → revoke → issue leave the subject denied. A stale denial does not rewind the ordinary cursor; subsequent ordinary events cannot erase it. T-13 now adds a separate source-ordered correction cursor: an issuer proposal for an exact replacement credential, a different configured approver and a delay produce `SanctionDenialCorrected` plus the replacement `MarkIssued` in one receipt. Late older denial proofs cannot override that correction, while a correction event without its replacement leaves the subject suspended. This local mechanism does not decide who has legal authority to use it; see [denial correction and recovery governance](84-denial-correction-recovery-governance.md).

The local migration regression also deploys a fresh `ComplianceSource` and linked `ProofmarkASC` on isolated Anvil chains. It materialises a newer issuance first, then has the actual file-journalled worker replay the older source denial. The worker is killed once before broadcast and once after the hub accepts the broadcast; after lease-controlled restart, both cases retain one signed relay, end in `Denied`, and preserve the newer ordinary cursor. The same assertion fails against the repository's pre-fix ASC, where the older denial is skipped. This uses synthetic identities, a local proof HTTP fixture and the mock native verifier; it is not a public-chain history replay, native-proof validation, deployment record or release approval.

Roster v2 separates hash domains, commits the leaf count in the root, and checks the full proof shape. Solidity and TypeScript share test vectors; the exact legacy exploit, internal-node substitution, wrong size/index/depth, odd-tail and sentinel cases have regression coverage. The Registry also rejects expired non-membership evidence and future issuance timestamps even when `maxAge = 0`.

The TypeScript verifier additionally canonicalizes fixed-width `bytes32` ordering keys before comparing them. Before that check, changing only a listed leaf key's hexadecimal A-F digits to uppercase preserved the key bytes and inclusion proof but changed JavaScript string ordering, allowing the listed subject to be presented as the left boundary of a false gap. The permanent negative regression failed **0/1** before the canonicalization and passes **1/1** after it. Solidity compares decoded `bytes32` values and did not have this textual-encoding distinction.

The exact appendix-A epoch-1 proof is now exercised at both the library and fresh Registry entry points. An isolated HEAD build of the pre-v2 Solidity library failed the negative assertion **0/1**; the current library and Registry tests pass **2/2**, including a fresh epoch carrying the historical v1 root so that the Registry freshness precondition itself cannot hide the rejection. This is local rejection evidence, not proof that any approved release address has been deployed or switched.

The ASC now also advertises `TRANSACTION_PROCESSING_VERSION() == 2` and processes mixed receipts atomically with a receipt-log cursor; the worker requires this version. [Atomic receipt migration](23-atomic-receipts.md) covers previously quarantined or partly consumed transactions.

Attribute schema 0 now rejects unsupported ranges/reserved bits, and policy schema 2 binds individual/entity kind separately from the legacy Policy tuple. New Registry construction requires the new ASC's schema/version declarations. These changes are specified in [credential/policy schema](24-credential-policy-schema.md); old frozen policies are not retroactively upgraded.

Epoch schema 2 is a separate version from roster hash format 2 and transaction processing 2. It adds source cutoff, source-set publication time and a full snapshot binding, with cutoff + 24h as an immutable maximum lifetime. Source/ASC/Registry, worker and tools must migrate together; [epoch freshness](32-epoch-freshness.md) covers delayed receipt semantics and the new event signature.

`ROSTER_AUTH_VERSION() == 1` is additionally required on all three contracts. [Issuer root authorization](33-roster-issuer-authorization.md) adds authenticated approvals in the same source receipt and checks each accepted leaf's issuer. A version-2 epoch without those approvals is not accepted. Obtain issuer approvals for new roots; never relabel historical receipts as signed.

New asset deployments additionally require Registry `ROSTER_WITNESS_VERSION() == 1` and a frozen `requireRoster=true` policy. [Fresh-roster consumers](34-fresh-roster-consumers.md) connect permissionless proof delivery to the storage-only token gate. Reissue alone is insufficient: a fresh authorized epoch must be relayed and each holder's witness cached. Legacy immutable assets do not inherit this behavior.

These are targeted fixes, not a claim that all contract risks are resolved. Issuer namespace/authenticity, publisher honesty and completeness, Direct revocation freshness, policy validation, migrations and independent review remain tracked separately. **Do not use the old or new deployment for real assets or production KYC on the strength of these tests alone.**

Asset recovery is also no longer a unilateral token-owner call in the working tree. New `GatedRwaNote` instances expose no `forceTransfer`/`forceBurn` selector; a once-configured proposer and different approver seal an exact transfer/burn, reason commitment and technical delay. Transfer recipients must pass the frozen policy at proposal and execution. Historical deployed tokens are unchanged and do not gain this control.

## Wire format: deliberately incompatible

All hashes use Ethereum Keccak-256. Prefixes below are exactly one byte; keys, marks and counts are exactly 32 bytes. Count is an unsigned, big-endian uint256.

```text
leaf       = keccak256(0x00 || subjectKey || markHash)
node       = keccak256(0x01 || left || right)
epochRoot  = keccak256(0x02 || leafCount || treeRoot)
inclusion  = { index: uint256, leafCount: uint256, siblings: bytes32[] }
```

The existing subject-key and mark-hash encoding is unchanged; see `pipeline/roster.ts` and `src/lib/RosterProof.sol`. Leaves are sorted by unique subject key with zero/minimum and maximum sentinels (zero marks). The leaf count includes both sentinels and must be at least two. An odd final node is duplicated at each level. A proof must have exactly the number of levels obtained by repeatedly taking `ceil(width / 2)` until width is one. At an odd tail the sibling must equal the current accumulator. An index must be inside the committed count and fully consumed. Non-inclusion additionally requires adjacent indices, the same count/depth, and a strict target-key gap.

The TypeScript implementation accepts only safe integer indices/counts and compares canonical fixed-width `bytes32` values rather than caller-controlled text casing. Solidity accepts uint256 and bounds proof depth to 256. Non-membership demonstrates absence from that published set; it does not establish why a person is absent, prove a legal revocation, or prove the publisher supplied a complete, correctly sorted roster.

The registry advertises `ROSTER_FORMAT_VERSION() == 2`, `EPOCH_SCHEMA_VERSION() == 2` and `ROSTER_AUTH_VERSION() == 1`. Epoch evidence records carry `rosterFormatVersion: 2`, `epochSchemaVersion: 2` and `rosterAuthVersion: 1`. Publication, dry-run and record-verification tools reject missing/unknown versions. There is no legacy fallback. The live-state UI's roster-format detection alone is not proof of epoch/authorization compatibility or an audit; its combined display remains to be completed. A failed version read is unconfirmed, never proof of compatibility.

## Migration gates and operator sequence

No deployments, key usage, role changes, policy changes or root publications were performed by this implementation work. The following is a runbook for an authorized migration after remaining blockers are resolved:

1. Freeze the release commit and resolve the applicable P0/P1 contract tickets. Obtain independent review of denial semantics and the v2 construction. Record chain IDs, bytecode hashes, constructor parameters, role holders and the approval owner. Never label the historical build as this release.
2. Deploy new source, ASC and Registry contracts: these are not proxy upgrades. Epoch schema v2 uses a new source function selector/event signature; the historical immutable source cannot publish it. Use an isolated deployment and document the historical cutoff/replay strategy rather than relabelling v1 events. All three contracts must advertise epoch schema 2 before worker/publication startup.
3. Reconstruct source history from the deployment block and reconcile every denial, ordinary revocation and issuance at a finalized cutoff. Import or replay denials into the new ASC before opening any consumer path. A new empty ASC is not a migration of existing sanctions state. Maintain an exported reconciliation report and do not copy only active marks. The local reverse-delivery/crash regression proves the state rule and worker recovery only; an authorized migration must still produce the exact release-address report from real finalized history and native proofs.
4. Re-register and freeze consumer policies after checking their full content; IDs need not be preserved. `GatedRwaNote` binds immutable registry/policy values, so changing a web environment variable does not migrate that asset. Decide explicitly whether a new demo asset is needed; do not move holders' balances without authority.
5. Publish a newly built v2 roster only after validating all source and hub addresses, issuer data, leaf count, inclusion and exclusion controls, completeness and validity windows. Do not wrap an old v1 root in a v2 record. Start a separate worker state file scoped to the new chain/source/ASC configuration and use a verified historical start block.
6. Update deployment manifests and web/worker/consumer configuration together. Retain the old manifests and `epoch-1.json` evidence as clearly labelled v1 history; use a new evidence filename for v2. Re-run source-to-ASC-to-registry and gated-asset tests against the exact release addresses, including negative denial order and non-membership controls.
7. Switch the demo only after verification. Publish the release commit, both chain transaction hashes, epoch root/count/format, policy content, expected decisions and timestamps. Replace stale video/deck/evidence claims. Monitoring must detect stale policies, stale epochs and failed propagation.

Before switch-over, rollback means abandoning the unactivated new release and retaining the labelled legacy demo as unsafe historical evidence. After activation, a defect means halting affected consumer access and investigating—not falling back to a known-vulnerable proof format. Any asset or authority changes require an approved recovery plan.

## Local verification

```sh
npm run test:all
npm run typecheck
npm run test:worker-crash
npm --prefix web run lint
npm --prefix web run build
```

`test/roster-abi.test.ts` compares the shared ABI with the Foundry artifact; run `forge build` first if running that test alone in a clean checkout. CI runs it in the Solidity job after compilation, while `npm run test:ts` remains independent of Foundry artifacts. The historical epoch verifier is expected to reject the v1 evidence now. This intentional migration failure must not be bypassed to make a submission check green.
