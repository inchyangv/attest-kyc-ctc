# Single-block Registry observations and UI diagnostics (T-36, partial)

2026-09-07 KST. Local changes, synthetic RPC/API checks and a local rendered-browser smoke. Not a hosted deployment, a completed issuance journey or a finality guarantee.

## Observation contract

`pipeline/onchain-state.ts` backs `/api/onchain`. It checks the actual RPC chain ID, selects one latest block, and supplies that block number to **every** contract/code read: Registry verdicts and policies, frozen/kind/schema data, ASC marks/tombstones/source binding, epoch root/provenance and the Registry witness/issuer approval. It rejects a configured ASC that is not the Registry's bound ASC, and an unsupported source chain key. It rereads the observation block hash after all dependent reads. A changed/missing block, wrong chain/binding or failed required read yields no successful observation.

The web provider disables its local read cache, so the final hash check reaches the node again. The API sets `Cache-Control: no-store` on success and errors and retains the pre-RPC request quota. The RPC transport has a 10-second request timeout; this is per request, not a complete-route SLA. The browser aborts after 30 seconds, aborts superseded reads, and has an explicit refresh/retry action. Starting a refresh hides the previous policy cards; a failed refresh cannot leave a stale PASS displayed as the new result.

Response observation metadata contains block number/hash/timestamp, chain ID and `finality: latest-observed-not-finalized`. Numeric-block reads plus a hash recheck detect an observed fork but are not a cryptographic snapshot guarantee against a malicious/inconsistent RPC or every possible A→B→A race. The block can reorganize after response. Consumers must evaluate again in the actual asset transaction and use an approved confirmation policy for stronger off-chain claims.

## Verdict versus explanation

`policies[].verified` is always the actual `Registry.isVerified` response at the observation block. Neither a successful source transaction nor local attribute checks overwrite it. The response exposes the observed policy kind/schema and complete policy values; the current demo adapter still queries policy IDs 1 and 2, not arbitrary customer-discovered policy catalogs.

For current compatible schemas, diagnostics inspect the **same credential path as the policy**. Required-roster policies use `getRosterWitness`, not the older ASC Direct mark. Missing witness fields are unknown, not inferred from Direct fields. Diagnostics cover missing/old witnesses, unapproved issuers, stale roster, subject tombstone, unsupported schema/kind, missing methods, assurance, regime/jurisdiction/issuer mismatch and credential time/age. These strings are explicitly **state-based diagnostics, not contract-emitted reason codes**. They need not explain every possible future/hypothetical Registry rejection. If the boolean and diagnostic state disagree, the response says `diagnosis: unexplained` and preserves the original boolean.

Version getters that fail are unknown, never assumed compatible. Roster support now needs bound source/ASC plus roster, epoch, issuer authorization, attrs, policy and atomic receipt versions; selector presence alone is insufficient. A legacy Registry boolean remains visible as `CHAIN TRUE/FALSE` with an unconfirmed warning, not a green current-schema PASS. Unknown-schema explanations are unavailable. The UI distinguishes the Direct mark, the separate witness and epoch cutoff/publication/snapshot data.

The old page applied one historical demo's `ISSUER_ERROR` story and 8m43s propagation time to **any** revoked address. That inference was removed. A subject tombstone shows a restriction, not its source transaction, legal cause or elapsed propagation. An issuer being tombstoned as a subject does not itself prove or disprove key compromise.

## Verification and remaining work

Five root TypeScript tests inspect every block tag, dependent witness/provenance reads and final hash check; inject reorg, wrong chain/ASC binding and required-read failure; distinguish legacy support; and cover negative diagnoses and deliberate verdict disagreement. A compiled ABI test compares both contracts' input selectors and output tuple layouts to this reader.

One actual Next API test uses an isolated synthetic JSON-RPC HTTP server. It checks the wire `eth_call`/`eth_getCode` block tags, no-store headers, successful witness observation, 503 with no verdict after a changed hash, and legacy handling. Its method allowlist contains only `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode` and `eth_call`; no signing/writes occur.

`npm run test:onchain-ui` starts the built Next app on an ephemeral localhost port and runs Chromium with synthetic `/api/onchain` responses. It renders current-witness PASS, missing-witness unknown fields, legacy CHAIN TRUE, contradictory chain/diagnostic state and failed refresh. External browser requests are blocked. This is rendered UI verification, **not** an end-to-end proof that the real API, worker, chains and browser wallet all agree in one transaction. Build `web` first; CI installs Chromium and runs this smoke after the build.

Still unresolved: source/hub transaction lineage and materialization block from an authoritative journal/indexer, dynamic customer policy discovery, `/verify` integration of the full transaction/witness lifecycle, automatic witness delivery and browser pending/revert/refresh/recovery cases against real local contracts (T-24/T-37/T-39). `propagation.sourceTransaction` and `hubTransaction` remain explicitly null with `not-resolved-by-state-read`; no links or timings were fabricated. No public deployment or source/hub transaction was performed. T-36 stays `IN_PROGRESS` until those required lineage and journey conditions are met.
