# T-15 / T-17 — Actual signed-worker process crash drill

2026-09-07. Local two-EVM integration evidence. This closes a gap between tests that reopened a Store object and a worker process that actually dies. It does not certify production recovery, native proof validity or managed high availability.

## Reproduce

```sh
npm run test:worker-crash
```

The command compiles existing contracts and runs one integration test with two crash scenarios. It launches isolated Anvil chains 11155111 and 102031, deploys the compiled ComplianceSource, linked EvmV1Decoder and ProofmarkASC, and provisions synthetic issuer/relay keys from the public Anvil mnemonic. No production keys, existing state directories, public network writes or external services are used. The source revocation receipt and hub transactions are real local EVM results.

The test launches the unmodified production `worker/index.ts` entry point as a child process. It runs actual preflight, source checkpoint scanning, attestation/proof GETs, proof encoding, signing, durable Store reservation, RPC broadcasting, receipt checks and finalization. A local HTTP service supplies a decoder-format wrapper of the actual source receipt and injects the broadcast fault. **Native inclusion/continuity verification is explicitly mocked** at the local precompile, and attestation/proof service responses are synthetic; this is not a public Attestcoin proof.

## Crash scenarios and assertions

| Scenario | Observed before SIGKILL | Required restart behavior |
| --- | --- | --- |
| Saved signature, broadcast request not forwarded | The worker's exact raw bytes/hash are already in the durable envelope. Hub receipt is absent, relay nonce is zero and ASC tombstone is false. | Broadcast the original stored bytes, confirm the original hash and apply the actual source revocation. No proof is requested again. |
| Broadcast accepted, acknowledgement withheld | The worker's exact stored bytes have a successful local hub receipt, consumed nonce zero and set the ASC tombstone. The worker has not received the broadcast acknowledgement or finalized its Store. | Check the original receipt and finalize the original job without a second broadcast or proof request. |

In both scenarios the test sends SIGKILL to its known worker child and awaits the child's terminal exit event with signal SIGKILL. It verifies the state bytes remain unchanged and both process/signer lease files remain, carrying that child's PID. A fresh worker attempting the same paths exits with `WORKER_LEASE_UNAVAILABLE` and cannot mutate the submitted state.

Only after observing that exact child exit, the **test harness** renames its own two exact temporary lease files to `.crashed-<pid>` evidence files. It does not use file age or `kill(pid, 0)` as proof of exit, and does not install a force-unlock CLI or authorize recovery of any production lease. The envelope remains untouched. A subsequent real worker child acquires new leases, validates source checkpoints and resumes the same job.

Completion requires the original transaction hash in the final job/history, one history entry, no unresolved envelope, ASC `processedQueries` true, actual subject tombstone true and the relay account's final nonce exactly one. All observed broadcast payloads must equal the originally persisted raw bytes. The not-forwarded scenario produces two local broadcast requests but only one forwarded transaction; the accepted scenario produces one request total. Each scenario makes exactly one attestation GET and one proof GET across the original worker and its restart. The recovered child exits zero on SIGTERM, releases its new leases and leaves the renamed crash evidence intact until isolated test cleanup.

The integration uses one-block local hub confirmation for deterministic fault placement. Deeper confirmation, reorg and unknown replacement cases remain separately covered by [relay transport integration](25-relay-recovery.md), not inferred from this test. Its two scenarios count as **one** test and are not included in the root unit/ABI test-report total.

The subsequent [confirmed-query skip regression](64-confirmed-query-skip.md) also starts a separate fresh-state worker after each completed recovery. That new scan requests its own proof and records a block-bound skip without a new broadcast; it is distinct from the original worker/restart pair's one-proof assertion above.

## Remaining operational requirements

This is not a power-loss/fsync durability, disk corruption/state-loss, distributed signer fencing, multi-host takeover, stale-backup restoration, unknown replacement or signed-source-fork repair drill. No business-approved recovery operator/IAM, production service manager, alert routing, staging environment, seven-day load/latency record or public proof-service conformance has been established. The existing production leases remain non-expiring and require verified, authorized recovery; this test does not relax that policy.

The workflow includes this integration in CI after compilation. Local execution proves the fixture paths above; editing the CI file is not evidence of a remote CI run.
