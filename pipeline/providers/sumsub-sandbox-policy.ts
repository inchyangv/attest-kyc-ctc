import { IdentityRequirement, defineIdentityPolicy } from '../identity-policy.js';
import { PROCESSING_POLICY_SCHEMA, defineProcessingPolicy } from '../privacy-processing-policy.js';
import { RETENTION_POLICY_SCHEMA, type RetentionLayerRuleV1, defineRetentionPolicy } from '../retention-policy.js';

const CUSTOMER_ID = 'proofmark-sumsub-sandbox-test';

/** Technical test policy for Sumsub's sandbox. It carries no production or legal approval claim. */
export const SUMSUB_SANDBOX_TEST_IDENTITY_POLICY = defineIdentityPolicy({
  schema: 'proofmark-identity-policy-v1',
  policyId: 'proofmark-sumsub-sandbox-test-v1',
  customerRiskId: 'sumsub-sandbox-test-only',
  status: 'synthetic',
  approvalRef: null,
  subjectKind: 'individual',
  required: [IdentityRequirement.WALLET_CONTROL],
  assuranceBands: [{ level: 1, required: [IdentityRequirement.WALLET_CONTROL], basis: 'wallet-bound Sumsub sandbox integration test only' }],
  biometrics: {
    mode: 'authorized',
    checks: [IdentityRequirement.FACE_MATCH, IdentityRequirement.LIVENESS],
    necessityRef: 'sandbox-test:document-and-liveness-level',
    legalBasisRef: 'sandbox-test:no-production-or-real-personal-data',
    approvalRef: 'sandbox-test:operator-enabled',
  },
});

export function sumsubSandboxTestProcessingPolicy(recipient: string) {
  return defineProcessingPolicy({
    schema: PROCESSING_POLICY_SCHEMA,
    policyId: 'proofmark-sumsub-sandbox-processing-v1',
    customerId: CUSTOMER_ID,
    status: 'synthetic',
    operatingModel: 'institution-service',
    controllerId: 'proofmark-sandbox-operator',
    processorId: 'sumsub-sandbox',
    approvalRef: null,
    legalReviewRef: null,
    contractRef: null,
    notice: {
      version: 'proofmark-sumsub-sandbox-test-v1',
      noticeRef: 'notice:sumsub-sandbox-test-only',
      rightsRequestRef: 'rights:sumsub-sandbox-dashboard',
      refusalEffectRef: 'notice:sumsub-sandbox-refusal',
    },
    residentIdentifier: { mode: 'prohibited', authorityRef: null, noticeRef: null, items: [] },
    onchain: {
      approved: false,
      networks: ['not-enabled'],
      data: ['credential_metadata'],
      publicationBasisRef: null,
      irreversibilityNoticeRef: 'notice:onchain-publication-disabled',
    },
    flows: [
      {
        stage: 'wallet_consent', recipient: 'proofmark:web', recipientRole: 'controller', countries: ['KR'],
        data: ['wallet_address', 'consent_record'], purposeRef: 'purpose:sumsub-sandbox-wallet-binding',
        legalBasisRef: 'basis:synthetic-integration-test', retentionRef: 'retention:sumsub-sandbox-session',
      },
      {
        stage: 'id_document', recipient, recipientRole: 'processor', countries: ['GLOBAL'],
        data: ['identity_document_image', 'identity_fields', 'biometric_template', 'screening_result', 'credential_metadata'],
        purposeRef: 'purpose:sumsub-sandbox-integration-test', legalBasisRef: 'basis:synthetic-integration-test',
        retentionRef: 'retention:sumsub-sandbox-provider-account',
      },
    ],
  });
}

const layers = (): RetentionLayerRuleV1[] => [
  { layer: 'evidence-vault', action: 'delete', durationDays: 1, retentionRef: 'retention:sumsub-sandbox-vault:1d' },
  { layer: 'issuance-journal', action: 'expire', trigger: 'terminal-at', durationDays: 1, retentionRef: 'retention:sumsub-sandbox-journal:1d' },
  { layer: 'revocation-outbox', action: 'retain-minimized', durationDays: 1, retentionRef: 'retention:sumsub-sandbox-outbox:1d' },
  { layer: 'backup', action: 'expire', durationDays: 1, retentionRef: 'retention:sumsub-sandbox-backup:1d' },
  { layer: 'vendor', action: 'external-delete', durationDays: 1, retentionRef: 'retention:sumsub-sandbox-dashboard-controlled' },
  { layer: 'operational-log', action: 'retain-minimized', durationDays: 1, retentionRef: 'retention:sumsub-sandbox-log:1d' },
  { layer: 'client-copy', action: 'client-controlled', durationDays: null, retentionRef: 'retention:sumsub-sandbox-client-control' },
  { layer: 'onchain', action: 'irreversible', durationDays: null, retentionRef: 'retention:onchain-not-used-by-provider-test' },
];

export const SUMSUB_SANDBOX_TEST_RETENTION_POLICY = defineRetentionPolicy({
  schema: RETENTION_POLICY_SCHEMA,
  policyId: 'proofmark-sumsub-sandbox-retention-v1',
  customerId: CUSTOMER_ID,
  jurisdiction: 'GLOBAL',
  status: 'synthetic',
  approvalRef: null,
  legalReviewRef: null,
  clockRef: 'clock:sumsub-sandbox-session',
  holdAuthorityRef: 'authority:sumsub-sandbox-test-only',
  rules: [
    { outcome: 'issued', trigger: 'decision-at', credentialDisposition: 'unchanged', layers: layers() },
    { outcome: 'review', trigger: 'decision-at', credentialDisposition: 'not-issued', layers: layers() },
    { outcome: 'denied', trigger: 'decision-at', credentialDisposition: 'not-issued', layers: layers() },
    { outcome: 'error', trigger: 'decision-at', credentialDisposition: 'not-issued', layers: layers() },
  ],
});
