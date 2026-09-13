# AML name evidence, identity comparison and regression gates

Working-tree implementation, reverified 2026-09-07. The T-26 evidence-format boundary was introduced in engine `aml-1.1.0`; the current engine is `aml-1.4.0`, the internal evaluation policy is `aml-internal-regression-1`, and the separate holdout report format is `aml-holdout-evaluation-1`. No live screening decision, rescreen run, customer record or deployed engine was changed.

Later engine versions add the bounded retrieval changes documented in [name candidate retrieval](29-aml-edit-retrieval.md) while retaining these identity rules. The description below records the T-26 boundary; current retrieval behavior follows that later document.

## Corrected defect

The old matcher assigned `corroborated=true` to every non-inferred name candidate, even when neither date of birth nor nationality supported it. It also treated different complete birth dates in the same year as a match. Thus `PM-T26-01`, the synthetic `Victor Sampleton` fixture with conflicting DOB/country, was automatically blocked.

Name score and descriptor comparison are now independent. Every built-in name hit carries `identityComparison.dob` (`match`, `year-match`, `conflict`, `missing`, `invalid`) and `identityComparison.nationality` (`match`, `conflict`, `missing`, `invalid`). Full dates require full equality and valid calendar dates. Year matching applies only when at least one side is genuinely year-only. Listed dates are alternatives: one exact alternative can support a match. Missing data is not a match or an explicit conflict.

`corroboration` records positive DOB/country comparisons even if another descriptor conflicts. `corroborated` is true only when there is positive support and no conflict or invalid comparison; it is not itself sufficient for a BLOCK. Supplied descriptors may still be self-declared. These fields do not prove the person owns the identity or establish a legal designation.

## Internal decision boundary

| Candidate evidence | Local result, unless another stronger condition applies |
|---|---|
| Exact listed wallet | BLOCK; wallet provenance cannot be overwritten by weaker name evidence |
| Name score ≥ 0.88, full DOB match, no conflicting/invalid descriptor | BLOCK |
| Decision-driving name score ≥ 0.82 with a descriptor conflict | REVIEW / `IDENTITY_CONFLICT` |
| Decision-driving name score ≥ 0.82 with only year/country support or missing descriptors | REVIEW / `NAME_SIMILARITY` |
| Inferred Hangul expansion with no positive descriptor support | Recorded but does not independently move the decision; this pre-existing exception remains a T-25 risk/validation topic |

For an inferred expansion, positive descriptor support plus a conflicting descriptor now drives review rather than being silently ignored. The existing jurisdiction and missing-DOB rules still apply. Country-only or year-only support never triggers automatic name blocking. A conflict does not automatically clear a customer: direct name candidates remain under review. Both REVIEW and BLOCK prevent positive credential issuance; pipeline regression tests verify that neither yields attrs or a claims root.

These are provisional engineering rules for the sandbox, **not a claim of legal compliance or an approved production decision policy**. OFAC advises comparing a potential name hit against the complete entry and available identifying information, seeking more information when necessary. [OFAC FAQ 5](https://ofac.treasury.gov/faqs/5) Its public search score is name-based, separate from other descriptors. [OFAC FAQ 251](https://ofac.treasury.gov/faqs/251) Those references inform the separation of signals; they do not endorse our thresholds, inferred-name exception or automated BLOCK rule. Applicable obligations and the manual-review/escalation boundary need the institution's qualified compliance approval.

## No silent candidate cutoff before a decision

The 50-candidate per-search and 25-hit final slices were removed from the decision path. All candidates returned by the current token index reach identity comparison and decision evaluation. A 76-entry synthetic collision test places the only full-DOB-supported entry last and still blocks. Decision-driving hits are ordered first for the public API's separate eight-hit presentation limit; the full hit evidence participates in the digest.

At the 1.1 boundary this did **not** fix recall before candidate generation: the index still omitted stop/high-frequency tokens and lacked edit distance. The subsequent [1.2 retrieval change](29-aml-edit-retrieval.md) fixes those specific omissions and the `Viktor Sampleton` example. Broader multilingual/short-name recall remains open. Removing slices increases worst-case work/evidence size; it does not provide a corpus-wide resource bound. Do not reintroduce silent truncation as a performance fix—explicit overload/review behavior and measured candidate retrieval are required.

## Evidence and UI

Hit digest records now include comparison states, so changing from supported DOB to a conflicting DOB changes the canonical evidence digest. No cleartext input name or DOB is added. The engine version increments because old and new evidence are not interchangeable. The screening UI shows full-date/year-only/conflict/missing states rather than saying every uncorroborated hit “does not hold” the person. The digest label correctly identifies SHA-256 for this screening record, distinct from the pipeline's chained evidence commitment.

This change does not reinterpret old evidence, rewrite active credentials, clear past denials or implement an appeal. Those require T-13/T-20 and a reviewed migration. Before release, archive the old rules and list snapshot, retain engine versions, approve new handling, and plan re-evaluation of affected historical cases without overwriting their original decisions.

## Reproducible internal results

`npm run test:ts` and `npm run test:all` now include every `aml/*.test.ts`, and root type checking includes AML test sources. `npx tsx aml/eval.ts` now exits nonzero on a missing positive, unexpected clean hold, missed normalization variant, failed wallet block, unearned PEP/adverse-media bits or an undersized sample. A gate unit test injects each failure metric and verifies rejection. The CI already runs `test:ts` and `aml/eval.ts` after fetching the lists, so these are executable gates rather than printed success-looking statistics.

The current local XML snapshot produced:

- 26,574 entries: OFAC 19,329, UN 1,011, EU 6,234.
- 200 deterministic in-list positives: **BLOCK 167, REVIEW 33, ALLOW 0**. The previous “200 blocked” result is historical.
- 610 synthetic clean names: zero BLOCK/REVIEW outcomes.
- Seven normalization variants of one selected name: seven caught; exact listed wallet: BLOCK.

| Local source file | SHA-256 |
|---|---|
| `ofac_sdn.xml` | `a6fe1073e4cc3a9ea9b827f63f5ab56b80933603a8af791b21d7cacbf99da598` |
| `un_consolidated.xml` | `683c29b7a7dedca7fdb5e48728b18d692e6bbbb1f41616c8aa8430b6f585c2a2` |
| `eu_fsf.xml` | `0c83e632fea7709d9c75bdd1deb4fa50782a93d2c99459f01c7a7a2d873c79c9` |

The evaluator prints engine/evaluation versions, sampling description, full source hashes and metrics on every run. Different list contents may legitimately fail a frozen internal regression; investigate the changed cases instead of automatically loosening the thresholds.

These are **internal regression results**, not independent holdout estimates, actual customer false-positive rates, multilingual typo recall or production investigation workload. The positive set is selected from the same list used for matching; the clean set is synthetic and Korean-heavy; normalization variants cover one name. Some source-backed unit tests skip when local XML is absent; the standalone evaluation requires all files and fails if they are absent, and CI runs that evaluator. T-29 still requires independently labelled and held-out evaluation by script/country/entity/list, review workload, approved thresholds and versioned reports. T-26 still requires compliance sign-off and deployed/operational validation.

## T-29 evaluation paths

The CI path and a supplied holdout now use different commands and report semantics:

- `npm run eval:aml` is the frozen internal regression gate. Its optional `--out <new-report.json>` writes an exclusive mode-0600 JSON report containing the engine/evaluation versions, exact source hashes and counts, deterministic sample construction, thresholds, outcomes, Wilson upper bounds, and explicit statistical limits. The 2026-09-07 fresh-manifest run is `artifacts/aml-evaluation/2026-09-07-t29-current/report.json`, fingerprint `6ac6708b49938feee4817c95740a79e3c276d5d5c5aa4a4ac70236ccf7354f32`.
- `npm run eval:aml:holdout -- --dataset <approved.json> --policy <thresholds.json> --out <new-report.json>` consumes a separately supplied labelled dataset. Add `--historical` only for offline regression against the repository snapshot. Each row requires ground truth, country, script, source list, entity type, label basis and optional completed investigation time. Dataset metadata records the label owner, selection protocol, whether labels were independent, whether the set was held out from development, and whether it contains personal data.
- The holdout report contains aggregate BLOCK/REVIEW/ALLOW counts, binary hold confusion matrices overall and by country/script/list/entity type, review rate, recorded investigation-time coverage/mean/p50/p95, source and dataset fingerprints, thresholds, and Wilson intervals. It does not copy subjects or case IDs into the report. Free-text dataset metadata must not contain names or other subject data.
- The runner validates metadata and reports `independenceMetadataComplete`; it does not authenticate the asserted evaluator identity or turn a locally supplied file into independent approval. Threshold failure exits nonzero and writes no success report.

`PM-T29-01` exercises the real matcher on a small Latin/Arabic synthetic corpus and then replaces every result with `ALLOW`. Before the holdout evaluator existed, the new regression failed at module load (**0/1**). The implemented evaluator reports two false negatives for the sabotaged engine and its threshold gate rejects the run; the same fixture passes with the real matcher. A CLI integration separately parses the repository list snapshot, writes a redacted source-bound report, and keeps its internal fixture marked incomplete for independence.

## T-26 re-execution evidence

On 2026-09-07 the exact `PM-T26-01` assertion failed against isolated `HEAD` because the result was `BLOCK` rather than `REVIEW`; it passes against the working tree with `corroborated=false`, DOB/country `conflict`, and `IDENTITY_CONFLICT`. The focused identity suite passed 10/10, all AML tests passed 59/59, and the real Next handler suite passed 60/60. The source-bound report is `artifacts/test-evidence/run-JyFKLP/report.json`, fingerprint `727a5d41f1af60215096e600dd386bfa8eb82ac752b6709f88b2f2649f713c55`, with Solidity 118/118 and TypeScript/ABI 556/556. These are synthetic/local results, not compliance approval, historical-case remediation, or operational deployment evidence.
