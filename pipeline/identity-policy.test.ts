import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MockAmlEngine } from './aml.js';
import { KrAdapter, type BankAccountResult, type IdDocumentResult } from './adapters/kr.js';
import { runIssuance, type IssueRequest } from './issue.js';
import { defineIdentityPolicy, evaluateIdentityPolicy, IdentityRequirement,
  SYNTHETIC_INDIVIDUAL_NONFACE_POLICY, type IdentityPolicyV1 } from './identity-policy.js';
import { Methods } from './methods.js';

const id: IdDocumentResult = {
  docType: 'RRC', fullName: 'Synthetic Person', dateOfBirth: '1990-01-01', docHash: `0x${'12'.repeat(32)}`,
  authenticityChecked: true, authentic: true, faceMatched: false, livenessPassed: false,
  vendor: 'synthetic:id', live: true,
};
const bank: BankAccountResult = {
  bankCode: '004', holderName: id.fullName, holderVerified: true, oneWonVerified: true,
  vendor: 'synthetic:bank', live: true,
};

test('PM-T31-01: document and account control cannot satisfy a policy requiring actual-person checks or earn assurance 5', async () => {
  const request = {
    wallet: `0x${'ab'.repeat(20)}`,
    declared: { fullName: id.fullName, dateOfBirth: id.dateOfBirth, nationality: 'KR', residence: 'KR' },
    idDocument: id,
    bankAccount: bank,
    walletControlProven: true,
    jurisdiction: 410,
    assurance: 5,
    identityPolicy: {
      schema: 'proofmark-identity-policy-v1',
      policyId: 'synthetic-high-risk-person-v1',
      customerRiskId: 'synthetic-high-risk',
      status: 'synthetic',
      approvalRef: null,
      subjectKind: 'individual',
      required: ['wallet_control', 'document_authenticity', 'account_control', 'face_match', 'liveness'],
      assuranceBands: [
        { level: 1, required: ['wallet_control'], basis: 'wallet challenge only' },
        { level: 3, required: ['wallet_control', 'document_authenticity', 'account_control'], basis: 'document and account control' },
        { level: 5, required: ['wallet_control', 'document_authenticity', 'account_control', 'face_match', 'liveness'], basis: 'authorized face match and liveness' },
      ],
      biometrics: { mode: 'prohibited' },
    },
  } satisfies IssueRequest;

  const out = await runIssuance(
    request,
    new KrAdapter(
      { name: id.vendor, live: true, biometricChecks: [], verify: async () => { throw new Error('no external call authorized'); } },
      { name: bank.vendor, live: true, holderName: async () => { throw new Error('no external call authorized'); }, oneWonTransfer: async () => { throw new Error('no transfer authorized'); } },
    ),
    new MockAmlEngine({ evidenceKey: 'synthetic-only-t31-evidence-key-32-chars' }),
    1_700_000_000_000,
  );

  assert.equal(out.status, 'REJECTED');
  if (out.status === 'REJECTED') {
    assert.match(out.reason, /face_match,liveness/);
    assert.match(out.reason, /BIOMETRIC_AUTHORIZATION_MISSING/);
    assert.ok(!('attrs' in out), 'a failed customer identity mapping must create no positive credential');
  }
});

test('policy-local assurance is derived from performed checks and an inflated expected grade is rejected', async () => {
  const result = evaluateIdentityPolicy(SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
    Methods.WALLET_CONTROL | Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.JURISDICTION_CHECK, 1);
  assert.equal(result.passed, true);
  assert.equal(result.assurance, 3);
  assert.equal(result.assuranceScale, 'policy-local');
  assert.match(result.assuranceBasis ?? '', /document authenticity, and account control/);
  assert.equal(result.requirements.find(item => item.requirement === IdentityRequirement.LIVENESS)?.outcome, 'not-required');
  assert.equal(result.requirements.some(item => item.requirement.includes('jurisdiction')), false,
    'self-declared country checks are not evidence of a human identity');

  const out = await runIssuance({
    wallet: `0x${'ab'.repeat(20)}`,
    declared: { fullName: id.fullName, dateOfBirth: id.dateOfBirth, nationality: 'KR', residence: 'KR' },
    idDocument: id, bankAccount: bank, walletControlProven: true, jurisdiction: 410,
    assurance: 5, identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
  }, new KrAdapter(
    { name: id.vendor, live: true, biometricChecks: [], verify: async () => { throw new Error('no external call authorized'); } },
    { name: bank.vendor, live: true, holderName: async () => { throw new Error('no external call authorized'); }, oneWonTransfer: async () => { throw new Error('no transfer authorized'); } },
  ), new MockAmlEngine({ evidenceKey: 'synthetic-only-t31-assurance-key-32-chars' }), 1_700_000_000_000);
  assert.equal(out.status, 'REJECTED');
  if (out.status === 'REJECTED') assert.match(out.reason, /expected 3/);
});

test('organization UBO and representative requirements stay explicitly unsupported, never passed by document/account bits', () => {
  const organizationPolicy = defineIdentityPolicy({
    schema: 'proofmark-identity-policy-v1', policyId: 'synthetic-organization-v1', customerRiskId: 'synthetic-organization',
    status: 'synthetic', approvalRef: null, subjectKind: 'organization',
    required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.AUTHORIZED_REPRESENTATIVE, IdentityRequirement.BENEFICIAL_OWNER_IDENTITY],
    assuranceBands: [{ level: 1, required: [IdentityRequirement.WALLET_CONTROL], basis: 'wallet control only; no organization identity claim' }],
    biometrics: { mode: 'prohibited' },
  });
  const result = evaluateIdentityPolicy(organizationPolicy,
    Methods.WALLET_CONTROL | Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT, 2);
  assert.equal(result.passed, false);
  assert.deepEqual(result.missing, [IdentityRequirement.AUTHORIZED_REPRESENTATIVE, IdentityRequirement.BENEFICIAL_OWNER_IDENTITY]);
  assert.equal(result.requirements.find(item => item.requirement === IdentityRequirement.BENEFICIAL_OWNER_IDENTITY)?.outcome, 'unsupported');
});

test('biometric policy needs prior necessity, legal-basis and approval references and rejects unauthorized results', () => {
  const base = {
    schema: 'proofmark-identity-policy-v1', policyId: 'synthetic-biometric-v1', customerRiskId: 'synthetic-biometric',
    status: 'approved', approvalRef: 'case:approval:1', subjectKind: 'individual',
    required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.FACE_MATCH],
    assuranceBands: [{ level: 4, required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.FACE_MATCH], basis: 'wallet control and authorized face match' }],
  } satisfies Omit<IdentityPolicyV1, 'biometrics'>;
  assert.throws(() => defineIdentityPolicy({ ...base,
    biometrics: { mode: 'authorized', checks: [IdentityRequirement.FACE_MATCH], necessityRef: '', legalBasisRef: '', approvalRef: '' },
  }), /prior decision reference/);
  const authorized = defineIdentityPolicy({ ...base, biometrics: { mode: 'authorized', checks: [IdentityRequirement.FACE_MATCH],
    necessityRef: 'case:necessity:1', legalBasisRef: 'case:legal:1', approvalRef: 'case:biometric-approval:1' } });
  assert.equal(evaluateIdentityPolicy(authorized, Methods.WALLET_CONTROL | Methods.FACE_MATCH, 1).passed, true);
  const prohibited = evaluateIdentityPolicy(SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
    Methods.WALLET_CONTROL | Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.FACE_MATCH, 1);
  assert.equal(prohibited.passed, false);
  assert.ok(prohibited.violations.includes('UNAUTHORIZED_FACE_MATCH'));
});

test('policy inputs are snapshotted so later requirement mutation cannot lower the gate', () => {
  const rawRequired = [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.DOCUMENT_AUTHENTICITY];
  const raw: IdentityPolicyV1 = {
    schema: 'proofmark-identity-policy-v1', policyId: 'synthetic-snapshot-v1', customerRiskId: 'synthetic-snapshot',
    status: 'synthetic', approvalRef: null, subjectKind: 'individual',
    required: rawRequired,
    assuranceBands: [{ level: 2, required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.DOCUMENT_AUTHENTICITY], basis: 'wallet and document' }],
    biometrics: { mode: 'prohibited' },
  };
  const policy = defineIdentityPolicy(raw);
  rawRequired.pop();
  assert.equal(evaluateIdentityPolicy(policy, Methods.WALLET_CONTROL, 1).passed, false);
});

test('a biometric-capable vendor is stopped before its request unless prior authorization is configured', async () => {
  let calls = 0;
  const vendor = {
    name: 'synthetic:face', live: true, biometricChecks: [IdentityRequirement.FACE_MATCH] as const,
    async verify() { calls++; return { kind: 'verified' as const, ...id, faceMatched: true }; },
  };
  const input = { docType: 'RRC' as const, image: new Uint8Array([1]), fullName: id.fullName,
    birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' };
  await assert.rejects(new KrAdapter(vendor, null).verifyIdDocument(input), /not authorized/);
  assert.equal(calls, 0, 'authorization must be checked before the vendor receives identity data');
  const unauthorizedResult = await new KrAdapter(vendor, null).run({ walletControlProven: true,
    idDocument: { ...id, faceMatched: true }, bankAccount: null });
  assert.match(unauthorizedResult.rejected ?? '', /not authorized/);
  assert.equal(unauthorizedResult.methods & Methods.FACE_MATCH, 0);

  const biometrics = { mode: 'authorized' as const, checks: [IdentityRequirement.FACE_MATCH],
    necessityRef: 'case:necessity:2', legalBasisRef: 'case:legal:2', approvalRef: 'case:approval:2' };
  const out = await new KrAdapter(vendor, null, { biometrics }).verifyIdDocument(input);
  assert.equal(out.kind, 'verified');
  assert.equal(calls, 1);
  const authorizedResult = await new KrAdapter(vendor, null, { biometrics }).run({ walletControlProven: true,
    idDocument: { ...id, faceMatched: true }, bankAccount: null });
  assert.equal(authorizedResult.methods & Methods.FACE_MATCH, Methods.FACE_MATCH);
});
