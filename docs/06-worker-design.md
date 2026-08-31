# Fault-tolerant worker

> 2026-08-30 · Tech Lead
> Background: [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md) section 7 on the example worker's production gaps, and [`01-env-verification.md`](01-env-verification.md) section 5 on the measured SDK failure.

---

## 1. Why we did not copy the example

The example worker (`loan-flow/worker.ts`) is labelled educational, and it behaves like it.

| Problem in the example | Result | What this worker does |
|---|---|---|
| All state in memory | A restart ignores events permanently | `Store`, file-backed with atomic writes |
| Start block from `getBlockNumber()` | Events during downtime are lost for good | Persisted cursor, resumes where it stopped |
| Dedupe cache cleared wholesale past 1000 entries | Duplicate processing | Per-job state kept permanently |
| No retry (`catch { console.error }`) | Silent loss | Exponential backoff plus a dead letter state |
| Sequential await | One eight-minute wait blocks the others | Independent jobs, concurrency 8 |
| **SDK `waitUntilHeightAttested`** | **Eight minutes of waiting lost to one timeout** | Every poll wrapped in its own retry |

### The last row is the one that matters, and we measured it

```
Waiting for block 11597452 attestation on Creditcoin...
Error: Failed to fetch attested height: AxiosError: timeout of 10000ms exceeded
  at ApiClient.<anonymous> (@gluwa/usc-sdk/dist/proof-provider/service/index.js:90:27)
```

`waitUntilHeightAttested()` polls every 15 seconds, but the HTTP call inside that loop carries a 10-second timeout and no retry. When it fails the exception escapes the loop and the wait is gone.

> **Attestation is a property of the chain, not of our process.** The source transaction stays valid, so retrying is always safe and there is never a reason to give up. `AttestationWatcher.waitFor()` absorbs individual poll failures and keeps waiting.

---

## 2. Layout

```
worker/
  config.ts       environment loading and validation
  log.ts          timestamped logger
  retry.ts        Backoff and withRetry, the answer to the SDK problem
  store.ts        file-backed state, atomic writes
  attestation.ts  attestation wait, replacing the SDK path
  proof.ts        proof retrieval and queryId computation
  abi.ts          ABIs read from the forge build output
  worker.ts       scan and process loops
  index.ts        entry point and graceful shutdown
```

## 3. Job lifecycle

```
discovered ──(wait for attestation)──▶ attested ──(proof)──▶ submitted ──▶ done
     │                                                            │
     └──────────── skipped (query already processed) ◀────────────┘
     └──────────── dead (past maxAttempts, or a C1 violation)
```

**One job is one source transaction.** `queryId` is per transaction, so `execute()` runs once per transaction and the ASC walks all N logs inside it.

## 4. The guards that matter

### 4.1 Cursor advances last

```ts
const found = await this.scanRange(from, to);
this.store.setCursor(to);   // only after every job in the range is persisted
```

Advance it first and a crash loses that range forever. The cursor also never moves backwards.

### 4.2 Idempotence, so no gas is wasted

The ASC already blocks a repeat through `processedQueries`, but the worker checks before submitting so a doomed transaction is never sent.

```ts
const txIndex = txIndexFromProof(proof.merkleProof.siblings);
const queryId = computeQueryId(proof.chainKey, proof.headerNumber, txIndex);
if (await this.asc.processedQueries(queryId)) { /* skipped */ }
```

`computeQueryId` has to match `ASCBaseX._computeQueryId` byte for byte. Both sides verify the 72-byte layout.

| Range | Contents |
|---|---|
| `[0..32)` | `uint256(chainKey)` |
| `[32..40)` | `uint64 blockHeight`, big-endian |
| `[40..72)` | `uint256(txIndex)` |

- Solidity: `test/QueryId.t.sol`, 256 fuzz runs plus a fixed vector
- TypeScript: `worker/worker.test.ts`, checked against the same fixed vector
  `0x6ca17d0e6939c57d0d71f9b17302db50a70d50e09c6144c362cadd1850a36159`

### 4.3 Configuration check at startup

```ts
if (Number(expectedKey) !== cfg.chainKey) throw …
if (srcAddr.toLowerCase() !== cfg.sourceAddress.toLowerCase()) throw …
```

If the source the ASC trusts differs from the source the worker watches, every proof reverts. Dying at startup beats burning eight minutes to find out.

### 4.4 Reorg headroom

Blocks are treated as final only once they are `WORKER_CONFIRMATIONS` behind head, default 4. Attestation already requires finality, so a larger value buys nothing.

### 4.5 C1 violation detection

Mixed ASC event kinds in one transaction mean one gets processed and the rest are sealed permanently ([`04-event-schema.md`](04-event-schema.md) section 0). Our `ComplianceSource` never produces such a transaction, so seeing one means something upstream is wrong. The worker marks the job `dead` and logs an error rather than passing over it.

### 4.6 Failure isolation

One failing job does not stop the queue. Past `maxAttempts` it becomes `dead` and waits for a human.

---

## 5. Running it

```sh
forge build                 # produces the ABIs the worker reads from out/
npm run worker
npm run worker:test         # 11 unit tests
npm run typecheck
```

`.env.example` lists what is needed. Fill in `SOURCE_CONTRACT_ADDRESS` and `ASC_CONTRACT_ADDRESS` after deployment.

## 6. Verified against the deployed contracts

The worker handled the whole path unattended, twice.

| Step | Synthetic mark (2026-08-30) | Honest mark (2026-08-31) |
|---|---|---|
| Sepolia `issue()` | `0x93e4f981…9a01`, block 11,597,799, 27,933 gas | `0xa251db9d…baea`, block 11,602,963 |
| Worker sees it | 86 seconds | 110 seconds |
| Attestation completes | 6m 30s (39 blocks) | 8m 50s (33 blocks) |
| CC3 `execute()` | `0xe0f8f6d4…`, 386,008 gas | `0x8e96ce1f…`, 388,696 gas |
| `isVerified` true | 7m 55s | 10m 48s |

```
✓ ASC configuration matches
found MarkIssued x1 in tx 0xa251db9d... (block 11602963)
waiting for block 11602963 to be attested. Latest 11602930, 33 blocks behind (~6.6 min)
✓ block 11602963 attested (latest 11602970)
✓ applied MarkIssued x1, gas 388696
```

Everything the design promised held: the startup check on `expectedChainKey` and `sourceContract`, absorbed polling failures, the pre-submission idempotence check, and a persisted cursor.

### What the first run did not prove

> The first mark's `methods` were hand-authored rather than produced by the pipeline. `0x19003f` claimed `ID_DOC_AUTHENTICITY`, `FACE_MATCH`, `LIVENESS` and `BANK_ACCOUNT`, and none of those checks ran.

| Proven | Not proven |
|---|---|
| Cross-chain integrity, every field intact | That any identity screening happened |
| Worker resilience across detect, wait and submit | That the `methods` bits were true |
| The gate responds (`isVerified` then `note.mint`) | Pipeline honesty |
| Propagation of 7m 55s | |

That mark was revoked on 2026-08-30, reason `ISSUER_ERROR`, propagating back in 8m 43s. A mark claiming checks that never ran is exactly what this product exists to stop, so leaving it on our own testnet was not an option.

The second run fixed the gap. The pipeline produced `0x190001` with no vendors connected, which passes the pilot policy and fails production, and that is what reached Creditcoin.

### Cross-chain integrity, field by field

```
status 1 ACTIVE   origin 1 Direct   kind 1   assurance 1   regime 2 sandbox   jurisdiction 410
methods 0x190001   epoch 0
claimsRoot   0x6e7b9593…05c9   matches what was issued
evidenceHash 0x3f976d2f…47d7   matches what was issued
```

> `origin = 1 (Direct)` came from the ASC, not the source event (`ProofmarkASC.sol:149`). Keeping it out of the packed attrs is what stops an issuer claiming roster provenance it never earned, and the on-chain value confirms the decision.

### Attestation latency is a range

| Observation | Latency |
|---|---|
| Hello Bridge, 8/30 | 8.5 min (42 blocks) |
| Synthetic mark E2E, 8/30 | 6.5 min (39 blocks) |
| Honest mark E2E, 8/31 | 8.8 min (33 blocks) |

**6.5 to 8.8 minutes across three observations.** Documents and the deck quote the range, never a single figure. Video editing assumes the worst case.

---

## 7. Two operational traps

### 7.1 Start the worker before issuing

With `WORKER_START_BLOCK=0` the cursor begins at the current head. Issue first and the worker never sees the event.

- Start the worker, then issue.
- If you already issued, set `WORKER_START_BLOCK=<block before issuance>` and `rm -f state/worker.json`.

This is the easiest thing to get wrong in a demo rehearsal.

### 7.2 `origin` is the second field of `getMark`

The `Mark` struct runs `status, origin, kind, assurance, …`. Omit `origin` from the ABI and every field shifts by one, which prints the last 20 bytes of `evidenceHash` as an address and makes `issuer` look corrupted. We hit this once.

The README and any reproduction steps carry the full signature:

```sh
cast call $ASC \
  "getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))" \
  $SUBJECT --rpc-url $CREDITCOIN_RPC_URL
```

> Always pass `--from` to `cast call`. Without it `msg.sender` is zero, `onlyOwner` fires first, and `OwnableUnauthorizedAccount` (`0x118cdaa7`) is easy to mistake for the gate working. The gate's own rejection is `RecipientNotVerified` (`0x17887111`).

---

## 8. Verification status

| | |
|---|---|
| Worker unit tests | **11 passed** (queryId 3, txIndex 2, Store 5, Backoff 1) |
| Typecheck | clean |
| Contract tests | **45 passed** |

> The typecheck caught a real bug along the way: `this.src` (provider) confused with `this.source` (contract). Log scanning would not have worked at all.

## 9. Remaining

- [x] ~~One E2E against the deployed addresses~~ done twice, section 6
- [ ] Dead-letter reprocessing CLI (`--retry-dead`)
- [ ] Metrics for processing latency, p50 and p95, feeding the KPIs in the plan
- [ ] Mode B is already wired on the source side as action 3, `RosterEpochPublished`. The ASC handler is P1.

---

## 10. Deployment topology and HA

The worker runs as a single instance. Its state is one local JSON file (`state/worker.json`, overridable through `WORKER_STATE_PATH` in `worker/config.ts`), there is no leader election and no lock, and nothing coordinates a second copy if one is started by hand. While the instance is down, propagation stops; on restart it resumes from the persisted cursor and works through the backlog. That is a delay, never a loss and never a corruption: attestation is a property of the chain, the source transaction stays valid however long it waits, and the cursor never rewinds, so a restart can neither skip an event nor overwrite what was already applied.

That is the state today. What follows is why closing it is a deployment change rather than a protocol change.

### 10.1 Redundancy is already safe

The contracts, not the worker, are what make duplicate submissions harmless.

| Guarantee | Where | What it gives us |
|---|---|---|
| `execute()` is permissionless and idempotent | `src/ASCBaseX.sol` | "Permissionless by design: anyone may call it", and the replay guard `require(!processedQueries[queryId], "Query already processed")` lets exactly one submission land |
| Ordering per subject | `src/ProofmarkASC.sol` | `lastAppliedHeight[subject]` skips any proof at or below the height already applied, emitting `StaleProofSkipped` instead of writing |
| Pre-submission check | `worker/worker.ts`, step 3 | The worker reads `processedQueries(queryId)` before submitting and marks the job `skipped`, so a worker that loses the race usually spends no gas at all |

`queryId` is `keccak256(chainKey, blockHeight, txIndex)`, derived from the source transaction and independent of who submits it. Two workers proving the same source transaction therefore compute the same `queryId` and collide on it: one `execute()` lands, the other reverts with `Query already processed`.

Arrival order does not matter either. In `_onIssued` and `_onTombstone`, a proof whose `blockHeight <= lastAppliedHeight[subject]` is skipped with a `StaleProofSkipped` event, so the transaction succeeds with subject state untouched and a late or out-of-order submission cannot resurrect a revoked mark or overwrite a newer one. `_onEpoch` has the same property from `if (epoch <= latestEpoch) revert EpochNotMonotonic(...)`.

The cost of full redundancy is bounded, and it is gas rather than correctness. The `processedQueries` read makes the common duplicate free; only inside the window between that read and the winner's inclusion does the loser pay for one reverted transaction.

### 10.2 Roadmap

| Step | What it is | Why it works |
|---|---|---|
| N stateless workers | The same worker running in more than one place, each with its own cursor | Section 7.1 already rebuilds state by setting `WORKER_START_BLOCK` and deleting `state/worker.json`. The chain is the source of truth and the state file is a rebuildable cursor cache, so shared state is optional rather than a prerequisite |
| Leader election | One worker submits while the others stand by | A cost optimization. It removes duplicate gas and nothing else, and it is explicitly not a correctness requirement, because the guarantees in 10.1 hold without it |
| Dead-letter alerting | A job reaching `dead` pages a human | `dead` means maxAttempts exhausted or a C1 violation (sections 4.5 and 4.6), which is the one class of failure that redundancy cannot fix |

Fleet-wide ordering needs no coordination: every worker is ordered per subject by `lastAppliedHeight`, so an instance replaying old blocks cannot damage a subject another instance has already moved forward.

> None of this topology is implemented today; every run in section 6 used one instance.
