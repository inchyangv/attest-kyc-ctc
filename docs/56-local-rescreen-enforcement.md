# T-20 — One local rescreen-to-enforcement case

2026-09-07. **IN_PROGRESS.** The local contract integration now connects the real screening engine, encrypted vault, durable outbox, production revocation transport, source receipt, ASC relay, reconciliation helper and token rejection in one test. It is not a public deployment or a completed institutional workflow.

## Connected sequence

Run `npm run test:cross-chain-gate`. In the existing two-Anvil scenario, Bob first has an actually issued, materialized and witnessed sandbox credential and receives 25 test tokens from Alice. His retained vault record uses that original issuance's request ID, claims, attributes and evidence hash; the source observation references the real local issuance transaction. The test records the already-verified local materialization and establishes active state.

A changed fictional sanctions corpus then lists Bob's random local wallet. This uses the real list-backed engine, not a stubbed BLOCK response. The corpus occupies the existing `OFAC_SDN` schema slot with an explicitly fictional entry/version; it is not an official source update or freshness claim. Read-only screening returns BLOCK without changing encrypted bytes or creating an outbox job. Committing screening writes blocked state, the list version and its revocation job together, with the original issuance case ID and source target.

The same EVM transport used by `rescreen --publish` signs a one-subject, reason-2 `revokeBatch`. A separately authorized local revoker account is used; it does not share the issuance signer's nonce. Before broadcast, the test reopens the actual vault and checks that the signed bytes are already retained. It then deliberately loses the acknowledgement **after real local broadcast acceptance** and makes receipt waiting fail as if the runner stopped. The first delivery therefore exits with one prepared pending job, not a false confirmation. A newly opened vault instance reconciles the real receipt by the retained hash; replacement signing and rebroadcast are fail-fast assertions. Recovery marks the outbox source-confirmed, removes raw signed bytes and consumes exactly one revoker nonce. Reopening and delivering again sends no transaction.

Before relay, the reconciliation helper returns AWAITING_HUB and the asset gate still permits Alice→Bob. After local relay of that exact revoke receipt, the helper returns ENFORCED with the same transaction hash; the Registry rejects Bob and an actual attempted token transfer reverts with the expected recipient error and unchanged balances. The later [observation-history extension](57-revocation-observation-history.md) persists both results and verifies them after reopening the vault. The source-confirmed outbox remains a source acknowledgement; stored history is not a current or permanent hub-enforcement flag.

## Production transport change

`pipeline/rescreen-evm.ts` is now shared by the operational CLI and the integration test. Initialization binds the configured chain, existing source code, confirmation count, signer provider and optional epoch. Preparation respects the job's source target. Before broadcast or reconciliation, it validates the original signed transaction: signature/hash, signer, chain, destination, zero value and exactly one nonzero subject with reason 2 and nonzero uint32 epoch. Delivery also checks that this signed subject matches the retained job's wallet, including replay of already-prepared jobs.

Source confirmation requires matching receipt hash/from/to, sufficient sampled depth, canonical block hash and exactly one matching subject/reason/epoch revocation event. The receipt block is rechecked before accepting success or a mined revert. `wait` performs that reconciliation again; its return status alone cannot confirm a job. Unknown/forked outcomes remain pending. The CLI owns and destroys its provider when finished or initialization fails. It still requires the existing exclusive runner lease and a dedicated signer; this is not a distributed nonce coordinator or runtime-pin approval system.

Four new root tests exercise real signed transaction serialization with synthetic RPC responses: altered target/chain/signer/value/calldata/subject/reason/epoch, wrong broadcast hash, missing/wrong/duplicate source events, wrong receipt identity, shallow/forked blocks, wait revalidation and invalid initialization/target configuration. Actual prepare/broadcast/receipt use is covered by the two-Anvil path above.

## Additional defect found by integration

The first end-to-end screening attempt returned ALLOW because wallet indexing accepted only lowercase EVM addresses. XML ingestion already lowercases addresses, but the engine's public corpus interface also accepts entries without that ingestion step. A mixed-case local address was silently omitted from the index. `buildCorpus` now validates case-insensitively and lowercases at the index boundary. A new AML regression covers mixed/lower/upper hex listed addresses and mixed/lower subject addresses, with an unrelated wallet still allowed. Listed-wallet matching still does not earn the transaction-graph exposure bit.

The engine version advances from `aml-1.3.0` to `aml-1.3.1` so evidence identifies the changed matching behavior. This does not reissue credentials or rewrite historical evidence. Anvil can give successive blocks the same timestamp, so the test explicitly chooses a screening instant at least one millisecond after its prior screening to meet its one-millisecond synthetic interval; no operational interval or clock check was relaxed.

## List-edition trigger boundary

The later `PM-T20-01` regression covers an active case that has just recorded an ALLOW under fictional edition 1, then becomes an exact wallet BLOCK under edition 2 one millisecond later while a 24-hour screening interval is still open. Previously the second pass selected zero cases because the interval was the only due condition. The permanent unit regression was added first and failed `0 !== 1` on that boundary.

`screenDue` now reads and validates the engine's complete current `listVersions` snapshot before adding list-triggered work. The vault compares that exact key/version set with the case's last committed rescreen event. Any addition, removal or version change bypasses the ordinary interval; a case with a prior screening timestamp but no retained rescreen-version baseline is conservatively selected. An unchanged version set still follows the configured interval. Each returned screening result must carry the same version set selected for the run or the commit fails with `SCREENING_LIST_VERSIONS_CHANGED`.

Interval-due records are snapshotted before the first asynchronous engine call, preserving the existing fence against concurrent review or deletion. List-triggered records are then added without replacing those snapshots, and `recordRescreen` still compares each selected case under the vault writer lock. The two-Anvil integration now stores the real list-backed edition-1 ALLOW, changes to the fictional wallet-listed edition 2, and proves that the 24-hour interval does not prevent the existing BLOCK/outbox/source/hub/token-rejection sequence.

This is an execution boundary, not an installed data watcher or scheduler. It takes effect whenever the one-shot rescreen runner is invoked with a changed, internally consistent corpus. The repository's existing scheduled-run state and monitors can detect missed/failed runs and pending delivery, but no operating-system scheduler, official-list activation, authenticated alert delivery or recipient acknowledgement was installed.

## Limits

The initial issuance's ID/bank/wallet-control inputs remain fixtures in this contract test. The retained record is built from the resulting original issuance, not created by the web API. The separate connected API test is not silently merged into this one. Native proof verification remains MockBlockProver; actual public proof construction, worker/query-service operation, finality and release pins remain unverified. The CLI checker intentionally rejects these future-dated local chains under its real host clock.

The T-03 [outbox runbook](20-rescreen-outbox-operations.md) also defines a durable redacted state for externally scheduled one-shot runs and a read-only missed/stalled/failed-run monitor. It neither installs a scheduler nor delivers an alert.

Remaining T-20 work includes durable hub acknowledgement and its reorg/supersession policy, reviewed case authorization, notices/appeals/reissue, production scheduler/alert installation and receipt, current official list activation, retention-versus-live-credential handling and approved live drills. No real person, institution, operational key or public-chain transaction was used.
