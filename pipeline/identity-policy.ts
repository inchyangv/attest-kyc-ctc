import { Methods, type MethodName } from './methods.js';

export const IDENTITY_POLICY_SCHEMA = 'proofmark-identity-policy-v1' as const;

export const IdentityRequirement = {
  WALLET_CONTROL: 'wallet_control',
  DOCUMENT_AUTHENTICITY: 'document_authenticity',
  ACCOUNT_CONTROL: 'account_control',
  FACE_MATCH: 'face_match',
  LIVENESS: 'liveness',
  AUTHORIZED_REPRESENTATIVE: 'authorized_representative',
  BENEFICIAL_OWNER_IDENTITY: 'beneficial_owner_identity',
} as const;

export type IdentityRequirementCode = typeof IdentityRequirement[keyof typeof IdentityRequirement];
export type BiometricRequirement = typeof IdentityRequirement.FACE_MATCH | typeof IdentityRequirement.LIVENESS;

export interface IdentityAssuranceBandV1 {
  level: 1 | 2 | 3 | 4 | 5;
  required: readonly IdentityRequirementCode[];
  /** Human-readable policy-local basis. It is not a portable provider grade. */
  basis: string;
}

export type BiometricPolicyV1 =
  | { mode: 'prohibited' }
  | {
      mode: 'authorized';
      checks: readonly BiometricRequirement[];
      necessityRef: string;
      legalBasisRef: string;
      approvalRef: string;
    };

export interface IdentityPolicyV1 {
  schema: typeof IDENTITY_POLICY_SCHEMA;
  policyId: string;
  /** Customer-owned risk classification identifier; never a person's risk data. */
  customerRiskId: string;
  status: 'synthetic' | 'approved';
  /** Opaque customer/compliance approval record. Required for non-synthetic operation. */
  approvalRef: string | null;
  subjectKind: 'individual' | 'organization';
  required: readonly IdentityRequirementCode[];
  assuranceBands: readonly IdentityAssuranceBandV1[];
  biometrics: BiometricPolicyV1;
}

export interface IdentityRequirementResultV1 {
  requirement: IdentityRequirementCode;
  method: MethodName | null;
  required: boolean;
  performed: boolean;
  outcome: 'pass' | 'missing' | 'not-required' | 'unsupported';
}

export interface IdentityPolicyEvaluationV1 {
  schema: 'proofmark-identity-evaluation-v1';
  policyId: string;
  customerRiskId: string;
  policyStatus: IdentityPolicyV1['status'];
  approvalRef: string | null;
  subjectKind: IdentityPolicyV1['subjectKind'];
  assurance: number;
  assuranceScale: 'policy-local';
  assuranceBasis: string | null;
  passed: boolean;
  missing: IdentityRequirementCode[];
  violations: string[];
  requirements: IdentityRequirementResultV1[];
  biometrics: { mode: BiometricPolicyV1['mode']; authorizedChecks: BiometricRequirement[] };
}

const REQUIREMENTS = new Set<IdentityRequirementCode>(Object.values(IdentityRequirement));
const BIOMETRICS = new Set<BiometricRequirement>([IdentityRequirement.FACE_MATCH, IdentityRequirement.LIVENESS]);
const METHOD_BY_REQUIREMENT: Record<IdentityRequirementCode, MethodName | null> = {
  wallet_control: 'WALLET_CONTROL',
  document_authenticity: 'ID_DOC_AUTHENTICITY',
  account_control: 'BANK_ACCOUNT',
  face_match: 'FACE_MATCH',
  liveness: 'LIVENESS',
  // Schema v0 has no performed-check bit for a representative or UBO identity workflow.
  authorized_representative: null,
  beneficial_owner_identity: null,
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/;

function uniqueRequirements(value: unknown, field: string): IdentityRequirementCode[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !REQUIREMENTS.has(item as IdentityRequirementCode))) {
    throw new Error(`${field} contains an unknown identity requirement`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} contains duplicate identity requirements`);
  return value as IdentityRequirementCode[];
}

/**
 * Validates and snapshots a policy. Callers cannot mutate requirements or assurance meaning after
 * screening has started. The returned levels are customer-policy-local and are never inferred
 * from a provider's numeric grade.
 */
export function defineIdentityPolicy(input: IdentityPolicyV1): Readonly<IdentityPolicyV1> {
  if (!input || input.schema !== IDENTITY_POLICY_SCHEMA) throw new Error('unsupported identity policy schema');
  if (!IDENTIFIER.test(input.policyId)) throw new Error('identity policyId must be a stable opaque identifier');
  if (!IDENTIFIER.test(input.customerRiskId)) throw new Error('identity customerRiskId must be a stable opaque identifier');
  if (!['synthetic', 'approved'].includes(input.status)) throw new Error('identity policy status must be synthetic or approved');
  if (input.status === 'approved' && (!input.approvalRef || !REFERENCE.test(input.approvalRef))) {
    throw new Error('approved identity policy requires an opaque approvalRef');
  }
  if (input.status === 'synthetic' && input.approvalRef !== null) throw new Error('synthetic identity policy cannot claim approval');
  if (!['individual', 'organization'].includes(input.subjectKind)) throw new Error('unsupported identity subjectKind');
  const required = uniqueRequirements(input.required, 'identity required');
  if (!Array.isArray(input.assuranceBands) || input.assuranceBands.length === 0) throw new Error('identity assuranceBands are required');
  const levels = new Set<number>();
  const assuranceBands = input.assuranceBands.map((band, index) => {
    if (!band || !Number.isInteger(band.level) || band.level < 1 || band.level > 5 || levels.has(band.level)) {
      throw new Error('identity assurance levels must be unique integers from 1 to 5');
    }
    levels.add(band.level);
    const requirements = uniqueRequirements(band.required, `identity assuranceBands[${index}].required`);
    if (!requirements.includes(IdentityRequirement.WALLET_CONTROL)) throw new Error('each identity assurance band must require wallet_control');
    if (!band.basis?.trim() || band.basis.length > 240) throw new Error('each identity assurance band needs a bounded basis');
    return Object.freeze({ level: band.level, required: Object.freeze([...requirements]), basis: band.basis.trim() });
  }).sort((a, b) => a.level - b.level);
  for (let i = 1; i < assuranceBands.length; i++) {
    const current = new Set(assuranceBands[i].required);
    if (assuranceBands[i - 1].required.some(requirement => !current.has(requirement))) {
      throw new Error('higher identity assurance bands must preserve every lower-band requirement');
    }
  }
  const biometrics = input.biometrics;
  if (!biometrics || !['prohibited', 'authorized'].includes(biometrics.mode)) throw new Error('identity biometric policy is required');
  let biometricSnapshot: BiometricPolicyV1 = { mode: 'prohibited' };
  if (biometrics.mode === 'authorized') {
    const checks = uniqueRequirements(biometrics.checks, 'identity biometrics.checks');
    if (checks.length === 0 || checks.some(check => !BIOMETRICS.has(check as BiometricRequirement))) {
      throw new Error('authorized biometrics must name face_match and/or liveness');
    }
    for (const [name, value] of Object.entries({ necessityRef: biometrics.necessityRef, legalBasisRef: biometrics.legalBasisRef, approvalRef: biometrics.approvalRef })) {
      if (!REFERENCE.test(value)) throw new Error(`identity biometric ${name} must be a prior decision reference`);
    }
    biometricSnapshot = Object.freeze({ ...biometrics,
      checks: Object.freeze([...checks]) as readonly BiometricRequirement[] });
  }
  return Object.freeze({ ...input, required: Object.freeze([...required]),
    assuranceBands: Object.freeze(assuranceBands), biometrics: biometricSnapshot });
}

const performed = (requirement: IdentityRequirementCode, methods: number): boolean => {
  const method = METHOD_BY_REQUIREMENT[requirement];
  return method !== null && (methods & Methods[method]) === Methods[method];
};

export function evaluateIdentityPolicy(input: IdentityPolicyV1, methods: number, kind: number): IdentityPolicyEvaluationV1 {
  const policy = defineIdentityPolicy(input);
  const required = new Set(policy.required);
  const allRequirements = [...REQUIREMENTS];
  const requirements = allRequirements.map<IdentityRequirementResultV1>((requirement) => {
    const method = METHOD_BY_REQUIREMENT[requirement];
    const isRequired = required.has(requirement);
    const didRun = performed(requirement, methods);
    const outcome = !isRequired ? 'not-required' : method === null ? 'unsupported' : didRun ? 'pass' : 'missing';
    return { requirement, method, required: isRequired, performed: didRun, outcome };
  });
  const missing = requirements.filter(item => item.required && item.outcome !== 'pass').map(item => item.requirement);
  const authorizedChecks = policy.biometrics.mode === 'authorized' ? [...policy.biometrics.checks] : [];
  const violations: string[] = [];
  if ((policy.subjectKind === 'individual' ? 1 : 2) !== kind) violations.push('SUBJECT_KIND_MISMATCH');
  const biometricReferenced = new Set([
    ...policy.required.filter(item => BIOMETRICS.has(item as BiometricRequirement)),
    ...policy.assuranceBands.flatMap(band => band.required).filter(item => BIOMETRICS.has(item as BiometricRequirement)),
  ] as BiometricRequirement[]);
  if (biometricReferenced.size && policy.biometrics.mode !== 'authorized') violations.push('BIOMETRIC_AUTHORIZATION_MISSING');
  for (const requirement of BIOMETRICS) {
    if (performed(requirement, methods) && !authorizedChecks.includes(requirement)) violations.push(`UNAUTHORIZED_${requirement.toUpperCase()}`);
  }
  const earned = policy.assuranceBands
    .filter(band => band.required.every(requirement => performed(requirement, methods)))
    .at(-1);
  return {
    schema: 'proofmark-identity-evaluation-v1', policyId: policy.policyId, customerRiskId: policy.customerRiskId,
    policyStatus: policy.status, approvalRef: policy.approvalRef,
    subjectKind: policy.subjectKind, assurance: earned?.level ?? 0, assuranceScale: 'policy-local',
    assuranceBasis: earned?.basis ?? null, passed: missing.length === 0 && violations.length === 0 && !!earned,
    missing, violations, requirements,
    biometrics: { mode: policy.biometrics.mode, authorizedChecks },
  };
}

export const SYNTHETIC_INDIVIDUAL_NONFACE_POLICY = defineIdentityPolicy({
  schema: IDENTITY_POLICY_SCHEMA,
  policyId: 'proofmark-synthetic-individual-nonface-v1',
  customerRiskId: 'synthetic-demo-only',
  status: 'synthetic',
  approvalRef: null,
  subjectKind: 'individual',
  required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.DOCUMENT_AUTHENTICITY, IdentityRequirement.ACCOUNT_CONTROL],
  assuranceBands: [
    { level: 1, required: [IdentityRequirement.WALLET_CONTROL], basis: 'wallet challenge only' },
    { level: 2, required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.DOCUMENT_AUTHENTICITY], basis: 'wallet challenge and document authenticity' },
    { level: 3, required: [IdentityRequirement.WALLET_CONTROL, IdentityRequirement.DOCUMENT_AUTHENTICITY, IdentityRequirement.ACCOUNT_CONTROL], basis: 'wallet challenge, document authenticity, and account control' },
  ],
  biometrics: { mode: 'prohibited' },
});

export const SYNTHETIC_SCREENING_ONLY_POLICY = defineIdentityPolicy({
  schema: IDENTITY_POLICY_SCHEMA,
  policyId: 'proofmark-synthetic-screening-only-v1',
  customerRiskId: 'synthetic-screening-only',
  status: 'synthetic',
  approvalRef: null,
  subjectKind: 'individual',
  required: [IdentityRequirement.WALLET_CONTROL],
  assuranceBands: [{ level: 1, required: [IdentityRequirement.WALLET_CONTROL], basis: 'wallet challenge only; no human identity claim' }],
  biometrics: { mode: 'prohibited' },
});
