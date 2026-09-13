# T-27/T-34 — Official-feed observations

## Latest local activation — 2026-09-08 KST

At 2026-09-08 02:27–02:28 KST, the actual bounded fetcher completed fresh HTTP 200 full GETs from all three configured official endpoints. Validation, raw read-back, normal evaluation and v3 build succeeded. This time `data/raw/current.json` and `web/data/sanctions-index.json.gz` were activated **locally in the repository workspace**; nothing was copied to a deployed runtime and no rescreen, epoch, issuer or worker transaction was sent.

Snapshot ID: `55963f011be92e6c6d141b51348722e461633d8e54906b0ee2c6ec178f62ee6e`.

| Source | Full GET completed, UTC | Bytes | Parsed entries | Content SHA-256 |
|---|---|---:|---:|---|
| OFAC_SDN | 2026-09-07T17:27:36.228Z | 28,978,335 | 19,329 | `a6fe1073e4cc3a9ea9b827f63f5ab56b80933603a8af791b21d7cacbf99da598` |
| UN_CONSOLIDATED | 2026-09-07T17:27:40.385Z | 2,176,957 | 1,011 | `683c29b7a7dedca7fdb5e48728b18d692e6bbbb1f41616c8aa8430b6f585c2a2` |
| EU_FSF | 2026-09-07T17:28:56.195Z | 25,766,640 | 6,234 | `0c83e632fea7709d9c75bdd1deb4fa50782a93d2c99459f01c7a7a2d873c79c9` |

Total: **26,574 entries**. The content hashes and counts are unchanged from the isolated candidate below; new full-GET times and effective-transport commitments correctly create a different manifest ID. Normal evaluation with `aml-1.4.0` produced 167 BLOCK/33 REVIEW/0 ALLOW for 200 deterministic in-list positives, zero holds among 610 synthetic clean inputs, 7/7 normalization variants detected, listed-wallet BLOCK and zero unearned PEP/adverse/exposure bits. The compressed artifact is approximately 1.14 MB and has SHA-256 `25968c04a138291b675fe0378f3aecc5bd61ac868923db62268cbb323dcec4ae`.

The FATF call-for-action and increased-monitoring statements dated 2026-06-19 were separately checked against the official statement pages on 2026-09-08 KST. The versioned local observation has table ID `e190ac6ca4657aa6ef704b47922caa27f769399fa3897532a5e7941623996a58`; it is independent of the OFAC/UN/EU snapshot and has its own age bound. This confirms the encoded country sets against those pages, not the legal suitability of Proofmark's decision rules.

## Prior isolated candidate — 2026-09-07 KST

2026-09-07, 12:09 KST. **Successful isolated download/build/evaluation; no repository or deployed-runtime activation.** This is a dated observation, not a continuing availability guarantee, independent AML benchmark or legal completeness opinion.

## Observed candidate

The unmodified configured OFAC, UN and EU download endpoints all completed full HTTP 200 GETs through the actual curl fetcher. The existing XML validation, duplicate-ID/name checks, parser, full content hashes and index read-back passed. The first attempt earlier in the project failed at EU HTTP 500; that historical result is not the result of this run. The [Commission's current resource page](https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/overview-sanctions-and-related-resources_en) still links to its consolidated financial-sanctions service. No third-party mirror or alternative feed was substituted.

Final candidate: provenance **v2**, parser `proofmark-lists-2`, compressed index **v3**.

Snapshot ID: `81ffee16eb42605ba15f439477273be98e70496b6f161bf86031173b0c32223d`.

| Source | Full GET completed, UTC | Bytes | Parsed entries | Content SHA-256 |
|---|---|---:|---:|---|
| OFAC_SDN | 2026-09-07T03:08:27.492Z | 28,978,335 | 19,329 | `a6fe1073e4cc3a9ea9b827f63f5ab56b80933603a8af791b21d7cacbf99da598` |
| UN_CONSOLIDATED | 2026-09-07T03:08:31.561Z | 2,176,957 | 1,011 | `683c29b7a7dedca7fdb5e48728b18d692e6bbbb1f41616c8aa8430b6f585c2a2` |
| EU_FSF | 2026-09-07T03:09:30.256Z | 25,766,640 | 6,234 | `0c83e632fea7709d9c75bdd1deb4fa50782a93d2c99459f01c7a7a2d873c79c9` |

Total: **26,574 entries**. The build produced approximately 1.14 MB gzip. `publishedAt` remains null: HTTP Last-Modified and the date embedded in a redirected storage path do not prove the legally effective publication date. A successful full GET does not prove that a remote publisher is current or complete.

## Execution and boundaries

An owned temporary working directory `/tmp/proofmark-official-refresh.KxgcYJ` was used for the actual repository commands, with the absolute repository loader/script paths. Consequently the fetcher's relative `data/raw/current.json` and builder's `web/data/sanctions-index.json.gz` resolve **inside that temporary directory**, not the repository.

The final raw/index/manifest generation is `data/raw/generations/91d72709-2d44-45aa-827d-374bc64b64c2` under that directory. Fetch, normal `aml/eval.ts` (without `--historical`) and `aml/build-index.ts` each exited 0. Raw loading rehashed/reparsed the received bytes; the build revalidated provenance and index content. Repository `data/raw/current.json` remained absent and repository data/web-data status was unchanged. No runtime copy, rescreen, epoch publication, issuer spend, deployment or customer-data processing occurred.

Internal evaluation using `aml-1.3.1` / `aml-internal-regression-1`: 200 deterministic in-list positives yielded **167 BLOCK / 33 REVIEW / 0 ALLOW**; 610 synthetic clean inputs yielded 0 holds; seven transformations of one normalization target were caught; the listed-wallet fixture blocked; unearned PEP/adverse/exposure bits were zero. This sampling is not an independent holdout, population false-positive estimate or approved production decision policy. Prior historical-corpus results remain separate.

## Disclosure found and repaired before promotion

The initial successful candidate used provenance v1 and included the full signed OFAC/UN redirect URLs. Those transport URLs could flow into public snapshot/evidence responses. It was **not promoted**. The [transport-URL boundary](31-sanctions-snapshots.md#transport-url-boundary-and-migration) now removes query/fragment/userinfo and commits the exact URL only as SHA-256. A second real full download, not an edited timestamp or rehashed old file, produced the v2 candidate above. Both downloads had identical content hashes; their check times/transport commitments and manifest identities differ.

The initial v1 candidate and original curl diagnostics remain private local artifacts for inspection, not public submission material. Both owning temporary directories were observed with mode 0700; this is a local permission check, not backup or host-security assurance. Do not upload raw headers/old manifests containing temporary signatures. Temporary paths are not durable evidence storage and may be cleaned by the host; preserve approved, redacted evidence under an agreed retention/access policy before relying on it later.

## Still required

Re-fetch/re-evaluate if the local candidate is no longer inside the approved release window; approve source completeness/publication semantics and purpose-specific freshness; distribute the same v2-provenance index and readers/pins under explicit release authority; authenticate every runtime observation; trigger/reconcile rescreening and deliver/acknowledge alerts. Old provenance v1 artifacts fail the new reader and must not be relabelled. No public-service health, actual issuer/worker use, fleet migration, legal sign-off or independent performance claim is established here. T-27 and T-34 remain IN_PROGRESS.
