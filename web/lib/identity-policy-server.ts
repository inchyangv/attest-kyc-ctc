import 'server-only';

import { defineIdentityPolicy, SYNTHETIC_INDIVIDUAL_NONFACE_POLICY, type IdentityPolicyV1 } from '@pipeline/identity-policy.js';
import { ConfigError } from './kyc-server';

export function identityPolicyForIssuance(demo: boolean): Readonly<IdentityPolicyV1> {
  if (demo) return SYNTHETIC_INDIVIDUAL_NONFACE_POLICY;
  const raw = process.env.IDENTITY_POLICY_JSON?.trim();
  if (!raw) throw new ConfigError('production issuance requires an approved customer identity policy mapping', ['IDENTITY_POLICY_JSON']);
  try {
    const policy = defineIdentityPolicy(JSON.parse(raw) as IdentityPolicyV1);
    if (policy.status !== 'approved') throw new Error('production identity policy must have approved status');
    return policy;
  } catch (error) {
    throw new ConfigError(`IDENTITY_POLICY_JSON is invalid: ${error instanceof Error ? error.message : 'invalid policy'}`, ['IDENTITY_POLICY_JSON']);
  }
}
