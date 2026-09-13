# T-39 — driver API conformance and honest completion boundary

2026-09-07. **IN_PROGRESS.** The driver now reaches the actual local wallet, image/ID and bank APIs with valid fictional inputs. Full issuance → source → hub → current witness → independent consumer gate remains unverified and is not replaced by these API checks.

## Confirmed mismatches and changes

`deploy/verify-demo.mjs` previously labelled 64 random bytes as PNG. That cannot pass the actual native image decoder introduced in T-22. The driver now generates a deterministic 32×24 RGB PNG with proper chunks, compressed pixels and CRCs. This is a patterned pixel fixture, not a photo or government-document replica. The same actual native ID-image path validates it in the HTTP integration test.

The old status preflight only required the deployment-level demo flag and configured vendors. Demo mode can coexist with institutional or testbed connectors. The driver now requires both exact built-in non-live `demo:id` and `demo:bank` adapters, their explicit demo status, bank-state availability, sandbox bits, issuer configuration and issuance journal configuration. Mixed or institutional testbed configuration stops the run before wallet or document requests.

Fictional sample fields replace the old ordinary-person persona; no claim is made that this name is absent from current official lists or that the numeric fields are bank-approved test identifiers. Every ID form and bank start/verify request includes the synthetic marker used by the server-side T-35 routing guard. Every start has an explicit idempotency request ID. Wallet proof remains bound through all of these requests. Built-in demo providers never need two-way authentication; an unexpected two-way response is a failed precondition, not a reason to switch to a live connector.

Required negative checks now stop the run before issuance if they fail. A bank mismatch that unexpectedly succeeds must not be followed by a new issuance request. The bounded response reader and diagnostic boundary described below now apply to every driver HTTP call. This is not a complete memory or infrastructure privacy audit.

## Bounded responses and recording-safe diagnostics

`deploy/demo-driver-http.mjs` applies a 30-second deadline across headers and body, rejects redirects without replaying the request, and caps response accumulation at 256 KiB and 4,096 chunks. It checks declared Content-Length early and independently counts the decompressed bytes exposed by fetch, so a small compressed payload cannot bypass the byte cap. It accepts only a JSON media type and a valid UTF-8 JSON object; HTML, malformed JSON, null, arrays and primitive values fail closed. Rejected or unfinished bodies are aborted. These limits bound the application's response accumulation, not all allocations within the HTTP/decompression runtime or a fleet-wide resource budget.

HTTP and parser failures produce fixed codes without the URL, response bytes, nested cause or original error message. Invalid CLI URLs exit 2 without echoing the input. A final asynchronous failure boundary emits only a fixed diagnostic, not an unhandled stack. Per-stage output no longer interpolates vendor-provided names, masked holders, references, arbitrary status/error fields, methods or raw onchain values. Public transaction/address identifiers are printed only after strict hex validation; the locally generated subject and a validated request ID remain intentionally observable. This is not anonymity: recording logs can still link that subject to a request or transaction.

Wallet challenge/proof types and lengths, exact non-live ID/bank provenance, four-digit demo code, source confirmation field types and commitment encodings are checked before reuse or successful reporting. The API observation helper requires real booleans rather than truthy strings, valid current epoch numbers and unique production/pilot policy IDs. These are API conformance checks, not independent authentication of an issuer, receipt or chain state.

Four additional root tests use actual loopback HTTP to cover exact byte limits, oversized announced/chunked/gzip bodies, invalid encodings/types, header/body stalls, redirects and disconnects without retry. One of those tests runs the actual driver subprocess through eight malicious-response scenarios spanning status, document, bank, issuance and malformed/oversized responses. Synthetic secret/control-character markers must not reach stdout/stderr, and pre-issuance failures must not create an issuance request. The HTTP fields and flow tokens in this diagnostic test are deliberate stubs; the separate actual wallet/ID/bank route test remains the API interoperability evidence.

## Explicit write mode

The command now requires:

```sh
node deploy/verify-demo.mjs https://approved-demo-origin.example --execute-issuance
```

This is an illustrative origin, not a deployed service. Use only an authorized isolated deployment. Without `--execute-issuance`, the driver exits 2 before network access. The URL must be an HTTPS origin or HTTP loopback, without credentials, query, fragment or a path prefix. This protects against accidentally treating the driver as the read-only submission verifier; the flag is not an approval system or a substitute for deployment/runtime review. The issuer server can spend gas and retain records after the issue request, even though the newly generated subject wallet is unfunded.

No public invocation or source transaction was performed for this change. `npm run verify:submission` remains a separate read-only workflow and does not invoke this driver.

## Original-request reconciliation in the running CLI

The driver now requires the pre-issuance request ID returned by the actual wallet-signature API. It records that validated public identifier in its output before calling issue. An older wallet endpoint that omits the ID stops the driver before identity or bank calls. No additional private key, ID proof, bank proof or personal evidence is written to a recovery file.

`deploy/demo-driver-issuance.mjs` sends the identity-bearing `issue` payload exactly once. If that request's transport response is lost or times out, it queries `status` for the pre-known request with the same wallet proof. A confirmed PREPARED response permits `resume` of that ID. Resumable 409/503 replies and ambiguous resume responses go back through read-only status. Every later payload contains only action, original request ID and wallet proof; it never re-sends identity/bank fields, selects a new ID or uses the confirmed-revert `retry` action.

A different/malformed returned request ID or missing ID on a successful HTTP response fails closed. A missing request (404), authentication failure, business refusal, confirmed failure, non-resumable server response or malformed JSON stops rather than creating a replacement. In particular, this change does not automatically renew expired wallet proofs or authorize a confirmed-revert retry.

The source reconciliation phase has one monotonic five-minute budget covering requests, response bodies and polling, plus a 64-request cap. Each HTTP request retains the 256 KiB/4,096-chunk limit and receives the smaller of 30 seconds and the remaining reconciliation budget. Polling waits five seconds in the actual CLI. Deadline exhaustion is unconfirmed, not proof that no issuance occurred. The later API roster-verdict wait remains a separate interval and still does not prove an independent consumer gate.

Four added root tests exercise the actual helper with loopback HTTP: initial response loss plus resumable 503, resume response loss followed by status-confirmed success, conflicting/missing IDs and terminal failures, and header/body/busy deadlines. A ninth malicious-response subprocess scenario runs the actual CLI, destroys its first issuance HTTP connection, checks that the next request is status with no identity fields, and verifies private diagnostic markers remain absent. These server responses are fixtures, not a journal or EVM execution. The actual storage/EVM response-loss integration in [the recovery runbook](22-issuance-recovery.md) remains separate.

Recovery here lasts only while the driver process and its throwaway key remain alive. Printing a request ID does not let a later process authenticate as that discarded wallet. Cross-process key custody/recovery, a CLI resume command, fresh-proof acquisition and a fully pinned CLI-to-public-chain run remain unfinished. Exit 2 at the incomplete full-E2E boundary is unchanged.

## Materialization is not roster readiness

The old loop stopped as soon as a Direct mark became Active, then immediately tested policy 2. Current policies require a current approved witness, which may arrive later or require an operator to publish the next epoch and materialize the witness. The new observation helper distinguishes missing Direct materialization, missing/stale/unapproved witness, incompatible schemas, tombstones, differing credential material and policy rejection.

It compares subject, issuer, assurance, regime, methods, claims/evidence commitments and expiry with the issued result and locates policies by ID rather than array order. It requires current witness epoch/approval, fresh roster, frozen roster policies and consistency between Registry booleans and diagnostics. Different mark/witness material, incompatible state or a restriction stops the run. Merely Active or awaiting a current witness does not prematurely end polling. No refresh/publish/cache transaction is automatically sent.

These are checks of the deployment's **API response**, not independently authenticated RPC state. The measured interval is now described as an API roster-verdict wait, including polling and epoch/witness delays. It is not a pure relay latency, a finality measure or evidence that the wait was “not a fault.”

Even if all currently implemented API steps pass, the driver returns **exit 2** with an explicit incomplete-E2E warning, not exit 0. Source/hub receipt lineage, independent reviewed runtime/source/issuer/policy pins, direct same-block RPC verification and actual consumer-gate execution are not implemented in this driver. An automation must not treat its API PASS lines as full T-39 completion. Exit 1 indicates a failed step; exit 2 means missing execution acknowledgement or the documented incomplete full-gate boundary.

## Verification

Four root tests cover the actual PNG structure/decompression, strict demo preflight, exact credential/current-witness observation states and refusal to execute without acknowledgement. These observation fixtures are synthetic and not network evidence.

`web/tests/demo-driver.test.mts` starts a loopback HTTP server and runs the **actual Node driver** as a subprocess. Wallet challenge/signature checking, opaque flow tokens, ID image decoding, demo ID/bank methods and both denial responses use the actual application route implementations. Before an explicit 503 issuance stub, the test decrypts and checks the ID/bank proofs against the wallet flow and their non-live provenance. No issuance journal, real screening, source/hub transaction or gate is executed in this test. Additional runs verify mixed-vendor preflight stops before wallet access and an intentionally broken negative response prevents any issuance request.

Still required for T-39: isolate and execute the real issuance journal/transport and AML snapshot path, reproduce source/hub materialization and witness readiness, authenticate deployment and receipt lineage independently, exercise the consumer gate, and test recovery/fresh wallet proof during long delays. Current public legacy contracts and the failed full official-list refresh are not valid shortcuts. Successful local API conformance does not approve live spend or prove a complete release.

Follow-up: a separate [two-chain local contract integration](50-local-cross-chain-gate.md) now executes the real EVM transport, source receipts, ASC materialization, approved roster witnesses and token success/rejection transactions. Its native proof verifier, identity inputs and AML dataset are explicit fixtures; it does not connect this HTTP driver to a real issuance journal or the proof service. Full T-39 completion and this driver's exit status are unchanged.

Further follow-up: [connected local API/storage/consumer integration](51-local-api-issuance-integration.md) now executes actual HTTP wallet/ID/bank/issue routes, Redis journal, encrypted vault, source transactions, fresh-wallet-proof resume, hub witnesses and wallet-signed consumer transfers in one test. Its HTTP client is a test harness, not this CLI or a browser. Official AML inputs and native proofs are still substituted, and the managed Redis REST service/worker are not exercised. This closes the local business-stack connection gap without establishing independent public-chain E2E or changing the driver's exit status.
