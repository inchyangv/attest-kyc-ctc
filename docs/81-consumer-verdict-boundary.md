# T-36 / T-37 — Consumer verdicts are observations, not transaction authorization

2026-09-07. The basic `examples/consumer/check.ts` still used a static network declaration, historical default addresses and independent latest reads for the boolean and policy freeze flag. It could label a wrong-chain or mixed-block response as a CC3 verdict, and had no structured unavailable result. The newer roster bundle checker and onchain page did not protect this separate entry point.

## Reader and CLI contract

`pipeline/consumer-verdict.ts` exports `readConsumerVerdict(provider, config, subject, policyId)`. Configuration explicitly binds nonzero Registry/ASC/source addresses and independently approved nonzero Registry/ASC runtime keccak256 hashes. The subject and positive policy ID are explicit; all uint256 policy IDs are preserved as bigint inputs and decimal-string output. Nothing defaults to a demo holder or a historical deployment.

The reader verifies actual hub chain 102031, captures one block with number/hash/timestamp, checks both runtime images at that block, and uses that block tag for every contract call. It requires current attrs/policy/roster/epoch/authorization/witness/transaction-processing schemas, exact Registry→ASC and ASC→source bindings and source chain key 1. These ABIs reuse the existing status reader fragments and their compiled-contract layout tests. The selected policy must exist, be frozen and have a supported individual/entity kind. The response includes its complete requireAll/assurance/maxAge/regime/jurisdiction/issuer/roster fields, kind and schema version. The final read rechecks block number/hash/timestamp and network.

The boolean comes only from `Registry.isVerified`, not attribute preview, witness simulation or a reconstruction of eligibility. A frozen Direct policy remains supported with an explicit warning that it does not establish continued revocation freshness. A roster policy requires a currently stored witness according to the contract, not merely a downloaded proof or published root. The full policy ID and contents still need independent application approval; immutability is not suitability or legal approval. The reader does not select a customer policy.

The CLI uses explicit shell configuration, no dotenv, private key or signer. Its RPC provider discovers and rechecks the network instead of declaring `staticNetwork: true`. It uses a 10-second per-request timeout and destroys its provider on completion/failure; this is not a hard global command deadline or authenticated RPC transport guarantee.

| CLI result | Exit | Meaning |
|---|---|---|
| `accepted`, `verified: true` | 0 | Selected Registry policy returned true at the reported block |
| `rejected`, `verified: false` | 0 | Selected Registry policy returned false at that block; no specific legal/operational cause inferred |
| `unavailable`, `verified: null` | 2 | No usable verdict; explicit fixed error code, no fallback to earlier success or false |

Configuration/argument, chain, runtime, schema, binding, policy and observation errors use `CONSUMER_*` codes. Other dependency failures project to `CONSUMER_DEPENDENCY_UNAVAILABLE`, without returning raw RPC URL, authorization data or remote diagnostics. Library consumers must handle thrown errors; the CLI projection is not automatic in another application's logger.

The output is a latest-block point-in-time observation, not finalized proof, an asset action, source transaction ancestry, current screening evidence or permission to bypass the eventual onchain gate. Runtime pins do not independently verify linked decoder/native/proxy implementation code or authenticate RPC responses. No maximum block-age/confirmation policy is silently chosen for the customer. The actual consumer transaction must evaluate its gate at execution; the response can become stale meanwhile.

## Executed evidence

Six root tests exercise pinned code/call block tags and full uint256 IDs; rejection versus exception and entity/Direct policy metadata; invalid configuration/runtime/schema/binding/frozen/unknown policy; final number/hash/time/network drift; actual CLI invalid arguments/missing configuration; and an owned HTTP RPC returning a synthetic private diagnostic. The last produces only structured unavailable, never leaks the diagnostic or issues a write request.

The existing two-chain gate integration now runs this actual CLI against its freshly deployed local Registry/ASC without any private-key environment variable. Direct materialization plus an accepted epoch, before witness storage, is rejected. After witness storage it is accepted. A wrong reviewed runtime pin produces unavailable rather than false. After the existing source revocation→hub relay and later roster expiry, the CLI returns genuine rejection. All observed CLI calls leave the hub block height unchanged and produce no transactions. Existing issuance, transfer, rescreen outbox, actual revocation, witness replacement and expiry tests remain in the same integration; it is not another suite.

This is actual local EVM policy execution but uses synthetic subjects, demo vendors and mocked native proof verification. It does not prove a public deployment, a real developer's staging integration, wallet transaction UX, integration time, legal policy suitability or customer approval. Those T-36/T-37 conditions remain open.
