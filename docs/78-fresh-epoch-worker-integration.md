# T-15 / T-23 / T-39 — Fresh publisher through the actual worker

2026-09-07. The [first fresh-CLI integration](77-fresh-epoch-cli-integration.md) used a parent-issued `ASC.execute` transaction to satisfy the publisher's hub wait. The same integration now starts the actual `worker/index.ts` subprocess to perform the relay. This changes the evidence from two separately exercised components to one connected local publisher→worker→ASC→publisher-check flow. A later [exact-carry correction](79-exact-epoch-carry.md) binds propagation to that actual worker receipt and adds a separate source epoch-2/no-hub-carry refusal branch.

The isolated synthetic-list setup, actual new `--publish`, encrypted raw persistence before source broadcast, source accepted/lost-ACK recovery and tampered-list second-publication refusal remain unchanged. The test parent no longer sends `ASC.execute`.

## Executed path

After the real Source accepts epoch 1, the test asserts source epoch 1 but hub epoch 0, with the publisher still running. The test mines until that source receipt is below Anvil's finalized head. A loopback fixture service implements the attested-height and exact proof-by-transaction GET routes. Its payload wraps the **actual source receipt**, including `RosterIssuerAuthorized` and `RosterEpochPublished`; the cryptographic native verification is still mocked.

The actual worker receives its own dedicated synthetic payer key, a persistent state path, explicit source replay start at the epoch receipt, chain/source/ASC settings, positive source/hub confirmation settings and a separate nonexistent dotenv path. It does not receive the publisher key or workspace secrets. Existing production worker code performs startup scope/binding checks, finalized source scan, attestation/proof HTTP requests, durable hub transaction submission, source/canonical receipt reconciliation and terminal state persistence.

The test requires:

- One action-3 job for the original source transaction, with one triggering epoch event. The complete proved receipt still contains both issuer authorization and epoch events; `job.logCount` is not the total receipt-log count.
- The exact chain/height/transaction-index query ID, one successful relay history entry, matching stored hub transaction hash and an actual successful hub receipt/processed query.
- Exactly one attested-height request, one proof request and one nonce consumed by the worker's dedicated hub wallet.
- Graceful `SIGTERM` exit code 0 and removal of only the worker's normal state/signer leases.
- The original publisher CLI observes worker-produced hub state and exits 0 after the existing common-block runtime, binding, full policy, issuer and three proof-verdict checks.
- A normal worker restart with the same state scans newly finalized empty blocks without another proof request, relay-history entry or hub nonce. It also exits cleanly.

This models normal process restart, not a new crash/unknown-hub-ack drill; those remain the separate actual worker crash integration. The new proof service is deterministic fixture HTTP, not the real attestation/proof builder, and the native verifier remains mock code on owned Anvil. A publisher exit 0 here is not public cross-chain proof readiness or a production SLA.

## Test corrections and reproduction

The first connected run did not discover the epoch because the fixture only mined one block; the worker correctly waited for Anvil's finalized height. The harness now mines enough blocks and waits for the finalized cursor on restart, without reducing the worker's finality checks. A second assertion incorrectly expected `logCount=2`; inspection confirmed the authorization event is receipt evidence, not a separate scheduling trigger. The assertion now requires one triggering event and separately requires both complete source logs. No production code or contract condition was relaxed.

`npm run test:epoch-publication` runs the expanded fresh-CLI/worker test and the earlier publication recovery test. This extends one existing integration; total separate Anvil/root-unit counts do not increase. All chains, proof HTTP server, child processes, state and synthetic list files are owned local fixtures. No real API provider, public chain, journal, deployment or official sanctions file was modified.

Remaining requirements include current authentic lists and member screening/completeness approval, real proof/attestation/native verification, external issuer signature workflows, approved runtime/issuer and production key/storage configuration, public deployment, operator recovery/renewal/availability and independent legal/security/customer evidence. Connecting the actual worker locally does not close those requirements or the 56-ticket goal.
