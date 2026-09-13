# T-05 / T-21 — Issuance respects unconfirmed vault writes

2026-09-07. Local issuance authorization boundary; not a distributed transaction or approved recovery procedure.

The encrypted journal's `evidenceStored` flag records a past successful evidence write. It cannot establish that the vault remains writable after another mutation fails. Previously, `assertMayBroadcast` checked the retained record's identity, state and retention but ignored a poisoned vault instance or its retained writer lock. An unrelated ambiguous write could therefore leave an otherwise eligible record readable while issuance signed or sent a transaction. Source acknowledgement would fail later, after the send.

The shared issuance evidence sink now calls `vault.assertWritable()` before reading authorization. This covers both original poisoned instances and newly opened instances observing the retained lock, including requests whose evidence was already stored and requests with an existing signature. Production web and resume paths already use this shared sink; no separate web implementation is introduced. Explicit no-vault sandbox behavior is unchanged and still depends on the mandatory encrypted journal.

`advanceIssuance` also repeats evidence authorization after its awaited durable broadcast-intent journal save, immediately before entering the broadcast call. A lock or disqualifying evidence update observed at that point prevents sending. This check is outside the broadcast-error catch: a vault storage failure uses the existing fixed `DEPENDENCY_UNAVAILABLE` journal projection, not `BROADCAST_UNCONFIRMED`. The stored raw transaction, nonce and persistent signer gate remain for reconciliation. An unsigned request does not create a signature while the fence is present. Receipt observation is still allowed; successful source/hub acknowledgement still requires the existing vault mutation path, which refuses fenced writes.

Two added root tests failed before the fix and pass afterward:

- Real encrypted vault directory-fsync failure after rename, on an unrelated record: previously stored evidence cannot authorize signing or rebroadcast. All four combinations of unsigned/signed and original/reopened vault are checked. No broadcast, no replacement signature, and the existing nonce gate and lock remain.
- A writer lock created during the awaited journal broadcast-intent save prevents the following send and preserves the exact prepared transaction with an unresolved signer gate and no accepted-broadcast timestamp.

These use synthetic evidence, a real temporary encrypted file and an in-memory journal/transport for deterministic fault ordering. Separate API and connected Redis/two-EVM tests cover normal-path compatibility; their fixture/native-proof limitations remain. This is not atomic exclusion across the lock check and network side effect, does not cancel in-flight broadcasts, and does not resolve previously accepted transactions. It does not add automatic lock removal, backup restore, KMS, storage-health certification or distributed fencing. Recovery requirements and lock limitations remain those in [vault write fencing](66-vault-write-fencing.md).
