# ASC integration review: the plan against how the protocol actually behaves

> 2026-08-30 · Tech Lead
> Subject: [`03-product-plan.md`](03-product-plan.md), section 5 architecture and section 6 data model
> Based on [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md), a read of `reference/attestcoin-protocol-examples`, and measured end-to-end runs
>
> **Conclusion.** The plan's direction holds. Three of its requirements cannot be implemented by inheriting `ASCBase` directly, and two of those become security holes. `ASCBase` has to be forked.

---

> **2026-08-30. Findings 1, 2 and 3 are proven by code rather than argued.**
> The `ASCBaseX` fork and `ProofmarkASC` are implemented, and a local harness that injects a mock precompile with `vm.etch` passes 14 tests. Three of them matter here:
> - `test_RejectsProofFromWrongChain` shows a mainnet proof (chainKey 3) is rejected, section 1
> - `test_StaleIssueCannotResurrectRevokedMark` shows an old issuance cannot revive a revoked mark, section 2
> - `test_BatchIssueProcessesAllLogs` applies three entries from one transaction with no `verifyBatch`, section 3
>
> [`04-event-schema.md`](04-event-schema.md) section 8 lists where each piece lives.

---

## Summary

| # | Finding | Severity | Effect on the plan |
|---|---|---|---|
| **1** | `_processAndEmitEvent` never receives `chainKey`, so the source chain cannot be pinned | high | rework the ASC design in section 5 |
| **2** | `_processAndEmitEvent` never receives `blockHeight`, so ordering cannot be enforced | high | add a rule to section 6.4 |
| **3** | No `verifyBatch` entry point on the contract side. It exists only in the SDK | medium | correct the batching claim in section 5.2 |
| **4** | `EvmV1Decoder` is a library and needs its own deployment and link | medium | a missing deployment step in section 9.2 |
| **5** | The replay key in section 7-7 does not match the real `queryId` granularity | low | reword section 7-7 |
| **6** | The batching argument in section 5.2 rests on an ATC assumption the measurements do not support | medium | replace the argument, section 6 below |
| 7 | The permissionless `materialize` assumption is correct | | no change |

---

## 1. The handler never receives `chainKey`

### What the code says

```solidity
// ASCBase.sol:18
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;
//                            no chainKey       no blockHeight
```

`execute()` takes `chainKey`, uses it for proof verification through `VERIFIER.verifyAndEmit`, and does not pass it on.

```sh
$ grep -n "chainKey" contracts/sol/ASCLoanManager.sol
# nothing. The example ASC never checks chainKey.
```

### Why that matters

CC3 Testnet supports two source chains at once, confirmed at runtime:

| chainKey | Chain | chainId |
|---|---|---|
| 1 | Ethereum Sepolia | 11155111 |
| 3 | Ethereum mainnet | 1 |

The only test the ASC applies is `log.address_ == sourceContract`. It never looks at which chain the log came from. If a contract at the same address also exists on mainnet and an attacker controls it, an event forged there passes as if it came from Sepolia.

### Whether it is exploitable depends on how you deploy

| Deployment | Exploitable |
|---|---|
| Plain `CREATE` from our EOA and nonce | Hard. The attacker needs our deployer key to land on the same address |
| `CREATE2`, for example through Foundry's default factory `0x4e59…4956C` | Yes. The address depends only on factory, salt and bytecode. Deploy the same bytecode to mainnet first and you own that contract, free to emit any `MarkIssued` you like |

Deploying to the same address across chains is common practice, which makes CREATE2 likely. At that point this stops being theoretical.

### Fix

Fork `ASCBase`, expose `chainKey` to the handler, and pin it on the first line.

```solidity
require(chainKey == expectedChainKey, "unexpected source chain");
```

> One line closes it. It costs nothing and holds regardless of how the contract was deployed.

---

## 2. Without `blockHeight` there is no ordering

### The scenario

Proof submission is permissionless and unordered. Anyone can submit an old proof at any time.

```
Sepolia block 100 : MarkIssued(Alice)
Sepolia block 200 : MarkRevoked(Alice)     sanctions hit

submission order, chosen by the attacker:
  1) submit the block 200 proof, Alice is revoked
  2) submit the block 100 proof, _onIssued runs, Alice is ACTIVE again
```

The `queryId`s differ because the block heights differ, so replay protection never fires. Both proofs are valid.

### Where this collides with section 6.4

Section 6.4 states that deny beats allow and a tombstone outranks any epoch root. That priority only partly closes this:
- If `MarkRevoked` sets `tombstone[W] = 1`, a later `MarkIssued` can change `status` but `isVerified` still stops at the tombstone.
- The moment a path exists to clear a tombstone, which false-positive resolution requires, or a `SUSPENDED` to `ACTIVE` transition appears, reordering becomes a live risk.
- Field updates such as extending `expiry` can also be rolled back by an older issuance.

### Fix

Keep a monotonic cursor per subject, which is why the handler needs `blockHeight`.

```solidity
mapping(address => uint64) public lastAppliedHeight;
mapping(address => uint64) public lastAppliedTxIndex;
// inside the handler
if (blockHeight < lastAppliedHeight[subject] ||
    (blockHeight == lastAppliedHeight[subject] && txIndex <= lastAppliedTxIndex[subject])) continue;
lastAppliedHeight[subject] = blockHeight;
lastAppliedTxIndex[subject] = txIndex;
```

`txIndex` is derived from the same proof verified by BlockProver, so opposing transactions inside
one source block are ordered without trusting the relayer. The snippet above is the historical
two-coordinate implementation. Working-tree v2 adds receipt-local log index and processes all
trusted lifecycle logs atomically; separate source functions did not enforce the old C1 rule.
See [the v2 specification](23-atomic-receipts.md). Historical design tables below are not release evidence.

---

## 3. There is no `verifyBatch` entry point on the contract

### What the code says

```sh
$ grep -rn "verifyBatch" contracts/sol/ node_modules/@gluwa/usc-contracts/contracts/
# nothing

$ grep -rn "verifyBatch" node_modules/@gluwa/usc-sdk/dist/block-prover/index.js
# → 205: verifyBatch(chainKey, heights, encodedTransaction, merkleProofs, sharedProof)
```

`verifyBatch` exists in the off-chain SDK and in the precompile, but not in `ASCBase`. `ASCBase.execute()` takes one proof, and `INativeQueryVerifier` declares only the single-proof `verifyAndEmit`.

### What that does to section 5.2

> Section 5.2 claimed `verifyBatch` would handle bursts of revocations, sharing one continuity proof across up to ten queries.

None of that comes for free. It would mean redeclaring the precompile's batch interface in Solidity and implementing the path ourselves.

### There is a cheaper route

Batching does not require `verifyBatch`. See [`02` section 8.1](02-loan-flow-analysis.md).

| Approach | Covers | Work needed |
|---|---|---|
| N events of one kind in one transaction, walked as logs | N entries inside one source transaction | Walk everything `getLogsByEventSignature` returns. `ASCBase` works as is |
| `verifyBatch` | Ten separate transactions | Implement the precompile's batch interface ourselves |

`revokeBatch()` already puts N events in one transaction, so the first approach covers what we need. Drop `verifyBatch` to P1 or out of scope; the implementation cost outweighs what it adds.

---

## 4. The `EvmV1Decoder` library deployment step is missing

The deployment schedule in section 9.2 omits this step, and without it `ProofmarkASC` fails to deploy.

```sh
# 1) deploy the library first
forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
  node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder

# 2) link that address and deploy the ASC
forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
  --libraries node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder:<address> \
  src/ProofmarkASC.sol:ProofmarkASC
```

Add "deploy and link EvmV1Decoder" as a prerequisite to the D-9 to D-8 entry in section 9.2.

> Do not reuse the pre-deployed address. Linking against the CC3 Testnet "Decoder Contract" at `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` was suggested, but its runtime size differs from our build: 19,199 hex chars against our 26,524. That could be a compiler or optimiser setting, or a different version. A bad link fails quietly and costs an eight-minute cycle to discover, and the saving is 0.0002 CTC. Deploy our own until someone proves they are the same.

---

## 5. Replay key granularity, a wording fix

| | Key |
|---|---|
| Plan, section 7-7 | `(chainKey, srcContract, srcTxHash, logIndex)` |
| Actual `ASCBase` | `(chainKey, blockHeight, txIndex)` |

`(blockHeight, txIndex)` identifies a transaction as precisely as `srcTxHash` does, so nothing is lost. `logIndex` is absent, but one `execute()` processes every log in that transaction atomically, so per-log duplication cannot occur. `srcContract` is also absent from the key, and the `log.address_` check covers that role.

Correct section 7-7 to the real key and note that per-log idempotence comes from atomic iteration. Nothing functional changes.

---

## 6. The batching argument needs a different premise

### What broke

Section 5.2 justified batching through protocol economics: free reads, paid writes. The end-to-end measurement says otherwise.

| Item | Measured |
|---|---|
| CC3 `execute()` gas | 394,982 |
| Gas price | 0.5 gwei |
| Balance change | 0.0002 CTC, exactly the gas cost |
| Separate oracle fee | none |

The readability path carries no ATC fee. What costs ATC appears to be writability, still in development. Both "our product creates ATC demand" and "we batch because writes are expensive" lose their footing.

### The conclusion survives on a different premise

The cost that drives batching sits on Ethereum, not on Creditcoin.

| Cost | At 100,000 users | Verdict |
|---|---|---|
| Creditcoin `execute()` | 0.0002 CTC times N | negligible, not a reason to batch |
| Ethereum L1 issuance transactions | 100,000 transactions of L1 gas | this is the real cost |
| Cross-chain round trips | 8 to 10 minutes times N, parallelisable | moderate |

**The replacement argument:**

> The epoch roster exists because of Ethereum L1 issuance cost, not Creditcoin write cost.
> One L1 transaction per user does not work at any scale.
> An epoch root fixes L1 writes independently of user count: 100,000 issuances become one L1 transaction.
> The Creditcoin round trip drops from N to one as a side effect.

This rests on measurement rather than an unverified ATC assumption, and it argues better. The expressive advantage for revocation, where falling out of the root is the whole mechanism, is unaffected.

### Settled: reads are free

Two independent sources agree, so this comes off the open questions list.

1. The protocol's own wording, from attestcoin.org: "Free reads, paid writes. Apps can read other chains at no cost; cross-chain actions require ATC token payment."
2. Our measurement: the `execute()` deduction equals the gas cost, 394,982 at 0.5 gwei, or 0.0002 CTC. No additional fee.

The claim that our product creates ATC demand and burn is withdrawn. The whole product sits on the free path. Once writability ships, propagation to spoke chains becomes a paid write, but that is roadmap rather than fact.

### What the CEIP argument rests on instead

Ecosystem rather than token economics. CEIP funds products that strengthen and grow the Creditcoin ecosystem. It does not ask how much ATC you burn.

| Withdrawn | Replacement |
|---|---|
| ~~Each epoch creates a cross-chain write, so we generate ATC demand~~ | Creditcoin becomes the chain of record for compliance. RWA and stablecoin issuers who are legally required to screen holders gain a reason to read it |
| ~~We batch because writes are expensive~~ | Ethereum L1 issuance gas is the real cost, as above |
| | Every submission in the other four tracks is a potential customer. A dApp that needs gating adds one SDK call |
| | Free reads mean there is no adoption barrier. A dApp integrates without paying per query |

> Free reads are not a fact working against us. They are the reason integration is frictionless, and saying so plainly holds up better in due diligence than inventing token demand that does not exist.

---

## 7. What the plan got right

| Plan | Verified |
|---|---|
| 6.5, anyone can `materialize` | `ASCBase.execute()` is `external` with no access control. Correct. A third party can push state forward when the issuer does not |
| 5, one source contract with purpose-built events | Matches the protocol's own guidance |
| 6.4, four fail-closed rules | No conflict with the ASC pattern |
| 7-3, publish the delay rather than hide it | Measured at 9m 43s from burn to application. Keep the wording |
| 5.2, splitting Mode A and Mode B | Structurally sound. Only the justification changes, as in section 6 |

---

## 8. Requested edits to the plan

| # | Where | What |
|---|---|---|
| 1 | 5 | State that `ProofmarkASC` forks `ASCBase` to expose `chainKey` and `blockHeight` |
| 2 | 6.4 | Order by `(blockHeight, txIndex)` per subject |
| 3 | 5.2 | Replace `verifyBatch` with walking multiple logs in one transaction, and drop `verifyBatch` to P1 |
| 4 | 9.2, D-9 | Add deploying and linking `EvmV1Decoder` as a prerequisite |
| 5 | 7-7 | Correct the replay key to `(chainKey, blockHeight, txIndex)` |
| 6 | 5.2 and 14 | Rebase the batching argument on Ethereum L1 issuance cost and drop the ATC demand claim |
| 7 | 5 | State the hard rule that one transaction carries one event kind ([`04`](04-event-schema.md) section 0, C1) |

---

## Appendix: the forked `ASCBase` signature

```solidity
// before
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;

// after, exposing the source identity and total transaction order
function _processAndEmitEvent(
    uint8   action,
    uint64  chainKey,        // pins the source chain, section 1
    uint64  blockHeight,     // enforces ordering, section 2
    uint64  txIndex,         // orders two transactions in the same source block
    bytes memory encodedTransaction
) internal virtual;
```

The fork derives `txIndex` through the verifier from the same Merkle proof used for inclusion.
Proof verification and the Attestcoin `queryId = keccak256(chainKey, blockHeight, txIndex)` replay
key remain byte-compatible with the upstream behavior.
