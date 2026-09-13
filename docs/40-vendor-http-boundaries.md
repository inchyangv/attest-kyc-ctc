# Institution HTTP deadlines and no automatic replay

Working-tree T-22 implementation, 2026-09-07. Transport hardening and synthetic conformance only; no institution, production wallet, public chain or deployed environment was used. T-30's real external integration is not completed by these tests.

## Changes and limits

CODEF and Open Banking previously read unbounded response bodies and automatically refreshed/replayed POSTs on HTTP 401, including one-won transfers. API idempotency alone could not stop this internal replay. Success-shaped envelopes could also be accepted despite a non-2xx HTTP status. Both connectors now use `pipeline/adapters/vendor-http.ts`:

| Boundary | Implemented limit |
|---|---|
| OAuth headers + complete body | 10 seconds; 65,536 decoded bytes |
| Product headers + complete body, including OCR | 30 seconds; 2,097,152 decoded bytes |
| Concurrent exchanges | Four per client transport; no waiting queue |
| Stream chunks | 65,536, including empty chunks |
| Serialized request string | 8 MiB before dispatch; serialization itself happens earlier |
| CODEF upload file | 5 MiB; web intake separately bounds multipart and decodes the image |
| Fetch behavior | Manual redirect refusal, no cache, credentials omitted, AbortController |
| Response acceptance | HTTP 2xx, valid bounded UTF-8, object JSON and expected top-level provider envelope |

Constructor timeout overrides can only shorten the defaults. They are not user fields or web environment knobs. Declared oversize is rejected early; actual bytes are counted even without a length header. Invalid lengths and uncompressed length mismatches fail. Native fetch may decompress a body; its decoded bytes are bounded and compressed Content-Length is not compared against decoded length. URL-encoded CODEF JSON remains supported; malformed JSON/encoding/envelopes fail closed.

No POST is automatically retried on 401, 429, 5xx, network error or timeout. A 401 invalidates only the token used in that request. A later **explicit** request can acquire a new token. OAuth acquisition is single-flight per client, so concurrent requests do not each request a token. Invalidated old tokens cannot clear a newer cached token. Values are limited to 8,192 bearer-token characters and expiry to positive integral seconds within the existing maxima: CODEF 604,800 and Open Banking 7,775,999. Missing expiry retains those prior defaults; these are local compatibility assumptions, not newly verified institutional lifetimes or a key-rotation policy.

## Timeout is uncertainty, not rollback

The timer covers header wait and body consumption. It aborts fetch and requests body cancellation. The caller receives the error without waiting forever for an uncooperative fetch/cancel. Its admission slot nevertheless stays occupied until fetch settles and requested cancellation acknowledges completion. Late success is discarded, never converted to a token or credential. Four permanently uncooperative exchanges therefore exhaust that client until repaired/restarted; timeout does not silently reset admission while old requests continue.

These are application bounds, not an OS memory ceiling or a guarantee that the institution stops processing. TLS, native decompression, parser overhead, concurrent intake and other processes remain separate. The pool is not distributed; shared OAuth still has waiting callers. JSON parsing is synchronous over bounded input and timers depend on event-loop scheduling.

The deadlines are **per exchange**, not per KYC journey. A cold product can take 10 seconds for OAuth plus 30 for the product. Bank start sequentially performs holder lookup and deposit and may require another refresh for a short-lived token. Intake, decoding and Redis add their own time. Browser disconnects are not threaded through every adapter method; fixed outbound deadlines still apply. Whole-flow deadlines and provider-approved captcha/latency limits remain release work.

Transport errors contain a fixed message, internal code and optionally HTTP status, never upstream bodies, URLs or supplied identity. ID/bank APIs return `503`, `Cache-Control: no-store`, `outcome: unconfirmed`, `automaticRetry: false`, without an ID/bank proof or challenge. They do not label the document counterfeit and do not provide a Retry-After instruction to repeat a paid call. The subsequent [public diagnostic boundary](41-public-diagnostic-boundary.md) also removes raw institution business-error messages/references from these APIs. This is T-34/T-23 work; T-33 separately concerns retention/deletion. Successful evidence exports and infrastructure logging still require their own review.

The bank reservation/budget precedes all institutional calls. A timeout leaves it pending; the same start ID returns `START_PENDING` before a second vendor call. The regression delegates the actual CODEF connector to synthetic fetch and proves only one deposit POST. This is **not exactly-once bank execution**: the first request might already have completed. HTTP 401/500 is also not proof of non-execution.

Do not delete pending state, switch namespace/key, change the start ID or initiate another deposit merely to repair the UI. The existing 24-hour idempotency retention and quota-limited explicit new starts are not reconciliation. A durable pre-dispatch bank transaction ID/outbox, authenticated outcome lookup, amount/receipt reconciliation and an authorized restart workflow remain needed. Open Banking still requests exactly one item for one won; no amount change is implied.

PNG uploads now retain `document.png` / `image/png` and original bytes at the CODEF hop rather than being mislabeled JPEG. The connector checks magic only to select wire metadata; full image decoding remains in web intake and original evidence hashes are unchanged.

## Verification and remaining gates

```sh
npx tsx --test pipeline/vendor-http.test.ts pipeline/codef.test.ts pipeline/openbanking.test.ts
npm run test:all
npm run typecheck
cd web
npm run test:api
npm run lint
npm run build
npm run test:id-image-build
```

Verified locally: Solidity **107**, TypeScript **293** (235 worker/pipeline + 49 AML + 9 compiled ABI), API **38**, separate built HTTP/native trace **1**, root typecheck and web lint/build. Ten new transport tests include one actual Node-fetch/localhost-server test for stalled headers/body, gzip expansion and redirect refusal. Other cases cover exact bytes, invalid UTF-8/lengths, chunk floods, retained cancellation slots/recovery, late success, token concurrency/expiry, and both actual bank connectors' no-replay paths. One additional CODEF test checks PNG MIME/bytes. Two API tests exercise unconfirmed ID/deposit responses and pending-request preservation with synthetic fetch. Their loader uses the route's CJS graph so error-class identity matches; no institution-specific runtime is simulated by merely renaming errors.

This is not account-specific provider conformance, authenticated external-issuer credential validation, reuse permission, a live SLA or external-transfer reconciliation. The later [shared API-issuance gas reservation](27-api-resource-limits.md#shared-issuer-gas-reservation) does not meter institution requests or reconcile a one-won result. Release gates include approved latency/cost limits, complete product-specific result schemas, durable unknown-outcome recovery, distributed vendor/RPC admission, amount/retry semantics, alerting and real authorized provider tests. T-22 remains `IN_PROGRESS` and T-30's external integration condition remains unmet.
