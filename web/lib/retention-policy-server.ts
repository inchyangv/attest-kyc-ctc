import 'server-only';

import {
  SYNTHETIC_RETENTION_POLICY,
  RetentionPolicyError,
  assertRetentionBinding,
  defineRetentionPolicy,
  retentionConsentStatement,
  retentionPolicyBinding,
  type RetentionPolicyBindingV1,
  type RetentionPolicyV1,
} from '@pipeline/retention-policy.js';
import { ConfigError, TokenError } from './kyc-server';

export function retentionPolicyForRuntime(demo: boolean): Readonly<RetentionPolicyV1> {
  if (demo) return SYNTHETIC_RETENTION_POLICY;
  const raw = process.env.RETENTION_POLICY_JSON?.trim();
  if (!raw) throw new ConfigError('production KYC requires an approved retention and deletion policy', ['RETENTION_POLICY_JSON']);
  try {
    const policy = defineRetentionPolicy(JSON.parse(raw) as RetentionPolicyV1);
    if (policy.status !== 'approved') throw new Error('production retention policy must have approved status');
    return policy;
  } catch (error) {
    throw new ConfigError(`RETENTION_POLICY_JSON is invalid: ${error instanceof Error ? error.message : 'invalid policy'}`, ['RETENTION_POLICY_JSON']);
  }
}

export function retentionPolicyContext(demo: boolean, customerId: string): {
  policy: Readonly<RetentionPolicyV1>;
  binding: RetentionPolicyBindingV1;
  consentStatement: string;
} {
  const policy = retentionPolicyForRuntime(demo);
  if (policy.customerId !== customerId) throw new ConfigError('processing and retention policies identify different customers', ['RETENTION_POLICY_JSON']);
  return { policy, binding: retentionPolicyBinding(policy), consentStatement: retentionConsentStatement(policy) };
}

export function authorizeCurrentRetention(demo: boolean, customerId: string, binding: RetentionPolicyBindingV1): Readonly<RetentionPolicyV1> {
  const policy = retentionPolicyForRuntime(demo);
  try {
    if (policy.customerId !== customerId) throw new RetentionPolicyError('RETENTION_POLICY_CHANGED', 'retention customer changed after wallet consent');
    assertRetentionBinding(policy, binding);
    return policy;
  } catch (error) {
    if (error instanceof RetentionPolicyError && error.code === 'RETENTION_POLICY_CHANGED') throw new TokenError(error.message);
    throw new ConfigError('the current retention policy does not authorize this request', ['RETENTION_POLICY_JSON']);
  }
}

export function retentionPolicyStatus(demo: boolean, customerId: string): {
  configured: boolean;
  status: RetentionPolicyV1['status'] | 'unavailable';
  policyId: string | null;
  customerId: string | null;
  jurisdiction: string | null;
  fingerprint: string | null;
  missing: string[];
} {
  try {
    const context = retentionPolicyContext(demo, customerId);
    return { configured: true, status: context.policy.status, policyId: context.policy.policyId,
      customerId: context.policy.customerId, jurisdiction: context.policy.jurisdiction,
      fingerprint: context.binding.fingerprint, missing: [] };
  } catch {
    return { configured: false, status: 'unavailable', policyId: null, customerId: null,
      jurisdiction: null, fingerprint: null, missing: ['RETENTION_POLICY_JSON'] };
  }
}
