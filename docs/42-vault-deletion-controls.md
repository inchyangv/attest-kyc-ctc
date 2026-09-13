# Vault deletion controls — T-33 local implementation

2026-09-07. Status: **IN_PROGRESS**, not a legally approved retention policy or a complete erasure service. No real record was deleted, no production schedule installed, and no chain transaction sent for this change.

## Customer/outcome policy binding

`pipeline/retention-policy.ts` adds the executable `proofmark-retention-policy-v1` schema. It has no production default. A manifest names one customer and jurisdiction, separately covers issued/review/denied/error outcomes, selects the collection or decision trigger, and covers all eight known storage/effect layers: evidence vault, issuance journal, revocation outbox, backup, vendor, operational log, client copy and on-chain publication. Each finite layer has an explicit duration and reference. Client copies must remain labelled client-controlled and public-chain effects irreversible. The Redis journal is deliberately restricted to the behavior actually implemented today: one day from the continuous terminal episode; an arbitrary policy duration is rejected.

Production now requires an `approved` `RETENTION_POLICY_JSON` with approval/legal-review, clock and hold-authority references. The customer must equal the processing-policy customer. Absence or invalidity stops the wallet challenge before consent, identity-document or bank vendor work. The generated retention statement and policy fingerprint are sealed with the SIWE challenge and wallet proof, included in the immutable issuance fingerprint and encrypted journal, and snapshotted with the vault record. ID, bank and issuance/resume recheck the current policy; status remains read-only for recovery when a policy changes. References make a decision attributable but do not prove that counsel, the customer, a clock source or a named authority approved it.

The vault deadline is derived from the selected outcome trigger rather than `EVIDENCE_RETENTION_DAYS`; the former 1,825-day runtime fallback was removed. A policy-bound deletion request must use the snapshotted policy reference and exact credential disposition. Existing deadline/hold/pending/review/revocation gates and separate approval still apply, and automatic purge remains exact-deadline only.

`assertRetentionCompletion` is a fail-closed reconciliation boundary, not a deletion receipt generator. It refuses an “all deleted” result unless every layer has a policy-bound observation, no active hold is reported, client/on-chain residuals are disclosed, and the credential decision is evidenced. `source-revoked` needs both source revocation and hub enforcement; `not-issued` needs issuance exclusion; `unchanged` needs an explicit maintenance observation. A vendor evidence reference remains externally sourced and cannot be made true by this module.

## What now executes

`pipeline/vault.ts` checks these conditions under the existing exclusive writer lock, after reloading the encrypted file:

- The original record deadline is a valid integer Unix-millisecond timestamp, at or after creation. New records with invalid dates are rejected; malformed legacy dates cannot authorize deletion. Retention extensions can only increase the effective deadline. They also extend the existing rescreen eligibility window, but do not extend an issuance authorization or an onchain credential.
- No unreleased hold exists. Hold IDs cannot be reused. A release retains its operator/case reference and does not revive a previous deletion approval.
- Issuance is not `pending`, human review is not `review`, and no pending/prepared revocation exists. Legacy `blocked` records without a confirmed source revocation cannot be deleted. A source confirmation is not a CC3 propagation acknowledgement.
- The latest deletion request has a different approver label, the exact request ID is current, and approval is not in the future. The request binds the full record, retention extensions, all hold events and that record's revocation jobs through SHA-256. Any change to those inputs makes it stale, even if a later decision returns the record to the same state. Approval never bypasses the retention deadline.
- A policy reference and a service-decision reference are required. `unchanged` explicitly leaves credentials unchanged; `source-revoked` requires local confirmed outbox evidence; `not-issued` requires local `rejected` state. These are local state checks and attributed decisions, not independent verification of a legal policy or global chain state. Other issuance records for the same wallet are outside this decision.

Approval can be recorded before expiry. An unchanged, approved `automatic` request becomes eligible at the exact effective deadline; a `manual` request is never included in scheduled purge. Subsequent rescreening invalidates approval, so this is conservative per-record automation, **not** a complete automatic retention-policy engine. `purgeExpired` skips blocked, stale, unapproved and manual records; it does not discard unfinished work to make deletion succeed.

`erase` now takes an approved request ID instead of a free-text reason. The retained event contains the policy reference and request ID. Operator/policy/case fields accept bounded identifier syntax, not free text; this does not prove an identifier contains no personal data. The deleted record's tombstone rejects later `put`, including an old issuance journal's evidence sink. Reissuing under a different request ID is not prohibited by this record-level tombstone.

## Operator workflow and authority boundary

The CLI is a local administrative tool. `COMPLIANCE_OPERATOR_ID` has no fallback for the new governance commands. **Different strings are not authenticated different people.** Anyone with the vault key/file access or control over the process can bypass this application boundary. Before production, use authenticated identities, independently authorized approvals, controlled time, access audit and restricted/KMS-backed storage. A syntactically valid policy reference is not counsel approval.

Read-only commands:

```sh
npm run vault:admin -- list
npm run vault:admin -- deletion-preview
npm run vault:admin -- purge
```

Preview returns only record ID, effective deadline, current request ID, automation mode and blocking codes. It does not create a missing directory, take a lock or rewrite ciphertext. All times are Unix **milliseconds**, not seconds. Do not paste names, bank details, document numbers or substantive legal advice into case references.

Mutation syntax below is documentation, not an instruction to run against live data. Substitute actual approved case/policy references and identities; synthetic test values are not authority:

```text
vault:admin -- hold <recordId> <uniqueHoldId> <caseRef>
vault:admin -- release-hold <recordId> <holdId> <releaseDecisionRef>
vault:admin -- extend-retention <recordId> <untilUnixMs> <policyDecisionRef>
vault:admin -- request-deletion <recordId> <policyRef> <unchanged|source-revoked|not-issued> <serviceDecisionRef> <manual|automatic>
vault:admin -- approve-deletion <recordId> <currentRequestId>
vault:admin -- erase <recordId> <approvedRequestId> --execute
vault:admin -- purge --execute
```

Run these through `npm run` with `COMPLIANCE_OPERATOR_ID` set by the local operator procedure. Request and approval are separate calls; the returned request ID must be supplied to approval and manual execution. `purge --execute` deletes only eligible records with an approved automatic request. Operators must review blockers/backlogs; retaining everything indefinitely is not claimed to satisfy deletion obligations.

`rescreen --publish` no longer calls purge. It still commits screening decisions and transmits revocations as documented in the outbox runbook. Deletion is a separate, explicitly invoked operation. A future approved scheduler may call the purge workflow; none was installed here.

## File compatibility and restore

AES-256-GCM envelope/key derivation remain version 1. The encrypted plaintext schema becomes version **2** with separate retention controls; these cannot be supplied through `VaultRecord` insertion. A v1 file is read without inventing approvals. Its first successful mutation writes v2. The previous reader rejects plaintext versions other than 1, so ordinary rollback to that reader cannot silently ignore v2 holds. A read-only preview does not migrate a file. Stop all old writers before upgrade; this does not create fleet-level fencing.

Existing v1 erasure events are also tombstones. T-21 now provides authenticated whole-vault backups, empty-destination restore and a required minimum vault revision. New backup manifests also bind the earliest policy-bound vault deletion deadline. Restore refuses an expired backup and now requires an independently supplied (possibly empty) erasure-tombstone floor; a backup containing any floor record is rejected instead of resurrecting it. Old backup files remain readable, but old restore-requirements JSON without the explicit floor fails closed. The caller still has to protect/authenticate the floor, current holds and clock outside the backup itself, reconcile other stores, and authorize rollback. Do not remove controls or change version numbers to recover access. This file is still whole-envelope encryption, not per-record cryptographic erasure; filesystem snapshots/old envelopes remain decryptable with their historical key.

## Residual data and unfinished decisions

| Storage or effect | This operation | Still required |
|---|---|---|
| Current encrypted vault record | Customer/jurisdiction/outcome policy derives the exact vault deadline; snapshot/ref/disposition, hold, approval and unfinished-work gates precede exact-deadline deletion | Actual approved policy/clock/authority, policy changes and shortening exceptions, production IAM/KMS |
| Deletion controls and tombstone | Retains opaque record/request references, fingerprints, operator/case/policy decisions and times | Approved independent retention schedule and restore-safe ledger; identifiers/fingerprints are not anonymous |
| Revocation outbox | Blocks deletion while unfinished; confirmed wallet/hash/status metadata remains | Separate metadata policy, source reorg/finality and CC3 reconciliation |
| Issuance journal | Consent-bound fingerprint is stored; the implemented terminal-at +1 day behavior is the only accepted policy shape. Vault tombstone prevents reinsertion | Authenticated cross-store hold/deletion propagation, managed Redis backup/restore and unresolved signed-transaction policy |
| Backups, snapshots, failed-write temporary files, replicas | New backup binds earliest policy deadline; expired restore and explicit erasure-floor resurrection are rejected | Actual copy inventory/deletion, authenticated off-host tombstone/hold/revision floor and verified disposal |
| Browser/downloads, vendor records, operational logs | Not addressed | Applicable notices/control boundaries, vendor deletion evidence and logging policy |
| Onchain commitments/marks and roster bundles | No transaction, revocation, expiry change or public-data deletion | Approved credential maintain/revoke rule and public-data minimization/distribution policy |

There is no longer a web 1,825-day fallback. The repository therefore cannot silently present five years as a universal legal requirement, but it also has no authority to choose a real customer's period. Pending records/reviews may require a supervised resolution path before deletion; skipping them indefinitely is not a finished retention system. Vault holds still do not stop independent Redis expiry, vendor actions or off-host copy disposal. These are concrete remaining T-21/T-32/T-33 gates, not optional documentation work.

## Verification

`pipeline/retention-policy.test.ts` adds four synthetic policy/completion tests, including `PM-T33-01`: an expired vault row with surviving journal, backup, vendor and credential state cannot be reported as complete. It also covers outcome triggers, no five-year fallback, complete layer inventory, drift, holds and enforced credential disposition. `pipeline/vault-retention.test.ts` now has 12 tests, including exact policy reference/disposition and exact-deadline automatic purge. `pipeline/vault-recovery.test.ts` has five tests, including pre-erasure backup resurrection and expiry refusal. CLI deletion uses only a temporary synthetic vault; cleanup is limited to each test's temporary directory.

The existing vault and rescreen tests now require approved deletion and preserve evidence while source revocation is pending. T-21 separately exercises a synthetic local backup/restore and isolated source-receipt comparison. These tests still do not prove a real legal decision, authenticated dual control, cross-store disposal, public-chain consequence or approved production restore drill.
