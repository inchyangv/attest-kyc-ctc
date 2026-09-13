# Observed cross-chain propagation

> Testnet observations only. The samples use different clocks and start points, so this document
> does not calculate p50/p95 and does not state an SLA. It exists to keep every latency claim tied
> to its measurement method.

## Comparable mark lifecycle observations

| Date | Event | Worker detection | Attestation complete | CC3 application | End-to-end result |
|---|---|---:|---:|---|---:|
| 2026-08-30 | Synthetic mark issuance | 1m 26s after source issuance | 6m 30s after issuance, 39 blocks | `execute()` 386,008 gas | `isVerified` true after 7m 55s |
| 2026-08-31 | Pipeline-produced mark issuance | 1m 50s after source issuance | 8m 50s after issuance, 33 blocks | `execute()` 388,696 gas | `isVerified` true after 10m 48s |
| 2026-08-30 | Synthetic mark revocation | not separately recorded | not separately recorded | revocation applied on CC3 | 8m 43s source revocation-to-application clock |

The first mark was intentionally revoked because its method bitmap was hand-authored. It proves the
transport and worker path, not KYC. The second mark was produced by the pipeline and honestly left
unperformed methods unset.

Source: [`docs/06-worker-design.md`](06-worker-design.md), sections 6 and 6.1.

## Epoch observation

| Date | Event | Start | End | Observed duration |
|---|---|---|---|---:|
| 2026-09-02 | Epoch 1 publication | Sepolia source block timestamp | CC3 `EpochAccepted` block timestamp | 8m 00s |
| 2026-09-08 | Epoch 2 publication ([Sepolia](https://sepolia.etherscan.io/tx/0xde9743af4f8895b152b49c0c67d2a0034ed392cd201a3f28d4f1bdbca4a7c3b9) block 11661380 at 13:33:00 UTC, [CC3](https://creditcoin-testnet.blockscout.com/tx/0x519bd88c03b37dd6e0db4defb73c149c394873a01e2d7598697d12b62cc8a9a1) block 5452305 at 13:41:15 UTC) | Sepolia source block timestamp | CC3 `EpochAccepted` block timestamp | 8m 15s |

This is a different clock from the worker wall-clock observations above. Its timestamps,
transactions and measurement label are recorded in
[`deployments/epoch-1.json`](../deployments/epoch-1.json).

## Earlier environment observation

The tutorial Hello Bridge run measured 9m 43s from burn to ASC application, including about 8.5
minutes of attestation waiting and roughly one minute for proof and submission. It checks the
environment and SDK path, not the Proofmark credential pipeline.

Source: [`docs/01-env-verification.md`](01-env-verification.md), sections 3.4 and 5.

## What can be said in the submission

- “Observed end-to-end mark propagation ranged from 7m 55s to 10m 48s across two Proofmark runs.”
- “Epoch 1 propagated in 8m 00s by source and destination block timestamps.”
- “The wait is visible and labelled in the edited demo.”

## What cannot be said

- “Instant”, “real-time” or “under nine minutes”
- A p50, p95 or availability SLA from this sample
- That the epoch observation and worker wall-clock observations are statistically interchangeable
- That testnet latency predicts mainnet or production performance

Every new run should append its source transaction, source block/time, worker detection time,
attested height time, CC3 transaction/block/time, start/end definition and any retries. Once enough
like-for-like samples exist, percentile reporting can replace the observed range.
