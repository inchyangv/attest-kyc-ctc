# Performed checks and result-derived regime

Working-tree change, 2026-09-07. Capability rules introduced with built-in engine `aml-1.3.0`, adapter rule `kr-results-v2`; later engine revisions preserve these capability semantics. T-28 repository-local execution is complete, but the ticket remains `IN_PROGRESS` for the decision and external gates below. No live vendor call, bank transfer, policy update, deployment or rescreen was performed.

## Unsupported capabilities cannot be enabled by flags

`ListBackedAmlEngine` has no PEP or adverse-media implementation. Setting either deprecated `hasPepData` or `hasAdverseMedia` to true now rejects construction. They no longer turn on bits or create `passed=true` evidence. Mutating the original options object after construction cannot activate these checks; list edition metadata is copied as well.

The built-in engine reports PEP, adverse media and graph/exposure analysis as `unavailable`, `applied=false`, `passed=false`. There is no fabricated successful provider run. Name and wallet-list checks identify their local provider implementation/version and list editions; the jurisdiction check identifies its table version and explicitly labels nationality/residence as self-declared.

No searchable names yields REVIEW / `SCREENING_UNAVAILABLE`, with SANCTIONS_SCREENED unset. Empty normalized name or missing/malformed country input yields REVIEW / `SCREENING_INPUT_INVALID` if no stronger hit already blocks/requires review. Country-format checking is not a complete ISO-membership or citizenship validation. Missing wallet input is `skipped`; a corpus without usable wallet entries is `unavailable`. Neither is represented as a successful wallet check.

Per-check outcomes stay distinct: an unrelated name may pass the name check while the exact listed wallet independently fails and drives BLOCK.

## Wallet lookup is not graph exposure

Exact listed-EVM-address lookup remains implemented and still blocks a listed wallet regardless of the supplied name. It does **not** set `ONCHAIN_EXPOSURE` (bit 20). No new bit is assigned in the existing schema merely to preserve an old display value.

For a clean, valid-name/country screening, the built-in mask is now `0x90000` (`SANCTIONS_SCREENED | JURISDICTION_CHECK`), not `0x190000`. The wallet lookup's execution/outcome appears separately in evidence and the API's `checks`. The screening page's method groups no longer present graph/exposure analysis as performed.

**Compatibility consequence:** a policy requiring bit 20 is not satisfied by new built-in-engine credentials solely because a wallet-list lookup ran. The SDK warns about that requirement without rewriting it. No frozen policy or deployed mark was changed. The local integration test's screening-only fixture is explicitly not the content of an existing deployed policy.

Historical schema-0 credentials sometimes carried bit 20 for exact wallet-list lookup. They must not be retroactively advertised as graph/exposure evidence. The on-chain bitmap alone cannot distinguish those historical semantics; an SDK warning is not a protocol-level migration. Before production use, identify affected issuers/credentials/policies, approve an explicit version/cutoff or replacement deployment and preserve historical evidence (T-12/T-28). Do not silently relax a customer's frozen requirement to make a new demo pass.

## Regime comes from results as well as configuration

`KrAdapter.regime` remains a configuration-capability getter. It does not determine the issued regime by itself. The status API labels that scope explicitly.

`run()` emits regime 1 only if all of the following hold:

- Both currently configured vendors are live.
- `sandboxBits` is off.
- The consumed ID result is live, the authenticity check ran and passed.
- The consumed bank result is live, holder verification passed and the one-won check passed.

Otherwise the result is regime 2; a failed authenticity check still rejects issuance. Evidence records `configuredRegime`, the actual `regime`, `liveResultsComplete`, `sandboxBits` and `regimeRule=kr-results-v2`. Merely switching deployment credentials to live vendors cannot upgrade previously sealed demo/sandbox results. Mixed, absent or incomplete results cannot earn regime 1. Demo-derived method bits remain regime 2 even if current vendor configuration is live.

This is a provenance/classification check over trusted server-side adapter results. It is not a vendor signature verifier, proof of a human identity, contract approval or regulatory certification. Vendor identity/audience/subject binding, stale results and licensed capability conformance remain separate T-30/T-31 gates. A custom engine or compromised trusted issuer can still lie unless its boundary is independently verified.

T-31 now enforces the next repository-local boundary in [the identity/assurance mapping](86-identity-assurance-boundary.md): self-declared country and document/account control cannot silently satisfy face, liveness, representative or UBO requirements, and assurance is derived from a named policy-local performed-check basis. The actual customer mapping and approval remain external gates.

## Verification and remaining work

`PM-T28-01` fixes the exact unsupported-capability flag counterexample in `aml/capabilities.test.ts`. Against isolated `HEAD`, the expectation that `hasPepData=true` must be rejected failed **0/1** because construction succeeded. The current implementation rejects both unsupported flags before screening, and the permanent regression passes **1/1**. The same file covers post-construction mutation, independent name/wallet outcomes, omitted inputs, empty data and absence of graph/PEP/adverse-media bits. `pipeline/regime-provenance.test.ts` covers eight incomplete/sandbox result combinations, valid live results, demo/disconnected configuration, packed issuance output after a configuration switch and the non-mutating SDK warning. All are synthetic, with vendor calls prohibited in fixtures. The internal AML evaluator also fails if the built-in engine earns bit 20, PEP or adverse-media bits.

Focused capability/regime/pipeline tests pass **57/57**. The default suites pass Solidity **118/118** and TypeScript **545/545**; the actual Next API passes **60/60**, root typecheck and web lint/build pass, and the browser/HTTP/Redis/vault/two-local-EVM issuance integration passes **1/1**. The source-bound report is generated only after this document is fixed, so its path and fingerprint are recorded in `TICKET.md` rather than inserted here and thereby invalidating its own fingerprint.

T-28 remains `IN_PROGRESS`: [shared source freshness/fetch provenance and warm reload](31-sanctions-snapshots.md) and the official-source v3 activation are locally covered by T-27, but authenticated provider run/receipt status/failure/timeout conformance (T-30), historical bit-20 semantic migration, approved customer method/regime mappings, and actual fleet rollout are not complete. Current local provider/version/status evidence is not a substitute for those gates. No independent review or operational rollout is claimed.
