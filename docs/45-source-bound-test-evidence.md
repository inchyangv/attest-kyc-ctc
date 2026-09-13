# T-40 — source-bound local test evidence

2026-09-07. The static submission checker no longer certifies the historical **57/123** numbers by finding them in prose. It consumes execution results from the actual current tests. This is local evidence, not a signed build attestation or public release approval.

## Commands and their distinct meaning

```sh
npm run check:submission -- --docs-only
npm run test:evidence
npm run check:submission
```

- `--docs-only` checks local address/caption/narration/driver-source declarations. It prints that test execution and release readiness are **not checked**. Driver preview field declarations are not proof that the E2E driver ran or the onchain policy passed. The obsolete English-only restriction is removed: Korean internal diligence is permitted; no official submission-language rule is asserted here.
- `test:evidence` runs `forge test --json` and every top-level `*.test.ts` file in worker, pipeline, AML and compiled-ABI test directories. It uses a custom Node reporter to consume `test:summary` events, not console/TAP-like text printed by a test. Foundry status fields and exactly one root Node summary supply counts. Nonzero process exit, empty/inconsistent output, failure/skip/cancellation/todo, timeout or source changes during the run prevent creation of a passing report.
- Default `check:submission` requires a passing report younger than 24 hours with the same source fingerprint and exact test-file set. Missing/stale/changed evidence fails. Its final message says that public deployment, freshness, video, external reproduction, legal/commercial evidence and final submission are **not verified**. `verify:submission` still has to pass the later live/read-only gates; nothing here bypasses their legacy-deployment rejection.

`artifacts/test-evidence/run-*/report.json` stores each successful local run. `latest.json` is an atomic convenience replacement pointing to the newest report content; earlier run directories remain. Reports are gitignored, mode 0600, and not committed or uploaded by these local commands. They contain counts, test filenames, timestamps, Node/Foundry versions and a source fingerprint, not private keys or raw test logs. Failed command stderr is bounded in the terminal for diagnosis. This is not a crash-proof database or retention-policy implementation for artifacts.

## Fingerprint and limits

The fingerprint includes relevant tracked **and untracked** source/configuration/test/documentation files, root lock/config files and README, including deleted tracked paths. It excludes `.env`/keys, runtime state, generated artifacts and gitignored dependencies. `forge-std` must be clean; its checked-out revision is included. Selected historical AML XML bytes and the optional current-generation pointer are included even though raw lists are gitignored: the AML property tests really consume them. Escaping source/data symlinks are refused. Changing code or that dataset invalidates a prior report.

TICKET.md is intentionally excluded as an execution ledger so recording the resulting counts does not invalidate its own evidence. A report does not prove that every public sentence is current or that an omitted dependency/runtime environment is harmless. Package locks identify intended dependencies, not a measured running container. The underlying compiler/binaries/OS are not cryptographically attested. Anyone who can rewrite the tool/report can forge local evidence; independent review, controlled CI provenance and a reviewed release commit remain T-42/T-54 gates.

The 24-hour freshness rule is an internal verification rule, not a hackathon/legal deadline. Historical AML fixture success is not fresh sanctions ingestion. Missing raw lists cause the corresponding tests to skip; the evidence runner **rejects skipped runs**, rather than reporting a smaller green count. Operators must prepare the intended data; this command does not fetch sources or fabricate source timestamps.

## CI scope

The TypeScript job keeps an early `--docs-only` check, then obtains official AML data, installs pinned Foundry, runs complete test evidence, validates it and uploads its report for 14 days with the pinned artifact action. The existing contracts/API/Redis/local-EVM jobs remain distinct. A live source-refresh failure can still block the complete evidence job; the previously observed EU failure was not bypassed by using historical data in CI. No remote CI run, push or deployment was performed as part of this change.

## Regression checks

`pipeline/test-evidence.test.ts` verifies six boundaries: Foundry status parsing; unique root Node summaries; rejection of failed/skipped/cancelled/todo reports; time/source/file/tool mismatches; an actual child Node runner whose test prints a forged 999-pass summary but really runs one pass/one skip; and a temporary Git fixture where dirty source/raw XML changes the fingerprint, `.env` does not, and a dirty dependency is rejected. The nested reporter test clears only the inherited Node test-runner context to launch an independent runner; it does not change the production evidence command's checks.

The first reporter regression exposed a nested-runner context issue and was corrected; an empty child report never became passing evidence. Temporary Git commits exist only inside the test's disposable fixture, not in the user repository.
