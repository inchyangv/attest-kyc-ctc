# T-41 — current-witness freshness and renewal boundary

2026-09-07. **IN_PROGRESS.** This is a local verifier improvement and an operating handoff, not evidence of a renewed public demo, approved operators or continuous judging-period uptime. No public transaction, deployment, vendor call or scheduled job was run.

## What the old calculation missed

The previous `check-demo-freshness.ts` used a Direct mark's expiry and the pilot policy's maxAge. A seven-day credential can outlive the current roster epoch and witness. With the current contracts, replacing an epoch invalidates cached witnesses; an epoch cannot live beyond its source cutoff plus 24 hours. Neither reissuing a credential alone nor simply publishing a new root keeps the consumer passing.

`npm run check:freshness` now uses `pipeline/demo-freshness.ts` and the shared `readOnchainState` reader. It checks:

- the actual RPC chain ID 102031, without an assumed static network;
- one common block for both holders, the unissued control, all policy/version/witness/provenance calls, and note bindings/transfer preflight; each reader and the combined result recheck the canonical block hash;
- the current ASC/Registry schemas, source contract address, Registry→ASC and note→Registry/policy-2 bindings;
- both exact frozen roster policies from `script/deploy.sh`: kind 1, mask 65572, assurance 2, KR 410, independently expected issuer; production regime 1/maxAge 2592000, pilot regime 2/maxAge 604800;
- agreement between actual Registry booleans and state diagnostics; both holders fail production and pass pilot, while the control fails both and its transfer preflight is rejected;
- current approved witnesses, nonzero root/snapshot, source-cutoff/publication ordering, maximum publication lag of 3600 seconds and maximum epoch age of 86400 seconds;
- a positive explicit remaining window bounded by the earliest of witnessed credential expiry, issuedAt plus pilot maxAge, and epoch validUntil. Direct marks remain diagnostics, not the basis of this window.

The scheduled end is **exclusive**. Registry maxAge itself is inclusive at its boundary; treating that boundary as exclusive is conservative by one second. Passing a 900-second window means the computed interval ends no earlier than 900 seconds after the observation reference; it does not say the credential is valid at the end instant.

The CLI disables ethers' short-lived request cache so canonical-block rechecks actually reach the RPC. The loopback transport test asserts all eight block reads arrive at the server. Other callers injecting a provider into the helper must likewise supply uncached reads; the helper cannot authenticate or repair a dishonest/cached provider implementation.

There is no host-time fallback for a missing block. The CLI also rejects a latest block more than 300 seconds behind or 30 seconds ahead of the observation clock. Tolerated lag is deducted from the remaining window, using the later of block and observation timestamps. These are local diagnostic limits, not measured Creditcoin finality or a customer-approved SLA. The runner needs a trusted synchronized clock. The report is an observation, not a promise that the RPC is honest, that its block is finalized or that no later reorg will occur.

## Required operator inputs

`MIN_FRESH_HOURS` has **no default**. Supply an explicitly approved positive decimal hour duration that resolves to whole seconds and is at most 24 hours. Zero, missing, malformed, subsecond and excessive values fail before network access. No smaller window has been approved or silently selected by this implementation. A full 24-hour remaining window is normally impossible after source publication and relay delay under a cutoff-plus-24-hour epoch; do not relax protocol freshness to make that request pass.

`DEMO_EXPECTED_ISSUER` is also mandatory and must be an independently reviewed nonzero policy issuer address, never a private key. Contract addresses come from `deployments/cc3-testnet.json`; the manifest still names the historical deployment and has not been migrated. The CLI is expected to reject incompatible old contracts. It does not learn an expected issuer from the live policy it is testing.

Before calling `npm run verify:submission`, provide this window and issuer **as well as** the four reviewed runtime pins required by [scene verification](44-demo-verification.md), and regenerate [source-bound local test evidence](45-source-bound-test-evidence.md). The standalone freshness check does not authenticate runtime code against those independent pins or read source-chain issuer roles. Those are separate preflight gates. It does not automatically refresh witnesses, issue a credential, publish an epoch or send a transfer. A nonzero exit must stop recording; repeating a failed observation does not renew anything.

## Renewal handoff still requiring approval and execution

1. Record the actual judging window, accountable primary/backup operator, incident channel, approved check cadence, minimum remaining window and renewal lead time. None is assigned by this document. Include source finalization, list retrieval, screening/review, root approval/publication, relay and witness availability in the lead time; measured staging tails, not the historical nine-minute single run, must justify it.
2. Complete authorized migration to compatible source/ASC/Registry/note, independently reviewed runtime pins and a valid current sanctions generation. The previously failed EU refresh and old v1 deployment cannot be disguised as current evidence.
3. Before the approved renewal deadline, obtain a current full sanctions snapshot, complete required holder re-screening and source-state replay, obtain issuer approval, publish the bounded epoch and confirm hub materialization. These writes and vendor activity need their own authorization and operational keys. Publishing a root without the underlying checks does not establish screening freshness.
4. After an epoch changes, rebuild/distribute its proof bundle and materialize each required holder's current witness. Confirm policy verdicts and both positive/negative gate paths with the read-only verifier. A new root can create an availability gap before witnesses are updated; current contracts do not provide an atomic fleet-wide cutover. Measure and disclose that gap rather than promising uninterrupted access.
5. Run the approved recurring read checks and persist timestamped results privately under the retention policy. Alert before the renewal lead-time boundary, and immediately on stale data/epoch, witness mismatch, RPC failure or a policy/gate discrepancy. This patch has not installed a scheduler, configured alert delivery or demonstrated seven-day operation.
6. Keep each recording's source/hub receipts, observed block hash, epoch/bundle, holder and policy scope as immutable historical evidence. Do not overwrite a video's old transaction references when the public demo renews. If a failure cannot be safely recovered before expiry, mark the demo unavailable and suspend recording rather than weakening the policy.

Source/hub event lineage, actual transfer balances, independent runtime/build review, provider honesty, finalized-chain proofs, full wallet issuance/witness E2E and real judging-period availability remain outside this local PASS. The report explicitly lists these limits and warns that earlier revocation, epoch replacement, policy/infrastructure changes or a reorg can end eligibility sooner.

## Verification

`pipeline/demo-freshness.test.ts` adds 14 tests. Synthetic cases cover shared-block reads, each limiting deadline, exact exclusive boundaries, missing/stale/unapproved witnesses, tombstones, invalid credentials, inconsistent Registry booleans, epoch provenance, source/issuer/schema/policy/note drift, late reorgs, unavailable/mixed blocks, stalled/future RPC clocks and lag deduction, explicit window validation and shared-block API compatibility. The real CLI is tested both for missing-input failure before RPC access and against a loopback HTTP JSON-RPC server using ethers transport, including a wrong-chain rejection. All requests in that fixture are read-only; these are not public deployment tests.

Existing on-chain reader tests retain their default latest-block behavior. No API contract or UI verdict semantics were changed by adding the optional shared observation block argument.

## 2026-09-08 addendum: the live v1 route

The public deployment in `deployments/cc3-testnet.json` is still the `v1-live` build, whose registry
has no roster-witness path and reverts on `ROSTER_FORMAT_VERSION()`. The CLI therefore no longer
rejects it outright. `script/check-demo-freshness.ts` first calls
`detectRosterGeneration` (`pipeline/roster-legacy-v1.ts`): a v2 registry gets the witness gate
above, the v1 build gets `checkLegacyDemoFreshness` (`pipeline/demo-freshness-legacy.ts`). The
legacy gate reads both holders, the control, both frozen policies and the note at one block, and
bounds the window by the earliest of credential expiry and `issuedAt + pilot maxAge`. It does not
verify roster witnesses, runtime pins, source lineage or finality, and it says so in its output.
Network failures and unknown versions remain errors; only a reverting call is read as v1.
`MIN_FRESH_HOURS` and `DEMO_EXPECTED_ISSUER` stay mandatory for the standalone CLI;
`scripts/verify-submission.sh` supplies the documented 24-hour margin and the committed
deployment manifest's deployer for the v1 route only. `pipeline/demo-freshness-legacy.test.ts`
covers the boundary, expiry, tombstone, dishonest-verdict, note-binding, v2-registry and reorg cases.
