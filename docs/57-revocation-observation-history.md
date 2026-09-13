# T-20 — Durable historical revocation observations

2026-09-07. **IN_PROGRESS.** Explicit local audit recording, not a permanent enforcement flag, authenticated compliance approval, scheduler or independent finality proof.

## Commands and authority

```sh
# Existing behavior: check current RPC state without writing the vault.
npm run check:revocation -- '<job ID>'

# Explicitly check and append a complete observation to the encrypted outbox.
# COMPLIANCE_OPERATOR_ID is required; it is an opaque audit label, not authenticated IAM.
npm run check:revocation -- '<job ID>' --record

# No RPC or current eligibility check; show the retained history only.
npm run check:revocation -- '<job ID>' --history
```

The ordinary command remains read-only. `--record` uses the same independently supplied deployment pins, exact receipt/cursor and Registry checks described in [the reconciliation runbook](55-revocation-reconciliation.md). It appends only after that operation returns a full source/hub observation. `--history` requires only the vault path/key and job ID; it labels the output `historicalOnly: true` and `currentEnforcement: NOT_CHECKED`. Exit 0 for history means the read succeeded, not that a subject is currently blocked.

No mode signs, broadcasts, changes a credential or reissues anything. The recording mode returns exit 0 only for a newly checked ENFORCED result. A complete AWAITING_HUB, SUPERSEDED or INCONSISTENT result can be recorded and still returns exit 1. A missing/shallow/reverted receipt or RPC/configuration/reorg exception does not produce a full hub observation and is not stored as if it did. Operators must not reinterpret an older ENFORCED entry as the result of that failed current check.

## What is retained

Each append has a millisecond recording time and a versioned observation with operator label, observation time, configured source/ASC/Registry/revoker, runtime hashes, selected policies and required confirmation depth. It includes the source transaction/receipt coordinates, the sampled source head number/hash/timestamp, and the hub block, tombstone, exact cursor and policy booleans. The observed depth must agree with the recorded source receipt/head numbers.

The internal schema boundary reconstructs only these fields. Arbitrary provider diagnostics, identity fields, raw transactions and extra properties are not copied. It validates addresses/hashes, booleans, integer/time/cursor bounds, policy ID agreement and the state implied by the actual cursor/tombstone/verdict data. That validation is not an independent proof: a caller holding the vault key and local code access remains within the trusted writer boundary.

History is stored inside the existing encrypted outbox envelope. A new entry does not change source delivery state, the retained compliance decision, raw-transaction disposal, signer-gate handling or deletion authority. Because deletion approval fingerprints include the outbox, a later history append invalidates an earlier deletion snapshot; it never grants a fresh deletion approval. Existing legally approved deletion/hold procedures still apply separately.

## Concurrency, replay and time

The caller supplies the original job snapshot read before awaiting the checker. Under the existing single-host writer lock, the vault reloads and requires that exact job to remain unchanged. A concurrent delivery, diagnostic change or other observation causes `REVOCATION_JOB_CHANGED` with no partial write. Obtain a fresh job and recheck; do not overwrite a more recent result or automatically adopt a fresh snapshot after the RPC response.

Transaction/source bindings must match the stored job. Recording must occur no earlier than the observation/job and within five minutes of the observation. Observation and recording times cannot go backwards relative to the last entry. Same-second observations can record distinct block states. An identical latest observation, including its operator label, does not append a duplicate or move its original recording time.

ENFORCED followed by SUPERSEDED remains two entries, not a rewritten past. An observed rollback can similarly be recorded as a later negative full observation; an RPC exception itself is not silently turned into a state claim. Optional fields do not require a vault format migration, but old writer code does not enforce the new recording API and must not remain in a release claiming these guarantees.

## Verification and limits

Six root tests cover restart persistence and later supersession, unchanged BLOCK/source state, stale snapshot rejection and duplicate replay, wrong transaction/stale/backdated or inconsistent claims, strict metadata projection, incomplete observations, a real history CLI subprocess with unusable RPC settings, refusal of recording without an operator label, and invalidation of earlier deletion authorization. These tests use fictional records and synthetic observations.

The existing real local two-chain rescreen case now records its actual checker results before and after relay, reopens the encrypted file, verifies the AWAITING_HUB→ENFORCED history and preserves blocked compliance/source-confirmed delivery. The chain clock is intentionally synthetic; recording in that helper-level test supplies an explicit matching local recording time. The operational CLI offers no clock override and still refuses those future-dated chains. A successful production `--record` run is not claimed.

This is append-only through the supplied API, not tamper-evident WORM storage or protection from a compromised vault key/host. There is no automatic pruning, archive export, per-case history cap, immutable external anchoring, authenticated reviewer identity or scheduled monitor. History growth, legally approved retention/holds across stores, backup integrity and operational alerting remain T-21/T-33/T-17/T-20 work. No historical entry guarantees current eligibility; source/hub reorgs, later issuance/denial and policy/deployment changes require a new check.
