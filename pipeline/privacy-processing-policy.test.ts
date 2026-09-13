import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROCESSING_POLICY_SCHEMA,
  ProcessingPolicyError,
  authorizeProcessing,
  defineProcessingPolicy,
  policyBinding,
  processingPolicyEvidence,
  processingPolicyFingerprint,
  processingConsentStatement,
  processingConsentStatementHash,
  type ProcessingPolicyV1,
} from './privacy-processing-policy.js';

const approvedPolicy = (overrides: Partial<ProcessingPolicyV1> = {}): ProcessingPolicyV1 => ({
  schema: PROCESSING_POLICY_SCHEMA,
  policyId: 'customer-alpha-privacy-v1',
  customerId: 'customer-alpha',
  status: 'approved',
  operatingModel: 'institution-service',
  controllerId: 'customer-alpha-controller',
  processorId: 'proofmark-processor',
  approvalRef: 'approval:privacy:2026-09-07',
  legalReviewRef: 'legal:opinion:2026-09-07',
  contractRef: 'contract:dpa:customer-alpha:v1',
  notice: {
    version: 'customer-alpha-notice-v1',
    noticeRef: 'notice:customer-alpha:v1',
    rightsRequestRef: 'rights:customer-alpha:channel-v1',
    refusalEffectRef: 'notice:customer-alpha:refusal-v1',
  },
  residentIdentifier: {
    mode: 'authorized',
    authorityRef: 'legal:rrn-authority:customer-alpha:v1',
    noticeRef: 'notice:customer-alpha:rrn-v1',
    items: ['customer_full', 'customer_birth_fragment'],
  },
  onchain: {
    approved: true,
    networks: ['ethereum-sepolia', 'creditcoin-cc3'],
    data: ['wallet_address', 'credential_metadata', 'commitments'],
    publicationBasisRef: 'legal:onchain-publication:customer-alpha:v1',
    irreversibilityNoticeRef: 'notice:onchain-irreversibility:customer-alpha:v1',
  },
  flows: [
    { stage: 'wallet_consent', recipient: 'proofmark:web', recipientRole: 'processor', countries: ['KR'],
      data: ['wallet_address', 'consent_record'], purposeRef: 'purpose:wallet-control', legalBasisRef: 'basis:wallet-consent', retentionRef: 'retention:wallet-flow' },
    { stage: 'id_document', recipient: 'codef:api', recipientRole: 'subprocessor', countries: ['KR'],
      data: ['identity_document_image', 'identity_fields', 'resident_registration_number'], purposeRef: 'purpose:id-authenticity', legalBasisRef: 'basis:id-check', retentionRef: 'retention:codef-contract' },
    { stage: 'bank_account', recipient: 'openbanking:prod', recipientRole: 'subprocessor', countries: ['KR'],
      data: ['bank_account', 'birth_date_fragment', 'account_holder_name'], purposeRef: 'purpose:account-control', legalBasisRef: 'basis:bank-check', retentionRef: 'retention:kftc-contract' },
    { stage: 'issuance_processing', recipient: 'proofmark:issuer', recipientRole: 'processor', countries: ['KR'],
      data: ['identity_fields', 'account_holder_name', 'claim_openings', 'screening_result'], purposeRef: 'purpose:credential-issuance', legalBasisRef: 'basis:institution-instruction', retentionRef: 'retention:issuance-memory' },
    { stage: 'recovery_journal', recipient: 'proofmark:journal', recipientRole: 'processor', countries: ['KR'],
      data: ['wallet_address', 'claim_openings', 'evidence_record', 'signed_transaction'], purposeRef: 'purpose:issuance-recovery', legalBasisRef: 'basis:institution-instruction', retentionRef: 'retention:journal-terminal-24h' },
    { stage: 'evidence_vault', recipient: 'proofmark:vault', recipientRole: 'processor', countries: ['KR'],
      data: ['identity_fields', 'claim_openings', 'evidence_record'], purposeRef: 'purpose:institution-record', legalBasisRef: 'basis:institution-record', retentionRef: 'retention:customer-alpha-schedule' },
    { stage: 'onchain_publication', recipient: 'public:blockchains', recipientRole: 'public-recipient', countries: ['GLOBAL'],
      data: ['wallet_address', 'credential_metadata', 'commitments'], purposeRef: 'purpose:credential-publication', legalBasisRef: 'basis:onchain-publication', retentionRef: 'retention:immutable-ledger' },
  ],
  ...overrides,
});

test('PM-T32-01 a changed customer/vendor/transfer policy cannot reuse an earlier wallet consent', () => {
  const signed = defineProcessingPolicy(approvedPolicy());
  const binding = policyBinding(signed);
  const changed = defineProcessingPolicy(approvedPolicy({
    policyId: 'customer-alpha-privacy-v2',
    approvalRef: 'approval:privacy:2026-09-08',
    flows: approvedPolicy().flows.map(flow => flow.stage === 'id_document'
      ? { ...flow, recipient: 'new-id-vendor', countries: ['US'] }
      : flow),
  }));

  assert.throws(
    () => authorizeProcessing(changed, binding, {
      stage: 'id_document', recipient: 'new-id-vendor',
      data: ['identity_document_image', 'identity_fields', 'resident_registration_number'],
    }),
    (error: unknown) => error instanceof ProcessingPolicyError && error.code === 'PROCESSING_POLICY_CHANGED',
  );
});

test('approved manifests cover the exact recipient/data stage and produce PII-free bound evidence', () => {
  const policy = defineProcessingPolicy(approvedPolicy());
  const binding = policyBinding(policy);
  authorizeProcessing(policy, binding, {
    stage: 'id_document', recipient: 'codef:api',
    data: ['identity_document_image', 'resident_registration_number'],
  });
  assert.throws(() => authorizeProcessing(policy, binding, {
    stage: 'id_document', recipient: 'unapproved-vendor', data: ['identity_document_image'],
  }), /not present in the approved data flow/);
  assert.throws(() => authorizeProcessing(policy, binding, {
    stage: 'id_document', recipient: 'codef:api', data: ['biometric_template'],
  }), /data category/);

  const evidence = processingPolicyEvidence(policy);
  assert.equal(evidence.fingerprint, processingPolicyFingerprint(policy));
  assert.equal(evidence.consentStatementHash, processingConsentStatementHash(policy));
  assert.match(processingConsentStatement(policy), /customer-alpha-notice-v1/);
  assert.deepEqual(Object.keys(evidence).sort(), [
    'approvalRef', 'consentStatementHash', 'customerId', 'fingerprint', 'legalReviewRef', 'noticeVersion',
    'operatingModel', 'policyId', 'schema',
  ]);
});

test('production manifests reject missing legal review, model contracts, RRN authority, rights, and on-chain approval', () => {
  assert.throws(() => defineProcessingPolicy(approvedPolicy({ legalReviewRef: null })), /legalReviewRef/);
  assert.throws(() => defineProcessingPolicy(approvedPolicy({ contractRef: null })), /contractRef/);
  assert.throws(() => defineProcessingPolicy(approvedPolicy({
    residentIdentifier: { ...approvedPolicy().residentIdentifier, authorityRef: null },
  })), /resident identifier authority/);
  assert.throws(() => defineProcessingPolicy(approvedPolicy({
    notice: { ...approvedPolicy().notice, rightsRequestRef: '' },
  })), /rightsRequestRef/);
  assert.throws(() => defineProcessingPolicy(approvedPolicy({
    onchain: { ...approvedPolicy().onchain, approved: false },
  })), /on-chain publication approval/);
});

test('SDK-only policy cannot authorize Proofmark-hosted processing', () => {
  const sdk = defineProcessingPolicy(approvedPolicy({
    operatingModel: 'sdk-only', processorId: null, contractRef: 'contract:sdk-license:v1',
  }));
  assert.throws(() => authorizeProcessing(sdk, policyBinding(sdk), {
    stage: 'issuance_processing', recipient: 'proofmark:issuer', data: ['identity_fields'],
  }), /SDK-only policy/);
});
