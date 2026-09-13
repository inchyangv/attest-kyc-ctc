# Proofmark hackathon threat model

> Scope: the public sandbox on Ethereum Sepolia and Creditcoin CC3 Testnet, as deployed in
> `deployments/cc3-testnet.json`. This is a security argument for a testnet integration, not an
> audit, production certification or claim that the demo vendors performed identity verification.

## What must remain true

1. A CC3 mark came from the configured source chain and source contract.
2. An old but valid proof cannot overwrite a newer decision for the same subject.
3. A denial, revocation or missing roster entry cannot be silently turned into an allow.
4. An application receives the verdict of the policy it selected, not a global KYC verdict.
5. A policy-gated asset cannot be rugged by changing the policy after binding.
6. No cleartext name, birth date, document number or account number is written on chain.

Availability is deliberately secondary to integrity: an unknown, expired or unreachable state
must deny rather than allow.

## Trust boundaries

```text
identity / AML provider
        | provider authenticity and licence are external trust
        v
reference issuer + web flow -- signed source transaction --> ComplianceSource on Sepolia
        |                                                        |
        | cleartext PII exists transiently here                  | public event, no cleartext PII
        v                                                        v
off-chain evidence vault                              Attestcoin BlockProver
                                                                 |
                                              verified source transaction
                                                                 v
                                                       ProofmarkASC on CC3
                                                                 |
                                                     materialised mark / epoch
                                                                 v
                                                    ProofmarkRegistry policy
                                                                 |
                                                                 v
                                                       GatedRwaNote / dApp
```

The worker is outside the trust boundary for correctness. It chooses when to submit a proof but
cannot make an invalid source transaction pass the BlockProver. It can delay availability.

## Threats, controls and residual risk

| Threat | Current control | Residual hackathon risk |
|---|---|---|
| Proof from the wrong chain | `expectedChainKey` is configured once and checked by `ProofmarkASC` | Attestcoin and the source chain remain protocol dependencies |
| Event from a same-address contract elsewhere | Source chain and `sourceContract` are both pinned | Misconfiguration before the one-time source setup requires redeployment |
| Replay of one proof | Query ID is permanently consumed | Storage grows; this is acceptable for the testnet scope |
| Old issuance submitted after revocation | Working-tree v2 per-subject `(blockHeight, txIndex, receiptLogIndex)` cursor skips stale ordinary state; permanent denial accumulates independently | Source finality remains external; historical ASC is not upgraded |
| Mixed actions or duplicate subjects in one source transaction | v2 atomically processes every trusted lifecycle log in receipt order, regardless of caller action hint | New worker refuses v1; old consumed queries need migration, not a retry against the same ASC |
| Ordinary issuance clears sanctions denial | Denial precedence remains until a source-ordered, independently approved correction is paired with an exact replacement credential | Correct legal classification and approver authority remain external |
| Policy owner changes requirements after asset launch | Policies can be frozen; `GatedRwaNote` accepts only a frozen policy | A consumer that does not enforce freezing can choose weaker semantics |
| Sandbox credential passes production | Policies pin regime, jurisdiction and trusted issuer; production #1 rejects regime 2 | The demo issuer remains trusted only for the sandbox policy |
| Forged roster non-membership | Both boundary `(key, mark)` leaves and their adjacency are verified | Epoch construction and publisher key remain operational trust |
| Stale roster is treated as valid | `validUntil` is checked and expiry fails closed for every subject | Long demo validity is not a production revocation SLA |
| Worker crash or RPC error loses an event | Atomic cursor/job store and retries; cursor advances after jobs persist | One worker means downtime delays propagation; there is no HA claim |
| Duplicate workers corrupt ordering | Contract replay and subject cursors make duplicate submission safe | A race may waste testnet gas |
| Cross-site issuance or oversized request | Same-origin mutation guard, actual-byte intake limits/deadlines before JSON/multipart parsing, bounded per-instance counters ([details](27-api-resource-limits.md)) | No distributed WAF/rate limit or trusted-proxy deployment validation; no global gas ceiling |
| Reuse of one wallet flow | Wallet, consent version and flow ID are sealed together; `issueOnce` consumes the request ID | The public flow uses demo identity and bank adapters |
| Cleartext PII reaches the chain or evidence log | Commitments on chain; keyed digests in evidence; Unicode-aware PII regression tests | Wallet and metadata remain linkable pseudonymous data |
| Admin recovery sends assets to an unchecked wallet | Owner-only force selectors are removed; sealed transfer/burn requests require distinct approval and delay, and transfer rechecks the recipient | Role holders, legal authority, notice and settlement are not locally approved |

## Privileged roles in the testnet deployment

The current deployment intentionally reuses one testnet key for several roles. That key can issue
marks, administer source roles, own policies and operate the asset. This is explicitly acceptable
only for the demo. The deployment does not prove production separation of deployer, issuer, policy
owner, epoch publisher, worker payer and asset recovery.

## What the demo does not prove

- Identity or bank verification by a live institution
- Accuracy of PEP or adverse-media screening
- Security of a managed evidence service
- Multi-instance availability or distributed abuse protection
- Production key custody, incident response or legal compliance
- Absence of smart-contract or web vulnerabilities under an external audit

## Regression evidence

- `test/ProofmarkASC.t.sol`: source pinning, replay, ordering and denial precedence
- `test/ProofmarkRegistry.t.sol`: policy, expiry, issuer, regime and fail-closed checks
- `test/RosterProof.t.sol`: forged-gap and relabelled-boundary attacks
- `test/GatedRwaNote.t.sol`: transfer, recovery and frozen-policy gates
- `pipeline/*.test.ts`: adapter honesty, evidence, privacy and roster vectors
- `worker/*.test.ts`: durable cursor, retry scheduling and query-ID agreement

Run `npm test`, `npm run test:ts` and `npm run verify:submission` for the local and deployed evidence.
