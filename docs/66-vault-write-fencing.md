# T-21 — Single-host vault concurrency and recovery boundary

2026-09-07. Local encrypted-file persistence and recovery verification. This is not a managed transactional database/KMS migration, power-loss guarantee, approved production recovery procedure or access-control audit.

## Concurrent writers and unconfirmed writes

The vault encrypts the entire file, fsyncs a private temporary file, atomically renames it and fsyncs the parent directory. Each mutation acquires one mode-0600 `<vault>.lock`, reloads the current ciphertext while holding it, applies the mutation, and publishes the replacement before releasing the lock. A local writer now waits up to five seconds for a normally completing writer instead of immediately returning the operating-system `EEXIST` error. It never removes or takes over a lock. A lock still present at the deadline returns fixed `VAULT_WRITER_BUSY`.

`PM-T21-01` holds a live, test-owned lock while four real child processes prepare independent API issuance, rescreen, appeal and approved purge operations. Before the bounded wait was added, all four exited at the same `EEXIST` boundary and the regression was **0/1**. They now wait, serialize, reload under the lock and preserve the new issuance, rescreen event, appeal decision and deletion tombstone together; the regression is **1/1**. Rescreen/review revisions still reject stale decisions about the same case. Waiting for a short local writer does not create distributed coordination or make a network filesystem safe.

Storage failures remain fail closed. The publication helper reports them as fixed `VAULT_WRITE_UNCONFIRMED` and acknowledges success only after file fsync → rename → directory fsync, including successful handle closure. If rename already occurred, it does not restore the previous file or pretend that the operation never happened. It removes only its own temporary path on a best-effort basis and never deletes the authoritative vault to roll back an ambiguous write.

When a mutation encounters that failure, it reloads observable disk state when possible, poisons further mutations on that instance and retains its acquired lock. A new instance times out as busy. Failure to write lock metadata or close/unlink the owned lock also fails closed. Ordinary semantic rejections such as stale review/conflicting evidence still release their lock and allow a corrected request.

## Backup, restore and rollback floor

`createBackup` takes the same writer lock and copies the exact current encrypted envelope into a new mode-0600 durable artifact. The artifact is authenticated with a key-derived HMAC and binds a random backup ID, creation time, monotonic local vault revision, logical state commitment, ciphertext hash and non-secret key identifier. Creation uses an exclusive hard-link publication and directory fsync; it will not replace an existing backup path. The manifest contains no cleartext record evidence.

`restoreBackup` only writes to an absent destination. Before writing, it verifies the backup authentication/ciphertext, decrypts it, and requires caller-supplied expected backup ID, state commitment and minimum revision. An older backup cannot pass a newer independently retained revision floor. It can also require exact record ID, wallet, claims root, evidence hash and source transaction hash values from read-only chain observations. Any mismatch is rejected before the destination is created. The restored envelope is read back and re-authenticated before its lock is removed.

The revision floor is useful only if the expected backup ID/state/revision is stored outside the backup and protected from rollback. The library does not invent that authority. It also does not reconcile every current chain mark automatically: the caller must supply observations obtained at the approved chain/finality boundary. Restore never overwrites the current vault, never clears an existing lock and never authorizes writers against the restored copy by itself.

`npm run vault:recovery` exposes explicit `backup`, empty-destination `restore`, `rotate-key` and synthetic/approved-environment `drill` commands. Restore requires a requirements JSON document and `--execute`; rotation requires a separate next secret, custodian label and `--execute`. The drill requires explicit RPO/RTO ceilings and commitment observations, and fails if either measured local ceiling is missed. These labels and files are not authenticated IAM or an off-host immutable control plane.

## Key rotation and access boundary

`rotateKey` runs under the writer fence, writes the whole current state with a different derived AES-256-GCM key, advances the vault revision and retains an encrypted maintenance entry binding time, operator label and previous/next key identifiers. After successful rotation, the current file opens with the new key and rejects the old key. Key-derived review revisions change, so a review snapshot taken before rotation cannot authorize a later decision.

This revokes the old secret only for the current rewritten vault. Any earlier backup or copied ciphertext remains decryptable with its historical key. The local process cannot prove that old secret copies were destroyed, that an operator label is a real separate person, or that KMS policy/access logs were enforced. Production rotation needs managed custody, independently authenticated actors, backup re-encryption/expiry and verified revocation.

## External delivery and recovery boundary

`deliverRevocations` checks writability before processing the outbox and again after receipt lookup immediately before a possible broadcast. This covers an already-signed envelope, which otherwise need not call prepare again. An unconfirmed-write instance or present writer lock prevents delivery; the original raw/hash/job is preserved. The existing single-rescreen-runner lease is separate from the short-lived writer lock.

This is a fail-closed local check, not atomic coordination with every external process between a lock check and a network send. It cannot cancel an already-in-flight broadcast. There is no distributed ownership protocol, and a third-party reader holding the key could ignore this library.

Do not retry writes, sign replacements, clear a lock by age/PID alone, restore a backup over the current file, or erase an encrypted orphan automatically. An authorized operator must establish all writers/issuers/delivery owners are stopped, diagnose storage health, preserve file/lock/orphan evidence, reconcile stored transaction hashes, choose an authoritative backup and revision floor, and start a separate restored instance. A rename may have committed even though the API reported failure.

The lock, backup manifest and encrypted maintenance entry are not independent append-only access audit records. Host/power/storage loss can invalidate assumptions about acknowledged bytes. Managed DB transactions and row locks, multi-host coordination, KMS/HSM custody and revocation, off-host immutable backup inventory/expiry, authenticated access audit, hardware/network-filesystem behavior, approved objectives and production restore/failover drills remain T-21.

## Verification

- Concurrency regression: **1/1** after the recorded **0/1** pre-fix failure. Four child processes preserve API/rescreen/appeal/purge results after a live lock is released.
- Focused local vault tests: concurrency **1**, I/O/delivery durability **4**, and backup/restore/rollback/key/CLI **4**. They use only temporary encrypted files and synthetic identities.
- Connected recovery integration: **1/1** on an isolated Sepolia-chain-ID Anvil. It deploys `ComplianceSource`, records an actual `MarkIssued` receipt, rotates the synthetic vault key, backs up and restores, and matches receipt subject/claimsRoot/evidenceHash/transaction hash. The recorded local observation was RPO **35 ms**, RTO **10 ms**, commitments **1** under test ceilings of 2,000 ms.

The I/O tests inject exceptions, not sudden power loss. The timing is one synthetic local observation, not a production SLO, sustained-load result or managed-platform failover. The native proof/hub path is not involved in this restore check because the compared commitment originates in the actual source receipt.
