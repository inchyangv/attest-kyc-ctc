# T-23 / T-39 / T-40 — Fresh publisher CLI local integration

2026-09-07 initial stage. Earlier tests executed the publication transport with a fixture readiness callback, then exercised the actual resume/check CLI. They did not execute a fresh `--publish` from real list loading through journaled source send, hub wait and final checks. This integration closes that **local CLI wiring** gap, not official-list or public-native-proof readiness. The later [actual worker connection](78-fresh-epoch-worker-integration.md) replaces this stage's parent-issued relay in the current test; the initial implementation and its limitations are recorded below.

## Isolation and execution

`test/epoch-publish-cli.integration.ts` copies the current unmodified CLI into an owned temporary repository-shaped directory and asserts behavior through a child process. Its `REPO/data/raw` is separate from the workspace data. Pipeline/AML code and installed dependencies are linked read-only by test convention; the child uses the same implementations. Deployment address configuration is overridden for two owned Anvil nodes. The child receives a minimal environment and a nonexistent temporary dotenv path, not workspace secrets. No production option was introduced to bypass list/freshness checks.

The fixture downloader returns one explicitly fictional XML record per list. Real snapshot activation, XML parsing, hashes/counts, manifest/snapshot ID and freshness checks run. The fixture metadata uses the configured source identifiers/URLs as required by the parser contract; **no official-source HTTP request occurred**. These synthetic manifests must never be published as real sanctions-list evidence. Both Anvil clocks start shortly before the test clock, within existing cutoff bounds; neither freshness validation nor real list timestamps are patched.

The parent creates a synthetic sandbox credential for the CLI's demo subject, actual Source/linked ASC/Registry contracts and exact frozen demo policies. The publication signer is already an authorized issuer/publisher and has nonce 1 from that fixture issuance. Expected runtime hashes are established from owned deployments before fault injection; these are synthetic expectations, not independent production approvals.

## Verified sequence

1. The actual `--publish` child loads and checks all three synthetic lists, replays the complete source history through a finalized cutoff, constructs its epoch and implicit issuer approval, verifies runtime/roles/call conditions, acquires the real journal and signs.
2. At its actual `eth_sendRawTransaction`, a loopback proxy independently decrypts the journal and requires the exact raw transaction to be stored with nonce 1 and no confirmation. Only then does the proxy send to the real local Source. It returns a deliberate RPC error after acceptance, simulating a lost acknowledgement.
3. The CLI reconciles that same source transaction. The parent transports its actual receipt logs into the actual ASC using an explicitly mocked native verifier. This is a harness relay, **not the worker, Attestcoin attestation service, cryptographic inclusion/continuity proof or public CC3 carry**.
4. The same CLI invocation detects the hub epoch, records its local propagation observation and executes the real common-block runtime/binding/whole-policy/issuer/proof checks. It exits 0 with pilot=true, production=false and non-inclusion=true. The resulting record binds the original hash, synthetic snapshot ID, source manifest, policy/runtime/hub observations and measured acceptance time.
5. There is one publication broadcast despite the lost acknowledgement. The publisher's final nonce is 2: fixture issuance plus one epoch. Reopening the encrypted journal confirms exactly the original raw/hash and successful source receipt. Output contains neither raw signed bytes nor the publisher key.
6. The test modifies only its owned active OFAC fixture file without updating the manifest and runs actual `--publish` again. It exits 1 before a new intent/send, keeps epoch 1 and nonce 2, preserves the existing record bytes, and leaves one journal entry. No refresh or waiver repairs the tamper automatically.

The first test run caught a missing AML-module link in the isolated repository harness; adding that link fixed module resolution without changing the CLI. The successful and tampered-list branches were then rerun. Cleanup terminates only owned children and removes only the owned temporary directory; real source data, journals and deployment records are untouched.

## Reproduction and remaining scope

`npm run test:epoch-publication` now builds contracts and runs both the prior recovery/fault integration and this fresh-CLI integration. CI runs both explicitly, and TypeScript includes the new test. This adds **one separate Anvil integration**, not a root-unit-test count. Source-bound root reports still do not aggregate these integration results.

The local CLI now has an executed fresh success and a list-integrity refusal. Still required: current authentic official-list refresh, per-subject screening/completeness approval, external issuer authorization workflows, actual worker/proof-service/native verification and public carry, independently approved runtime/issuer configuration, public deployment and operational recovery/availability evidence. No customer, legal, security-audit or submission approval is inferred from exit 0 under these local fixtures. The 56-ticket goal remains incomplete.
