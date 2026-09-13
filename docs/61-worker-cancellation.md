# T-15 / T-17 — Cooperative worker shutdown

2026-09-07. Local implementation and regressions, not a production shutdown SLA or a signed-job crash drill.

## Corrected behavior

The worker's stop signal now interrupts the main polling sleep, retry backoff, below-height attestation polling, exhausted-retry polling and active attestation/proof HTTP exchanges. Aborted operations throw fixed `WORKER_STOPPED`; arbitrary abort reasons are not reflected. Retry checks cancellation both before work and after a result, so a late result is not accepted as successful work. Cancellation is rethrown before warning/retry scheduling and does not consume another attempt.

The old attestation request used a timeout-only controller and its sleeps did not receive the worker signal. The pinned SDK 0.18.0 `ProofBuilder.getProof` has no cancellation argument. The worker now makes the same `GET /api/v1/proof-by-tx/{chainKey}/{transactionHash}` request and consumes the raw response JSON directly, matching the installed SDK's mapping. It does not expect the SDK's in-process `{success,data}` wrapper on the wire. A local actual SDK/worker parity test checks that mapping. The SDK dependency remains for other repository consumers; there is no dependency or public provider upgrade.

The shared native-fetch transport connects the external stop signal to the actual request/body stream. It does not merely race a timeout and leave an unobserved request running. It rejects redirects and uses no-store/omit-credentials. Existing per-attempt deadlines remain 15 seconds for attested height and 10 seconds for proof. The full decoded body is bounded at 64 KiB for height and 8 MiB for proof, with 65,536 chunks and strict UTF-8/JSON parsing. Height must be a nonnegative safe integer. Errors are fixed codes for HTTP status, network, timeout, resource limit or invalid response; remote bodies/URLs are not interpolated by this transport.

These byte/deadline ceilings are local resource protections, **not** measured maximum production proof size, proof authenticity or a customer-approved service limit. A larger legitimate proof will be rejected and needs an explicit resource/compatibility review. Full proof validity remains the contract/native verifier's job; this change does not certify arbitrary structurally valid JSON as a proof. The configured proof builder and actual deployed wire format still need public/staging conformance evidence.

## Durable work and boundaries

The worker already refuses new pool reservations on stop and drains existing reservations. Cancellation inside unsigned preparation leaves the durable job pending without increasing attempts, attaching an error or making it dead. The next approved restart may resume its original job. The main idle poll catches its own shutdown cancellation, allowing an orderly exit rather than reporting a start failure.

The relay sender, signed envelope, source guards and nonce gate are unchanged. A stop detected by a source guard before broadcast or before receipt finalization must retain any already-persisted envelope and submitted job. It must not declare success, free the nonce, replace signed bytes or sign the next job. Restart reconciles that original envelope. An already-running RPC/broadcast may still settle during shutdown; cancellation is not transaction revocation.

This is **not** a global shutdown deadline: source/hub/preflight/relay RPC requests still use their existing bounded per-request timeout, synchronous work cannot be preempted, and a sequence of dependency operations can take longer than a single request budget. Abnormal process termination still leaves leases for verified recovery. No force-unlock, replacement transaction, state deletion, supervisor timeout or production service policy has been installed.

## Verification

Six new root tests cover abortable long sleeps/backoff, no pre-aborted invocation or late success, real local HTTP connection closure during stalled headers and bodies, timeout/status/redirect/decoded gzip byte/UTF-8/JSON rejection, actual pinned-SDK GET parity, active proof cancellation, active/below-height attestation cancellation and persisted relay stop/resume boundaries. The relay stop test uses the actual file Store/sender with a synthetic transport and verifies one original signature, no alternate-job nonce and preserved pending state before resuming.

The existing actual worker subprocess test was extended with a synthetic finalized `MarkRevoked` source log. Its attestation service sends headers and an unfinished JSON body. SIGTERM exits zero within the test's two-second ceiling, clears both leases and closes the health listener; the discovered job is byte-for-byte logically unchanged, attempts remain zero, no relay is allocated and only one attestation request was made. This two-second assertion applies to that local synthetic workload, not arbitrary production RPC/signing work. The test count is unchanged for the extended subprocess case.

The subsequent [actual signed-worker crash drill](62-worker-crash-recovery.md) adds local SIGKILL/restart coverage before forwarding and after accepted broadcast. Public native proof compatibility, high-load graceful drain, production signed-work recovery, supervisor identity/timeouts, operational paging and seven-day staging measurements remain open.
