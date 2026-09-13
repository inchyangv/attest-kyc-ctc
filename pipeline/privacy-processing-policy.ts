import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical.js';

export const PROCESSING_POLICY_SCHEMA = 'proofmark-processing-policy-v1' as const;

export const ProcessingStage = {
  WALLET_CONSENT: 'wallet_consent',
  ID_DOCUMENT: 'id_document',
  BANK_ACCOUNT: 'bank_account',
  ISSUANCE_PROCESSING: 'issuance_processing',
  RECOVERY_JOURNAL: 'recovery_journal',
  EVIDENCE_VAULT: 'evidence_vault',
  ONCHAIN_PUBLICATION: 'onchain_publication',
} as const;

export type ProcessingStageCode = typeof ProcessingStage[keyof typeof ProcessingStage];
export type OperatingModel = 'first-party' | 'institution-service' | 'sdk-only';
export type RecipientRole = 'controller' | 'processor' | 'subprocessor' | 'public-recipient';
export type ResidentIdentifierItem = 'customer_full' | 'customer_birth_fragment' | 'operator_full';
export type ProcessingDataCategory =
  | 'wallet_address' | 'consent_record' | 'identity_document_image' | 'identity_fields'
  | 'resident_registration_number' | 'bank_account' | 'birth_date_fragment'
  | 'account_holder_name' | 'claim_openings' | 'screening_result' | 'evidence_record'
  | 'signed_transaction' | 'credential_metadata' | 'commitments' | 'biometric_template';

export interface ProcessingFlowV1 {
  stage: ProcessingStageCode;
  recipient: string;
  recipientRole: RecipientRole;
  countries: readonly string[];
  data: readonly ProcessingDataCategory[];
  purposeRef: string;
  legalBasisRef: string;
  retentionRef: string;
}

export interface ProcessingPolicyV1 {
  schema: typeof PROCESSING_POLICY_SCHEMA;
  policyId: string;
  /** Opaque customer or deployment identifier, never a person's name. */
  customerId: string;
  status: 'synthetic' | 'approved';
  operatingModel: OperatingModel;
  controllerId: string;
  processorId: string | null;
  approvalRef: string | null;
  legalReviewRef: string | null;
  contractRef: string | null;
  notice: {
    version: string;
    noticeRef: string;
    rightsRequestRef: string;
    refusalEffectRef: string;
  };
  residentIdentifier: {
    mode: 'prohibited' | 'synthetic-only' | 'authorized';
    authorityRef: string | null;
    noticeRef: string | null;
    items: readonly ResidentIdentifierItem[];
  };
  onchain: {
    approved: boolean;
    networks: readonly string[];
    data: readonly ProcessingDataCategory[];
    publicationBasisRef: string | null;
    irreversibilityNoticeRef: string;
  };
  flows: readonly ProcessingFlowV1[];
}

export interface ProcessingPolicyBindingV1 {
  schema: 'proofmark-processing-policy-binding-v1';
  policyId: string;
  noticeVersion: string;
  fingerprint: string;
}

export interface ProcessingPolicyEvidenceV1 {
  schema: 'proofmark-processing-policy-evidence-v1';
  policyId: string;
  customerId: string;
  operatingModel: OperatingModel;
  noticeVersion: string;
  approvalRef: string | null;
  legalReviewRef: string | null;
  fingerprint: string;
  /** Digest of the exact processing notice text shown and included in the wallet statement. */
  consentStatementHash: string;
}

export class ProcessingPolicyError extends Error {
  constructor(readonly code: 'PROCESSING_POLICY_INVALID' | 'PROCESSING_POLICY_CHANGED' | 'PROCESSING_NOT_AUTHORIZED', message: string) {
    super(message);
    this.name = 'ProcessingPolicyError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/;
const COUNTRY = /^(?:[A-Z]{2}|GLOBAL)$/;
const STAGES = new Set<ProcessingStageCode>(Object.values(ProcessingStage));
const ROLES = new Set<RecipientRole>(['controller', 'processor', 'subprocessor', 'public-recipient']);
const DATA = new Set<ProcessingDataCategory>([
  'wallet_address', 'consent_record', 'identity_document_image', 'identity_fields',
  'resident_registration_number', 'bank_account', 'birth_date_fragment', 'account_holder_name',
  'claim_openings', 'screening_result', 'evidence_record', 'signed_transaction',
  'credential_metadata', 'commitments', 'biometric_template',
]);
const RRN_ITEMS = new Set<ResidentIdentifierItem>(['customer_full', 'customer_birth_fragment', 'operator_full']);

const reference = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !REFERENCE.test(value)) throw new Error(`${field} must be an opaque evidence reference`);
  return value;
};
const identifier = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${field} must be an opaque identifier`);
  return value;
};
const unique = <T extends string>(value: unknown, allowed: Set<T>, field: string): T[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !allowed.has(item as T))) {
    throw new Error(`${field} contains an unsupported or empty value`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} contains duplicate values`);
  return [...value] as T[];
};

/**
 * Validate and snapshot the complete customer/deployment processing manifest. References are
 * evidence pointers, not self-proving legal conclusions; production accepts only a separately
 * approved manifest so the server cannot silently infer a party, purpose, vendor or location.
 */
export function defineProcessingPolicy(input: ProcessingPolicyV1): Readonly<ProcessingPolicyV1> {
  try {
    if (!input || input.schema !== PROCESSING_POLICY_SCHEMA) throw new Error('unsupported processing policy schema');
    const policyId = identifier(input.policyId, 'processing policyId');
    const customerId = identifier(input.customerId, 'processing customerId');
    if (!['synthetic', 'approved'].includes(input.status)) throw new Error('processing policy status must be synthetic or approved');
    if (!['first-party', 'institution-service', 'sdk-only'].includes(input.operatingModel)) throw new Error('unsupported operating model');
    const controllerId = identifier(input.controllerId, 'processing controllerId');
    const processorId = input.processorId === null ? null : identifier(input.processorId, 'processing processorId');
    if (input.operatingModel === 'institution-service' && !processorId) throw new Error('institution-service requires an identified processor');
    if (input.operatingModel === 'first-party' && processorId) throw new Error('first-party processing cannot assign a separate processor without a different model');
    if (input.operatingModel === 'sdk-only' && processorId) throw new Error('SDK-only policy cannot assign Proofmark as a hosted processor');

    const approvalRef = input.approvalRef === null ? null : reference(input.approvalRef, 'processing approvalRef');
    const legalReviewRef = input.legalReviewRef === null ? null : reference(input.legalReviewRef, 'processing legalReviewRef');
    const contractRef = input.contractRef === null ? null : reference(input.contractRef, 'processing contractRef');
    if (input.status === 'approved') {
      if (!approvalRef) throw new Error('approved processing policy requires approvalRef');
      if (!legalReviewRef) throw new Error('approved processing policy requires legalReviewRef');
      if (!contractRef) throw new Error('approved processing policy requires contractRef');
    } else if (approvalRef || legalReviewRef || contractRef) {
      throw new Error('synthetic processing policy cannot claim approval, legal review, or contract evidence');
    }

    if (!input.notice) throw new Error('processing notice is required');
    const notice = Object.freeze({
      version: identifier(input.notice.version, 'processing notice.version'),
      noticeRef: reference(input.notice.noticeRef, 'processing notice.noticeRef'),
      rightsRequestRef: reference(input.notice.rightsRequestRef, 'processing notice.rightsRequestRef'),
      refusalEffectRef: reference(input.notice.refusalEffectRef, 'processing notice.refusalEffectRef'),
    });

    if (!input.residentIdentifier || !['prohibited', 'synthetic-only', 'authorized'].includes(input.residentIdentifier.mode)) {
      throw new Error('resident identifier policy is required');
    }
    const rrnItems = input.residentIdentifier.items.length === 0
      ? [] : unique(input.residentIdentifier.items, RRN_ITEMS, 'residentIdentifier.items');
    const rrnAuthority = input.residentIdentifier.authorityRef === null ? null
      : reference(input.residentIdentifier.authorityRef, 'resident identifier authority');
    const rrnNotice = input.residentIdentifier.noticeRef === null ? null
      : reference(input.residentIdentifier.noticeRef, 'resident identifier notice');
    if (input.residentIdentifier.mode === 'authorized' && (!rrnAuthority || !rrnNotice || rrnItems.length === 0)) {
      throw new Error('authorized resident identifier processing requires resident identifier authority, notice, and exact items');
    }
    if (input.residentIdentifier.mode === 'prohibited' && (rrnAuthority || rrnNotice || rrnItems.length)) {
      throw new Error('prohibited resident identifier policy cannot list authority, notice, or items');
    }
    if (input.residentIdentifier.mode === 'synthetic-only' && input.status !== 'synthetic') {
      throw new Error('synthetic-only resident identifiers require a synthetic policy');
    }
    const residentIdentifier = Object.freeze({ ...input.residentIdentifier, items: Object.freeze(rrnItems),
      authorityRef: rrnAuthority, noticeRef: rrnNotice });

    if (!input.onchain || typeof input.onchain.approved !== 'boolean') throw new Error('on-chain processing policy is required');
    const networks = unique(input.onchain.networks, new Set<string>(input.onchain.networks.filter(v => typeof v === 'string' && IDENTIFIER.test(v))), 'onchain.networks');
    const onchainData = unique(input.onchain.data, DATA, 'onchain.data');
    const publicationBasisRef = input.onchain.publicationBasisRef === null ? null
      : reference(input.onchain.publicationBasisRef, 'onchain.publicationBasisRef');
    const irreversibilityNoticeRef = reference(input.onchain.irreversibilityNoticeRef, 'onchain.irreversibilityNoticeRef');
    if (input.status === 'approved' && (!input.onchain.approved || !publicationBasisRef)) {
      throw new Error('approved processing policy requires on-chain publication approval and basis');
    }
    if (input.status === 'synthetic' && publicationBasisRef) throw new Error('synthetic policy cannot claim an on-chain legal basis');
    const onchain = Object.freeze({ ...input.onchain, networks: Object.freeze(networks), data: Object.freeze(onchainData),
      publicationBasisRef, irreversibilityNoticeRef });

    if (!Array.isArray(input.flows) || input.flows.length === 0) throw new Error('processing data flows are required');
    const seen = new Set<string>();
    const flows = input.flows.map((flow: ProcessingFlowV1, index: number) => {
      if (!flow || !STAGES.has(flow.stage)) throw new Error(`flows[${index}].stage is unsupported`);
      const recipient = identifier(flow.recipient, `flows[${index}].recipient`);
      if (!ROLES.has(flow.recipientRole)) throw new Error(`flows[${index}].recipientRole is unsupported`);
      const countries = unique(flow.countries, new Set<string>(flow.countries.filter(v => typeof v === 'string' && COUNTRY.test(v))), `flows[${index}].countries`);
      const data = unique(flow.data, DATA, `flows[${index}].data`);
      const key = `${flow.stage}\0${recipient}`;
      if (seen.has(key)) throw new Error('processing flows contain a duplicate stage/recipient');
      seen.add(key);
      return Object.freeze({ ...flow, recipient, countries: Object.freeze(countries), data: Object.freeze(data),
        purposeRef: reference(flow.purposeRef, `flows[${index}].purposeRef`),
        legalBasisRef: reference(flow.legalBasisRef, `flows[${index}].legalBasisRef`),
        retentionRef: reference(flow.retentionRef, `flows[${index}].retentionRef`) });
    });
    if (!flows.some(flow => flow.stage === ProcessingStage.WALLET_CONSENT)) throw new Error('wallet consent data flow is required');
    const rrnFlows = flows.filter(flow => flow.data.includes('resident_registration_number'));
    if (rrnFlows.length && residentIdentifier.mode === 'prohibited') throw new Error('resident number appears in a prohibited data flow');
    if (!rrnFlows.length && residentIdentifier.items.length) throw new Error('resident identifier items require a matching data flow');
    const chainFlow = flows.find(flow => flow.stage === ProcessingStage.ONCHAIN_PUBLICATION);
    if (input.onchain.approved && !chainFlow) throw new Error('approved on-chain publication requires a data flow');
    if (chainFlow && (chainFlow.recipientRole !== 'public-recipient' || !chainFlow.countries.includes('GLOBAL')
      || onchainData.some(item => !chainFlow.data.includes(item)))) {
      throw new Error('on-chain data flow must disclose its public global recipient and data');
    }

    return Object.freeze({ ...input, policyId, customerId, controllerId, processorId, approvalRef, legalReviewRef,
      contractRef, notice, residentIdentifier, onchain, flows: Object.freeze(flows) });
  } catch (error) {
    if (error instanceof ProcessingPolicyError) throw error;
    throw new ProcessingPolicyError('PROCESSING_POLICY_INVALID', error instanceof Error ? error.message : 'processing policy is invalid');
  }
}

export function processingPolicyFingerprint(input: ProcessingPolicyV1): string {
  const policy = defineProcessingPolicy(input);
  return createHash('sha256').update(`proofmark-processing-policy-v1|${canonicalJson(policy)}`).digest('hex');
}

export function policyBinding(input: ProcessingPolicyV1): ProcessingPolicyBindingV1 {
  const policy = defineProcessingPolicy(input);
  return { schema: 'proofmark-processing-policy-binding-v1', policyId: policy.policyId,
    noticeVersion: policy.notice.version, fingerprint: processingPolicyFingerprint(policy) };
}

export function processingPolicyEvidence(input: ProcessingPolicyV1): ProcessingPolicyEvidenceV1 {
  const policy = defineProcessingPolicy(input);
  return { schema: 'proofmark-processing-policy-evidence-v1', policyId: policy.policyId, customerId: policy.customerId,
    operatingModel: policy.operatingModel, noticeVersion: policy.notice.version,
    approvalRef: policy.approvalRef, legalReviewRef: policy.legalReviewRef,
    fingerprint: processingPolicyFingerprint(policy), consentStatementHash: processingConsentStatementHash(policy) };
}

export function authorizeProcessing(input: ProcessingPolicyV1, binding: ProcessingPolicyBindingV1, request: {
  stage: ProcessingStageCode;
  recipient: string;
  data: readonly ProcessingDataCategory[];
}): void {
  const policy = defineProcessingPolicy(input);
  const expected = policyBinding(policy);
  if (!binding || binding.schema !== expected.schema || binding.policyId !== expected.policyId
    || binding.noticeVersion !== expected.noticeVersion || binding.fingerprint !== expected.fingerprint) {
    throw new ProcessingPolicyError('PROCESSING_POLICY_CHANGED', 'processing policy changed after wallet consent; start a new flow');
  }
  if (policy.operatingModel === 'sdk-only' && request.stage !== ProcessingStage.WALLET_CONSENT) {
    throw new ProcessingPolicyError('PROCESSING_NOT_AUTHORIZED', 'SDK-only policy cannot authorize Proofmark-hosted processing');
  }
  const flow = policy.flows.find(candidate => candidate.stage === request.stage && candidate.recipient === request.recipient);
  if (!flow) throw new ProcessingPolicyError('PROCESSING_NOT_AUTHORIZED', 'processing stage/recipient is not present in the approved data flow');
  for (const item of request.data) {
    if (!flow.data.includes(item)) throw new ProcessingPolicyError('PROCESSING_NOT_AUTHORIZED', `data category ${item} is not authorized for this stage`);
  }
  if (request.data.includes('resident_registration_number') && policy.residentIdentifier.mode === 'prohibited') {
    throw new ProcessingPolicyError('PROCESSING_NOT_AUTHORIZED', 'resident registration number processing is prohibited by this policy');
  }
  if (request.stage === ProcessingStage.ONCHAIN_PUBLICATION && !policy.onchain.approved) {
    throw new ProcessingPolicyError('PROCESSING_NOT_AUTHORIZED', 'on-chain publication is not approved by this policy');
  }
}

export function processingConsentStatement(input: ProcessingPolicyV1): string {
  const policy = defineProcessingPolicy(input);
  const recipients = [...new Set(policy.flows.map(flow => flow.recipient))].join(',');
  const countries = [...new Set(policy.flows.flatMap(flow => flow.countries))].join(',');
  const rrn = policy.residentIdentifier.mode === 'authorized' ? 'authorized RRN items'
    : policy.residentIdentifier.mode === 'synthetic-only' ? 'synthetic RRN fixture only' : 'no RRN';
  const publication = policy.onchain.approved
    ? `wallet-linked metadata and commitments are published irreversibly on ${policy.onchain.networks.join(',')}`
    : 'on-chain publication is disabled for this flow';
  return `Proofmark notice ${policy.notice.version}: policy ${policy.policyId}; model ${policy.operatingModel}; controller ${policy.controllerId}; recipients ${recipients}; locations ${countries}; ${rrn}; rights ${policy.notice.rightsRequestRef}; retention follows each approved flow; ${publication}.`;
}

export function processingConsentStatementHash(input: ProcessingPolicyV1): string {
  return consentTextHash(processingConsentStatement(input));
}

/** Domain-separated digest for an exact displayed/signed consent statement. */
export function consentTextHash(statement: string): string {
  if (typeof statement !== 'string' || !statement.length) throw new Error('consent statement is required');
  return `0x${createHash('sha256').update('proofmark-consent-text-v1\0').update(statement).digest('hex')}`;
}

export const SYNTHETIC_PROCESSING_POLICY = defineProcessingPolicy({
  schema: PROCESSING_POLICY_SCHEMA,
  policyId: 'proofmark-synthetic-processing-v1',
  customerId: 'synthetic-demo-only',
  status: 'synthetic',
  operatingModel: 'first-party',
  controllerId: 'proofmark-demo',
  processorId: null,
  approvalRef: null,
  legalReviewRef: null,
  contractRef: null,
  notice: {
    version: 'proofmark-kyc-v4-synthetic',
    noticeRef: 'notice:synthetic-demo:v1',
    rightsRequestRef: 'rights:synthetic-demo:v1',
    refusalEffectRef: 'notice:synthetic-demo:refusal-v1',
  },
  residentIdentifier: {
    mode: 'synthetic-only', authorityRef: null, noticeRef: 'notice:synthetic-fixtures-only:v1',
    items: ['customer_full', 'customer_birth_fragment'],
  },
  onchain: {
    approved: true,
    networks: ['ethereum-sepolia', 'creditcoin-cc3'],
    data: ['wallet_address', 'credential_metadata', 'commitments'],
    publicationBasisRef: null,
    irreversibilityNoticeRef: 'notice:synthetic-onchain-irreversibility:v1',
  },
  flows: [
    { stage: 'wallet_consent', recipient: 'proofmark:web', recipientRole: 'controller', countries: ['KR'],
      data: ['wallet_address', 'consent_record'], purposeRef: 'purpose:synthetic-wallet', legalBasisRef: 'basis:synthetic-fixture', retentionRef: 'retention:wallet-token' },
    { stage: 'id_document', recipient: 'demo:id', recipientRole: 'controller', countries: ['KR'],
      data: ['identity_document_image', 'identity_fields', 'resident_registration_number'], purposeRef: 'purpose:synthetic-id', legalBasisRef: 'basis:synthetic-fixture', retentionRef: 'retention:browser-token' },
    { stage: 'bank_account', recipient: 'demo:bank', recipientRole: 'controller', countries: ['KR'],
      data: ['bank_account', 'birth_date_fragment', 'account_holder_name'], purposeRef: 'purpose:synthetic-bank', legalBasisRef: 'basis:synthetic-fixture', retentionRef: 'retention:demo-bank-state' },
    { stage: 'issuance_processing', recipient: 'proofmark:issuer', recipientRole: 'controller', countries: ['KR'],
      data: ['identity_fields', 'account_holder_name', 'claim_openings', 'screening_result'], purposeRef: 'purpose:synthetic-issuance', legalBasisRef: 'basis:synthetic-fixture', retentionRef: 'retention:issuance-memory' },
    { stage: 'recovery_journal', recipient: 'proofmark:journal', recipientRole: 'controller', countries: ['KR'],
      data: ['wallet_address', 'claim_openings', 'evidence_record', 'signed_transaction'], purposeRef: 'purpose:synthetic-recovery', legalBasisRef: 'basis:synthetic-fixture', retentionRef: 'retention:journal-terminal-24h' },
    { stage: 'onchain_publication', recipient: 'public:blockchains', recipientRole: 'public-recipient', countries: ['GLOBAL'],
      data: ['wallet_address', 'credential_metadata', 'commitments'], purposeRef: 'purpose:synthetic-publication', legalBasisRef: 'basis:synthetic-fixture', retentionRef: 'retention:immutable-ledger' },
  ],
});
