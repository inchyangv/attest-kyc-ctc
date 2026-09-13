# T-40 — strict scene assertions and write-mode boundary

2026-09-07. **IN_PROGRESS; no live deployment or submission PASS was obtained.** The script still contains historical addresses. They do not implement the required v2 interfaces and must fail these checks. No new pins, issuer, transaction or deployment evidence was invented.

## Executable assertions

`docs/demo-video/commands-v2.sh` uses offline parsers (`assert-demo-output.mjs`, `demo-block.mjs`, `demo-issuance.mjs`) for:

- exact CC3 102031 and Sepolia 11155111 chain IDs;
- nonempty runtime bytes and independent expected keccak256 pins for source, ASC, Registry and note;
- source/ASC attribute, epoch and issuer-authorization versions, ASC receipt-processing v2, Registry roster/policy/epoch/auth/witness versions;
- source chain key/address, Registry→ASC and note→Registry/policy bindings, expected source issuer authorization;
- both policies' frozen flags and individual kind, and all eight policy fields against the current `script/deploy.sh` specifications: mask 65572, assurance 2, KR 410, approved issuer, roster required and exists; production regime 1/maxAge 2592000, pilot regime 2/maxAge 604800;
- production rejection/pilot acceptance, control rejection, transfer preflight and successful transfer simulation;
- exact `RecipientNotVerified` ABI data including recipient and policy ID, rather than any occurrence of its selector;
- screening's BLOCK/risk 5 and the expected corroborated OFAC entry, and configured demo ID/bank, non-live labels, source binding and recovery-journal configuration. HTTP errors fail before the JSON assertion;
- for scene 4, the expected transaction/destination, successful receipt, exact source issuance event, subject/issuer/attributes/commitments, log coordinates and approved confirmation depth. Missing issuance expectations fail; the full submission wrapper now includes this scene.

Scalar parsing accepts cast's integer plus scientific display annotation, but rejects arbitrary substring matches, extra lines and wrong booleans. Tuple length and every field are checked. It does not infer source credential truth from JSON or runtime identity from code presence alone. Scene 4 now checks an exact receipt event; its limited lineage claim and remaining cross-chain boundaries are below.

All chain-scene preconditions run for scenes 4/6/7/8 even when scene 6 is not selected. Unknown/empty scene selections and invalid RECORD values fail. Historical display-only mark/balance reads and comments remain and are not assertions about the current holder's full mark or balance. The final message distinguishes read-only scene checks from RECORD=1 write mode.

### Read-only block anchors (2026-09-07)

For `RECORD=0`, strict chain scenes first check both chain IDs, then capture a number/hash from each chain's latest header. Every subsequent `cast call` and `cast code` in that invocation receives the corresponding explicit height, including runtime pins, schema/bindings, policies, mark/tombstone, balances and both successful/reverted transfer simulations. The shared wrapper rejects a missing/unknown/duplicate RPC scope or a scene-supplied block override. Inherited anchor variables are cleared; API-only scenes perform no chain reads.

Before the overall `read-only scene checks complete` message, the script fetches both heights again and compares their hashes with the original anchors. Missing/malformed headers, changed height/hash or either RPC failure prevent overall success. Intermediate PASS lines are not a complete result; callers must require the process to exit zero. `script/demo-block.mjs` bounds input to 2 MB, validates UTF-8 JSON, safe block height and nonzero 32-byte hash, and returns only an anchor or a fixed error.

This is a same-height read and final canonical-hash check, not EIP-1898 hash-addressed state, two-chain atomicity, finalized consensus or trustless RPC authentication. It cannot exclude a dishonest RPC, a transient A→B→A view, or a reorg after the final observation. It adds no head-age guarantee; the separate freshness verifier still applies. Scene 4 separately requires receipt depth relative to the captured source head and an unchanged receipt block, as below. `cast call` also performs a preparatory `eth_getTransactionCount(..., "latest")`; the actual `eth_call` state and `eth_getCode` code reads are the pinned operations. No nonce is reserved or transaction sent in read-only mode.

`RECORD=1` retains the existing write workflow and is **not** covered by the read-only snapshot guarantee. The separate historical `commands.sh` recording kit is unchanged. Nothing here approves recording writes, promotes historical contracts to v2, or makes old runtime/policy pins pass.

### Exact source issuance receipt (2026-09-07)

Scene 4 and the complete `verify:submission` wrapper now require these additional **reviewed public values**, sourced from the original issuance record/release evidence rather than learned from the receipt under test:

```text
SEPOLIA_TX                    original mined transaction hash
DEMO_ISSUANCE_TX_TO            exact outer transaction destination
DEMO_ISSUANCE_SUBJECT          expected credential holder
DEMO_ISSUANCE_ATTRS            exact attrs bytes32
DEMO_ISSUANCE_CLAIMS_ROOT      original claimsRoot bytes32
DEMO_ISSUANCE_EVIDENCE_HASH    original evidenceHash bytes32
DEMO_SOURCE_CONFIRMATIONS     explicitly approved positive confirmation depth
```

`DEMO_EXPECTED_ISSUER` remains the reviewed issuer used by the source-role and consumer-policy checks. No personal openings, raw signed transaction or private key are needed. For a direct issuance the outer destination is ComplianceSource; for the tested `RotatingIssuer.issueOnce` flow it is the stable issuer account, while the event must still originate from ComplianceSource. Do not assume the outer sender/destination equals the event issuer/source, or infer this expected destination from the queried receipt.

`demo-issuance.mjs` checks exact transaction/destination, status 1, nonzero block hash, safe height/index and sufficient inclusive depth (`sourceHead - receiptBlock + 1`). It validates every log's transaction/block coordinates, increasing global log index, non-removed state and basic byte shapes. Known trusted-source lifecycle events must decode and re-encode canonically. Exactly one lifecycle event for the expected subject must exist and it must be `MarkIssued` with the expected issuer, attrs and both commitments. Another target issuance, revocation or denial in the receipt is rejected, even if an expected issuance is also present; other subjects and unrelated valid logs do not masquerade as the target. This strict demonstration check does not attempt to summarize all valid mixed-lifecycle receipts.

The helper returns the receipt block/hash, transaction index and **receipt-local array position**, not the global log index. The script checks that receipt block immediately, and again before final read-only success, as well as checking both original head anchors. In write mode it reads a current source head for the receipt check but makes no final read-only snapshot claim. Missing expectations/depth cannot be bypassed by skipping scene 4 in the full wrapper.

This verifies an RPC receipt against reviewed expectations and observed canonical headers. It does **not** authenticate the receipt against a consensus receipts root/native proof, inspect transaction calldata or request-ID consumption, prove provider checks were truthful, or link the source event to a particular ASC application transaction/current witness/asset balance delta. Historical issuance is not current eligibility; later transactions may revoke or replace it. Independent runtime/account review, the full cross-chain lineage, latest freshness and actual public reproduction remain open.

## Independent pins and migration

The operator must provide these **non-secret reviewed values**:

```text
DEMO_EXPECTED_ISSUER       policy issuer address, never its private key
DEMO_ASC_CODEHASH          keccak256 of reviewed deployed ASC runtime
DEMO_SOURCE_CODEHASH       keccak256 of reviewed deployed source runtime
DEMO_REGISTRY_CODEHASH     keccak256 of reviewed deployed Registry runtime
DEMO_NOTE_CODEHASH         keccak256 of reviewed deployed note runtime
```

These must come from the approved deployment/reproducible-build review, including constructor immutables and decoder/library linkage. This patch does not generate or approve those pins. Copying `cast code` from the RPC being tested into the expectation only proves self-consistency and is not acceptable provenance. Runtime hashes authenticate equality to the selected bytes, not the correctness of the review that selected them.

Update the historical address set, manifests, holder witnesses, policy IDs and submission materials together during an authorized migration. Do not weaken a version, policy or runtime expectation so the old deployment passes. The policies match the current deployment script, not a claim that policy IDs 1/2 on the old network have those fields.

## Read-only versus recording

`scripts/verify-submission.sh` explicitly invokes `commands-v2.sh` with `RECORD=0`, overriding inherited `RECORD=1`. The tested scene branch contains only curl screening/status and cast read/simulation operations. It does not load `.env`. The helper consumes stdin and imports ethers for hashing; it has no network, signer or filesystem API.

Directly invoking `commands-v2.sh` with `RECORD=1` retains its historical two-transfer workflow; this is **write mode** and may spend gas after all preconditions pass. This implementation/testing did not run that mode against a network. An operator must separately authorize recording transactions. The wrapper boundary is not a sandbox against modified scripts, malicious PATH tools or arbitrary shell startup hooks.

### Recording-kit split (2026-09-07)

The separately edited two-minute recording kit now uses `commands.sh` for the historical deployment and `commands-v2.sh` for strict post-migration checks. The submission wrapper and its real-shell regression harness follow the strict path; neither falls back to the recording kit. Scene numbering differs between the two files. Use the wrapper for verification rather than copying old scene examples from script comments. The recording script's `checks complete` output is not a v2 verification result. Its live-state claims, recording transactions, narration and historical deployment were not independently revalidated in this routing change.

The revised narration's production-reject/pilot-accept sentences and shot list's exact policy 1=false/policy 2=true calls are checked statically. Passing those wording checks does not approve broader claims such as “every asset”, “revoked everywhere”, legal compliance or current public availability. Final video/deployment alignment remains an open T-55 gate.

## Verification evidence and remaining gates

`pipeline/demo-verification.test.ts` contains 12 tests. The original eight cover scalar/tuple parsing, exact runtime/revert data, receipt validation, actual shell happy path, wrong deployment/policy/verdict, isolated scene-7 failures, API semantics, and actual wrapper forcing RECORD=0. The wrapper test starts with RECORD=1 and a synthetic key marker; all cast calls remain in read-only mode with no `send`, private-key argument or key marker, including the required receipt scene. It runs the real scene script and helper, while PATH fixtures replace cast/curl and the other downstream verifier programs. These are **shell-routing and assertion tests**, not contract or full-submission verification. No operational key, private identity, public transaction or vendor call is used.

Three added tests cover missing/wrong/reorganized anchors on either chain with no final success, private/bounded block parsing, and the installed real `cast` binary against an owned loopback JSON-RPC fixture. Existing successful shell tests now assert every call/code has its expected source/hub height and both final anchors are checked; fixtures reject unpinned reads. The real-binary test observes `eth_call` at `0x64` and `eth_getCode` at `0xc8`, with only chain-ID/nonce preparatory reads allowed. Its first attempt exposed the preparatory nonce read missing from the fixture; that read was modeled explicitly rather than assumed away. This is actual CLI wire-shape evidence with synthetic RPC replies, not a real EVM, public chain or independent RPC finality test.

The twelfth shell test covers absent/wrong issuance, missing configuration, insufficient depth and a receipt block that changes only at the final check, after the initial exact event/receipt check passed. Three additional tests in `test/demo-issuance.test.ts` encode events from the compiled contract ABI and exercise exact fields, unrelated subjects/receipt-local position, ambiguous target lifecycle, removed/malformed/reordered coordinates, depth boundaries and private bounded errors. These three require `forge build`, like the other root ABI tests.

The existing separate `test/issuance-evm.integration.ts` also executes the installed `cast receipt --json` and the actual parser against two real local Anvil receipts: direct source issuance and the stable issuer account path. Wrong issuer and outer destination are rejected in both cases. Its pre-existing source reorg/revert/retry and issuer-rotation checks remain. This is one expanded integration test, not two new tests; hub materialization is still a fixture. It does not run the whole scene script against a new public deployment or claim native-proof verification.

Open T-40/T-41/T-42/T-55 gates include a clean new deployment and reviewed pins, precise mark/event lineage and actual balance deltas, fresh witnesses throughout the review window, public HTTP/chain execution and independent reproduction. Local read-only state pinning now has the bounded scope above. At the original writing, `check-demo-freshness.ts` had old policy/Direct-mark assumptions and `check-submission.ts` used hard-coded old counts and an obsolete English-only rule; the follow-ups below address those historical failures. `verify-epoch-record.ts` still rejects the old v1 epoch as intended. This partial change must not be described as a working submission release.

The actual local `npm run check:submission` exited 1 with three failed assertions: the old E2E `passesKrProduction`/`passesKrPilot` field strings and the English-only documentation rule. Its old 57/123 count checks still passed because they only search historical prose, illustrating why that check is not test-result evidence. The full Solidity 107/TypeScript 321 regression suite, root typecheck and scene/wrapper shell syntax passed. No full public verifier was run or reported as passing.

Follow-up: [source-bound test evidence](45-source-bound-test-evidence.md) replaces the static test-count checks, distinguishes docs-only lint, updates the driver declaration names and removes the unsupported blanket language restriction. The failed run above is historical diagnostic evidence, not the current static-check outcome. Public/new-deployment and freshness gates remain open.

Further follow-up: [current-witness freshness](46-demo-freshness-operations.md) replaces the old Direct-mark calculation with a same-block holder/control/note observation, current schema/policy/witness checks and the shortest credential/policy/epoch window. The standalone check requires an explicit approved window and issuer, rejects stale RPC blocks and describes only conditional scheduled validity. The scene script now has read-only height/hash anchors; event/balance lineage, actual migration, renewal and public reproduction remain open.

## 2026-09-08 addendum: routing in the submission wrapper

`scripts/verify-submission.sh` now checks the deployed registry generation before choosing a scene
script. A v2 registry runs the strict pinned checks above; the live `v1-live` build runs the
read-only recording kit (`docs/demo-video/commands.sh`, scenes 1 to 6 and 8, `RECORD=0`), the
Direct-mark freshness gate and the roster-format-1 epoch verification. Neither route enters write
mode. The strict v2 assertions are unchanged and still apply after the v2 redeploy.
