# Proofmark: a cross-chain KYC and AML attestation layer

> 2026-08-30 · Tech Lead / PO · For [BUIDL CTC 2026 Fall](00-hackathon-brief.md)
> Prerequisites: [`00-hackathon-brief.md`](00-hackathon-brief.md), [`01-env-verification.md`](01-env-verification.md)
> Prior team work: an EAS-based compliance layer on GIWA. Knowledge carried over, code did not (section 11, R4).
>
> **Status:** the canonical document for product, architecture and scope. When research changes, fix the mapping in section 13 first and let section 9 follow.
> Notation: measurements stand as written; estimates are marked `estimate`; unverified assumptions are marked `assumed`.

---

## 1. In one paragraph

An international KYC and AML attestation layer. It issues, on Ethereum and in machine-readable form, which country verified an identity and by what method; Creditcoin verifies that issuance mathematically with no oracle operator in between; any chain can read the result. Not one byte of personal data goes on chain. What remains is a **mark** saying the wallet completed KYC, and a **proof** that the mark was really issued.

One design proposition decides whether this works across borders:

> "KYC complete" does not carry a fixed meaning across borders. So the mark carries the checks that were performed rather than a verdict, and each consumer decides equivalence under its own jurisdiction's policy.

The first jurisdiction adapter is Korea: ID document verification, then bank account verification through a one-won transfer. That pairing satisfies the two-check requirement in the FSC's non-face-to-face identification guidance, and the same interface takes any other jurisdiction's adapter.

| Item | Value |
|---|---|
| Product name | **Proofmark**. Repository and technical name `attest-kyc` |
| One line | Verify once, carry the result by proof, check it on any chain |
| Tagline | Prove your compliance once. Carry it to every chain. |
| Track | **RWA**, section 12 |
| Source chain | Ethereum Sepolia, chainKey `1`. Confirmed at runtime, and not the same as chainId 11155111 |
| Verification hub | Creditcoin CC3 Testnet, chainId 102031, through the ASC and BlockProver |
| Attestcoin axis | Readability. Writability is roadmap |
| On-chain personal data | zero bytes |
| First jurisdiction | KR: ID document plus bank account |

---

## 2. The problem splits twice: once per chain, once per border

### 2.1 Rebuilt on every chain

| Option today | What breaks |
|---|---|
| Build KYC again on each chain | Vendor minimums, months of integration and data-controller obligations all multiply by the number of chains. The user uploads the same document N times |
| A central server signs "verified" | One key becomes the whole security model, and there is no good answer to a regulator asking why that signature should be believed |
| A bridge or relayer mirrors the state | Trusting the relayer becomes trusting the compliance. The trust moved rather than disappeared |

### 2.2 Every country means something different by it

The same label points at different work depending on where you are.

| Jurisdiction | What it requires |
|---|---|
| Korea | Non-face-to-face identification: at least two of document image, video call, verification on delivery of an access device, or use of an existing account, plus CDD under the FIU act |
| EU | AMLD customer due diligence plus an eIDAS assurance level, low, substantial or high `assumed` |
| US | CIP: collect and verify name, date of birth, address and an identification number |
| FATF, everywhere | R.10 CDD and EDD, R.16 travel rule |

Put a single boolean on chain and it stops being useful the moment it crosses a border. It satisfies a Korean dApp and gives an EU-regulated one nothing to stand on, and the reverse holds too. That is why on-chain identity projects have stayed local.

### 2.3 Our answer

Carry the evidence, not the conclusion. The mark holds `methods`, a bitmap of the checks performed, `regime`, the framework they ran under, `jurisdiction`, and `assurance`, the issuer's own grade. The consumer applies its policy and decides. We never claim Korean KYC equals EU KYC. We publish what was done, in a form a contract can read.

That buys two things at once: portability across regimes, and legal safety, because no equivalence is asserted.

---

## 3. What gets built

### 3.1 Three nouns

| Name | Definition | Where it lives |
|---|---|---|
| **Mark** | Which jurisdiction verified what, by which method, and until when. This is everything the public sees | Ethereum as origin, Creditcoin as the verified record |
| **Proof** | Three layers: an evidence proof binding the offline screening to the on-chain mark, the Attestcoin cross-chain proof, and optional selective disclosure | hashes, Attestcoin, the user's browser |
| **Roster** | The full set of valid state at an epoch, expressed as one root | published on Ethereum, verified on Creditcoin |

### 3.2 The user journey, Korean path

```
0. connect wallet, sign ownership (EIP-4361, 10 min TTL, binding address, consent version and claimsRoot)
1. [ID document]  capture, OCR, authenticity lookup with the issuing authority (face match and liveness once a face vendor is connected)
2. [bank account] one-won transfer, account holder name compared with the document name
                  this pair satisfies the FSC two-check requirement
3. [reconcile]    declared details, document, account holder. All three must agree
4. [AML]          sanctions lists, jurisdiction, on-chain exposure, risk band, which sets expiry
5. [commitment]   the browser salts each claim and computes claimsRoot.
                  32 bytes reach the server. The originals stay in the issuer's vault
6. [issue]        Sepolia ComplianceSource.issue(...), emitting the mark event
7. [cross-chain]  wait for attestation, about 8 min, fetch the proof, the ASC verifies
8. [use]          any dApp on any chain calls isVerified(wallet, policy)
```

Step 3 is the heart of it. Declared details, document and account holder are reconciled, and only the fact that they agreed reaches the chain as a proof and a mark.

### 3.3 The privacy boundary, which does not move

| Who | Sees |
|---|---|
| Anyone, on chain | wallet, kind, assurance, the methods bitmap, regime, jurisdiction, expiry, issuer, epoch, claimsRoot, evidenceHash, and the proof it was issued on Ethereum |
| A dApp | `isVerified(W, policy)` returning a bool, and nothing else |
| The user | their own credential, held locally, with selective disclosure available |
| An auditor or regulator, under contract or warrant | the issuer's full offline evidence, checkable against the on-chain `evidenceHash` |
| Nobody | reverses personal data out of the chain. Salted commitments make it structurally impossible |

---

## 4. The method system, which is what makes it portable

### 4.1 The methods bitmap

```solidity
// identity checks: what was done
uint32 constant M_WALLET_CONTROL      = 1 << 0;  // wallet ownership signature
uint32 constant M_ID_DOC_IMAGE        = 1 << 1;  // document image submitted
uint32 constant M_ID_DOC_AUTHENTICITY = 1 << 2;  // authenticity checked with the issuer
uint32 constant M_FACE_MATCH          = 1 << 3;  // face compared to the document photo
uint32 constant M_LIVENESS            = 1 << 4;  // liveness
uint32 constant M_BANK_ACCOUNT        = 1 << 5;  // account holder name, via a one-won transfer
uint32 constant M_MOBILE_CARRIER      = 1 << 6;  // mobile carrier identification
uint32 constant M_VIDEO_CALL          = 1 << 7;  // video call
uint32 constant M_IN_PERSON           = 1 << 8;  // in person
uint32 constant M_EPASSPORT_NFC       = 1 << 9;  // ePassport chip read, issuer signature verified
uint32 constant M_GOV_EID             = 1 << 10; // government eID such as eIDAS
// screening: what was filtered
uint32 constant M_SANCTIONS_SCREENED  = 1 << 16;
uint32 constant M_PEP_SCREENED        = 1 << 17;
uint32 constant M_ADVERSE_MEDIA       = 1 << 18;
uint32 constant M_JURISDICTION_CHECK  = 1 << 19;
uint32 constant M_ONCHAIN_EXPOSURE    = 1 << 20;
```

**Why a bitmap.** A single grade does not cross a border; a list of checks does. An EU dApp can look at a Korean mark, see document authenticity, account verification and liveness, and decide for itself that this meets substantial under its own rules.

### 4.2 The Korean adapter

| Step | Check | FSC guidance | Bits set |
|---|---|---|---|
| 0 | Wallet ownership signature | not a regulatory requirement, ours | `WALLET_CONTROL` |
| 1 | ID document | method 1, document image | `ID_DOC_IMAGE` `ID_DOC_AUTHENTICITY` (`FACE_MATCH` `LIVENESS` when a face vendor is added) |
| 2 | Bank account, one-won transfer | method 4, use of an existing account | `BANK_ACCOUNT` |
| 3 | AML screening | CDD under the FIU act | `SANCTIONS_SCREENED` `JURISDICTION_CHECK` `ONCHAIN_EXPOSURE` |

Methods 1 and 4 together satisfy the two-check requirement. The mark records that pairing as `regime = KR_FSC_NONFACE`.

**How each check is actually performed** (`pipeline/adapters/`, wired into the web flow at `/verify`):

| Check | Vendor and product | What runs |
|---|---|---|
| Document fields | CODEF resident registration card OCR / driver-licence OCR (`/v1/kr/etc/a/kyc/registration-card`, `/drivers-license`) | The photo is read so the customer does not type; every field is confirmed against the card |
| Document authenticity, resident registration card | CODEF resident registration authenticity through Government24 (`/v1/kr/public/mw/identity-card/check-status`) | The issuer logs in with its own joint certificate and asks Government24 whether the name, resident number, and issue date identify a genuine card. `resAuthenticity = "1"` sets the bit; anything else stops issuance |
| Document authenticity, driver licence | CODEF driver-licence authenticity through the Korean National Police Agency's Traffic Civil Service 24 (`/v1/kr/public/ef/driver-license/status`) | Same login; licence number and the anti-forgery serial are checked. `"2"` (number exists, serial did not verify) is a rejection |
| Account holder | KFTC Open Banking real-name inquiry (`/v2.0/inquiry/real_name`), or CODEF account-holder authentication (`/v1/kr/bank/a/account/holder-authentication`) | The bank returns the holder for the account and the customer's real-name number; it must equal the name on the document |
| Account control | KFTC Open Banking deposit transfer (`/v2.0/transfer/deposit/acnt_num`), or CODEF account authentication by one-won transfer (`/v1/kr/bank/a/account/transfer-authentication`) | One won is deposited with a code as the sender; the customer types the code back. The code never reaches the browser, only a keyed digest inside a sealed challenge |

The additional-authentication legs the institutions impose (a captcha on a corporate-certificate login, an app approval) are carried through the same endpoint with `is2Way` and surfaced to the operator in the flow.

> **What "live" means.** CODEF's demo tier reaches the real Government24 and Traffic Civil Service 24 with a daily allowance; its sandbox answers from fixed sample data, and its bank products return random test data anywhere but production. The KFTC testbed runs the real API against canned data and moves no money. Each vendor result therefore carries `live`, and by default a bit is set only from a live result. Production for the bank axis needs participating-institution registration with KFTC or the CODEF partnership contract; production for the document axis needs either the issuer's certificate or an operator approving each lookup through app-based authentication (KakaoTalk, PASS, and others), which needs nothing but a CODEF demo key. None of the commercial side is code, and the code does not pretend otherwise.

> **Demo mode** (`KYC_DEMO=1`, `web/lib/kyc-server.ts`). An axis without a real vendor gets `pipeline/adapters/demo.ts`: same interface, same inputs, same tokens and reconciliation, no institution asked. The page announces it, the evidence names `demo:*`, and the mark carries `regime = KR_FSC_NONFACE_SANDBOX`. Under demo the adapter's `sandboxBits` switch sets the bits from non-live results so the flow ends with a mark that passes policy #1; the on-chain policy does not read `regime` yet (P1, section 9.1), which is the one place a sandbox mark and a production mark look alike, and the reason the switch defaults to off outside demo. Real and demo mix per axis, so a CODEF demo key gives a real document check next to a demo account. Sign-up steps, wire formats and the environment reference: [`07-kyc-vendors.md`](07-kyc-vendors.md).

### 4.3 Other jurisdictions, on the roadmap

| Jurisdiction | Adapter | Priority | Note |
|---|---|---|---|
| **KR** | document authenticity plus one-won transfer | first, this competition | the only jurisdiction the team has operated in |
| **Global** | ePassport NFC, ICAO 9303 | second | The chip data is signed by the issuing country's CSCA, so it verifies offline with no vendor and no jurisdiction dependency. It is the strongest check we can build without a partnership |
| EU | eIDAS nodes, bank ID such as iDIN or itsme | third | |
| US | CIP, matching SSN or ITIN | third | |
| JP, SG, others | case by case | fourth | |

### 4.4 Consumer policies, registered by the dApp

```solidity
struct Policy {
    uint32   requireAll;    // every one of these bits must be present
    uint32   requireAny;    // at least one of these
    uint8    minAssurance;
    uint40   maxAge;        // freshness ceiling
    uint16[] allowedRegimes;
    uint16[] deniedJurisdictions;   // FATF high-risk jurisdictions and the like
}
```

- A Korean VASP: `requireAll = ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED`
- An EU RWA issuer: `requireAll = LIVENESS | SANCTIONS_SCREENED | PEP_SCREENED`, `requireAny = EPASSPORT_NFC | GOV_EID`
- A game: `requireAll = SANCTIONS_SCREENED` and nothing more

P0 implements `requireAll` and `maxAge`. The rest is P1.

### 4.5 AML lists, international from the start

| List | Jurisdiction | Status |
|---|---|---|
| OFAC SDN | US | loaded |
| UN Consolidated | UN | loaded |
| EU FSF | EU | loaded |
| UK HMT / OFSI | UK | planned |
| FSC designated list | KR | no machine-readable distribution, manual loading under review |
| PEP and adverse media | commercial | roadmap, needs a data agreement |

Pipeline knowledge from the earlier project carried over: normalisation rules, the Hangul romanisation path, and how to score without wrecking specificity. The code did not.

---

## 5. Architecture

```
┌─ Ethereum Sepolia (chainKey 1, where issuance happens) ───────────┐
│  ComplianceSource.sol        one source contract per dApp         │
│   ├ issue()        → MarkIssued(subject,kind,assurance,methods,   │
│   │                             regime,jurisdiction,expiry,       │
│   │                             claimsRoot,evidenceHash)          │
│   ├ revoke()       → MarkRevoked(subject,reasonCode,epoch)        │
│   ├ deny()         → SanctionDenied(subject,listVersion,epoch)    │
│   └ publishEpoch() → RosterEpochPublished(epoch,root,listVersion, │
│                                           validUntil)             │
└──────────────────────────────┬────────────────────────────────────┘
                               │ (watch)
┌─ Offchain (the issuer) ───────┴────────────────────────────────────┐
│  1 jurisdiction adapter: KR document then account; later NFC, eIDAS│
│  2 reconciliation across declared, document and account holder     │
│  3 AML: load, normalise, match, decide, risk band, expiry          │
│  4 evidence: append-only hash chain, head becomes evidenceHash     │
│  5 epoch builder: sorted-key Merkle tree, publishes the root       │
│  6 worker: wait for attestation, fetch proof, submit to the ASC    │
│  7 rescreening daemon: re-check the active roster, revoke on a hit │
└──────────────────────────────┬────────────────────────────────────┘
                               │ merkleProof + continuityProof
┌─ Creditcoin CC3 (verification hub, the chain of record) ─────────┐
│  ProofmarkASC.sol                                                │
│   ├ synchronous BlockProver verification at 0x…0FD2              │
│   ├ pinned source contract and chainKey, replay guard            │
│   ├ epochRoots[epoch] · latestEpoch · epochValidUntil            │
│   ├ tombstone[subject]  revocation and sanctions, epoch-independent│
│   └ marks[subject]      materialised cache                       │
│  ProofmarkRegistry.sol   isVerified / isDenied / proof mode       │
│  GatedRwaNote.sol        RWA note, movable only between passers   │
└──────────────────────────────┬────────────────────────────────────┘
                               │ checkable against the hub
┌─ Spoke chains (read surface) ─┴────────────────────────────────────┐
│  ProofmarkMirror.sol + @proofmark/sdk + a proof-serving REST API  │
└───────────────────────────────────────────────────────────────────┘
```

### 5.1 Components

| Layer | Component | Responsibility | Scope |
|---|---|---|---|
| L0 | `ComplianceSource.sol` on Sepolia | Issue, revoke, sanction, publish epochs. Purpose-built events only, never a generic `Transfer` | P0 |
| L1 | Jurisdiction adapter, reconciliation, AML, evidence, epoch builder, worker | Where the trust actually lives | P0 |
| L2 | `ASCBaseX.sol`, the `ASCBase` fork | Passes `chainKey` and `blockHeight` to `_processAndEmitEvent`. Verification, queryId and replay protection stay as the original | P0, security |
| L2 | `ProofmarkASC.sol` on CC3 | Proof verification, state machine, ordering cursor | P0 |
| L2 | `ProofmarkRegistry.sol` | The only surface a dApp calls | P0 |
| L3 | `GatedRwaNote.sol` | Makes the removal test visible | P0 |
| L4 | `@proofmark/sdk` and a proof REST API | Integration in half an hour | P1 |
| L5 | `ProofmarkMirror.sol` on a spoke | Substance behind the multichain claim | P1 |
| L6 | Selective disclosure and ZK attribute proofs | Age, residence and similar | P2 |

### 5.2 Two application modes

> **The premise changed twice, and measurement settled it.** The faucet gave 10,000 CTC rather than the README's 100. A query costs 0.0002 CTC in gas alone, 394,982 gas at 0.5 gwei, not the 11 CTC we had estimated, and the balance change matched the gas exactly, so no separate oracle fee exists. There is no testnet resource constraint.
>
> "We batch because queries are scarce" is therefore withdrawn entirely.

> **Settled: the product sits on the free path.** attestcoin.org states "Reading other chains stays free. Every time an app sends action across chains, it pays in ATC." Everything we do is readability, and the measurement agrees. The claim in section 14 about creating ATC demand is withdrawn; what costs ATC is writability, still in development. Free reads are not a fact against us. They mean a dApp integrates with no per-query cost, and saying that plainly beats inventing token demand.

**What drives batching is Ethereum L1, not Creditcoin.** The CC3 submission costs 0.0002 CTC and can be ignored. Issuance itself is an L1 transaction, and a hundred thousand users means a hundred thousand of them, with the issuer paying that gas in any market. An epoch root fixes L1 writes independently of user count: one transaction per epoch whether it covers one subject or a hundred thousand.

Operations point the same way. Every submission carries an eight to ten minute attestation wait and its retries, so a design whose latency and operational load scale with user count does not become a product.

> This argument rests on measurement rather than an unverified assumption, so it survives whatever the ATC question turns out to be.

| | Mode A, individual proof | Mode B, epoch roster |
|---|---|---|
| What is proven | one `MarkIssued` event | one `RosterEpochPublished` root |
| Cross-chain writes | one per user | one per epoch, regardless of user count |
| At 100,000 users | 100,000 L1 issuance transactions plus 100,000 CC3 submissions | one L1 transaction per epoch, eight a day, plus eight on CC3 |
| Expressing revocation | needs its own event | falling out of the root is the whole mechanism |
| Latency | finality plus attestation, about 8 min | epoch interval plus about 8 min |
| Used for | urgent revocation, and a fresh mark usable immediately | the normal operating path |

> The answer to "why batch" is cost, not taste. The design comes from reading how the protocol charges, and it fixes cost independently of user count. That is the strongest evidence of integration depth we can offer, because it is a design only someone who has used the protocol arrives at.

**Bursts of revocations go through multiple logs in one transaction, not `verifyBatch`.** Checked against the code: `verifyBatch` exists in the SDK and the precompile but not in `ASCBase`, and `execute()` takes a single proof. Meanwhile `EvmV1Decoder.getLogsByEventSignature()` returns every matching log as an array. The example reading only `logs[0]` is a simplification its own comment admits to.
>
> Put `revokeBatch()` on the source contract, emit N events in one transaction, and because `queryId` is per transaction one `execute()` applies all N. This works without forking `ASCBase`.

---

## 6. Data model

### 6.1 Claim commitments

```
claim_i     = (key, value, salt_i)        // ("dob","1990-01-01",0x…), ("idDocHash",…), ("accountHolder",…)
leaf_i      = keccak256(abi.encode(key, value, salt_i))
claimsRoot  = MerkleRoot(sorted(leaf_1..leaf_n))
evidenceHash= H(prevHash ‖ stepPayload)   // head of the append-only chain, one entry per step
```
The salts stay in the user's browser. Selective disclosure means presenting `(key, value, salt, path)` and checking it against `claimsRoot`.

### 6.2 The on-chain mark

```solidity
struct Mark {
    uint8   status;        // 1 ACTIVE · 2 REVOKED · 3 DENIED · 4 SUSPENDED
    uint8   kind;          // 1 INDIVIDUAL · 2 ENTITY · 3 SANCTION
    uint8   assurance;     // issuer's own grade 1..5, not a claim of equivalence
    uint16  regime;        // which framework the checks ran under, e.g. KR_FSC_NONFACE
    uint16  jurisdiction;  // ISO-3166 numeric, the issuing jurisdiction
    uint32  methods;       // bitmap of checks performed, what makes the mark portable
    uint40  issuedAt;
    uint40  expiry;        // set by risk band, 365 days at band 1 down to 30 at band 5
    uint32  epoch;
    bytes32 claimsRoot;
    bytes32 evidenceHash;
    address issuer;
}
```
No name, no date of birth, no document number, no account number. That does not change.

### 6.3 The roster tree, which has to prove a negative

The hard part is not proving a mark was issued. It is proving it was not revoked and is not on a sanctions list. Membership proofs are easy; non-membership is decided by the data structure.

| Candidate | Non-membership | Depth | Verdict |
|---|---|---|---|
| Plain Merkle | not possible | log n | works only as a whitelist |
| Sorted-key Merkle with adjacency proofs | `leaf_i.key < target < leaf_{i+1}.key` | about 20 at a million entries | chosen: cheap to verify, clear to implement |
| Sparse Merkle | natural, through default leaves | 160 to 256 | verification costs too much gas |

A leaf is `H(subjectKey ‖ markHash)` with `subjectKey = keccak256(chainNamespace ‖ subject)`, CAIP-10 shaped so non-EVM subjects remain possible.
**Fallback.** If time runs short, keep only the whitelist in the root and express revocation and sanctions through tombstone events. The functionality survives; the query cost rises.

### 6.4 Decision rules, fail closed and enforced in the contract

```
isVerified(W, policy) =
      marks[W].status == ACTIVE
  &&  (marks[W].methods & policy.requireAll) == policy.requireAll
  &&  marks[W].assurance >= policy.minAssurance
  &&  marks[W].expiry > block.timestamp
  &&  block.timestamp - marks[W].issuedAt <= policy.maxAge
  &&  tombstone[W] == 0                    // revocation and sanctions always win
  &&  _fresh(W, policy)                      // depends on provenance, see below
```

**Freshness depends on provenance.** Without that split, every mark materialised through Mode A fails the epoch check, because it has no epoch.

```
_fresh(W, policy) =
   marks[W].origin == Roster                    // Mode B, a roster snapshot
     ? marks[W].epoch == latestEpoch && block.timestamp < epochValidUntil
     : !policy.requireRoster                    // Mode A, an individual proof
```

| Provenance | Guarantees | Does not guarantee |
|---|---|---|
| **Direct**, Mode A | The mark was issued at L1 block N, a proven past fact. It does not go stale when we stop publishing | A later revocation that was never submitted cross-chain. Tombstones reflect only what arrived |
| **Roster**, Mode B | The full valid set at that epoch. Whoever is missing has been revoked | Freshness beyond one epoch interval |

Hence `Policy.requireRoster`. A high-risk dApp accepts roster-backed marks only; a low-risk one takes individual proofs. Direct being the weaker guarantee is stated in the policy rather than buried in code.

1. **An expired roster verifies nobody.** Unknown is never a pass.
2. **Deny beats allow.** A tombstone outranks any epoch root.
3. **A stale cache is not a truth.** It has to be re-materialised.
4. **Epochs increase monotonically.** A rollback needs an explicit governance path.

### 6.5 What a dApp integrates against

| Mode | Call | Character |
|---|---|---|
| Cache | `isVerified(W, policyId)` | A storage read. Anyone can fill the cache through `materialize(W, mark, proof)`, so an inattentive issuer never leaves a gate stuck open |
| Proof | `verifyWithProof(W, mark, proof, epoch, policyId)` | Always current, writes no state. For high-value transactions |

---

## 7. The hard parts, and what we did about them

| # | Problem | Approach | What remains |
|---|---|---|---|
| 1 | KYC means different things per jurisdiction | Section 4: carry the `methods` bitmap rather than a verdict, and leave equivalence to the consumer | We guarantee no equivalence, which is the point |
| 2 | Proving a negative | Epoch roster root, section 6.3, plus tombstone priority | The gap inside an epoch interval is covered by the tombstone lane |
| 3 | Propagation delay | Measured attestation lag of 6.5 to 8.8 minutes on top of finality, published as a product parameter rather than hidden | Real-time blocking has to gate on the source chain |
| 4 | Write cost. One write per user does not survive mainnet | Mode B epoch batching, which decouples cost from user count | Application lags by one epoch interval, covered by row 2's tombstone lane |
| 5 | Freshness | Each epoch publishes `validUntil`, and expiry fails closed | If the issuer stops, gates close. That is the safe direction |
| 6 | Trusting a mirror | A spoke root is comparable to the hub's verified root, and anyone can disprove a mismatch | Slashing incentives for disproving are roadmap |
| 7 | Replay | `ASCBase` already blocks it through `queryId = keccak256(chainKey, blockHeight, txIndex)`. We add source address pinning | It only stops resubmitting the same transaction. Rows 13 and 14 are separate problems |
| **13** | chainKey spoofing. The handler cannot tell which chain a proof came from | `ASCBase._processAndEmitEvent(action, queryId, tx)` receives neither `chainKey` nor `blockHeight`. CC3 serves chainKey 1 and 3 at once, so a same-address contract on mainnet can emit an event that passes. CREATE2 makes claiming that address first straightforward | Fork `ASCBase` to widen the signature and `require(chainKey == EXPECTED)`. P0 |
| **14** | Reordering revives a revoked mark | Submission is permissionless and unordered. Send `MarkIssued` from block 100 after `MarkRevoked` from block 200 and the mark returns to ACTIVE. The queryIds differ so replay protection never fires, and both proofs are valid | A `lastAppliedHeight` cursor rejects the older height. It needs `blockHeight` in the handler, so the same fork covers it. P0 |
| 8 | Dusting as griefing, where a sanctioned address sends 1 wei to disable someone's mark | On-chain exposure distinguishes sending from receiving | |
| 9 | Key risk | Separate issuer, epoch and owner keys, with two-step ownership transfer | A stolen issuer key still forges issuances. Comparison against the epoch root detects it |
| 10 | False positives | An appeal path plus a cleared list, so the next rescreening does not revoke the same person again | A human makes the call |
| 11 | Data protection law, PIPA and GDPR | Zero bytes on chain, the consent version bound into the signed message, and erasure carried out in the offline vault. An on-chain commitment means nothing without the original | We are not an identity verification authority. The verification itself is delegated to vendors |
| 12 | Honesty while vendors are unconnected | An unconnected check leaves its bit unset, and consumer policies filter on that automatically | The demo's KR adapter is a mock, and the screen, the docs and the mark all say so |

---

## 8. How other chains read this

Attestcoin's writability is still in development, so we cannot claim Creditcoin pushes state to other chains.

| Role | Chain | Trust basis | Scope |
|---|---|---|---|
| Origin | Ethereum Sepolia | where issuance actually happened | P0 |
| Hub of record | Creditcoin CC3 | mathematical verification by the Attestcoin attester network | P0 |
| Spoke | any EVM chain | a mirror comparable to the hub's verified root, plus a proof-serving API | P1 |
| Push, roadmap | Creditcoin to spoke | Attestcoin writability | P2 |

> For the submission: *"Creditcoin is the chain of record for compliance state. Any chain can read it; only Creditcoin can prove it."*

---

## 9. Scope and schedule

### 9.1 P0 / P1 / P2

| Priority | Item | Definition of done |
|---|---|---|
| P0 | Deploy and verify `ComplianceSource` on Sepolia | Four purpose-built events, tests passing |
| P0 | KR adapter: document authenticity with the issuing authority, one-won account verification, reconciliation, methods recording | CODEF (Government24 / Traffic Civil Service 24 authenticity and OCR) and KFTC Open Banking or CODEF for the account, behind `IdDocumentVendor` / `BankAccountVendor`. A bit is set only from a live vendor answer; the evidence records vendor, reference and whether it was live. No mock anywhere in the flow |
| P0 | AML screening against real OFAC, UN and EU lists | Real BLOCK and ALLOW decisions |
| P0 | Evidence hash chain into `evidenceHash` | Anyone with a copy can recompute and compare |
| P0 | ~~Local mock BlockProver harness~~ | Done. `encodedTransaction` is ABI encoded rather than RLP, so synthetic fixtures are possible. `vm.etch` injects the mock in the precompile's place, and the whole path is testable without the eight-minute wait |
| P0 | Fault-tolerant worker wrapping the SDK wait with retries, backoff and persistence | Kill the process, restart it, and the job still finishes |
| P0 | Worker, `ProofmarkASC` and `Registry` deployed on CC3 | One successful Sepolia to CC3 round trip with public transaction hashes. Done twice |
| P0 | `GatedRwaNote` demo | Unverified reverts, issuance succeeds, revocation blocks again |
| P0 | README as the required technical document, plus a three-minute demo video | A judge reproduces it in five minutes |
| P1 | Epoch roots, Mode B, with sorted-key non-membership proofs | One root applies N subjects |
| P0 | ~~`ASCBase` fork, chainKey pinning, ordering cursor~~ | Done. `ASCBaseX.sol` and `ProofmarkASC.sol`, 14 tests. `test_RejectsProofFromWrongChain` and `test_StaleIssueCannotResurrectRevokedMark` are mutation tested: remove the guard and exactly that test fails |
| P1 | `revokeBatch()`, batching through multiple logs per transaction | Emit N in one transaction, apply all N in one `execute()` |
| P2 | ~~`verifyBatch`~~ | Not supported on the contract side. Revisit whether it is needed |
| P1 | Extended policies: `requireAny`, regime, jurisdiction | Working EU and US policy examples |
| P1 | `@proofmark/sdk` and a proof REST API | An outsider integrates in half an hour |
| P1 | One spoke mirror | A screen comparing it against the hub |
| P2 | ePassport NFC adapter | The next step for other jurisdictions |
| P2 | Selective disclosure and ZK attribute proofs | |
| P2 | Rescreening cron | A manual console run covers it for now |

### 9.2 Schedule, deadline 2026-09-14 12:59 KST

| Window | Goal | Gate |
|---|---|---|
| D-14, 8/30 | Environment verified, 10,000 CC3 CTC and Sepolia ETH received, event schema drafted | Sepolia ETH arrives |
| D-13 to D-12, 8/31 to 9/1 | One real Hello Bridge round trip, read Tutorial 4, freeze the event schema | A successful round trip. A failure here means changing the architecture now |
| D-11 to D-10, 9/2 to 9/3 | Deploy `ComplianceSource`, build the KR adapter, reconciliation and AML screening | The four events freeze. Later changes cost simultaneous edits to worker and ASC |
| D-9 to D-8, 9/4 to 9/5 | Local mock harness, then the `ASCBaseX` fork, then `ProofmarkASC` and `Registry`, then deploy to CC3 | Deploy only after anvil is green. `EvmV1Decoder` has 14 public functions, so a `--libraries` link is mandatory, confirmed by `linkReferences` in the build output. Do not reuse the pre-deployed `0x731c…9F9f`: its runtime is 19,199 chars against our 26,524, so it is not the same contract. A bad link fails quietly and costs an eight-minute cycle |
| D-7 to D-6, 9/6 to 9/7 | Mode B epoch roots, non-membership proofs, the revocation lane | Evening of D-6: decide on the Mode B fallback |
| D-5 to D-4, 9/8 to 9/9 | `GatedRwaNote`, web demo, SDK, spoke mirror | Run the revoke-then-block scenario on chain |
| D-3 to D-2, 9/10 to 9/11 | README, technical documentation, more tests, tidy addresses and transactions | One reproduction rehearsal by someone outside the team |
| D-1, 9/12 | Deck PDF, demo video, submission form draft | Check every public URL in a private window |
| D-0, 9/13 | Submit, targeting 01:00 KST on 9/14 | Screenshot of the completed submission |

> The deadline lands at midday Monday Korean time, so the work finishes over the weekend. Sunday night is not a buffer.

### 9.3 Rules for spending on-chain queries

The budget question closed with 10,000 CTC. What is short is time: an attestation takes about eight minutes.

| Rule | Reason |
|---|---|
| Nothing goes on chain until it passes the local mock harness | One failure costs eight minutes, and the day holds only so many round trips |
| Batch changes that need on-chain verification into one run | Eight minutes once beats eight minutes N times |
| Check the balance weekly, refill under 2,000 CTC | Running out is unlikely, and it stops the day if it happens |
| Track Sepolia ETH separately | Public faucets have daily limits |

### 9.4 Measured against assumed

| Item | Status |
|---|---|
| Attestation lag, 6.5 to 8.8 min | measured, three observations |
| chainKey: Sepolia 1, mainnet 3 | measured |
| Proof Builder API works, 0.58s response | measured |
| ~~Nine queries a day~~, actually 10,000 CTC | measured, and it contradicts the README |
| Cost per query 0.0002 CTC, 394,982 gas at 0.5 gwei with no separate fee | measured. No budget constraint |
| Burn to ASC application, 9m 43s: 8.5 min waiting plus about a minute for proof and submission | measured |
| `verifySingle` gas: estimated 421,105, used 394,982 | measured |
| Sepolia mint 50,969 gas, burn 30,721 gas | measured |
| No ATC fee on the readability path | settled. Official wording and our measurement agree |
| `verifyBatch` gas | `assumed`, never measured because the path is unused |
| Proof Builder rate limits | `assumed`, not yet measured |
| Sepolia finality to attestation, as a separate figure | `assumed`, folded into the end-to-end number above |

---

## 9.5 Deployment, which satisfies the testnet requirement

`deployments/cc3-testnet.json` is canonical. A redeployment updates it first.

| Contract | Chain | Address |
|---|---|---|
| `EvmV1Decoder` | CC3 Testnet | `0xff3558704c75ed69e1D657474210365b24d31938` |
| `ProofmarkASC` | CC3 Testnet | `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` |
| `ProofmarkRegistry` | CC3 Testnet | `0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc` |
| `ComplianceSource` | **Sepolia** | `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` |
| `GatedRwaNote` | CC3 Testnet | `0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625` |

> **The ASC on CC3 and ComplianceSource on Sepolia share an address.** Same deployer, same nonce, different chains, so CREATE lands in the same place. We verified it: the bytecode differs, 18,120 chars against 7,478, each responds only to its own interface, and cross-calls revert. The risk is that a script passing the ASC address to `configureSource` by mistake would look identical, so a redeployment compares `cast code` on both chains.

**Post-deployment checks, all passing**

```
asc.expectedChainKey  : 1          Sepolia, confirmed at runtime through getSupportedChains()
asc.sourceContract    : 0x93C6…5629 ComplianceSource on Sepolia
reg.ASC               : 0x93C6…5629 the ASC on CC3
src.isIssuer(deployer): true
note.POLICY_ID        : 1          KR policy, methods mask 0x10024
```

**On-chain evidence that the gate is closed**

```
$ cast call $NOTE "mint(address,uint256)" $ME 1e18 --from $ME --rpc-url $CC3
revert 0x17887111…  = RecipientNotVerified(0xFD12…bD5E, 1)
$ cast call $REG "isVerified(address,uint256)(bool)" $ME 1 → false
```

> **Without `--from` you reach a different conclusion.** `cast call` leaves msg.sender at zero, so `mint` stops at `OwnableUnauthorizedAccount` (`0x118cdaa7`) before the gate ever runs. That is the ownership check, not the gate, and both look like a revert. Reproduction steps must state `--from`. We walked into this ourselves.

### 9.6 End-to-end issuance

A mark issued through the Korean flow, propagated cross-chain, opening the gate. Every step succeeded.

| Step | Result |
|---|---|
| Worker start | ASC `expectedChainKey` and `sourceContract` checked, cursor at 11,597,795 |
| Sepolia issuance | tx `0x93e4f981…9a01`, block 11,597,799, 27,933 gas |
| Worker detection | 86 seconds later, including four confirmation blocks |
| Attestation complete | 6m 30s after issuance, 39 blocks |
| CC3 proof submission | tx `0xe0f8f6d4…`, 386,008 gas |
| `isVerified` turns true | 7m 55s after issuance |
| `note.mint` succeeds | tx `0x8f6789cf…c138`, 271,866 gas, balance 1.0 |

**The mark that was issued**

```
methods = 0x19003f
  = WALLET_CONTROL | ID_DOC_IMAGE | ID_DOC_AUTHENTICITY | FACE_MATCH | LIVENESS
  | BANK_ACCOUNT | SANCTIONS_SCREENED | JURISDICTION_CHECK | ONCHAIN_EXPOSURE
  covers the KR policy requireAll of 0x10024: authenticity, bank account, sanctions
regime = 1 (KR_FSC_NONFACE) · jurisdiction = 410 (KR) · assurance = 2
```

**Cross-chain integrity: every field on CC3 matches what Sepolia issued**

```
status 1(ACTIVE) · origin 1(Direct) · kind 1 · assurance 2 · regime 1 · jurisdiction 410
methods 0x19003f · epoch 0 · issuer 0xFD12…bD5E
claimsRoot   0xd78af317ce2a4285946d7bd54065896f31492ca7a4de6c8cfdfcdf88226bca97  matches
evidenceHash 0xfab2199203e7f2e7a6176d54dcd8d1870d3a691b2b544b80735938db23cf297a  matches
```

> `origin` reading 1 (Direct) is the design working. The value came from the ASC observing which action it processed, not from the source event (`ProofmarkASC.sol:149`), so an issuer cannot claim roster provenance it never earned. The freshness split in section 6.4 turns on this field.

**Propagation measured at 7m 55s.** Not instant, as section 7 row 3 says. The number is published as a product parameter.

> **This mark's `methods` were synthetic, which made it a lie, and it was revoked.**
> The run existed to validate the pipeline, so `attrs` were hand-authored. The resulting mark claimed
> `ID_DOC_AUTHENTICITY`, `FACE_MATCH`, `LIVENESS` and `BANK_ACCOUNT`, and none of those checks ran.
> With no vendors connected those bits cannot honestly be set, per section 4.2.
>
> Separating what the run proved from what it did not:
>
> | Proven | Not proven |
> |---|---|
> | Cross-chain integrity, every field intact | That document authenticity or account verification actually ran |
> | Worker resilience and idempotence | That the screening the mark describes took place |
> | That the gate responds to a mark | That the KR policy can be passed honestly |
> | Propagation of 7m 55s | |
>
> **Revoked 2026-08-30.** Sepolia `revoke(subject, 4=ISSUER_ERROR, 0)` in tx `0x6d630831…050f`, applied on CC3 in tx `0xc3d4d056…` at 382,312 gas. Propagation took 8m 43s.
> Result: `tombstone=true`, mark `status=2 REVOKED`, `isVerified` false under both policies, `note.mint` reverting with `RecipientNotVerified`.
> A tombstone blocking both policies confirms deny beats allow on chain, rule 2 of section 6.4, and demonstrates demo scene 8 as a side effect.
> A mark claiming checks that never happened is precisely what this product exists to stop, so leaving it on our own testnet was not an option.



> **Operational note.** The worker cursor starts at the current head by default, so issuing first means the event is never seen. Start the worker, then issue, or set `WORKER_START_BLOCK`. This is the easiest thing to get wrong in a rehearsal.

---

---

## 9.7 AML screening engine, measured

No fixtures. `aml/fetch-lists.sh` loads 57MB of source XML from OFAC, the UN and the EU.

| List | Entries | Note |
|---|---|---|
| OFAC SDN | 19,321 | includes 1,007 crypto addresses |
| UN Consolidated | 1,011 | 736 individuals plus entities |
| EU FSF | 6,234 | |
| **Total** | **26,566** entries, **78,365** names and aliases, **124** sanctioned EVM addresses | parsed in 0.5s |

**Measured with `aml/eval.ts`. `aml/engine.test.ts` holds the numbers in place.**

| Metric | Value |
|---|---|
| Recall | **100%**. 200 listed individuals looked up by their own name, date of birth and country, all caught |
| Specificity | **100%**. 600 ordinary Korean names and 10 western names, no false positives |
| Evasion | **7 of 7**: invisible characters, Cyrillic homoglyphs, diacritics, full width, reversed order, inserted punctuation |
| Sanctioned wallet | Blocked regardless of name, from the OFAC `idList` |

**The first measurement came back at 67% specificity, a third of ordinary names flagged.** The containment bonus applied regardless of token count, so two tokens overlapping gave a common fragment like `ji` full marks and ordinary Korean names were caught in bulk. Restricting the bonus to cases where the shorter side has three or more tokens took false positives to zero and left recall at 100%.

**How romanised expansion is treated, which is the judgement this product turns on**

```
Kim Jong Un    KP, date of birth matches   BLOCK band 5   expansion hit, corroborated
Choi Yeong-ho  KR                          ALLOW band 2   expansion hit, nothing corroborates it
```

An expanded spelling is our inference, not something any list asserts. Strip the diacritics and Choi Yeong-ho and the listed Choi Yong-ho both become `yong`, scoring 100 against each other, and a test reproduces the collision. So an expansion hit with no corroboration from date of birth, country or wallet does not move the decision. The hit itself stays in the evidence, which keeps the audit trail intact.

**Honesty is enforced by code**

```
methodsApplied = 0x190000
  = SANCTIONS_SCREENED | JURISDICTION_CHECK | ONCHAIN_EXPOSURE
  PEP_SCREENED  bit 0, no data source connected
  ADVERSE_MEDIA bit 0, no data source connected
```

Screening that did not run leaves its bit unset, and a consumer policy filters on that automatically, per section 4.4. The FATF jurisdiction table carries `verified: false`, and the evidence records it as unverified rather than implying a certainty we have not earned.

**Evidence is deterministic.** The same input produces the same digest, pinned by a test. `engineVersion` travels with it, so a change to the matching rules stays distinguishable even when the list edition is unchanged.

**The evidence carries no cleartext name. The first version did, and that was a defect.**

The first implementation stored `normalizedName`, `nameTokens` and `romanizedVariants` in cleartext. Evidence lives off chain, which makes that look acceptable, but it puts the right to erasure against the audit trail: with PII in the evidence, erasing the vault means erasing the evidence too, and the arrangement in section 7 row 11 falls apart.

Every name field became an HMAC digest under a key the issuer holds. `evidenceKey` is a required argument, because a default is what someone ships to production.

> **Pseudonymisation, not anonymisation.** Names carry little entropy, so an unsalted hash falls to a dictionary attack. The key holder can confirm a candidate, and that is deliberate, because audits have to reproduce. A leaked evidence file on its own yields no names. `keyId` travels alongside so rotation stays traceable.

**A side finding: the PII detector failed on Hangul.** The leak went unnoticed at first. The check was `JSON.stringify(ev).includes(name)` and it returned false while the value sat right there:

```
input   NFC → bc15 c11c c900                (3 code points)
stored  NFD → 1107 1161 11a8 1109 …         (8 code points, jamo decomposed)
```

Same characters, different code point sequence. A PII detector that fails on Korean names is not something to leave in a product that screens Korean names, so the detector now compares across NFC, NFD, NFKC and NFKD, and a test checks the detector itself: it asserts first that a plain `includes` misses the value, then that the detector catches it.

---

## 10. Demo script, three minutes

| # | Scene | What it shows |
|---|---|---|
| 1 | Connect wallet, ID document, bank account | The Korean flow as it is. Open devtools and the payload leaving the browser is 32 bytes |
| 2 | Reconciliation | Declared details, document and account holder agreeing. Only the agreement survives; the values do not |
| 3 | AML screening | Three real lists. Type a sanctioned name and it blocks immediately |
| 4 | Sepolia issuance | On Etherscan, with the `methods` bitmap visible in the mark |
| 5 | Attestation, proof, verification on CC3 | The scene the competition is about. The eight-minute wait is a timelapse, labelled as edited |
| 6 | A GatedRwaNote transfer succeeding | The policy passes |
| 7 | Two dApps, two policies | One mark passing the pilot policy and failing production for want of the authenticity bit. This is where portability becomes visible |
| 8 | Sanction hit, rescreening, revocation on Sepolia, propagation, the same transfer failing | The lifecycle running for real |
| 9 | A full dump of the on-chain data | Zero bytes of personal data |

---

## 11. Risk register

| # | Risk | Impact | Mitigation | Decision point |
|---|---|---|---|---|
| ~~R1~~ | ~~Sepolia ETH not received~~ | closed | Both faucets landed on 8/30 | closed |
| ~~R2~~ | ~~Query budget exhaustion~~ | closed | 0.0002 CTC per query. The mock harness stays P0 for speed, since the eight-minute attestation is the real bottleneck | closed |
| R2b | SDK `waitUntilHeightAttested()` dies on a single API timeout | high | Measured: eight minutes lost to one `AxiosError: timeout of 10000ms`. Our worker wraps the wait with retries, backoff and persistence. The source transaction stays valid, so a rerun recovers | implemented |
| ~~R2c~~ | ~~The ATC demand argument in section 14~~ | closed | Official wording and measurement agreed, so the argument is withdrawn and replaced with the ecosystem case. No submission claims ATC demand | closed |
| R3 | Mode B non-membership proofs overrun | medium | The section 6.3 fallback, tombstones only | evening of D-6 |
| R4 | The originality rule, and any suspicion of reused code | severe | Written fresh in a new repository. What carried over is knowledge: AML normalisation, matching design, fail-closed rules. The README states the prior work up front | D-12 |
| R5 | Reading as "an app with an oracle bolted on" | high | Lead the submission summary with the removal test and the cost argument | D-2 |
| R6 | Overstating latency as instant revocation | high | Publish the measured range. Never write "instant" | ongoing |
| R7 | The unconnected KR vendors reading as connected | high | Leave the bits unset and label it on three surfaces | D-4 |
| R8 | Misreading the regulatory position, claiming to be a verification authority or asserting equivalence | high | State that assurance is our own grade and equivalence is the consumer's call | ongoing |
| R9 | Public Sepolia RPC rate limits | medium | Keep an Alchemy or Infura key in reserve | D-11 |
| R10 | Not enough people | medium | Everything outside P0 is designed to be droppable | D-6 |

---

## 12. Track

| Track | Assessment |
|---|---|
| **RWA** | Tokenised assets carry a legal requirement to screen holders, and `GatedRwaNote` as a credit note sits on Creditcoin's own ground. Chosen |
| DeFi | A gated lending pool works too, but this is the crowded track | second choice |
| AI, DePIN, Gaming | not a fit |

One more argument: every submission in the other four tracks is a potential customer. That any of them could add our SDK carries weight in due diligence.

---

## 13. Competition requirements against this plan

| Requirement | Where | Status |
|---|---|---|
| Working Attestcoin integration | Section 5, and the batching design in 5.2 | done |
| Technical documentation covering setup and protocol use | README plus this document and `01-env-verification.md` | done |
| Depth of integration | The removal test, the `ASCBase` fork with its two security findings, batching through multiple logs | done |
| Original work created during the hackathon | R4: new repository, prior work disclosed up front | settled |
| Testnet deployment on CC3 and Sepolia | Section 9.5 | done |
| Attestcoin as a core feature | Remove it and the product collapses into a relayer | done |
| Project sector | RWA, section 12 | settled |
| Integration summary, the most important narrative | README section 3 | drafted |
| GitHub URL and README | written; the repository still needs pushing | **open** |
| Deck or whitepaper PDF | D-1 | **open** |
| Demo video URL | Script in section 10 | **open** |
| Team details, residence and citizenship | not collected | **open** |
| Eligibility, including not being a sanctioned person | needs confirming for everyone | **open** |

---

## 14. Market and revenue, for CEIP due diligence

The CEIP fast track is worth more than the prize money, and what follows judging is due diligence.

| Customer | Why they buy | What they do instead | Pricing |
|---|---|---|---|
| RWA and stablecoin issuers | A whitelist has to run every day and produce evidence for a supervisor | Stand up an operations team and build the evidence system themselves | Annual contract plus an operational SLA |
| Cross-chain dApps | Not rebuilding KYC per chain | Vendor contracts multiplied by chain count | Per issuance; queries are free |
| Multinational dApps | One integration instead of one per jurisdiction. They change the policy, not the plumbing | Jurisdictions times vendors, in integrations | Jurisdiction adapter subscription |
| Wallets | Checking a recipient before sending | Incident response and explaining that funds cannot be recovered | Per query |
| VASPs and custodians | Pre-checking personal wallet recipients, travel rule | Manual review and held withdrawals | Per check |

**What this gives back to Creditcoin**

Not a token economics argument. Attestcoin reads are free, confirmed by both the official wording and our measurement, and our product sits entirely on that path, so claiming we create ATC demand would be false. CEIP looks for products that strengthen and grow the ecosystem rather than for burn volume, and that is the standard we answer to.

| What | Why |
|---|---|
| Creditcoin becomes the chain of record for compliance | Issuers legally required to screen holders gain a reason to read it, and Attestcoin is the only trustless cross-chain read available |
| Every submission in the other four tracks is a potential customer | A dApp that needs gating adds one SDK call, and the demand circulates inside the ecosystem |
| Free reads mean no adoption barrier | A dApp integrates with no per-query cost. Our revenue comes from issuance, operations and evidence, so queries can stay free indefinitely |
| Writability propagation, roadmap | Pushing to spoke chains becomes a paid write. Written as roadmap, never as current fact |

**Why this team**
Seven years operating Korea's fourth registered VASP, covering the CEO, compliance officer and CTO roles, plus the engineer who built that exchange's KYC. Top rating in the FSC's money laundering risk assessment three quarters running. A team that has actually run document and account verification is moving those procedures on chain, and that combination is unlikely to appear twice in this competition.

**KPIs:** issuances, active marks, transactions passing a gate, integrated dApps, jurisdictions supported, propagation latency at p50 and p95, revocation SLA, zero epoch freshness violations, list freshness.

---

## 15. Lines we hold

1. **No PII on chain.** No exceptions. Commitments and hashes only.
2. **We do not become an identity verification authority.** Vendors perform the verification; we are responsible for the result's lifecycle and its movement.
3. **No power to freeze assets.** We publish decisions and never move anyone's funds.
4. **Everything in the demo works.** No staged screening, no fake timers. An unconnected check is expressed by leaving its bit unset.
5. **No equivalence claims.** We never write that Korean KYC equals EU KYC. We publish the methods and the consumer decides.
6. **Documents describe what is live.** Nothing that exists only in the repository is described as deployed.
7. **No overstatement.** We do not write "instant". We write the measured range.
8. **No design that would work just as well without Attestcoin.**
9. **Prior work is disclosed first.** The earlier project is a reason to trust us, not something to hide. The code is still written fresh.
10. **`.env` is never committed.** We do not copy the example repository's pattern (`01-env-verification.md` section 4).

---

## 16. Decisions

| # | Decision | Options | Outcome |
|---|---|---|---|
| D1 | Product name | Proofmark, AttestKYC | **Proofmark**, and only Proofmark. For an international product the English name has to carry, and this one comes straight from "proof plus mark", so the name explains the design. No secondary or Korean name anywhere in the product; an earlier draft had put one in the wordmark without approval, and it was removed |
| D2 | Track | RWA, DeFi | **RWA** |
| D3 | Prior project assets | port the code, or carry knowledge only | **knowledge only**, per R4 |
| D4 | How far the KR adapter integrates | real vendor integrations, or interface plus mock | **Real integrations, no mock.** Document authenticity through CODEF against Government24 and Traffic Civil Service 24, the account through KFTC Open Banking (or CODEF), both live in code and tested against the documented wire formats. What fourteen days cannot buy is the commercial side (KFTC participating-institution registration, the CODEF partnership contract), and that shows up honestly as `live = false` from a testbed and a bit left at zero, not as a fake vendor. See section 4.2 |
| D5 | Second jurisdiction | ePassport NFC, EU, US | **ePassport NFC.** It verifies without a vendor or a jurisdiction dependency, which is the real gateway. P2 |
| D6 | Team size | one, or several | **Several.** The submission form asks each member for residence and citizenship | 
| D7 | Which spoke chain | undecided | decide at D-5 |

---

## 17. What is left

1. Push the repository to GitHub. The submission needs the URL, and the README is written.
2. Watch the AMA recording and fold anything new into the brief and section 13.
3. Confirm the team roster, since the form asks for residence and citizenship per member.
4. Record the demo video against the section 10 script.
5. Produce the deck or whitepaper PDF and host it at a public URL.
