import { ethers } from 'ethers';
import { SUPPORTED_METHODS } from './attrs.js';
import { Methods } from './methods.js';

export const POLICY_SCHEMA_VERSION = 2;
export const POLICY_REGISTRY_ABI = [
  'function ATTRS_SCHEMA_VERSION() view returns (uint256)',
  'function POLICY_SCHEMA_VERSION() view returns (uint256)',
  'function policyKind(uint256) view returns (uint8)',
  'function registerPolicyForKind((uint32 requireAll,uint8 minAssurance,uint40 maxAge,uint16 requiredRegime,uint16 requiredJurisdiction,address trustedIssuer,bool requireRoster,bool exists) p,uint8 kind) returns (uint256 policyId)',
] as const;

export async function requirePolicySchema(provider: ethers.Provider, registry: string): Promise<void> {
  const contract = new ethers.Contract(registry, POLICY_REGISTRY_ABI, provider);
  const versions = await Promise.all([contract.ATTRS_SCHEMA_VERSION(), contract.POLICY_SCHEMA_VERSION()]).catch(() => null);
  if (!versions || versions[0] !== 0n || versions[1] !== 2n) throw new Error('unsupported or unconfirmed credential/policy schema; migrate before typed-policy integration');
}
export interface PolicyInput {
  requireAll: number; minAssurance: number; maxAge: number; requiredRegime: number;
  requiredJurisdiction: number; trustedIssuer: string; requireRoster: boolean;
}
export function validatePolicy(p: PolicyInput, kind: number): void {
  const ranges: [number, number][] = [[p.requireAll, 0xffffffff], [p.minAssurance, 5], [p.maxAge, 0xffffffffff],
    [p.requiredRegime, 2], [p.requiredJurisdiction, 999]];
  if ((kind !== 1 && kind !== 2) || ranges.some(([value, max]) => !Number.isSafeInteger(value) || value < 0 || value > max)
    || (p.requireAll & ~SUPPORTED_METHODS) !== 0 || !ethers.isAddress(p.trustedIssuer) || typeof p.requireRoster !== 'boolean') throw new Error('invalid policy schema');
}

/** Intentionally permitted wildcards, with explicit integration warnings. Not compliance advice. */
export function policyWarnings(p: PolicyInput, kind: number): string[] {
  validatePolicy(p, kind);
  return [p.requireAll === 0 ? 'No method is required.' : '', p.minAssurance === 0 ? 'No assurance minimum beyond schema validity.' : '',
    (p.requireAll & Methods.ONCHAIN_EXPOSURE) !== 0 ? 'The built-in AML engine does not perform graph/exposure analysis and cannot satisfy ONCHAIN_EXPOSURE; exact wallet-list lookup is not equivalent.' : '',
    p.maxAge === 0 ? 'No age ceiling; mark expiry still applies.' : '', p.requiredRegime === 0 ? 'Any supported regime, including sandbox, is accepted.' : '',
    p.requiredJurisdiction === 0 ? 'Any supported numeric jurisdiction is accepted.' : '',
    p.trustedIssuer.toLowerCase() === ethers.ZeroAddress ? 'Any issuer accepted by the underlying credential path can satisfy this policy.' : '',
    !p.requireRoster ? 'Direct proof does not establish continued revocation freshness and cannot back new GatedRwaNote deployments.' : 'Roster inclusion still trusts issuer approval and publisher completeness; storage-only consumers need a current cached roster witness.'].filter(Boolean);
}
