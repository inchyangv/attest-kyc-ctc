# Event schema

> 2026-08-30 · Tech Lead
> Prerequisites: [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md) for the ASC pattern, [`03-product-plan.md`](03-product-plan.md) sections 5 and 6 for the product
> Read alongside [`05-asc-integration-review.md`](05-asc-integration-review.md), which is where this schema's constraints come from
>
> Freezing this document unblocks `ComplianceSource.sol` on Sepolia, `ProofmarkASC.sol` on CC3 and the worker in parallel.
> Any change after that costs three simultaneous edits.

---

## 0. Four constraints that shape the schema

All four come from reading `ASCBase`. They decide how much freedom the event design has.

| # | Constraint | Source | Effect on the schema |
|---|---|---|---|
| C1 | `queryId = f(chainKey, blockHeight, txIndex)`, carrying neither the action nor the log index | `ASCBase._computeQueryId` | One source transaction gets one `execute()`. Mix event kinds in a transaction and one is processed while the rest are sealed permanently |
| C2 | One `execute()` can walk every log in that transaction | `getLogsByEventSignature` returns an array | Batching means N events of one kind in one transaction |
| C3 | At most 4 topics: the signature plus 3 indexed | EVM | Three indexed parameters. Everything else goes in `data` |
| C4 | Checking `log.address_` is the only authenticity test available | `ASCLoanManager._processFundLogs` | Events come from exactly one source contract |

### The hard rule that follows from C1

> One transaction emits one kind of ASC event.

Mixing them opens a griefing path. An attacker lands the cheap action first, `processedQueries[queryId]` is consumed, and every other event in that transaction is sealed for good. `execute()` is permissionless, so anyone can do it.

Every `ComplianceSource` function emits one kind of event. Compound operations, such as issuing and publishing an epoch, use separate transactions.

---

## 1. Action codes

```solidity
enum Action {
    MarkIssued,       // 0
    MarkRevoked,      // 1
    SanctionDenied,   // 2
    RosterEpoch       // 3
}
```

The `action` in `execute(action, ...)` comes from the caller and is not derived from the proof. A wrong pairing makes `getLogsByEventSignature` return nothing and the `require` reverts, so it fails safely. A revert also rolls back `processedQueries`, so nothing is sealed. The exception is the mixed transaction C1 describes.

---

## 2. Scalar packing: `attrs` as bytes32

The mark's scalar fields occupy exactly 192 bits inside one `bytes32`.

```
bit  255      248 247      240 239        224 223           208
     ┌──────────┬───────────┬──────────────┬─────────────────┐
     │ kind  u8 │assurance u8│  regime u16  │ jurisdiction u16│
     └──────────┴───────────┴──────────────┴─────────────────┘
bit  207            176 175            136 135          96 95        64 63    0
     ┌────────────────┬──────────────────┬───────────────┬────────────┬────────┐
     │  methods  u32  │  issuedAt   u40  │  expiry  u40  │ epoch  u32 │ resv64 │
     └────────────────┴──────────────────┴───────────────┴────────────┴────────┘
```

| Field | Type | Shift | Mask |
|---|---|---|---|
| `kind` | uint8 | 248 | `0xFF` |
| `assurance` | uint8 | 240 | `0xFF` |
| `regime` | uint16 | 224 | `0xFFFF` |
| `jurisdiction` | uint16 | 208 | `0xFFFF` |
| `methods` | uint32 | 176 | `0xFFFFFFFF` |
| `issuedAt` | uint40 | 136 | `0xFFFFFFFFFF` |
| `expiry` | uint40 | 96 | `0xFFFFFFFFFF` |
| `epoch` | uint32 | 64 | `0xFFFFFFFF` |
| (reserved) | 64 bits | 0 | room to extend |

**Why pack**
1. The whole encoded transaction travels as calldata, so a smaller log costs less gas to verify.
2. Indexing `attrs` lets the ASC read it straight from `topics[2]` with no `abi.decode`.
3. The reserved 64 bits allow new fields without changing the event signature, and a signature change means editing three places at once.

```solidity
library MarkAttrs {
    function pack(
        uint8 kind, uint8 assurance, uint16 regime, uint16 jurisdiction,
        uint32 methods, uint40 issuedAt, uint40 expiry, uint32 epoch
    ) internal pure returns (bytes32) {
        return bytes32(
            (uint256(kind)         << 248) | (uint256(assurance) << 240) |
            (uint256(regime)       << 224) | (uint256(jurisdiction) << 208) |
            (uint256(methods)      << 176) | (uint256(issuedAt)  << 136) |
            (uint256(expiry)       <<  96) | (uint256(epoch)     <<  64)
        );
    }
    function kind(bytes32 a)         internal pure returns (uint8)  { return uint8(uint256(a) >> 248); }
    function assurance(bytes32 a)    internal pure returns (uint8)  { return uint8(uint256(a) >> 240); }
    function regime(bytes32 a)       internal pure returns (uint16) { return uint16(uint256(a) >> 224); }
    function jurisdiction(bytes32 a) internal pure returns (uint16) { return uint16(uint256(a) >> 208); }
    function methods(bytes32 a)      internal pure returns (uint32) { return uint32(uint256(a) >> 176); }
    function issuedAt(bytes32 a)     internal pure returns (uint40) { return uint40(uint256(a) >> 136); }
    function expiry(bytes32 a)       internal pure returns (uint40) { return uint40(uint256(a) >>  96); }
    function epoch(bytes32 a)        internal pure returns (uint32) { return uint32(uint256(a) >>  64); }
}
```

---

## 3. The four events

### 3.1 `MarkIssued`

```solidity
/// @notice A compliance mark is issued. The Creditcoin ASC consumes this cross-chain.
event MarkIssued(
    address indexed subject,      // topics[1] subject wallet
    bytes32 indexed attrs,        // topics[2] packed scalars, section 2
    address indexed issuer,       // topics[3] issuer
    bytes32 claimsRoot,           // data[0]   claim commitment root
    bytes32 evidenceHash          // data[1]   evidence chain head
);
```

| | |
|---|---|
| Signature | `MarkIssued(address,bytes32,address,bytes32,bytes32)` |
| topics | 4, the maximum |
| data | 64 bytes |
| Action | `0` |

> Indexing `attrs` is what makes this work. The ASC reads `topics[2]` and has all eight fields.
> `subject` and `issuer` also serve the worker's `queryFilter`.

### 3.2 `MarkRevoked`

```solidity
/// @notice A mark is revoked. Tombstones outrank every epoch root.
event MarkRevoked(
    address indexed subject,      // topics[1]
    uint16  indexed reasonCode,   // topics[2]
    uint32  indexed epoch         // topics[3] epoch at revocation
);
```

| | |
|---|---|
| Signature | `MarkRevoked(address,uint16,uint32)` |
| topics | 4 |
| data | **0 bytes** |
| Action | `1` |

> With no data, batch revocation is cheap. Emit N in one transaction and one `execute()` applies all of them (C2).

**`reasonCode`**

| Value | Meaning |
|---|---|
| 1 | user request |
| 2 | rescreening hit |
| 3 | document expired |
| 4 | issuer error |
| 5 | risk escalated |
| 6 | appeal upheld, false positive cleared |

### 3.3 `SanctionDenied`

```solidity
/// @notice A sanction decision. Deny beats allow and outranks any mark.
event SanctionDenied(
    address indexed subject,      // topics[1]
    uint32  indexed listVersion,  // topics[2] list edition that matched
    uint32  indexed epoch         // topics[3]
);
```

| | |
|---|---|
| Signature | `SanctionDenied(address,uint32,uint32)` |
| topics | 4 |
| data | 0 bytes |
| Action | `2` |

> Separate from `MarkRevoked` because a revocation can be undone when a false positive clears, while a sanction runs on its own lane and consumers query it through `isDenied()`. Distinct signatures are what let `getLogsByEventSignature` separate them.

### 3.4 `RosterEpochPublished`

```solidity
/// @notice Publishes an epoch roster root. One write regardless of how many subjects it covers.
event RosterEpochPublished(
    uint32  indexed epoch,        // topics[1]
    bytes32 indexed root,         // topics[2] sorted-key Merkle root
    uint32  indexed listVersion,  // topics[3] AML list edition
    uint40  validUntil            // data[0]   roster freshness expiry
);
```

| | |
|---|---|
| Signature | `RosterEpochPublished(uint32,bytes32,uint32,uint40)` |
| topics | 4 |
| data | 32 bytes |
| Action | `3` |

> Exactly one per transaction. Epochs increase monotonically, so batching them means nothing.

---

## 4. Checked against the protocol's own guidance

The Attestcoin docs list five readability practices. This schema follows all five.

| Guidance | This schema | |
|---|---|---|
| One source contract per dApp | `ComplianceSource.sol` only | yes |
| A distinct event type per query | four distinct signatures | yes |
| Names that state the cross-chain intent | `MarkIssued`, `RosterEpochPublished` | yes |
| Avoid standard events such as `Transfer` | purpose-built events only | yes |
| Everything the ASC needs is in the event | eight fields in `attrs` plus two roots | yes |

---

## 5. The consuming side: reference implementation

```solidity
contract ProofmarkASC is Ownable, ASCBaseX {   // the fork, see doc 05 section 2
    using MarkAttrs for bytes32;

    bytes32 constant SIG_ISSUED  = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
    bytes32 constant SIG_REVOKED = keccak256("MarkRevoked(address,uint16,uint32)");
    bytes32 constant SIG_DENIED  = keccak256("SanctionDenied(address,uint32,uint32)");
    bytes32 constant SIG_EPOCH   = keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40)");

    uint64  public expectedChainKey;        // doc 05 section 1, cross-chain confusion
    address public sourceContract;          // C4
    mapping(address => uint64) public lastAppliedHeight;   // doc 05 section 3, ordering

    function _processAndEmitEvent(
        uint8 action, uint64 chainKey, uint64 blockHeight,
        bytes32, bytes memory encodedTx
    ) internal override {
        // 1. pin the source chain, or an Ethereum mainnet proof passes
        require(chainKey == expectedChainKey, "unexpected source chain");

        if      (action == uint8(Action.MarkIssued))     _onIssued(blockHeight, _logs(encodedTx, SIG_ISSUED));
        else if (action == uint8(Action.MarkRevoked))    _onRevoked(blockHeight, _logs(encodedTx, SIG_REVOKED));
        else if (action == uint8(Action.SanctionDenied)) _onDenied(blockHeight, _logs(encodedTx, SIG_DENIED));
        else if (action == uint8(Action.RosterEpoch))    _onEpoch(_logs(encodedTx, SIG_EPOCH));
        else revert InvalidAction(action);
    }

    /// Receipt check and signature filter, following ASCLoanManager._validateTransactionContents
    function _logs(bytes memory encodedTx, bytes32 sig)
        private pure returns (EvmV1Decoder.LogEntry[] memory logs)
    {
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        require(r.receiptStatus == 1, "source tx failed");        // 2. reject failed source transactions
        logs = EvmV1Decoder.getLogsByEventSignature(r, sig);
        require(logs.length > 0, "no matching event");
    }

    function _onIssued(uint64 blockHeight, EvmV1Decoder.LogEntry[] memory logs) private {
        for (uint256 i = 0; i < logs.length; i++) {               // 3. C2, batching
            EvmV1Decoder.LogEntry memory L = logs[i];
            require(L.address_ == sourceContract, "untrusted emitter");   // 4. C4
            require(L.topics.length == 4, "bad topics");

            address subject = address(uint160(uint256(L.topics[1])));
            bytes32 attrs   = L.topics[2];
            address issuer  = address(uint160(uint256(L.topics[3])));
            (bytes32 claimsRoot, bytes32 evidenceHash) = abi.decode(L.data, (bytes32, bytes32));

            // 5. ordering guard, so an older issuance cannot overwrite a newer revocation
            if (blockHeight <= lastAppliedHeight[subject]) continue;
            lastAppliedHeight[subject] = blockHeight;

            _applyMark(subject, attrs, issuer, claimsRoot, evidenceHash);
        }
    }
    // _onRevoked, _onDenied and _onEpoch follow the same five steps
}
```

**Five steps every handler performs.** Miss one and there is a hole.

| # | Check | If missing |
|---|---|---|
| 1 | `chainKey == expectedChainKey` | A proof from a same-address contract on another chain passes (doc 05 section 1) |
| 2 | `receiptStatus == 1` | A failed transaction is applied as if it succeeded |
| 3 | Walk every log | Only the first entry of a batch lands |
| 4 | `log.address_ == sourceContract` | Anyone can emit a forged event and have it accepted |
| 5 | `blockHeight > lastAppliedHeight` | Resubmitting an old issuance revives a revoked mark (doc 05 section 3) |

---

## 6. Source contract interface, on Sepolia

```solidity
contract ComplianceSource is Ownable {
    // C1: each function emits one kind of event
    function issue(address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash) external onlyIssuer;
    function issueBatch(Issuance[] calldata items) external onlyIssuer;      // C2 batching
    function revoke(address subject, uint16 reasonCode) external onlyIssuer;
    function revokeBatch(address[] calldata subjects, uint16[] calldata reasons) external onlyIssuer;
    function deny(address subject, uint32 listVersion) external onlyIssuer;
    function publishEpoch(bytes32 root, uint32 listVersion, uint40 validUntil) external onlyEpochKey;
}
```

> No convenience function calls `issue` and `publishEpoch` in one transaction. That violates C1.
> Epoch publication is always its own transaction.

---

## 7. Open decisions

| # | Item | Options | Due |
|---|---|---|---|
| E1 | `regime` numbering | own uint16 enum, or something ISO-derived | D-12 |
| E2 | `jurisdiction`: issuance only, or issuance plus residence | carrying both needs the reserved 64 bits | D-12 |
| E3 | Maximum batch size against the gas limit | needs a measurement of walking N logs | D-11 |
| E4 | Whether `issuer` needs to be indexed | dropping it frees a slot for `claimsRoot` | D-12 |
| E5 | Governance path for an epoch rollback | `03-product-plan.md` section 6.4 | D-7 |

---

## 8. Implementation status: the schema is verified by code

The contracts follow this schema and the local harness verifies them.

| File | Contents |
|---|---|
| `src/lib/ProofmarkTypes.sol` | `Action`, `MarkStatus`, the `Methods` bitmap, `RevokeReason`, `Mark`, `Policy` |
| `src/lib/MarkAttrs.sol` | Section 2 packing and unpacking, 256 fuzz runs round trip |
| `src/lib/VerifierInterface.sol` | BlockProver precompile interface |
| `src/ASCBaseX.sol` | `ASCBase` fork exposing `chainKey` and `blockHeight` |
| `src/ComplianceSource.sol` | Section 6, four events and three batch functions |
| `src/ProofmarkASC.sol` | Section 5, all five checks |
| `test/mocks/MockBlockProver.sol` | Mock precompile injected with `vm.etch` |
| `test/ReceiptFixture.sol` | Synthetic `encodedTransaction` builder |
| `test/ProofmarkASC.t.sol` | 14 tests, all passing |

The real `encodedTransaction` layout, read off the decoder source:
```
abi.encode(uint8 txType, bytes[] chunks)          // chunks.length == 3 (type 0~2) / 4 (type 3~4)
chunks[last] = abi.encode(uint8 status, uint64 gasUsed, LogEntryTuple[] logs, bytes bloom)
LogEntryTuple = (address address_, bytes32[] topics, bytes data)
```
It is ABI encoding rather than RLP, which is what makes synthetic fixtures possible. The whole path can be tested without the eight-minute attestation wait.

```sh
forge test    # 14 passed
```

### Guarding against a signature typo
`test_EventSignatureConstantsAreCorrect` compares all four hardcoded constants against a real `keccak256`. One typo costs eight minutes on chain, so this is a CI gate.

---

## 9. Freeze checklist

1. ~~Hardcode the `keccak256` signature constants~~ done, pinned by a test
2. ~~Mirror section 3 into the `ComplianceSource.sol` comments~~ done
3. Fold in the measured end-to-end gas for E3, the maximum batch size
4. Decide E1, E2 and E4

Computed 2026-08-30 with `cast keccak`. Recompute whenever a signature changes.

```solidity
// MarkIssued(address,bytes32,address,bytes32,bytes32)
bytes32 constant SIG_ISSUED  = 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3;
// MarkRevoked(address,uint16,uint32)
bytes32 constant SIG_REVOKED = 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09;
// SanctionDenied(address,uint32,uint32)
bytes32 constant SIG_DENIED  = 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae;
// RosterEpochPublished(uint32,bytes32,uint32,uint40)
bytes32 constant SIG_EPOCH   = 0x984d6a4d0b5705f143158aad863f7a4f77abd36d272098cda48adbcbd40b0dc3;
```

Recompute:
```sh
cast keccak "MarkIssued(address,bytes32,address,bytes32,bytes32)"
cast keccak "MarkRevoked(address,uint16,uint32)"
cast keccak "SanctionDenied(address,uint32,uint32)"
cast keccak "RosterEpochPublished(uint32,bytes32,uint32,uint40)"
```
