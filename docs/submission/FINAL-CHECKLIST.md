# Final submission checklist

> **2026-09-10 development update:** use [WIN-01~14 and its verification ledger](../88-winning-sprint.md) for the new provider/ZK/judge work. The v1 refresh instructions below are historical deployment-specific steps, not authorization to send transactions. Do not claim provider-issued onchain credentials, end-to-end ZK, or current AML propagation until their linked acceptance evidence exists.

> Updated 2026-09-07 for the two-minute cut. Run the on-chain refresh and the recording from a checkout that matches the live v1 contracts (see `docs/demo-video/PREFLIGHT.md`, step d).

The repository work can be completed early; the evidence cannot. Frozen sandbox policy 2 accepts
a mark for only seven days after issuance, so execute the time-gated section within seven days of
judging and preferably within 48 hours of recording.

## Time-gated on-chain refresh

- [ ] Start the worker before sending any source transaction: `npm run worker`.
- [ ] Confirm `DEMO_SUBJECT_A_KEY` and `DEMO_SUBJECT_B_KEY` resolve to the two KPCN holders.
- [ ] Run `npx tsx script/demo-gate-issue.ts --dry-run`; both marks must say regime 2 and include
      the three bits required by policy 2.
- [ ] Run `npx tsx script/demo-gate-issue.ts`; record the new Sepolia `issueBatch` transaction.
- [ ] Wait until both A and B return true under policy 2 on CC3.
- [ ] Run `npx tsx script/publish-epoch.ts --dry-run`; read every exclusion.
- [ ] Run `npx tsx script/publish-epoch.ts --publish`; retain the generated epoch JSON and Markdown.
- [ ] Run `npm run verify:submission`; every check must pass with at least 24 hours of policy
      freshness remaining.
- [ ] Replace old transaction links and timing claims in README, the evidence manifest, deck and
      video kit only with values emitted by these runs.

Never loosen policy 2 or extend a mark's timestamp to keep the demo alive. Refresh the evidence.

## Record

- [ ] Run every item in `docs/demo-video/PREFLIGHT.md`.
- [ ] Re-issue holders A and B and wait for policy 2 to return true before recording; film scene 6 before scene 7.
- [ ] Keep `demo:id`, `demo:bank`, regime 2, production FAIL and sandbox PASS legible.
- [ ] Render the scene 4 caption: “edited — cross-chain propagation took about 9 minutes”, and fill the scene 7 caption from the measured wait.
- [ ] Show `RecipientNotVerified` and `SenderNotVerified`, never `OwnableUnauthorizedAccount`.
- [ ] Keep the final cut at or below 2:00.
- [ ] Watch once with audio and once muted at 1080p; hashes and labels must remain readable.
- [ ] Upload, open the public URL in a private window and add it to README and the submission form.

## Independent reproduction

- [ ] Give an outside reviewer only the public repository and
      `docs/submission/reproduction-template.md`.
- [ ] Fix every ambiguity they encounter.
- [ ] Retain the dated, completed reproduction record; do not claim it while the template is blank.

## Submission form

- [ ] Product name is only “Proofmark”.
- [ ] First sentence calls it a Creditcoin compliance gateway, not a regulated KYC provider.
- [ ] Track is RWA.
- [ ] Repository, product, on-chain page, video, deck and transaction links open privately.
- [ ] Live, Sandbox and Roadmap claims match `docs/15-submission-evidence.md`.
- [ ] No claim says production-ready, audited, anonymous, instant, paid or funded.
- [ ] Team details, residence, citizenship and eligibility are confirmed by each person.
- [ ] Final commit is pushed and its CI run is green.
- [ ] Submit before 2026-09-14 12:59 KST and retain a screenshot of confirmation.
