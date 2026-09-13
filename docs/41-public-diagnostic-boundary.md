# Public diagnostics versus retained evidence

Working-tree implementation, 2026-09-07. Partial T-34/T-23, not completion of T-33 retention/deletion or T-32 legal review. No external system, credential or production data was changed.

## What the browser no longer receives

ID and bank error handlers previously returned `VendorError.message`, `.code` and `.ref` directly. CODEF builds some of those errors from upstream `message`/`extraMessage`; Open Banking uses its response message and transaction reference. Those fields are untrusted diagnostic text, not proof that they contain no resident number, account, name, certificate detail or unrelated third-party identity. Masking a holder's first/last character in a mismatch error also disclosed more about a different account holder than the flow needed.

`web/lib/public-errors.ts` now projects errors into a small public schema:

| Situation | Public result |
|---|---|
| Recognized local input problem | Fixed guidance by exact local error code; no source message/reference |
| Institution business error | Generic guidance; only `CF-` + five digits, one uppercase letter + four digits, or three numeric digits are retained as provider code |
| Unknown/arbitrary code | `VENDOR_FAILURE`; arbitrary code text is not reflected |
| Unavailable vendor/OCR/RSA configuration | Fixed `VENDOR_UNAVAILABLE`, HTTP 503 |
| Transport failure | Fixed `unconfirmed` / `automaticRetry: false`, HTTP 503, finite transport-code allowlist |
| Service configuration failure | Fixed `CONFIGURATION_UNAVAILABLE`, HTTP 503; only catalogued variable **names**, never values/message/stack |
| Account holder mismatch | Fixed mismatch message; neither holder name nor provider reference |
| Screening or KYC status failure | Fixed service-unavailable JSON; no native filesystem path/parser message |

No vendor `message`, `ref`, `cause` or `stack` is serialized on these failure paths. Even a recognized code does not permit the message to pass through. A code's syntax is not independent authentication or a legal meaning. The formatter leaves the original Error untouched; it does not rewrite a stored evidence object or hash. Original failed-request diagnostics are **not newly persisted** by this change, and no invented support ID suggests that an operator can retrieve them from an audit service that does not exist.

Two-way ID continuation accepts only the already-supported `secureNo` and `simpleAuth` methods. It supplies fixed captcha/app instructions instead of the upstream free-text message. Unknown methods fail unconfirmed with no continuation token. Existing captcha bytes and the encrypted, wallet-bound continuation remain available for the required interaction. Successful OCR fields, successful reference summaries and the authenticated issuance evidence/claim download are intentionally not removed by an error-formatting change.

The configuration builder no longer includes invalid environment values or raw constructor exceptions in status messages. Unknown `OPENBANKING_ENV` now fails configuration instead of silently selecting the test rail. This is a fail-closed configuration change; valid test/prod behavior is unchanged.

## Response caching

`web/lib/private-response.ts` sets `Cache-Control: no-store`, `Pragma: no-cache` and `X-Content-Type-Options: nosniff` for all JSON results from wallet, ID, bank, issuance, KYC status and screening routes, including success, invalid input and error. Explicit caller cache headers cannot override no-store. Shared request-guard errors also return no-store while retaining a legitimate rate-limit Retry-After. This does not alter the onchain route's existing no-store behavior.

These headers are not data deletion and do not control browser developer tools, malicious clients, already-downloaded claims, screenshots, server memory, tracing agents, reverse-proxy logs or vendor retention. Platform/framework logging outside the caught application paths was not audited. First-party token/journal/state diagnostic codes still have their own implementations and are not presented as a universal arbitrary-error sanitizer.

## Tests and integrity boundary

The API suite adds six diagnostic/response tests, two ID tests and one bank test. Synthetic values representing an RRN, name, account/certificate secret and private path are inserted into error messages, refs, causes and codes. Tests cover Unicode values, arbitrary/prototype-named codes, mutated transport messages, variable-name filtering and unchanged source Errors. Actual ID/bank routes return sanitized errors; both supported continuation methods still work and arbitrary method strings fail. A real missing-index filesystem error is first confirmed to contain the private temporary path, then the actual screening/status routes are checked for generic JSON and no raw application console output. Fresh, isolated processes verify invalid configuration values are not reflected and do not select a test bank.

Commands: `cd web && npm run test:api && npm run lint && npm run build && npm run test:id-image-build`; root `npm run typecheck` and `git diff --check`. API count is **47** (previous 38 + 9). No new chain transaction or vendor request is required. All tests are synthetic; they do not prove platform-wide absence of PII.

T-34 still requires real institution-authorized receipts and trust pins, customer-approved auditor authority, an approved independent chain reader and an infrastructure PII review. The local format and verifier below enforce those inputs rather than inventing them. An evidence hash does not establish truth of the original KYC result. T-33's legal hold, retention clock, deletion approval, backups, cross-store deletion and credential-state consequences are unchanged and remain open. T-23's managed keys, rotations and production access/logging controls also remain unfinished.

## Authorized audit export and independent reconstruction

The local T-34 audit path is implemented in `pipeline/audit-evidence.ts` and the read-only verifier is exposed as:

```text
npm run verify:audit-export -- <export.json> <public-trust-pins.json> <independent-onchain-observation.json>
```

An export can be prepared only for an issued retained record with a current customer-signed `proofmark-audit-grant-v1`. The grant fixes the customer, auditor, record, purpose, authorization reference, validity window and the exact minimum claim keys that may be opened. It is checked against a configured authorizer address; an address carried by the export is never trusted. Claim values outside that exact grant are not copied. Each selected claim carries its Merkle proof, while the full `screeningSubject` and undisclosed openings remain in the encrypted vault.

For every document-authenticity or bank-account bit in attrs, the export requires one `proofmark-institution-receipt-v1`. The normalized receipt binds provider, product, environment, opaque provider reference, result, request ID and the digest of the exact PII-free adapter axis. Its EIP-191 signature is checked against a separately configured provider/product/environment/key pin. A recomputable evidence chain containing arbitrary `ref` strings is rejected. This verifier establishes signature and linkage only: it does not turn a vendor statement into a legal conclusion or prove that a configured signer is institution-authorized. Current CODEF/KFTC responses do not supply this repository with such an authenticated receipt, so real production exports remain blocked pending provider conformance and trust-pin approval.

The export links request ID, deterministic audit credential ID, source transaction/block, subject, issuer, attrs, claims root and evidence hash. It records evidence-chain, claim, attrs, AML engine/list/HMAC-key, processing/identity/retention policy versions. The web wallet token now carries a SHA-256 domain-separated digest of the exact combined processing and retention notice text whose wallet signature was verified; issuance copies that digest into the processing-policy evidence step. Existing records without this field cannot be upgraded by assertion and are refused by the audit exporter.

`verifyAuditExport` checks the customer grant, receipt signatures, exporter signature, selective-disclosure proofs, evidence-chain head, commitment/issue steps, policy/version linkage and exact onchain tuple. The verifier also requires a second onchain observation supplied outside the signed export, so replaying the export's own assertion is insufficient. The CLI emits only a bounded verification event with the export fingerprint and receipt/disclosure counts; it does not print wallet, claims, evidence, provider references or signatures. The independent party remains responsible for obtaining the observation from an approved read-only source-chain endpoint and establishing its canonicality/finality.

The export declares that original institution response bodies are not retained by this path. It also declares that an HMAC-key holder can test identity candidates and that the customer-controlled authorization governs transfer. Export signing detects alteration after export; it does not prove the original KYC result was true, make pseudonymous material anonymous, authorize the auditor, establish a provider key's legal authority, or audit reverse-proxy/APM/platform logs. Those require the actual customer/vendor/auditor/security controls and observations.

T-23's later local role, token-rotation, minimum-worker-environment and host/header controls are recorded separately in [runtime key separation and bounded rotation](85-runtime-key-boundary.md). That work preserves this document's limitation: application projection tests do not prove that infrastructure logs are free of personal or secret data.
