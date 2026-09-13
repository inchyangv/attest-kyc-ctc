# Recoverable issuance — working-tree implementation

Status: locally tested, not deployed. This addresses T-05 and parts of T-24/T-36. It does not certify production readiness, replace an independent audit, or upgrade the historical sandbox contracts.

## Safety contract

The API commits the original outcome, salted claims, evidence, target and consent version to an encrypted shared journal before signing. Concurrent creation has one winner; changed input for an existing request returns 409. Resumption never reruns AML or generates fresh salts for that request. A new screening flow is required after an unsigned preparation expires (15 minutes).

| Journal phase | Meaning | Next action |
|---|---|---|
| `prepared` | Original payload stored; signature may already be stored | Resume the same request |
| `submitted` | Original signed bytes and broadcast intent stored; source outcome unresolved | Recheck receipt, rebroadcast identical bytes if needed |
| `source-confirmed` | Canonical successful source receipt, matching event and confirmation depth checked | Check exact CC3 mark and source coordinates |
| `materialized` | Exact CC3 propagation observed | Historical acknowledgement, not current eligibility |
| `failed` | Rejection, expired preparation, unreconciled consumed ID, or confirmed revert | No automatic fresh transaction; only confirmed revert supports explicit retry |

Default source depth is six blocks. Receipt validation checks canonical block hash, sender, destination, transaction hash, successful `issueOnce` event fields and consumed request ID. Signed transaction validation checks the exact calldata, chain, issuer, source, nonce and zero value. CC3 checking pins the ASC/source/chain relationship and compares mark contents, tombstone, source block and transaction index at one hub block.

For a configured stable issuer, `RotatingIssuerEvmTransport` instead pins the contract issuer, public operating-key address and exact positive key epoch in the same encrypted journal target. It signs typed wrapper calldata to the stable issuer, requires the source role on that contract and explicitly rejects a direct source role on the operating EOA. Receipt validation requires the source's unique `KeyedMarkIssued` with the pinned epoch; materialization also checks ASC key provenance and current cutoff usability. `ROTATING_ISSUER_ADDRESS` and `ISSUER_KEY_EPOCH` must be supplied together. Rotation after preparation therefore fails closed instead of silently signing under a different generation.

A later source reorg is checked on resume. A stored `status` response is a snapshot, not a live chain check. A materialization acknowledgement is historical: current policy, sanctions, freshness and eligibility still require the Registry. If a later mark supersedes this one before acknowledgement, the runner deliberately cannot infer that the original mark was observed; operator reconciliation remains necessary.

The journal becomes terminal `materialized` only after the retained evidence sink has durably recorded the matching hub acknowledgement. If that activation write fails, or commits but its response is lost, the journal remains `source-confirmed` with `DEPENDENCY_UNAVAILABLE` and stays in the recovery queue. A later bounded pass repeats the idempotent activation before terminalizing the journal; it does not sign or broadcast again. This ordering prevents a terminal journal entry from hiding a vault record that is still `pending`.

## Shared state and nonce ownership

`pipeline/issuance-journal.ts` uses one Redis Lua transition across keys sharing a Redis hash slot. Each request has a 30-second lease plus revision comparison. A stale owner cannot save a new signature. Signed bytes and broadcast intent must be saved before sending; a lost Redis response must be reconciled by reloading, never by assuming the write failed.

The issuer gate has **no time-based expiry** while a nonce is unresolved. Different requests cannot take that signer until confirmation or a terminal unsigned failure releases the gate. Lease expiry permits recovery of the same request, not nonce reassignment. Gate-owning requests are returned before the bounded pending queue so older source-confirmed entries cannot starve recovery. The key must be exclusive to this issuance workflow: another service signing with it is outside this coordination guarantee.

Redis must provide durable, non-evicting primary state with atomic Lua execution. Loss/rollback of the journal can destroy the original transaction association even when the chain consumed the request. Do not clear a gate or reset a namespace to unblock a queue. Pause new issuance, restore a consistent backup and reconcile signed hashes/nonces with the source before resuming. Managed REST-provider conformance, failover and recovery drills remain deployment gates; the local Redis tests do not prove those properties for a vendor.

## API and UI

All actions require a valid wallet proof with `proofmark-kyc-v3` consent. A fresh proof for the same wallet can recover a known request ID without the old ID/bank tokens. Another wallet gets 404 without claims. The request ID is not a bearer credential. `POST /api/kyc/status` is the request-specific read endpoint; `GET /api/kyc/status` remains deployment/vendor configuration. The POST handler forces `status` regardless of a body-supplied `resume` or `retry`, so a read endpoint cannot sign, broadcast, acquire a lease or mutate the journal.

- `action: "issue"`: derive ID from authenticated wallet/flow, create or resume the immutable payload.
- `POST /api/kyc/status` with `requestId`: read only; no signing, sending or lease mutation. The legacy issue-route `action: "status"` remains compatible.
- `action: "resume", requestId`: one bounded reconciliation step; may sign or resend as above.
- `action: "retry", requestId`: only a confirmed source revert permits a fresh signature. Original payload remains unchanged, old hash/nonce is retained, and the preparation deadline still applies.

The verify page stores only the last request ID in wallet-scoped session storage and exposes load/resume/revert-retry buttons. Responses and downloaded evidence include the request ID; raw signed bytes are never returned. Every response projects source state, exact CC3 attestation state, current Registry policy state and per-policy asset readiness separately. `source-confirmed` and even historical `materialized` cannot set asset readiness without a current Registry PASS. While an asset-not-ready result remains open and has not reached its configured timeout, the page checks the read-only status endpoint every five seconds; mutation remains an explicit Resume/Retry action.

The deployment can publish operator-approved source/CC3 expected ranges, a whole-flow timeout and an HTTPS support path with `ISSUANCE_SOURCE_EXPECTED_SECONDS`, `ISSUANCE_HUB_EXPECTED_SECONDS`, `ISSUANCE_TRACKING_TIMEOUT_SECONDS` and `ISSUANCE_SUPPORT_URL`. Ranges use positive `min-max` seconds. Missing or malformed values are returned as unconfigured rather than replaced with guessed timing. Selecting values, staffing the support path and validating them under operating load remain deployment decisions.

Attribute-only policy previews are explicitly not on-chain verdicts. Source confirmation and CC3 propagation have separate labels. The connected local browser recovery described below is verified; real wallet-extension/mobile return, production hosting and public-chain recovery remain T-24/T-39 work.

## Configuration and runner

Set the same `ISSUANCE_JOURNAL_REDIS_REST_URL`, `ISSUANCE_JOURNAL_REDIS_REST_TOKEN`, `ISSUANCE_JOURNAL_KEY` (at least 32 characters) and `ISSUANCE_JOURNAL_NAMESPACE` on API and recovery runner. Use an authenticated HTTPS primary REST endpoint supporting JSON Redis commands and `EVAL`. The absolute completion deadline now requires **Redis 7-compatible `PEXPIRETIME` and `redis.acl_check_cmd`**, plus permission for `PEXPIRETIME` and `PEXPIREAT` inside Lua. `PEXPIRETIME` is checked before any mutation, even create/acquire; terminal writes also preflight `PEXPIREAT` permission before changing payload/signer ownership. Missing support/permission fails closed as journal unavailability. This does not prove rollback under every Redis/OOM/other-command failure. No local-memory or sliding-TTL fallback exists, even for demo issuance. The bank challenge store has separate configuration and purpose. Provider capability/conformance and deployment are not proven by the isolated Redis test.

For signing/reconciliation also configure `ISSUER_PRIVATE_KEY`, `NEXT_PUBLIC_SEPOLIA_RPC`, `NEXT_PUBLIC_CC3_RPC`, `NEXT_PUBLIC_SOURCE`, `NEXT_PUBLIC_ASC` and optional `ISSUANCE_CONFIRMATIONS` (default 6). The implementation pins Sepolia 11155111 and CC3 102031. Where evidence retention is enabled, the runner needs the same persistent `EVIDENCE_VAULT_PATH` and `EVIDENCE_VAULT_KEY`; the file vault is not usable on Vercel. API wallet proofs additionally require `EVIDENCE_HMAC_KEY`.

```sh
# Reads pending IDs, phases and hashes only; does not sign or send.
npm run issuance:resume

# Explicit mutating mode: one bounded pass; use only in an approved deployment.
npm run issuance:resume -- --publish
```

Deploy a monitored scheduler for the bounded pass; the browser is not a reliable scheduler. This repository adds the runner but has not installed or run a production schedule. Alert on oldest pending age, persistent signer gate, repeated dependency errors, missing source confirmation and missing hub propagation. `--publish` does not automatically retry a confirmed revert. Inspect the cause and obtain a wallet-authenticated explicit retry or a new screening flow.

## Privacy and retention

The shared journal contains personal claims, salts and evidence, encrypted with AES-256-GCM and request-ID-bound authenticated data. It is **not** a no-retention sandbox. Consent v3 discloses the journal, reconciliation-based retention, 24-hour completion retention and separate issuer evidence retention. The displayed checkbox and SIWE signature use the same statement. Old v2 proofs fail closed; users must sign again after rollout.

Pending records persist until reconciliation. As of 2026-09-07, successful/failed terminal records receive one absolute `terminalExpiresAt` deadline, using Redis time plus 24 hours at the start of a continuous terminal episode. The hash metadata and physical `PEXPIREAT` deadline are written in the same Lua operation as the terminal payload and queue removal. Reads, duplicate creates, release/acquire, diagnostic saves (including a real `advanceIssuance` dependency failure), and recovery after a lost save response do not restart the clock. The timestamp is operational hash metadata, outside the encrypted evidence payload; it is not an authenticated legal-policy decision.

An explicit confirmed-revert retry or reorg reconciliation can return a terminal record to nonterminal state. That save clears its deadline and makes the record persistent while recovery is unresolved, retaining the existing signer gate rules. A later terminal transition starts a **new** completion episode and its 24-hour deadline. This is intentionally not an immutable lifetime limit from first failure: deleting a pending signed transaction merely because a previous failure's deadline passed could strand its nonce. Backlog limits, approval of these retention purposes and unresolved-case handling remain open T-33 gates. The generic journal adapter relies on the delivery service to authorize phase transitions; this patch does not add an independent legal or state-machine approval authority.

For a legacy terminal key with a physical TTL but no deadline field, the next terminal save adopts the exact existing `PEXPIRETIME`, not a new 24-hour window. A shorter physical TTL is also preserved. Malformed, out-of-range or already-passed stored deadlines fail before payload/lease/signer mutation; they are not silently repaired or used to erase uncertain recovery data. An inconsistent key can therefore remain physically present pending supervised reconciliation. Redis expiry is verified for consistent completed records, not claimed as forensic storage destruction or a hold-aware disposal policy.

Stop old writers before rollout. The encrypted payload format remains v1; old Lua writers can still overwrite physical TTLs or omit the new metadata, and this is **not** a mixed-version-fleet fence. Restores, metadata loss, legacy terminal records that have lost their TTL, Redis backups/AOF/replicas and recreated expired request IDs require a separately approved recovery/deletion policy. This change does not prove their original completion time or prevent all journal resurrection. Encryption is not anonymization, and indefinite unresolved records require operational/legal handling before real personal data is allowed.

The file vault starts approved issuance as `pending` and activates it only after matching CC3 acknowledgement. A delayed callback cannot overwrite `review` or `blocked`. A pending copy can exist after signing/storage failures; it must not be treated as active KYC. Source-confirmed records awaiting CC3 still need ongoing compliance coverage (T-20).

Deleting a file-vault record does not delete its copy in the journal or backups, nor the public on-chain commitments. The [v2 vault deletion controls](42-vault-deletion-controls.md) now enforce local deadlines, holds and snapshot-bound approval, refuse pending issuance/review/revocation deletion, and prevent a journal evidence sink from reinserting a tombstoned record into that surviving vault. They do not add holds or erasure to Redis, protect an old full-vault restore, or cancel a signed transaction. Cross-store erasure/hold propagation, KMS/access audit, provider residency and cancellation/revocation of already signed transactions are unfinished T-21/T-32/T-33 gates. Do not claim complete erasure or legal compliance from this implementation.

## Verification evidence and limits

### Recovery ID before a potentially lost response

The wallet-signature response now includes the request ID for that authenticated flow. Wallet and issuance routes use one shared derivation function, preserving the existing `keccak256(lowercaseAddress + "|" + flowId)` mapping. Returning an ID neither allocates a journal record nor grants access to one: status/resume still require a valid same-wallet proof. A newly signed flow gets its own ID but can recover an explicitly supplied older request owned by the same wallet.

The verification page stores the flow's recovery ID in session storage **before** sending its first issue request. Previously it saved only an ID received in a success/error response, so a completely lost initial response could leave a refreshed page without a recovery target. Reconnecting reads the previous saved ID and does not overwrite it with the new flow's ID. Selecting a new sample resets local form state, not the saved recovery record. Loading the original result after reconnect does not resend identity or bank proofs.

Session storage contains the request ID only, not wallet/ID/bank tokens or personal fields. If storage is unavailable, the displayed in-memory ID can be copied, but persistence across refresh is not guaranteed. Clearing/closing the browser session, changing devices or losing both the ID and original flow remains a support/recovery limitation. An ID prepared before an uncommitted request may legitimately return 404; it is not proof that issuance happened. Do not automatically start a replacement issuance merely because the first response was lost.

The new page fails closed if an older wallet API omits the recovery ID; deploy compatible wallet/issue/page versions together. No public rollout was performed.

### Vault activation before terminal journal state

The materialization boundary has a dedicated fault regression for both failure-before-commit and commit-with-lost-response behavior. Before the ordering fix, the first activation error left the journal terminal `materialized`; Redis therefore removed the request from the recovery queue while the vault could still be `pending`. The regression failed **0/1** with that behavior. The delivery flow now activates the retained evidence first, then saves terminal journal state. Both ambiguous cases retain the original transaction, source confirmation and signer history, remain discoverable as `source-confirmed`, and recover without a second signature or broadcast.

The real isolated-Redis integration additionally checks queue membership: activation failure leaves the request in `pending()`, and successful replay removes it only after terminal persistence. This establishes local state-machine/Redis behavior, not managed-store durability, backup restoration, scheduler deployment or an atomic transaction spanning Redis, the file vault and either chain.

The [connected local integration](51-local-api-issuance-integration.md) injects loss after real Redis commits the signed-payload save and after the actual issue route confirms a source transaction. In the former case no transaction is broadcast before recovery; in the latter the source nonce has already advanced once. Status/resume with a new signed wallet flow preserves the original raw transaction hash, claims and evidence, ending with exactly one source nonce consumed in either case. This is a real local storage/EVM/API fault test, not a managed-Redis outage or public chain test.

The Chromium synthetic-sample test separately aborts the first issue request without delivering any response. It checks session storage from the request interception callback, reloads the page, selects a sample and reconnects with a different fixture flow, then loads the old ID without issuing again or sending ID/bank proofs. Its API and injected wallet are mocks; it does not turn the local API/chain test into a browser-to-public-chain E2E result.

The later [connected browser integration](51-local-api-issuance-integration.md#connected-browser-recovery) also drives the built page through actual wallet/ID/bank/issue route implementations and the real isolated Redis journal, vault and source EVM. It drops all source-confirmed replies, including Chromium transport retries, then verifies page reload, explicit fresh EOA signature and original-ID status/resume without old ID/bank proofs. The visible transaction hash, retained claims and single consumed source nonce agree. The API responses are not mocked in this test; the wallet interface, institutions, AML data and native cross-chain verifier are. A same-origin test server dispatches actual routes, not Next's production API transport. Later witness/token/revocation actions are local test-process transactions, not browser wallet transactions.

- `pipeline/issuance-delivery.test.ts`: orchestration fault injection, immutable recovery, lost save/broadcast responses, signer blocking, explicit revert retry and stale lease. Journal/chain are test doubles here.
- `test/issuance-redis.integration.ts`: 12 tests against actual isolated Redis. Covers concurrent creation, encryption, lease/CAS, persistent signer gate, lost-save recovery; activation-before-terminal queue recovery; repeated terminal saves and actual delivery errors; legacy/shorter absolute expiry; reopened pending episodes; committed terminal response loss; actual key expiry; invalid deadline metadata; and actual Redis ACL denial of `PEXPIRETIME`/`PEXPIREAT` before mutation. The short expiry test changes only its synthetic key. REST transport is bridged to Redis, not a deployed REST provider.
- `test/issuance-evm.integration.ts`: actual local Anvil source deployment/signatures/events, tampering, confirmation, source reorg and reverted transaction retry. Hub responses are explicit fixtures, not the live Attestcoin precompile.
- `web/tests/issuance-route.test.mts`: read-only handler ownership, original claims, old-consent rejection, response redaction and missing-journal failure. Not a browser wallet/ID/bank/issuance end-to-end run.
- `pipeline/vault.test.ts`: actual encrypted-file pending/activation, replay, hash mismatch and review/block preservation.

CI runs the new Redis, local EVM and API tests. No operational key, real bank call, public-chain transaction or deployment was used to obtain these results.
