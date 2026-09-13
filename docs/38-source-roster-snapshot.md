# Source-cutoff roster replay — T-18, local verification

2026-09-07 KST. Local implementation, synthetic failure injection and isolated Anvil source tests. No public epoch, role, deployment, external issuer signature or real screening dataset was changed.

## Replaced construction path

`script/publish-epoch.ts` previously enumerated source issuance events, unioned inconsistent range queries, and used current CC3 Active marks/tombstones to filter the set. That missed a source revoke/deny not yet relayed to CC3. It also inferred scan start from historical address-specific floors and empty-window walks, and required every hub-known subject to have an issuance. A source subject may legitimately be revoked/denied before any issuance.

[`pipeline/roster-source.ts`](../pipeline/roster-source.ts) now determines membership by replaying **all source issue/revoke/deny events through one finalized source cutoff**. Hub state is not the source completeness oracle and is not used to omit an unmaterialized issuance. The publisher checks the ASC's configured source/chain binding at one hub observation block, but this binding check does not turn hub state into a source snapshot.

The new set is source-active **at cutoff**. Ordinary issuance/revoke follows block, transaction and log order; any denial remains permanent across later issuance. The latest valid issuance supplies the entire attrs/issuer/claims/evidence tuple. Deny-before-issue and revoke-without-issue are explicit exclusions rather than scan failures. Unsupported/noncanonical trusted event encodings and invalid issuance attributes fail the whole replay. Expiry is evaluated at the cutoff timestamp, not the local clock, so the same cutoff can be reproduced later.

A source revoke delayed on the hub is excluded from the new root; no stale hub Active mark can put it back. This does not block all publication whenever the hub lags: the chosen path is independent source replay, not waiting for every individual proof. Already published roots remain historical assertions until replaced/expired or a restriction is relayed. New publication cannot remove that existing propagation window. Customer requirements to pause all activity during lag remain separate operational policy work.

## Scan boundary and checks

| Boundary | Enforced behavior |
|---|---|
| Chain | Actual provider network must match the configured source chain |
| Start | Successful direct CREATE receipt whose contractAddress is the configured source; creation transaction must occur in that block at its recorded index |
| End | `min(finalized.number, head - confirmations)`; explicit signed cutoff must not exceed this ceiling |
| Coverage | Every block from creation through cutoff, including empty blocks; every listed transaction's receipt, including foreign transactions and failed transactions |
| Independent headers | A separately configured finalized-header RPC must report the same chain, block hash/parent/time, transaction list and `receiptsRoot` for every scanned block |
| Cryptographic receipts | Every transaction receipt is canonically encoded by EIP-2718 and rebuilt into the Ethereum receipt MPT; its root must equal the independently observed block `receiptsRoot` |
| Consistency | Parent/hash/time continuity, transaction/receipt block/hash/index, cumulative gas/type/bloom, full block-global log positions, failed receipt has no logs |
| Independent RPC surfaces | Address-only `getLogs` results equal source logs reconstructed from the receipt trie inputs, including operational source events |
| Closing check | Re-read anchor and cutoff hashes, finalized height and confirmed head; discard on changed hash or regressed finality |
| Resource budget | Exceeding block/receipt budget fails the entire build; it never returns a truncated roster |

The receipt formatter in the installed ethers version omits `removed` and may omit the obsolete post-Byzantium `root: null`. Receipt logs may lack `removed` only while being checked against their transaction and canonical observed block coordinates. `removed=true` is rejected everywhere; `getLogs` must return explicit non-removed logs. Receipt `status`, cumulative gas, 256-byte bloom, envelope type and logs are required for trie reconstruction. These formatter differences were found against actual Anvil receipts, not inferred from artificial fixtures.

The `PM-T18-01` regression removes an entire revoke transaction from the primary block response and removes the same event from `getLogs`. The old receipt/getLogs comparison accepted that internally consistent lie and produced a stale allow roster. Snapshot v2 rejects it because the independent block body differs; independently, changing any encoded receipt field fails the `receiptsRoot` comparison. A primary endpoint cannot hide or alter a receipt while retaining the independently observed header root.

There is no code-history binary search, fixed public-demo block fallback, union of disagreeing log queries, or early exit after empty windows. `SOURCE_FROM_BLOCK` is explicitly rejected by this publisher. The source deployment transaction is supplied through `SOURCE_DEPLOYMENT_TX` or the matching address book's `sourceDeployment.transactionHash`. `script/deploy.sh` now records the source CREATE transaction hash when a separately authorized deployment occurs. The checked-in historical address book was not retroactively filled with an invented transaction.

This anchor currently supports top-level CREATE deployments, as used by this deployment script. Factory/CREATE2/proxy upgrades and preexisting code need an explicitly verified deployment/history scheme before support; a caller-chosen later transaction is not accepted as the source creation receipt.

## Reproducible signing and record inputs

`sourceSnapshot` version 2 records source chain/address, deployment transaction/block/hash, cutoff block/hash/timestamp, confirmation setting, block/receipt/source-log counts, the independent header transcript digest, rolling block/receipt transcript digest, source log digest, canonical entries digest and root. Entries and exclusions accompany the publication record. Version 1 plans/records are not upgraded by inference and must be rebuilt and reviewed.

Dry-run prints that manifest with the existing EIP-712 plan. Publication rebuilds the same cutoff, compares every manifest field, checks the fresh sanctions generation, validates the exact root approval and rechecks cutoff hash/time before sending. Signed plans without a manifest now fail rather than acquiring a completeness label by inference. The existing 256 KiB approval-file cap still applies and is a scaling limit, not a million-user solution.

`--check` now replays the **recorded original cutoff**, not the latest source set. A later legitimate issuance/revoke or wall-clock expiry cannot spuriously change the historic input root. The current on-chain epoch cutoff/root must agree; a changed transcript or missing manifest fails. If another epoch supersedes the one this process published, the checker requires that epoch's own matching record; it does not relabel the carried record. Current policy/expiry verdicts can still fail even when the original input root reproduces correctly.

This source snapshot change does not upgrade every subsequent publisher-side hub polling/verdict read into a finalized, single-block observation. The separate onchain reader has its own [single-block semantics](35-single-block-verdicts.md); publisher evidence and polling races remain part of T-40. Nor does this add durable signed-transaction journaling to the publisher (T-23).

## Authenticated incremental checkpoint

An optional checkpoint stores the complete lifecycle map, issuer-compromise cutoffs, cumulative receipt/log counters and all three rolling digests after the closing reorg/finality checks succeed. It is AES-256-GCM encrypted with scope-bound associated data `(chainId, source, deploymentTx)`, written mode 0600 with file fsync, atomic rename and directory fsync, and protected by an exclusive single-writer lock. Wrong key/scope, ciphertext mutation, oversized/non-regular files and concurrent writers fail closed.

On reuse, the publisher re-reads the checkpoint block from both RPCs and requires its exact hash, timestamp and `receiptsRoot` before restoring state. Only later blocks count against the per-run block/receipt budgets; cumulative manifest counts/digests remain byte-identical to a cold replay. A checkpoint newer than an explicitly requested historical cutoff is not relabelled or used. Without both checkpoint settings, the publisher performs the original cold replay.

## Configuration and deployment constraints

```text
SOURCE_DEPLOYMENT_TX            required unless present in the matching deployment manifest
SOURCE_HEADER_RPC_URL           separately operated finalized-header endpoint; must differ from the primary URL
SOURCE_CONFIRMATIONS           12 by default, positive; finalized is also required
SOURCE_SCAN_CHUNK              100 by default, 1..1000, for getLogs comparison windows
SOURCE_SNAPSHOT_MAX_BLOCKS     20000 by default, positive, per-run scan budget; no truncation fallback
SOURCE_SNAPSHOT_MAX_RECEIPTS   200000 by default, positive, per-run scan budget; no truncation fallback
SOURCE_SNAPSHOT_CHECKPOINT_PATH optional durable encrypted checkpoint path
SOURCE_SNAPSHOT_CHECKPOINT_KEY optional independent 32+ character secret; required with the path
```

Publisher RPC connections disable their local read cache and use a 15-second per-request timeout. Cold replay can be expensive: it reads unrelated transactions too, and total work grows with source-chain history rather than roster size alone. The authenticated checkpoint makes later work incremental but does not remove the initial archive scan, storage sizing or recovery-copy requirement. Skipping old ranges to make an initial build pass is not supported. No customer-scale runtime target or archive-provider SLA was measured here.

Epoch lifetime remains bounded by the original cutoff, with publication within one hour and validity no more than 24 hours from cutoff. A long scan can consume this publication window and must then fail/rebuild. Fresh v3 sanctions provenance is still required separately. The earlier EU refresh failure and historical v1 deployment incompatibility were not bypassed.

## Verified cases

Twelve source replay TypeScript tests cover delayed revocation; monotonic denial and no-prior-issue restrictions; long empty gaps; same-block/mixed receipt ordering; stable reconstruction after later writes and expiry; v2 manifest tampering; consistently omitted transactions/logs; receipt-root mutation; omitted/duplicated/foreign indexed logs; missing receipts, incorrect coordinates and receipt log gaps; wrong chain/deployment/finality/cutoff; exhausted scan budgets; checkpoint/cold equivalence; source reorg; malformed trusted events and foreign emitters. A thirteenth test covers encrypted checkpoint tamper/scope/single-writer/permission behavior. A compiled ABI test compares all lifecycle event signatures/indexing/layouts to the source contract.

The existing isolated Anvil issuance test was extended. It deploys actual source/issuer contracts, replays all actual block receipts, then sends a source revoke **without** changing its synthetic hub fixture. The new source roster drops from two entries to one. Replaying the earlier cutoff after the revoke produces the identical prior tree, exclusions and manifest. The initial test failed because Anvil had not yet finalized the deployment; it now mines enough actual local blocks for its finalized tag, rather than treating latest as finalized. The receipt `removed` formatting mismatch was also corrected and added to the fixture behavior.

```sh
npx tsx --test pipeline/roster-source.test.ts pipeline/roster-source-checkpoint.test.ts test/roster-source-abi.test.ts
npx tsx --test test/issuance-evm.integration.ts
npm run test:epoch-publication
npm run test:atomic-receipts
npm run test:cross-chain-gate
npm run test:all
npm run typecheck
npx tsx script/publish-epoch.ts --help
bash -n script/deploy.sh
git diff --check
```

These are source replay/encoding checks and local EVM evidence, not a successful full public publisher invocation, real Attestcoin proof transport, production source migration or fresh real sanctions activation. The deployment script change was syntax-checked, not executed on a public chain.

## Remaining T-18 trust and completion conditions

Receipt-trie reconstruction is cryptographic only relative to the supplied finalized header. The implementation requires two distinct RPC URLs and compares every scanned block, but it does not run an Ethereum consensus light client or prove that the configured endpoints have independent operators. Two colluding/identically compromised endpoints can still present the same false header. Selecting authenticated independent providers, protecting the checkpoint secret/path, keeping an off-host recovery copy and testing real archive-provider faults are operational approvals and evidence still required before a public completeness claim.

Issuer approval authenticates the asserted root but cannot prevent a publisher and signer from agreeing to omit an eligible person before source issuance. Source issuance history also does not prove that every included person has been re-screened against the current sanctions snapshot. Per-member rescreen evidence, issuer isolation, data availability and omission accountability remain T-06/T-19/T-20/T-27 work. Customer-scale initial scan/incremental latency, customer lag-stop criteria, public migration and independent security review are still outstanding. The repository-local T-18 completion cases are verified, but T-18 remains `IN_PROGRESS` rather than treating these external decisions and operating evidence as complete.
