# BUIDL CTC 2026 Fall: competition brief

> 2026-08-30 · Tech Lead / PO
> Sources: the competition announcement in full, https://attestcoin.org and https://docs.attestcoin.org

---

## 1. TL;DR

| Item | Detail |
|---|---|
| Competition | BUIDL CTC 2026 Fall, "BUIDL For The Real World" |
| Host | Creditcoin and Credit Labs |
| Required theme | Attestcoin Protocol integration, formerly Universal Smart Contracts. No exceptions |
| Tracks | DeFi, RWA, DePIN, Gaming, AI. Pick one |
| Prize pool | $15,000: $10,000, $3,000 and $2,000 |
| Extras | Top three get a CEIP fast track, skipping initial screening straight to due diligence, plus CertiK audit credits |
| Deadline | 2026-09-13 23:59 ET, which is 2026-09-14 12:59 KST |
| Time remaining | D-14 as of 2026-08-30 |
| Minimum team | one person |
| Deployment | Testnet deployment is required, CC3 Testnet and Ethereum Sepolia |

**The judgement that matters.** The CEIP fast track is worth more than the $15,000, which means judges are looking for something investable rather than a hackathon demo. Scope accordingly: a working minimum product with a clear market argument, not a toy.

Related: [01-env-verification.md](./01-env-verification.md), the environment verification report.

---

## 2. Required theme: Attestcoin Protocol

> "Every submission this season must leverage the Attestcoin Protocol."

Attestcoin extends Creditcoin into verified cross-chain data and messaging. Apps on Creditcoin can use attested data from other chains and run cross-chain business logic without depending on a centralised oracle operator.

What the hosts say they are looking for:
- trustless cross-chain DeFi
- tokenised real-world assets
- game economies
- verifiable governance

---

## 3. Timeline

| Date | Event | Status |
|---|---|---|
| 2026-08-13 | Submissions open | done |
| 2026-08-18 | Online AMA, [recording](https://youtu.be/HPL6LjTqQm4) | held. Worth watching |
| 2026-09-13 23:59 ET | Submission deadline, extended | D-14 |
| 2026-09-20 | Winners announced | |

### Working backwards from the deadline

| Window | Goal | Output |
|---|---|---|
| 8/30 to 9/01 | Settle the idea and the track, design the integration points, complete `Hello Bridge` | Architecture document, integration spec |
| 9/02 to 9/07 | Core implementation: source contract, worker, ASC | Deployed to Sepolia and CC3, one successful end-to-end run |
| 9/08 to 9/10 | Frontend, integration tests, README and technical documentation | An app that can be demonstrated |
| 9/11 to 9/12 | Demo video, deck or whitepaper PDF, fill in the form | Everything the submission needs |
| 9/13 | Submit at least twelve hours early, targeting 01:00 KST on 9/14 | Submitted |

> The deadline is 12:59 on a Monday, Korean time. The work finishes over the weekend, and Sunday night is not a buffer.

---

## 4. Prizes and benefits

- **$15,000 in prizes**
  - $10,000, $3,000 and $2,000
- **CertiK, for every winning team**
  - 8K in credits toward a repository audit
  - three months of Skynet Boost
  - CoinMarketCap listing support is not included
- **CEIP fast track for the top three**

### CEIP (Creditcoin Ecosystem Investment Program)

- An investment programme run by Credit Labs, backing companies and individuals building products that strengthen and extend the Creditcoin ecosystem.
- What it offers: early investment with follow-on funding or grants possible, engineering and product advice from the Creditcoin team, and access to their partner network of ecosystem partners and VCs.
- The fast track skips initial screening and goes straight to due diligence, which shortens the path to an investment decision.

---

## 5. The five tracks

| # | Track | How the hosts define it | Note |
|---|---|---|---|
| 1 | DeFi | Lending, trading, liquidity and yield on Creditcoin, showing the network can run practical and transparent on-chain finance | The most crowded |
| 2 | RWA | Tokenising, managing and financing real assets, connecting off-chain value to on-chain transparency | Creditcoin's home ground in credit and lending, and aligned with the hosts' story |
| 3 | DePIN | Cross-chain data driving incentives, settlement and coordination for hardware and sensor networks | Hard to demonstrate without hardware |
| 4 | Gaming | Games and game infrastructure with in-game economies, asset ownership and player-driven marketplaces | Hard to finish to a decent standard in fourteen days |
| 5 | AI | Apps that process cryptographically verified cross-chain data, decide autonomously and trigger on-chain transactions without a centralised oracle | A strong story, with an obvious risk of being AI in name only |

**How to pick.** What Attestcoin can actually do today is let Creditcoin read what happened on Ethereum without trusting anyone. The more a product depends on that, the better it scores. An app with an oracle bolted on loses on integration depth.

---

## 6. Requirements

### 6.1 Eligibility, for every member
- no criminal record
- no pending criminal proceedings
- not resident in a sanctioned country
- not a sanctioned person
- permitted to participate under local law

### 6.2 Attestcoin integration, a core scoring criterion
> "Projects must demonstrate a meaningful and functional integration with the Attestcoin Protocol."

A complete submission needs:
1. working Attestcoin integration code inside the project
2. technical documentation covering setup and how the protocol is used
3. depth of protocol use, which is scored

### 6.3 Project requirements
- original work created during the hackathon
- deployed to a testnet
- Attestcoin integrated as a core feature
- no third-party IP infringement

### 6.4 Terms
- everything submitted is accurate and truthful
- full rights and ownership of all submitted code, content and material

---

## 7. Submission checklist

### Project
- [ ] Project Name
- [ ] Project logo, an image URL in PNG, SVG or AI (optional)
- [ ] Project sector: DeFi, RWA, DePIN, Gaming or AI
- [ ] Project Description
- [ ] **Attestcoin Protocol integration summary**, describing how the protocol is used. The most important thing written
- [ ] **GitHub repository URL**, README required
- [ ] **Deck or whitepaper**, a PDF URL
- [ ] **Prototype Demo Video URL**

### Team, per member
- [ ] First & Last Name
- [ ] Email
- [ ] Telegram ID (optional)
- [ ] X / Twitter (optional)
- [ ] LinkedIn (optional)
- [ ] Resume PDF URL (optional)
- [ ] Short Bio
- [ ] Role within the team
- [ ] Country of Residence
- [ ] Country of Citizenship

### Team size
- minimum one

> **Hosting.** The logo, the PDF and the video all need public URLs. Arrange them in advance through GitHub Pages, a shared Google Drive link, an unlisted YouTube video or similar.

---

## 8. Attestcoin Protocol, technical summary

### 8.1 In one line
A cross-chain interoperability hub that lets smart contracts on Creditcoin read, and eventually write to, supported chains. It locks no assets the way a bridge does, custodies no funds, and moves only verified information.

### 8.2 Trust model
- Instead of a central oracle operator, a network of independent attesters stakes real value and checks each chain's data directly.
- "proof, not a promise": mathematics rather than trust in an intermediary.
- No single point of failure.

### 8.3 Components

| Component | Role |
|---|---|
| Attesters | Independent verifiers attesting source chain block headers |
| ASC, Attestcoin Smart Contract | Deployed on Creditcoin, verifies proofs and runs business logic |
| BlockProver precompile | Verifies a transaction proof synchronously inside one Creditcoin block, at `0x...0FD2` |
| ChainInfo precompile | Supported chains and attestation status, at `0x...0fd3` |
| Proof Builder service | Generates Merkle and continuity proofs, offered as a hosted API |
| Offchain worker | Watches source chain events, waits for attestation, fetches the proof, calls the ASC |

### 8.4 The readability pipeline
1. **Attestation.** Attesters attest source chain blocks to Creditcoin, with continuity proving.
2. **Transaction proving.** A Merkle proof establishes inclusion, with continuity proving for the query.

- **Speed.** Verification completes within about one block, roughly 15 seconds, after source chain finality.
- **Batching.** Up to ten queries can share one continuity proof, within a 1000-block window.
- **Writability**, meaning cross-chain execution, is still in development. Readability is the axis that works today.

### 8.5 The recommended dApp pattern

```
[User] → Source Chain Contract (Ethereum Sepolia)
             │  optional onchain logic (e.g. burn)
             └─ emit Event
                    ↓ (watch)
             Offchain Worker
                    ├─ waitUntilHeightAttested()
                    ├─ ProofBuilder.getProof(txHash)  → merkleProof + continuityProof
                    └─ call ASC(proof, txData)
                              ↓
             ASC on Creditcoin
                    ├─ synchronous verification via the BlockProver precompile
                    └─ run business logic, in the ASC or a dApp contract
```

**Practices the documentation states**
- One source contract per dApp, emitting every protocol-related event
- Unambiguous events: a distinct type per query, such as `LoanInitiated` against `LoanRepaid`
- Names that state the intent, such as `TokensBurnedForBridging`
- Avoid standard events: `TokensBurned` rather than a generic `Transfer`
- Complete data: every field the ASC needs is in the event

### 8.6 SDK

```sh
npm install @gluwa/usc-sdk    # peer dep: ethers v6
```

| API | Purpose |
|---|---|
| `PrecompileChainInfoProvider.getSupportedChains()` | Supported chains and their `chainKey` |
| `proofBuilder.waitUntilHeightAttested()` | Wait until the target block is attested |
| `proofBuilder.getProof(txHash)` | Fetch `merkleProof` and `continuityProof` |
| `PrecompileBlockProver.verifySingle()` and `verifyBatch()` | Submit a proof for on-chain verification |
| `RawProofBuilder` | Compute locally instead of using the hosted API, same interface |

### 8.7 Environments and addresses

**CC3 Testnet, what we use**
| Item | Value |
|---|---|
| Supported source chains | Ethereum Sepolia at chainKey `1`, Ethereum mainnet at chainKey `3` |
| ASC dashboard | https://dashboard.cc3-testnet.creditcoin.network/ |
| Proof Builder API | https://proof-gen-api.cc3-testnet.creditcoin.network/ |
| Decoder Contract | `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` |
| ChainInfo Precompile | `0x0000000000000000000000000000000000000fd3` |
| BlockProver Precompile | `0x0000000000000000000000000000000000000FD2` |

**CC3 Mainnet, for reference**
| Item | Value |
|---|---|
| Supported source chain | Ethereum mainnet at chainKey `1` |
| ASC dashboard | https://dashboard.cc3-mainnet-usc.creditcoin.network/ |
| Proof Builder API | https://proofbuilder.cc3-mainnet-usc.creditcoin.network/ |
| Decoder Contract | `0x9D094C9f22B10FCf842c2fC6A0981630A4F94B5C` |

> On testnet Sepolia is chainKey `1` and mainnet is `3`. Do not confuse either with an EVM chainId. Always confirm at runtime through `getSupportedChains()`.

### 8.8 Guided tutorials, in order
1. **Hello Bridge**, a first cross-chain transaction
2. **Custom Contract Bridging**
3. **Bridge Off-chain Worker**, running the worker
4. **Cross-Chain Loan dApp**, the capstone

Example repository: https://github.com/gluwa/attestcoin-protocol-examples
The documentation marks these as educational and warns against deploying them directly. The videos still use the old USC name.

### 8.9 The ATC token
- Fixed supply of 10 million ATC, no inflation
- Free reads, paid writes. Cross-chain actions cost ATC
- Fees are burned, which makes the design deflationary and funds attester rewards

---

## 9. Strategy notes

1. **Scoring turns on integration depth.** The announcement says so directly: "Depth of Attestcoin Protocol utilization will be evaluated as one of the core scoring criteria." The design has to fall apart without Attestcoin. A single data lookup is weak.
2. **Bet on readability.** Writability is still in development. To demonstrate anything reliably in fourteen days, build on the axis that works: a fact on Sepolia, verified trustlessly on Creditcoin, driving an on-chain action.
3. **For CEIP, the narrative is half the work.** What follows judging is due diligence. A deck with no market, no users, no revenue model and no answer to "why Creditcoin" does not reach the top three.
4. **Testnet deployment and a public verification path are not optional.** Put contract addresses, example transaction hashes and dashboard links in the README so a judge reproduces it in five minutes.
5. **Keep the video under three minutes and give the proof scene room.** The Sepolia transaction, the wait for attestation, and verification succeeding on Creditcoin all have to be visible.
6. **The README is how the technical documentation requirement gets met.** Documenting setup and protocol use is an explicit requirement.

---

## 10. Open questions

> Environment items were verified on 2026-08-30. See [docs/01-env-verification.md](./01-env-verification.md).

**Closed**
- [x] ~~Gas tokens for CC3 and a Sepolia RPC~~ A public Sepolia RPC removes the need for Infura, and both faucet routes are confirmed
- [x] ~~Attestation latency~~ Measured at 6.5 to 8.8 minutes across three runs. The API responds in about 0.6s
- [x] ~~Whether the environment works~~ Toolchain, build, RPCs, precompiles and oracle all fine

**Still open**
- [ ] Watch the AMA recording for scoring detail and host preferences the announcement leaves out
- [ ] Whether a detailed scoring rubric exists. Ask in Discord `#buidl-ctc-qna`
- [x] ~~Whether readability carries a fee~~ Free, confirmed by the official wording and our measurement ([`05`](05-asc-integration-review.md) section 6)
- [ ] How "original work created during the hackathon" is judged, and what reuse of prior work is allowed
- [ ] Open the actual submission form and read its fields. Not thirty minutes before the deadline
- [x] ~~Faucet funds~~ Received 2026-08-30
- [ ] Settle the team roster and collect residence and citizenship per member

---

## 11. Measured constraints that shape the design

Two facts from the environment verification that change how the product is built.

### 11.1 Cross-chain confirmation takes eight to ten minutes
Attesters take a measured 6.5 to 8.8 minutes to attest a source chain block, across three observations. The margin exists to survive reorgs.
Nothing needing a real-time answer belongs on this axis. Design for an optimistic UI, an async worker and a visible waiting state.
The video has to account for it too, through a cut or a timelapse.

### 11.2 ~~A nine-query daily limit on testnet~~ Corrected

> This was written up as a severe constraint on the strength of the README's "100 CTC per 24 hours, worth nine queries". The actual grant was 10,000 CTC. The constraint does not apply to us.

The rule of testing locally first survives, only its reason changes. What needs conserving is not a query budget but eight-minute attestation cycles. One failed end-to-end attempt costs eight minutes, and money does not buy that back.

---

## 12. Next

1. ~~Verify the environment with `Hello Bridge`~~ done
2. ~~Collect funds from both faucets~~ done
3. Watch the AMA recording and update sections 9 and 10
4. Join Discord and post the open questions
5. ~~Read Tutorial 4, `Loan Flow`~~ done, see [`02`](02-loan-flow-analysis.md)

---

## 13. Links

| | URL |
|---|---|
| Attestcoin | https://attestcoin.org/ |
| Developer documentation | https://docs.attestcoin.org/ |
| Documentation index for LLMs | https://docs.attestcoin.org/llms.txt |
| Chains & Environments | https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments |
| Guided Tutorials | https://docs.attestcoin.org/attestcoin-protocol/guided-tutorials |
| SDK documentation | https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk |
| SDK npm | https://www.npmjs.com/package/@gluwa/usc-sdk |
| Example repository | https://github.com/gluwa/attestcoin-protocol-examples |
| AMA recording | https://youtu.be/HPL6LjTqQm4 |
| Creditcoin Discord | https://discord.gg/Gu43zTfmtc |
| Contact | team@creditcoin.org, or Discord `#buidl-ctc-qna` |
