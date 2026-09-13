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

`AttestationWatcher.waitFor()` absorbs individual poll failures and keeps waiting. This does not establish that the original source coordinates remain canonical. The working tree checks source hash/finality around the wait and stops on a conflicting observation; see [source checkpoints](26-source-checkpoints.md).

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
  proof-http.ts   cancellable, byte/deadline-bounded proof/attestation HTTP
  abi.ts          ABIs read from the forge build output
  worker.ts       scan and process loops
  index.ts        entry point and graceful shutdown
```

## 3. Job lifecycle

```
discovered ──(wait for attestation)──▶ attested ──(proof)──▶ submitted ──▶ done
     │                                                            │
     └──────────── skipped (query already processed) ◀────────────┘
     └──────────── dead (past maxAttempts)
```

**One job is one source transaction.** `queryId` is per transaction, so `execute()` runs once per transaction and the ASC walks all N logs inside it.

## 4. The guards that matter

### 4.1 Atomic range checkpoints

```ts
this.store.commitSourceRange(from, { height: to, hash: end.hash }, jobs);
```

The working tree commits jobs, cursor and the range-end hash together after consistency checks. The cursor advances normally, but can rewind to a verified retained ancestor for an unsigned fork. Signed or consumed outcomes are preserved under a persistent hold. See [source checkpoint recovery](26-source-checkpoints.md).

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

The scan ceiling is the lower of the RPC's `finalized` height and `head - WORKER_CONFIRMATIONS` (margin default 4). Missing finality fails closed; confirmations are not a substitute. Checkpoint and per-job source hash checks guard restart, attestation and relay boundaries. These rely on the source RPC and do not guarantee safety against a finality violation or a dishonest/incomplete RPC.

### 4.5 Atomic receipt version gate

Working-tree startup requires `TRANSACTION_PROCESSING_VERSION() == 2` before dispatch. A missing/unknown version fails closed. The scanner groups all recognized source logs per transaction, including mixed kinds and duplicate subjects, into one executable job. The first recognized event supplies an action hint; ASC v2 processes the entire trusted receipt regardless of that hint. This replaces the old mixed-event `dead` quarantine, which incorrectly assumed source function separation prevented issuer-contract composition. Old dead jobs and consumed v1 queries need explicit migration/reconciliation, not automatic erasure. See [atomic receipts](23-atomic-receipts.md).

### 4.6 Failure isolation

Working-tree startup also requires `ISSUER_KEY_PROVENANCE_VERSION() == 1` on both source and ASC. The scanner treats `KeyedMarkIssued` as action 0 and `IssuerKeyCompromised` as action 4. Thus a cutoff declaration is a durable transaction job subject to the same finalized scan, proof, relay journal and restart behavior as other lifecycle receipts; merely changing a source role is not substituted for that event.

Startup additionally requires `DENIAL_CORRECTION_VERSION() == 1` on Source and ASC. `SanctionDenialCorrected` is action 5; its paired replacement issuance stays in the same transaction job and is applied atomically. An old worker that does not watch action 5 must not operate a correction-capable release.

Ordinary job failures retry and eventually become `dead`. Source safety, state integrity and ownership failures stop the worker. An unresolved signed relay retains its nonce gate rather than being discarded after retry exhaustion.

### 4.7 Bounded execution reservations (working tree, 2026-09-07)

`worker/pool.ts` reserves a job ID synchronously before its first asynchronous step. Capacity and duplicate checks share that reservation. When no slot is available, the caller returns immediately; the job remains in the persisted Store backlog for a later poll. There is no per-job capacity sleep or second queue of waiting promises. At most `WORKER_CONCURRENCY` task reservations exist, including callbacks not yet entered. The file-backed Store still loads its entire backlog into memory; this does not claim bounded total backlog memory or a managed queue.

The worker reloads a reserved job immediately before processing and skips a missing/terminal job or a stopped worker. Completion and failure release the reservation. Stop refuses new reservations; drain waits for actual tasks only. It does not impose a new RPC deadline or solve an indefinitely stalled existing dependency call.

Concurrency, scan span, retry count, poll interval and confirmations must be positive safe integers. Cold-start now requires a positive explicit source deployment/replay block; there is no head-default fallback.

`worker/pool.test.ts` exercises 100 polling bursts over 1,000 IDs at capacity 3, 120 file-backed jobs across repeated polling cycles, execution/reporting failure cleanup, stop/drain and malformed settings. The tests verify the production pool and backlog selector with synthetic work. They do not submit proofs or establish nonce safety.

The subsequent [relay journal change](25-relay-recovery.md) adds durable signed transactions, signer serialization and single-host process ownership. The pool alone does not guarantee exactly-once sends. [Source checkpoint recovery](26-source-checkpoints.md) now covers unsigned reorg replay; signed-fork remediation, managed HA and actual proof-service E2E remain separate gates.

[Cooperative shutdown](61-worker-cancellation.md) subsequently connects worker cancellation to polling/backoff and actual proof/attestation HTTP. It preserves pending/signed recovery state and does not impose a global shutdown deadline on source/hub RPC or synchronous work.

---

## 5. Running it

```sh
forge build                 # produces the ABIs the worker reads from out/
npm run worker:init-state   # one-time authorized zero-nonce dedicated signer bootstrap
npm run worker
npm run worker:test         # worker unit/fault-injection tests
npm run test:source-reorg   # isolated Anvil source relocation test
npm run test:t16-recovery   # isolated Anvil loss/backup/deep-hub-reorg fence
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

### 7.1 Pin the start block and preserve signer state

The historical worker used `WORKER_START_BLOCK=0` to start at the current head, missing earlier issuance. The working tree requires a positive explicit deployment/replay start block and pins it with chain/source/ASC/signer identity in the state file.

- For a new authorized deployment, use its verified source creation/replay block and an unused dedicated relay key, then run `npm run worker:init-state` exactly once before the service. The initializer requires latest and pending nonce zero and sends no transaction.
- Preserve old state. An unscoped legacy file requires reconciliation; it is not automatically rebound.
- Never delete a state file to rescan: it may contain the only association between an unresolved signed transaction and its job. Use the [recovery runbook](25-relay-recovery.md).

New starts and migrations must inventory outstanding transactions before the worker can safely allocate a nonce.

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

## 8. Historical verification status (2026-08-30)

| | |
|---|---|
| Worker unit tests | **11 passed** (queryId 3, txIndex 2, Store 5, Backoff 1) |
| Typecheck | clean |
| Contract tests | **57 passed** |

> The typecheck caught a real bug along the way: `this.src` (provider) confused with `this.source` (contract). Log scanning would not have worked at all.

## 9. Remaining

- [x] ~~One E2E against the deployed addresses~~ done twice, section 6
- [ ] Dead-letter reprocessing CLI (`--retry-dead`)
- [ ] Metrics for processing latency, p50 and p95, feeding the KPIs in the plan
- [x] Historical Mode B epoch-1 handler exercised on the old deployment. This is **not** evidence for working-tree epoch schema v2; the new worker requires schema 2 on source and ASC. See [epoch migration](32-epoch-freshness.md).

---

## 10. Deployment topology and HA

The working-tree worker is a single-host service with a local JSON state file, process leases and a durable signed relay envelope. While the instance is down, propagation stops. Restart validates source checkpoints before dispatch, checks the original pending receipt before proof preparation, and reconciles all retained terminal/skip hub observations plus contiguous signer nonces. Unsigned source forks within retained history can be replayed; signed/consumed source forks, stale backups, missing baselines and removed released receipts are held. Detection and signing fences are local; authorized state repair after loss/finality violation, archive RPC loss or a corrupted/mismatched deployment remain T-16/T-17/T-21 gates. See [relay recovery](25-relay-recovery.md) and [source checkpoints](26-source-checkpoints.md).

There is no managed HA or shared distributed lease implementation today. Contract replay protection and relay operational correctness are separate concerns.

### 10.1 What contract replay protection does and does not guarantee

The contracts reject duplicate queries; they do not coordinate the nonce of workers sharing a key or restore lost signed transaction associations.

| Guarantee | Where | What it gives us |
|---|---|---|
| `execute()` is permissionless and idempotent | `src/ASCBaseX.sol` | "Permissionless by design: anyone may call it", and the replay guard `require(!processedQueries[queryId], "Query already processed")` lets exactly one submission land |
| Ordering per subject | `src/ProofmarkASC.sol` | one `(height, tx, log)` cursor orders ordinary events and a separate cursor orders denial/correction decisions |
| Pre-submission check | `worker/worker.ts`, step 3 | The worker reads `processedQueries(queryId)` before submitting and marks the job `skipped`, so a worker that loses the race usually spends no gas at all |

`queryId` is `keccak256(chainKey, blockHeight, txIndex)`, derived from the source transaction and independent of who submits it. Two workers proving the same source transaction therefore compute the same `queryId` and collide on it: one `execute()` lands, the other reverts with `Query already processed`.

For credential state, ordinary events use the lexicographic triple including receipt log position; stale ordinary events are skipped while denial remains fail-closed until a newer governed correction. The ASC visits all lifecycle logs in a mixed receipt and skips stale epochs without suppressing other events. These controls do not make two independent same-key relay processes safe.

The cost of full redundancy is bounded, and it is gas rather than correctness. The `processedQueries` read makes the common duplicate free; only inside the window between that read and the winner's inclusion does the loser pay for one reverted transaction.

### 10.2 Roadmap

| Step | What it is | Why it works |
|---|---|---|
| Multiple workers | Requires an explicit managed ownership/state design or strictly separate signer keys | Local state now holds unresolved signed transactions, not only a rebuildable cursor. Sharing a signer across independent stores is unsupported |
| Leader election | One owner per signer with durable fencing and recovery | Required for a shared signer in HA; permissionless query replay protection alone does not prevent nonce replacement or unknown transaction outcomes |
| Dead-letter alerting | A job reaching `dead` should page a human | `dead` means maxAttempts exhausted; historical C1 quarantines require explicit reconciliation. Alert delivery is still an operational gate |

ASC v2 orders ordinary events by `(blockHeight, txIndex, receiptLogIndex)` and accumulates permanent denial independently. That protects credential ordering, not the wallet nonce or storage coordination of a relay fleet.

> None of this topology is implemented today; every run in section 6 used one instance.
