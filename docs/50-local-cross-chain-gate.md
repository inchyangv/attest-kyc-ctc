# T-39 — Two-chain local contract integration

2026-09-07. **IN_PROGRESS.** This closes a local contract integration gap, not the full browser/API-to-Creditcoin E2E requirement. No public deployment, institutional request, real identity, or external proof service was used.

## Reproduce

```sh
npm run test:cross-chain-gate
```

Requires installed project dependencies, Forge and Anvil. The test builds local artifacts and starts two isolated loopback Anvil processes with source chain ID 11155111 and hub chain ID 102031. These are local simulations with those IDs, not connections to Sepolia or Creditcoin. It deploys fresh contracts, uses public Anvil development keys, funds a random local subject with synthetic gas, and stops its own processes afterward. CI runs the same test separately from the root unit suite.

## What actually executes

`test/cross-chain-gate.integration.ts` deploys `ComplianceSource`, linked `ProofmarkASC`/`EvmV1Decoder`, `ProofmarkRegistry`, frozen production/pilot roster policies and `GatedRwaNote` from compiled artifacts. Source replay begins at the exact deployment transaction hash captured from deployment, not a guessed block or a historical manifest.

For two random subjects, the real issuance pipeline produces sandbox regime 2 outcomes. `EvmIssuanceTransport` checks its source/hub targets, signs and broadcasts actual local `issueOnce` transactions, confirms their source receipts and checks the exact resulting ASC mark after relay. Direct materialization alone remains ineligible for the roster policy.

The test replays source receipts through a finalized local cutoff, constructs the roster, obtains the issuer's actual EIP-712 root signature, publishes the epoch on the source contract, and relays the resulting receipt to the hub. The Registry validates and caches both encoded membership witnesses. The consumer remains closed until both are present. Production policy 1 rejects these sandbox credentials; pilot policy 2 permits them. The real shared-block freshness helper checks the deployment with an explicitly injected local block clock.

The note mints 100 local units and transfers 25 to the second eligible subject; resulting balances are 75 and 25. Three denial cases assert both exact custom-error data in simulation and a mined failed transaction receipt, with all observed balances unchanged:

- Transfer to an unissued control address: `RecipientNotVerified(control, 2)`.
- Transfer to the revoked recipient after hub relay: `RecipientNotVerified(recipient, 2)`.
- Transfer by the sender at the epoch expiry boundary: `SenderNotVerified(sender, 2)`.

The source revoke alone does **not** immediately block the hub gate: the test explicitly observes the still-open propagation window before relaying the revoke receipt. A new epoch excludes that revoked subject and invalidates the other subject's old witness. The previous proof cannot be cached for the new epoch. A newly cached witness works only until the new epoch's `validUntil`; it fails at that exact boundary even though the underlying credential expires later. Replaying each already-processed source receipt is rejected.

## Explicit substitutes and remaining gaps

The local native proof-verification precompile is **MockBlockProver**. Decoder-format transaction wrappers contain actual source receipt logs, but their surrounding proof data is synthetic. A failing verifier mock is also tested to confirm rejection before any mark appears. This does not establish real inclusion, continuity, finality, cross-chain consensus, query service availability, or compatibility with the live Attestcoin proof builder. Mining local blocks to obtain an Anvil `finalized` cutoff is not a measurement of public-chain finality or propagation latency.

The initial AML engine runs a single explicitly fictional record; `OFAC_SDN` is only the fixture's existing schema slot, not a claim that official OFAC data was checked. Snapshot IDs and list version are fictional. Demo ID verification receives synthetic bytes directly, without the web native-image route. Bank verification, wallet control and `evidenceStored` are supplied fixture assertions, not proof of an API flow, wallet signature ceremony, bank challenge or durable issuance journal. The later rescreen case now writes a real encrypted vault record tied to Bob's original issuance and uses a changed fictional listed-wallet corpus, as described below.

The [driver/API test](49-demo-driver-api-conformance.md) and this test cover separate portions of the journey. Combining their PASS results is **not** a single full-flow E2E result. Still required: actual API issuance/journal/vault and current AML snapshot integration, recovery during delays, real proof construction and worker relay, independent deployment/runtime pins, public receipt lineage and approved consumer execution. The driver still exits 2 at its documented incomplete-E2E boundary. No historical public contract is promoted to the new guarantees by this local test.

Follow-up: a new [connected local API/storage/consumer test](51-local-api-issuance-integration.md) now closes the local API→journal/vault→source→hub/witness→wallet-signed token path in one execution, including fresh wallet-proof resume. It still uses synthetic source XML, a Redis REST bridge and a mocked native proof verifier; official snapshot, real proof service/worker and public deployment verification remain open. It is additional evidence, not a reinterpretation of this narrower test.

Further follow-up: [the local rescreen-to-enforcement case](56-local-rescreen-enforcement.md) replaces this test's direct manual revoke with real screening BLOCK → encrypted outbox → shared production EVM transport → source receipt → relay → exact reconciliation → actual token rejection. Broadcast-acknowledgement loss and same-nonce recovery are verified in that sequence. The initial identity/API and native-proof substitutions above still apply.
