# Stable issuer / operating-key rotation — T-12, partial

2026-09-07 KST. Local candidate implementation and synthetic contract/Anvil verification. No public deployment, live role changes, legal issuer certification, customer migration or compromise response was performed. T-12 remains `IN_PROGRESS`.

## What changed

[`RotatingIssuer`](../src/RotatingIssuer.sol) is a new, non-upgradeable issuer contract bound to one immutable `ComplianceSource`. Policies and source `KeyedMarkIssued.issuer` bind to the contract address; a separately controlled operating key submits its calls. This makes a planned operating-key change possible without modifying the trusted issuer in a frozen policy or replacing a new token already bound to that issuer.

This is a stable **technical principal**, not a registry of legal entities. The legal entity, beneficial ownership, authorized recovery administrators, provider rights and contract address must still be established in T-30/T-52/T-53. Existing EOA-bound policies and tokens do not acquire this indirection retroactively.

The recovery owner and initial operating key must differ. The source issuer role must be granted to the contract, not to its operating keys. This contract does not grant itself any source role. Granting the operating EOA a direct source issuer role would create an independent path unaffected by this contract's suspension; deployment review must exclude that path. The real local EVM test checks that both operating EOAs have no such role.

## State and authority

| Transition | Authorized actor | Effect |
|---|---|---|
| deploy | deployment authority | Validates source schema 0 / epoch 2 / roster auth 1 / issuer-key provenance 1; binds source; initial key epoch 1 |
| propose key | recovery owner | Sets a never-used, nonzero key distinct from owner/pending owner; current key remains active |
| accept key | proposed key itself, with exact current epoch | Retires previous operating key, increments epoch, activates new key, clears suspension/proposal |
| cancel proposal | recovery owner | Clears pending key; does not stop current key |
| suspend | recovery owner, nonzero incident reference hash | Immediately clears current/pending key, increments epoch, disables new forwarded writes and signatures |
| declare compromise | recovery owner, approved last-trusted source block and opaque incident hash | Source emits authenticated generation/cutoff evidence and the issuer retires that generation atomically |
| recover after suspension | owner proposes unused key; that key accepts | Activates another epoch. Retired keys cannot be reinstated |
| owner change | current owner proposes; next owner accepts | Two-step transfer; clears outstanding key proposal on acceptance. Current/retired operating keys cannot become recovery owner |

Ownership renunciation is disabled to avoid intentionally removing the recovery path. No multisig threshold or timelock is implemented by this contract. The owner may be a suitable separately approved multisig, but no such deployment/approval is assumed. An owner compromise can still authorize a malicious new key. Initial operating-key possession is a deployment precondition; the constructor itself does not perform a challenge.

There is no arbitrary target/call/delegatecall forwarding. The current key may call typed `issueOnce`, `revoke` and `deny` wrappers for the fixed source. Every wrapper carries `expectedEpoch`, rejecting stale call data after an epoch transition. The source's original request ID guard remains authoritative across key changes. Batch forwarding, session keys and gas sponsorship are not implemented.

These wrappers do **not** repair the source's global subject slot and cross-issuer revoke/deny authority (T-06). They preserve the authority already assigned to this source issuer; multi-institution isolation must be solved separately before using this as a general multi-issuer service.

## Root approvals

The existing source ERC-1271 path calls this issuer's read-only signature validator. Contract signature validity may depend on the contract's current authorization state; the standard does not make signatures permanently valid. [ERC-1271 specification](https://eips.ethereum.org/EIPS/eip-1271)

The operating key signs an inner EIP-712 message:

```text
domain: name ProofmarkIssuer, version 1, source-chain chainId,
        verifyingContract = stable issuer contract address
IssuerApproval(bytes32 sourceDigest,uint64 keyEpoch)
signature envelope: uint64 big-endian epoch || 65-byte low-s ECDSA (r,s,v)
```

`sourceDigest` must be the exact outer `ProofmarkRoster` approval digest, which binds source contract/chain, publisher, epoch/root/list version/cutoff/validity/snapshot. The issuer wrapper validates the signed digest and epoch, not the semantic meaning of arbitrary digests presented directly to ERC-1271. The issuer signing workflow must obtain and review the correct source digest; generic wallet signing is not a provider conformance check.

The validator requires current source issuer membership, an active key, exact 73-byte envelope/current epoch and a valid ECDSA recovery. Wrong epoch/key/domain/digest or malformed signatures fail. A completed rotation invalidates unused approvals by the retired key. A suspension also invalidates them, and source role regrant alone cannot undo that suspension. Operational signing currently uses an ECDSA key, not a nested ERC-1271 signer.

[`pipeline/issuer-key.ts`](../pipeline/issuer-key.ts) creates the inner typed data, encodes the signature for the existing `EPOCH_APPROVALS_FILE` envelope, encodes `issueOnce` call data and validates compromise-cutoff calldata. It does not load a key or authorize the governance input. `RotatingIssuerEvmTransport` now uses the existing durable issuance journal while pinning stable issuer, public operating key and exact epoch; it verifies source/ASC bindings, requires the role only on the stable contract, signs the wrapper call, validates the keyed source event and checks materialized cutoff usability. The web route and recovery runner select it only when `ROTATING_ISSUER_ADDRESS` and `ISSUER_KEY_EPOCH` are both explicit.

## Important limits verified by counterexample

**A source role toggle alone is not key retirement.** With the same active key epoch, `setIssuer(contract,false)` makes an unused signature fail, but a later `setIssuer(contract,true)` makes that signature valid again. The test deliberately preserves this counterexample. Retire the operating key with the issuer suspension/rotation protocol; do not describe a temporary source role removal as signature destruction.

**Plain suspension is not retroactive hub invalidation.** A previously published/relayed root approval is historical source evidence. Neither the hub ASC nor Registry calls this source-chain contract when consuming it. `suspend(reasonHash)` therefore stops future source calls/signatures but deliberately supplies no historical judgment.

**Declared compromise is propagated historical invalidation.** Source/ASC/Registry now expose `ISSUER_KEY_PROVENANCE_VERSION() == 1`. `KeyedMarkIssued` binds direct evidence to a nonzero issuer generation; keyed roster authorization binds a root approval to that generation and its proved source height. `declareCompromise` emits the recovery owner's chosen `lastTrustedBlock` from the trusted source and retires the key in the same transaction. Once the worker relays action 4, Registry rejects direct marks and roster approvals from that generation whose proved source height is later than the tightest cutoff. Earlier direct marks retain their approved treatment. A new key alone cannot forgive rejected history. Cold source replay also excludes post-cutoff keyed issuances before building a new roster.

The cutoff is a governance input, not a fact the contract can discover. It must be derived from authoritative incident evidence and approved by the designated customer/legal authority. Legacy `MarkIssued`/EOA evidence has implicit generation zero and cannot be retroactively classified by this mechanism; migrating that history remains a separate decision.

Neither suspension nor rotation clears a subject's permanent denial. The tests relay denial, rotate, relay a new issue, and retain denial. Correcting a mistaken denial requires the separate governed T-13 workflow. A new key cannot silently forgive it.

## Planned-key-change rehearsal actually executed

Foundry uses real deployed local source/issuer/ASC/Registry/token code with the mock native proof verifier. The test forwards issuance with key A and checks that the emitted/materialized issuer is the stable contract. It publishes an actually source-validated ERC-1271 root, caches inclusion witnesses, freezes an issuer-specific policy and mints 100 synthetic token units to Alice.

After owner proposal and key B acceptance, A cannot issue, A's unused next-root approval fails, B issues with the same contract issuer, and B approves the next root. The policy remains frozen with its original trusted issuer. Alice transfers 40 to Bob, Bob burns 10, and balances are 60/30 with supply 90. This proves continuity for a **planned operating-key change on new contracts**. Burning a synthetic note does not prove fiat redemption, legal discharge or an issuer business exit. Retaining prior marks in this planned test assumes no compromise; it is not an approved compromised-history policy.

The extended local Anvil issuance integration independently signs the nested typed data using ethers, compares its digest to compiled Solidity, rejects the retired signature at actual source publication, accepts the new one, and runs the journal-compatible stable transport through prepare/broadcast/receipt/materialization. It verifies the actual `KeyedMarkIssued` issuer/epoch and idempotency. Both EOAs lack direct source issuer roles. Anvil is isolated on localhost and only synthetic keys/claims are used. Its hub fixture is synthetic, so this does not establish real Attestcoin cross-chain behavior.

The compromise rehearsal creates generation-1 direct marks on both sides of a source-block cutoff and a post-cutoff generation-1 roster approval. Before action 4 all are usable. After the declaration is relayed, the pre-cutoff direct mark remains usable while the post-cutoff direct mark and roster witness fail. A holder minted under the frozen roster policy cannot burn during the gap. Recovery key B reissues/re-screens that holder, signs a fresh one-holder root, and the same still-frozen policy permits a burn. This is a synthetic availability/exit exercise, not fiat redemption or legal discharge.

## Incident / old-asset migration runbook — local mechanics rehearsed, external procedure not executed

1. Establish the exact chain/source/issuer/key generation and incident interval from authoritative receipts and signing logs. Record an opaque incident hash without publishing PII. Get the designated recovery authority and customer incident permissions; no approval is assumed here.
2. The authorized recovery owner suspends the stable issuer. Reconcile any pending source transaction, prepared signed issuance and queued root approval. Transactions already included before suspension are not undone; a proposal alone is not emergency containment. Remove any separately granted direct source roles under their own source-owner authority.
3. Enumerate already accepted credentials/roots/witnesses and affected consumers. Do not report them blocked merely because the source signature now fails. Use approved consumer pause/restriction and relayed revocation procedures where available. Existing immutable `GatedRwaNote` has no general pause switch, and relying only on natural expiry may exceed the customer's risk tolerance; this is an unresolved pilot gate, not a completed incident mechanism.
4. Obtain the approved compromised-history cutoff and correction procedure, preserve permanent denials, review original evidence and re-screen affected users before new roots. Do not republish the old compromised roster solely to restore service. The local provenance/cutoff mechanism enforces the supplied source-block boundary, but choosing it and applying it to legacy generation-zero evidence still requires T-06/T-07/T-13/T-18 coordination and independent review.
5. For existing EOA-bound frozen policies or a changed source/Registry/legal issuer, create an explicitly approved successor policy/asset path. Inventory balances, encumbrances, eligibility, tombstones, redemption entitlement and settlement evidence. A new deployment alone is not asset migration. The T-13 delayed dual-control mechanism still requires legal authority, settlement evidence and a verified successor destination; historical owner-controlled tokens do not inherit it.
6. Rehearse a restricted holder's safe exit/redemption and restart recovery before external use. Keep the original policy frozen; do not silently weaken it or change trust under the same address. [Migration runbook](19-security-migration.md) and [maintenance/issuer-exit conditions](36-supply-chain-maintenance.md) remain applicable.

## Verification and remaining conditions

Eight Solidity tests cover planned rotation/real source logs/holder continuity; exact pre/post-cutoff direct and roster treatment plus recovery/reissue/burn; exact epoch/idempotency/reuse; malformed and wrong-domain signatures; source-role revival; recovery authority and owner transfer; permanent denial and revoke; deployment/proposal guards. TypeScript tests cover typed encoding, cutoff calldata, cold source replay, worker action/preflight, consumer diagnostics and compiled ABI boundaries. The Anvil issuance test runs the real stable-issuer/source transport path and still counts as one integration test.

```sh
forge test --match-contract RotatingIssuerTest -vv
npx tsx --test pipeline/issuer-key.test.ts test/issuer-key-abi.test.ts
npm run test:issuance-evm
npm run test:cross-chain-gate
npm run test:relay-evm
npm run test:epoch-publication
npm run test:issuance-e2e
npm run test:all
npm run typecheck
forge fmt --check
git diff --check
```

Remaining T-12 completion requirements: explicit legal issuer/key identity mapping; customer-approved cutoff selection and legacy generation-zero treatment; production KMS/multisig/recovery governance; actual proof-service/public cross-chain propagation limits; existing EOA-bound frozen policy and real asset migration; restricted-holder legal redemption; and a customer-approved incident/issuer-exit drill. No public key, role, policy, token balance or deployment changed in this work.
