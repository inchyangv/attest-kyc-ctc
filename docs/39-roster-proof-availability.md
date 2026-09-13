# Immutable roster bundles and independent proof replicas — T-19, partial

2026-09-07 KST. Local artifacts, synthetic replica outage tests, read-only chain-check fixtures and local EVM cost measurements. No public distribution, production proof API, customer data export or availability SLA was deployed.

## Available path

`pipeline/roster-bundle.ts` exports the selected public wire fields from a current-format epoch record into a canonical JSON bundle. It binds explicit source chain ID/key/address, hub chain ID, ASC, Registry, epoch/root/list version, cutoff/publication/expiry/snapshot, declared issuer approvals and complete sorted roster entries. File identity is SHA-256 of the exact UTF-8 bytes. The filename is `<sha256>.json`; write-once creation refuses to overwrite an existing artifact.

Loading requires an explicit content hash and reconstructs the root. Unsupported versions, invalid fields/times/attrs, duplicate subjects/issuers, missing issuer coverage, wrong root, unexpected raw fields and oversized inputs fail. Limits are 64 MiB and 100,000 entries, not a tested memory/latency guarantee at the upper limit. The tree is kept private in memory; returned metadata/proofs are detached, so one caller cannot corrupt later responses. Subject lookup uses binary search for both inclusion and non-inclusion, followed by depth-sized sibling extraction.

Copies do not need a publisher process, issuer key, source RPC or running indexer to regenerate proofs for that root. They **must exist before the publisher artifact is lost**. No scheme can reconstruct undisclosed leaves from a root alone. The publication CLI now fails before journal intent creation/signing unless the operator explicitly acknowledges the disclosure and supplies at least two distinct replica directories. It fsyncs a canonical content-addressed prepublication seed containing all leaves and provenance to every directory, then binds its hash/count into the encrypted publication intent. Once the source receipt supplies the otherwise unknowable `publishedAt`, exact final bundles are written to every same replica. Existing exact files make recovery idempotent; conflicts, missing copies and changed bytes fail closed.

Two directories on one machine are only two configured copies, not independently operated storage. This code does not upload them, prove geography/durability or establish an SLA. `EPOCH_BUNDLE_REPLICA_DIRS` and `EPOCH_BUNDLE_DISCLOSURE_ACK=wallet-linkable-roster-approved` are therefore operational inputs requiring prior destination/data-right approval. A legacy journal without the seed binding can be recovered into replicas, but its record says `prepublicationBound: false`; it is not retroactively represented as prepublication availability evidence.

## CLI and proof API

```sh
# Existing current-format epoch record and independently reviewed deployment coordinates.
npm run roster:bundle -- export EPOCH_RECORD DEPLOYMENT_JSON OUTPUT_DIR --ack-linkable-roster
npm run roster:bundle -- proof BUNDLE_JSON SHA256 SUBJECT
npm run roster:bundle -- recover-seed SEED_JSON SHA256 SOURCE_PUBLISHED_AT OUTPUT_DIR --ack-linkable-roster
npm run roster:bundle -- check BUNDLE_JSON SHA256 SUBJECT POLICY_ID TRUSTED_DEPLOYMENT_JSON HUB_RPC
npm run roster:bundle -- serve BUNDLE_JSON SHA256 4178 --ack-linkable-roster
```

The bundle CLI never loads `.env`, reads issuer private keys or sends a transaction. Local export/recovery creates mode-0600 files. Input is a bounded regular file; growth during reading is rejected. `recover-seed` needs only a surviving pinned seed and a source receipt timestamp observed independently of the failed publisher; it does not establish that the root is current. `check` uses an explicit read-only RPC with a 10-second request timeout. Exit zero means the requested read completed, not that a credential was accepted: inspect the structured verdict.

The server binds **127.0.0.1 only** and loads a validated immutable bundle before listening. Its one route is:

```text
GET /v1/rosters/<sha256>/proof/<0x-subject-address>
```

There is no mutable `latest` alias, URL-controlled file path, raw bundle download endpoint, RPC forwarding, signing or access log. Only GET is accepted; query strings, request bodies and cross-origin browser requests are rejected. The local server limits its request target, connections, header/request time, requests per socket and a global 120-request/minute budget. Success responses are privately cacheable immutable **historical proof artifacts**, not cached current-eligibility responses. Unknown pins/paths fail without returning another epoch's proof. This is not a production gateway, distributed quota or abuse-tested public service.

An inclusion response contains the leaf mark, proof, pinned scope and encoded witness request. A non-inclusion response contains adjacent keys/mark hashes and proofs, not the neighboring holders' clear addresses. Both say `chainValidation: not-performed`. Absence means only absence from that publisher-asserted root, never “sanctioned,” “never issued,” or “legally prohibited.”

## Current chain validation is separate

`checkBundleProof` takes **independently trusted consumer coordinates**, not addresses copied blindly from a downloaded file. It reads actual hub chain ID, pins all dependent calls to one latest block and rechecks its hash. It checks Registry/ASC schema capabilities and bindings, source chain key/address, current epoch/root and all epoch provenance, issuer approval, policy frozen status and `requireRoster`.

For inclusion it asks `verifyWithRoster` for the requested policy and simulates `cacheRosterWitness` only if the policy proof passes. The returned transaction is re-encoded from the checked proof fields: arbitrary `transaction.to/data` supplied in a proof response is ignored. Nothing is signed or sent. A wallet still needs to authorize delivery; the actual transaction can fail if the epoch/state changes meanwhile. The token must evaluate `isVerified` at execution, after witness storage.

For absence it checks `proveNotInRoster` and returns `eligible: false` even when `proofAccepted: true`. This avoids interpreting a successful absence proof as a positive credential. A stale bundle, a new epoch with the same root, unknown schema, wrong scope/source/ASC, missing approval, mutable/Direct policy or changed observation block fails closed. A normal policy rejection returns false without a witness transaction.

This is latest-block observation, not finalized evidence or a guarantee against a malicious RPC/A→B→A race. Source chain ID/key association comes from the consumer's trusted deployment configuration; a hub read alone does not independently discover that association. Content hashes and file `approvedIssuers` are not signatures or chain evidence.

## Privacy and distribution approval

The bundle exposes the full wallet-linked roster and credential attrs/issuer/claims/evidence commitments. These are not names or ID documents, but they are not anonymous or unlinkable. API queries expose the requested wallet to the serving replica and its network infrastructure. No claim of privacy-preserving membership discovery is made.

Exporter field selection excludes operational records and raw PII; the loader rejects unexpected fields. The acknowledgement flag makes this disclosure explicit but is **not** legal consent, vendor redistribution permission or permission to publish customer data. Approve destination, access control, retention, mirror owners and data rights before exporting real records beyond the authorized operations environment. Proof API authentication, selective distribution, private retrieval and deletion/retention obligations remain open design work.

## Measured local cost, not a production target

Command: `npm run roster:benchmark -- 1000 10000 --gas --http --source-replay --write`, after `forge build`.

Evidence: `artifacts/roster-benchmark/2026-09-07T13-47-27-495Z/report.json`, September 7 22:47:27 KST, Node 24.15.0, darwin arm64, Apple M5 Pro. Artifacts are gitignored; rerun the command in another checkout. One process/run, 100 in-process inclusion queries plus 96 localhost HTTP requests at concurrency 16 per case. Source measurements use actual `ComplianceSource.issueBatch` and `publishEpoch` transactions and full receipt-root replay on isolated Anvil; the two reader interfaces deliberately share that one local node and are not independent infrastructure.

| Metric | 1,000 synthetic holders | 10,000 synthetic holders |
|---|---:|---:|
| Synthetic inputs + initial root | 119 ms | 1,072 ms |
| Export + root recheck | 113 ms | 1,096 ms |
| Replica load + tree reconstruction | 102 ms | 1,006 ms |
| Bundle bytes | 354,660 | 3,540,660 |
| Inclusion query p50 / p95 / p99 | 0.252 / 0.319 / 0.488 ms | 0.277 / 0.347 / 0.573 ms |
| localhost HTTP 96 requests, concurrency 16 | 0 failures; p95 16.603 ms | 0 failures; p95 8.889 ms |
| Proof depth | 10 | 14 |
| Inclusion / absence response bytes | 3,193 / 2,603 | 3,728 / 3,160 |
| Witness calldata bytes | 644 | 772 |
| Local inclusion harness gas estimate | 38,417 | 44,025 |
| Local absence harness gas estimate | 58,260 | 69,162 |
| Local storage-proof harness actual gas | 60,979 | 66,587 |
| Actual source issuance tx/events/gas | 10 / 1,000 / 5,868,262 | 100 / 10,000 / 58,712,968 |
| Actual source root tx/gas | 1 / 55,703 | 1 / 55,703 |
| Cold replay time / total instrumented calls | 448 ms / 91 | 3,909 ms / 362 |
| Replay blocks / receipts / source logs | 29 / 13 / 1,003 | 119 / 103 / 10,003 |
| Cumulative process peak RSS | 301,006,848 bytes | 1,147,748,352 bytes |

The HTTP sample is a short loopback run below the server's 120-request/minute budget, not sustained customer traffic, distributed quota, TLS/gateway overhead or a production percentile. Peak RSS is process-wide and cumulative, including earlier cases, source replay, fixtures and tree rebuilds; heap deltas include GC effects. The proof gas measurements call compiled `RosterProof` through a minimal contract on isolated Anvil. Its storage path writes one proof-derived slot, but it is **not** Registry policy/ASC/native-verifier gas, an Ethereum/CC3 fee, or the cost of delivering every holder's witness.

The measured write model still contains per-person source issuance **events**: batches of 100 made the 1,000/10,000 cases 10/100 source transactions, followed by one root publication. Individual hub issuance materialization is not required by the source-replayed roster builder, but the existing worker still watches those events. Storage-only consumers need per-holder witness storage updates for a new epoch, in addition to one native-proof-backed hub epoch acceptance. A root transaction alone does not make these writes constant. Public archive latency, real source/hub fee prices, native proof cost and actual Registry witness gas remain unmeasured; the report does not extrapolate a production bill from local gas.

## Verification and remaining work

Five bundle/server tests validate canonical exports, exact calldata/proofs, tampering/limits/schema/raw fields, detached responses, empty/sentinel/binary-search cases and replica service after deleting only the test's synthetic origin file. Two `PM-T19-01` availability tests require at least two durable seeds, reject a missing/changed staged copy before finalization, remove the publisher origin and one replica, and reconstruct a proof from the survivor. The actual CLI test also checks acknowledgement, mode-0600/no-overwrite and offline seed recovery. Publication integration verifies the missing-replica configuration consumes no source nonce, binds the seed hash/count before signing, and writes two final bundles after the actual local source receipt.

Three read-only chain fixtures verify every call's block tag, re-encoded transaction safety, same-root/new-epoch invalidation, schema/source/policy/approval/provenance mismatches, reorg, policy rejection and negative-proof semantics. A compiled ABI test checks the reader's selectors and return layouts against both contracts. The local gas fixture only verifies proof algorithms; the additional local contract/wallet integration below now exercises the online checker separately.

### Connected bundle-to-wallet test

`npm run test:cross-chain-gate` now exports complete bundle provenance from actual local source publication receipts and the source-replayed roster, then loads those canonical bytes by their content hash. The consumer's source/ASC/Registry coordinates come from the test's own deployments, not from the downloaded proof. Native proof verification is still mocked; these are synthetic holders and a test token on two isolated Anvil instances.

Before witness storage, both inclusion proofs pass the actual Registry's pilot policy and witness simulation, while storage-only eligibility remains false. Production policy rejects the same pilot credential without creating a transaction request. The never-issued control has a valid non-inclusion proof but `eligible: false` and no transaction request. These checker calls do not mine a hub block.

The test deliberately replaces one inclusion response's `transaction.to` and `transaction.data` with an unrelated address and `0xdeadbeef`. The checker returns exactly the canonical witness calldata for the checked holder and the independently configured Registry. An explicitly owned local holder wallet—not the bundle loader or checker—sends the checked request, and its successful receipt targets that Registry. One stored witness is insufficient for the two-party token gate; only after the same holder wallet delivers the recipient's already-approved proof does the gate pass. No source issuer transaction is required; its nonce remains unchanged during this phase. The existing mint-100/transfer-25 and denied-control-transfer balance assertions then run against these stored bundle-derived witnesses.

After the existing actual source revocation and hub relay, epoch 2 excludes the revoked holder. The old bundle is rejected by the checker, and sending the old **previously successful simulated request** with the local wallet produces an actual status-0 receipt. The old witness cannot open the gate. The new bundle gives the removed holder a valid absence proof with no eligibility/transaction, and the retained holder receives a freshly checked request that succeeds onchain. At epoch expiry the checker rejects that new bundle too and the token blocks transfer. Absence alone does not explain why a holder is missing; the test knows the revocation from its separate lifecycle evidence.

This extends the existing gate integration rather than adding another test-suite count. The published bundle is reconstructed in memory in this test; independently hosted mirrors, browser wallet consent, public proof-service/native verification and external customer staging are not exercised. The older local HTTP replica tests remain separate availability evidence, not proof of a hosted SLA. No production roster was exported, published or uploaded.

T-19 remains `IN_PROGRESS`: there is no agreed customer scale/SLO, independently operated hosted replica, approved automatic remote distribution, full browser/external-wallet witness-delivery journey, production HTTP concurrency/privacy controls, public archive replay measurement, actual chain fee economics or deployed service. T-18 authenticated source completeness and per-member re-screening, T-06 issuer isolation and T-38 external-wallet scope remain separate prerequisites. New schemas/bundles do not migrate the historical public deployment.
