# Governed denial correction and asset recovery (T-13)

Updated 2026-09-07. This is a local protocol implementation and synthetic test record. It is not a legal conclusion, sanctions delisting decision, asset recovery authorization, deployment record or independent review.

## Separate state transitions

Proofmark now keeps five operations distinct instead of treating a generic “clear” string as authority:

1. `MarkRevoked` is ordinary credential invalidation. A later ordinary issuance can replace it.
2. `SanctionDenied` opens a source denial revision and remains fail-closed on the hub.
3. Vault review and legal holds remain off-chain case workflow. A vault `cleared` result does not mutate the source, ASC or asset.
4. `SanctionDenialCorrected` is a proved source action with an opaque case/reason hash, exact denial revision, proposing issuer and independent approver.
5. Asset recovery is a separate token proposal, approval, delay and execution. It neither clears a denial nor creates a credential.

The repository does not assign legal meanings to reason hashes or claim that an operator role proves a real human reviewed the file. Cleartext case material and personal information must stay in the approved off-chain case system. Which facts permit correction, who may hold each role, notice/appeal requirements and whether transfer, burn, fiat redemption or another remedy is lawful remain approval gates.

## Denial correction protocol

`ComplianceSource.DENIAL_CORRECTION_VERSION() == 1` adds an approver role controlled by the source owner. An enabled issuer proposes an exact tuple of subject, replacement attributes, claims commitment, evidence commitment and nonzero reason hash against the current `sourceDenialRevision`. A different enabled correction approver must approve it. A repeated denial increments the revision and invalidates every pending proposal for the older snapshot.

Execution is permissionless only after the stored proposal and approval exist and the one-hour technical minimum has elapsed. The proposer must still be an enabled issuer and the replacement attributes must still be valid. Execution emits `SanctionDenialCorrected` immediately followed by the exact replacement `MarkIssued` in one source receipt. The one-hour floor is not presented as a jurisdiction- or asset-approved delay; an authorized release may require a longer outer workflow.

The worker requires denial-correction version 1 on both Source and ASC before it starts, recognizes the correction as action 5 and relays the entire receipt under the existing durable/finalized transaction path. `ProofmarkASC` maintains a source-order sanctions-decision cursor independent of ordinary issuance ordering. Therefore:

- an old denial delivered after a newer correction is skipped;
- a correction older than a newer denial is skipped;
- correction without its replacement issuance leaves the subject `Suspended` and tombstoned;
- the correction and replacement receipt clears `permanentDenial` and activates only the newly approved credential;
- proposal/approval identities, denial revision, correction ID and reason hash remain queryable and are emitted in dedicated audit events.

Cold source roster replay consumes the same correction event. It removes the permanent-denial exclusion only when the later replacement issuance is present and valid at the selected finalized cutoff.

## Asset recovery protocol

`GatedRwaNote.RECOVERY_GOVERNANCE_VERSION() == 1` removes the owner-only `forceTransfer` and `forceBurn` entry points. The owner configures distinct proposer and approver addresses exactly once. The proposer seals kind (`Transfer` or `Burn`), source holder, destination, amount and nonzero reason hash. The independent approver approves that exact request; execution is permissionless after the one-hour technical floor.

A transfer destination must pass the token's immutable frozen policy both when proposed and when executed. Eligibility lost during the delay causes execution to revert without changing balances. Burn has no recipient and represents only an on-chain supply reduction; tests do not call it a legal redemption, discharge or settlement. Proposal, approval and execution events include the identities and reason commitment. The token owner can be one configured side but cannot satisfy both roles or use a legacy direct selector.

## Local counterexample and evidence scope

The permanent T-13 counterexample gives the existing token owner a blocked holder and a currently verified recipient, then calls the legacy `forceTransfer` and `forceBurn` selectors. Against the pre-change implementation the owner moved value before the first negative assertion, so the regression failed **0/1**. The current contract has neither selector and requires a sealed, independently approved delayed request.

Focused tests cover independent correction approval, stale denial-revision fencing, delay enforcement, correction/replacement receipt atomicity, reverse proof delivery, fail-closed correction without issuance, worker action/version handling, compiled ABI parity, cold roster replay, owner-only legacy calls, delayed burn and destination eligibility loss after approval. All identities, reasons, credentials, assets and chains in these tests are synthetic/local; the native proof verifier is mocked in Solidity tests.

The current focused command `npm run test:t13-governance` passes Solidity **20/20** and TypeScript/ABI **18/18**. The actual isolated Source/Hub Anvil integration `npm run test:atomic-receipts` passes **1/1** with a real source denial/correction transaction, the real worker child process, mock proof HTTP/native verifier, ASC action 5 and independent cold roster reconstruction.

## Release and external gates

Before any non-demo use, an authorized owner must supply and approve at least:

- the legal taxonomy for ordinary revoke, denial, temporary hold, correction, seizure/transfer, burn, redemption and settlement;
- named proposer/approver organizations, separation-of-duty and conflict/recusal rules, role rotation/revocation and emergency handling;
- the applicable delay, notice, appeal, evidence-retention and privacy rules, plus an approved case system binding the opaque hashes;
- recipient/beneficiary and encumbrance checks, amount authority, fiat settlement/reconciliation and holder communications for each asset;
- deployment/migration treatment for historical denials, pending cases, existing owner-controlled tokens and already consumed source queries;
- operational KMS/multisig custody, public Source/ASC/Registry/token deployment, real proof propagation, monitoring, independent security review and legal/asset sign-off.

No deployment, public-chain write, real key, real identity, real asset movement or external approval was used here. Until those gates are evidenced, T-13 remains `IN_PROGRESS` even when every local suite is green.
