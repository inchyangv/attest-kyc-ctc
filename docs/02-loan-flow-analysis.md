# Reading Tutorial 4, `Loan Flow`

> 2026-08-30 · Subject: `reference/attestcoin-protocol-examples/loan-flow/` and `contracts/sol/`
> Purpose: take the ASC extension pattern and the security model, and find the example's limits before they find us

---

## 1. Why this example matters

It is the only tutorial that builds a cross-chain state machine. Hello Bridge proves one fact and mints once. Loan Flow uses repeated cross-chain confirmations to drive a sequence of state transitions.

```
Created → Funded → PartlyRepaid → Repaid
                 ↘ Expired
```

A product that verifies a fact and changes on-chain state as a result reuses this skeleton almost unchanged.

---

## 2. System layout

### 2.1 Components

| Where | Contract | Role |
|---|---|---|
| Sepolia, source | `TestERC20` | the ERC20 the loan uses |
| Sepolia, source | `AuxiliaryLoanContract` | moves the tokens and emits `LoanFunded` and `LoanRepaid` |
| Creditcoin | `ASCLoanManager`, extending `ASCBase` | verifies proofs and holds loan state, the authoritative ledger |
| Creditcoin | `EvmV1Decoder` | a library, deployed separately and linked |
| Off chain | `worker.ts` | watches both chains, builds proofs, submits them |

### 2.2 Deployment order matters

```
1. TestERC20              → Sepolia
2. EvmV1Decoder           → Creditcoin   (library)
3. ASCLoanManager         → Creditcoin   (--libraries, linked to step 2)
4. AuxiliaryLoanContract  → Sepolia
5. authorize_token           (whitelist the ERC20 on Aux)
6. register_source_contract  (register Aux on Manager)  required for security
```

> `EvmV1Decoder` is a `library`, so it needs its own deployment and a `--libraries ...:EvmV1Decoder:<address>` link. Skip that and `ASCLoanManager` fails to deploy. Our deployment script has to carry the step.

---

## 3. `ASCBase`, the skeleton we extend

This is the reusable core of an Attestcoin dApp (`contracts/sol/ASCBase.sol`).

```solidity
function execute(
    uint8 action,                                   // action code we define
    uint64 chainKey, uint64 blockHeight,            // source chain coordinates
    bytes calldata encodedTransaction,              // encoded transaction and receipt
    bytes32 merkleRoot,
    INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
    bytes32 lowerEndpointDigest,
    bytes32[] calldata continuityRoots
) external returns (bool) {
    bytes32 queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
    require(!processedQueries[queryId], "Query already processed");   // 2. replay guard
    bool verified = _verifyProof(...);                                 // 1. precompile verification
    require(verified, "Proof of inclusion verification failed");
    processedQueries[queryId] = true;
    _processAndEmitEvent(action, queryId, encodedTransaction);         // what we implement
    return true;
}
```

### There is exactly one extension point

```solidity
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;
```

Building our ASC means extending `ASCBase` and implementing `_processAndEmitEvent`. Proof verification and replay protection come free.

### The `queryId` computation hides a design constraint

```solidity
queryId = keccak256(abi.encodePacked(chainKey, blockHeight(8B), txIndex(32B)))  // 72 bytes
```

`txIndex` is recovered from the Merkle proof through `VERIFIER.calculateTxIndex(merkleProof)`.

> **What this implies.** `queryId` identifies one transaction. It carries neither the action nor an event index, so one source transaction gets one ASC action.
>
> The example reinforces that impression by reading only `logs[0]` in `_processFundLogs`. That turns out to be a simplification rather than a constraint, and section 8.1 shows the way around it: put N logs in one transaction and have the ASC walk all of them.

---

## 4. Security model: four checks worth copying

This is the part of the example that is well built. Drop any one of them and assets can be taken.

| # | Check | How | Attack it prevents |
|---|---|---|---|
| 1 | Inclusion proof | `VERIFIER.verifyAndEmit()` on the precompile at `0x…0FD2` | Claiming a transaction that never happened |
| 2 | Replay guard | `processedQueries[queryId]` | Submitting one proof repeatedly to be credited twice |
| 3 | Emitter check | `log.address_ == sourceLoanContract` | The one that matters most, see below |
| 4 | Receipt and type check | `receipt.receiptStatus == 1`, `isValidTransactionType` | Passing off a failed transaction as a success |

### Understand check 3

The README spells out the attack:

> Anyone can deploy their own contract, emit `LoanFunded` with any `loanId` they like, build an inclusion proof for that transaction and submit it. The proof is entirely valid, because the transaction really did happen on the source chain.

"This transaction exists" and "this transaction means something in our system" are different questions. The oracle answers the first. The contract has to answer the second.

```solidity
require(sourceLoanContract != address(0), "Source loan contract not registered!");
require(log.address_ == sourceLoanContract, "... not emitted by registered source loan contract!");
require(log.topics[0] == FUND_EVENT_SIGNATURE, "Not LoanFunded event");
```

> **Our checklist.** Whatever fact we read cross-chain, verify three things: the emitting contract is on an allowlist, the event signature matches, and the topics have the expected shape. An audit finds a missing one immediately.

---

## 5. Event decoding

`EvmV1Decoder` parses the encoded transaction and receipt.

```solidity
uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
require(EvmV1Decoder.isValidTransactionType(txType));

EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
require(receipt.receiptStatus == 1, "Transaction did not succeed");

EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, EVENT_SIG);
require(logs.length > 0);
```

`LogEntry` carries `address_` (the emitter), `topics[]` (indexed parameters) and `data` (the rest).

Event signatures are hardcoded as constants:

```solidity
// keccak256("LoanFunded(uint256)")
bytes32 public constant FUND_EVENT_SIGNATURE = 0x9e71d2fb732e...;
// keccak256("LoanRepaid(uint256,uint256)")
bytes32 public constant REPAY_EVENT_SIGNATURE = 0x040cee90ee47...;
```

Extracting parameters:
```solidity
loanId = uint256(log.topics[1]);        // indexed → topics
amount = abi.decode(log.data, (uint256)); // non-indexed → data
```

> This is where the guidance about unambiguous events earns itself. Filtering happens by signature alone, so a generic `Transfer` becomes hard to distinguish from another contract's, and a wrong indexed layout breaks parsing. Purpose-built events carrying every field the consumer needs.

---

## 6. The trust asymmetry

Loan Flow is trustless in one direction only.

```
Sepolia ──── oracle proof, trustless ────▶ Creditcoin     cryptographic
Creditcoin ── worker calls as owner ──────▶ Sepolia       requires trust
```

- `AuxiliaryLoanContract.registerLoanFund()` is `onlyOwner`, so the worker calls it directly with no proof.
- `markLoanAsExpired()` is `onlyOwner` on both sides.
- `ASCLoanManager.registerLoan()` is `onlyOwner`, so registering a loan is an operator action.

The reason is that Attestcoin's writability, the cross-chain execution path, is still in development. Only readability is trustless today.

### What that means for us

1. Say it plainly. When a judge or an auditor asks whether this is only half trustless, the answer names the protocol's current limit and where we placed our trust assumption. Hedging costs more than the limitation does.
2. There is room to do better. Keep the authoritative state on Creditcoin and use the source chain purely as an event emitter, and the trusted direction shrinks to nothing.
3. Which direction has to be trustless is the first product question. Ours is Sepolia to Creditcoin.

### A gap in the signature check

`registerLoan` verifies lender and borrower signatures with EIP-191, but:

```solidity
bytes32 messageHash = keccak256(abi.encodePacked(
    fundFlow.from, ..., loanTerms.deadlineBlockNumber
));
```

There is no nonce, no chainId and no contract address. A signature for identical terms can be reused, and it replays onto another chain or another deployment. Any signature we use goes through EIP-712 with a nonce, chainId and verifyingContract. An audit will raise this.

---

## 7. The off-chain worker (`worker.ts`)

### How it runs

A five-second polling loop watches six event types in parallel:

| Watched | Chain | Reaction |
|---|---|---|
| `LoanRegistered` | Creditcoin | calls `registerLoanFund` on the source chain |
| `LoanFunded` | Sepolia | builds a proof and calls `execute(action=0)` |
| `LoanRepaid` | Sepolia | builds a proof and calls `execute(action=1)` |
| `LoanFunded`, `LoanExpired`, `LoanPartiallyRepaid`, `LoanRepaid` | Creditcoin | logging only |

It also watches for the deadline block through `ccProvider.on('block')` and calls `markLoanAsExpired`.

It polls with `queryFilter`, and a comment gives the reason: RPC nodes expire filters and return `Filter id does not exist`.

### Production gaps, which is why we did not copy it

The example says it is educational, and it behaves accordingly.

| Problem | Where | Result |
|---|---|---|
| All state in memory | `loanTracker`, `loanExpiriesAt` | A restart loses everything, and events are ignored permanently with `Loan X not found in tracker` |
| Start block is now | `sourceFromBlock = await getBlockNumber()` | Anything emitted during downtime is missed for good |
| Dedupe cache cleared wholesale | `if (processedTxs.size > 1000) clear()` | Later events can be processed twice |
| Dedupe by transaction | `processedTxs.has(txHash)` | Only the first of several events in a transaction is handled |
| No retry | `catch { console.error }` | A failed proof or an out-of-gas is lost silently |
| One sequence | sequential await | One loan waiting eight minutes blocks every other |

**Minimum requirements for ours:**
- [x] Persist the block cursor to a file or database and resume from it
- [x] Persist processing history with an idempotence key
- [x] Exponential backoff on failure, with a dead letter state
- [x] Re-read state from chain rather than trusting memory
- [x] Process jobs independently so one eight-minute wait does not block the rest

> All five are implemented. See [`06-worker-design.md`](06-worker-design.md).

---

## 8. Cost and latency

Oracle queries consumed by a full Loan Flow cycle:

| Step | Oracle queries | Latency |
|---|---|---|
| `register_loan` | 0, local to Creditcoin | immediate |
| `fund_loan`, paid in full | 1 | about 8 min |
| `repay_loan`, principal | 1 | about 8 min |
| `repay_loan`, interest | 1 | about 8 min |
| **Total** | **3** | **about 24 min** |

> **Correction.** The first draft repeated the README's "100 CTC buys nine queries, so three cycles a day". The actual grant was 10,000 CTC. There is no query budget constraint.

The bottleneck is time, not money. A cycle takes about 24 minutes, and a failure costs that again.

| Mitigation | Effect |
|---|---|
| Local mock BlockProver on anvil | Verifies the whole ASC path with no proof, turning an eight-minute round trip into nothing |
| Pay in full rather than in parts | Saves one query and eight minutes |
| Several logs in one transaction, walked by the ASC | N facts per round trip, section 8.1 |

### 8.1 How batching actually works: `getLogsByEventSignature` returns everything

The example reads only `logs[0]`. That is a simplification, not a protocol constraint.

```solidity
EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, SIG);
// example: EvmV1Decoder.LogEntry memory log = logs[0];   only the first
for (uint i = 0; i < logs.length; i++) { ... }         walk them all
```

`queryId` is per transaction, so `execute()` runs once per transaction. Inside that one call every log in the transaction is available.

> **The conclusion.** Emit N entries from the source chain in one transaction and the ASC applies all of them in a single `execute()`. One cross-chain round trip, eight minutes and one query, covers N facts. This is how batching works in this protocol.
>
> `verifyBatch`, which shares a continuity proof across up to ten queries, is a separate mechanism for ten different transactions. `ASCBase` has no entry point for it, and `execute()` takes a single proof, so using it means implementing it ourselves.

## 9. The skeleton we reuse

```solidity
contract OurASC is Ownable, ASCBase {
    enum Actions { FactA, FactB }

    // 1) the trusted source contract, check 3
    address public sourceContract;

    // 2) event signature constants
    bytes32 public constant FACT_A_SIG = keccak256("FactAttested(bytes32,address)");

    function registerSourceContract(address c) external onlyOwner { sourceContract = c; }

    function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTx)
        internal override
    {
        if (action == uint8(Actions.FactA)) _handleFactA(encodedTx);
        else revert InvalidAction(action);
    }

    function _handleFactA(bytes memory encodedTx) internal {
        // 4. receipt and type checks
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        require(r.receiptStatus == 1, "tx failed");

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(r, FACT_A_SIG);
        require(logs.length > 0, "no event");
        EvmV1Decoder.LogEntry memory log = logs[0];

        // 3. emitter check, never omit this
        require(sourceContract != address(0), "source not registered");
        require(log.address_ == sourceContract, "untrusted emitter");
        require(log.topics[0] == FACT_A_SIG, "wrong event");
        require(log.topics.length == 3, "bad topics");

        // extract parameters, then business logic
        bytes32 factId = log.topics[1];
        address subject = address(uint160(uint256(log.topics[2])));
        // ... state transition ...
    }
}
```

**Reuse checklist**
- [x] Extend `ASCBase` for free proof verification and replay protection
- [x] Route actions in `_processAndEmitEvent`
- [x] Allowlist the source contract
- [x] Signature constants and topic shape checks
- [x] Receipt status check
- [x] Deploy and link `EvmV1Decoder`, in the deployment script
- [x] Purpose-built events only, carrying every field the ASC needs

---

## 10. Smaller observations

- The `ASCLoanManager` constructor reassigns `VERIFIER`, which the `ASCBase` constructor already set. A minimal example confirms solc 0.8.30 allows reassigning an immutable in a derived constructor, so this is redundant rather than wrong. Same value, no effect. We drop it.
- `AuxiliaryLoanContract.addAuthorizedToken` still carries `// TODO: Need to check if the address is a valid ERC20`, which says what kind of code this is.
- The `await tx.wait()` comment in `fund_loan.ts` reads like a bug someone hit: fund twice without waiting and a stale allowance collides. Our worker can fall into the same hole.

---

## 11. File map

| File | Contents |
|---|---|
| `contracts/sol/ASCBase.sol` | The extension skeleton: execute, proof verification, queryId, replay guard |
| `contracts/sol/VerifierInterface.sol` | Precompile interface and the `0x…0FD2` constant |
| `contracts/sol/ASCLoanManager.sol` | An ASC implementation: action routing, log checks, state transitions |
| `contracts/sol/AuxiliaryLoanContract.sol` | Source chain emitter and token movement |
| `contracts/sol/LoanTypes.sol` | Structs and enums |
| `loan-flow/worker.ts` | The whole off-chain worker |
| `utils/index.ts` | `generateProofFor`, gas estimation, submission helpers |
| `loan-flow/register.ts` | EIP-191 signature creation and submission |
| `loan-flow/fund_loan.ts` | The approve then fundLoan pattern |

---

## 12. Follow-up

- [x] Complete Hello Bridge once the faucet lands, confirming the environment end to end
- [x] Loan Flow needs four contract deployments. Reading the code, as in this document, was enough.
- [x] Draft our ASC from the section 9 skeleton
- [x] Build the worker around persistent state from the start, as section 7 requires
