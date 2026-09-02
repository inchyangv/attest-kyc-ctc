# Proofmark investment and pilot memo

> 2026-09-02 · Creditcoin ecosystem / hackathon diligence view
> This is a product and investment assessment, not legal advice. Revenue, pilots and funding described below are targets unless explicitly marked live.

## Decision

**Recommendation: conditional milestone investment, not an unconditional seed check.** Proofmark is one of the stronger Creditcoin-native infrastructure builds technically: it uses Attestcoin for a necessary trust-minimization property, has a real policy-gated asset path, and now closes the obvious policy, ordering, replay and non-inclusion gaps. The investable wedge is not “another KYC provider.” It is the Creditcoin compliance gateway that normalizes credentials from established issuers and gives each Creditcoin application a frozen, auditable policy surface.

The reason to fund a pilot is technical differentiation and ecosystem fit. The reason not to fund the whole roadmap upfront is commercial evidence: no live regulated vendor contract, independent issuer, design-partner LOI, managed evidence service, audit, or production legal sign-off exists today.

## Scorecard

| Dimension | Weight | Score | Diligence view |
|---|---:|---:|---|
| Creditcoin / Attestcoin necessity | 20 | 19 | Source events are verified through BlockProver; replacing Attestcoin would reintroduce a trusted oracle |
| Technical execution | 20 | 18 | Live contracts, worker, policy-gated note, roster mode, 57 Solidity and 123 TypeScript tests |
| Security and correctness | 20 | 16 | Same-block ordering, denial precedence, replay protection, policy freeze and bound non-inclusion proofs are implemented; no external audit yet |
| Product clarity | 15 | 12 | Verify → prove → enforce is coherent; the public sandbox still requires explanation and cannot show a live vendor |
| Go-to-market evidence | 15 | 5 | Buyer and pricing hypotheses are credible, but there is no LOI, paid pilot, vendor contract or revenue |
| Regulatory / operations readiness | 10 | 5 | Consent, encrypted pilot vault, erasure, rescreen and Seoul function preference exist; managed operations and counsel approval do not |
| **Total** | **100** | **75** | **Fund a narrow, gated pilot** |

## Product thesis

A credential provider answers “what did this provider verify?” A Creditcoin application still needs to answer “is that enough for this asset, jurisdiction and moment?” Proofmark owns that second layer:

```text
credential issuers
  ├─ reference KR issuer (implemented)
  ├─ Sumsub / CCID adapter (target)
  ├─ zkMe adapter (target)
  └─ regulated institution adapter (target)
          ↓ normalized method + regime + issuer semantics
Ethereum source event → Attestcoin proof → Creditcoin ASC
          ↓
frozen consumer policy → lending / RWA / stablecoin gate
```

This positioning avoids trying to replace global KYC vendors before there is distribution and gives those vendors a Creditcoin-native consumption path.

## Competitive map

| Alternative | What it does well | Where Proofmark can win | Where Proofmark is behind |
|---|---|---|---|
| [Sumsub + Chainlink CCID/ACE](https://sumsub.com/newsroom/sumsub-partners-with-chainlink-to-power-cross-chain-identity-for-on-chain-compliance/) | Enterprise verification and reusable privacy-preserving credentials across major EVM ecosystems | Creditcoin-native Attestcoin verification, explicit frozen per-asset policies, roster non-membership, open read surface | Vendor coverage, enterprise distribution, production credentials, integrations |
| [zkMe zkKYC](https://www.zk.me/credentials/zkkyc/) | Reusable ZK credentials, selective disclosure, personhood/citizenship/location/AML products | Proven source-transaction path into Creditcoin and policy/gating semantics designed for its applications | Zero-knowledge privacy, supported jurisdictions, production adoption |
| Direct CODEF / Sumsub / bank integration | Authoritative checks and contracted compliance workflow | One normalized integration for multiple Creditcoin applications; policy can change without rerunning integration code | Proofmark still needs those rails and cannot inherit their permissions |
| Generic attestation / VC registry | Flexible schema and broad tooling | Fail-closed compliance-specific state machine, ongoing rescreen/revocation and application policy | Standards/network effects and issuer ecosystem |
| App-specific allowlist | Fast and cheap for one launch | Portability, auditability, explicit freshness/issuer/regime, reusable state | Simplicity for a small one-off application |

The defensible asset is not the bitmap alone. It is the combination of credential normalization, proven source provenance, policy semantics, continuous lifecycle operations, evidence interoperability, and integrations into Creditcoin applications.

## Business model

On-chain reads should remain free and permissionless, consistent with [Attestcoin's current read model](https://attestcoin.org/). Revenue attaches to institutional work:

| Surface | Charging unit | Buyer |
|---|---|---|
| Issuer platform and SLA | annual contract | regulated issuer, RWA platform, lender |
| Credential issuance | per completed check, vendor cost passed through | issuer / application |
| Continuous compliance | active wallet/month or rescreen event | issuer / asset operator |
| Evidence vault and audit export | annual tier plus storage | obligated institution |
| Provider / jurisdiction adapter | implementation plus maintenance subscription | provider or ecosystem |
| Policy integration and governance | project fee / support plan | Creditcoin application |

Pricing must be validated with design partners. The first pilot should test willingness to pay and operational burden, not optimize gross margin.

## Market wedge without invented TAM

No top-down “global KYC market” number is used here; it would not describe Proofmark's reachable market. The first measurable market is bottom-up:

1. Creditcoin RWA, lending and stablecoin applications that need wallet eligibility.
2. Credential issuers that want one Creditcoin integration rather than bespoke work per application.
3. Applications expanding across jurisdictions that need a policy layer above reusable credentials.

The first proof of market is therefore two integrations, not a slide-sized TAM: one asset/application consuming policy and one issuer/provider supplying a credential. Success means a live end-to-end pilot, a signed operating model, and a priced renewal proposal.

## CEIP proposal

**Ask: USD 100,000 for a 12-week milestone pilot.** This sits within the [CEIP's published USD 25,000–500,000 investment range](https://creditcoin.org/Fund). It is a proposal, not awarded funding.

| Tranche | Amount | Exit evidence |
|---|---:|---|
| 1. Productization | $25k | managed-vault/KMS design, separated roles, adapter interface, threat model, one signed design-partner discovery memo |
| 2. Integration | $35k | one external credential adapter on testnet, distributed API controls, operational rescreen/manual-review runbook, partner sandbox integration |
| 3. Pilot | $40k | external contract review fixes, two integrated design partners or one paid pilot, measured issuance/revocation SLA, production launch decision |

Proposed use of funds: 55% engineering, 15% security review, 15% compliance/legal/vendor work, 10% partner integration, 5% operations and reporting. No token-liquidity or broad paid-marketing budget belongs in this phase.

## Twelve-week milestones

| Weeks | Deliverable | Acceptance test |
|---|---|---|
| 1–2 | External issuer/credential adapter specification; managed vault and key architecture | independent reviewer can map every trust boundary and data controller |
| 3–5 | First adapter and provider conformance suite | provider credential becomes a normalized mark; wrong issuer/regime/jurisdiction fails |
| 4–6 | Managed persistence, distributed throttling, consent/retention configuration | concurrent flows do not lose records; replay and abuse tests pass |
| 6–8 | Role separation and incident/recovery procedures | issuer cannot mutate frozen policy; recovery simulation is recorded |
| 8–10 | External contract/security review and fixes | no unresolved critical/high finding |
| 10–12 | Design-partner integration and SLA measurement | issue, propagate, rescreen, revoke/reactivate and gate flows run from partner staging |

## Investment gates and kill criteria

Release tranche 2 only after a credible issuer/provider path and one application design partner are documented. Release tranche 3 only after the adapter is exercised outside the Proofmark team's own issuer.

Stop or reposition the project if any of these is true by week 8:

- no Creditcoin application will integrate even with funded support;
- no credential issuer/provider will permit credential reuse or source-event publication;
- counsel concludes the operating model creates obligations the target buyers will not accept;
- managed evidence operations make the economics worse than direct vendor integration;
- Attestcoin propagation/freshness cannot meet the selected asset's risk window.

## Current diligence evidence

- Current deployment: [cc3-testnet.json](../deployments/cc3-testnet.json)
- Product/security status: [README.md](../README.md)
- Regulatory position: [08-regulatory-position.md](08-regulatory-position.md)
- Worker design: [06-worker-design.md](06-worker-design.md)
- Epoch operations: [10-epoch-roster-runbook.md](10-epoch-roster-runbook.md)
- Test commands: `npm test`, `npm run test:ts`, `npm run typecheck`, `cd web && npm run lint && npm run build`

## Bottom line

Proofmark is investable as a Creditcoin ecosystem infrastructure experiment with milestone discipline. It is not yet investable as a scaled compliance company on traction. The right check buys the missing external proof—independent credentials, design partners, managed operations and review—while preserving the unusually strong protocol work already completed.
