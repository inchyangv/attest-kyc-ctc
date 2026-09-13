# T-20 — Read-only source-to-hub revocation reconciliation

2026-09-07. **IN_PROGRESS.** This adds a per-case observation command. Its default remains read-only; the subsequent [explicit history recording mode](57-revocation-observation-history.md) can append complete observations. Neither mode installs monitoring, relays a proof, reissues a mark or completes the institutional appeal workflow.

## Operator command

```sh
npm run check:revocation -- '<exact outbox job ID>'
```

The default command reads one job, including a source-confirmed job no longer returned by the pending outbox list. It requires `EVIDENCE_VAULT_PATH` and `EVIDENCE_VAULT_KEY` for authorized local access. Without `--record`, it never changes the encrypted file or takes a writer lock. No mode loads a signing key, broadcasts or renews anything. `--record` and `--history` behavior and exit meanings are specified in the linked history runbook.

Provide `SOURCE_CHAIN_RPC_URL`, `CREDITCOIN_RPC_URL`, `SOURCE_CONTRACT_ADDRESS`, `RESCREEN_CONFIRMATIONS`, `REVOCATION_ASC_ADDRESS`, `REVOCATION_REGISTRY_ADDRESS`, `REVOCATION_EXPECTED_REVOKER`, `REVOCATION_POLICY_IDS`, and the three `REVOCATION_{SOURCE,ASC,REGISTRY}_CODE_HASH` values. The supported chain pair is explicitly Sepolia 11155111 → CC3 testnet 102031, with ASC chain key 1. Configured policy IDs must be unique positive integers, at most 16, and must identify existing frozen policies.

Runtime hashes must be approved deployment pins obtained independently of the RPC observation being tested. The checker cannot establish who approved a supplied hash. Do not derive pins from an untrusted current response just to make the command pass. Legacy deployment incompatibility, unavailable pins and stale heads are failures, not permission to weaken checks. The `.env.example` intentionally supplies no contract, revoker or hash defaults for this command.

Only HTTPS or loopback HTTP RPC endpoints are accepted by the CLI. Providers disable ethers' short request cache so block-hash rechecks reach the RPC. Each RPC HTTP request has a 10-second timeout; this is not a single total wall-clock SLA for the entire multi-request operation. CLI exceptions are fixed error codes, without raw RPC URLs, response bodies, private key material, subject data or parser diagnostics. A successful JSON result uses a digest of the local job ID and public transaction/block coordinates rather than printing the retained identity or raw signed bytes.

## What a positive observation requires

1. Job transaction and any retained source target match the configured source deployment. The actual source/hub network IDs and runtime bytecode hashes match the required pins.
2. Both latest blocks have valid coordinates and timestamps within 300 seconds behind / 30 seconds ahead of the observation clock. The CLI uses the host clock, with no environment override.
3. The source receipt matches the stored transaction hash, configured contract and independently specified revocation signer. It is successful, canonical at the observed block and deep enough relative to the sampled source head. Source code at the receipt block must also match its pin.
4. Exactly one matching `MarkRevoked` log names this subject and reason code 2, the rescreen outbox's reason. The comparison uses the receipt-local array position, **not the RPC's block-global log index**.
5. At one hub block, the Registry points to the expected ASC, the ASC points to the expected source/chain key and supports atomic transaction processing v2, and the Registry has policy schema v2. The ASC cursor matches the source receipt's block, transaction index and receipt-local log position exactly.
6. At that same hub block, the subject tombstone is true and every requested existing frozen Registry policy returns actual boolean false. A local diagnosis never overwrites those booleans.
7. Before returning positive enforcement, source receipt block, sampled source head and hub observation block hashes are fetched again and remain unchanged.

The result is a current RPC-based observation, not a proof that the source can never reorganize, independent native inclusion-proof verification or a signed operational acknowledgement. Code pins do not make a consistently dishonest RPC trustworthy. The helper does not scan for the hub relay transaction or assert that a particular consumer is connected to this Registry/policy. Use the consumer's own binding and transaction checks separately.

## States and follow-up

| State | Meaning and next action |
| --- | --- |
| `UNSIGNED` | No stored transaction; inspect local outbox preparation, not hub propagation. |
| `SOURCE_PENDING` | RPC has no receipt for the stored hash. This can include broadcast uncertainty or a disappeared receipt; reconcile the original hash. |
| `SOURCE_UNCONFIRMED` | Receipt exists but the sampled confirmation depth is insufficient. Wait and recheck. |
| `SOURCE_REVERTED` | Confirmed source failure; inspect the original operation before an authorized retry. |
| `AWAITING_HUB` | Exact source event exists but hub cursor has not reached it. Diagnose the relay/proof path. Registry false alone is not evidence that this revoke arrived. |
| `SUPERSEDED` | Hub cursor is later. Current rejection may be real, but this query cannot certify that this particular event was observed historically. Review the later event; do not automatically reissue or clear anything. |
| `INCONSISTENT` | Exact cursor exists, but tombstone/policy verdicts do not establish rejection. Investigate; do not report enforcement. |
| `ENFORCED` | Exact event position, tombstone and selected Registry rejections agree at the rechecked hub block. This is not a permanent guarantee. |

For a current check, only `ENFORCED` returns CLI exit 0. All other states and configuration/RPC errors return exit 1. Early negative states are not full hub observations. The command is not a daemon: scheduling, alerts, escalation ownership and approved evidence retention remain T-20/T-17 work. Explicitly stored observations are historical records, not institutional approval or permanent enforcement acknowledgement.

## Local verification

Six root tests cover exact receipt-local indexing and same-block reads, pending/reverted/shallow source receipts, older/newer cursors and unrelated rejection, conflicting pins/sender/subject/reason/duplicate events/configuration, wrong chains/bindings/policies, stale/future blocks and three reorg rechecks. A real CLI subprocess verifies fixed error output and byte-identical encrypted-vault preservation on a missing case. RPCs in these root tests are explicit synthetic providers.

The existing two-Anvil contract integration additionally feeds an actual source revoke receipt to the helper before relay (`AWAITING_HUB`) and after actual local ASC materialization (`ENFORCED`). It then sends the token transaction and checks the exact recipient rejection and unchanged balances. The subsequent [rescreen integration](56-local-rescreen-enforcement.md) now creates the outbox through real engine screening against a changed fictional corpus and sends it through the shared production transport, replacing the original manually assembled case. Runtime pins in this controlled fixture come from the locally deployed artifacts, not an independently approved public release.

That test's CLI subprocess correctly refuses its intentionally future-dated chains with `STALE_OR_INVALID_HEAD`, preserving encrypted bytes. No successful public CLI run is claimed. An initial fixture edit had a duplicate variable name and omitted required synthetic DOB fields; those test construction errors were corrected without relaxing checker boundaries. Native proof verification remains mocked in the two-chain test, as described in [the contract integration scope](50-local-cross-chain-gate.md).
