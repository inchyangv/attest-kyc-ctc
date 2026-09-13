# Proofmark: a cross-chain KYC and AML attestation layer

> 2026-08-30 · Tech Lead / PO · For [BUIDL CTC 2026 Fall](00-hackathon-brief.md)
> Prerequisites: [`00-hackathon-brief.md`](00-hackathon-brief.md), [`01-env-verification.md`](01-env-verification.md)
> Prior team work: an EAS-based compliance layer on GIWA. Knowledge carried over, code did not (section 11, R4).
>
> **Status, updated 2026-09-07:** product proposal and implementation history, not release approval. The [56-ticket execution ledger](../TICKET.md) is the current completion record. Historical addresses, schedules, fees and testnet observations below do not establish the current working tree's deployed behavior. Sections 9.2–9.7 preserve dated planning/observations; they are not current deadline, balance, latency or eligibility checks.
> Notation: measurements stand as written; estimates are marked `estimate`; unverified assumptions are marked `assumed`.

### Current investment and release boundary

The [2026-09-10 winning sprint](88-winning-sprint.md) is the current implementation priority: authenticated global provider onboarding, current AML, minimal-disclosure eligibility proofs, and a judge-facing product journey. The historical plan below remains background; new local features are not presumed deployed or production-approved.

| Question | Current evidence and limit |
|---|---|
| Does one issuer leave another issuer's credential intact? | No. [T-06 acceptance](69-issuer-isolation-decision.md) still fails all three local overwrite/revoke/deny isolation cases. Independent issuer scoping versus an enforced single-issuer product needs a user decision. |
| Is the current flow connected? | The built browser, actual routes, isolated Redis/vault/source and later hub/witness/token actions are [connected locally](51-local-api-issuance-integration.md). The provider interface, institutions and native proof are fixtures; later chain actions are test-process transactions. |
| Are the latest contract fixes deployed? | Not established. Historical public addresses are incompatible with several new schema/proof/consumer guarantees. New deployment and migration require separate approval and evidence. |
| Are official lists available? | A [dated isolated full GET/build/evaluation](83-official-snapshot-observation.md) passed. The candidate was not copied into repository or deployed runtimes. Provenance v2/readers/index/pins must be transitioned together. |
| Can another chain consume verified state now? | This repository has local consumer tools/examples. A production spoke mirror, independent consuming app and measured external integration are not verified. |
| Are institutions, customers and legal rights secured? | Not verified. Provider access/reuse rights, customer discovery, retention/processing approval, IP and independent audit remain gates, not consequences of a green test suite. |

---

## 1. In one paragraph

A proposed cross-chain KYC and AML attestation layer. An issuer records its asserted checks, jurisdiction and commitments on an EVM source; the Creditcoin-side consumer is intended to verify source-event provenance through the native proof system. That does not independently verify the truth of identity checks, issuer judgment or roster completeness. Arbitrary-chain consumption is a roadmap item, not an implemented universal read surface. The defined events contain no name, date of birth, document number or account number, but wallet-linked metadata and commitments remain pseudonymous and linkable.

One design proposition decides whether this works across borders:

> "KYC complete" does not carry a fixed meaning across borders. So the mark carries the checks that were performed rather than a verdict, and each consumer decides equivalence under its own jurisdiction's policy.

The first proposed jurisdiction adapter is Korea: ID-document and bank-account checks, with a one-won code flow. Whether an approved vendor arrangement and the complete customer workflow satisfy applicable identification obligations requires qualified review. A shared adapter interface is not evidence that another jurisdiction or provider is supported.

| Item | Value |
|---|---|
| Product name | **Proofmark**. Repository and technical name `attest-kyc` |
| One line | Record issuer checks on a source chain; evaluate their proven record under a consumer policy |
| Tagline | Issuer assertions, source provenance, consumer policy |
| Track | **RWA**, section 12 |
| Source chain | Ethereum Sepolia, chainKey `1`. Confirmed at runtime, and not the same as chainId 11155111 |
| Verification hub | Creditcoin CC3 Testnet, chainId 102031, through the ASC and BlockProver |
| Attestcoin axis | Readability. Writability is roadmap |
| On-chain cleartext PII | zero bytes; wallet-linked metadata and commitments are pseudonymous, not anonymous |
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

The proposition is reusable, explicit check metadata. Avoiding an equivalence claim does not itself establish legal safety, portability rights or a customer's acceptance policy.

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
0. consent and connect wallet; sign EIP-4361 binding address, flow ID and consent version
1. [ID document]  capture, OCR, authenticity lookup with the issuing authority (face match and liveness once a face vendor is connected)
2. [bank account] one-won transfer, account holder name compared with the document name
                  operational and legal sufficiency requires provider/customer approval
3. [reconcile]    declared details, document, account holder. All three must agree
4. [AML]          sanctions lists, jurisdiction, on-chain exposure, risk band, which sets expiry
5. [commitment]   the issuer creates per-claim random salts and computes claimsRoot.
                  Openings return to the user and enter the encrypted production evidence record
6. [issue]        Sepolia ComplianceSource.issueOnce(requestId,...), permanently consuming the flow
7. [cross-chain]  obtain/verify the source proof; public latency for the new release is not established
8. [use on hub]   satisfy the exact frozen policy; a roster policy also needs a current stored witness
```

Step 3 is the heart of it. Declared details, document and account holder are reconciled, and only the fact that they agreed reaches the chain as a proof and a mark.

### 3.3 The privacy boundary, which does not move

| Who | Sees |
|---|---|
| Anyone, on chain | wallet, kind, assurance, the methods bitmap, regime, jurisdiction, expiry, issuer, epoch, claimsRoot, evidenceHash, and the proof it was issued on Ethereum |
| A dApp | The bool is a convenience call, not an access-control boundary: the app can also inspect public events, marks, policy and witness metadata |
| The user | Full claims/evidence returned to this flow and downloadable; claim-disclosure helpers exist, but an approved selective-disclosure/auditor product is not established |
| An auditor or regulator, under contract or warrant | the issuer's full offline evidence, checkable against the on-chain `evidenceHash` |
| Privacy limit | Salted commitments are designed to resist guessing; wallet linkage, auxiliary information, retained openings and issuer-key access still matter. Do not infer anonymity or a legal erasure conclusion |

The regulatory analysis of the off-chain side of this boundary — controller status, PIPA, the Credit Information Act, AML retention — is in `docs/08-regulatory-position.md` (a position paper, not legal advice).

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

**Why a bitmap.** It lets a consumer express required checks explicitly. A set of bits does not establish an eIDAS assurance level or cross-border recognition; those mappings require an approved policy and supporting evidence. In particular, this implementation does not currently perform liveness.

### 4.2 The Korean adapter

| Step | Check | FSC guidance | Bits set |
|---|---|---|---|
| 0 | Wallet ownership signature | not a regulatory requirement, ours | `WALLET_CONTROL` |
| 1 | ID document | method 1, document image | `ID_DOC_IMAGE` `ID_DOC_AUTHENTICITY` (`FACE_MATCH` `LIVENESS` when a face vendor is added) |
| 2 | Bank account, one-won transfer | method 4, use of an existing account | `BANK_ACCOUNT` |
| 3 | Supported screening | Does not by itself establish complete CDD | `SANCTIONS_SCREENED` and self-declared-input `JURISDICTION_CHECK`; no graph/exposure bit |

`KR_FSC_NONFACE` is an implementation regime label, not a compliance certificate. Regime selection must reflect completed live results, not configuration alone; demo participation remains sandbox. See [capability and regime boundaries](30-check-capabilities.md).

**Implemented connector paths, not proof of approved live-vendor operation** (`pipeline/adapters/`, wired into `/verify`). Endpoint/response assumptions still require provider conformance and permitted access/reuse:

| Check | Vendor and product | What runs |
|---|---|---|
| Document fields | CODEF resident registration card OCR / driver-licence OCR (`/v1/kr/etc/a/kyc/registration-card`, `/drivers-license`) | The photo is read so the customer does not type; every field is confirmed against the card |
| Document authenticity, resident registration card | CODEF resident registration authenticity through Government24 (`/v1/kr/public/mw/identity-card/check-status`) | The issuer logs in with its own joint certificate and asks Government24 whether the name, resident number, and issue date identify a genuine card. `resAuthenticity = "1"` sets the bit; anything else stops issuance |
| Document authenticity, driver licence | CODEF driver-licence authenticity through the Korean National Police Agency's Traffic Civil Service 24 (`/v1/kr/public/ef/driver-license/status`) | Same login; licence number and the anti-forgery serial are checked. `"2"` (number exists, serial did not verify) is a rejection |
| Account holder | KFTC Open Banking real-name inquiry (`/v2.0/inquiry/real_name`), or CODEF account-holder authentication (`/v1/kr/bank/a/account/holder-authentication`) | The bank returns the holder for the account and the customer's real-name number; it must equal the name on the document |
| Account control | KFTC Open Banking deposit transfer (`/v2.0/transfer/deposit/acnt_num`), or CODEF account authentication by one-won transfer (`/v1/kr/bank/a/account/transfer-authentication`) | The configured rail starts a code challenge; the server enforces attempts/expiry/consumption. Built-in demo deliberately displays a simulated code without a deposit. Live rail and ambiguous-timeout reconciliation require provider conformance |

The additional-authentication legs the institutions impose (a captcha on a corporate-certificate login, an app approval) are carried through the same endpoint with `is2Way` and surfaced to the operator in the flow.

> **What the `live` field does not prove.** The adapters record vendor/mode/results and gate method bits; those local labels are not independent proof of institutional execution or permitted reuse. A key, certificate or environment name alone does not establish contract rights, lawful access, customer acceptance or production availability. Actual provider receipts/run IDs and approved conformance remain T-30 work. Current mode assumptions and unresolved access conditions are tracked in [the vendor document](07-kyc-vendors.md); do not treat this plan as current vendor terms.

> **Demo mode** (`KYC_DEMO=1`, `web/lib/kyc-server.ts`). Built-in demo axes use `pipeline/adapters/demo.ts`: the same flow/token interfaces and reconciliation, with no institution asked. The page labels `demo:*` evidence and sandbox regime. `sandboxBits` can represent simulated checks under that regime; a production-regime policy rejects them. A pilot attribute preview is not an onchain pass: a new roster-gated asset also needs its full frozen policy, current witness and issuer approval. Actual result provenance, not configured mode alone, determines the regime. See [`07-kyc-vendors.md`](07-kyc-vendors.md).

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
    uint8    minAssurance;
    uint40   maxAge;        // freshness ceiling
    uint16   requiredRegime;
    uint16   requiredJurisdiction;
    address  trustedIssuer;
    bool     requireRoster;
    bool     exists;
}
```

- A Korean VASP: `requireAll = ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED`
- An EU RWA issuer: one frozen policy per accepted credential combination, for example `LIVENESS | SANCTIONS_SCREENED | PEP_SCREENED | EPASSPORT_NFC`
- A game: `requireAll = SANCTIONS_SCREENED` and nothing more

The current working-tree registry also binds an immutable `policyKind` (individual/entity) outside this struct. Policy updates stop at freeze. The new asset additionally requires a compatible witness-capable registry and a frozen roster-required policy; attributes alone or a Direct mark do not open it. Historical deployments must not be assumed to enforce this release's checks.

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

The diagram is the original layer sketch, not a current ABI or a claim that every depicted component is implemented/deployed. The spoke/mirror is roadmap; rescreening has local commands and controls, not an installed production daemon. Current event versions and release boundaries are in [the event schema](04-event-schema.md), [security migration](19-security-migration.md) and TICKET.md.

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

The earlier small testnet observation reported approximately 0.0002 CTC for one submission. It is a historical gas observation, not a current tariff, zero marginal operating cost, production quotation or proof of unlimited resources. Neither a faucet balance nor one transaction settles network fees, RPC/proof-service limits, current writability support or customer integration cost. Use the [explicitly synthetic unit-economics model](43-unit-economics.md) as a planning worksheet until actual quotations and release-specific measurements exist.

Roster publication can batch a set commitment and its cross-chain acceptance. It does **not** remove the source issuance/revocation events that the current source-replay builder consumes, per-member screening, issuer approval work, bundle delivery or holder witness refresh transactions. A new epoch invalidates older witnesses; merely publishing its root does not refresh every consumer's stored proof.

| | Mode A, individual proof | Mode B, epoch roster |
|---|---|---|
| What is proven | one `MarkIssued` event | one `RosterEpochPublished` root |
| Writes to budget | Source lifecycle and hub receipt processing; batching depends on actual receipts | Source lifecycle plus root/approval publication, hub acceptance and per-subject witness transactions as needed |
| Scale claim | No customer-volume operating measurement | 100,000 users do not become one total system write; [bundle measurements](39-roster-proof-availability.md) cover only their stated local scope |
| Revocation | Source event must reach the hub to affect its state | A current roster can exclude a subject; absence alone does not prove why. Previously usable state also depends on expiry, delivery and witness rules |
| Latency | Source confirmation, attestation/proof and relay; no approved SLA | Adds publication cadence and witness availability; historical timing is not a release SLA |
| Use boundary | Weaker Direct policies can remain valid until their own limits if later revocation is not delivered | New gated assets require a fresh stored witness and the complete frozen policy |

The investment case depends on measured total cost and a customer who needs this provenance path. Batching alone does not establish either.

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
Claim openings are returned to the browser and retained in the encrypted recovery journal/configured evidence vault. They are not browser-only secrets. `discloseClaim`/`verifyDisclosure` implement a claim inclusion helper; an approved selective-disclosure workflow, auditor access and export policy remain separate work.

### 6.2 The on-chain mark

This explanatory sketch omits fields such as actual provenance origin. [ProofmarkTypes.sol](../src/lib/ProofmarkTypes.sol) and schema/version tests are authoritative for encoding. A bit or issuer grade is an assertion, not independently verified institutional performance.

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

Current roster format v2 uses `subjectKey = keccak256(abi.encode(namespace, subject))`, domain-separated leaf/internal/root hashes (`0x00`/`0x01`/`0x02`) and a root commitment to `leafCount`. Proofs validate full depth/index/odd tails and consistent adjacent leaf counts. Use [the actual library](../src/lib/RosterProof.sol) and cross-language vectors, not the obsolete untagged `H(key ‖ markHash)` recipe. The subject is still an EVM address and is not issuer-scoped; neither non-EVM support nor T-06 isolation follows from the namespace string.
The verifier recomputes each boundary leaf from both `(key, mark)` before checking adjacency. Accepting a supplied key independently of the Merkle leaf would let an attacker relabel two real neighboring leaves around a target that is actually present.
Do not silently fall back to old roots, Direct eligibility or a different sanctions authority to meet a deadline. Any reduction or incompatible migration needs explicit product and release approval.

### 6.4 Decision rules, fail closed and enforced in the contract

Working-tree update (T-08): for `requireRoster=true`, `isVerified` uses the Registry's separate current-epoch witness, not `ASC.marks[W]`. It checks tombstone, latest epoch, original root expiry and issuer approval, then applies all attribute/kind/credential-age rules to the witnessed leaf. `cacheRosterWitness` supplies a verified inclusion without rewriting Direct provenance. New `GatedRwaNote` deployments require this frozen policy and witness capability 1. [Current consumer path and outage evidence](34-fresh-roster-consumers.md). The pseudocode below describes the older materialized-mark branch, not the entire new witness path; `maxAge=0` means no credential-age ceiling and the actual contract additionally rejects future timestamps and invalid schema/kind.

```
isVerified(W, policy) =
      marks[W].status == ACTIVE
  &&  (marks[W].methods & policy.requireAll) == policy.requireAll
  &&  marks[W].assurance >= policy.minAssurance
  &&  marks[W].expiry > block.timestamp
  &&  block.timestamp - marks[W].issuedAt <= policy.maxAge
  &&  (policy.requiredRegime == 0 || marks[W].regime == policy.requiredRegime)
  &&  (policy.requiredJurisdiction == 0 || marks[W].jurisdiction == policy.requiredJurisdiction)
  &&  (policy.trustedIssuer == 0 || marks[W].issuer == policy.trustedIssuer)
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
| **Roster**, Mode B | Membership in the issuer-approved asserted set at the current epoch | Completeness, per-member rescreening, the reason for absence, or freshness after the original expiry |

Hence `Policy.requireRoster`. A high-risk dApp accepts roster-backed marks only; a low-risk one takes individual proofs. Direct being the weaker guarantee is stated in the policy rather than buried in code.

1. **An expired roster verifies nobody.** Unknown is never a pass.
2. **Deny beats allow.** A tombstone outranks any epoch root. A newer full issuance may clear an ordinary revocation; it cannot clear a sanctions denial.
3. **A stale cache is not a truth.** It has to be re-materialised.
4. **Epochs increase monotonically.** A rollback needs an explicit governance path.

### 6.5 What a dApp integrates against

| Mode | Call | Character |
|---|---|---|
| Storage | `isVerified(W, policyId)` | Required-roster policy reads a witness supplied by `cacheRosterWitness(W, mark, inclusion)`, rechecking current epoch/expiry/issuer approval/tombstone and policy. Other policies retain weaker Direct behavior. Cache delivery never renews time. |
| Proof | `verifyWithRoster(W, policyId, mark, inclusion)` | Checks the current issuer-approved, unexpired root directly without writing state; publisher completeness remains a trust assumption. |

---

## 7. The hard parts, and what we did about them

| # | Problem | Approach | What remains |
|---|---|---|---|
| 1 | KYC means different things per jurisdiction | Section 4: carry the `methods` bitmap rather than a verdict, and leave equivalence to the consumer | We guarantee no equivalence, which is the point |
| 2 | Proving a negative | Format-v2 adjacency proves absence from the committed set, not absence from all legal sanctions | Tombstones help only after delivery; set completeness, rescreening and remaining valid-state windows need separate evidence |
| 3 | Propagation delay | Measured attestation lag of 6.5 to 8.8 minutes on top of finality, published as a product parameter rather than hidden | Real-time blocking has to gate on the source chain |
| 4 | Total write and operating cost | Epoch commitments batch part of the workload; source lifecycle and witness refresh remain | Customer scale, transaction mix, total cost and tolerated delay need measurement |
| 5 | Freshness | Each epoch publishes `validUntil`, and expiry fails closed | If the issuer stops, gates close. That is the safe direction |
| 6 | Trusting a mirror | A spoke root is comparable to the hub's verified root, and anyone can disprove a mismatch | Slashing incentives for disproving are roadmap |
| 7 | Replay | `ASCBase` already blocks it through `queryId = keccak256(chainKey, blockHeight, txIndex)`. We add source address pinning | It only stops resubmitting the same transaction. Rows 13 and 14 are separate problems |
| **13** | Wrong-source proof acceptance | Current ASC checks the configured source chain key and event emitter through the widened processing boundary | Local wrong-chain/emitter tests are not independent native-proof or deployment verification |
| **14** | Out-of-order lifecycle delivery | Current ASC uses source block/transaction/log ordering, full-receipt atomicity and a separate monotonic permanent denial | T-06 issuer isolation and approved historical migration remain unresolved |
| 8 | Wallet risk beyond exact list matching | Transaction-graph exposure/dusting analysis is not implemented and bit 20 stays unset | Select an approved data source and policy before claiming this control |
| 9 | Key risk | Stable issuer/operational key separation and local rotation tests exist | A compromised trusted issuer can authorize false claims/roots; comparison alone does not detect truth. Historical compromise cutoffs and operational custody remain T-12/T-23 work |
| 10 | False positives | An appeal path plus a cleared list, so the next rescreening does not revoke the same person again | A human makes the call |
| 11 | Data protection and retention | Events omit defined cleartext identity fields; wallet linkage/metadata remain public and offchain records persist | Consent capture, cryptography and local deletion controls do not establish lawful processing, complete erasure or vendor rights; T-32/T-33/T-53 remain open |
| 12 | Honesty while vendors are unconnected | An unconnected check leaves its bit unset, and consumer policies filter on that automatically | The demo's KR adapter is a mock, and the screen, the docs and the mark all say so |

---

## 8. How other chains read this

No implemented production spoke push/mirror is established in this repository. Earlier roadmap statements about the upstream writability product are not a current verification of its external release status.

| Role | Chain | Trust basis | Scope |
|---|---|---|---|
| Origin | Ethereum Sepolia | where issuance actually happened | P0 |
| Hub of record | Creditcoin CC3 | mathematical verification by the Attestcoin attester network | P0 |
| Spoke | any EVM chain | a mirror comparable to the hub's verified root, plus a proof-serving API | P1 |
| Push, roadmap | Creditcoin to spoke | Attestcoin writability | P2 |

Submission-safe scope: *"The local prototype connects source-issued assertions to a Creditcoin-side policy gate. Other-chain distribution and independently verified public-release operation remain to be demonstrated."* Do not claim universal reads or exclusive proof capability from the hub prototype.

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
| P1 | ~~Epoch roots, Mode B, with sorted-key non-membership proofs~~ | Done. Epoch 1 is published and the deployed registry verifies inclusion and non-inclusion |
| P0 | ~~`ASCBase` fork, chainKey pinning, ordering cursor~~ | Done. `ASCBaseX.sol` and `ProofmarkASC.sol`, 14 tests. `test_RejectsProofFromWrongChain` and `test_StaleIssueCannotResurrectRevokedMark` are mutation tested: remove the guard and exactly that test fails |
| P1 | ~~`revokeBatch()`, batching through multiple logs per transaction~~ | Done. Emit N in one transaction, apply all N in one `execute()` |
| P2 | ~~`verifyBatch`~~ | Not supported on the contract side. Revisit whether it is needed |
| P1 | Extended policies: `requireAny`, regime, jurisdiction | Working EU and US policy examples |
| P1 | `@proofmark/sdk` and a proof REST API | An outsider integrates in half an hour |
| P1 | One spoke mirror | A screen comparing it against the hub |
| P2 | ePassport NFC adapter | The next step for other jurisdictions |
| P2 | Selective disclosure and ZK attribute proofs | |
| P2 | Rescreening cron | A manual console run covers it for now |

### 9.2 Historical planning schedule — stated deadline unverified for submission

The original plan assumed 2026-09-14 12:59 KST. This date and the relative windows below are retained as planning history, not verified current rules, team assignments or a delivery promise.

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
| One reported query: approximately 0.0002 CTC, 394,982 gas at 0.5 gwei | Historical transaction observation; no general fee, balance or capacity guarantee |
| Burn to ASC application, 9m 43s: 8.5 min waiting plus about a minute for proof and submission | measured |
| `verifySingle` gas: estimated 421,105, used 394,982 | measured |
| Sepolia mint 50,969 gas, burn 30,721 gas | measured |
| Earlier interpretation of no ATC read fee | Historical interpretation; current upstream terms/status not verified by this revision |
| `verifyBatch` gas | `assumed`, never measured because the path is unused |
| Proof Builder rate limits | `assumed`, not yet measured |
| Sepolia finality to attestation, as a separate figure | `assumed`, folded into the end-to-end number above |

---

## 9.5 Historical deployment record — not the current release

`deployments/cc3-testnet.json` records historical addresses. These are not evidence that the current source/schema/proof fixes are deployed, or that current submission rules are satisfied. No new deployment was authorized by this plan.

| Contract | Chain | Address |
|---|---|---|
| `EvmV1Decoder` | CC3 Testnet | `0x5eE29aB8845A2AD4BBE1e01c5BD3bCc3AEee47Fd` |
| `ProofmarkASC` | CC3 Testnet | `0x3C6Fe016645CA52952E29C66E435bDa7F611b242` |
| `ProofmarkRegistry` | CC3 Testnet | `0x2F4E5e1270f90E51251651caf08547393e3C0572` |
| `ComplianceSource` | **Sepolia** | `0xA9A34586303b9fD92e090F9bb1D332DC854c72B9` |
| `GatedRwaNote` | CC3 Testnet | `0xa74aB3De359a55A729f9185Fe4Afe90526E585CA` |

The deploy script records and then re-reads every linkage: source chain key, source contract,
registry ASC, token policy ID, policy existence, and permanent freeze state. A redeployment aborts
if any address has no runtime code or any linkage differs from the manifest.

**Historical post-deployment observations, not rechecked here**

```
asc.expectedChainKey  : 1          Sepolia, confirmed at runtime through getSupportedChains()
asc.sourceContract    : 0xA9A3…72B9 ComplianceSource on Sepolia
reg.ASC               : 0x3C6F…242  the ASC on CC3
src.isIssuer(deployer): true
note.POLICY_ID        : 2          KR sandbox pilot, methods mask 0x10024
reg.policyFrozen(1/2): true / true
```

**On-chain evidence that the gate is closed**

```
$ cast call $NOTE "mint(address,uint256)" $ME 1e18 --from $ME --rpc-url $CC3
revert 0x17887111…  = RecipientNotVerified(0xFD12…bD5E, 2)
$ cast call $REG "isVerified(address,uint256)(bool)" $ME 2 → false
```

> **Without `--from` you reach a different conclusion.** `cast call` leaves msg.sender at zero, so `mint` stops at `OwnableUnauthorizedAccount` (`0x118cdaa7`) before the gate ever runs. That is the ownership check, not the gate, and both look like a revert. Reproduction steps must state `--from`. We walked into this ourselves.

### 9.6 End-to-end issuance

A historical synthetic mark propagated cross-chain and opened a gate. Its identity-check bits were hand-authored, not earned through the Korean vendor flow; it was subsequently revoked as described below. This is not a valid KYC issuance or current-release E2E result.

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



> **Current operational boundary.** The worker now requires an explicit start block and scoped checkpoints. Do not use the old current-head default or guess a recovery floor. Follow [source checkpoint recovery](26-source-checkpoints.md) and reconcile signed/consumed fork holds before resuming.

---

---

## 9.7 AML screening engine, measured

The table below is the preserved historical corpus observation, not current runtime freshness. A later [isolated official refresh](83-official-snapshot-observation.md) parsed 26,574 entries and passed an internal evaluation but was not deployed. The normal evaluation combines deterministic in-list positives with synthetic clean inputs; it is not fixture-free independent validation.

| List | Entries | Note |
|---|---|---|
| OFAC SDN | 19,321 | includes 1,007 crypto addresses |
| UN Consolidated | 1,011 | 736 individuals plus entities |
| EU FSF | 6,234 | |
| **Total** | **26,566** entries, **78,365** names and aliases, **124** sanctioned EVM addresses | parsed in 0.5s |

**Internal regression, not independent validation.** Working-tree `aml-1.1.0` results and snapshot hashes are in [identity comparison and evaluation gates](28-aml-identity-comparison.md). `aml/eval.ts` now fails on defined regressions, and all AML tests are included in CI.

| Metric | Value |
|---|---|
| In-list positive regression | 200 entries looked up using their own descriptors: 168 BLOCK, 32 REVIEW, zero ALLOW |
| Synthetic clean regression | 600 generated Korean names and 10 English names: zero holds; not an actual customer false-positive estimate |
| Normalization regression | Seven variants of one name caught: original, invisible characters, Cyrillic homoglyphs, diacritics, full width, reversed order, inserted punctuation; no general typo-recall claim |
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
methodsApplied = 0x90000  (working-tree aml-1.4.0)
  = SANCTIONS_SCREENED | JURISDICTION_CHECK
  PEP_SCREENED  bit 0, no data source connected
  ADVERSE_MEDIA bit 0, no data source connected
  ONCHAIN_EXPOSURE bit 0, graph/exposure analysis not implemented
```

Exact listed-wallet lookup is recorded separately and does not establish transaction-graph exposure analysis. Unsupported capability flags now reject startup; live vendor configuration alone cannot promote sandbox results to regime 1. See [check capabilities and migration conditions](30-check-capabilities.md). The FATF jurisdiction table's version travels in evidence; the inputs are self-declared nationality/residence, not independently verified citizenship.

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

The proposed recording kit lives in [docs/demo-video/](demo-video/). It is not a completed recording or current public-chain verification. Before filming, reconcile script/screens/addresses/policies with the approved release and run the preflight. The earlier eight-scene timing below is a storyboard, not proof that its operations fit an unedited three-minute execution.

| # | Scene | Seconds | What it shows |
|---|---|---|---|
| 1 | Cold open | 12 | A mark issued on Ethereum, verified on Creditcoin, gating a tokenised note |
| 2 | Live sanctions screening | 20 | Three real lists. A listed name blocks at risk band 5, corroborated by date of birth; unlicensed checks stay unset |
| 3 | Guided issuance at `/verify` | 28 | Wallet control, document, bank account, screening. The identity and bank vendors are labelled demo adapters and the mark discloses it in its regime field; the screening is real |
| 4 | Sepolia issuance | 20 | On Etherscan, with the `methods` bitmap visible in the mark |
| 5 | Attestation, as a labelled edit | 16 | The wait, cut under an on-screen caption naming the measured range. Never presented as real time |
| 6 | Creditcoin verdicts | 36 | Explain production-regime rejection separately from pilot attribute preview and actual current-witness eligibility; do not invent a missing-bit explanation |
| 7 | `GatedRwaNote` refuses, then allows | 28 | The gate reverting on an unverified recipient, then the same transfer landing. Remove Attestcoin and the gate stops working |
| 8 | Revocation, and a full dump of the on-chain data | 18 | Show delivered revocation and exact policy effect; defined cleartext identity fields are absent, while wallet-linked metadata and commitments remain public |

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
| R11 | Worker durability, signer ownership and distributed operation | high | Local lease/journal/crash/reorg tests exist; they do not guarantee no loss or safe N-worker shared-signing operation. Distributed fencing, backup recovery, monitoring and approved operational SLA remain T-16/T-17/T-21 work | before production operation |

---

## 12. Track

| Track | Assessment |
|---|---|
| **RWA** | Tokenised assets carry a legal requirement to screen holders, and `GatedRwaNote` as a credit note sits on Creditcoin's own ground. Chosen |
| DeFi | A gated lending pool works too, but this is the crowded track | second choice |
| AI, DePIN, Gaming | not a fit |

One more argument: every submission in the other four tracks is a potential customer. That any of them could add our SDK carries weight in due diligence.

---

## 13. Submission requirements and evidence status

The original requirement mapping is not an approval record. Current rules, dates, eligibility and final acceptance must be checked through the official submission process; this document does not establish them.

| Deliverable | Current status and remaining gate |
|---|---|
| Protocol integration | Historical public transactions and current local integrations exist. New-release public proof/runtime/lineage verification remains incomplete. |
| Technical documentation | Repository documents exist; this revision corrects several contradictory claims. Independent reproduction and final cross-document review remain required. |
| Testnet deployment | Section 9.5 is historical. The latest incompatible fixes require approved deployment and migration, not reuse of old success output. |
| Originality, ownership and team | Team statements are not independent IP, licence, incorporation, cap-table or eligibility verification. See T-52. |
| Public repository and integration summary | Prepared materials are not evidence that a reviewed release commit, URLs and current claims are synchronized. |
| Deck/PDF | Internal files exist. They do not prove current public-chain behavior or publication approval. |
| Video, team details and submission receipt | Final recording/URL, authorized team information, official eligibility review and accepted submission are not verified. |

Use [the final checklist](submission/FINAL-CHECKLIST.md) and the ticket ledger. No row is closed merely because a file or historical address exists.

---

## 14. Customer and investment hypotheses

The proposed first buyer is an issuer or asset operator that needs repeatable holder checks, durable evidence and a consumer-policy gate. The exact customer, gated action, jurisdiction, accepted provider, reuse rights and acceptable delay are still choices to validate through [design-partner discovery](18-design-partner-discovery.md). A wallet address, test token transfer or another hackathon project is not a qualified customer.

The commercial hypothesis is an issuance/operations/evidence service. Annual, usage-based and jurisdiction-adapter pricing are options, not accepted prices or contracted revenue. RPC/proof access, source and hub writes, witness refresh, vendors, storage, manual review, support and legal/security work all contribute to cost. No claim of free integration, unlimited resources or indefinitely free service follows from a historical testnet fee observation. [The unit-economics worksheet](43-unit-economics.md) explicitly uses synthetic assumptions pending real quotations and customer feedback.

Creditcoin's proposed value is a verifiable source-to-consumer provenance path that an independent issuer and consuming app actually use. That needs comparison with direct issuer signatures, an existing provider or a simpler allowlist under the customer's threat model. This repository does not establish exclusive technical capability, customer demand, durable read volume or protocol-token revenue. Spoke propagation/write-fee scenarios depend on a chosen, verified integration and current terms; they are not present product activity.

The team's stated VASP experience, roles and regulatory assessment history require documentary and reference checks under T-52. They must not be described as independently verified facts or proof that this implementation meets regulatory requirements.

Measure distinct independent issuers/apps, non-team retained users, paid customer actions, revenue and full operating cost separately from synthetic/developer/testnet activity. Report source-to-hub and revocation latency with defined start/end points and failure/timeout counts; percentile or SLA claims need a representative observation set. No customer KPI is populated by this plan. Funding amounts, milestones, conditions and investment decisions need the actual approving parties; the AI-authored review is not a foundation commitment.

---

## 15. Lines we hold

1. **No cleartext PII on chain.** No names, dates of birth, document numbers, or account numbers. Wallet-linked metadata and commitments are pseudonymous and linkable, not anonymous.
2. **No inherited legal permission.** Using a vendor does not settle our own processing duties or make its permissions ours. Provider execution and legal roles need evidence and approval.
3. **Asset effects are explicit.** Changing a gate can block transfers even without directly moving funds. Governance, correction, redemption and forced-action authority must be separately defined and approved.
4. **Demo substitutions are visible.** Synthetic providers, inputs, native proofs and edited waits are labelled. Sandbox bits are not live checks; local test success is not a public end-to-end result.
5. **No equivalence claims.** We never write that Korean KYC equals EU KYC. We publish the methods and the consumer decides.
6. **Documents describe what is live.** Nothing that exists only in the repository is described as deployed.
7. **No overstatement.** Timing claims state the observed version, endpoints, sample size and failures; a historical range is not an SLA.
8. **Test protocol necessity.** Compare this provenance path with simpler alternatives under the customer's requirements; do not assume the answer for the pitch.
9. **Prior work and rights are disclosed.** Originality, ownership, dependency licences and team history require the T-52 evidence; a narrative is not clearance.
10. **`.env` is never committed.** We do not copy the example repository's pattern (`01-env-verification.md` section 4).

---

## 16. Decisions

| # | Decision | Options | Outcome |
|---|---|---|---|
| D1 | Product name | Proofmark, AttestKYC | **Proofmark**, and only Proofmark. For an international product the English name has to carry, and this one comes straight from "proof plus mark", so the name explains the design. No secondary or Korean name anywhere in the product; an earlier draft had put one in the wordmark without approval, and it was removed |
| D2 | Track | RWA, DeFi | **RWA** |
| D3 | Prior project assets | port the code, or carry knowledge only | **knowledge only**, per R4 |
| D4 | KR adapter target | Approved vendor operation or labelled fixtures | Live connectors remain the target; built-in demo and local HTTP fixtures are what the connected tests currently use. Actual institutional execution/reuse rights are not established by wire-format tests |
| D5 | Second jurisdiction | ePassport NFC, EU, US | Earlier preference: ePassport NFC. No implementation, trust-list/device assessment, customer need or legal acceptance is established; do not prioritize expansion without evidence |
| D6 | Team and submission details | Actual eligible team | Team roster, roles and required official-form details remain to be confirmed with the people concerned |
| D7 | Spoke integration | Customer-selected chain and trust model | Undecided; no current mirror delivery date or deployment authority |
| D8 | Issuer isolation | Independent scoped credentials or enforced single issuer | **Pending user decision.** Three local T-06 isolation acceptance cases remain red; do not treat a request to continue implementation as a choice between these products |

---

## 17. What is left

The [full ticket ledger](../TICKET.md) retains all 56 completion conditions. Principal dependencies are:

1. Decide T-06, implement the chosen scope across contracts/policies/rosters/recovery, and approve disposition of ambiguous legacy restrictions.
2. Choose the actual customer/gated action/provider and obtain permitted access/reuse, qualified processing/retention review and independent security review.
3. Approve managed storage/key custody, ownership, backup/recovery, monitoring and real operating limits; install and verify them rather than counting local tools as deployment.
4. Complete authorized new-release source/proof/worker/hub/witness/consumer reproduction with synchronized current data, runtime pins and migration records.
5. Reconcile all public materials, current official submission requirements and team/IP evidence; obtain approval before final recording, upload or submission. None of these external actions is authorized by this plan alone.
