# T-40 — Check the policy, not only its booleans

2026-09-07. The epoch CLI previously required pilot=true and production=false for the demo mark, but those booleans do not establish the policy being demonstrated. A weaker minimum assurance or wildcard issuer can produce exactly the same results. A registry advertising compatible schema and returning the expected verdicts was therefore insufficient evidence of the intended demo configuration.

## Implemented checks

`pipeline/epoch-policy.ts` compares both policies at the same hub observation block already used by the CLI. The required demo template follows `script/deploy.sh` and the existing demo-freshness checker:

| Field | Policy 1 | Policy 2 |
|---|---|---|
| requireAll | 65572 | 65572 |
| minAssurance | 2 | 2 |
| maxAge | 2,592,000 seconds | 604,800 seconds |
| requiredRegime | 1 | 2 |
| requiredJurisdiction | 410 | 410 |
| trustedIssuer | Explicit `DEMO_EXPECTED_ISSUER` | Same explicit issuer |
| requireRoster / exists / frozen | All true | All true |
| kind | 1, individual | 1, individual |

The registry must also report attributes schema 0 and policy schema 2. Any mismatch is an error before a new completed check record or success snippet is written. `policyObservation` records the expected issuer and all observed fields; source-only recovery strips it with old hub evidence.

`--check` now requires a valid nonzero `DEMO_EXPECTED_ISSUER` before making RPC requests. `--publish` requires the setting before journal acquisition/signing because its verification tail uses the same check. The actual full policy comparison occurs in that check; this change does not move every consumer-policy dependency before the source send. Resume and unsigned cancellation do not need this setting because they do not claim current policy verification. `.env.example` and CLI help document it. The address is never inferred from the policy, roster, publisher key or historical deployment. Supplying an environment variable is not proof that a real organization has approved it.

These are exact checks for this repository's demo, not a universal KYC policy or legal approval for regime 1. The production verdict must still reject the synthetic sandbox mark. Different customer policies need explicit agreed specifications, not relaxed comparisons to make this demo pass. Runtime-bytecode pins, actual issuer identity/authority, compromised-key invalidation and independent source/native-proof evidence remain separate requirements.

## Executed evidence

Two new root tests cover the complete successful observation and all eight ABI reads using the selected block. The negative matrix changes each of the eight policy tuple fields for each policy, then frozen state, credential kind and both schema versions. Missing, malformed and zero expected issuer values fail; a block number below one fails. These are controlled ABI fixtures, not on-chain policy mutations.

The actual two-Anvil/CLI integration's successful policies now exactly match the deployment template, including the production 30-day age limit (the preceding fixture used seven days for both policies). A second real Registry is deployed only in the owned local test with minimum assurance 1 and wildcard issuer, and both policies are frozen. Actual `verifyWithRoster` calls still return pilot=true and production=false for the same synthetic mark. The actual CLI rejects that Registry with `EPOCH_POLICY_MISMATCH` and preserves the previous successful JSON/Markdown byte-for-byte. All observed policy calls use the fixed hub block. This test extends the existing integration rather than increasing its suite count.

The first root run failed because the test fixture indexed an empty ethers ABI Result for no-argument version calls; the fixture was corrected to check argument length. The actual EVM branch passed that first run. The corrected root tests and integration were then rerun. There was no change to contract policy rules to accommodate the test.

No production Registry, issuer setting, deployment file, public chain or actual customer policy was changed. Existing external approval/deployment/native-proof/fresh-official-list requirements remain unverified.
