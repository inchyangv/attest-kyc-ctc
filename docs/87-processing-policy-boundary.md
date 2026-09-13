# Customer processing-policy boundary

Working-tree implementation, 2026-09-07. This is the locally enforceable part of T-32. It does
not supply a legal opinion, customer contract, vendor permission, deployed-region attestation or
rights-request operation.

## What is now enforced

Production KYC has no inferred default operating model. `PROCESSING_POLICY_JSON` must be a
validated `proofmark-processing-policy-v1` manifest with `approved` status before the wallet
challenge can be issued. The manifest snapshots:

- one of `first-party`, `institution-service`, or `sdk-only`, with opaque controller, processor,
  customer, approval, legal-review and contract/terms references;
- the versioned notice, refusal-effect reference and rights-request channel reference;
- every processing stage's data categories, recipient and recipient role, countries, purpose,
  item-level basis and retention-schedule reference;
- the exact resident-identifier items and authority/notice references, or an explicit prohibition;
- public-chain networks, published categories, publication-basis reference and irreversibility
  notice reference.

References are evidence pointers. Parsing an operator-supplied string does not prove that the
referenced opinion, approval, contract or service exists. The release gate still requires those
materials and their authorized signers.

The built-in demo uses a separate immutable `synthetic` policy. It names only `demo:id` and
`demo:bank`, labels resident-number fields as synthetic-only and carries no legal-review,
contract or publication-basis claim. A configured real vendor is not covered by that policy and
therefore cannot be called under the demo consent binding.

## Request and evidence binding

`GET /api/kyc/status` exposes the non-secret policy ID, customer ID, model, notice version,
generated notice statement and SHA-256 policy fingerprint. The `/verify` checkbox displays that
same generated statement. `GET /api/kyc/wallet` seals the full binding into the SIWE challenge;
the signed statement contains the policy/notice IDs, model, controller, recipients, locations,
resident-identifier mode, rights reference, retention disclosure and public-chain
irreversibility. The resulting wallet token carries the same binding.

The ID and bank routes compare the wallet binding with the current policy and authorize the
exact configured adapter recipient and data categories before a vendor method runs. New issue,
resume and retry authorize issuer processing, the mandatory journal, the production vault and
public-chain publication. Status remains read-only and available for an old request, but an old
or differently bound request cannot be resumed after policy drift.

For new issuance, the redacted policy evidence tuple—policy/customer/model/notice IDs, approval
and legal-review references, and fingerprint—is included in the immutable request fingerprint,
encrypted journal, optional encrypted vault record and the append-only evidence chain before
claim creation. It contains no names, resident numbers, account data or document images.

## Regression boundary

`PM-T32-01` signs policy A, then changes the customer policy, ID vendor and processing country
before an RRC verification request. Before this module existed, the new regression could not
load and the generic `proofmark-kyc-v3` token had no policy/vendor/transfer binding. The current
pure regression rejects the mismatched fingerprint, and the actual ID-route regression confirms
that rejection occurs before the document adapter is invoked.

The policy tests also reject an unlisted recipient, an undeclared data category, missing legal
review/contract/rights/RRN authority/on-chain approval and an SDK-only policy attempting hosted
processing. These tests establish code behavior only; they do not validate the truth or legal
sufficiency of any approval reference.

Local verification on 2026-09-07: focused processing-policy tests **4/4**, actual Next API tests
**63/63**, browser/HTTP + Redis journal + encrypted vault + two local EVM issuance **1/1**, the
separate two-EVM gate integration **1/1**, default Solidity **118/118** and TypeScript **565/565**.
Root/web typecheck, web lint and the 13-route production build also passed. All inputs were fixed
synthetic fixtures and isolated local services.

## Remaining completion evidence

T-32 remains `IN_PROGRESS`. For the selected customer and operating model, authorized legal and
privacy reviewers still need to provide the actual role analysis and item-level bases, resident-
identifier authority, contract/DPA and subprocessor terms, cross-border-transfer analysis,
notices and consent wording, retention schedule, rights/correction/erasure workflow, and public-
chain publication decision. Engineering then needs to load that exact approved manifest, verify
the actual web/vendor/Redis/vault/RPC/backup/observability/support locations and versions, test a
rights request and complete disposal/restriction across every copy, and retain deployment and
server evidence showing that the displayed notice and runtime policy fingerprint match.

No production policy value is supplied in this repository. No real person, resident number,
account, vendor request, operating key, public-chain write, deployment or external party was
used for this implementation.
