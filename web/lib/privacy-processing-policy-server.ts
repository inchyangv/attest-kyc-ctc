import 'server-only';

import {
  SYNTHETIC_PROCESSING_POLICY,
  ProcessingPolicyError,
  authorizeProcessing,
  defineProcessingPolicy,
  policyBinding,
  processingConsentStatement,
  processingPolicyEvidence,
  type ProcessingDataCategory,
  type ProcessingPolicyBindingV1,
  type ProcessingPolicyEvidenceV1,
  type ProcessingPolicyV1,
  type ProcessingStageCode,
} from '@pipeline/privacy-processing-policy.js';
import { ConfigError, TokenError } from './kyc-server';

export function processingPolicyForRuntime(demo: boolean): Readonly<ProcessingPolicyV1> {
  if (demo) return SYNTHETIC_PROCESSING_POLICY;
  const raw = process.env.PROCESSING_POLICY_JSON?.trim();
  if (!raw) throw new ConfigError('production KYC requires an approved customer processing policy', ['PROCESSING_POLICY_JSON']);
  try {
    const policy = defineProcessingPolicy(JSON.parse(raw) as ProcessingPolicyV1);
    if (policy.status !== 'approved') throw new Error('production processing policy must have approved status');
    return policy;
  } catch (error) {
    throw new ConfigError(`PROCESSING_POLICY_JSON is invalid: ${error instanceof Error ? error.message : 'invalid policy'}`, ['PROCESSING_POLICY_JSON']);
  }
}

export function processingPolicyContext(demo: boolean): {
  policy: Readonly<ProcessingPolicyV1>;
  binding: ProcessingPolicyBindingV1;
  evidence: ProcessingPolicyEvidenceV1;
  consentStatement: string;
} {
  const policy = processingPolicyForRuntime(demo);
  return { policy, binding: policyBinding(policy), evidence: processingPolicyEvidence(policy),
    consentStatement: processingConsentStatement(policy) };
}

export function authorizeCurrentProcessing(demo: boolean, binding: ProcessingPolicyBindingV1, request: {
  stage: ProcessingStageCode;
  recipient: string;
  data: readonly ProcessingDataCategory[];
}): ProcessingPolicyEvidenceV1 {
  const policy = processingPolicyForRuntime(demo);
  try {
    authorizeProcessing(policy, binding, request);
    return processingPolicyEvidence(policy);
  } catch (error) {
    if (error instanceof ProcessingPolicyError && error.code === 'PROCESSING_POLICY_CHANGED') {
      throw new TokenError(error.message);
    }
    throw new ConfigError('the current processing policy does not authorize this request', ['PROCESSING_POLICY_JSON']);
  }
}

export function processingPolicyStatus(demo: boolean): {
  configured: boolean;
  status: ProcessingPolicyV1['status'] | 'unavailable';
  policyId: string | null;
  customerId: string | null;
  operatingModel: ProcessingPolicyV1['operatingModel'] | null;
  noticeVersion: string | null;
  noticeStatement: string | null;
  fingerprint: string | null;
  missing: string[];
} {
  try {
    const context = processingPolicyContext(demo);
    return { configured: true, status: context.policy.status, policyId: context.policy.policyId,
      customerId: context.policy.customerId, operatingModel: context.policy.operatingModel,
      noticeVersion: context.policy.notice.version, noticeStatement: context.consentStatement,
      fingerprint: context.binding.fingerprint, missing: [] };
  } catch {
    return { configured: false, status: 'unavailable', policyId: null, customerId: null,
      operatingModel: null, noticeVersion: null, noticeStatement: null, fingerprint: null,
      missing: ['PROCESSING_POLICY_JSON'] };
  }
}
