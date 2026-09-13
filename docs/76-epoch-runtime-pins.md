# T-23 / T-40 — Explicit epoch runtime pins

2026-09-07. Schema/version methods identify an advertised interface, not the complete deployed code. The epoch publisher/checker now compares exact runtime bytes against explicit expected hashes in addition to its existing role, schema, binding, receipt and policy checks.

## Configuration and scope

The CLI reuses the existing scene-verifier names `DEMO_SOURCE_CODEHASH`, `DEMO_ASC_CODEHASH` and `DEMO_REGISTRY_CODEHASH`. All three must be full nonzero keccak256 hashes. They must come from independently reviewed release evidence, including immutable values and linked addresses where relevant. Never derive the expected value from the same remote RPC response merely to make the check pass. No default hash or inferred approval is supplied in `.env.example`.

`--publish` and `--resume-publication` check pins after acquiring their exclusive journal lease and before source observation/planning/signing. Normal mismatch releases only that invocation's lock and does not mutate the stored intent, sign a replacement or send. Source/hub dependencies therefore can hold source recovery; manual unverified reads are not silently promoted to a successful resume. Unsigned cancellation remains a local operation without runtime configuration or network reads.

The publication readiness callback repeats runtime checks before new signing or identical-byte rebroadcast, alongside original roster, snapshot/freshness, approval coverage and current source call simulation. This is not atomic with the eventual network send, a distributed key fence, or a complete fresh-publication CLI/proof-service test.

`--check` validates pin configuration before RPC access. ASC and Registry code are read at the same fixed hub observation block used for all schema/policy/verdict calls. Source code is read at an explicit recent source block. Nonempty byte-aligned hex is hashed; malformed/empty/different code is refused. Both chains, selected block numbers and canonical block hashes are checked. `runtimeObservation` records each checked address/hash/block. Source-only record projection removes older runtime observations rather than treating them as newly verified evidence. The check's existing final hub/source-cutoff checks still run before artifacts are written.

These are three exact code-image comparisons with point-in-time RPC consistency checks. They do not pin a proxy implementation, linked decoder library's own runtime, native verifier, upgrade governance, storage state, deployment transaction or build provenance. The expected ASC image includes its linked address bytes, but that alone does not authenticate code behind that address. Pin approval, key custody and authorized pin changes remain external release responsibilities. Pins are not immutable fields in the existing publication intent schema; changing configuration is not an audited release migration protocol.

## Executed local evidence

Three new root tests cover required pin inputs before code reads, all three exact-byte/hash comparisons at explicit source/hub heights, empty/malformed/changed code, chain/height mismatches and a replaced observed source block. Existing record projection coverage includes removal of stale `runtimeObservation`.

The two-Anvil/actual CLI integration establishes synthetic expected hashes from its owned fixture deployments before injecting faults. This is not independently approved production provenance. Its successful check records the expected source code hash and pins hub runtime reads to the shared block. All prior policy-weakening, final observation fault, source reorg, revert, cancellation and actual SIGKILL branches remain.

The final branch appends an unreachable STOP byte to the Source code only in owned Anvil state. `EPOCH_SCHEMA_VERSION()` still returns 2, but the runtime hash changes. The actual `--check` exits 1 with `EPOCH_RUNTIME_MISMATCH`; actual `--resume-publication` also exits 1 and releases its normal lease. Previous successful JSON/Markdown remain byte-identical, and the publisher's nonce stays at three: two source epoch transactions and one synthetic issuance. No pin-mismatch transaction is sent. The local chains are discarded in owned cleanup, not restored through a production code-change operation.

The first type check caught readonly properties inherited by a mapped TypeScript type; the hash-map type was corrected before runtime tests. No contract behavior or comparison was relaxed. No public runtime was changed, no production hashes were approved, and no actual deployment or native-proof verification was performed.
