# Identity requirement and assurance boundary

Working-tree change, 2026-09-07. This is the repository-local T-31 implementation evidence. It
does not select a customer risk policy, approve biometric processing, establish a legal basis or
prove the identity of a real person.

## What the implementation now enforces

[`pipeline/identity-policy.ts`](../pipeline/identity-policy.ts) defines a versioned mapping from a
customer policy requirement to the check that can satisfy it. Wallet control, document
authenticity, account control, face match and liveness map to their exact method bits. Authorized
representative and beneficial-owner identity are explicit requirements but have no schema-v0
method mapping, so they remain `unsupported` and cannot pass because document or bank checks ran.
Nationality, residence, jurisdiction 410 and sanctions screening are intentionally absent from the
identity mapping: those values do not prove that the document/account user is the actual person.

Every evaluation records all requirements as `pass`, `missing`, `not-required` or `unsupported`,
with the mapped method and whether it actually ran. Required missing/unsupported checks reject
issuance before claim creation or attribute packing. The policy and its nested requirement lists
are copied and frozen before use, preventing a caller from lowering a prepared mapping by later
mutating the input object.

Assurance is `policy-local`. Each level has a written basis and an exact requirement set. The
highest fully performed band is derived from method bits; optional `IssueRequest.assurance` is only
an expected assertion and must equal that derivation. The web route does not supply a grade. A caller/provider cannot turn the document/account
pair into assurance 5 by supplying the number 5. Evidence records the policy ID, customer-risk ID,
approval status/reference, local assurance/basis and the complete requirement matrix without
identity values.

The built-in `proofmark-synthetic-individual-nonface-v1` policy exists only for `KYC_DEMO=1`. It
requires wallet control, document authenticity and account control, maps those to assurance 3,
and prohibits biometrics. It is labelled `synthetic`; it is not a customer or compliance approval.
Outside demo mode, the issuance route requires `IDENTITY_POLICY_JSON`, validates it, and accepts
only `status=approved` with an opaque approval reference. The whole policy is included in the
HMAC issuance fingerprint, so a policy change cannot silently reuse an existing request payload.

## Biometric admission

The default biometric mode is `prohibited`. An authorized policy must name only `face_match`
and/or `liveness` and contain prior necessity, legal-basis and approval references. A biometric
result not authorized for that check rejects issuance. In addition, every ID vendor declares its
biometric capabilities. `KrAdapter.verifyIdDocument()` checks that declaration before validation
or vendor access and refuses a biometric-capable vendor unless matching authorization and all
three references were supplied. Current CODEF and labelled demo adapters declare no biometric
capability and continue returning face/liveness false.

This is a code admission boundary, not the missing legal decision. References are opaque links to
outside approval records; the validator cannot determine that their contents are correct or that
consent/notice, purpose limitation, minimization, vendor terms and retention are lawful.

## Configuration shape

Production configuration is one JSON object in `IDENTITY_POLICY_JSON`:

```json
{
  "schema": "proofmark-identity-policy-v1",
  "policyId": "customer-policy-version",
  "customerRiskId": "customer-risk-class",
  "status": "approved",
  "approvalRef": "customer:approval-record",
  "subjectKind": "individual",
  "required": ["wallet_control", "document_authenticity", "account_control"],
  "assuranceBands": [
    { "level": 1, "required": ["wallet_control"], "basis": "customer-approved basis" },
    { "level": 3, "required": ["wallet_control", "document_authenticity", "account_control"], "basis": "customer-approved basis" }
  ],
  "biometrics": { "mode": "prohibited" }
}
```

The identifiers and text above are schema examples, not usable approvals. A corporate policy may
name `authorized_representative` and `beneficial_owner_identity`, but current evaluation will fail
closed until those performed checks receive a reviewed schema mapping and implementation.

## Regression and verification scope

`PM-T31-01` supplies successful document authenticity and account control, no face match or
liveness, an expected assurance 5, and a policy requiring both actual-person checks. Before the
policy boundary existed, the focused test returned `ISSUED` and failed **0/1**. The permanent
regression now rejects it before positive attributes and passes **1/1**.

[`pipeline/identity-policy.test.ts`](../pipeline/identity-policy.test.ts) also covers policy-local
assurance, inflated grades, explicit UBO/representative non-support, prior biometric references,
unauthorized results, immutable snapshots, and pre-vendor biometric blocking. The web API suite
covers synthetic demo selection and production rejection of missing, invalid or unapproved
policy configuration. Final baseline/source-bound counts and the report fingerprint are recorded
in `TICKET.md`, because inserting them here before the evidence run would invalidate that report.

## Remaining admission gates

- A real customer must define its customer types, gated actions and risk classes, then map each to
  required identity, delegated-authentication, mule-account, representative and UBO checks.
- The customer's compliance owner must approve the exact mapping, policy-local assurance bases,
  missing/REVIEW behavior, freshness, escalation and evidence/retention rules.
- If biometrics are actually needed, authorized legal/privacy reviewers must establish necessity,
  legal basis, notice/consent where applicable, vendor/region/data/retention/deletion controls and
  approval evidence before a biometric-capable adapter is enabled.
- A selected provider must prove the approved checks and status semantics in its authorized
  environment. Real-person/organization outcomes, delegated access and fraud resistance need
  permitted external conformance; synthetic fixtures cannot supply this evidence.

Until those items exist, T-31 remains `IN_PROGRESS` even though its repository-local fail-closed
boundary is implemented and tested.
