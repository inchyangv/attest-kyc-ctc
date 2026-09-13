# T-23 / T-40 — Source recovery must not renew old hub evidence

2026-09-07. The prior `writeRecord` spread old JSON into the new patch. A source-only resume omitted `checkedAt`, registry checks and propagation fields, so earlier observations survived. Its sibling Markdown could still contain submission-ready PASS prose. The CLI's `NOT_CHECKED` message was correct but did not prevent an artifact consumer from treating the merged file as fresh cross-chain evidence.

## Changed behavior

`pipeline/epoch-record.ts` writes the complete current record, not a patch over old observations. Source-only recovery supplies source facts only. Standalone `--check` explicitly takes the original source facts through `sourceEpochRecord`, which strips old checks, off-chain checks, proof-mode flag, check time, acceptance time and propagation measurements. The tail of a fresh `--publish` may carry propagation measured by that same invocation. Source transaction/hash/cutoff facts are preserved when checking; their age is not disguised as a new publication.

Before replacement, existing source identity fields must agree: epoch/root/list version/expiry/cutoff/publication timestamp/snapshot/schema versions, original publication hash/block and deterministic source snapshot. Previously present identity facts cannot silently disappear. Object key order is irrelevant. Malformed, non-file, unreadable or oversized existing evidence is an error rather than a first-write fallback. Records are bounded at 8 MiB. This comparison is a conflict guard, not independent authentication of old files or newly supplied facts; the caller must already have verified the source.

Every successful record write first replaces the sibling Markdown with a conservative **verification not established** marker, then replaces the complete JSON. Both use private temporary files, file fsync, atomic rename and directory fsync. The two files are not one atomic transaction: an error may leave the marker beside older JSON, or a post-rename error may leave new bytes visible without acknowledging durability. Errors are reported as unconfirmed, not success. The encrypted publication journal remains authoritative for raw transaction/nonce recovery.

Only after current checks match and freshness passes does `--check` replace that marker with its observation snippet. Failed verdicts no longer generate the old success-shaped snippet. The snippet text distinguishes original source facts from current observations and from independent deployment/submission approval. An error before the record-writing stage leaves prior artifacts unchanged; this is not a global invalidation service for failed checks. Consumers must still inspect dates, current chain state and command outcome, not infer current validity from a file's existence.

This intentionally replaces stale derived diagnostic fields/prose in the current snapshot. It does not archive them, delete encrypted publication history, undo a source transaction, certify legal eligibility or prove a current CC3 carry. Old immutable artifacts, backups and copied snippets are outside this correction. The helper is not a cross-process lease/CAS for concurrent independent check writers; full observation history, authenticated runtime pins and common-block publication checks remain separate work.

## Executed verification

Three new root tests use owned temporary files:

1. Strip all old hub fields without mutating the input, replace the JSON completely, and invalidate stale PASS prose; verify private permissions and temporary-file cleanup.
2. Refuse changed/missing source identity and corrupt existing records without overwriting them; accept equivalent object key ordering and refuse non-JSON target paths.
3. Inject failure at the JSON rename: return a fixed unconfirmed error, keep previous complete JSON and the conservative Markdown marker, and clean the owned temporary file.

The existing actual Anvil/CLI integration is extended, not counted as another suite. After a real source recovery, it seeds old check/propagation fields and PASS prose only into its owned temporary evidence files, then invokes the actual resume CLI again. Exit remains 2, original source hash is preserved, all stale hub fields disappear and Markdown is unverified; source nonce remains one and ASC epoch remains zero. Its earlier reorg/revert/cancellation and two SIGKILL recovery branches still run.

No workspace deployment record, public chain, real journal or production snippet was modified by these tests. Current official AML data, successful fresh-publication CLI/native proof/CC3 carry, multi-writer operation and independent production audit were not established by this change.
