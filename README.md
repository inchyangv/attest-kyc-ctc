# Proofmark

**Verify once. Carry the result to every chain.**

A KYC and AML attestation layer. Screening results are issued on Ethereum, verified on Creditcoin through the Attestcoin Protocol with no oracle operator in between, and read by any chain that wants them. No personal data goes on chain.

Built for BUIDL CTC 2026 Fall. Track: RWA.

---

## 1. The problem

Once on-chain finance sits inside a regulatory perimeter, every service opens with the same question: **may I transact with this wallet?**

There are three ways to answer it today and none of them are good. Build KYC again on each chain, and the vendor contracts, the integration work and the data-controller obligations multiply by the number of chains. Trust a signing server, and one key becomes the whole security model. Trust a relayer, and you have moved the trust rather than removed it.

Crossing a border adds a second problem. "KYC complete" names different work in different places. Korea's non-face-to-face identification requires two independent checks from a fixed list. eIDAS grades assurance on its own scale. US CIP asks for a specific set of identifiers. A single boolean cannot carry any of that.

## 2. What Proofmark does

**A mark carries the checks that were performed, not a verdict.** Sixteen bits record what actually happened: document authenticity, liveness, bank account verification, sanctions screening, jurisdiction, on-chain exposure. Each consumer applies its own policy to those bits and reaches its own conclusion. We publish evidence; we do not assert that Korean KYC equals EU KYC.

**Attestcoin makes the mark portable without a trusted party.** The mark is issued on Ethereum. Creditcoin verifies its inclusion proof inside a single block through the BlockProver precompile. Nobody has to believe us.

**On-chain personal data is zero bytes.** What travels is two 32-byte commitments and a bitmap.

---

## 3. Attestcoin Protocol integration

The scoring criteria ask how deeply a submission uses the protocol. The test we hold ourselves to: remove Attestcoin and see what survives.

| Remove Attestcoin | What is left |
|---|---|
| Creditcoin has no way to learn what Ethereum issued | A relayer we operate, which is the trust the product exists to remove |
| Epoch roster roots cannot be checked | Issuer signatures, back to trusting one key |
| A spoke chain's mirror cannot be disproven | Trusting the mirror operator |

### Where the protocol is used

| Where | What |
|---|---|
| `worker/` | Polls attested height, fetches the inclusion proof, submits to the ASC |
| `src/ASCBaseX.sol` | Fork of `ASCBase` that passes `chainKey` and `blockHeight` to the handler. Section 5 explains why |
| `src/ProofmarkASC.sol` | Verifies through the BlockProver precompile inside one Creditcoin block |
| `src/ComplianceSource.sol` | `issueBatch` and `revokeBatch` put N events in one transaction, so one `execute()` applies all of them |
| `script/check_chains.ts` | Reads chainKey from the ChainInfo precompile at deploy time rather than hardcoding it |

### Why the design batches

Reads are free on Attestcoin. The official wording is "reading other chains stays free," and our measurement agrees: the `execute()` call deducted exactly its gas cost and no protocol fee. So we do not claim to generate ATC demand. We do not have that story and will not invent one.

Batching is driven by Ethereum L1 instead. A hundred thousand users means a hundred thousand L1 issuance transactions, and the issuer pays that gas. An epoch roster root fixes L1 writes at one transaction per epoch regardless of how many subjects it covers.

---

## 4. Reproduce it in five minutes

### Deployed contracts

| Contract | Chain | Address |
|---|---|---|
| `EvmV1Decoder` | CC3 Testnet (102031) | `0xff3558704c75ed69e1D657474210365b24d31938` |
| `ProofmarkASC` | CC3 Testnet | `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` |
| `ProofmarkRegistry` | CC3 Testnet | `0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc` |
| `ComplianceSource` | **Sepolia** (11155111) | `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` |
| `GatedRwaNote` | CC3 Testnet | `0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625` |

The ASC and ComplianceSource share an address. Same deployer, same nonce, different chains, so CREATE produces the same result. The bytecode differs and the first command below shows it.

### Two subjects

| Subject | Story |
|---|---|
| `0xb8FEBEaB3705793474fA05b91Bf5D205855dD3c1` | Issued through the honest pipeline. Passes the pilot policy, fails production |
| `0xFD1222e35a536A62f180aA44826656940e86bD5E` | Revoked. Its `methods` were hand-authored during pipeline testing and claimed checks we never ran |

### Commands

```sh
CC3=https://rpc.cc3-testnet.creditcoin.network
SEP=https://ethereum-sepolia-rpc.publicnode.com
ASC=0x93C62D3016123Da0aBdB4AC1857564c30CbE5629
REG=0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc
NOTE=0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625
SUB=0xb8FEBEaB3705793474fA05b91Bf5D205855dD3c1

# 1. one address, two different contracts
cast code $ASC --rpc-url $CC3 | wc -c      # 18121  ProofmarkASC
cast code $ASC --rpc-url $SEP | wc -c      #  7479  ComplianceSource

# 2. the ASC accepts proofs from one chain only
cast call $ASC "expectedChainKey()(uint64)" --rpc-url $CC3     # 1, Sepolia
cast call $ASC "sourceContract()(address)"  --rpc-url $CC3

# 3. the mark that crossed over. Note the field order: origin is second
cast call $ASC "getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))" $SUB --rpc-url $CC3
#   status 1 ACTIVE, origin 1 Direct, kind 1, assurance 1, regime 2 sandbox,
#   jurisdiction 410 KR, methods 0x190001

# 4. the same mark under two policies
cast call $REG "isVerified(address,uint256)(bool)" $SUB 1 --rpc-url $CC3   # false, KR VASP production
cast call $REG "isVerified(address,uint256)(bool)" $SUB 2 --rpc-url $CC3   # true,  KR pilot
```

Two notes for anyone reproducing this.

**Pass `--from` to `cast call`.** Without it msg.sender is zero, `onlyOwner` fires before the gate, and you get `OwnableUnauthorizedAccount` (`0x118cdaa7`) instead of the gate's `RecipientNotVerified` (`0x17887111`). Both look like a revert and mean different things. We walked into this ourselves.

**`missing field mixHash` from forge and cast on CC3 is harmless.** Creditcoin runs on Substrate and its block format differs. Every operation still succeeds.

### The gate in action

`GatedRwaNote` refuses every mint and transfer unless both sides pass deployed policy #1, and until this run no address on CC3 passed it, so only the deny half of the gate had ever fired. Two fresh subjects were issued marks through the local pipeline to close that gap. Both went through the real reconciliation and the real screening against the same 26,566 loaded entries, but the two regulatory checks were answered by the built-in demo vendors: the evidence names `demo:id` and `demo:bank` with `live: false`, no institution was queried, and the mark says so itself — `regime = KR_FSC_NONFACE_SANDBOX`, the same disclosure `/verify` writes under `KYC_DEMO=1`. Both marks carry `methods 0x190027` and `assurance 3`. Policy #1 was not modified to let them through: it still reads `requireAll = 0x10024`, `minAssurance = 2`, `maxAge = 0`, `requireRoster = false`, and the last command below re-reads that from chain. This run demonstrates the gate, not a production onboarding.

| Subject | Role | Address |
|---|---|---|
| A | holder. Passes policy #1, signs the transfers | `0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2` |
| B | recipient. Passes policy #1 | `0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee` |
| C | control. Never issued to, never funded, passes nothing | `0x680Cc6e52d80F8f3759C7d7209f576CedCE7F2C5` |

| Chain | Block | Action | Transaction | Result |
|---|---|---|---|---|
| Sepolia | 11607741 | `ComplianceSource.issueBatch`, both marks in one transaction | `0x02cdf784fb7808b3d44b37a6e43b9145d7666519aca51d5497d4264bf3857c55` | status 1 |
| CC3 | 5407725 | 0.2 tCTC to A, so A can pay its own gas | `0xdfb2b58105bafc298475d600077376d11a6ad2e4b0b0837227e8d601efbea9e9` | status 1 |
| CC3 | 5407761 | worker `execute`, applying both `MarkIssued` logs | `0x2d97cd34a44cb08cbafa82dcb159c01f4a3add85014a0793697ecf3cfa1d7af9` | status 1. `isVerified` turns true for A and B |
| CC3 | 5407782 | `mint(A, 100 KRCN)`, owner only, gate checks the recipient | `0x9a58b27face8bedeb49eab2d1cd21cc541d96c8880c49b4ee865639652b6db0e` | status 1 |
| CC3 | 5407786 | A sends 1 KRCN to C, gas limit forced past estimation so the revert lands on chain | `0x121b0d4f4213ba533e0284ec5e78db9d0d8054a970dee8947ab027f39528f18e` | **status 0, reverted.** The gate blocked it |
| CC3 | 5407787 | A sends 40 KRCN to B | `0x6ec9dbedd37daa607a0df4e50026e61a049c620ce81981afa5f4ebdb39e431ce` | status 1 |

Propagation measured on this run: the Sepolia block carrying `issueBatch` is stamped `2026-08-31T19:30:12Z` and the CC3 block that materialised both marks is stamped `2026-08-31T19:39:30Z`, so **9m 18s** from issuance to `isVerified`. Both marks rode one attestation — the worker recorded two `MarkIssued` logs under that one source transaction — so the figure is the same for A and B. The worker's own job record puts the same round trip at 561s, three seconds longer, because it stamps the moment it wrote the CC3 receipt rather than the block. One run, one number, on the testnets named above — section 6 keeps the earlier observations separately.

```sh
CC3=https://rpc.cc3-testnet.creditcoin.network
REG=0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc
ASC=0x93C62D3016123Da0aBdB4AC1857564c30CbE5629
NOTE=0xA8Dfe6f5063a8159524DedbBAc75f034C3BF0625
A=0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2
B=0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee
C=0x680Cc6e52d80F8f3759C7d7209f576CedCE7F2C5

# both sides of the successful transfer pass the production policy, the control does not
cast call $REG "isVerified(address,uint256)(bool)" $A 1 --rpc-url $CC3     # true
cast call $REG "isVerified(address,uint256)(bool)" $B 1 --rpc-url $CC3     # true
cast call $REG "isVerified(address,uint256)(bool)" $C 1 --rpc-url $CC3     # false

# the token's own preflight view, before anyone spends gas
cast call $NOTE "canTransfer(address,address)(bool)" $A $C --rpc-url $CC3  # false
cast call $NOTE "canTransfer(address,address)(bool)" $A $B --rpc-url $CC3  # true

# the revert, reproduced as a call. --from is what exercises the sender-side check
cast call $NOTE "transfer(address,uint256)" $C 1000000000000000000 --from $A --rpc-url $CC3
#   revert 0x17887111  RecipientNotVerified(0x680Cc6e5…, 1)   the gate
# drop --from and msg.sender is zero, which the gate exempts as the mint path:
cast call $NOTE "mint(address,uint256)" $A 1000000000000000000 --rpc-url $CC3
#   revert 0x118cdaa7  OwnableUnauthorizedAccount(0x0)        not the gate, just onlyOwner

# what the successful transfer moved, and the mark that allowed it
cast call $NOTE "balanceOf(address)(uint256)" $B --rpc-url $CC3            # 40000000000000000000
cast call $ASC "getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))" $A --rpc-url $CC3
#   status 1 ACTIVE, origin 1 Direct, kind 1, assurance 3, regime 2 sandbox,
#   jurisdiction 410 KR, methods 0x190027

# the policy the two marks were measured against, unchanged
cast call $REG "policies(uint256)(uint32,uint8,uint40,bool,bool)" 1 --rpc-url $CC3
#   65572 (0x10024), 2, 0, false, true
```

The deny half needs no new transaction. Of the 101 KRCN outstanding, 1 was minted before any of this and sits in `0xFD1222e35a536A62f180aA44826656940e86bD5E`, the wallet whose mark we revoked — the "One mark on chain was revoked by us" bullet under "Other limits" in section 8 records that revocation and what its propagation cost. `canTransfer` from that wallet is false today, so the balance cannot move: same gate, same policy that just let A pay B.

### Web demo

Hosted, nothing to install: **https://attest-kyc.stabled.ai**. The same production build is also served at https://proofmark-swart.vercel.app, so one dead domain cannot take the demo down.

Or run it locally:

```sh
cd web && npm install && npm run dev
```

`scripts/check-demo-urls.sh` checks both hosted URLs — the three pages and the three API routes behind them — and exits non-zero if any of them is down.

`/` runs live sanctions screening against the real lists. `/onchain` reads Creditcoin and shows the same mark passing one policy and failing the other.

---

## 5. Architecture

```
Ethereum Sepolia (chainKey 1)             where issuance happens
  ComplianceSource.sol
    MarkIssued / MarkRevoked / SanctionDenied / RosterEpochPublished
            |
            | worker watches
  Offchain  |- KR adapter: ID document, bank account
            |- reconciliation: declared details, document, account holder
            |- AML engine: 26,566 entries from OFAC, UN and EU
            |- evidence: hash chain per step
            |- worker: waits for attestation, fetches proof, submits
            |
            | merkle proof + continuity proof
Creditcoin CC3                            the chain of record
  ProofmarkASC       BlockProver verification, source pinning, ordering cursor
  ProofmarkRegistry  isVerified(subject, policyId)
  GatedRwaNote       an RWA note that only moves between wallets a policy accepts
```

### Why `ASCBase` is forked

`ASCBase.execute()` receives `chainKey` and `blockHeight` and passes neither to the handler. Inheriting it directly leaves two holes.

| Hole | What it allows | Fix |
|---|---|---|
| No `chainKey` | CC3 serves Sepolia (1) and Ethereum mainnet (3) at once. A handler that only checks `log.address_` accepts a forged event from a same-address contract on the other chain, and CREATE2 makes that address cheap to arrange | `require(chainKey == expectedChainKey)` |
| No `blockHeight` | Proof submission is permissionless and unordered. Submit an old `MarkIssued` after a `MarkRevoked` and the dead mark comes back. The queryIds differ, so replay protection does not catch it | `lastAppliedHeight` cursor |

Both guards are mutation tested. Remove either one and exactly its test fails.

---

## 6. Measurements

### Cross-chain propagation

| Step | Value |
|---|---|
| Sepolia issuance | 27,933 gas |
| Worker sees the event | 86 seconds later |
| Attestation completes | 6.5 to 8.5 minutes, two observations |
| CC3 proof verification | 386,008 gas |
| Issuance to `isVerified` true | 7m 55s and 10m 48s across two runs |

We do not describe revocation as instant. Source chain finality sets a floor, so the number is published as a product parameter. Anything needing real-time blocking has to gate on the source chain.

### AML screening

No fixtures. `bash aml/fetch-lists.sh` pulls 57MB of source XML.

| | |
|---|---|
| Loaded | OFAC SDN 19,321, UN 1,011, EU FSF 6,234. 26,566 entries, 78,365 names, 124 sanctioned EVM addresses |
| Recall | 100%. 200 listed individuals looked up by their own name, date of birth and country |
| Specificity | 100%. 600 ordinary Korean names plus 10 western names, zero false positives |
| Evasion | 7 of 7: invisible characters, Cyrillic homoglyphs, diacritics, full width, reversed order, inserted punctuation |
| Wallet | Blocked on address alone, regardless of name |

Romanised expansion is our inference, not something a list asserts.

```
Kim Jong Un   KP, date of birth matches   BLOCK  band 5   expansion hit, corroborated
Choi Yeong-ho KR                          ALLOW  band 2   expansion hit, nothing corroborates it
```

Strip the diacritics and Choi Yeong-ho scores 100 against a different listed person, Choi Yong-ho. A test reproduces that collision. Letting expansion drive decisions produced a 33% false positive rate; refusing to let it drive them produces zero, and Kim Jong Un is still caught. So an uncorroborated expansion hit stays in the evidence and stays out of the decision.

---

## 7. Setup

```sh
forge build && forge test                       # 45 tests

npm install
bash aml/fetch-lists.sh                         # source lists, not committed
npx tsx --test "worker/*.test.ts" "pipeline/*.test.ts" "aml/*.test.ts"   # 134 tests
npx tsx aml/eval.ts                             # screening measurements

cp .env.example .env                            # fill in the keys
./script/deploy.sh preflight                    # checks only, no transactions
./script/deploy.sh deploy

npm run worker                                  # start this before issuing
```

`EVIDENCE_HMAC_KEY` is required. Generate it with `openssl rand -hex 32`. The engine refuses to start without one, and there is no default, because a default is what someone ships.

Start the worker before issuing. Its cursor begins at the current head, so an event emitted first is never seen. Set `WORKER_START_BLOCK` if you need to catch up.

---

## 8. What runs and what does not

This section stays. What we did not do is part of what the product is.

### Bits we can set honestly

| Bit | Status | Why |
|---|---|---|
| `WALLET_CONTROL` | yes | EIP-4361 signature, verified server side |
| `SANCTIONS_SCREENED` | yes | 26,566 entries from three real lists |
| `JURISDICTION_CHECK` | yes | FATF table, marked unverified against the source and recorded that way in evidence |
| `ONCHAIN_EXPOSURE` | yes | 124 sanctioned wallets from OFAC |
| `ID_DOC_AUTHENTICITY` | yes, with the vendor configured | CODEF against Government24 (resident registration card) or the Korean National Police Agency's Traffic Civil Service 24 (driver licence), logged in with the issuer's certificate. `pipeline/adapters/codef.ts` |
| `BANK_ACCOUNT` | yes, on production rails | Holder name from the bank against the real-name number, then one won with a code the customer reads back. KFTC Open Banking (`pipeline/adapters/openbanking.ts`) or CODEF. The KFTC testbed runs the same API without moving money and is recorded as not live, so it sets nothing |
| `FACE_MATCH`, `LIVENESS` | no | No face vendor connected |
| `PEP_SCREENED`, `ADVERSE_MEDIA` | no | Commercial datasets we have not licensed |

The flow is at `/verify`: wallet signature, document photo and OCR, authenticity with the authority (including the captcha or app-approval leg the authority may demand), holder name and the one-won code, then screening and `ComplianceSource.issue()`. Vendor credentials go in `web/.env.example`'s `CODEF_*`, `OPENBANKING_*` and `ISSUER_PRIVATE_KEY`. Without them the step reports which variables are missing.

### Demo mode, and what onboards today

| Axis | Self-service today | How | Result |
|---|---|---|---|
| ID document | **yes**: CODEF demo tier + app-based authentication | Sign up at codef.io, apply for the demo service, and copy `clientId` / `clientSecret` / `publicKey` from Key Management. Set `CODEF_ENV=demo`, `CODEF_LOGIN_TYPE=simple`, `CODEF_SIMPLE_LEVEL=1` (KakaoTalk), and the operator's name, phone, and resident number. Each check prompts for approval in the operator's app, then Government24 or Traffic Civil Service 24 answers for real | live, bit set, regime production |
| Bank account | testbed only: KFTC Open Banking | Register at developers.kftc.or.kr, create a test app, set `OPENBANKING_*` with `OPENBANKING_ENV=test`. The real API answers with canned data and moves no money | not live |
| Bank account, real | no: KFTC participating-institution registration or the CODEF partnership contract | weeks, and a contract | live, bit set |

`KYC_DEMO=1` fills any axis that has no real vendor with the built-in demo vendor (`pipeline/adapters/demo.ts`): same inputs, same procedure, no institution asked. The page says so, the one-won code is shown on the page in place of the bank app, the evidence names `demo:*`, and the mark carries `regime = KR_FSC_NONFACE_SANDBOX`. Under demo the bits are set anyway (`KYC_DEMO_BITS=1`), so the flow ends with a mark that passes policy #1; set `KYC_DEMO_BITS=0` to keep them unset. A name containing `FAKE` is rejected by the demo authority and an account ending in `99` belongs to someone else, so both outcomes can be shown. Real and demo mix per axis: with CODEF configured and no bank vendor, the document is checked for real and the account is demo.

### The two deployed policies

| policyId | Name | requireAll | A mark from the pipeline |
|---|---|---|---|
| 1 | KR VASP production | `0x10024`: document authenticity, bank account, sanctions | passes only when both regulatory checks ran against live rails |
| 2 | KR pilot | `0x190001`: wallet control, sanctions, jurisdiction, on-chain exposure | passes |

We did not lower policy 1 to make our own mark pass. A standard you relax to fit yourself is not a standard.

> The mark deployed on CC3 today was issued before the vendors were wired and does not pass the production policy. It says so on `/onchain`. A mark issued through `/verify` with CODEF on demo or production and Open Banking on production carries both bits and passes.

That is the design. A check that did not run, or ran against a testbed, is a zero bit, and a zero bit is what lets a consumer policy reject the mark. `pipeline/pipeline.test.ts` pins every case: no vendor, a sandbox answer, an authority that says no, a code never read back.

### Other limits

- **Writability is unused.** Attestcoin's cross-chain write is still in development, so pushing state to spoke chains is roadmap, not fact.
- **Epoch rosters (Mode B) are built but not published on chain.** Every deployed mark is `origin = Direct`, which proves issuance and says nothing about a revocation that was never submitted. `Policy.requireRoster` exposes that difference rather than hiding it.
- **The FATF table is unverified** against the source. `jurisdiction.ts` marks it `verified: false` and the evidence carries that through.
- **One mark on chain was revoked by us.** Its `methods` were hand-authored and claimed checks we never performed. Revoking it cost 8m 43s of propagation and is visible at `/onchain?subject=0xFD1222e35a536A62f180aA44826656940e86bD5E`.

---

## 9. Tests

```
Solidity     45   ASC 14, Registry 14, GatedRwaNote 7, RosterProof 7, QueryId 2, AttrsVector 1
TypeScript  134   worker 11, pipeline 106, AML 17
```

The ones worth reading:

| Test | What it holds |
|---|---|
| `test_RejectsProofFromWrongChain` | chainKey spoofing, mutation tested |
| `test_StaleIssueCannotResurrectRevokedMark` | reordering attack, mutation tested |
| `test_SameMarkDifferentJurisdictionPolicies` | one mark, two answers |
| `our own mark cannot pass the KR VASP production policy` | honesty |
| `screening that did not run leaves its bit unset` | honesty |
| `the real engine leaves no cleartext PII in the evidence` | privacy boundary |
| `catches Hangul stored as NFD, decomposed into jamo` | the detector itself |

That last one exists because the first PII check reported clean and was wrong. The engine stored the name in NFD, `includes()` compared against NFC, and the two never matched. A PII detector that fails on Korean names is not something to leave in a product that screens Korean names.

---

## 10. Documentation

| File | |
|---|---|
| `docs/00-hackathon-brief.md` | Competition requirements |
| `docs/01-env-verification.md` | Attestcoin environment verification |
| `docs/02-loan-flow-analysis.md` | Tutorial 4 analysis |
| **`docs/03-product-plan.md`** | Product, architecture, data model, scope, measurements |
| `docs/04-event-schema.md` | The four source events |
| `docs/05-asc-integration-review.md` | `ASCBase` integration review |
| `docs/06-worker-design.md` | Worker design |
| `docs/07-kyc-vendors.md` | KYC vendors: what is real, what is demo, how to connect each |
| `web/DESIGN.md` | Design system |

## Originality

Everything here was written during the hackathon. The team previously built an EAS-based compliance attestation layer on the GIWA chain. What carried over is domain knowledge, specifically the AML normalisation rules and the fail-closed principles. No code carried over.
