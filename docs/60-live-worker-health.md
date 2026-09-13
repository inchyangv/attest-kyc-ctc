# T-17 — Live worker self-report

2026-09-07. **IN_PROGRESS.** Optional loopback HTTP visibility into the running worker, separate from the [read-only state-file monitor](59-local-worker-monitor.md). Not a deployment, paging integration, independent process attestation or seven-day SLA result.

## Enable explicitly

Set both `WORKER_HEALTH_PORT` (positive integer, at most 65535) and `WORKER_HEALTH_MAX_SCAN_AGE_MS` (positive safe integer milliseconds), then start the worker through its approved deployment workflow. Leaving both blank disables the listener; supplying only one or an invalid value fails configuration. There is no guessed production scan-age threshold. Choose it with the actual polling interval, RPC budget and scan duration in mind. A threshold below normal polling can cause periodic stale reports.

The listener binds only `127.0.0.1`, after both existing worker/signer leases are acquired and state is reloaded. It starts before preflight, so an in-progress preflight can report STARTING. An occupied health port fails startup and releases the acquired leases instead of silently starting without the requested visibility. This change does not install a service, open a public interface or modify firewall/proxy configuration.

Read `http://127.0.0.1:<configured-port>/health` using a bounded local HTTP client. Only exact `GET /health` with the matching `127.0.0.1:<port>` Host is accepted. Origin-bearing requests, query strings, alternate hostnames, other methods and request-body declarations are rejected; no CORS is enabled. Header size is 4 KiB, connections are capped at 16, request/socket timeouts are configured at five seconds, responses are no-store and connections close. These are local diagnostic bounds, not a demonstrated hostile-load ingress guarantee. Do not publicly proxy this unauthenticated endpoint; local users/processes can query it, and a different process could impersonate a listener after shutdown. Deployment identity still belongs to the supervisor and its security boundary.

## Meaning of a response

| HTTP / status | Evidence and limitation |
| --- | --- |
| 503 `STARTING` | This worker can answer HTTP but preflight has not completed. |
| 503 `SOURCE_SCAN_NOT_OBSERVED` | Preflight completed, but this process has not completed a scan step with an initialized verified source anchor. A file left by an earlier process is not sufficient. |
| 200 `LOCAL_SCAN_RECENT` | This process completed a source scan step within the selected age threshold and has not reported a subsequent scan error. A caught-up no-new-block scan also counts. This does **not** prove caught-up chains, attestation availability, successful hub delivery, enough gas or an empty backlog. |
| 503 `SOURCE_SCAN_STALE` | The last completed scan is at least the threshold age. The event loop may still answer while a chain request is stalled. |
| 503 `SOURCE_SCAN_ERROR` | The last scan attempt threw. A later successful anchored scan clears this status; a cumulative error count remains. Raw exceptions are not returned. |
| 503 `STOPPING` | Shutdown/fatal-stop was requested; this phase cannot be reset by a late successful scan. The listener stays available during draining, then closes. |
| No response / timeout | The caller has not established responsiveness. Distinguish stopped/unstarted/frozen process, wrong port and local networking with the supervisor. Do not treat any stored state or lease as a substitute response. |

Responses include process-local monotonic uptime, age since the last completed scan, cumulative completed scan/error counts and current in-flight pool size. They contain no PID, keys, addresses, transaction/query IDs, proof data, state path or raw diagnostics. `eventLoop: RESPONDING` describes the current HTTP response, not continuous availability. `chainLag`, `hubDelivery` and `externalAvailability` are always `NOT_CHECKED`. No timestamp is periodically written to disk. Counter/age state resets on restart, and an unchanged source head can still be scanned successfully; head freshness and lag require separate observations.

The endpoint does not perform RPC calls, touch jobs, retry dead letters, steal leases or change signer ownership. Use it alongside backlog diagnostics, not instead of them. A process can respond while its relay job is stuck; a timer-only heartbeat would not establish progress either. Never automatically clear a lease or allocate a new signer nonce based on a failed health read.

## Independent bounded read-only probe

The separate CLI makes one real HTTP request to the literal loopback IP, with no state-file fallback:

```sh
# Example local thresholds, not an approved operational SLA. Match the listener's scan policy.
WORKER_HEALTH_PORT=9001 WORKER_HEALTH_MAX_SCAN_AGE_MS=15000 MONITOR_WORKER_TIMEOUT_MS=1000 npm run probe:worker
```

All three settings are required; the timeout must be a positive integer no greater than 60,000 ms. The CLI does not load `.env` or import worker signing configuration. It accepts no URL, hostname, path or command-line arguments. It sends only `GET http://127.0.0.1:<port>/health`, without redirects, proxy configuration, credentials, retries or write actions. This is an external observer of the worker process, but not an installed independent monitoring service.

One monotonic deadline covers connecting, headers and the complete body. The probe bounds headers/body to 4 KiB each, requires strict UTF-8 JSON, exact version/field set, no-store JSON headers, matching HTTP/status/phase, valid counters/ages and the independently configured scan-age policy. Unexpected fields, private diagnostics, missing/malformed responses, redirects, compressed bodies and policy mismatches fail closed. Output contains validated scalar self-report fields only; invalid bodies and transport exceptions are replaced by fixed codes. Port refusal and transport errors do not prove which process failed.

The response's scan age alone is insufficient: the probe conservatively adds the entire request duration before accepting a recent scan. If that bound reaches the chosen maximum, it returns `ATTENTION_REQUIRED / SCAN_AGE_BOUND_EXCEEDED`, even if the worker generated HTTP 200. This may warn conservatively near the boundary; it is not a measurement of chain lag or a synchronized timestamp. The probe snapshots its settings at invocation, so caller mutation cannot loosen an in-flight check.

| Exit | Probe outcome | Meaning |
| --- | --- | --- |
| 0 | `LOCAL_SCAN_RECENT` | A timely, internally consistent local response satisfies the configured scan-age bound. Not proof of process identity, current chains, hub delivery or overall health |
| 1 | `ATTENTION_REQUIRED` | Valid startup/stale/error/stopping response, or the conservative transit-age bound was exceeded |
| 2 | `UNAVAILABLE` / fixed CLI error | Deadline, connection, schema/policy/HTTP/header failure or invalid settings; no healthy fallback |

Every report states `processIdentity: NOT_VERIFIED`, `chainState: NOT_CHECKED`, and `alertDelivery: NOT_CHECKED`. A different local listener could imitate valid JSON. Bind the actual deployment identity through the approved supervisor/security model; do not expose or proxy this unauthenticated endpoint publicly. If the probe itself never runs, this one-shot tool cannot report that fact. Missed-run detection, a durable scheduler, alert deduplication/escalation/acknowledgement and a recipient remain separate operational gates. No service, schedule, receiver or automatic recovery was installed.

## Verification

Five root tests cover explicit settings, monotonic/inclusive scan-age boundaries, startup/error/recovery/stopping, actual HTTP status and private fixed errors, authority/origin/method/path/body rejection, and occupied-port failure.

Seven additional root tests in `worker/health-probe.test.ts` cover explicit probe settings, strict self-report consistency, the actual listener lifecycle/closed port, redirects/oversized/invalid UTF-8/private/HTTP-header failures with exactly one request, silent headers/unfinished bodies under the same deadline, conservative response age plus immutable settings, and actual CLI exit 0/1/2 without signing keys. The existing real-worker subprocess test also runs the probe: recent scans pass, SIGSTOP produces `DEADLINE_EXCEEDED` while the state bytes remain unchanged, and a stalled source RPC produces `SOURCE_SCAN_STALE`. These are local fault tests, not a delivered page or an uptime SLA.

One of those tests launches the **actual worker entry point in a separate process** with local synthetic JSON-RPC source/hub endpoints. It verifies preflight/anchored scans produce live 200; SIGSTOP makes a bounded HTTP request time out while the state bytes remain unchanged; SIGCONT restores responsiveness; an actually outstanding source RPC request produces a responsive but stale 503; RPC error produces a private error-state 503; recovery returns to 200. The subsequent [shutdown regression](61-worker-cancellation.md) introduces one synthetic source job and stalls its attestation response body before SIGTERM; the worker exits zero, preserves the unsigned job, closes the port and removes both leases. The test uses a public synthetic mnemonic only, emits no signed transaction and rejects unexpected RPC methods. It is not a real chain/finality/proof-service or signed-job shutdown drill.

## Composite chain/state observation

`npm run monitor:worker:service` closes the specific gap where a responsive, recently scanning worker looked green while its stored source cursor was far behind the configured source RPC head. It runs the bounded loopback probe, strict read-only worker-state monitor and fixed JSON-RPC observations concurrently under one explicit deadline. It calls only `eth_chainId`, `eth_getBlockByNumber("latest", false)`, hub `eth_getTransactionCount` at `latest` and `pending`, `eth_getBalance` and `eth_gasPrice`. It never imports dotenv or worker configuration, reads a private key, signs, sends a transaction, changes Store/lease state, retries a job or sends an alert.

In addition to all settings required by `probe:worker` and `monitor:worker`, configure:

```text
MONITOR_WORKER_SERVICE_TIMEOUT_MS
MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG
MONITOR_WORKER_SOURCE_MAX_HEAD_AGE_SECONDS
MONITOR_WORKER_HUB_MAX_HEAD_AGE_SECONDS
MONITOR_WORKER_HUB_MIN_BALANCE_WEI
MONITOR_WORKER_HUB_MAX_GAS_PRICE_WEI
MONITOR_WORKER_HUB_MAX_NONCE_BACKLOG
```

Every value is explicit; there is no production default. Thresholds are inclusive except balance, which warns below the minimum. RPC URLs must be HTTP(S) without URL credentials, query or fragment. Responses have a single absolute deadline plus 4 KiB headers/16 KiB bodies and strict JSON-RPC IDs/fields/quantities; output filters URLs and addresses. Source lag is `configured source head - validated persisted cursor`; source/hub head age uses the configured RPC block timestamp and local wall clock. Hub telemetry includes latest/pending nonce backlog, balance and gas price. Chain-ID mismatch, a future head timestamp, cursor ahead of sampled head, pending nonce below latest, invalid state/response or failed health probe is unavailable (exit 2), never quiet. Threshold findings or state/self-report attention exit 1; all observations within thresholds exit 0.

`SERVICE_OBSERVATIONS_OK` remains deliberately narrow. `processIdentity` is `NOT_VERIFIED`; the output says its chain values came from configured RPCs and were not independently verified; `alertDelivery` is `NOT_CHECKED`. A single compromised or stale RPC can give internally valid false data, latest block timestamp is not finality, gas price is only the sampled RPC estimate, balance does not prove fee sufficiency, and nonce backlog does not prove transaction ownership. The local JSON Store is not a durable shared queue or distributed fencing service.

Six composite regressions include `PM-T17-01`: cursor 10 plus a valid recent self-report plus source head 110 must report `SOURCE_CURSOR_LAG`. The pre-change probe made zero source RPC calls and the counterexample failed. Current tests cover exact inclusive lag/head-age/gas/nonce thresholds, low balance, all fixed RPC calls, quiet-but-limited claims, malformed/private response suppression, strict settings and actual CLI exit 0/1/2 without loading an injected worker private key.

## Local run records and missed-run audit

The observation command stays read-only. To create local staging input explicitly, an approved scheduler may call `npm run record:worker:service`; this runs the same observation and atomically writes an immutable-name, mode-0600, fsynced, digest-bound redacted envelope beneath `MONITOR_WORKER_EVIDENCE_DIR`. It does not mutate worker state. `npm run audit:worker:service` only reads those bounded regular files and checks the exact deployment digest, a configured maximum run gap, latest run age, a staging window of at least 604,800 seconds and an explicit minimum retained job count.

The audit reports never-run, latest missed run, historical gaps, incomplete seven-day window, attention/unavailable samples and target-load absence. It publishes sample counts plus separate probe-run latency p50/p95/p99 for ok/attention/unavailable observations, and carries the latest retained-state completed/skipped/failed latency, pending/overdue age and attempt metrics. Configure:

```text
MONITOR_WORKER_EVIDENCE_DIR
MONITOR_WORKER_RUN_INTERVAL_SECONDS
MONITOR_WORKER_MISSED_AFTER_SECONDS
MONITOR_WORKER_STAGING_SECONDS=604800
MONITOR_WORKER_STAGING_MIN_JOBS
```

The missed threshold must exceed the intended interval. Five regressions cover atomic/digest/scope binding, a synthetic seven-day record set and status/latency counts, never/missed/gap/window/load findings, refusal to shrink the configured staging duration below seven days, and actual audit CLI exit 0/1/2 without making an RPC request. Those time-shifted fixtures validate the auditor; they are not seven elapsed days of staging evidence. There is still no installed scheduler, independent storage, authenticated receiver, deduplication/escalation/acknowledgement, approved target-load definition or actual alert delivery.

## Still open

Production deployment and supervisor identity, installed independent polling, durable alert deduplication/escalation/acknowledgement and actual receipt by a named operator, independently trusted source/hub observations, managed shared queue/distributed fencing, an approved operational signed-work recovery drill and seven elapsed days at an approved target load remain T-17. The bounded composite probe and local run-gap/staging auditor are implemented, but no receiver, daemon or schedule has been installed and the synthetic time-shifted history test is not operational evidence. The older file monitor intentionally continues to report `processLiveness: NOT_CHECKED`; reading a file is still not this live probe.
