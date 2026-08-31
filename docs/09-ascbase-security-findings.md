# ASCBase security findings: the handler never sees `chainKey` or `blockHeight`

> 2026-09-01 · Tech Lead
> Subject: the Attestcoin Protocol base contract every ASC inherits, `ASCBase`, as vendored in `reference/attestcoin-protocol-examples/contracts/sol/ASCBase.sol`
> Mitigated in: [`src/ASCBaseX.sol`](../src/ASCBaseX.sol) (the fork) and [`src/ProofmarkASC.sol`](../src/ProofmarkASC.sol) (the handler)
> Pinned by: `test/ProofmarkASC.t.sol` · `test_RejectsProofFromWrongChain`, `test_StaleIssueCannotResurrectRevokedMark`
> First written up in [`05-asc-integration-review.md`](05-asc-integration-review.md) sections 1 and 2, restated here as a standalone report
>
> Offered to the Creditcoin and Attestcoin team as a contribution. Nothing here is unpublished: both findings have been in this repository since 2026-08, and both are already fixed on our side. The pattern is sound — these are two parameters that stop one function short of the handler.

---

## Summary

| # | Finding | Class | Severity | Why that severity | Status |
|---|---|---|---|---|---|
| **1** | `execute()` receives `chainKey`, verifies against it, and does not pass it to `_processAndEmitEvent`. A handler cannot pin the source chain | source authentication | high | The proof stays valid; only the *origin* is unconstrained. On a hub serving several source chains at once, the emitter-address check that every example ASC relies on is no longer sufficient by itself | Mitigated in `ASCBaseX`. Upstream `ASCBase` narrow signature unchanged in the copy we integrate against, as of 2026-09-01 |
| **2** | `execute()` receives `blockHeight` and does not pass it either. A handler cannot order what it applies | state integrity | high | Submission is permissionless and unordered by design, and the built-in replay guard is keyed per query, so it does not fire on two genuinely different proofs about the same subject | Mitigated in `ASCBaseX` + `lastAppliedHeight` cursor. Upstream unchanged as of 2026-09-01 |

Severity for both is carried over from the integration review that produced them; no score beyond that is claimed. Both concern the inheritance pattern in `ASCBase`, not the BlockProver precompile, the proof format, or any deployed third-party ASC.

The upstream signature, and the one line where the parameters are dropped:

```solidity
// ASCBase.sol:18 — the only extension point a derived contract implements
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;
//                            no chainKey       no blockHeight

// ASCBase.sol:43 — execute() has both in scope here and forwards neither
_processAndEmitEvent(action, queryId, encodedTransaction);
```

```sh
$ grep -n "chainKey" reference/attestcoin-protocol-examples/contracts/sol/ASCLoanManager.sol \
                     reference/attestcoin-protocol-examples/contracts/sol/ASCMinter.sol
# no matches. Neither example ASC checks the source chain, because neither can.
```

---

## Finding 1 — a same-address contract on a second source chain passes as the trusted emitter

### Precondition

Three things, all ordinary:

1. The hub verifies proofs from more than one source chain at the same time. CC3 Testnet does: reading the supported list off the ChainInfo precompile (`script/check_chains.ts`) returns chainKey 1 = Ethereum Sepolia (chainId 11155111) and chainKey 3 = Ethereum mainnet (chainId 1).
2. The ASC authenticates events the way the examples do — `log.address_ == sourceContract`.
3. The same address is reachable by someone else on the other source chain. `CREATE2` makes that cheap: through a shared factory such as Foundry's default at `0x4e59...4956C`, the address depends only on factory, salt and bytecode, so deploying the same bytecode on the other chain first hands the attacker that address. Cross-chain address parity is a deployment convention, not an exotic setup — Proofmark's own contracts show how naturally it happens: `ProofmarkASC` on CC3 and `ComplianceSource` on Sepolia sit at the same address, `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629`, purely because one deployer used the same nonce twice (README section 4).

### Mechanism

`execute(action, chainKey, blockHeight, ...)` uses `chainKey` for `VERIFIER.verifyAndEmit` and then drops it. The handler is handed only `action`, `queryId` and the encoded transaction. So a proof of a real event on chain B, emitted from the address the ASC trusts on chain A, is indistinguishable inside the handler from the event it was waiting for: the inclusion proof is genuine, the receipt status is 1, the event signature matches, and `log.address_` matches. Nothing left in scope carries the chain identity.

### Consequence

Whatever the ASC's events authorise, the second chain also authorises. For a compliance registry that means an attacker-authored `MarkIssued` materialises a mark; for the loan-manager example it would mean loan state moving on a foreign chain's say-so. The trust anchor silently widens from "one contract on one chain" to "that address on any chain the hub attests".

### Fix

Widen the handler signature so `chainKey` survives, then pin it on the first line. In `ProofmarkASC._processAndEmitEvent`:

```solidity
if (chainKey != expectedChainKey) revert UnexpectedChainKey(chainKey, expectedChainKey);
```

`expectedChainKey` is set once by `configureSource(chainKey_, sourceContract_)`, and no proof is accepted before it is set. One comparison; no gas story, no protocol change, and it holds regardless of how either contract was deployed.

### The mutation test that pins it

`test_RejectsProofFromWrongChain` submits a valid proof at chainKey 3 whose log carries the correct emitter address, and requires the revert:

```solidity
vm.expectRevert(abi.encodeWithSelector(ProofmarkASC.UnexpectedChainKey.selector, MAINNET_KEY, SEPOLIA_KEY));
_exec(uint8(Action.MarkIssued), MAINNET_KEY, 100, encTx, 2);
assertEq(asc.getMark(alice).status, uint8(MarkStatus.None));
```

Delete the guard line and the suite reports 44 passed, 1 failed — that one test, `[FAIL: next call did not revert as expected]`, and no other. The test therefore measures the guard rather than the happy path.

---

## Finding 2 — a stale issuance submitted after a revocation brings the dead mark back

### Precondition

Two properties of the pattern, both intentional:

1. `execute()` is `external` with no access control. Anyone may submit any valid proof at any time, which is a feature — a third party can push state forward when the issuer will not.
2. Nothing constrains *when*. A proof of an old block stays valid forever, so submission order is chosen by the submitter, not by the source chain.

The handler has no way to notice, because `blockHeight` stops at `execute()`.

### Mechanism

```
Sepolia block 100 : MarkIssued(Alice)
Sepolia block 200 : MarkRevoked(Alice)     sanctions hit

submission order, chosen by the submitter:
  1) the block 200 proof lands. Alice is revoked
  2) the block 100 proof lands. The issuance handler runs again and Alice is ACTIVE
```

Both proofs are genuine, so verification passes twice. The built-in replay guard does not fire: `queryId = keccak256(chainKey, blockHeight, txIndex)`, and the two proofs differ in `blockHeight`, so they are two distinct queries by construction. Replay protection is doing exactly its job; the missing thing is ordering, which is a different property.

### Consequence

Any state transition the events express can be rolled back to an earlier one — a revocation undone, a shortened expiry restored, a downgraded field lifted. It is not limited to the revoke/issue pair; it applies to every field the newest proof was supposed to own.

Proofmark's own fail-closed rules blunt this without closing it: `MarkRevoked` also sets a tombstone, and `isVerified` stops at a tombstone regardless of `status`. But the moment a legitimate path exists to clear a tombstone — false-positive resolution needs one — or a suspended-to-active transition appears, reordering is a live risk again. Depending on a second rule to cover an ordering gap is not a fix.

### Fix

Pass `blockHeight` to the handler and keep a monotonic per-subject cursor. In `ProofmarkASC`, applied identically in the issuance and tombstone handlers:

```solidity
mapping(address => uint64) public lastAppliedHeight;

if (blockHeight <= lastAppliedHeight[subject]) {
    emit StaleProofSkipped(subject, blockHeight, lastAppliedHeight[subject]);
    continue;                      // an older proof never overwrites a newer one
}
lastAppliedHeight[subject] = blockHeight;
```

Skipped rather than reverted, so one stale entry in a batch cannot block the rest, and the skip is observable on chain.

Known residue, stated rather than hidden: `<=` cannot order two events inside a single source block. Proofmark covers that with two rules rather than with contract logic — `ComplianceSource` is written so each function emits one kind of event, which is the C1 rule of one event kind per transaction ([`04-event-schema.md`](04-event-schema.md) section 0), and the issuer serialises off chain so opposing events for one subject never land in the same block. The second is an operating rule, not something the contract enforces. An ASC that cannot make that guarantee upstream would need `txIndex` or `logIndex` as a tiebreaker.

### The mutation test that pins it

`test_StaleIssueCannotResurrectRevokedMark` applies the revocation at block 200, then submits the older issuance from block 100 and asserts the mark stays dead:

```solidity
_exec(uint8(Action.MarkRevoked), SEPOLIA_KEY, 200, revokeTx, 10);
_exec(uint8(Action.MarkIssued),  SEPOLIA_KEY, 100, issueTx,  11);   // valid proof, older block
assertEq(asc.getMark(alice).status, uint8(MarkStatus.Revoked), "stale proof resurrected the mark");
assertTrue(asc.tombstone(alice), "tombstone cleared");
assertEq(asc.lastAppliedHeight(alice), 200);
```

Delete the cursor guard from the issuance handler and the suite reports 44 passed, 1 failed: `[FAIL: stale proof resurrected the mark: 1 != 2]` — status Active where Revoked was required, and again no other test moves.

---

## Suggested upstream remediation

Both findings share one cause and one fix: `execute()` already holds `chainKey` and `blockHeight`, and the handler is the only place that can act on them. Widen the extension point.

```solidity
// before
function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal virtual;

// after
function _processAndEmitEvent(
    uint8   action,
    uint64  chainKey,        // lets the handler pin the source chain, finding 1
    uint64  blockHeight,     // lets the handler order what it applies, finding 2
    bytes32 queryId,
    bytes memory encodedTransaction
) internal virtual;
```

`ASCBaseX` is that change and nothing else, which is the argument for it being safe:

| Kept byte-identical to `ASCBase` | Changed |
|---|---|
| `verifyAndEmit` call and the whole `_verifyProof` path | the `_processAndEmitEvent` declaration, two parameters wider |
| `_computeQueryId`, assembly and 72-byte layout included | the single call site inside `execute()` |
| `processedQueries` replay guard and its `require` ordering | — |
| `execute()`'s external signature, so every existing caller, SDK path and worker is unaffected | — |

Two consequences worth stating plainly. The verification path is untouched, so nothing about proof soundness or replay behaviour is being renegotiated — `test/QueryId.t.sol` fuzzes our `queryId` derivation against the same layout. And because only the internal virtual signature moves, the break is confined to `_processAndEmitEvent` overrides in derived contracts: each needs two parameters added to its declaration, and may then ignore them. Handing the handler information it may discard is strictly more expressive than withholding it; the guards themselves stay the integrator's choice, which is where they belong.

---

## Disclosure note

- **Scope.** The `ASCBase` inheritance pattern as vendored in the protocol examples. No claim is made about the BlockProver precompile, the proof or attestation format, or any third-party ASC deployed by anyone else.
- **Impact.** Testnet integration pattern. No funds are at risk in anything we operate: Proofmark runs on Sepolia and CC3 Testnet, and both findings were fixed before `ProofmarkASC` was deployed, so neither was ever live in our system.
- **Publication.** Written up in this repository since 2026-08 — `docs/05-asc-integration-review.md` sections 1 and 2, `src/ASCBaseX.sol`'s header comment, README section 5 — and reachable by anyone reading the code. This document adds no exploitation detail beyond what those public tests already encode.
- **Intent.** A contribution, not a report card. We hit both of these while integrating, fixed them in a fork, and would rather the fix live upstream than in our copy. The protocol team is welcome to take `src/ASCBaseX.sol` as-is, under the MIT licence it already carries.
- **Contact.** Sharing route not yet decided; the maintainers of this repository are the point of contact.
