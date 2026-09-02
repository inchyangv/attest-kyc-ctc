# Proofmark

**A compliance gateway for Creditcoin. External KYC/AML credentials go in; frozen, application-specific policy decisions come out.**

Proofmark records which checks an issuer actually performed, proves the Ethereum source transaction through the Attestcoin Protocol, and materializes the result on Creditcoin CC3. A lending market, stablecoin, or tokenized asset can then enforce its own policy without rerunning KYC or trusting a bridge operator.

The privacy claim is deliberately narrow: names, dates of birth, document numbers, and account numbers are never written on chain. Wallet addresses, issuer addresses, method metadata, and commitments are pseudonymous and linkable; they are not anonymous.

## Try it

- Product: [attest-kyc.stabled.ai](https://attest-kyc.stabled.ai)
- Creditcoin state: [attest-kyc.stabled.ai/onchain](https://attest-kyc.stabled.ai/onchain)
- Full verification journey: [attest-kyc.stabled.ai/verify](https://attest-kyc.stabled.ai/verify)
- Pitch deck: [docs/deck/proofmark-deck.pdf](docs/deck/proofmark-deck.pdf)
- Investment and pilot memo: [docs/11-investment-memo.md](docs/11-investment-memo.md)

The public journey is a sandbox. Demo identity and bank adapters do not contact an institution and can only produce `regime = 2`. Frozen production policy #1 requires `regime = 1`, so a demo mark cannot pass it.

## Why this belongs in the Creditcoin ecosystem

Creditcoin applications need a reusable compliance state, not another KYC form. Proofmark separates three concerns:

1. **Verify:** a configured credential rail performs document, account, sanctions, and jurisdiction checks. A missing or sandbox check leaves an honest bit or regime behind.
2. **Prove:** `ComplianceSource` emits on Ethereum Sepolia. Attestcoin BlockProver verifies that source transaction; no Proofmark-operated oracle signs the cross-chain message.
3. **Enforce:** `ProofmarkRegistry` applies a frozen policy over method bits, assurance, age, regime, jurisdiction, issuer, and optional roster membership. `GatedRwaNote` refuses mint and transfer when the policy fails.

This makes Proofmark useful as a Creditcoin-native normalization and policy layer above existing credential providers. The reference issuer is implemented today; adapters for credentials such as CCID, zkKYC providers, and regulated institutional rails are the commercial expansion path, not a claim that those integrations already exist.

## What is live now

As of 2026-09-02:

| Component | Status |
|---|---|
| Contracts | Current source is deployed on CC3 Testnet and Sepolia |
| Policies | Production #1 and sandbox #2 are registered and permanently frozen |
| Cross-chain ordering | Per-subject `(source block, transaction index)` cursor prevents stale or same-block resurrection |
| Replay protection | API flow is consent-bound; `ComplianceSource.issueOnce` permanently consumes its request ID |
| Revocation | Ordinary revocation can be superseded by a later full issuance; sanctions denial remains permanent |
| Rosters | Inclusion and non-inclusion proofs bind both keys and marks; adversarial relabelling regression is tested |
| AML data | 26,566 OFAC/UN/EU entries, 78,365 names; source timestamps are checked and stale data fails closed |
| FATF | June 2026 monitored-jurisdiction tables are source-verified and versioned in evidence |
| Evidence | AES-256-GCM pilot vault, retention purge, erasure log, rescreening, and manual-review CLI are implemented |
| Public sandbox | No persistent server-side evidence is retained; production issuance fails closed without a persistent vault |

The encrypted file vault is suitable for a single-instance pilot on persistent encrypted storage. It is intentionally disabled on Vercel's ephemeral filesystem. A production hosted service still needs a managed database/KMS adapter, distributed rate limiting, vendor contracts, operational key separation, and security review.

## Current testnet deployment

Source of record: [deployments/cc3-testnet.json](deployments/cc3-testnet.json).

| Contract | Network | Address |
|---|---|---|
| `EvmV1Decoder` | Creditcoin CC3 | `0x5eE29aB8845A2AD4BBE1e01c5BD3bCc3AEee47Fd` |
| `ProofmarkASC` | Creditcoin CC3 | `0x3C6Fe016645CA52952E29C66E435bDa7F611b242` |
| `ProofmarkRegistry` | Creditcoin CC3 | `0x2F4E5e1270f90E51251651caf08547393e3C0572` |
| `ComplianceSource` | Ethereum Sepolia | `0xA9A34586303b9fD92e090F9bb1D332DC854c72B9` |
| `GatedRwaNote` (`KPCN`) | Creditcoin CC3 | `0xa74aB3De359a55A729f9185Fe4Afe90526E585CA` |

The contracts share one testnet owner/issuer key. That is acceptable only for the demo. Production must separate deployer, issuer, policy owner, epoch publisher, worker payer, and asset recovery roles behind managed keys or multisigs.

### Frozen policies

| ID | Purpose | Required methods | Assurance | Max age | Regime | Jurisdiction | Trusted issuer | Asset binding |
|---|---|---|---:|---:|---:|---:|---|---|
| 1 | KR production | `0x10024` | 2 | 30 days | 1 | 410 | deployer/issuer | none |
| 2 | KR sandbox pilot | `0x10024` | 2 | 7 days | 2 | 410 | deployer/issuer | `KPCN` |

Both `policyFrozen(1)` and `policyFrozen(2)` return `true`. The gated note constructor rejects a mutable policy.

### Live cross-chain evidence

- Sepolia `issueBatch` [`0x29049802…69f1`](https://sepolia.etherscan.io/tx/0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1) materialized two sandbox marks on CC3; the worker submission was [`0x50c30b31…67d8`](https://creditcoin-testnet.blockscout.com/tx/0x50c30b315f74150fecf56b670a5d6c9cf7dc0bc76c815809dbc6af899de567d8).
- `KPCN` minted 100 tokens to verified subject A in [`0xa1f3b9fa…e77`](https://creditcoin-testnet.blockscout.com/tx/0xa1f3b9fa62419b0352376d633b703442830d95a45179772825e44397342f8e77), then transferred 40 to verified subject B in [`0xefe550ff…aa0d`](https://creditcoin-testnet.blockscout.com/tx/0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d). A call to an unissued recipient reverts with `RecipientNotVerified`.
- Epoch 1 root `0xfe6cf3e0…364d` was published on Sepolia in [`0x2adefae2…16df`](https://sepolia.etherscan.io/tx/0x2adefae22bd29e7fc43b9f9161f6c722cc2deb4eae6bc720aca5a2b65e7816df) and accepted on CC3 in [`0xb011cd6e…532f`](https://creditcoin-testnet.blockscout.com/tx/0xb011cd6e5a590b924858262cdfc832a6ef0d71cc4b78c3ac61efaf3d0c2f532f), 8m 00s later by block timestamps. Contract calls confirm policy 2 membership `true`, policy 1 membership `false`, and non-membership for an unissued address `true`.

The complete epoch inputs, timings, and verdicts are in [deployments/epoch-1.json](deployments/epoch-1.json).

## Security properties added in the current build

- `ProofmarkASC.configureSource` is one-time and rejects every proof before configuration.
- The cross-chain query ID follows Attestcoin's `(chainKey, blockHeight, txIndex)` layout; state application uses the same transaction index as a per-subject tiebreaker.
- A sanctions denial cannot be downgraded by an ordinary revoke or issuance. A non-sanctions revoke can be reactivated only by a newer full issuance.
- Non-inclusion proofs recompute each boundary leaf from `(key, mark)`. A valid neighboring leaf cannot be relabelled around a listed target.
- Consumer policy checks include required/all method bits, minimum assurance, maximum mark age, regime, jurisdiction, trusted issuer, and optional fresh roster membership.
- Policies can be frozen permanently; a policy-gated token can bind only to a frozen policy.
- The token owner has recovery-only `forceTransfer` and `forceBurn`; recovery cannot move assets to an unverified recipient.
- The worker persists jobs atomically and requeues pending failures on every poll cycle, not only on restart.
- Request bodies are size-limited, same-origin state-changing routes are checked, and per-instance throttles return `429`. A multi-instance production deployment still needs host-level distributed controls.

## Privacy and evidence boundary

On chain:

- wallet/subject address and issuer address;
- status, origin, kind, assurance, regime, jurisdiction, method bitmap, timestamps, and epoch;
- `claimsRoot` and `evidenceHash` commitments.

Off chain during issuance:

- declared identity and account inputs;
- fields needed by the configured verification vendors;
- salted claim openings and a recomputable evidence chain.

Evidence uses keyed HMACs for low-entropy identity fields. This is pseudonymization, not anonymization. The `proofmark-kyc-v2` consent text is bound into the wallet-signed EIP-4361 flow, every downstream token is bound to the same flow ID and wallet, and one flow can finalize only once.

For non-demo issuance, the API refuses to continue unless a persistent encrypted evidence vault is configured. The pilot vault supports:

```bash
npm run vault:admin -- counts
npm run vault:admin -- decide <record-id> cleared "review reason"
npm run vault:admin -- erase <record-id> "request or policy basis"
npm run vault:admin -- purge
npm run rescreen                 # dry run
npm run rescreen -- --publish    # records decisions and emits a revocation batch
```

See [docs/08-regulatory-position.md](docs/08-regulatory-position.md). It is an engineering position paper pending Korean compliance and legal review, not legal advice.

## AML data and evaluation

Refresh, build, and evaluate the source lists:

```bash
bash aml/fetch-lists.sh
npx tsx aml/build-index.ts
npx tsx aml/eval.ts
```

The fetch is fail-fast, validates minimum size and XML shape, and atomically replaces all three lists only after every download passes. Runtime loading checks each source timestamp on every request and fails closed once the configured maximum age is exceeded.

The current corpus contains:

| Source | Entries |
|---|---:|
| OFAC SDN | 19,321 |
| UN Consolidated | 1,011 |
| EU Financial Sanctions Files | 6,234 |
| Total | 26,566 |

Current deterministic evaluation: 200/200 listed-person recall, 610/610 clean-name specificity, 7/7 transliteration/evasion cases, and the listed-wallet case blocked. This is an engineering regression corpus, not a regulatory certification or a substitute for licensed PEP/adverse-media data.

## Build and verify

Requirements: Node.js, npm, and Foundry.

Clone with submodules, or initialize `forge-std` before running Foundry:

```bash
git clone --recurse-submodules https://github.com/stabled-ai/attest-kyc-ctc.git
# existing clone: git submodule update --init --recursive
```

```bash
npm ci
npm test                    # Solidity
npm run test:ts             # worker + pipeline + vault
npm run typecheck

cd web
npm ci
npm run lint
npm run build
```

Deploy and operate on testnet:

```bash
cp .env.example .env
./script/deploy.sh preflight
./script/deploy.sh deploy

npm run worker              # start before emitting source events
npx tsx script/demo-gate-issue.ts
npx tsx script/publish-epoch.ts --dry-run
npx tsx script/publish-epoch.ts --publish
```

`script/publish-epoch.ts` rebuilds the active set from Sepolia issuance events and CC3 materialized state, refuses an incomplete source scan, self-checks proofs, publishes one root, then asks the deployed registry for both membership and non-membership verdicts.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | Solidity source, ASC, registry, source events, policy-gated note |
| `test/` | Foundry security and lifecycle tests |
| `worker/` | Source scanner, Attestcoin proof fetcher, durable retry state |
| `pipeline/` | KYC adapters, reconciliation, evidence, commitments, roster, vault |
| `aml/` | Official-list loaders, matcher, FATF table, evaluation corpus |
| `web/` | Next.js product and API journey |
| `script/` | deployment, epoch, rescreen, and vault operations |
| `deployments/` | machine-readable testnet evidence |
| `docs/` | protocol reviews, runbooks, regulatory position, pitch materials |

## Commercial wedge

Proofmark should not compete by charging every Creditcoin contract to read a boolean. Reads stay permissionless. The paid surface is issuer and institutional infrastructure:

- annual platform/SLA for a regulated issuer or asset platform;
- per issuance and recurring rescreening;
- encrypted evidence-vault and audit export;
- adapters for credential providers and jurisdiction-specific policies;
- integration and policy-governance support for Creditcoin applications.

The near-term target is two design partners: one Creditcoin RWA/lending application and one regulated KYC/AML issuer. The proposed CEIP milestone is a 12-week, USD 100k testnet-to-pilot program; it is an ask, not awarded funding or booked revenue.

## Known gaps before production

- No signed vendor agreement or live institutional ID/bank rail is configured in the public demo.
- PEP and adverse-media checks are unset because no licensed source is connected.
- The file vault is not a multi-instance managed service; Vercel sandbox retention is disabled.
- Rate limiting is per instance until a distributed gateway/WAF is configured.
- No external smart-contract audit, penetration test, Korean legal sign-off, or production key ceremony has been completed.
- The reference issuer is centralized. External credential adapters and independent issuers are roadmap.
- Testnet roles reuse one key; production governance and emergency procedures remain to be implemented.

## License

MIT. See [LICENSE](LICENSE).
