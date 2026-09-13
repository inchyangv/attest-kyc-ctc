# T-35 — isolated synthetic sanctions decision exercise

2026-09-07, updated 2026-09-08. This completes the local training exercise left open in [the synthetic input change](47-synthetic-demo-experience.md). The separate matching-profile regression now uses the activated official three-source artifact and the connected test is wired through actual APIs and local source/hub/witness/gate contracts. T-35 remains **IN_PROGRESS** because an educational example or owned local integration does not prove public deployment, independent first-time judge usability, real extension/mobile wallets, managed capacity or public native-proof behavior.

## What the visitor can learn

In demo mode, `/verify` now has a separate “Why screening blocks or requests review” panel. It works without connecting a wallet, entering personal information or selecting an issuance profile. Four buttons send only a fixed scenario identifier to `/api/demo/screen`:

| Fictional input | Actual engine result on the fixed corpus | Point illustrated |
|---|---|---|
| Exact name, full DOB and nationality match | Training BLOCK | Strong name and full-date support without conflict can block. |
| Same name, no identity descriptors | Training REVIEW | A name alone is not enough for automatic blocking. |
| Same name, conflicting DOB | Training REVIEW | A conflicting descriptor requires review, not automatic block or clearance. |
| Different fictional name | Training ALLOW | Absence from one fictional record is not official-list clearance. |

These decisions come from the current `ListBackedAmlEngine`, including its existing name matching and identity comparison rules. The endpoint does not return a hard-coded decision table. The display includes the fictional input and record, actual name score/DOB/nationality comparisons, engine version and a SHA-256 fingerprint of the fixed record plus all scenario inputs. That hash identifies these fixture bytes, not an official list, a verified publication time, an independent dataset or a signed execution attestation.

All four outputs are marked **TRAINING**, including ALLOW. None asserts that a real person is sanctioned, screened, identified or eligible for issuance. The panel does not change the issuance form, wallet, consent, proofs or journal state. It does not submit a transaction, create a credential or open either policy gate. It is not a substitute for the normal sanctions engine, a successful full source refresh or screening the actual holder during issuance.

## Isolation boundaries

`pipeline/sanctions-training.ts` accepts only the four scenario strings. It constructs a new engine using one private fictional fixture and fixed inputs. It never calls the file-backed list loader, reads a sanctions index, fetches a vendor/RPC, opens a vault/journal or imports an issuer/signer. The public fixture-only HMAC value used internally is explicitly not an operational evidence key; no user-supplied names or secret evidence are processed with it.

The engine's internal `ListId` type currently contains only official-format namespaces. The fixture occupies one `OFAC_SDN` schema slot for matching compatibility. **It is not an OFAC entry.** This implementation does not add a fake record to any operational list or extend the meaning of official provenance. The raw engine result is never exported by the training wrapper. Its explicit projection removes official list IDs/versions, evidence, snapshot freshness, method bits, claims commitments, wallet/ID/bank proofs and transaction fields. The response uses its own `proofmark-synthetic-screening/v1` schema and explicitly sets `officialListsChecked`, `eligibleForIssuance` and `credentialCreated` to false.

The separate route is available only when `KYC_DEMO=1`. It has a 1024-byte bounded JSON body and a separate 20-request/minute per-instance bucket, preserves the same-origin guard and always returns no-store responses. It rejects additional fields—including names, wallet addresses and proofs—rather than screening them against the training corpus. Error messages do not reflect the supplied values. This does not mean incoming bytes never reach the server or that the local bucket is a distributed ingress quota; existing proxy and retention requirements still apply.

No issuer configuration, evidence secret, official dataset or wallet proof is required to run the exercise. Conversely, its JSON is not a wallet proof and cannot authenticate an issuance. The production `/api/screen`, its freshness checks and issuance's actual AML dependency are unchanged. An unavailable official dataset must still fail the real screening path; there is no training fallback.

The UI checks the response schema, training scope, scenario and explicit no-issuance flags before display. A different scenario, live-style response, malformed payload or failed request produces no verdict. A new request clears the previous result immediately; requests time out after ten seconds, and unmount aborts pending work. There is no automatic retry or training call on page load.

## Verification and limits

- Four root tests execute all four cases through the actual matcher/decision engine, test immutable fixture reuse and invalid inputs, verify that the projection contains no official-list or credential fields, and reject malformed/live-style display results.
- Four actual route tests run without operational credentials or external fetch access, check fixed-input restrictions/origin/body/rate limits, disable the route outside demo mode and confirm training JSON fails authentication when submitted as an issuance wallet proof.
- `npm run test:training-ui` uses Chromium at a 390-pixel viewport against the built local Next route and actual engine. Only the configuration response is synthetic; the four training results come from the real HTTP endpoint. It verifies wallet access never occurs, form/consent state is unchanged, and injected failure/wrong-scope responses remove the old result. The test's initial 403 was a loopback-origin mismatch: NextURL canonicalizes the address to `localhost`, so the test browser URL was corrected to match. The server origin guard was not weakened.

The existing synthetic-input and on-chain Chromium tests, API suite, native image deployment trace, lint/build and source-bound root regression remain separate evidence scopes. No operational AML accuracy, legal sanctions determination, real identity, public deployment, institutional call or source-to-hub issuance is demonstrated by this training exercise. The small fictional corpus is not a benchmark or independent holdout.
