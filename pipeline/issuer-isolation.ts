import { ethers } from 'ethers';

export const ISSUER_MODES = ['single-issuer', 'independent-issuer-scoped'] as const;
export type IssuerMode = typeof ISSUER_MODES[number];
/** The deployed contract family still keys lifecycle state and roster witnesses by subject alone. */
export const CURRENT_ISSUER_SCOPE_VERSION = 0;

export interface IssuerReleaseProfile {
  mode: string | undefined;
  stableIssuers: readonly string[];
  policyIssuers: readonly string[];
}

function normalizedUniqueAddresses(values: readonly string[], field: string): string[] {
  const normalized = values.map(value => {
    if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`INVALID_${field}`);
    return ethers.getAddress(value).toLowerCase();
  });
  return [...new Set(normalized)];
}

/**
 * Fail-closed T-06 guard for the current incompatible scope-v0 release.
 *
 * It does not approve either product direction. It only prevents this legacy contract family from
 * being labelled or deployed as issuer-isolated, and requires an explicit single-issuer decision
 * before its existing deployment script can proceed.
 */
export function assertIssuerReleaseProfile(profile: IssuerReleaseProfile): void {
  if (!profile.mode) throw new Error('ISSUER_ISOLATION_DECISION_REQUIRED');
  if (!ISSUER_MODES.includes(profile.mode as IssuerMode)) throw new Error('INVALID_ISSUER_MODE');

  const stableIssuers = normalizedUniqueAddresses(profile.stableIssuers, 'STABLE_ISSUER');
  const policyIssuers = normalizedUniqueAddresses(profile.policyIssuers, 'POLICY_ISSUER');

  if (profile.mode === 'independent-issuer-scoped') {
    throw new Error(`SCOPED_ISSUER_PROTOCOL_NOT_IMPLEMENTED: scope version ${CURRENT_ISSUER_SCOPE_VERSION}`);
  }
  if (stableIssuers.length !== 1) throw new Error('SINGLE_ISSUER_REQUIRES_ONE_STABLE_IDENTITY');
  if (policyIssuers.length !== 1 || policyIssuers[0] !== stableIssuers[0]) {
    throw new Error('SINGLE_ISSUER_POLICY_MUST_PIN_STABLE_IDENTITY');
  }
}
