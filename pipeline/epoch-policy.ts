import { ethers } from 'ethers';

export const EPOCH_POLICY_ABI = [
  'function ATTRS_SCHEMA_VERSION() view returns (uint256)',
  'function POLICY_SCHEMA_VERSION() view returns (uint256)',
  'function policies(uint256) view returns (uint32,uint8,uint40,uint16,uint16,address,bool,bool)',
  'function policyFrozen(uint256) view returns (bool)',
  'function policyKind(uint256) view returns (uint8)',
] as const;

export function expectedDemoIssuer(raw: string | undefined): string {
  if (!raw || !ethers.isAddress(raw) || raw.toLowerCase() === ethers.ZeroAddress) throw new Error('DEMO_EXPECTED_ISSUER_REQUIRED');
  return ethers.getAddress(raw);
}

/** Exact demo policy template from script/deploy.sh, not a general compliance policy. The
 * expected issuer comes from independently trusted operator config, never the observed policy.
 */
export async function checkEpochPolicies(provider: ethers.Provider, registry: string, issuer: string, blockNumber: number) {
  const expectedIssuer = expectedDemoIssuer(issuer);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) throw new Error('EPOCH_POLICY_BLOCK_INVALID');
  const reg = new ethers.Contract(registry, EPOCH_POLICY_ABI, provider), at = { blockTag: blockNumber };
  const [attrs, schema] = await Promise.all([reg.ATTRS_SCHEMA_VERSION(at), reg.POLICY_SCHEMA_VERSION(at)]);
  if (attrs !== 0n || schema !== 2n) throw new Error('EPOCH_POLICY_SCHEMA_MISMATCH');
  const policies = await Promise.all([1, 2].map(async id => {
    const [p, frozen, kind] = await Promise.all([reg.policies(id, at), reg.policyFrozen(id, at), reg.policyKind(id, at)]);
    if (p[0] !== 65572n || p[1] !== 2n || p[2] !== BigInt(id === 1 ? 2592000 : 604800)
      || p[3] !== BigInt(id) || p[4] !== 410n || p[5].toLowerCase() !== expectedIssuer.toLowerCase()
      || p[6] !== true || p[7] !== true || frozen !== true || kind !== 1n) throw new Error('EPOCH_POLICY_MISMATCH');
    return { id, requireAll: Number(p[0]), minAssurance: Number(p[1]), maxAge: Number(p[2]),
      requiredRegime: Number(p[3]), requiredJurisdiction: Number(p[4]), trustedIssuer: ethers.getAddress(p[5]),
      requireRoster: true, exists: true, frozen: true, kind: Number(kind) };
  }));
  return { expectedIssuer, policies };
}
