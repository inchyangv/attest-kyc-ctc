# Regulatory position: the off-chain side of the privacy boundary

> 2026-09-02 · Tech Lead
> **Draft — pending compliance-officer review.** A position paper, **not legal advice**.
> Background: [`03-product-plan.md`](03-product-plan.md) sections 3.3, 6.1–6.2, section 7 row 11 and section 15; [`07-kyc-vendors.md`](07-kyc-vendors.md) sections 3, 4.1, 7 and 9.
> Code this paper describes, and nothing beyond it: `pipeline/claims.ts`, `pipeline/issue.ts`, `pipeline/evidence.ts`, `pipeline/evidence-key.ts`, `pipeline/pii-guard.ts`, `pipeline/reconcile.ts`, `pipeline/vault.ts`, `aml/engine.ts`, `web/lib/kyc-server.ts`, `web/lib/evidence-vault.ts`, `web/app/api/kyc/issue/route.ts`, `script/rescreen.ts`, `script/vault-admin.ts`, `deploy/worker/provision.sh`.

---

## 0. Status of this document

> **This is a position paper. It is not legal advice.** It was written by the engineering side of the team to state, in one place and without softening, what personal data the system touches, where that data goes, and which Korean statutes plausibly attach to it.
>
> **Status: Draft — pending compliance-officer review.** Every point that needs a lawyer or the compliance officer is tagged `[COUNSEL]` in line and collected in section 8. External use of this document — investor materials, a data room, a partner or vendor conversation, a regulator submission — is prohibited until the compliance officer has reviewed it and resolved those markers. Nothing here concludes that the system satisfies any statute; the paper deliberately stops at a position.

"No cleartext PII on chain" is the strong half of the story and it is verifiable: the on-chain `Mark` struct (`03-product-plan.md` section 6.2) carries `status`, `origin`, `kind`, `assurance`, `regime`, `jurisdiction`, a `methods` bitmap, `issuedAt`, `expiry`, `epoch`, `claimsRoot`, `evidenceHash` and the issuer address. No name, no date of birth, no document number, no account number. It is not an anonymity claim: wallet and issuer addresses, metadata and commitments are linkable pseudonymous data. The other half is off chain: the cleartext that transits the issuer, the fragments sent to vendors, and the evidence and claim originals behind `evidenceHash` and `claimsRoot`. That off-chain side is regulated personal-data handling in Korea.

---

## 1. What the system actually holds, and where

| Layer | What it is | Where it lives | Grounded in |
|---|---|---|---|
| **On chain** | `status`, `kind`, `assurance`, `regime`, `jurisdiction`, `methods`, `issuedAt`, `expiry`, `epoch`, `claimsRoot`, `evidenceHash`, `issuer` | Ethereum Sepolia (`ComplianceSource`), mirrored to Creditcoin CC3 through the Attestcoin Protocol | `03-product-plan.md` 6.2 |
| **Issuer processing memory** | declared full name, date of birth, nationality, residence; the vendor-returned document name, date of birth and `docHash`; the vendor-returned account-holder name; the per-claim 32-byte salts | the memory of one issuance invocation; in production a configured vault then retains the evidence record under policy | `web/app/api/kyc/issue/route.ts`, `pipeline/issue.ts`, `web/lib/evidence-vault.ts` |
| **Transit only — to vendors** | CODEF: document fields, birth date, and the customer's resident-number tail, RSA-encrypted per request (`pipeline/adapters/codef.ts`); under app-based login, also the **operator's own** name, phone and resident number, because the authority requires the requesting party to identify itself. KFTC Open Banking: bank code, account number, and `account_holder_info` — the **first six digits of the resident registration number** — plus the one-won transfer | the vendors' systems, under the vendors' own regulatory permissions | `07-kyc-vendors.md` 3.3 and 4.1 |
| **User-held** | the complete claim set `(key, value, salt)` and the full evidence export, both returned in the `/api/kyc/issue` JSON response (`claims: out.claims`, `evidence: out.evidence`) | wherever the customer saves them; the browser by default | `web/app/api/kyc/issue/route.ts`, `pipeline/claims.ts` |
| **Issuer-retained, production path** | screening subject, consent version, evidence, claim openings, lifecycle state, rescreen and review history | AES-256-GCM encrypted pilot vault on persistent storage; production issuance fails closed without one | `pipeline/vault.ts`, `web/lib/evidence-vault.ts` |
| **Public Vercel sandbox** | no persistent server-side evidence record | Vercel filesystem is ephemeral, so the adapter is deliberately disabled and the UI/API disclose non-retention | `web/lib/evidence-vault.ts`, `web/app/verify/page.tsx` |

Four implementation details matter to every argument below.

**Commitments (`pipeline/claims.ts`).** A claim leaf is `keccak256(abi.encode(key, value, salt))`, and `claimsRoot` is the Merkle root over the sorted leaves (`pipeline/merkle.ts` sorts). The keys today (`pipeline/issue.ts`, the claim assembly around lines 117–127) are `fullName`, `dateOfBirth`, `nationality` and `residence` always, plus `idDocHash` when the document axis ran and `accountHolder` when the bank axis ran. Salts are 32 random bytes each.

**Where the salts come from.** `newSalt()` is defined in `pipeline/claims.ts` and called inside `pipeline/issue.ts` — that is, **server-side, during issuance** — and the salts leave in the response body. In a production flow they also enter the encrypted evidence record so the obligated operator can reproduce the commitment; in the public sandbox there is no persistent server record. Any claim that the issuer "never sees" the data would be false, and we do not make it.

**Evidence (`pipeline/evidence.ts`).** The evidence chain is append-only: `evidenceHash = keccak256(prevHash ‖ canonicalJson(step))`. Step payloads carry, by design, "no cleartext PII. Hashes, decisions and versions only" — per-axis agreement flags and normalised digests from `pipeline/reconcile.ts`, decision codes, list and engine versions, vendor identifiers. `EvidenceChain.recompute` is the audit path: anyone holding an evidence export recomputes the head and compares it with the `evidenceHash` written on chain.

**Pseudonymisation, not anonymisation (`pipeline/evidence-key.ts`, `aml/engine.ts`).** Names inside evidence appear as keyed HMAC-SHA256 digests under `EVIDENCE_HMAC_KEY`. The module's own comment is the honest statement of the limit: "This is pseudonymisation, not anonymisation. The key holder can confirm a candidate." Under the Personal Information Protection Act, pseudonymised data remains personal data, with a specific processing regime attached — so an evidence export is a personal-data artefact in the customer's hands, not a neutral log. The key has no default; the loader throws when it is missing or under 32 characters. `pipeline/pii-guard.ts` is the test-side leak detector that keeps this true: it compares all four Unicode normal forms (NFC, NFD, NFKC, NFKD), and it exists because a naive substring check missed a Korean name that the AML engine had stored in NFD.

---

## 2. Controller and processor roles

Which statutory role Proofmark occupies is not a detail — nearly every duty below hangs off it, and the answer differs by deployment model. Both models are live possibilities in the current plan, so both are stated and neither is concluded. `[COUNSEL]`

| Model | Description | Our reading, subject to review |
|---|---|---|
| **(a) First-party issuance** | Proofmark issues marks on its own behalf to end users who come through `/verify` | Proofmark is likely a personal-information controller under the Personal Information Protection Act for the issuance processing: it decides the purpose, the fields collected, the vendors used and the retention posture `[COUNSEL]` |
| **(b) Issuance as a vendor to an obligated institution** | A virtual-asset service provider or other obligated institution contracts Proofmark to run the checks and issue the mark | Proofmark is likely an entrusted processor under the delegation provisions of the Personal Information Protection Act, with the client institution as controller — which moves the consent, notice and retention duties to the client and imposes a written delegation agreement, instruction-bound processing and supervision duties on both sides `[COUNSEL]` |

In both models CODEF and KFTC Open Banking act under their own regulatory permissions for the lookups they perform; Proofmark does not inherit those permissions and does not claim them. This is the same line as `03-product-plan.md` section 15 rule 2: vendors perform the verification, and we are responsible for the result's lifecycle.

Two consequences are worth stating even before counsel: model (b) is the model the commercial plan points at, and it is also the model under which the retention duty in section 5 most clearly binds *someone* — the client. Under model (a) the same duty may bind Proofmark directly, and Proofmark today has no store in which to discharge it. `[COUNSEL]`

---

## 3. PIPA touchpoints (Personal Information Protection Act, 개인정보 보호법)

**Collection and consent.** Collection is real: name, date of birth, nationality, residence, document fields and an account number, plus the resident-number fragments the two vendor lookups require. A lawful basis is therefore required, and for this shape of processing that basis is normally the data subject's consent, obtained with notice of purpose, items, retention period and any delegation. `[COUNSEL]` The live `proofmark-kyc-v2` notice describes identity/account processing, configured vendors, encrypted retention, and pseudonymous on-chain publication. The wallet-signed EIP-4361 message binds that exact consent version; every ID, bank, and issuance token is bound to the same flow ID and wallet. This technical capture does not settle whether the wording and presentation satisfy Korean consent requirements; counsel must approve them.

**Delegation to vendors.** Sending personal data to CODEF and to KFTC to perform verification is delegation of processing, which normally requires a written agreement, a scope limitation and a supervision duty, and — depending on characterisation — disclosure of the delegatee to the data subject. `[COUNSEL]` The concrete flows to name in any such notice are the ones in section 1: the RSA-encrypted resident-number fragment to CODEF for the authenticity lookup, and the first six digits of the resident registration number to KFTC in `account_holder_info` for the holder-name inquiry. One flow has a different data subject and is easy to miss: the app-based login CODEF requires sends the *operator's* name, phone and resident number on every check, which is employee personal data processed for our own purpose and needs its own basis and notice. `[COUNSEL]`

**The destruction duty against an append-only design.** The Personal Information Protection Act requires destruction without delay once the purpose is achieved or the retention period ends. The evidence chain is append-only by construction, but the vault record is erasable: `EvidenceVault.erase` removes the encrypted personal record and retains only an opaque record ID, timestamp and reason; `purgeExpired` applies the configured retention deadline. The on-chain commitments remain immutable. Our position is that off-chain erasure plus an opaque erasure event is the appropriate resolution, subject to counsel—especially because a regulator may still treat the wallet-linked commitment as personal data. `[COUNSEL]`

**Pseudonymised evidence is still personal data.** Stated in section 1 and repeated here because it is the point most likely to be overstated in a pitch: HMAC digests keyed by a key we hold are pseudonymous, not anonymous. Treat evidence exports as personal data in transit, in storage and in any audit hand-off. `[COUNSEL]`

**Do the on-chain commitments remain personal data?** `claimsRoot` and `evidenceHash` are salted, per-issuance, 32-byte values. Our position is that once the salts and the originals no longer exist anywhere, a commitment is not personal data relating to an identifiable person: with 32 random bytes per claim there is no dictionary to run, and the on-chain value carries no auxiliary field to correlate on beyond a wallet address the user chose to bind. We hold this position deliberately, and we flag it, because the counter-argument is not frivolous — while the user still holds their salts, the commitment is *linkable by the user*, and a regulator may reason about identifiability with reference to any party's ability to re-identify rather than ours alone. `[COUNSEL]` The practical consequence if the counter-argument prevails: on-chain data becomes non-erasable personal data, and the mitigation would be a design that treats mark revocation plus off-chain destruction as the erasure remedy — which is what the contract's status lifecycle already provides.

---

## 4. Credit Information Act relevance (신용정보법)

The bank axis is where this statute plausibly reaches. Verifying that an account exists and that its holder name matches the declared name, via KFTC Open Banking's holder-name inquiry plus a one-won transfer, means handling an account number, an account-holder name and the resident-number fragment described above — data about a financial transaction relationship, which is the neighbourhood the Credit Information Act governs. `[COUNSEL]`

Three facts bound the exposure honestly. First, Proofmark holds **no credit-information-business permission** and applies for none; the bank rail is exercised through KFTC Open Banking under the participating-institution scheme described in `07-kyc-vendors.md` section 4.3, which is itself a registration step we have not completed. Second, nothing derived from the bank check is retained: the axis produces a boolean pair (holder verified, one-won verified) and a claim commitment, and the account number is never written to evidence — `pipeline/pii-guard.ts` is the test that keeps that true. Third, the applicability question again routes through section 2: as an entrusted processor for an obligated institution, the analysis differs materially from first-party handling. `[COUNSEL]`

Until counsel resolves that, the position we hold is narrow: the bank axis is exercised only through a permitted rail operated by a permitted institution, no credit information is retained by us, and we make no statement about whether the processing falls inside or outside the Credit Information Act's scope. `[COUNSEL]`

---

## 5. AML record retention versus stateless issuance

The Act on Reporting and Using Specified Financial Transaction Information (특정금융정보법) imposes customer due-diligence and record-keeping duties on obligated entities, including retention of the records for five years. The article-level specifics, the exact start of the retention clock, and which of the two models in section 2 makes Proofmark an obligated entity all need counsel `[COUNSEL]`; this paper cites no article numbers on purpose, because a wrong citation inside a compliance team's own paper is worse than none.

The implementation now has a pilot retention mechanism, but a module is not an operating control. A production operator must place it on persistent encrypted storage, protect and rotate the key, monitor purge/rescreen jobs, restrict access, and document restore and incident procedures. The public Vercel sandbox retains nothing and cannot discharge an institutional record-keeping obligation.

The reconciliation we propose, and which the compliance officer should test:

1. **The obligated entity holds the evidence.** Under model (b) the client institution retains the evidence export as part of its own due-diligence file. Its integrity is provable rather than asserted: `EvidenceChain.recompute` in `pipeline/evidence.ts` reproduces the head from the export, and the head is compared against the `evidenceHash` in the on-chain mark. An institution can therefore prove its retained record is the record that was used at issuance — an auditability property a conventional KYC file does not have.
2. **An issuer-side encrypted pilot vault is implemented, not production-operated.** It uses AES-256-GCM, atomic local writes, consent/version fields, retention deadlines, rescreen history, manual-review decisions and opaque erasure events. It is explicitly disabled on Vercel. A managed database/KMS adapter, access control, backup/restore, key rotation and audit logging remain production work. `[COUNSEL]`
3. **Retention beats erasure inside the window.** Where a retention statute applies, our position is that it prevails over an erasure request for its duration, and the correct handling is to restrict processing to the retention purpose and then destroy at the end of the window, logging both events. `[COUNSEL]`

---

## 6. Cross-border transfer

The geography is asymmetric, and stating it precisely matters more than stating it favourably.

| Component | Where it runs | Personal data involved |
|---|---|---|
| Web KYC and screening routes | Next.js route configuration pins `preferredRegion = 'icn1'`, Vercel's Seoul region. Deployment output and runtime logs must still be checked after every production release. | This is the component that processes cleartext personal data and talks to vendors |
| Worker (`deploy/worker/provision.sh`) | AWS `ap-northeast-2` — Seoul, **inside Korea** (the script defaults `AWS_REGION=ap-northeast-2`) | None. The worker reads chain events and submits proofs; it never sees personal data |
| Chains | Ethereum Sepolia and Creditcoin CC3, globally replicated by design | Commitments and hashes only (section 1) |

The intended topology now keeps the cleartext-processing functions and the worker in Seoul. That reduces routine cross-border infrastructure transfer; it does not remove vendor-transfer analysis, global chain replication of pseudonymous commitments, platform failover questions, or the need to verify the deployed region.

If any configured vendor, managed vault, backup, observability provider, or failover path processes the data abroad, the Personal Information Protection Act's cross-border requirements still attach. `[COUNSEL]` Korea-region hosting is therefore the default, not the full legal answer. The deployment region and every subprocessor location remain release-gate evidence.

---

## 7. Consistency with the lines we hold

This paper adds analysis; it changes no commitment in `03-product-plan.md` section 15.

| Line | How this paper stands with it |
|---|---|
| 1. No cleartext PII on chain | Re-verified against the `Mark` struct. Wallet-linked metadata and commitments are explicitly described as pseudonymous and linkable, not anonymous |
| 2. We do not become an identity verification authority | Section 2 keeps the vendors' permissions with the vendors and keeps the result lifecycle with us |
| 6. Documents describe what is live | Consent, a file-backed encrypted pilot vault, review/rescreen/erasure tooling, and Seoul route preference are live code. The managed vault service, operational controls, and legal approval remain gaps |
| 7. No overstatement | The paper states no conclusion of compliance anywhere, prices the on-chain-commitment argument together with its counter-argument, and cites no statute article it cannot stand behind |

---

## 8. Open questions for counsel

Every marker above, with who resolves it. "Compliance officer" means the team's own compliance officer; "counsel" means external Korean counsel.

| # | Question | Section | Signs off |
|---|---|---|---|
| 1 | Controller versus entrusted-processor characterisation under each deployment model, and the delegation agreement each requires | 2 | Counsel, reviewed by the compliance officer |
| 2 | Lawful basis and the consent notice contents for first-party issuance, including the overseas-transfer element | 3, 6 | Counsel drafts, compliance officer implements |
| 3 | Whether per-record cryptographic erasure satisfies the destruction duty against an append-only digest chain | 3 | Counsel |
| 4 | Whether salted on-chain commitments remain personal data while the data subject still holds their salts | 3 | Counsel |
| 5 | Vendor delegation disclosures, and whether the resident-number fragments sent to CODEF and KFTC need itemised notice | 3, 4 | Compliance officer, confirmed by counsel |
| 6 | Credit Information Act applicability to the bank axis under each deployment model, and whether any permission is implicated | 4 | Counsel |
| 7 | Whether Proofmark is ever the obligated entity under the Act on Reporting and Using Specified Financial Transaction Information, and the article-level retention specifics | 5 | Counsel |
| 8 | Retention-versus-erasure ordering, and the log we must keep of both events | 3, 5 | Counsel |
| 9 | Cross-border transfer basis for the issuance function, and for any future vault hosted abroad | 6 | Counsel |
| 10 | Evidence-vault production sign-off: managed storage, access control, key custody/rotation, backup, region, and erasure procedure | 1, 5 | Compliance officer with engineering |
| 11 | Confirm deployment output/runtime logs show `icn1` for every KYC route and record that evidence for the release | 6 | Engineering (human step) |

Until every row above is resolved, this document stays a draft, stays internal, and remains **not legal advice**.
