# T-20 — Case-bound human review revisions

2026-09-07. Local concurrency protection for human decisions, not authenticated reviewer identity, two-person approval, legal clearance or on-chain reissuance.

## Case review and commit

Previously `decideReview` reloaded the current vault under its writer lock but applied a submitted human decision without checking which case version the reviewer had seen. Two reviewers could overwrite one another, even at the same timestamp and without changing the visible active state. The automatic rescreen path already required a pre-screen snapshot; this change supplies a separate boundary for human decisions.

`reviewSnapshot(id)` reads the existing encrypted vault without writes and returns a detached record plus a keyed revision. The revision covers the full record, that record's revocation jobs (including delivery/observation metadata), and retention controls. It uses HMAC-SHA256 with the vault key and an explicit review-revision domain, so the exported revision is not an unsalted digest of low-entropy personal data. It remains a sensitive correlation token, not anonymization or authorization.

The reviewer must retain the revision from the case actually examined. `decideReview(id, event, expectedRevision)` reloads under the writer lock and compares that revision before mutation. Missing/wrong/stale/erased cases fail with fixed `REVIEW_RECORD_CHANGED`; there is no automatic fresh-snapshot retry. Fetching a new revision solely to submit an old conclusion would bypass the intended human workflow and is not supported as recovery guidance.

Record, rescreen, source acknowledgement, another review, retention/hold, and outbox-only updates invalidate the revision. Unrelated records do not. The conservative whole-case fence can require rereview after operational metadata changes; it deliberately does not infer that those changes are harmless to a person's decision. Approved erasure cannot be undone by an old review. This is still a single-host encrypted-file CAS, not distributed database isolation or a WORM audit log.

Decision timestamps must be nonnegative safe integers and not precede record creation, the last screening or prior review. The outcome must be exactly `cleared` or `blocked`. Actor and reason fields must be opaque references matching the existing 1–128 character reference convention, not free-text personal data. Stored events project only these validated fields and `basedOn: expectedRevision`; callers cannot inject their own basedOn or extra payload. Legacy events may lack basedOn and are not rewritten.

The existing pending-revocation clearance guard remains. BLOCK still creates/retains its outbox atomically. Clearance cannot fabricate source/hub acknowledgement, cancel an in-flight signed revocation, reissue a credential or remove permanent on-chain denial. A fresh revision is not permission to bypass those restrictions.

## CLI

```sh
npm run vault:admin -- review-snapshot <record-id>
# Review the case in the approved private evidence workflow and retain the returned revision.
npm run vault:admin -- decide <record-id> <cleared|blocked> <reviewed-revision> <opaque-case-reference>
```

The CLI snapshot returns revision, case digest and minimal state/history-count metadata. It does **not** display identity/evidence or constitute the substantive case review. Programmatic authorized callers can examine the detached record; production evidence access and reviewer tooling remain to be implemented/approved.

`COMPLIANCE_OPERATOR_ID` is mandatory for decide; the old `local-operator` fallback is removed. It is still only an unauthenticated label. The CLI explicitly reports `operatorAuthentication: NOT_CHECKED`; successful decisions report `currentEnforcement: NOT_CHECKED`. Conflicts fail with `REVIEW_RECORD_CHANGED`; other errors in these two review operations return fixed `REVIEW_OPERATION_UNAVAILABLE`. The old free-text decide syntax is rejected rather than silently adopting a current revision. Existing unrelated admin commands retain their own behavior; this is not a blanket audit of all admin output.

Both library and CLI callers must adopt the required revision argument. Do not leave old unfenced writer processes running during rollout. No schema migration, production rollout, external case system, IAM connection, customer notification or service policy was installed.

## Verification

Five new root tests use real encrypted files and separate vault instances: same-time human clear/clear or block/clear conflicts; record/source/retention/hold/outbox changes; unrelated updates and approved erasure; missing/invalid revisions and malformed/backdated decisions; and actual CLI snapshot/commit/replay/missing-actor/legacy-syntax handling. Rejected decisions leave encrypted bytes unchanged, cannot append a second review or resurrect erased data, and cannot overwrite their own basedOn reference. Existing rescreen/materialization/pending-revocation tests use explicit current snapshots only for their synchronous fixture decisions.

Authenticated case assignment, independence/two-person approval, approved risk limits and decision policy, current official-list review, appeals, notification SLAs, legal decisions, production data access/retention, and actual on-chain clearance/reissuance remain T-20/T-13. This revision protocol cannot establish that a human actually read the evidence or had authority to decide.
