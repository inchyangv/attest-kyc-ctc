# Regulatory position: the off-chain side of the privacy boundary

> 2026-09-02 · Engineering draft; implementation reconciliation 2026-09-07
> **Draft — pending compliance-officer review.** A position paper, **not legal advice**.
> Background: [`03-product-plan.md`](03-product-plan.md) sections 3.3, 6.1–6.2, section 7 row 11 and section 15; [`07-kyc-vendors.md`](07-kyc-vendors.md) sections 3, 4.1, 7 and 9.
> Primary code boundaries: `src/lib/ProofmarkTypes.sol`, `pipeline/claims.ts`, `pipeline/issue.ts`, `pipeline/evidence.ts`, `pipeline/evidence-key.ts`, `pipeline/pii-guard.ts`, `pipeline/privacy-processing-policy.ts`, `pipeline/reconcile.ts`, `pipeline/vault.ts`, `pipeline/issuance-journal.ts`, `pipeline/adapters/`, `aml/engine.ts`, `web/lib/consent.ts`, `web/lib/kyc-server.ts`, `web/lib/privacy-processing-policy-server.ts`, `web/lib/evidence-vault.ts`, `web/lib/issuance-server.ts`, `web/app/api/kyc/`, `script/rescreen.ts`, `script/vault-admin.ts`, `web/vercel.json`, `deploy/worker/provision.sh`.

---

## 0. Status of this document

> **This is a position paper. It is not legal advice.** It was written by the engineering side of the team to state, in one place and without softening, what personal data the system touches, where that data goes, and which Korean statutes plausibly attach to it.
>
> **Status: Draft — pending qualified legal and operational review.** `[COUNSEL]` marks unresolved decisions, not approvals. This file is linked from the repository README; an “internal” label is not an access control or evidence of confidentiality. It is not approved for reliance as a legal opinion, compliance certificate, contractual representation or regulator submission. Actual reviewers, institutional roles and publication approval remain unassigned/unverified in [TICKET.md](../TICKET.md). Existing repository availability must not be confused with that approval.

The current [Mark definition](../src/lib/ProofmarkTypes.sol) has no fields for a cleartext name, date of birth, document number or account number. It does expose wallet-linked metadata, issuer, status, origin, method/jurisdiction/assurance values, timestamps and commitments. Schema inspection is not proof that every arbitrary transaction or deployed service is free of personal data. Wallet linkage and retained openings prevent an anonymity claim. This paper inventories processing for qualified review; it does not decide statutory applicability or approve real-data operation. Historical testnet deployments do not implement all current local controls.

---

## 1. What the system actually holds, and where

| Layer | What it is | Where it lives | Grounded in |
|---|---|---|---|
| **On chain / relay / RPC** | Source event subjects, issuer and attributes; hub `Mark` including ASC-assigned `origin`; commitments, lifecycle and transaction coordinates | Source/hub chains, RPCs, worker state and public explorers; globally observable wallet linkage | `src/lib/ProofmarkTypes.sol`, `src/ComplianceSource.sol`, `worker/` |
| **Issuer processing memory** | declared full name, date of birth, nationality, residence; the vendor-returned document name, date of birth and `docHash`; the vendor-returned account-holder name; the per-claim 32-byte salts | Issuance invocation; the outcome enters the shared journal and, where configured, the file vault described below | `web/app/api/kyc/issue/route.ts`, `pipeline/issue.ts`, `web/lib/evidence-vault.ts` |
| **Configured vendor requests** | CODEF document fields and, on the RRC path, encrypted resident-number tail; simple-login configuration can contain the approver's name, phone and full resident number. Open Banking holder inquiry sends account/bank data and supplied YYMMDD as `account_holder_info`; one-won flow sends account data | Adapter code describes possible requests, not actual approved provider operation, retention terms or the approver's identity/employment | `pipeline/adapters/codef.ts`, `pipeline/adapters/openbanking.ts` |
| **User-held** | the complete claim set `(key, value, salt)` and the full evidence export, both returned in the `/api/kyc/issue` JSON response (`claims: out.claims`, `evidence: out.evidence`) | wherever the customer saves them; the browser by default | `web/app/api/kyc/issue/route.ts`, `pipeline/claims.ts` |
| **Issuer-retained, production path** | screening subject, consent version, evidence, claim openings, lifecycle state, rescreen and review history | AES-256-GCM encrypted pilot vault on persistent storage; production issuance fails closed without one | `pipeline/vault.ts`, `web/lib/evidence-vault.ts` |
| **Mandatory recovery journal, including demo issuance** | Original outcome, full issued claims/salts/evidence, wallet/consent, target, signed transaction and reconciliation state; optional copy of the file-vault record | Encrypted Redis journal. Pending records persist; completed episodes have an absolute 24-hour expiry. This is not a lifetime limit or complete backup erasure | `pipeline/issuance-journal.ts`, `web/lib/issuance-server.ts`, [recovery/retention](22-issuance-recovery.md) |
| **Vercel configuration boundary** | The file vault is disabled, not all server retention. Current issuance still requires the encrypted shared journal, even in demo mode | Source configuration only; actual deployed journal, regions, versions and provider retention must be verified separately | `web/lib/evidence-vault.ts`, `web/app/api/kyc/issue/route.ts` |
| **Temporary proofs and bank state** | Wallet/flow binding, vendor results in encrypted browser-held tokens; shared bank challenge/idempotency state includes keyed identifiers and sealed responses | Browser memory and configured bank state store; separate keys, TTLs and purpose from the issuance journal | `web/app/api/kyc/id/route.ts`, `web/app/api/kyc/bank/route.ts`, [bank state](21-bank-challenge-state.md) |
| **Processing-policy evidence** | Opaque policy/customer/model/notice IDs, approval and legal-review references, and policy fingerprint; no subject fields | SIWE/wallet token, request fingerprint, evidence chain, encrypted journal and configured vault | [processing-policy boundary](87-processing-policy-boundary.md) |

This is a code-level inventory, not a complete production data map. Request bodies, provider systems, ingress/CDN/WAF logs, error monitoring, traces, replicas/backups, support exports, operator credentials and user downloads need an actual processor/location/retention inventory. “Transit only” and a failed request do not prove that no copy exists.

Four implementation details matter to every argument below.

**Commitments (`pipeline/claims.ts`).** A claim leaf is `keccak256(abi.encode(key, value, salt))`, and `claimsRoot` is the Merkle root over the sorted leaves (`pipeline/merkle.ts` sorts). The keys in `pipeline/issue.ts` are `fullName`, `dateOfBirth`, `nationality` and `residence`, plus `idDocHash` when the document axis ran and `accountHolder` when the bank axis ran. Salts are 32 random bytes each. Claim disclosure helpers exist; the API returns the complete claim set, not an approved minimum-disclosure auditor workflow.

**Where the salts come from.** `newSalt()` runs server-side during issuance. Issued openings are returned to the browser and retained in the mandatory encrypted recovery journal; a configured file vault also retains them. Demo mode does not remove the journal requirement. Neither encryption nor returning a copy to the user means the issuer never saw or retained the originals.

**Evidence (`pipeline/evidence.ts`).** The append-only hash chain binds canonical step payloads, including reconciliation digests, decisions, versions and vendor identifiers. `EvidenceChain.recompute` permits a holder to compare an export with a selected on-chain hash. This proves consistency with that commitment, not truthful provider execution, a complete due-diligence file, lawful collection or an uncompromised issuer. The containing journal/vault also stores cleartext claim values inside encryption; it is not just a digest log.

**Pseudonymisation, not anonymisation (`pipeline/evidence-key.ts`, `aml/engine.ts`).** HMAC-SHA256 name digests permit a key holder to test candidates. The key loader rejects absent/short configuration; this is not a key-custody audit. Unicode-normalized leak tests cover selected fixtures, not every input, log or provider response. Treat exports and wallet-linked metadata as privacy-sensitive pending review. PIPC describes pseudonymization as requiring additional information for identification, with purpose, adequacy and follow-up controls; a hash does not by itself authorize commercial KYC reuse. [PIPC guidance](https://pipc.go.kr/eng/user/lgp/bnp/pseudonymization.do) `[COUNSEL]`

---

## 2. Controller and processor roles

Which statutory role Proofmark occupies is not a detail — nearly every duty below hangs off it, and the answer differs by deployment model. Both models are live possibilities in the current plan, so both are stated and neither is concluded. `[COUNSEL]`

| Model | Description | Our reading, subject to review |
|---|---|---|
| **(a) First-party issuance** | Proofmark issues marks on its own behalf to end users who come through `/verify` | Proofmark is likely a personal-information controller under the Personal Information Protection Act for the issuance processing: it decides the purpose, the fields collected, the vendors used and the retention posture `[COUNSEL]` |
| **(b) Issuance as a vendor to an institution** | A client contracts for defined checks and issuance | A possible entrusted-processing arrangement, not automatic transfer of all duties to the client. Determine each party's purposes, instructions, direct duties, disclosures, subcontracting and independent reuse; the commercial label does not settle the legal role `[COUNSEL]` |

No approved vendor/participating-institution arrangement is established by adapter code or configured keys. Each party's permitted service, data items, processing purpose, retention and reuse/publication rights require documentary verification. Proofmark does not inherit a vendor's permissions.

The institution-service model is a commercial hypothesis, not an executed contract. File-vault and journal implementations exist, but no approved institutional retention operation is established. Review the chosen operator and client before assigning duties or onboarding real people. `[COUNSEL]`

---

## 3. PIPA touchpoints (Personal Information Protection Act)

**Collection and consent.** The current [processing-policy boundary](87-processing-policy-boundary.md) removes a universal production notice: production wallet challenges require an approved customer manifest, generate the displayed/SIWE statement from its model, parties, recipients, locations, resident-identifier mode, rights reference, retention disclosure and public-chain scope, and bind its fingerprint through later routes and issuance evidence. The built-in demo has a distinct `proofmark-kyc-v4-synthetic` notice and no legal-approval claim. These are technical consistency and fail-closed controls, not an approved legal basis or proof of informed understanding. Determine the basis, necessity, optional/required separation, refusal consequences and actual wording for each item and recipient before real-data operation. `[COUNSEL]`

**Resident identifiers and vendors.** Ordinary consent must not be assumed sufficient for full resident-registration-number processing: PIPA Article 24-2 restricts it to specified exceptions. Map the complete input, fragments, combination with other fields, encryption and each party's authority; truncation or RSA does not itself resolve the question. [PIPA official text](https://law.go.kr/lsInfoP.do?lsId=011357) Whether a transfer is entrustment, third-party provision or another arrangement needs the actual contract and purpose. Identify the simple-login approver and their separate processing basis rather than presuming they are an employee. `[COUNSEL]`

The production manifest now refuses RRN-bearing flows without exact authorized items, authority and notice references, and refuses a configured vendor/data category absent from the signed policy. This prevents silent runtime drift but does not verify the referenced authority or make ordinary consent sufficient. `PM-T32-01` changes the policy/vendor/country after wallet signature and is rejected before a vendor call. `[COUNSEL]`

**Deletion engineering and unresolved legal policy.** The current file vault can erase a record only after its deadline, without an active hold or unfinished issuance/review/revocation, and with a current deletion approval. Automatic purge additionally requires an approved automatic request. It retains deletion controls/tombstones and confirmed outbox metadata; journal copies, backups, downloads and onchain commitments are not erased. These [local controls and residual boundaries](42-vault-deletion-controls.md) do not establish the legally correct retention period, authenticated approval, complete disposal, or the legal status of wallet-linked commitments. Counsel must determine the applicable duties and exceptions; the blanket 1,825-day default is not presented as a universal legal rule. `[COUNSEL]`

**Pseudonymised evidence is still personal data.** Stated in section 1 and repeated here because it is the point most likely to be overstated in a pitch: HMAC digests keyed by a key we hold are pseudonymous, not anonymous. Treat evidence exports as personal data in transit, in storage and in any audit hand-off. `[COUNSEL]`

**On-chain identifiability and erasure.** Salted claims and HMAC-linked evidence have different constructions; `evidenceHash` is not itself a per-claim salted hash. Losing our copy of openings does not prove that every other copy is gone or that wallet/issuer/timestamp/method links can no longer identify someone. Revocation changes eligibility; it does not delete historical events, block explorers or replicas and is not an established legal erasure remedy. Do not promise irreversibly anonymous commitments or complete erasure. Decide whether publication is permissible at all under the actual threat model and rights process. `[COUNSEL]`

---

## 4. Credit Information Act relevance

The bank axis processes account information and holder-name results. Whether the chosen service, data and parties fall under the Credit Information Act, another financial regime or particular permission requirements is unresolved. This paper does not establish a licence, exemption or participating-institution registration. `[COUNSEL]`

The previous “nothing derived from the bank check is retained” claim was incorrect. `pipeline/issue.ts` adds the returned holder name as the `accountHolder` claim; issued claims enter the encrypted recovery journal and configured evidence vault. Method flags and evidence also reflect the bank result. Avoiding an account-number field in the final claim/evidence schema does not exclude request memory, challenge state, provider copies or logs from the processing inventory.

Approve the field-level basis, provider access and retention/reuse rights before enabling a real bank flow. Local fixtures and demo adapters are not proof of a permitted institutional rail. The bank check is not a verified credit assessment or lending recommendation. `[COUNSEL]`

---

## 5. Institutional records and recovery retention

KoFIU describes CDD as broader than name screening or two identity checks, including beneficial ownership and risk-dependent additional information. A methods bitmap does not establish completion of that institutional workflow. [KoFIU CDD overview](https://www.kofiu.go.kr/eng/policy/amls05.do) The applicable record classes, obligated entity, retention period, clock trigger, holds and deletion exceptions need qualified confirmation against current law and the actual business relationship. This revision does not certify an article-level AML retention schedule. `[COUNSEL]`

The file-vault default of 1,825 days from record creation and the journal's 24-hour terminal-episode TTL are engineering settings, not approved statutory clocks. Pending journal entries can persist indefinitely, and a reopened reconciliation episode can become persistent again. File-vault holds do not propagate to Redis expiry. This can create both excessive-retention and premature-loss risks under a future approved policy; do not solve them by indiscriminately deleting uncertain signed transactions or retaining everything forever. [Current cross-store limits](22-issuance-recovery.md#privacy-and-retention)

The reconciliation we propose, and which the compliance officer should test:

1. **Assign the complete institutional record.** Establish who holds which originals, provider receipts, approvals, disclosure history and evidence exports, with authenticated access and restore/reconciliation tests. Hash consistency alone proves neither file completeness nor truthful collection; no exclusive advantage over conventional signed audit records is asserted.
2. **Approve and operate the stores.** The encrypted file vault is local implementation, not a managed service. Vercel disables that file adapter, not the mandatory shared recovery journal. Managed storage/KMS, access control, rotation, backup/restore, audit, hold propagation and monitored reconciliation need implementation/operational evidence. `[COUNSEL]`
3. **Resolve conflicts by record and purpose.** PIPA Article 21 provides destruction rules with an exception where preservation is required by other laws and separate-management requirements for retained data. It does not make an arbitrary software deadline or generic AML label an approval. Record the specific basis and trigger, then test disposal across every copy. [Official Article 21](https://www.law.go.kr/LSW/lsLinkCommonInfo.do?ancYnChk=&chrClsCd=010202&lsJoLnkSeq=1020398651) `[COUNSEL]`

---

## 6. Cross-border transfer

The geography is asymmetric, and stating it precisely matters more than stating it favourably.

| Component | Where it runs | Personal data involved |
|---|---|---|
| Web KYC and screening routes | `web/vercel.json` specifies `regions: ["icn1"]`; routes do not currently export `preferredRegion`. Configuration is not deployment attestation, data-residency enforcement or a guarantee about edge/failover/support access | Cleartext request/provider fields and returned originals |
| Redis journal and bank state | Separate configured services; their regions/replicas/backups/support locations are not established by the web region | Encrypted claims/evidence and challenge state; identifiers, timing and operational metadata remain |
| File vault and backups | Operator-selected persistent storage; unavailable as a file adapter on Vercel | Encrypted original records, openings and lifecycle history |
| Worker (`deploy/worker/provision.sh`) | Script defaults `AWS_REGION=ap-northeast-2`; actual host, RPC endpoints, logs and access need verification | No designed cleartext identity-document path, but wallet-linked events, proofs, lifecycle state and transaction metadata are not “no personal data” |
| Chains / RPC / explorers | Ethereum Sepolia and Creditcoin CC3, globally replicated | Wallets, issuer, method/status/timestamp metadata and commitments; not hashes only |

The intended Seoul placement is a configuration preference, not proof that cleartext or pseudonymous data stays in Korea. Trace every processor, recipient, backup, remote-support path and public-chain disclosure for the actual release. No production topology was inspected in this revision.

PIPA Article 28-8 addresses overseas provision (including access), entrusted processing and storage, subject to specified bases and safeguards. Counsel must map the actual transfers and applicable basis, notice and contracts; a Seoul runtime setting is not the answer for foreign access or global replication. [PIPA official text](https://law.go.kr/lsInfoP.do?lsId=011357) `[COUNSEL]`

---

## 7. Consistency with the lines we hold

This paper adds analysis; it changes no commitment in `03-product-plan.md` section 15.

| Line | How this paper stands with it |
|---|---|
| 1. No cleartext PII on chain | Current schema has no named identity/account fields; wallet-linked metadata and commitments remain privacy-sensitive. Not a complete deployed-data audit |
| 2. No inherited legal permission | Provider implementation or access keys do not establish either party's processing/reuse/publication rights |
| 6. Documents describe what is live | Distinguish current source/local tests, historical public deployment and approved operational service. None substitutes for another |
| 7. No overstatement | No claim of sandbox non-retention, duty transfer, blanket five-year compliance, anonymous commitments or revocation-as-erasure |

---

## 8. Open questions for counsel

Review roles below are proposed, not appointed people. Every row remains **OPEN**, with actual owner, reviewer, approval date and decision evidence **UNASSIGNED/UNSET**. No external legal engagement or approval is represented.

| # | Question | Section | Signs off |
|---|---|---|---|
| 1 | Controller versus entrusted-processor characterisation under each deployment model, and the delegation agreement each requires | 2 | Counsel, reviewed by the compliance officer |
| 2 | Lawful basis and the consent notice contents for first-party issuance, including the overseas-transfer element | 3, 6 | Counsel drafts, compliance officer implements |
| 3 | Whether per-record cryptographic erasure satisfies the destruction duty against an append-only digest chain | 3 | Counsel |
| 4 | Identifiability across wallets, metadata, issuer linkage, retained openings and third-party copies; whether publication is permissible and what rights can actually be fulfilled | 3 | Counsel |
| 5 | Full resident-number processing authority, fragment combinations, named approver's data, recipient roles, permitted vendor requests and itemized notice | 3, 4 | Compliance officer, confirmed by counsel |
| 6 | Credit Information Act applicability to the bank axis under each deployment model, and whether any permission is implicated | 4 | Counsel |
| 7 | Whether Proofmark is ever the obligated entity under the Act on Reporting and Using Specified Financial Transaction Information, and the article-level retention specifics | 5 | Counsel |
| 8 | Retention-versus-erasure ordering, and the log we must keep of both events | 3, 5 | Counsel |
| 9 | Cross-border transfer basis for the issuance function, and for any future vault hosted abroad | 6 | Counsel |
| 10 | Evidence-vault production sign-off: managed storage, access control, key custody/rotation, backup, region, and erasure procedure | 1, 5 | Compliance officer with engineering |
| 11 | Verify actual web/Redis/vault/vendor/RPC/backup/observability/support locations, versions and transfer paths, not only `icn1` | 6 | Engineering with counsel |
| 12 | Contracted reuse, publication and onward-consumer rights; incident notification, correction/redemption, service limits, liability and insurance allocation | 2–6; T-53 | Both parties' legal and operational approvers |
| 13 | Reconcile pending-journal retention, 24-hour expiry, file-vault holds, restored copies and immutable chain history with the approved per-record schedule | 3, 5 | Counsel with engineering and the actual record owner |

Each decision must identify the operating entity, service/jurisdiction, data/recipient/purpose, dated authoritative basis, actual approving person, evidence link, implementation change and negative/operational verification. A checked box or this document is not that evidence. T-32/T-33/T-53 and the release gate stay open until their actual completion conditions are met.

## 9. Source-check boundary

Official pages above were consulted on 2026-09-07. The PIPA page displayed Law No. 20897, effective 2025-10-02; its dynamic body was not fully exposed by the text reader, so indexed article excerpts were used only for the narrow points cited. The separate Article 21 text and PIPC/KoFIU guidance support the cited background. This is not an exhaustive check of all amendments, enforcement decrees, sector-specific rules or case law applicable on the eventual launch date. PIPC's English law index also contains older material; an English page's availability is not current-law clearance. Qualified review must resolve effective versions and applicability before reliance.

This revision corrects source-level claims. It does not verify current provider permissions, the public deployment, real customer consent, forensic erasure, managed storage or a legal opinion. No real-person request, public transaction, external contact, release or submission was performed for this correction.
