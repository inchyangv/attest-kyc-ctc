# API intake limits and remaining cost controls

Working-tree implementation, 2026-09-07. Partial T-22; no gateway configuration, vendor call, live issuance or deployment was performed.

## Actual bytes before parsing

All five POST handlers use `web/lib/request-body.ts`; none calls the incoming request's unbounded `json()` or `formData()` directly. The bounded reader counts received bytes regardless of `Content-Length`, cancels on overflow and returns `413` before wallet verification, vendor lookup, journal access or transaction preparation. Declared oversized length can be rejected without reading. Invalid or mismatched length is `400`. A missing length is supported and is not a bypass.

| Route | Complete body ceiling | Intake deadline | Required media type |
|---|---|---|---|
| `/api/kyc/wallet` | 16,384 bytes | 10 seconds | `application/json` |
| `/api/kyc/bank` | 32,768 bytes | 10 seconds | `application/json` |
| `/api/kyc/issue` | 65,536 bytes | 10 seconds | `application/json` |
| `/api/screen` | 32,768 bytes | 10 seconds | `application/json` |
| `/api/kyc/id` | 6 MiB including multipart overhead | 30 seconds | `multipart/form-data` with a parseable boundary |

The ID image ceiling is 5 MiB. Multipart fields must have unique names, at most 24 fields, names no longer than 100 characters, and text values no longer than 16,384 characters. Those field checks occur after parsing the bounded body. Document image validation is a separate subsequent gate, described below.

Only identity content encoding is supported; compressed request bodies return `415`. JSON must be a valid UTF-8 object, not null, an array or a scalar. Invalid input returns a generic `400` without parser details or submitted identity fields. Unsupported media types return `415`; body deadlines return `408`. Aborted or failed streams return `400`.

The reader uses a fixed byte buffer and rejects more than 65,536 chunks, including empty chunks. It races the entire read operation against one deadline, avoiding accumulated timeout-promise handlers per chunk. Cancellation is requested but its completion is not awaited, so an unresponsive underlying cancel does not hold up the error response.

This bounds the application's intake buffer, **not** total process/fleet memory. Concurrent requests, JSON/multipart parsing overhead, decoded images, vendor work and reverse-proxy buffering remain separate resource controls. Deadlines begin when the handler reads; they do not cover time already spent at an ingress proxy or establish a total vendor/issuance processing deadline.

## Local throttle scope

The per-process counter map now has a hard 10,000-entry ceiling. New keys at capacity receive `429` instead of unbounded allocations or eviction of existing quotas. Each bucket retains its own expiry, preventing a short-window request from clearing a long-window quota. Cleanup runs at most once per second. Client identifiers are hashed to bound stored key size; that is neither authentication nor an anonymity claim.

`/api/onchain` now receives the same local request guard, at 60 calls per minute per observed client. Invalid subject requests also consume that quota before any RPC access. Its RPC requests use a 10-second timeout and one retry; failures return a generic `503`. One accepted call still fans out into several chain reads. This is not a shared RPC expenditure ceiling. The later [T-36 implementation](35-single-block-verdicts.md) separately pins the policy observation to one block and rechecks its hash.

**Forwarding headers are trusted only when an approved ingress strips/rewrites caller-supplied `x-forwarded-for` and `x-real-ip`.** No such deployment change is claimed here. Direct access or an untrusted proxy permits key rotation to evade a per-client quota. The map ceiling also allows an availability attack that exhausts local slots; it is a memory bound, not a complete abuse defense.

The [bank shared-state budget](21-bank-challenge-state.md) remains the cross-instance protection for repeated transfer starts. It is separate from this local map. The issuance path now also has the shared daily gas reservation below; neither control turns forwarding headers into authenticated client identity or provides a fleet-wide RPC budget.

## Shared issuer gas reservation

Every API or `issuance:resume -- --publish` path must configure `ISSUANCE_GAS_BUDGET_KEY`, `ISSUANCE_DAILY_GAS_LIMIT` and `ISSUANCE_DAILY_TRANSACTION_LIMIT`. There are no product-default ceilings. They use the issuance journal's Redis endpoint and namespace but an independent HMAC key. Missing or invalid configuration fails before a transaction can be durably saved or broadcast. The KYC status response reports configuration presence without exposing limits, usage, issuer addresses or secrets.

After the source transaction is populated and signed, but before the signed bytes enter the journal or leave the process, a Redis Lua transition reserves its exact gas limit and one transaction against a UTC-day issuer ledger. The request key is the signed transaction hash, so retrying the same bytes from another app/processor instance is idempotent while an explicit post-revert transaction consumes another slot. Keys and issuer identities are HMACed. Redis `TIME`, not an instance clock, selects the day; all checks happen before either counter mutates.

An unknown broadcast or receipt keeps the reservation indefinitely. A canonical success or revert receipt supplies `gasUsed`; only then does another idempotent Lua transition reduce the current-day gas total from the reserved ceiling to actual usage. Usage greater than the signed gas limit, a changed issuer/hash fact, response loss, malformed state and unavailable Redis fail closed. Repeated API `action=status` reads do not advance issuance, reserve gas or mutate the journal; the route regression performs 50 such normal polls. The existing local route request cap still bounds polling abuse.

This is a gas-unit and transaction-count ceiling for API issuance by one configured issuer, not a fiat budget or a limit on rescreen, epoch publication, relayer, deployment or arbitrary key use outside these two repository entry points. Budget and journal writes are conservative but not one atomic Redis transaction: a budget reply/save failure can strand a reservation without permitting excess spend. Namespace/key rotation, UTC rollover, stale reservations and manual correction therefore require a separately approved pause/reconciliation procedure. A Redis primary, durability, ACL, failover and alert delivery are deployment conditions, not established by local Lua tests.

## Document image admission and decoder lifecycle

`web/lib/id-image.ts` runs after wallet-flow validation and before `requireIdVendor()` for both OCR and verification, including two-way continuation. Unknown nonempty `action` or `docType` now returns `400`; omitted values retain the existing `verify` / `RRC` defaults. `web/lib/id-image-policy.json` is shared with the fixed child entry point and sets:

| Control | Local limit / behavior |
|---|---|
| Encoded image | 5,242,880 bytes; whole multipart remains limited to 6 MiB |
| Declared MIME + detected format | Exact `image/jpeg` or `image/png`, matching the decoded format |
| JPEG container | One baseline/progressive frame; marker/segment framing, no concatenated image, trailing bytes or MPO |
| PNG container | Complete chunks and terminal IEND; no trailing bytes or APNG animation chunks |
| Resolution | At most 12,000,000 pixels and 8,192 pixels on either side |
| Actual decoding | `sharp@0.35.4`, warning-level failure, pixel/channel limits, native safety limits enabled; full 8-bit RGBA decode |
| Admission | Two decoder children per validator instance/process; no waiting queue; excess receives `503` + `Retry-After: 1` |
| Deadline | Parent timer at 3,000 ms kills the child with SIGKILL; native processing also has a 2-second timeout |
| Return channel | At most 1,024 bytes; exact format/width/height schema and dimensions revalidated by parent |

File extensions are not trusted. An empty or unsupported MIME is `415`; empty image is `400`; encoded oversize is `413`; invalid container, corrupted pixels and disallowed dimensions are `422`. Timeout, worker start/import/crash/protocol failure are generic `503`. An already-aborted request or abort during validation is `408`. No vendor is called for rejected images.

`metadata()` alone is insufficient: the regression includes a truncated JPEG whose metadata still reports valid dimensions. The worker additionally decodes the complete pixel stream with `.raw().toBuffer()`. At the pixel ceiling the returned RGBA buffer is 48,000,000 bytes. That is an **output buffer bound, not a native/process RSS bound**. Native parsing, metadata, intermediate buffers, library initialization and the parent multipart buffers also consume memory. `--max-old-space-size=128` constrains V8 old-space, not all native allocations.

The parent retains its admission slot until the child's `close` event, even if an abort/timeout response has already been returned. A rejected promise alone does not free a still-running decoder slot. Children do not inherit application credentials or `NODE_OPTIONS`; their only configured environment values set production mode and one native/libuv thread. macOS may add its own text-encoding variable. Input goes through stdin, output contains only dimensions/format, stderr is discarded, and the worker does not write images to disk or log native parser errors/EXIF. The wall timer includes worker startup and input transfer; like any Node timer it depends on parent event-loop/OS scheduling.

This is killable process isolation, **not an OS sandbox**. The child still runs as the application user, has filesystem/network access allowed by the host, and native-code vulnerabilities are not excluded by these checks. Production needs container/cgroup or equivalent CPU/RSS limits, restricted filesystem/network and a codec patch process. The two-worker limit is not shared across route bundles, serverless instances or hosts. Concurrent intake requests and vendor work remain outside this pool.

Original image bytes are deliberately unchanged: OCR `docHash`, the subsequent ID proof and the two-way token's document binding still refer to the original `keccak256`. A valid replacement image with different bytes cannot reuse that continuation. No sanitization, EXIF/GPS removal, antivirus, OCR quality, authenticity or liveness guarantee follows from successful decoding. Ancillary metadata may still be forwarded to the vendor; stripping/re-encoding would require an explicit evidence-hash/continuation migration and privacy review. HEIC/WebP/SVG/PDF/GIF are not accepted by this route. The file input now advertises JPEG/PNG and the size/resolution limits; camera/device conversion usability still needs a pilot.

## Build packaging and local evidence

`sharp` is now a direct exact dependency at the already-installed version `0.35.4`. The ID route's `outputFileTracingIncludes` explicitly carries the worker, shared policy, sharp and its native/dependent runtime packages. The runtime working directory must be the Next web application root; a missing worker or native binary fails closed, never bypasses validation.

`cd web && npm run build && npm run test:id-image-build` checks the ID `.nft.json`, copies only its traced dependencies into a fresh temporary tree and actually decodes a synthetic PNG there with an empty configured environment. It then copies the remaining Next traces/build files, refuses `.env` or escaping symlink paths, starts built Next on localhost and performs a real synthetic wallet challenge/signature → OCR HTTP flow. It checks the original document hash and a malformed image's `422`. The Next launcher itself comes from the installed Next runtime; this is **not** a standalone-container or Vercel deployment test. Temporary files and the local server are cleaned up. No real bank/ID credentials, production wallet or public transaction are used. The test is wired after the CI web build, but no remote CI run is claimed.

Local evidence on 2026-09-07 (Node 24.15.0, darwin-arm64): the current **57 API/guard tests** include eight image-validation/process tests, four actual ID-route tests and 50 repeated normal issuance-status reads in the route regression; **one separate built HTTP/trace test** passed. Baseline and progressive JPEG/PNG success, original bytes, exact 12-million-pixel / 8,192-side boundaries, MIME/signature mismatch, oversize/corruption/APNG/MPO/concatenation, decoder timeout/capacity recovery/abort/missing file, credential environment stripping and output overflow are covered. Demo verification retains `live=false`; a decoded image does not turn demo provenance into a real institutional check. Web lint/build and root typecheck passed.

The direct-dependency change was inventoried in `artifacts/supply-chain/2026-09-06T18-46-59-537Z/` (ignored, unsigned local evidence). Root/web CycloneDX counts remain 76/462 and complete npm audits returned zero. Web lock SHA-256 is `5336b685ec9df32dcfd42a9703b59e3778cca50b222a710893790c67d78fa36f`. A subsequent `npm ci --ignore-scripts` installed 385 packages successfully; all 36 API tests, web build and traced HTTP test passed again from that install. The separate existing Chromium onchain rendering test also passed; it does not test camera uploads. [T-54 license/maintenance/provenance caveats](36-supply-chain-maintenance.md) still apply, including libvips distribution review and the reported eslint deprecation.

## Remaining release conditions

`cd web && npm run test:api` exercises the production reader and Route Handler functions with streamed synthetic requests, no live credentials and network calls disabled. Coverage includes missing/understated length on every POST handler, exact UTF-8 byte boundaries, cancellation before trailing chunks, malformed/oversized headers, compressed bodies, malformed JSON/multipart, duplicate fields, aborts, stalled cancellation, chunk floods and onchain pre-RPC throttling. A separate counter test fills 10,000 keys and verifies quota preservation and differing expiry windows. Existing bank and issuance route tests continue to pass.

The API suite is function-level Web Request testing; the additional built test covers local HTTP and trace packaging, not deployed ingress, Linux/serverless isolation or a complete browser KYC journey. Before an external pilot, T-22 still requires:

- Approved proxy/header policy and gateway body, connection/concurrency and slow-upload limits; verify chunked HTTP behavior on the actual host.
- Shared flow/user/account/IP admission and RPC budgets across replicas, with explicit failover behavior and alerting.
- Actual-host codec compatibility, restricted native runtime/RSS limits, camera usability and distributed concurrency. [The later vendor HTTP boundary](40-vendor-http-boundaries.md) implements per-exchange deadlines/response limits and removes automatic POST replay; approved whole-flow latency, persistent unknown-transfer reconciliation and distributed cost/amount controls remain.
- Approved gas/transaction ceilings, managed Redis conformance, stuck-reservation reconciliation, operator pause/escalation and budgets for every non-API signer path.
- Load/cost tests and normal-user acceptance criteria. Wallet possession alone does not authorize unbounded paid checks or gas spend.
