# Bounded edit name retrieval and its limits

Working-tree implementation, 2026-09-07. Engine `aml-1.4.0`. Local T-25 implementation and partial T-29 evaluation infrastructure; no production deployment, live rescreen, customer action or independent model validation.

## What now works

The reported `Victor Sampleton` / `Viktor Sampleton` miss is corrected at both retrieval and scoring. A shared exact token is no longer necessary: `Viktor Sampelton` retrieves the original even though both tokens changed. Tokens of 6–64 Unicode code points support up to two insertions, deletions, substitutions or adjacent transpositions; tokens of 4–5 code points support one. A three-part listed name with exactly one part absent from a supplied name is retained at the existing review floor when at least two parts remain. One-part fragments are not promoted.

The expanded `PM-T25-01` regression uses `Wiktor Alexander Sampleton`, `Victor Sampleton`, and a changed 64-code-point token. Before this change its first assertion failed (**0/1**, `Wiktor...` was ALLOW with no hit); after the change the same regression passes (**1/1**). The exact appendix-B `Viktor Sampleton` case remains covered.

The corpus retains all token postings. Stop-token-only names such as `Ali Hassan` and postings with more than 4,000 names are no longer silently excluded. A 4,002-entry collision test keeps the one identity-supported entry at the end and verifies that it still drives the decision. T-26's removal of candidate/result cutoffs remains in place; UI presentation limits do not limit evaluation.

## Retrieval and score

1. Normalize/tokenize the name as before. For edit operations, recompose each token to NFC and count Unicode code points.
2. For vocabulary tokens of 4–64 code points, index the original token plus all single-code-point deletion signatures. Query the same signatures and verify every resulting token pair with `withinOneEdit` before accepting it as a candidate key. Shared signatures alone are not a match.
3. For the 6–64 range, index distinct boundary bigrams to retrieve possible two-edit tokens. Every retrieved pair is verified with a Unicode-code-point restricted Damerau–Levenshtein distance capped at two. Bigrams are only retrieval keys; sharing one never creates a hit.
4. Retrieve all names attached to exact and accepted near tokens. Score each candidate using the largest of the existing exact-token score, bounded edit-token score, and missing-part score.
5. The edit score pairs exact tokens first, then the strongest remaining eligible pairs without reusing a token. An edited pair contributes `1 - distance / max(token lengths)`; the total is divided by the larger distinct-token count. This is a deterministic greedy score, **not** an optimal assignment, identity confidence or legal probability.
6. An exact one-part omission between a two- and three-part name scores 0.82, so it creates REVIEW rather than the full-DOB automatic BLOCK reserved for scores of at least 0.88. Edited remaining parts are discounted. This 0.82 behavior is an internal regression boundary, not an institution-approved risk decision.
7. Apply the existing [identity comparisons](28-aml-identity-comparison.md) independently. Name-only or conflicting identity evidence does not become a confirmed match because an edit was found. Existing thresholds remain: candidate floor 0.72, decision-driving review floor 0.82 and strong/full-DOB blocking floor 0.88. A retrieved candidate below the decision threshold may still result in ALLOW.

The 4-code-point minimum protects short names and initials from overbroad editing; two edits start at 6 points, and the 64 maximum bounds expansion and distance work. Neither cutoff is an approved institution-specific risk policy. Tokens below 4 or above 64 remain exact-searchable, and the matrix records both their exact success and edited miss rather than hiding the gap. Inferred Hangul romanizations retain exact-token matching rather than receiving a second edit-expansion layer. Different scripts are not treated as phonetically equivalent, and phonetic-only variants remain explicitly unmodeled.

The first implementation counted decomposed Hangul jamo. That incorrectly made three-syllable Korean names look like long tokens with small relative edits, producing four new clean-sample reviews. The frozen regression gate failed. NFC recomposition restored the already-intended short-token boundary; no affected names were whitelisted and no evaluation threshold was relaxed. A decomposed-Hangul regression now checks that boundary directly.

## Multiple supplied names and provenance

A supplied `romanizedName` supplements the original `fullName`; it cannot suppress original-script search. Both supplied names affect the evidence digests. Per-entry hits preserve `directNameScore` and `inferredNameScore`: a higher inferred expansion cannot erase a lower but decision-driving supplied-name match. Both path scores participate in the versioned hit evidence.

Entry deduplication now uses a map rather than repeated linear scans. Wallet hits retain their wallet provenance. Decisions are evaluated across the full returned candidate set and decision-driving hits appear first for presentation.

## Local verification and cost

Fourteen test groups in `aml/edit-distance.test.ts` cover one- and two-edit operations, two simultaneously changed tokens, a missing part, short/64/over-64 boundaries, stop/common-token retrieval, 4,002-name collisions, token non-reuse, original-name preservation, aliases, synthetic Cyrillic/Arabic/Hangul examples, inferred/direct precedence, evidence binding, and fail-closed index/query capacity. Together with the identity-policy regressions, the focused run is **24/24**.

`npm run eval:aml:t25` runs a separately routed, 19-row internally authored matrix. All 19 expected outcomes pass: 12/12 supported escalation cases, 2/2 supported clean ALLOW cases, and five declared boundary/unmodeled cases. The matrix breaks results out by operation and Latin/Cyrillic/Arabic/Hangul script, but its dataset identifier is literally `internal-synthetic-regression-not-independent-holdout`. It is evaluation plumbing and regression coverage, not the independent labelled holdout required for release.

The unchanged internal evaluator on the [recorded source snapshot](28-aml-identity-comparison.md) still gives 168 BLOCK, 32 REVIEW and zero ALLOW for 200 in-list positives; zero holds for 610 synthetic clean names; seven normalization variants caught; and the listed wallet blocked. `aml/eval.ts` retains its failing exit gate. This does not mean all one-edit names, short names, phonetic variants or token omissions are caught.

`npm run benchmark:aml` provides a read-only local observation. On Node v24.15.0, 26,566 entries and 200 ordered in-list queries, this run measured:

| Observation | Result |
|---|---|
| Engine/index construction | 430 ms |
| 200-query time / throughput | 6,224 ms / 32.13 queries/s |
| Query p50 / p95 / maximum | 29.22 / 63.45 / 97.04 ms |
| Largest returned hit set in that sample | 28 |
| Process RSS before construction / after queries / delta | 451.70 / 599.75 / 148.05 MiB |

RSS includes XML ingestion and the Node runtime; it is neither retained-index heap size nor a measurement of the web's baked-index path. There is no concurrent HTTP load in this benchmark. The additional retrieval index has a real memory/work cost. No production memory budget, throughput or latency SLA is inferred from these numbers.

Matching has fixed fail-closed ceilings instead of recall-destroying truncation: 250,000 indexed names, 1,500,000 token postings, 3,000,000 bigram postings, 64 input tokens, 300,000 query posting visits, 100,000 vocabulary candidates, and 100,000 candidate names. Crossing a ceiling throws `AML_MATCH_CAPACITY`; the web boundary converts screening failure to 503. Unit regressions prove both query and index overloads fail rather than return ALLOW. The recorded corpus and 200-query benchmark complete within these ceilings, but this is not a production capacity approval.

## Remaining T-25/T-29 release conditions

- Independent labelled holdout data and error analysis by script, name length, country, alias quality and entity type; institution-approved tradeoffs between missed hits, reviews and false positives.
- Institution decisions for the measured exact-only boundaries (tokens below 4 or above 64), more than two edits, more than one missing part, phonetic equivalence and ambiguous transliterations. The implementation exposes these as limits rather than claiming they are solved.
- Approved production capacity/latency budgets and concurrent HTTP/adversarial testing at the customer corpus and request shape. The local fixed ceilings and single-process observation are only fail-closed infrastructure.
- Real review handling and workload measurement, comparison with an approved commercial/provider alternative, and staged release with versioned evidence/rescreen procedures.

T-25 therefore remains `IN_PROGRESS`. The local counterexample and supported edit classes are fixed; the broader recall/operational completion criteria are not claimed complete.
