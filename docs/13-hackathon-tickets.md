# Proofmark hackathon tickets

> Scope frozen: 2026-09-03 to the 2026-09-14 submission deadline.
> This file is the source of truth for hackathon work. Production-only work is deliberately out of
> scope. Every ticket must end in repository evidence that a judge can inspect.

## Status legend

- `TODO`: not started
- `DOING`: being implemented
- `VERIFY`: implementation exists; final evidence or human rehearsal remains
- `DONE`: completion evidence is linked from this file
- `EXTERNAL`: the repository work is complete, but a named human or outside organisation must act
- `TIME-GATED`: executing it now would make the evidence stale before judging

## Submission gate

| ID | Priority | Ticket | Definition of done | Status |
|---|---|---|---|---|
| HACK-01 | P0 | Make sandbox/production language contradiction-free | Every public script and submission document says demo ID/bank checks create regime 2, pass policy 2, and fail policy 1 | DONE |
| HACK-02 | P0 | Reconcile stale repository status | Test counts, Mode B status, GitHub status, deployment addresses and completed roadmap entries agree across active documents | DONE |
| HACK-03 | P0 | Ship a five-minute judge verification path | One read-only command verifies public URLs, source pinning, frozen policies, both policy verdicts, the gated rejection and roster verdicts | DONE |
| HACK-04 | P0 | Package the consumer integration | Copyable Solidity and TypeScript examples show the one registry call an application needs and document fail-closed behaviour | DONE |
| HACK-05 | P0 | Publish a concise threat model | One document states assets, actors, trust boundaries, mitigations, residual demo risks and production non-claims | DONE |
| HACK-06 | P0 | Make the final three-minute demo recordable | Shot list, narration, commands and preflight agree; automated checks catch narration-critical drift | DONE |
| HACK-07 | P0 | Create a submission evidence manifest | One page separates Live, Sandbox and Roadmap claims and links every live claim to a transaction, deployment file, test or public endpoint | DONE |
| HACK-08 | P1 | Publish observed propagation evidence | Existing observations use one schema, distinguish source-to-hub from worker E2E latency, and never claim a statistical SLA | DONE |
| HACK-09 | P1 | Specify an external credential adapter | Versioned interface and conformance cases cover issuer, methods, assurance, regime, jurisdiction, freshness, replay and revocation without claiming a live partner | DONE |
| HACK-10 | P1 | Prepare design-partner discovery | Target profile, outreach text, interview questions and a discovery-note template are ready for one Creditcoin application interview | DONE |
| HACK-11 | P1 | Run an outside-the-team reproduction | A person receives only the public repository, records elapsed time and blockers, and signs a dated reproduction note | EXTERNAL |
| HACK-12 | P1 | Record and publish the final video | Final cut is at most 3:00, visibly labels the edited wait and demo vendors, and is linked from README/submission material | EXTERNAL |
| HACK-13 | P0 | Refresh expiring on-chain demo evidence | Within seven days of judging, issue fresh demo holders, republish the roster if needed, rerun the gate and update every recorded transaction | TIME-GATED |
| HACK-14 | P0 | Submit the final package | Fresh evidence, video URL, public links, team eligibility and a green final CI run are entered before the deadline; confirmation is retained | TIME-GATED |
| HACK-15 | P1 | Keep project documentation in English | The Korean diligence report is replaced by an English edition, all active Markdown is English-only, and the submission checker rejects Hangul drift | DONE |

## Explicitly deferred until after the hackathon

These are important production tasks, not unfinished hackathon tickets: managed DB/KMS, vendor
contracts, licensed PEP/adverse-media data, legal sign-off, formal audit, production key ceremony,
worker HA, ZK disclosure, new jurisdictions and spoke chains. None may be described as live.

## Remaining human/time-gated actions

| Ticket | When | Owner action |
|---|---|---|
| HACK-11 | After this change is pushed publicly | Give an outside reviewer only the clone command in `docs/submission/reproduction-template.md`; retain their completed record |
| HACK-12 | After HACK-13 passes | Record the prepared two-take script, render the explicit edited-wait caption, upload and add the public URL |
| HACK-13 | Within seven days of judging; current marks and epoch 2 both stop passing policy 2 at 2026-09-14 15:11 UTC | Follow `docs/submission/FINAL-CHECKLIST.md` from the `v1-live` checkout (re-issue, then publish the next epoch); `npm run verify:submission` must stay green afterwards |
| HACK-14 | Before 2026-09-14 12:59 KST | Confirm team eligibility, final links and green CI, submit, retain confirmation |

## Execution log

| Date | Ticket | Evidence |
|---|---|---|
| 2026-09-03 | Backlog created | This file |
| 2026-09-03 | HACK-01 | Corrected the narration and E2E driver: regime 2 must fail policy 1 and pass policy 2 |
| 2026-09-03 | HACK-02 | Reconciled test counts, Mode B, batch revoke, GitHub and deck status |
| 2026-09-03 | HACK-03 | `npm run verify:submission` passed: public URLs, policy split, gate and roster proofs |
| 2026-09-03 | HACK-04 | `src/examples/ProofmarkConsumer.sol` and `examples/consumer/check.ts`; live read returned policy 2 `true` |
| 2026-09-03 | HACK-05 | `docs/14-hackathon-threat-model.md` |
| 2026-09-03 | HACK-06 | Narration fixed to 437/450 words; preflight now calls the complete verifier |
| 2026-09-03 | HACK-07 | `docs/15-submission-evidence.md` |
| 2026-09-03 | HACK-08 | `docs/16-propagation-observations.md` |
| 2026-09-03 | HACK-09 | `docs/17-external-credential-adapter.md` |
| 2026-09-03 | HACK-10 | `docs/18-design-partner-discovery.md` |
| 2026-09-03 | HACK-15 | Replaced the Korean diligence report with `docs/12-ctc-investment-review.md` and added an English-only documentation guard |
| 2026-09-03 | HACK-13 | Added `npm run check:freshness`; both holders currently pass with 143h remaining, exposing the required pre-judging refresh |
| 2026-09-03 | Regression | 57 Solidity and 123 TypeScript tests, typecheck, web lint/build, shell/Node syntax and full public submission verification passed |
| 2026-09-07 | HACK-13 | Holders A and B re-issued in Sepolia `issueBatch` [`0x80140a23…155d`](https://sepolia.etherscan.io/tx/0x80140a23f93c26fdba0de88b53cee2398aaad483d1f5cbdeab155b6fa782155d) (block 11654962) with `docs/demo-video/reissue-ab.sh`; policy 2 passes until 2026-09-14 15:11 UTC. The roster was not republished |
| 2026-09-08 | HACK-03 | Judge path repaired for the live v1 build: `verify:submission`, `check:freshness` and `verify:epoch` now route by the deployed registry generation (`pipeline/roster-legacy-v1.ts`, `pipeline/demo-freshness-legacy.ts`, 7 new tests); the full read-only verification passed against attest-kyc.stabled.ai |
| 2026-09-08 | HACK-07 | Evidence manifest reconciled with the 2026-09-07 refresh, the corrected scene numbers and the time-bound epoch 1 roster verdict |
| 2026-09-08 | HACK-13 | Epoch 2 (root `0xa347701c…e847`, the 2026-09-07 marks) published in Sepolia [`0xde9743af…c3b9`](https://sepolia.etherscan.io/tx/0xde9743af4f8895b152b49c0c67d2a0034ed392cd201a3f28d4f1bdbca4a7c3b9) block 11661380 and accepted on CC3 in [`0x519bd88c…a9a1`](https://creditcoin-testnet.blockscout.com/tx/0x519bd88c03b37dd6e0db4defb73c149c394873a01e2d7598697d12b62cc8a9a1) after 8m 15s; all three registry verdicts match; `deployments/epoch-2.json` recorded |
