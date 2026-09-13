# Epoch freshness and schema v2 (T-09, partial)

2026-09-07 KST. Local code/test changes only. The historical source, ASC, Registry, root and consumer policies were not changed. T-09 remains `IN_PROGRESS` because source/fleet migration, completeness, per-member screening and customer-approved freshness policies are not established.

## Wire contract

Epoch schema is distinct from roster hash format and receipt processing; all currently have value 2 but describe different compatibility requirements. `ComplianceSource`, `ProofmarkASC` and `ProofmarkRegistry` advertise `EPOCH_SCHEMA_VERSION() == 2`. The new source function is:

```solidity
publishEpoch(uint32 epoch, bytes32 root, uint32 listVersion,
             uint40 validUntil, uint40 sourceCutoff, bytes32 snapshotId)
```

The emitted `RosterEpochPublished` keeps three indexed values (`epoch`, `root`, `listVersion`) and carries four ABI data words (`validUntil`, `sourceCutoff`, source-set `publishedAt`, `snapshotId`). Its topic is `0x9c17b3d0d930980ffef5e671b9390a26d8f8b5f801f0ce3636909c95c69eb908`. The old four-argument function selector is absent and old epoch-event signatures are not accepted by the new epoch handler. Ordinary lifecycle event signatures remain unchanged.

Subsequent T-07 changes additionally require [roster authorization v1](33-roster-issuer-authorization.md): the six-argument function requires the caller to hold both issuer and publisher roles and authorizes only itself. A separate publisher uses `publishEpochForIssuers` with exact-root issuer signatures. The ASC requires matching authorization events in the same proved receipt. Epoch schema 2 alone is no longer a sufficient compatibility gate.

`EpochBounds.sol` is shared by source and ASC:

- root and snapshot ID must be nonzero; cutoff must be positive;
- cutoff must not exceed the source publication time;
- publication must occur no more than one hour after cutoff;
- validity must end after source publication but at most 24 hours after cutoff.

The source supplies `publishedAt = block.timestamp` and checks validity before advancing its epoch sequence. The ASC checks topic widths, exact data length, typed uint40 decoding, the same structural bounds and no future publication relative to its current block time. Values cannot become valid through uint truncation. The shared bounds are protocol ceilings, **not** an approved sanctions rescreening SLA. Validator timestamps and source/hub clock differences remain trust/availability inputs.

An empty asserted roster represented by the valid two-sentinel Merkle construction is different from a zero root: its nonzero commitment is allowed. It may prove all ordinary subjects absent from that set. This never establishes the reason for absence or proves publisher honesty/completeness.

## Time semantics

For example, cutoff 00:00 and publication 00:30 permit expiry at most 24:00, not 24:30. If the hub receives that event at 12:00, it preserves the original expiry. The remaining window is twelve hours, not a newly started day.

A structurally valid higher epoch received after its expiry is still recorded as the latest epoch, but `isRosterFresh()` is false. It cannot accidentally extend lifetime or leave an older, still-unexpired epoch as the current allowed set. Delivering an older sequence later cannot restore that older root. Recording expired history does not mean current proof acceptance.

Roster cache, membership and non-membership paths all use `ASC.isRosterFresh()`. The predicate rejects missing/invalid metadata, future publication time and `block.timestamp >= validUntil`. Historical roots remain queryable in `epochRoots`, but the public proof verdicts are explicitly about the **current** epoch only. A raw historical root is not a current clearance/denial answer. Direct-mode credential freshness is unchanged and remains T-08.

## Publisher and verification tools

The worker refuses to start unless source and ASC both advertise epoch schema 2, in addition to atomic receipt processing 2. Shared Registry guards require both roster hash format 2 and epoch schema 2. This deliberately prevents mixing an old source/ASC with a newly formatted root.

`pipeline/epoch.ts` mirrors time bounds for publication planning. The script obtains the timestamp of the source block it scanned through, uses `EPOCH_VALID_HOURS` (default/max 24), and checks a v3 sanctions manifest through the shared T-27 loader. Publication further caps list check age at 24 hours even if the general sandbox ceiling is seven days. It rechecks the bounds before sending. `EPOCH_VALID_DAYS` and arbitrary `EPOCH_LIST_VERSION` overrides are rejected. `listVersion` is now the first 32 bits of the **full manifest snapshot ID**, while the full bytes32 binding is retained; it is not a substitute for the individual source content hashes in that manifest.

Records include both schema declarations, cutoff, source publication time and snapshot ID. New JSON/Markdown filenames are prefixed `epoch-v2-` and scoped by source/ASC addresses to preserve the historical `epoch-1` artifacts. `verify-epoch-record.ts` compares metadata to chain, pins all decision reads to one hub block and rechecks its hash. The normal historical record still fails compatibility before RPC verification; nothing was relabelled to obtain a green result.

The verifier's recording margin is separate from the on-chain lifetime: `EPOCH_MIN_REMAINING_SECONDS` defaults to 3,600 (allowed range 1..86,400). The old default of 24 hours **remaining after relay** is incompatible with a hard 24-hour lifetime measured before relay. This is an explicit recording-preflight adjustment, not a longer policy lifetime or a new availability claim. Operators may retain 86,400 and obtain the expected failure; do not silently extend roots to satisfy it.

The source cutoff and sanctions-list checks are independent freshness clocks. Publication planning now sets `validUntil` to the earlier of the requested cutoff-anchored lifetime and the oldest official-source `checkedAt + 24 hours`. A newly scanned source block therefore cannot repackage a 23-hour-old sanctions snapshot into another 24-hour assertion; it has at most one hour left. At exactly 24 hours the plan is already expired and fails before signing or sending. The full manifest hash already binds every source `checkedAt`, while the shorter `validUntil` is enforced by source, ASC and Registry. This is still an authorized publisher assertion: the contracts cannot independently prove the remote lists were honest or complete.

## Verification and remaining work

Five new Solidity tests cover source invalid vectors/sequence preservation, exact publication/expiry boundaries, delayed and expired hub delivery, future time, malformed ABI values, old-sequence non-resurrection and legacy signature rejection. Existing Registry positive/negative proof tests now use bounded epochs and cover current-time/future/expiry behavior. Existing mixed-receipt tests still exercise multiple epochs and denial preservation.

Four TypeScript tests cover cutoff-anchored planning, snapshot binding, invalid time/duration, stale/future lists, the combined source/list age ceiling and source/ASC schema mismatch. The new combined-age regression failed on the prior planner because a 23-hour-old snapshot received another full day (`1800086400` instead of `1800003600`); it passes after the validity cap. A compiled-ABI test covers the new function and event. The current basic suites pass with Solidity **110/110** and TypeScript **490/490**. The actual isolated publisher/worker integration passes **2/2** and carries a 23-hour-old synthetic list snapshot through source transaction, mock-native relay, ASC and Registry with only its remaining one-hour lifetime. It does not establish public Attestcoin epoch-v2 propagation or official-list activation.

No publish command, role change, public transaction or deployment was executed. T-27 later completed one isolated full HTTP 200 refresh of all three configured official feeds and built a provenance-v2 candidate, but did not activate it in this repository or any runtime. That dated temporary candidate is not a continuing freshness guarantee and the publisher must not bypass a failed current refresh using historical lists. The new epoch event also requires a newly deployed source, not just a Registry replacement.

T-18 later added a finalized/reorg-checked full source-history replay and cross-RPC comparison, but not cryptographic receipt-root completeness or an independent reconstruction. Remaining requirements include that stronger completeness evidence, data-change-triggered rescreening with per-member evidence (T-20/T-27), issuer namespace (T-06), risk-specific customer freshness approval, independent review, managed key separation and successful source-to-CC3 operational migration. T-07 subsequently added exact-root approval and a dedicated publisher-key workflow; it does not establish production key management or issuer review quality. Merely loading a fresh manifest and emitting its hash does **not** prove the roster was actually rescreened against it. Contracts validate bounds on an authorized assertion, not the underlying XML or off-chain due diligence.
